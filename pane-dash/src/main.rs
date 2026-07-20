use std::future::Future;
use std::io;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use crossterm::event::{Event as CrosstermEvent, EventStream};
use crossterm::execute;
use crossterm::terminal::{
    EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode,
};
use futures_util::StreamExt;
use pane_dash::actions::execute_jump;
use pane_dash::app::{Action, AppState, Event, reduce};
use pane_dash::control::{ControlEvent, ControlHandle};
use pane_dash::model::{Model, ModelConfig};
use pane_dash::options::parse_show_options;
use pane_dash::snapshot::parse;
use pane_dash::tmux_exec::TmuxExec;
use pane_dash::transport::{
    ConnectionMessage, SnapshotCompletion, TransportCoordinator, TransportDirective, TransportMode,
    spawn_connection_attempt,
};
use pane_dash::ui;
use ratatui::{Terminal, backend::CrosstermBackend};
use tokio::sync::mpsc;

struct TerminalGuard;

struct SnapshotResponse {
    seq: u64,
    mutation_generation: u64,
    observed_at: u64,
    source: SnapshotSource,
    result: Result<Vec<u8>, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SnapshotSource {
    Channel { connection_generation: u64 },
    OneShot,
}

#[derive(Default)]
struct SnapshotGeneration {
    current: u64,
    last_seq: u64,
}

impl SnapshotGeneration {
    fn current(&self) -> u64 {
        self.current
    }

    fn record_successful_mutation(&mut self) {
        self.current = self.current.wrapping_add(1);
    }

