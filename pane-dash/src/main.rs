use std::future::Future;
use std::io;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use crossterm::event::{
    DisableFocusChange, EnableFocusChange, Event as CrosstermEvent, EventStream,
};
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
use pane_dash::preview::parse_preview;
use pane_dash::snapshot::parse;
use pane_dash::tmux_exec::TmuxExec;
use pane_dash::transport::{
    ConnectionMessage, SnapshotCompletion, TransportCoordinator, TransportDirective, TransportMode,
    spawn_connection_attempt,
};
use pane_dash::ui;
use ratatui::{Terminal, backend::CrosstermBackend};
use tokio::sync::mpsc;
use tokio::time::MissedTickBehavior;

struct TerminalGuard;

struct PreviewResponse {
    sequence: u64,
    pane_id: pane_dash::model::PaneId,
    result: Result<pane_dash::preview::PreviewFrame, String>,
}

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConnectionMessageKind {
    Connected,
    Failed,
    TopologyChanged,
    Terminated,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConnectionRoute {
    Ignore,
    Install,
    ConnectionFailed,
    TopologyChanged,
    ChannelEnded,
}

fn classify_connection_message(
    kind: ConnectionMessageKind,
    generation: u64,
    pending_generation: Option<u64>,
    active_generation: Option<u64>,
) -> ConnectionRoute {
    match kind {
        ConnectionMessageKind::Connected if pending_generation == Some(generation) => {
            ConnectionRoute::Install
        }
        ConnectionMessageKind::Failed if pending_generation == Some(generation) => {
            ConnectionRoute::ConnectionFailed
        }
        ConnectionMessageKind::TopologyChanged if active_generation == Some(generation) => {
            ConnectionRoute::TopologyChanged
        }
        ConnectionMessageKind::Terminated if active_generation == Some(generation) => {
            ConnectionRoute::ChannelEnded
        }
        _ => ConnectionRoute::Ignore,
    }
}

#[derive(Default)]
struct SnapshotInFlight {
    seq: Option<u64>,
}

impl SnapshotInFlight {
    fn spawned(&mut self, seq: u64) {
        self.seq = Some(seq);
    }
    fn reset(&mut self) {
        self.seq = None;
    }
    fn accepts(&mut self, seq: u64) -> bool {
        if self.seq != Some(seq) {
            return false;
        }
        self.seq = None;
        true
    }
}

fn clear_terminated_connection_state<T>(
    control: &mut Option<T>,
    active_connection_generation: &mut Option<u64>,
    in_flight_snapshot: &mut SnapshotInFlight,
    debounce_deadline: &mut Option<tokio::time::Instant>,
) {
    *control = None;
    *active_connection_generation = None;
    in_flight_snapshot.reset();
    *debounce_deadline = None;
}

fn recover_missing_channel_snapshot(coordinator: &mut TransportCoordinator) {
    if !coordinator
        .snapshot_completed(SnapshotCompletion::Failed)
        .is_empty()
    {
        let _ = coordinator.snapshot_completed(SnapshotCompletion::Failed);
    }
}

fn classify_snapshot_payload(
    source: SnapshotSource,
    result: Result<Vec<u8>, String>,
) -> (
    SnapshotCompletion,
    Result<pane_dash::snapshot::ParseOutcome, String>,
) {
    match result {
        Err(error) => (SnapshotCompletion::Failed, Err(error)),
        Ok(bytes) => {
            let outcome = parse(&bytes);
            if matches!(source, SnapshotSource::Channel { .. })
                && (bytes.first() != Some(&0x1e) || outcome.records.is_empty())
            {
                (
                    SnapshotCompletion::MalformedPayload,
                    Err("malformed control snapshot payload".into()),
                )
            } else {
                (SnapshotCompletion::Valid, Ok(outcome))
            }
        }
    }
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
        if let Err(error) = execute!(io::stdout(), EnableFocusChange) {
            let _ = execute!(io::stdout(), LeaveAlternateScreen);
            let _ = disable_raw_mode();
            return Err(error).context("enable terminal focus events");
        }
        Ok(Self)
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = execute!(io::stdout(), DisableFocusChange);
        let _ = execute!(io::stdout(), LeaveAlternateScreen);
        let _ = disable_raw_mode();
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
    let mut tick = snapshot_interval();
    let mut preview_tick = preview_interval();
    let (snapshot_tx, mut snapshots) = mpsc::unbounded_channel();
    let (preview_tx, mut preview_responses) = mpsc::unbounded_channel();
    let (connection_tx, mut connection_messages) = mpsc::unbounded_channel();
    let (mut coordinator, directives) = TransportCoordinator::new();
    let mut control = None;
    let mut pending_connection_generation = None;
    let mut active_connection_generation = None;
    let mut next_connection_generation = 0_u64;
    let mut debounce_deadline = None;
    let mut next_snapshot_seq = 0_u64;
    let mut in_flight_snapshot = SnapshotInFlight::default();
    let mut snapshot_generation = SnapshotGeneration::default();
    dispatch_directives(
        directives,
        &mut coordinator,
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
        &mut in_flight_snapshot,
    );
    let _ = apply_event(
        &mut terminal,
        &mut app,
        Event::PreviewTick,
        &tmux,
        control.as_ref(),
        &client_tty,
        &mut preview_tick,
        &preview_tx,
    )
    .await?;
    while !app.should_quit {
        tokio::select! {
            event = input.next() => match event {
                Some(Ok(CrosstermEvent::Key(key))) => {
                    if apply_event(&mut terminal, &mut app, Event::Key(key), &tmux, control.as_ref(), &client_tty, &mut preview_tick, &preview_tx).await? {
                        snapshot_generation.record_successful_mutation();
                    }
                },
                Some(Ok(CrosstermEvent::FocusGained)) => {
                    let _ = apply_event(&mut terminal, &mut app, Event::TerminalFocus(true), &tmux, control.as_ref(), &client_tty, &mut preview_tick, &preview_tx).await?;
                },
                Some(Ok(CrosstermEvent::FocusLost)) => {
                    let _ = apply_event(&mut terminal, &mut app, Event::TerminalFocus(false), &tmux, control.as_ref(), &client_tty, &mut preview_tick, &preview_tx).await?;
                },
                Some(Ok(CrosstermEvent::Resize(_, _))) => redraw(&mut terminal, &mut app)?,
                Some(Ok(_)) => {},
                Some(Err(error)) => return Err(error).context("read terminal event"),
                None => app.should_quit = true,
            },
            _ = tick.tick() => {
                dispatch_directives(
                    coordinator.input(pane_dash::transport::TransportInput::FallbackTick),
                    &mut coordinator,
                    &tmux, &session_id, &connection_tx, &mut control,
                    &mut pending_connection_generation, &mut active_connection_generation,
                    &mut next_connection_generation, &mut debounce_deadline, &snapshot_tx,
                    &mut next_snapshot_seq, &snapshot_generation,
                    &mut in_flight_snapshot,
                );
                if apply_event(&mut terminal, &mut app, Event::Tick { now: now_secs() }, &tmux, control.as_ref(), &client_tty, &mut preview_tick, &preview_tx).await? {
                    snapshot_generation.record_successful_mutation();
                }
            },
            _ = preview_tick.tick() => {
                let _ = apply_event(&mut terminal, &mut app, Event::PreviewTick, &tmux, control.as_ref(), &client_tty, &mut preview_tick, &preview_tx).await?;
            },
            message = connection_messages.recv() => if let Some(message) = message {
                let (kind, generation) = match &message {
                    ConnectionMessage::Connected { generation, .. } => {
                        (ConnectionMessageKind::Connected, *generation)
                    }
                    ConnectionMessage::Failed { generation, .. } => {
                        (ConnectionMessageKind::Failed, *generation)
                    }
                    ConnectionMessage::Event { generation, event } => match event {
                        ControlEvent::TopologyChanged => {
                            (ConnectionMessageKind::TopologyChanged, *generation)
                        }
                        ControlEvent::Terminated(_) => (ConnectionMessageKind::Terminated, *generation),
                    },
                };
                let route = classify_connection_message(
                    kind,
                    generation,
                    pending_connection_generation,
                    active_connection_generation,
                );
                let directives = match (route, message) {
                    (ConnectionRoute::Install, ConnectionMessage::Connected { generation, handle }) => {
                        pending_connection_generation = None;
                        active_connection_generation = Some(generation);
                        control = Some(handle);
                        coordinator.input(pane_dash::transport::TransportInput::Connected)
                    }
                    (ConnectionRoute::ConnectionFailed, ConnectionMessage::Failed { .. }) => {
                        pending_connection_generation = None;
                        coordinator.input(pane_dash::transport::TransportInput::ConnectionFailed)
                    }
                    (ConnectionRoute::TopologyChanged, _) => {
                        coordinator.input(pane_dash::transport::TransportInput::TopologyChanged)
                    }
                    (ConnectionRoute::ChannelEnded, _) => {
                        clear_terminated_connection_state(
                            &mut control,
                            &mut active_connection_generation,
                            &mut in_flight_snapshot,
                            &mut debounce_deadline,
                        );
                        coordinator.input(pane_dash::transport::TransportInput::ChannelEnded)
                    }
                    _ => Vec::new(),
                };
                dispatch_directives(
                    directives, &mut coordinator, &tmux, &session_id, &connection_tx, &mut control,
                    &mut pending_connection_generation, &mut active_connection_generation,
                    &mut next_connection_generation, &mut debounce_deadline, &snapshot_tx,
                    &mut next_snapshot_seq, &snapshot_generation,
                    &mut in_flight_snapshot,
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
                    &mut coordinator,
                    &tmux, &session_id, &connection_tx, &mut control,
                    &mut pending_connection_generation, &mut active_connection_generation,
                    &mut next_connection_generation, &mut debounce_deadline, &snapshot_tx,
                    &mut next_snapshot_seq, &snapshot_generation,
                    &mut in_flight_snapshot,
                );
            },
            response = snapshots.recv() => if let Some(response) = response {
                if matches!(response.source, SnapshotSource::Channel { connection_generation } if active_connection_generation != Some(connection_generation)) {
                    continue;
                }
                if !in_flight_snapshot.accepts(response.seq) {
                    continue;
                }
                let (completion, outcome) = classify_snapshot_payload(response.source, response.result);
                let event = match outcome {
                    Ok(outcome) => Event::Snapshot { outcome, observed_at: response.observed_at },
                    Err(error) => Event::SnapshotFailed(error),
                };
                let directives = coordinator.snapshot_completed(completion);
                dispatch_directives(
                    directives, &mut coordinator, &tmux, &session_id, &connection_tx, &mut control,
                    &mut pending_connection_generation, &mut active_connection_generation,
                    &mut next_connection_generation, &mut debounce_deadline, &snapshot_tx,
                    &mut next_snapshot_seq, &snapshot_generation,
                    &mut in_flight_snapshot,
                );
                if snapshot_generation.accepts(response.seq, response.mutation_generation)
                    && apply_event(&mut terminal, &mut app, event, &tmux, control.as_ref(), &client_tty, &mut preview_tick, &preview_tx).await?
                {
                    snapshot_generation.record_successful_mutation();
                }
            },
            response = preview_responses.recv() => if let Some(response) = response {
                let _ = apply_event(
                    &mut terminal,
                    &mut app,
                    Event::PreviewCaptured {
                        sequence: response.sequence,
                        pane_id: response.pane_id,
                        result: response.result,
                    },
                    &tmux,
                    control.as_ref(),
                    &client_tty,
                    &mut preview_tick,
                    &preview_tx,
                ).await?;
            },
        }
    }
    Ok(())
}

fn preview_interval() -> tokio::time::Interval {
    let mut interval = tokio::time::interval_at(
        tokio::time::Instant::now() + Duration::from_millis(500),
        Duration::from_millis(500),
    );
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    interval
}

fn snapshot_interval() -> tokio::time::Interval {
    let mut interval = tokio::time::interval_at(
        tokio::time::Instant::now() + Duration::from_secs(1),
        Duration::from_secs(1),
    );
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    interval
}

fn bench_first_frame_message(elapsed_ms: f64) -> String {
    format!("pane-dash coldframe_ms={elapsed_ms:.3}")
}

#[allow(clippy::too_many_arguments)]
fn dispatch_directives(
    directives: Vec<TransportDirective>,
    coordinator: &mut TransportCoordinator,
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
    in_flight_snapshot: &mut SnapshotInFlight,
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
                    recover_missing_channel_snapshot(coordinator);
                    continue;
                };
                in_flight_snapshot.spawned(spawn_snapshot(
                    snapshot_tx,
                    next_snapshot_seq,
                    snapshot_generation.current(),
                    SnapshotSource::Channel {
                        connection_generation,
                    },
                    async move { handle.snapshot().await.map_err(|error| error.to_string()) },
                ));
            }
            TransportDirective::OneShotSnapshot => {
                let tmux = tmux.clone();
                in_flight_snapshot.spawned(spawn_snapshot(
                    snapshot_tx,
                    next_snapshot_seq,
                    snapshot_generation.current(),
                    SnapshotSource::OneShot,
                    async move { tmux.snapshot().await.map_err(|error| error.to_string()) },
                ));
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
) -> u64
where
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
    seq
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