    fn accepts(&mut self, seq: u64, mutation_generation: u64) -> bool {
        if seq <= self.last_seq {
            return false;
        }
        self.last_seq = seq;
        mutation_generation == self.current
    }
}

impl TerminalGuard {
    fn enter() -> Result<Self> {
        enable_raw_mode().context("enable raw mode")?;
        if let Err(error) = execute!(io::stdout(), EnterAlternateScreen) {
            let _ = disable_raw_mode();
            return Err(error).context("enter alternate screen");
        }
        Ok(Self)
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let _ = execute!(io::stdout(), LeaveAlternateScreen);
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let startup_started = Instant::now();
    let (client_tty, session_id, _pane_id, bench_first_frame) = parse_args()?;
    let tmux = TmuxExec::new("tmux");
    let (snapshot_bytes, options_bytes) = tmux.startup().await?;
    let cfg = parse_show_options(&options_bytes);
    let initial_snapshot = parse(&snapshot_bytes);
    let model = Model::build(
        &initial_snapshot.records,
        &ModelConfig {
            match_pattern: cfg.match_pattern.clone(),
            stale_secs: cfg.stale_secs,
        },
        now_secs(),
    );
    let mut app = AppState::new(model, cfg);
    app.dropped_records = initial_snapshot.dropped;

    let _terminal = TerminalGuard::enter()?;
    install_panic_cleanup();
    let mut terminal = Terminal::new(CrosstermBackend::new(io::stdout()))?;
    redraw(&mut terminal, &mut app)?;
    if bench_first_frame {
        eprintln!(
            "{}",
            bench_first_frame_message(startup_started.elapsed().as_secs_f64() * 1_000.0)
        );
        return Ok(());
    }

    let mut input = EventStream::new();
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    let (snapshot_tx, mut snapshots) = mpsc::unbounded_channel();
    let (connection_tx, mut connection_messages) = mpsc::unbounded_channel();
    let (mut coordinator, directives) = TransportCoordinator::new();
    let mut control = None;
    let mut pending_connection_generation = None;
    let mut active_connection_generation = None;
    let mut next_connection_generation = 0_u64;
    let mut debounce_deadline = None;
    let mut next_snapshot_seq = 0_u64;
    let mut snapshot_generation = SnapshotGeneration::default();
    dispatch_directives(
        directives,
        &tmux,
        &session_id,
        &connection_tx,
        &mut control,
        &mut pending_connection_generation,
        &mut active_connection_generation,
        &mut next_connection_generation,
        &mut debounce_deadline,
        &snapshot_tx,
        &mut next_snapshot_seq,
        &snapshot_generation,
    );
    while !app.should_quit {
        tokio::select! {
            event = input.next() => match event {
                Some(Ok(CrosstermEvent::Key(key))) => {
                    if apply_event(&mut terminal, &mut app, Event::Key(key), &tmux, control.as_ref(), &client_tty).await? {
                        snapshot_generation.record_successful_mutation();
                    }
                },
                Some(Ok(CrosstermEvent::Resize(_, _))) => redraw(&mut terminal, &mut app)?,
                Some(Ok(_)) => {},
                Some(Err(error)) => return Err(error).context("read terminal event"),
                None => app.should_quit = true,
            },
            _ = tick.tick() => {
                dispatch_directives(
                    coordinator.input(pane_dash::transport::TransportInput::FallbackTick),
                    &tmux, &session_id, &connection_tx, &mut control,
                    &mut pending_connection_generation, &mut active_connection_generation,
                    &mut next_connection_generation, &mut debounce_deadline, &snapshot_tx,
                    &mut next_snapshot_seq, &snapshot_generation,
                );
                if apply_event(&mut terminal, &mut app, Event::Tick { now: now_secs() }, &tmux, control.as_ref(), &client_tty).await? {
                    snapshot_generation.record_successful_mutation();
                }
            },
            message = connection_messages.recv() => if let Some(message) = message {
                let directives = match message {
                    ConnectionMessage::Connected { generation, handle }
                        if pending_connection_generation == Some(generation) => {
                            pending_connection_generation = None;
                            active_connection_generation = Some(generation);
                            control = Some(handle);
                            coordinator.input(pane_dash::transport::TransportInput::Connected)
                        }
                    ConnectionMessage::Failed { generation, error: _ }
                        if pending_connection_generation == Some(generation) => {
                            pending_connection_generation = None;
                            coordinator.input(pane_dash::transport::TransportInput::ConnectionFailed)
                        }
                    ConnectionMessage::Event { generation, event }
                        if active_connection_generation == Some(generation) => match event {
                            ControlEvent::TopologyChanged => coordinator.input(pane_dash::transport::TransportInput::TopologyChanged),
                            ControlEvent::Terminated(_) => {
                                control = None;
                                active_connection_generation = None;
                                coordinator.input(pane_dash::transport::TransportInput::ChannelEnded)
                            }
                        },
                    _ => Vec::new(),
                };
                dispatch_directives(
                    directives, &tmux, &session_id, &connection_tx, &mut control,
                    &mut pending_connection_generation, &mut active_connection_generation,
                    &mut next_connection_generation, &mut debounce_deadline, &snapshot_tx,
                    &mut next_snapshot_seq, &snapshot_generation,
                );
                if sync_transport_degraded(&mut app, &coordinator) {
                    redraw(&mut terminal, &mut app)?;
                }
            },
            _ = async {
                if let Some(deadline) = debounce_deadline {
                    tokio::time::sleep_until(deadline).await;
                } else {
                    std::future::pending::<()>().await;
                }
            } => {
                debounce_deadline = None;
                dispatch_directives(
                    coordinator.input(pane_dash::transport::TransportInput::DebounceElapsed),
                    &tmux, &session_id, &connection_tx, &mut control,
                    &mut pending_connection_generation, &mut active_connection_generation,
                    &mut next_connection_generation, &mut debounce_deadline, &snapshot_tx,
                    &mut next_snapshot_seq, &snapshot_generation,
                );
            },
            response = snapshots.recv() => if let Some(response) = response {
                if matches!(response.source, SnapshotSource::Channel { connection_generation } if active_connection_generation != Some(connection_generation)) {
                    continue;
                }
                let (completion, event) = match response.result {
                    Ok(bytes) => {
                        let outcome = parse(&bytes);
                        let malformed = matches!(response.source, SnapshotSource::Channel { .. })
                            && (bytes.first() != Some(&0x1e) || outcome.records.is_empty());
                        if malformed {
                            (SnapshotCompletion::MalformedPayload, Event::SnapshotFailed("malformed control snapshot payload".into()))
                        } else {
                            (SnapshotCompletion::Valid, Event::Snapshot { outcome, observed_at: response.observed_at })
                        }
                    }
                    Err(error) => (SnapshotCompletion::Failed, Event::SnapshotFailed(error)),
                };
                let directives = coordinator.snapshot_completed(completion);
                dispatch_directives(
                    directives, &tmux, &session_id, &connection_tx, &mut control,
                    &mut pending_connection_generation, &mut active_connection_generation,
                    &mut next_connection_generation, &mut debounce_deadline, &snapshot_tx,
                    &mut next_snapshot_seq, &snapshot_generation,
                );
                if snapshot_generation.accepts(response.seq, response.mutation_generation)
                    && apply_event(&mut terminal, &mut app, event, &tmux, control.as_ref(), &client_tty).await?
                {
                    snapshot_generation.record_successful_mutation();
                }
            },
        }
    }
    let _ = client_tty;
    Ok(())
}

fn bench_first_frame_message(elapsed_ms: f64) -> String {
    format!("pane-dash coldframe_ms={elapsed_ms:.3}")
}

#[allow(clippy::too_many_arguments)]
fn dispatch_directives(
    directives: Vec<TransportDirective>,
    tmux: &TmuxExec,
    session_id: &str,
    connection_tx: &mpsc::UnboundedSender<ConnectionMessage>,
    control: &mut Option<ControlHandle>,
    pending_connection_generation: &mut Option<u64>,
    active_connection_generation: &mut Option<u64>,
    next_connection_generation: &mut u64,
    debounce_deadline: &mut Option<tokio::time::Instant>,
    snapshot_tx: &mpsc::UnboundedSender<SnapshotResponse>,
    next_snapshot_seq: &mut u64,
    snapshot_generation: &SnapshotGeneration,
) {
    for directive in directives {
        match directive {
            TransportDirective::Connect => {
                *next_connection_generation = next_connection_generation.wrapping_add(1);
                let generation = *next_connection_generation;
                *pending_connection_generation = Some(generation);
                *active_connection_generation = None;
                *control = None;
                spawn_connection_attempt(
                    PathBuf::from("tmux"),
                    session_id.into(),
                    generation,
                    connection_tx.clone(),
                );
            }
            TransportDirective::ChannelSnapshot => {
                let (Some(handle), Some(connection_generation)) =
                    (control.clone(), *active_connection_generation)
                else {
                    continue;
                };
                spawn_snapshot(
                    snapshot_tx,
                    next_snapshot_seq,
                    snapshot_generation.current(),
                    SnapshotSource::Channel {
                        connection_generation,
                    },
                    async move { handle.snapshot().await.map_err(|error| error.to_string()) },
                );
            }
            TransportDirective::OneShotSnapshot => {
                let tmux = tmux.clone();
                spawn_snapshot(
                    snapshot_tx,
                    next_snapshot_seq,
                    snapshot_generation.current(),
                    SnapshotSource::OneShot,
                    async move { tmux.snapshot().await.map_err(|error| error.to_string()) },
                );
            }
            TransportDirective::StartDebounce => {
                if debounce_deadline.is_none() {
                    *debounce_deadline =
                        Some(tokio::time::Instant::now() + Duration::from_millis(50));
                }
            }
        }
    }
}

fn spawn_snapshot<F>(
    tx: &mpsc::UnboundedSender<SnapshotResponse>,
    next_snapshot_seq: &mut u64,
    mutation_generation: u64,
    source: SnapshotSource,
    snapshot: F,
) where
    F: Future<Output = Result<Vec<u8>, String>> + Send + 'static,
{
    *next_snapshot_seq = next_snapshot_seq.wrapping_add(1);
    let seq = *next_snapshot_seq;
    let tx = tx.clone();
    tokio::spawn(async move {
        let result = snapshot.await;
        let _ = tx.send(SnapshotResponse {
            seq,
            mutation_generation,
            observed_at: now_secs(),
            source,
            result,
        });
    });
}

fn sync_transport_degraded(app: &mut AppState, coordinator: &TransportCoordinator) -> bool {
    let transport_degraded = coordinator.mode() == TransportMode::Degraded;
    if app.transport_degraded == transport_degraded {
        false
    } else {
        app.transport_degraded = transport_degraded;
        true
    }
}

async fn apply_event(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    app: &mut AppState,
    event: Event,
    tmux: &TmuxExec,
    control: Option<&ControlHandle>,
    client_tty: &str,
) -> Result<bool> {
    let result = reduce(app, event);
    let mut mutated = false;
    for action in result.actions {
        match action {
            Action::ToggleGroup(on) => {
                tmux.set_group(on).await?;
                mutated = true;
            }
            Action::Jump { target, zoom } => {
                if execute_jump(tmux, control, client_tty, &target, zoom).await {
                    app.should_quit = true;
                    mutated = true;
                }
            }
            Action::Quit => {}
        }
    }
    if result.changed {
        redraw(terminal, app)?;
    }
    Ok(mutated)
}

fn redraw(terminal: &mut Terminal<CrosstermBackend<io::Stdout>>, app: &mut AppState) -> Result<()> {
    let now = now_secs();
    app.prepare_render(now);
    terminal.draw(|frame| ui::render(frame, app, now))?;
    Ok(())
}

fn parse_args() -> Result<(String, String, String, bool)> {
    let mut positional = Vec::new();
    let mut bench_first_frame = false;
    for arg in std::env::args().skip(1) {
        if arg == "--bench-first-frame" {
            bench_first_frame = true;
        } else {
            positional.push(arg);
        }
    }
    if positional.len() != 3 {
        anyhow::bail!("expected client_tty session_id pane_id");
    }
    Ok((
        positional.remove(0),
        positional.remove(0),
        positional.remove(0),
        bench_first_frame,
    ))
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn install_panic_cleanup() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = disable_raw_mode();
        let _ = execute!(io::stdout(), LeaveAlternateScreen);
        previous(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::{SnapshotGeneration, bench_first_frame_message};

    #[test]
    fn discards_snapshot_launched_before_a_successful_local_mutation() {
        let mut guard = SnapshotGeneration::default();
        let stale_generation = guard.current();
        guard.record_successful_mutation();
        assert!(!guard.accepts(1, stale_generation));

        let fresh_generation = guard.current();
        assert!(guard.accepts(2, fresh_generation));
    }

    #[test]
    fn formats_the_cold_frame_measurement_for_the_probe() {
        assert_eq!(
            bench_first_frame_message(12.345),
            "pane-dash coldframe_ms=12.345"
        );
    }
}