#[allow(clippy::too_many_arguments)]
async fn apply_event(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    app: &mut AppState,
    event: Event,
    tmux: &TmuxExec,
    control: Option<&ControlHandle>,
    client_tty: &str,
    preview_interval: &mut tokio::time::Interval,
    preview_tx: &mpsc::UnboundedSender<PreviewResponse>,
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
            Action::CapturePreview { sequence, pane_id } => {
                start_preview_capture(
                    preview_interval,
                    preview_tx,
                    tmux.clone(),
                    sequence,
                    pane_id,
                );
            }
            Action::Quit => {}
        }
    }
    if result.changed {
        redraw(terminal, app)?;
    }
    Ok(mutated)
}

fn start_preview_capture(
    preview_interval: &mut tokio::time::Interval,
    tx: &mpsc::UnboundedSender<PreviewResponse>,
    tmux: TmuxExec,
    sequence: u64,
    pane_id: pane_dash::model::PaneId,
) {
    preview_interval.reset();
    spawn_preview_capture(tx, tmux, sequence, pane_id);
}

fn spawn_preview_capture(
    tx: &mpsc::UnboundedSender<PreviewResponse>,
    tmux: TmuxExec,
    sequence: u64,
    pane_id: pane_dash::model::PaneId,
) {
    let tx = tx.clone();
    tokio::spawn(async move {
        let result = tmux
            .capture_pane(&pane_id)
            .await
            .map(|bytes| parse_preview(pane_id.clone(), bytes))
            .map_err(|error| error.to_string());
        let _ = tx.send(PreviewResponse {
            sequence,
            pane_id,
            result,
        });
    });
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
        let _ = execute!(io::stdout(), DisableFocusChange);
        let _ = execute!(io::stdout(), LeaveAlternateScreen);
        let _ = disable_raw_mode();
        previous(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::{
        ConnectionMessageKind, ConnectionRoute, SnapshotGeneration, SnapshotInFlight,
        SnapshotSource, bench_first_frame_message, classify_connection_message,
        classify_snapshot_payload, clear_terminated_connection_state, dispatch_directives,
        preview_interval, snapshot_interval, spawn_preview_capture, start_preview_capture,
        sync_transport_degraded,
    };
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    use pane_dash::app::{Action, AppState, Event, reduce};
    use pane_dash::model::{Model, ModelConfig};
    use pane_dash::options::DashConfig;
    use pane_dash::tmux_exec::{SNAPSHOT_FORMAT, TmuxExec};
    use pane_dash::transport::{
        SnapshotCompletion, TransportCoordinator, TransportDirective, TransportInput, TransportMode,
    };
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::time::Duration;
    use tempfile::TempDir;
    use tokio::sync::mpsc;

    fn valid_record() -> Vec<u8> {
        b"\x1e$1\x1fs\x1f@1\x1f0\x1fw\x1f%1\x1f0\x1f1\x1fc\x1f/\x1f0\x1fa\x1f\x1f\x1f\x1f\x1f\x1f"
            .to_vec()
    }

    fn fake_snapshot_tmux(dir: &TempDir) -> (TmuxExec, std::path::PathBuf) {
        let log = dir.path().join("argv.log");
        let executable = dir.path().join("fake-tmux");
        fs::write(
            &executable,
            format!(
                "#!/bin/sh\nprintf '%s\\0' \"$@\" >> '{}'\nprintf '\\n' >> '{}'\nif [ \"$1\" = list-panes ]; then\n    printf '%b' '\\036$1\\037s\\037@1\\0370\\037w\\037%1\\0370\\0371\\037c\\037/\\0370\\037a\\037\\037\\037\\037\\037\\037\\n'\nfi\n",
                log.display(),
                log.display(),
            ),
        )
        .unwrap();
        let mut permissions = fs::metadata(&executable).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&executable, permissions).unwrap();
        (TmuxExec::new(executable), log)
    }

    fn preview_app() -> AppState {
        let outcome = pane_dash::snapshot::parse(&valid_record());
        let mut app = AppState::new(
            Model::build(&outcome.records, &ModelConfig::default(), 0),
            DashConfig::default(),
        );
        reduce(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Char('j'), KeyModifiers::NONE)),
        );
        reduce(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Char('j'), KeyModifiers::NONE)),
        );
        app
    }

    fn fake_preview_tmux(dir: &TempDir) -> (TmuxExec, std::path::PathBuf) {
        let log = dir.path().join("preview-argv.log");
        let executable = dir.path().join("fake-preview-tmux");
        fs::write(
            &executable,
            format!(
                "#!/bin/sh\nprintf '%s\\0' \"$@\" >> '{}'\nprintf '\\n' >> '{}'\nprintf 'captured\\n'\n",
                log.display(),
                log.display(),
            ),
        )
        .unwrap();
        let mut permissions = fs::metadata(&executable).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&executable, permissions).unwrap();
        (TmuxExec::new(executable), log)
    }

    async fn execute_preview_action(
        app: &mut AppState,
        tmux: &TmuxExec,
        tx: &mpsc::UnboundedSender<super::PreviewResponse>,
        responses: &mut mpsc::UnboundedReceiver<super::PreviewResponse>,
        action: Action,
    ) {
        let Action::CapturePreview { sequence, pane_id } = action else {
            panic!("expected preview capture action");
        };
        spawn_preview_capture(tx, tmux.clone(), sequence, pane_id);
        let response = responses.recv().await.expect("preview response");
        reduce(
            app,
            Event::PreviewCaptured {
                sequence: response.sequence,
                pane_id: response.pane_id,
                result: response.result,
            },
        );
    }

    #[tokio::test(start_paused = true, flavor = "current_thread")]
    async fn preview_scheduler_starts_at_500ms_and_pauses_for_inspect_or_focus_loss() {
        let mut scheduler = preview_interval();
        let dir = TempDir::new().unwrap();
        let (tmux, log) = fake_preview_tmux(&dir);
        let (tx, mut responses) = mpsc::unbounded_channel();
        let mut app = preview_app();
        let (sequence, pane_id) = app.preview.in_flight.clone().expect("initial request");
        execute_preview_action(
            &mut app,
            &tmux,
            &tx,
            &mut responses,
            Action::CapturePreview { sequence, pane_id },
        )
        .await;

        tokio::time::advance(Duration::from_millis(499)).await;
        assert!(
            tokio::time::timeout(Duration::ZERO, scheduler.tick())
                .await
                .is_err(),
            "preview tick fired before 500ms"
        );
        tokio::time::advance(Duration::from_millis(1)).await;
        scheduler.tick().await;
        let action = reduce(&mut app, Event::PreviewTick)
            .actions
            .pop()
            .expect("capture at 500ms");
        execute_preview_action(&mut app, &tmux, &tx, &mut responses, action).await;
        tokio::time::advance(Duration::from_millis(500)).await;
        scheduler.tick().await;
        let action = reduce(&mut app, Event::PreviewTick)
            .actions
            .pop()
            .expect("second steady capture");
        execute_preview_action(&mut app, &tmux, &tx, &mut responses, action).await;

        let log_bytes = fs::read(log).unwrap();
        let invocations = log_bytes
            .split(|byte| *byte == b'\n')
            .filter(|entry| !entry.is_empty())
            .map(|entry| {
                entry
                    .split(|byte| *byte == b'\0')
                    .filter(|argument| !argument.is_empty())
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        assert_eq!(invocations.len(), 3, "initial plus two per second");
        assert!(invocations.iter().all(|arguments| {
            arguments == &vec![b"capture-pane".as_slice(), b"-p", b"-e", b"-t", b"%1"]
        }));

        tokio::time::advance(Duration::from_secs(5)).await;
        scheduler.tick().await;
        let action = reduce(&mut app, Event::PreviewTick)
            .actions
            .pop()
            .expect("one delayed capture after a stall");
        execute_preview_action(&mut app, &tmux, &tx, &mut responses, action).await;
        assert!(
            tokio::time::timeout(Duration::ZERO, scheduler.tick())
                .await
                .is_err(),
            "missed ticks must not burst"
        );
        reduce(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Char('u'), KeyModifiers::CONTROL)),
        );
        assert!(reduce(&mut app, Event::PreviewTick).actions.is_empty());
        reduce(&mut app, Event::TerminalFocus(false));
        assert!(reduce(&mut app, Event::PreviewTick).actions.is_empty());
        assert!(
            reduce(&mut app, Event::TerminalFocus(true))
                .actions
                .is_empty()
        );
        let action = reduce(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Char('r'), KeyModifiers::CONTROL)),
        )
        .actions
        .pop()
        .expect("ctrl-r capture");
        execute_preview_action(
            &mut app,
            &TmuxExec::new("/missing/tmux"),
            &tx,
            &mut responses,
            action,
        )
        .await;
        assert!(app.preview.error.is_some());
    }

    #[tokio::test(start_paused = true, flavor = "current_thread")]
    async fn immediate_preview_capture_rearms_the_interval_deadline() {
        let mut scheduler = preview_interval();
        let dir = TempDir::new().unwrap();
        let (tmux, log) = fake_preview_tmux(&dir);
        let (tx, mut responses) = mpsc::unbounded_channel();

        tokio::time::advance(Duration::from_millis(490)).await;
        start_preview_capture(&mut scheduler, &tx, tmux, 1, "%1".into());
        tokio::time::advance(Duration::from_millis(10)).await;
        assert!(
            tokio::time::timeout(Duration::ZERO, scheduler.tick())
                .await
                .is_err()
        );
        tokio::time::advance(Duration::from_millis(490)).await;
        scheduler.tick().await;
        let _ = responses.recv().await.expect("immediate capture response");
        let log_bytes = fs::read(log).unwrap();
        assert_eq!(
            log_bytes
                .split(|byte| *byte == b'\n')
                .filter(|entry| !entry.is_empty())
                .count(),
            1
        );
    }

    #[tokio::test(start_paused = true, flavor = "current_thread")]
    async fn snapshot_interval_waits_one_second_and_does_not_burst_while_inspecting() {
        let mut interval = snapshot_interval();
        let mut app = preview_app();
        reduce(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Char('u'), KeyModifiers::CONTROL)),
        );
        assert!(app.preview.inspect);
        let dir = TempDir::new().unwrap();
        let (tmux, log) = fake_snapshot_tmux(&dir);
        let (mut coordinator, _) = TransportCoordinator::new();
        coordinator.input(TransportInput::ConnectionFailed);
        coordinator.input(TransportInput::ConnectionFailed);
        assert_eq!(coordinator.mode(), TransportMode::Degraded);
        let (connection_tx, _) = mpsc::unbounded_channel();
        let (snapshot_tx, mut snapshots) = mpsc::unbounded_channel();
        let mut control = None;
        let mut pending_connection_generation = None;
        let mut active_connection_generation = None;
        let mut next_connection_generation = 0;
        let mut debounce_deadline = None;
        let mut next_snapshot_seq = 0;
        let snapshot_generation = SnapshotGeneration::default();
        let mut in_flight_snapshot = SnapshotInFlight::default();

        tokio::time::advance(Duration::from_millis(999)).await;
        assert!(
            tokio::time::timeout(Duration::ZERO, interval.tick())
                .await
                .is_err()
        );
        for advance in [Duration::from_millis(1), Duration::from_secs(1)] {
            tokio::time::advance(advance).await;
            interval.tick().await;
            let directives = coordinator.input(TransportInput::FallbackTick);
            assert_eq!(directives, vec![TransportDirective::OneShotSnapshot]);
            dispatch_directives(
                directives,
                &mut coordinator,
                &tmux,
                "session",
                &connection_tx,
                &mut control,
                &mut pending_connection_generation,
                &mut active_connection_generation,
                &mut next_connection_generation,
                &mut debounce_deadline,
                &snapshot_tx,
                &mut next_snapshot_seq,
                &snapshot_generation,
                &mut in_flight_snapshot,
            );
            let response = snapshots.recv().await.expect("one-shot snapshot response");
            assert!(in_flight_snapshot.accepts(response.seq));
            let (completion, outcome) = classify_snapshot_payload(response.source, response.result);
            assert!(coordinator.snapshot_completed(completion).is_empty());
            reduce(
                &mut app,
                Event::Snapshot {
                    outcome: outcome.expect("valid snapshot"),
                    observed_at: response.observed_at,
                },
            );
            assert!(app.preview.inspect || app.preview.target.is_none());
        }
        let log_bytes = fs::read(log).unwrap();
        assert_eq!(
            log_bytes
                .split(|byte| *byte == b'\n')
                .filter(|entry| !entry.is_empty())
                .count(),
            2
        );
        assert!(
            !log_bytes
                .windows(b"show-options".len())
                .any(|w| w == b"show-options")
        );
        tokio::time::advance(Duration::from_secs(5)).await;
        interval.tick().await;
        assert!(
            tokio::time::timeout(Duration::ZERO, interval.tick())
                .await
                .is_err()
        );
    }

    #[test]
    fn snapshot_transport_ticks_remain_independent_of_preview_inspect_mode() {
        let mut app = preview_app();
        reduce(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Char('u'), KeyModifiers::CONTROL)),
        );
        assert!(app.preview.inspect);

        let (mut coordinator, _) = TransportCoordinator::new();
        coordinator.input(TransportInput::ConnectionFailed);
        coordinator.input(TransportInput::ConnectionFailed);
        assert_eq!(coordinator.mode(), TransportMode::Degraded);
        assert_eq!(
            coordinator.input(TransportInput::FallbackTick),
            vec![TransportDirective::OneShotSnapshot]
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn preview_capture_executor_returns_success_or_nonfatal_failure() {
        let dir = TempDir::new().unwrap();
        let executable = dir.path().join("fake-tmux");
        fs::write(&executable, "#!/bin/sh\nprintf 'captured\\n'\n").unwrap();
        let mut permissions = fs::metadata(&executable).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&executable, permissions).unwrap();
        let (tx, mut responses) = mpsc::unbounded_channel();
        spawn_preview_capture(&tx, TmuxExec::new(executable), 7, "%7".into());
        let response = responses.recv().await.expect("capture response");
        assert_eq!(response.sequence, 7);
        assert!(response.result.is_ok());

        spawn_preview_capture(&tx, TmuxExec::new("/missing/tmux"), 8, "%8".into());
        let response = responses.recv().await.expect("failure response");
        assert_eq!(response.sequence, 8);
        assert!(response.result.is_err());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn degraded_fallback_ticks_poll_without_show_options_and_keep_the_alert() {
        let dir = TempDir::new().unwrap();
        let (tmux, log) = fake_snapshot_tmux(&dir);
        let (mut coordinator, _) = TransportCoordinator::new();
        coordinator.input(TransportInput::ConnectionFailed);
        coordinator.input(TransportInput::ConnectionFailed);
        assert_eq!(coordinator.mode(), TransportMode::Degraded);

        let mut app = AppState::new(
            Model::build(&[], &ModelConfig::default(), 0),
            DashConfig::default(),
        );
        assert!(sync_transport_degraded(&mut app, &coordinator));
        assert!(app.transport_degraded);

        let (connection_tx, _) = mpsc::unbounded_channel();
        let (snapshot_tx, mut snapshots) = mpsc::unbounded_channel();
        let mut control = None;
        let mut pending_connection_generation = None;
        let mut active_connection_generation = None;
        let mut next_connection_generation = 0;
        let mut debounce_deadline = None;
        let mut next_snapshot_seq = 0;
        let snapshot_generation = SnapshotGeneration::default();
        let mut in_flight_snapshot = SnapshotInFlight::default();

        for _ in 0..3 {
            let directives = coordinator.input(TransportInput::FallbackTick);
            assert_eq!(directives, vec![TransportDirective::OneShotSnapshot]);
            dispatch_directives(
                directives,
                &mut coordinator,
                &tmux,
                "session",
                &connection_tx,
                &mut control,
                &mut pending_connection_generation,
                &mut active_connection_generation,
                &mut next_connection_generation,
                &mut debounce_deadline,
                &snapshot_tx,
                &mut next_snapshot_seq,
                &snapshot_generation,
                &mut in_flight_snapshot,
            );

            let response = snapshots.recv().await.expect("one-shot snapshot response");
            assert!(in_flight_snapshot.accepts(response.seq));
            let (completion, outcome) = classify_snapshot_payload(response.source, response.result);
            let follow_up = coordinator.snapshot_completed(completion);
            assert!(follow_up.is_empty());
            dispatch_directives(
                follow_up,
                &mut coordinator,
                &tmux,
                "session",
                &connection_tx,
                &mut control,
                &mut pending_connection_generation,
                &mut active_connection_generation,
                &mut next_connection_generation,
                &mut debounce_deadline,
                &snapshot_tx,
                &mut next_snapshot_seq,
                &snapshot_generation,
                &mut in_flight_snapshot,
            );
            reduce(
                &mut app,
                Event::Snapshot {
                    outcome: outcome.expect("valid one-shot snapshot"),
                    observed_at: response.observed_at,
                },
            );
            assert!(app.transport_degraded);
        }

        let log_bytes = fs::read(log).unwrap();
        let invocations: Vec<Vec<&[u8]>> = log_bytes
            .split(|byte| *byte == b'\n')
            .filter(|entry| !entry.is_empty())
            .map(|entry| {
                entry
                    .split(|byte| *byte == b'\0')
                    .filter(|argument| !argument.is_empty())
                    .collect()
            })
            .collect();
        assert_eq!(
            invocations,
            vec![
                vec![
                    b"list-panes".as_slice(),
                    b"-a",
                    b"-F",
                    SNAPSHOT_FORMAT.as_bytes()
                ],
                vec![
                    b"list-panes".as_slice(),
                    b"-a",
                    b"-F",
                    SNAPSHOT_FORMAT.as_bytes()
                ],
                vec![
                    b"list-panes".as_slice(),
                    b"-a",
                    b"-F",
                    SNAPSHOT_FORMAT.as_bytes()
                ],
            ]
        );
        assert!(
            !fs::read(dir.path().join("argv.log"))
                .unwrap()
                .windows(b"show-options".len())
                .any(|window| window == b"show-options")
        );
    }

    #[test]
    fn classifies_only_completed_channel_payloads_as_malformed() {
        for bytes in [vec![], b"noise".to_vec(), b"\x1ebad".to_vec()] {
            assert_eq!(
                classify_snapshot_payload(
                    SnapshotSource::Channel {
                        connection_generation: 1
                    },
                    Ok(bytes)
                )
                .0,
                SnapshotCompletion::MalformedPayload
            );
        }
        let mut hostile = b"\x1ebad".to_vec();
        hostile.extend(valid_record());
        assert_eq!(
            classify_snapshot_payload(
                SnapshotSource::Channel {
                    connection_generation: 1
                },
                Ok(hostile)
            )
            .0,
            SnapshotCompletion::Valid
        );
        assert_eq!(
            classify_snapshot_payload(SnapshotSource::OneShot, Ok(vec![])).0,
            SnapshotCompletion::Valid
        );
        assert_eq!(
            classify_snapshot_payload(SnapshotSource::OneShot, Err("x".into())).0,
            SnapshotCompletion::Failed
        );
    }

    #[test]
    fn ignores_old_snapshot_after_channel_reset_until_current_seq_completes() {
        let mut in_flight = SnapshotInFlight::default();
        in_flight.spawned(1);
        in_flight.reset();
        in_flight.spawned(2);
        assert!(!in_flight.accepts(1));
        assert!(in_flight.accepts(2));
        assert_eq!(in_flight.seq, None);
    }

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

    #[test]
    fn classifies_connection_messages_by_kind_and_generation() {
        let pending = Some(2);
        let active = Some(3);

        for kind in [
            ConnectionMessageKind::Connected,
            ConnectionMessageKind::Failed,
            ConnectionMessageKind::TopologyChanged,
            ConnectionMessageKind::Terminated,
        ] {
            assert_eq!(
                classify_connection_message(kind, 1, pending, active),
                ConnectionRoute::Ignore
            );
        }
        assert_eq!(
            classify_connection_message(ConnectionMessageKind::Connected, 2, pending, active),
            ConnectionRoute::Install
        );
        assert_eq!(
            classify_connection_message(ConnectionMessageKind::Failed, 2, pending, active),
            ConnectionRoute::ConnectionFailed
        );
        assert_eq!(
            classify_connection_message(ConnectionMessageKind::TopologyChanged, 3, pending, active),
            ConnectionRoute::TopologyChanged
        );
        assert_eq!(
            classify_connection_message(ConnectionMessageKind::Terminated, 3, pending, active),
            ConnectionRoute::ChannelEnded
        );
    }

    #[test]
    fn missing_channel_handle_completes_the_snapshot_request() {
        let (mut coordinator, _) = TransportCoordinator::new();
        coordinator.input(TransportInput::Connected);
        let directives = coordinator.input(TransportInput::FallbackTick);
        assert_eq!(directives, vec![TransportDirective::ChannelSnapshot]);
        assert!(coordinator.input(TransportInput::RefreshNow).is_empty());

        let tmux = TmuxExec::new("tmux");
        let (connection_tx, _) = mpsc::unbounded_channel();
        let (snapshot_tx, _) = mpsc::unbounded_channel();
        let mut control = None;
        let mut pending_connection_generation = None;
        let mut active_connection_generation = None;
        let mut next_connection_generation = 0;
        let mut debounce_deadline = None;
        let mut next_snapshot_seq = 0;
        let snapshot_generation = SnapshotGeneration::default();
        let mut in_flight_snapshot = SnapshotInFlight::default();

        super::dispatch_directives(
            directives,
            &mut coordinator,
            &tmux,
            "session",
            &connection_tx,
            &mut control,
            &mut pending_connection_generation,
            &mut active_connection_generation,
            &mut next_connection_generation,
            &mut debounce_deadline,
            &snapshot_tx,
            &mut next_snapshot_seq,
            &snapshot_generation,
            &mut in_flight_snapshot,
        );

        assert_eq!(
            coordinator.input(TransportInput::FallbackTick),
            vec![TransportDirective::ChannelSnapshot]
        );
    }

    #[test]
    fn channel_end_clears_state_before_a_reconnected_topology_change_arms_debounce() {
        let mut control = Some(());
        let mut active_connection_generation = Some(3);
        let mut in_flight_snapshot = SnapshotInFlight::default();
        in_flight_snapshot.spawned(4);
        let old_deadline = tokio::time::Instant::now() + Duration::from_secs(1);
        let mut debounce_deadline = Some(old_deadline);

        clear_terminated_connection_state(
            &mut control,
            &mut active_connection_generation,
            &mut in_flight_snapshot,
            &mut debounce_deadline,
        );
        assert_eq!(control, None);
        assert_eq!(active_connection_generation, None);
        assert_eq!(in_flight_snapshot.seq, None);
        assert_eq!(debounce_deadline, None);

        let (mut coordinator, _) = TransportCoordinator::new();
        coordinator.input(TransportInput::Connected);
        coordinator.input(TransportInput::ChannelEnded);
        coordinator.input(TransportInput::Connected);
        let directives = coordinator.input(TransportInput::TopologyChanged);
        assert_eq!(directives, vec![TransportDirective::StartDebounce]);

        let tmux = TmuxExec::new("tmux");
        let (connection_tx, _) = mpsc::unbounded_channel();
        let (snapshot_tx, _) = mpsc::unbounded_channel();
        let mut control = None;
        let mut pending_connection_generation = None;
        let mut next_connection_generation = 0;
        let mut next_snapshot_seq = 0;
        let snapshot_generation = SnapshotGeneration::default();
        let before_dispatch = tokio::time::Instant::now();
        super::dispatch_directives(
            directives,
            &mut coordinator,
            &tmux,
            "session",
            &connection_tx,
            &mut control,
            &mut pending_connection_generation,
            &mut active_connection_generation,
            &mut next_connection_generation,
            &mut debounce_deadline,
            &snapshot_tx,
            &mut next_snapshot_seq,
            &snapshot_generation,
            &mut in_flight_snapshot,
        );
        let new_deadline = debounce_deadline.expect("reconnected debounce is armed");
        assert!(new_deadline >= before_dispatch + Duration::from_millis(50));
        assert!(new_deadline < old_deadline);
    }
}
