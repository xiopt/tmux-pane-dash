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
use pane_dash::actions::{execute_jump, kill_pane, send_text};
use pane_dash::app::{Action, ActionOutcome, AppState, CompletedAction, Event, reduce};
use pane_dash::config::load_ui_config;
use pane_dash::control::{ControlEvent, ControlHandle, is_safe_client_tty};
use pane_dash::creation::{CreateRequest, CreationId, CreationProgress, run_creation};
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
use ratatui::{
    Terminal,
    backend::{Backend, CrosstermBackend},
};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::MissedTickBehavior;

struct TerminalGuard;

struct PreviewResponse {
    sequence: u64,
    pane_id: pane_dash::model::PaneId,
    result: Result<pane_dash::preview::PreviewFrame, String>,
}

struct CreationTask {
    id: CreationId,
    cancel: oneshot::Sender<()>,
    join: JoinHandle<()>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuntimeTimer {
    Snapshot,
    Preview,
}

#[derive(Default)]
struct ActionEffects {
    mutated: bool,
    refresh_now: bool,
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
    FocusChanged,
    SessionChanged,
    Terminated,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConnectionRoute {
    Ignore,
    Install,
    ConnectionFailed,
    TopologyChanged,
    FocusChanged,
    SessionChanged,
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
        ConnectionMessageKind::FocusChanged if active_generation == Some(generation) => {
            ConnectionRoute::FocusChanged
        }
        ConnectionMessageKind::SessionChanged if active_generation == Some(generation) => {
            ConnectionRoute::SessionChanged
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
    mutation_generation: Option<u64>,
}

impl SnapshotInFlight {
    fn spawned(&mut self, seq: u64, mutation_generation: u64) {
        self.seq = Some(seq);
        self.mutation_generation = Some(mutation_generation);
    }
    fn reset(&mut self) {
        self.seq = None;
        self.mutation_generation = None;
    }
    fn accepts(&mut self, seq: u64) -> bool {
        if self.seq != Some(seq) {
            return false;
        }
        self.seq = None;
        self.mutation_generation = None;
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

fn snapshot_keeps_launch_session(
    outcome: &pane_dash::snapshot::ParseOutcome,
    launch_session_id: &str,
) -> bool {
    outcome.dropped > 0
        || outcome
            .records
            .iter()
            .any(|record| record.session_id == launch_session_id)
}

fn source_session_changed_requires_quit(launch_session_id: &str, changed_session_id: &str) -> bool {
    changed_session_id != launch_session_id
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
    let config_started = Instant::now();
    let loaded_ui = load_ui_config(&cfg.theme);
    let initial_snapshot = parse(&snapshot_bytes);
    let model = Model::build(
        &initial_snapshot.records,
        &ModelConfig {
            match_pattern: cfg.match_pattern.clone(),
            stale_secs: cfg.stale_secs,
        },
        now_secs(),
    );
    let mut app = AppState::new(model, cfg, loaded_ui);
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
        eprintln!(
            "{}",
            bench_config_to_frame_message(config_started.elapsed().as_secs_f64() * 1_000.0)
        );
        return Ok(());
    }

    let mut input = EventStream::new();
    let mut tick = snapshot_interval();
    let mut preview_tick = preview_interval();
    let (snapshot_tx, mut snapshots) = mpsc::unbounded_channel();
    let (preview_tx, mut preview_responses) = mpsc::unbounded_channel();
    let (creation_tx, mut creation_progress) = mpsc::unbounded_channel();
    let mut creation_task = None;
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
        &client_tty,
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
    let result = async {
    let _ = apply_event(
        &mut terminal,
        &mut app,
        Event::PreviewTick,
        &tmux,
        control.as_ref(),
        &client_tty,
        &mut preview_tick,
        &preview_tx,
        &creation_tx,
        &mut creation_task,
    )
    .await?;
    while !app.should_quit {
        tokio::select! {
            event = input.next() => match event {
                Some(Ok(CrosstermEvent::Key(key))) => {
                    let effects = apply_event(&mut terminal, &mut app, Event::Key(key), &tmux, control.as_ref(), &client_tty, &mut preview_tick, &preview_tx, &creation_tx, &mut creation_task).await?;
                    process_action_effects(
                        effects, &mut coordinator, &tmux, &session_id, &client_tty, &connection_tx,
                        &mut control, &mut pending_connection_generation,
                        &mut active_connection_generation, &mut next_connection_generation,
                        &mut debounce_deadline, &snapshot_tx, &mut next_snapshot_seq,
                        &mut snapshot_generation, &mut in_flight_snapshot,
                    );
                },
                Some(Ok(CrosstermEvent::FocusGained)) => {
                    let _ = apply_event(&mut terminal, &mut app, Event::TerminalFocus(true), &tmux, control.as_ref(), &client_tty, &mut preview_tick, &preview_tx, &creation_tx, &mut creation_task).await?;
                },
                Some(Ok(CrosstermEvent::FocusLost)) => {
                    let _ = apply_event(&mut terminal, &mut app, Event::TerminalFocus(false), &tmux, control.as_ref(), &client_tty, &mut preview_tick, &preview_tx, &creation_tx, &mut creation_task).await?;
                },
                Some(Ok(CrosstermEvent::Resize(_, _))) => redraw(&mut terminal, &mut app)?,
                Some(Ok(_)) => {},
                Some(Err(error)) => return Err(error).context("read terminal event"),
                None => app.should_quit = true,
            },
            timer = next_runtime_timer(&mut tick, &mut preview_tick) => {
                run_runtime_timer_step(
                    timer, &mut terminal, &mut app, &mut coordinator, &tmux, &session_id,
                    &mut control, &client_tty, &connection_tx, &mut pending_connection_generation,
                    &mut active_connection_generation, &mut next_connection_generation,
                    &mut debounce_deadline, &snapshot_tx, &mut next_snapshot_seq,
                    &mut snapshot_generation, &mut in_flight_snapshot, &mut preview_tick,
                    &preview_tx, &creation_tx, &mut creation_task,
                ).await?;
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
                        ControlEvent::FocusChanged(_) => {
                            (ConnectionMessageKind::FocusChanged, *generation)
                        }
                        ControlEvent::SessionChanged(_) => {
                            (ConnectionMessageKind::SessionChanged, *generation)
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
                    (ConnectionRoute::FocusChanged, ConnectionMessage::Event { event: ControlEvent::FocusChanged(focused), .. }) => {
                        let _ = apply_event(&mut terminal, &mut app, Event::TerminalFocus(focused), &tmux, control.as_ref(), &client_tty, &mut preview_tick, &preview_tx, &creation_tx, &mut creation_task).await?;
                        Vec::new()
                    }
                    (ConnectionRoute::SessionChanged, ConnectionMessage::Event { event: ControlEvent::SessionChanged(changed_session_id), .. }) => {
                        if source_session_changed_requires_quit(&session_id, &changed_session_id) {
                            app.should_quit = true;
                        }
                        Vec::new()
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
                    directives, &mut coordinator, &tmux, &session_id, &client_tty, &connection_tx, &mut control,
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
                    &tmux, &session_id, &client_tty, &connection_tx, &mut control,
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
                    directives, &mut coordinator, &tmux, &session_id, &client_tty, &connection_tx, &mut control,
                    &mut pending_connection_generation, &mut active_connection_generation,
                    &mut next_connection_generation, &mut debounce_deadline, &snapshot_tx,
                    &mut next_snapshot_seq, &snapshot_generation,
                    &mut in_flight_snapshot,
                );
                if snapshot_generation.accepts(response.seq, response.mutation_generation) {
                    let source_session_alive = match &event {
                        Event::Snapshot { outcome, .. } => {
                            control.is_some() || snapshot_keeps_launch_session(outcome, &session_id)
                        }
                        Event::SnapshotFailed(_) => true,
                        _ => unreachable!("snapshot responses only produce snapshot events"),
                    };
                    if !source_session_alive {
                        app.should_quit = true;
                    } else if apply_event(&mut terminal, &mut app, event, &tmux, control.as_ref(), &client_tty, &mut preview_tick, &preview_tx, &creation_tx, &mut creation_task).await?.mutated {
                        snapshot_generation.record_successful_mutation();
                    }
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
                    &creation_tx, &mut creation_task,
                ).await?;
            },
            progress = creation_progress.recv() => if let Some(progress) = progress {
                let effects = apply_event(&mut terminal, &mut app, Event::CreationProgress(progress), &tmux, control.as_ref(), &client_tty, &mut preview_tick, &preview_tx, &creation_tx, &mut creation_task).await?;
                process_action_effects(effects, &mut coordinator, &tmux, &session_id, &client_tty, &connection_tx, &mut control, &mut pending_connection_generation, &mut active_connection_generation, &mut next_connection_generation, &mut debounce_deadline, &snapshot_tx, &mut next_snapshot_seq, &mut snapshot_generation, &mut in_flight_snapshot);
            },
        }
    }
    Ok(())
    }
    .await;
    finish_creation_task_result(&mut creation_task, result).await
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

async fn next_runtime_timer(
    snapshot: &mut tokio::time::Interval,
    preview: &mut tokio::time::Interval,
) -> RuntimeTimer {
    tokio::select! {
        _ = snapshot.tick() => RuntimeTimer::Snapshot,
        _ = preview.tick() => RuntimeTimer::Preview,
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_runtime_timer_step<B>(
    timer: RuntimeTimer,
    terminal: &mut Terminal<B>,
    app: &mut AppState,
    coordinator: &mut TransportCoordinator,
    tmux: &TmuxExec,
    session_id: &str,
    control: &mut Option<ControlHandle>,
    client_tty: &str,
    connection_tx: &mpsc::UnboundedSender<ConnectionMessage>,
    pending_connection_generation: &mut Option<u64>,
    active_connection_generation: &mut Option<u64>,
    next_connection_generation: &mut u64,
    debounce_deadline: &mut Option<tokio::time::Instant>,
    snapshot_tx: &mpsc::UnboundedSender<SnapshotResponse>,
    next_snapshot_seq: &mut u64,
    snapshot_generation: &mut SnapshotGeneration,
    in_flight_snapshot: &mut SnapshotInFlight,
    preview_tick: &mut tokio::time::Interval,
    preview_tx: &mpsc::UnboundedSender<PreviewResponse>,
    creation_tx: &mpsc::UnboundedSender<CreationProgress>,
    creation_task: &mut Option<CreationTask>,
) -> Result<()>
where
    B: Backend,
    B::Error: std::error::Error + Send + Sync + 'static,
{
    match timer {
        RuntimeTimer::Snapshot => {
            dispatch_directives(
                coordinator.input(pane_dash::transport::TransportInput::FallbackTick),
                coordinator,
                tmux,
                session_id,
                client_tty,
                connection_tx,
                control,
                pending_connection_generation,
                active_connection_generation,
                next_connection_generation,
                debounce_deadline,
                snapshot_tx,
                next_snapshot_seq,
                snapshot_generation,
                in_flight_snapshot,
            );
            if apply_event(
                terminal,
                app,
                Event::Tick { now: now_secs() },
                tmux,
                control.as_ref(),
                client_tty,
                preview_tick,
                preview_tx,
                creation_tx,
                creation_task,
            )
            .await?
            .mutated
            {
                snapshot_generation.record_successful_mutation();
            }
        }
        RuntimeTimer::Preview => {
            let _ = apply_event(
                terminal,
                app,
                Event::PreviewTick,
                tmux,
                control.as_ref(),
                client_tty,
                preview_tick,
                preview_tx,
                creation_tx,
                creation_task,
            )
            .await?;
        }
    }
    Ok(())
}

fn bench_first_frame_message(elapsed_ms: f64) -> String {
    format!("pane-dash coldframe_ms={elapsed_ms:.3}")
}

fn bench_config_to_frame_message(elapsed_ms: f64) -> String {
    format!("pane-dash config_to_frame_ms={elapsed_ms:.3}")
}

#[allow(clippy::too_many_arguments)]
fn dispatch_directives(
    directives: Vec<TransportDirective>,
    coordinator: &mut TransportCoordinator,
    tmux: &TmuxExec,
    session_id: &str,
    client_tty: &str,
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
                    client_tty.into(),
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
                let mutation_generation = snapshot_generation.current();
                let seq = spawn_snapshot(
                    snapshot_tx,
                    next_snapshot_seq,
                    mutation_generation,
                    SnapshotSource::Channel {
                        connection_generation,
                    },
                    async move { handle.snapshot().await.map_err(|error| error.to_string()) },
                );
                in_flight_snapshot.spawned(seq, mutation_generation);
            }
            TransportDirective::OneShotSnapshot => {
                let tmux = tmux.clone();
                let mutation_generation = snapshot_generation.current();
                let seq = spawn_snapshot(
                    snapshot_tx,
                    next_snapshot_seq,
                    mutation_generation,
                    SnapshotSource::OneShot,
                    async move { tmux.snapshot().await.map_err(|error| error.to_string()) },
                );
                in_flight_snapshot.spawned(seq, mutation_generation);
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

#[allow(clippy::too_many_arguments)]
fn process_action_effects(
    effects: ActionEffects,
    coordinator: &mut TransportCoordinator,
    tmux: &TmuxExec,
    session_id: &str,
    client_tty: &str,
    connection_tx: &mpsc::UnboundedSender<ConnectionMessage>,
    control: &mut Option<ControlHandle>,
    pending_connection_generation: &mut Option<u64>,
    active_connection_generation: &mut Option<u64>,
    next_connection_generation: &mut u64,
    debounce_deadline: &mut Option<tokio::time::Instant>,
    snapshot_tx: &mpsc::UnboundedSender<SnapshotResponse>,
    next_snapshot_seq: &mut u64,
    snapshot_generation: &mut SnapshotGeneration,
    in_flight_snapshot: &mut SnapshotInFlight,
) {
    if effects.mutated {
        snapshot_generation.record_successful_mutation();
    }
    if effects.refresh_now {
        dispatch_directives(
            coordinator.input(pane_dash::transport::TransportInput::RefreshNow),
            coordinator,
            tmux,
            session_id,
            client_tty,
            connection_tx,
            control,
            pending_connection_generation,
            active_connection_generation,
            next_connection_generation,
            debounce_deadline,
            snapshot_tx,
            next_snapshot_seq,
            snapshot_generation,
            in_flight_snapshot,
        );
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
async fn apply_event<B>(
    terminal: &mut Terminal<B>,
    app: &mut AppState,
    event: Event,
    tmux: &TmuxExec,
    control: Option<&ControlHandle>,
    client_tty: &str,
    preview_interval: &mut tokio::time::Interval,
    preview_tx: &mpsc::UnboundedSender<PreviewResponse>,
    creation_tx: &mpsc::UnboundedSender<CreationProgress>,
    creation_task: &mut Option<CreationTask>,
) -> Result<ActionEffects>
where
    B: Backend,
    B::Error: std::error::Error + Send + Sync + 'static,
{
    let _ = reap_finished_creation_task(creation_task, creation_tx).await;
    let result = reduce(app, event);
    let mut effects = ActionEffects::default();
    for action in result.actions {
        match action {
            Action::ToggleGroup(on) => {
                tmux.set_group(on).await?;
                effects.mutated = true;
                effects.refresh_now = true;
            }
            Action::Jump { target, zoom } => {
                if execute_jump(tmux, control, client_tty, &target, zoom).await {
                    app.should_quit = true;
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
            Action::SendText { pane_id, text } => {
                let outcome = send_text(tmux, &pane_id, &text).await;
                let succeeded = outcome == ActionOutcome::Success;
                let completion = reduce(
                    app,
                    Event::ActionFinished {
                        kind: CompletedAction::Send,
                        pane_id,
                        outcome,
                    },
                );
                effects.mutated |= succeeded;
                effects.refresh_now |= succeeded;
                if completion.changed {
                    redraw(terminal, app)?;
                }
            }
            Action::KillPane { pane_id } => {
                let outcome = kill_pane(tmux, &pane_id).await;
                let succeeded = outcome == ActionOutcome::Success;
                let completion = reduce(
                    app,
                    Event::ActionFinished {
                        kind: CompletedAction::Kill,
                        pane_id,
                        outcome,
                    },
                );
                effects.mutated |= succeeded;
                effects.refresh_now |= succeeded;
                if completion.changed {
                    redraw(terminal, app)?;
                }
            }
            Action::Quit => {}
            Action::StartCreation { id, request } => {
                start_creation(creation_task, creation_tx, tmux.clone(), id, request).await;
            }
            Action::CreationMutation => effects.mutated = true,
            Action::RefreshNow => effects.refresh_now = true,
        }
    }
    if result.changed {
        redraw(terminal, app)?;
    }
    Ok(effects)
}

async fn reap_finished_creation_task(
    task: &mut Option<CreationTask>,
    progress: &mpsc::UnboundedSender<CreationProgress>,
) -> bool {
    if !task.as_ref().is_some_and(|task| task.join.is_finished()) {
        return false;
    }
    let task = task.take().expect("finished creation task is present");
    let id = task.id;
    if let Err(error) = task.join.await {
        let _ = progress.send(CreationProgress::TaskFailed {
            id,
            error: format!("creation worker ended abnormally: {error}"),
        });
    }
    true
}

async fn start_creation(
    task: &mut Option<CreationTask>,
    progress: &mpsc::UnboundedSender<CreationProgress>,
    tmux: TmuxExec,
    id: CreationId,
    request: CreateRequest,
) {
    if let Some(previous) = task.take() {
        let id = previous.id;
        let _ = previous.cancel.send(());
        if let Err(error) = previous.join.await {
            let _ = progress.send(CreationProgress::TaskFailed {
                id,
                error: format!("creation worker ended abnormally: {error}"),
            });
        }
    }
    let (cancel, cancellation) = oneshot::channel();
    let progress = progress.clone();
    let join = tokio::spawn(async move {
        run_creation(tmux, id, request, progress, cancellation).await;
    });
    *task = Some(CreationTask { id, cancel, join });
}

async fn cleanup_creation_task(task: &mut Option<CreationTask>) {
    if let Some(task) = task.take() {
        let _ = task.cancel.send(());
        if let Err(error) = task.join.await {
            eprintln!("creation worker ended abnormally during cleanup: {error}");
        }
    }
}

async fn finish_creation_task_result<T>(
    task: &mut Option<CreationTask>,
    result: Result<T>,
) -> Result<T> {
    cleanup_creation_task(task).await;
    result
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

fn redraw<B>(terminal: &mut Terminal<B>, app: &mut AppState) -> Result<()>
where
    B: Backend,
    B::Error: std::error::Error + Send + Sync + 'static,
{
    let full_area = terminal.size()?.into();
    let viewport_height = ui::preview_inner_height(app, full_area);
    reduce(app, Event::PreviewViewport(viewport_height));
    if let Some(metrics) = ui::help_viewport(app, full_area) {
        reduce(
            app,
            Event::HelpViewport {
                max_offset: metrics.max_offset,
                page_height: metrics.page_height,
            },
        );
    }
    let now = now_secs();
    app.prepare_render(now);
    terminal.draw(|frame| ui::render(frame, app, now))?;
    Ok(())
}

fn parse_args() -> Result<(String, String, String, bool)> {
    parse_args_from(std::env::args().skip(1))
}

fn parse_args_from(
    args: impl IntoIterator<Item = String>,
) -> Result<(String, String, String, bool)> {
    let mut positional = Vec::new();
    let mut bench_first_frame = false;
    for arg in args {
        if arg == "--bench-first-frame" {
            bench_first_frame = true;
        } else {
            positional.push(arg);
        }
    }
    if positional.len() != 3 {
        anyhow::bail!("expected client_tty session_id pane_id");
    }
    let client_tty = positional.remove(0);
    if !is_safe_client_tty(&client_tty) {
        anyhow::bail!("invalid client tty");
    }
    Ok((
        client_tty,
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
        ActionEffects, ConnectionMessageKind, ConnectionRoute, RuntimeTimer, SnapshotGeneration,
        SnapshotInFlight, SnapshotSource, apply_event, bench_config_to_frame_message,
        bench_first_frame_message, classify_connection_message, classify_snapshot_payload,
        cleanup_creation_task, clear_terminated_connection_state, dispatch_directives,
        next_runtime_timer, parse_args_from, preview_interval, process_action_effects, redraw,
        run_runtime_timer_step, snapshot_interval, snapshot_keeps_launch_session,
        source_session_changed_requires_quit, spawn_preview_capture, start_creation,
        start_preview_capture, sync_transport_degraded,
    };
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    use pane_dash::app::{Action, AppState, Event, HelpState, Modal, reduce};
    use pane_dash::config::LoadedUiConfig;
    use pane_dash::creation::{CreateContext, CreateDraft, CreationProgress, build_request};
    use pane_dash::model::{Model, ModelConfig};
    use pane_dash::options::DashConfig;
    use pane_dash::preview::parse_preview;
    use pane_dash::snapshot::parse;
    use pane_dash::tmux_exec::{SNAPSHOT_FORMAT, TmuxExec};
    use pane_dash::transport::{
        SnapshotCompletion, TransportCoordinator, TransportDirective, TransportInput, TransportMode,
    };
    use ratatui::{Terminal, backend::TestBackend};
    use std::os::unix::fs::PermissionsExt;
    use std::time::Duration;
    use std::{fs, process::Command};
    use tempfile::TempDir;
    use tokio::sync::mpsc;

    fn valid_record() -> Vec<u8> {
        b"\x1e$1\x1fsession\x1f@1\x1f0\x1fwindow\x1f%1\x1f0\x1f1\x1fopencode\x1f/tmp\x1f0\x1fworking\x1f1\x1f1\x1f\x1f\x1f\x1f1\n"
            .to_vec()
    }

    fn fake_snapshot_tmux(dir: &TempDir) -> (TmuxExec, std::path::PathBuf) {
        let log = dir.path().join("argv.log");
        let executable = dir.path().join("fake-tmux");
        fs::write(
            &executable,
            format!(
                "#!/bin/sh\nprintf '%s\\0' \"$@\" >> '{}'\nprintf '\\n' >> '{}'\nif [ \"$1\" = list-panes ]; then\n    printf '%b' '\\0036$1\\0037session\\0037@1\\00370\\0037window\\0037%1\\00370\\00371\\0037opencode\\0037/tmp\\00370\\0037working\\00371\\00371\\0037\\0037\\0037\\00371\\n'\nfi\n",
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
            LoadedUiConfig::default(),
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

    #[test]
    fn redraw_routes_help_viewport_before_render_and_clamps_in_the_same_frame() {
        let mut app = preview_app();
        app.modal = Some(Modal::Help(HelpState {
            offset: 99,
            max_offset: 99,
            page_height: 1,
        }));
        let mut terminal = Terminal::new(TestBackend::new(92, 24)).unwrap();

        redraw(&mut terminal, &mut app).unwrap();

        assert_eq!(
            app.modal,
            Some(Modal::Help(HelpState {
                offset: 20,
                max_offset: 20,
                page_height: 21,
            }))
        );
    }

    #[test]
    fn redraw_does_not_create_help_state_when_help_is_inactive() {
        let mut app = preview_app();
        let mut terminal = Terminal::new(TestBackend::new(92, 24)).unwrap();

        redraw(&mut terminal, &mut app).unwrap();

        assert_eq!(app.modal, None);
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

    async fn recv_without_advancing<T>(
        rx: &mut mpsc::UnboundedReceiver<T>,
        description: &str,
    ) -> T {
        for _ in 0..10_000 {
            match rx.try_recv() {
                Ok(value) => return value,
                Err(mpsc::error::TryRecvError::Empty) => tokio::task::yield_now().await,
                Err(mpsc::error::TryRecvError::Disconnected) => {
                    panic!("{description} channel closed")
                }
            }
        }
        panic!("{description} did not arrive while Tokio time was paused")
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
        let frame = parse_preview("%1".into(), b"one\ntwo\nthree".to_vec());
        app.preview.frame = Some(frame.clone());
        app.preview.lines_from_bottom = 1;
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
    async fn runtime_timer_selector_dispatches_preview_before_snapshot() {
        let mut snapshot = snapshot_interval();
        let mut preview = preview_interval();

        tokio::time::advance(Duration::from_millis(500)).await;

        assert_eq!(
            next_runtime_timer(&mut snapshot, &mut preview).await,
            RuntimeTimer::Preview
        );
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
        let frame = parse_preview("%1".into(), b"one\ntwo\nthree".to_vec());
        app.preview.frame = Some(frame.clone());
        app.preview.lines_from_bottom = 1;

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
                "/dev/ttys001",
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
            let bytes = response.result.as_ref().expect("fake snapshot bytes");
            assert_eq!(bytes, &valid_record());
            let parsed = parse(bytes);
            assert_eq!(parsed.records.len(), 1);
            assert_eq!(parsed.dropped, 0);
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
            assert_eq!(app.selected_pane(), Some("%1".into()));
            assert_eq!(app.preview.target, Some("%1".into()));
            assert!(app.preview.inspect);
            assert_eq!(app.preview.frame, Some(frame.clone()));
            assert_eq!(app.preview.lines_from_bottom, 1);
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
            LoadedUiConfig::default(),
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
                "/dev/ttys001",
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
                "/dev/ttys001",
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
        in_flight.spawned(1, 0);
        in_flight.reset();
        in_flight.spawned(2, 0);
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

    #[tokio::test(flavor = "current_thread")]
    async fn successful_send_effects_bump_before_refresh_and_failures_do_nothing() {
        let dir = TempDir::new().unwrap();
        let (tmux, _) = fake_snapshot_tmux(&dir);
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
        let mut next_snapshot_seq = 1;
        let mut snapshot_generation = SnapshotGeneration::default();
        let mut in_flight_snapshot = SnapshotInFlight::default();

        assert!(snapshot_generation.accepts(1, 0));
        process_action_effects(
            ActionEffects {
                mutated: true,
                refresh_now: true,
            },
            &mut coordinator,
            &tmux,
            "session",
            "/dev/ttys001",
            &connection_tx,
            &mut control,
            &mut pending_connection_generation,
            &mut active_connection_generation,
            &mut next_connection_generation,
            &mut debounce_deadline,
            &snapshot_tx,
            &mut next_snapshot_seq,
            &mut snapshot_generation,
            &mut in_flight_snapshot,
        );
        let response = snapshots.recv().await.expect("post-send snapshot");
        assert_eq!(snapshot_generation.current(), 1);
        assert_eq!(response.mutation_generation, 1);
        assert_eq!(in_flight_snapshot.mutation_generation, Some(1));
        assert!(snapshot_generation.accepts(response.seq, response.mutation_generation));
        assert!(!snapshot_generation.accepts(response.seq + 1, 0));

        let next_snapshot_seq_before = next_snapshot_seq;
        process_action_effects(
            ActionEffects::default(),
            &mut coordinator,
            &tmux,
            "session",
            "/dev/ttys001",
            &connection_tx,
            &mut control,
            &mut pending_connection_generation,
            &mut active_connection_generation,
            &mut next_connection_generation,
            &mut debounce_deadline,
            &snapshot_tx,
            &mut next_snapshot_seq,
            &mut snapshot_generation,
            &mut in_flight_snapshot,
        );
        assert_eq!(snapshot_generation.current(), 1);
        assert_eq!(next_snapshot_seq, next_snapshot_seq_before);
    }

    #[tokio::test(start_paused = true, flavor = "current_thread")]
    async fn runtime_timers_advance_while_creation_is_blocked() {
        let dir = TempDir::new().unwrap();
        let release = dir.path().join("release");
        let pid = dir.path().join("creation.pid");
        let log = dir.path().join("tmux.log");
        let executable = dir.path().join("fake-tmux");
        fs::write(
            &executable,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$1\" >> '{}'\ncase \"$1\" in\nsplit-window) printf '%s' \"$$\" > '{}'; while [ ! -f '{}' ]; do sleep 0.01; done; printf '%%44\\n' ;;\ncapture-pane) printf 'preview advanced\\n' ;;\nlist-panes) printf '%b' '\\036$1\\037session\\037@1\\0370\\037window\\037%1\\0370\\0371\\037opencode\\037/tmp\\0370\\037idle\\0371\\0371\\037\\037\\037\\0371\\n' ;;\nesac\n",
                log.display(),
                pid.display(),
                release.display(),
            ),
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        let tmux = TmuxExec::new(executable);
        let mut terminal = Terminal::new(TestBackend::new(100, 30)).unwrap();
        let mut app = preview_app();
        let mut preview_tick = preview_interval();
        let (preview_tx, mut preview_responses) = mpsc::unbounded_channel();
        let (creation_tx, mut progress) = mpsc::unbounded_channel();
        let (snapshot_tx, mut snapshots) = mpsc::unbounded_channel();
        let (connection_tx, _connection_messages) = mpsc::unbounded_channel();
        let (mut coordinator, _) = TransportCoordinator::new();
        coordinator.input(TransportInput::ConnectionFailed);
        coordinator.input(TransportInput::ConnectionFailed);
        assert_eq!(coordinator.mode(), TransportMode::Degraded);
        let mut control = None;
        let mut pending_connection_generation = None;
        let mut active_connection_generation = None;
        let mut next_connection_generation = 0;
        let mut debounce_deadline = None;
        let mut next_snapshot_seq = 0;
        let mut snapshot_generation = SnapshotGeneration::default();
        let mut in_flight_snapshot = SnapshotInFlight::default();
        let mut snapshot_tick = snapshot_interval();
        let mut task = None;

        for key in [KeyCode::Char('n'), KeyCode::Enter, KeyCode::Enter] {
            apply_event(
                &mut terminal,
                &mut app,
                Event::Key(KeyEvent::new(key, KeyModifiers::NONE)),
                &tmux,
                None,
                "/dev/ttys001",
                &mut preview_tick,
                &preview_tx,
                &creation_tx,
                &mut task,
            )
            .await
            .unwrap();
        }
        assert!(task.is_some());
        assert!(!app.should_quit);

        let (sequence, pane_id) = app
            .preview
            .in_flight
            .clone()
            .expect("initial model selection requests a preview");
        start_preview_capture(
            &mut preview_tick,
            &preview_tx,
            tmux.clone(),
            sequence,
            pane_id,
        );
        let response = recv_without_advancing(
            &mut preview_responses,
            "initial preview while creation is blocked",
        )
        .await;
        apply_event(
            &mut terminal,
            &mut app,
            Event::PreviewCaptured {
                sequence: response.sequence,
                pane_id: response.pane_id,
                result: response.result,
            },
            &tmux,
            None,
            "/dev/ttys001",
            &mut preview_tick,
            &preview_tx,
            &creation_tx,
            &mut task,
        )
        .await
        .unwrap();

        tokio::time::advance(Duration::from_millis(500)).await;
        assert_eq!(
            next_runtime_timer(&mut snapshot_tick, &mut preview_tick).await,
            RuntimeTimer::Preview
        );
        run_runtime_timer_step(
            RuntimeTimer::Preview,
            &mut terminal,
            &mut app,
            &mut coordinator,
            &tmux,
            "session",
            &mut control,
            "/dev/ttys001",
            &connection_tx,
            &mut pending_connection_generation,
            &mut active_connection_generation,
            &mut next_connection_generation,
            &mut debounce_deadline,
            &snapshot_tx,
            &mut next_snapshot_seq,
            &mut snapshot_generation,
            &mut in_flight_snapshot,
            &mut preview_tick,
            &preview_tx,
            &creation_tx,
            &mut task,
        )
        .await
        .unwrap();
        let response = recv_without_advancing(
            &mut preview_responses,
            "production preview timer capture while creation is blocked",
        )
        .await;
        apply_event(
            &mut terminal,
            &mut app,
            Event::PreviewCaptured {
                sequence: response.sequence,
                pane_id: response.pane_id,
                result: response.result,
            },
            &tmux,
            None,
            "/dev/ttys001",
            &mut preview_tick,
            &preview_tx,
            &creation_tx,
            &mut task,
        )
        .await
        .unwrap();
        assert!(app.preview.frame.is_some());

        let old_snapshot_hash = app.model.content_hash();
        tokio::time::advance(Duration::from_millis(500)).await;
        let mut snapshot_completed = false;
        for _ in 0..2 {
            match next_runtime_timer(&mut snapshot_tick, &mut preview_tick).await {
                RuntimeTimer::Preview => {
                    run_runtime_timer_step(
                        RuntimeTimer::Preview,
                        &mut terminal,
                        &mut app,
                        &mut coordinator,
                        &tmux,
                        "session",
                        &mut control,
                        "/dev/ttys001",
                        &connection_tx,
                        &mut pending_connection_generation,
                        &mut active_connection_generation,
                        &mut next_connection_generation,
                        &mut debounce_deadline,
                        &snapshot_tx,
                        &mut next_snapshot_seq,
                        &mut snapshot_generation,
                        &mut in_flight_snapshot,
                        &mut preview_tick,
                        &preview_tx,
                        &creation_tx,
                        &mut task,
                    )
                    .await
                    .unwrap();
                    let response = recv_without_advancing(
                        &mut preview_responses,
                        "ready preview response before retrying the timer selector",
                    )
                    .await;
                    apply_event(
                        &mut terminal,
                        &mut app,
                        Event::PreviewCaptured {
                            sequence: response.sequence,
                            pane_id: response.pane_id,
                            result: response.result,
                        },
                        &tmux,
                        None,
                        "/dev/ttys001",
                        &mut preview_tick,
                        &preview_tx,
                        &creation_tx,
                        &mut task,
                    )
                    .await
                    .unwrap();
                }
                RuntimeTimer::Snapshot => {
                    run_runtime_timer_step(
                        RuntimeTimer::Snapshot,
                        &mut terminal,
                        &mut app,
                        &mut coordinator,
                        &tmux,
                        "session",
                        &mut control,
                        "/dev/ttys001",
                        &connection_tx,
                        &mut pending_connection_generation,
                        &mut active_connection_generation,
                        &mut next_connection_generation,
                        &mut debounce_deadline,
                        &snapshot_tx,
                        &mut next_snapshot_seq,
                        &mut snapshot_generation,
                        &mut in_flight_snapshot,
                        &mut preview_tick,
                        &preview_tx,
                        &creation_tx,
                        &mut task,
                    )
                    .await
                    .unwrap();
                    let response = recv_without_advancing(
                        &mut snapshots,
                        "production fallback timer snapshot",
                    )
                    .await;
                    assert!(in_flight_snapshot.accepts(response.seq));
                    let (completion, outcome) =
                        classify_snapshot_payload(response.source, response.result);
                    assert_eq!(completion, SnapshotCompletion::Valid);
                    let event = Event::Snapshot {
                        outcome: outcome.expect("fallback snapshot must parse"),
                        observed_at: response.observed_at,
                    };
                    dispatch_directives(
                        coordinator.snapshot_completed(completion),
                        &mut coordinator,
                        &tmux,
                        "session",
                        "/dev/ttys001",
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
                    apply_event(
                        &mut terminal,
                        &mut app,
                        event,
                        &tmux,
                        None,
                        "/dev/ttys001",
                        &mut preview_tick,
                        &preview_tx,
                        &creation_tx,
                        &mut task,
                    )
                    .await
                    .unwrap();
                    snapshot_completed = true;
                    break;
                }
            }
        }
        assert!(
            snapshot_completed,
            "snapshot must not be starved by the preview timer"
        );
        assert_ne!(app.model.content_hash(), old_snapshot_hash);
        assert!(fs::read_to_string(&log).unwrap().contains("list-panes"));

        apply_event(
            &mut terminal,
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Char('j'), KeyModifiers::NONE)),
            &tmux,
            None,
            "/dev/ttys001",
            &mut preview_tick,
            &preview_tx,
            &creation_tx,
            &mut task,
        )
        .await
        .unwrap();
        assert!(!app.should_quit);
        assert!(
            task.is_some(),
            "creation task ended before input; fake tmux calls: {:?}; progress: {:?}",
            fs::read_to_string(&log).unwrap(),
            progress.try_recv()
        );
        let creation_pid = fs::read_to_string(&pid).unwrap();
        assert!(
            Command::new("kill")
                .args(["-0", creation_pid.trim()])
                .status()
                .unwrap()
                .success(),
            "creation worker must remain blocked while input is processed"
        );

        fs::write(release, "").unwrap();
        let mut finished = false;
        while !finished {
            let item =
                recv_without_advancing(&mut progress, "creation worker progress before Finished")
                    .await;
            let terminal_event = matches!(item, CreationProgress::Finished { .. });
            apply_event(
                &mut terminal,
                &mut app,
                Event::CreationProgress(item),
                &tmux,
                None,
                "/dev/ttys001",
                &mut preview_tick,
                &preview_tx,
                &creation_tx,
                &mut task,
            )
            .await
            .unwrap();
            finished = terminal_event;
        }
        assert!(
            finished,
            "creation worker must emit a terminal Finished event"
        );
        assert!(progress.try_recv().is_err());
        cleanup_creation_task(&mut task).await;
        assert!(task.is_none());
        assert!(
            !Command::new("kill")
                .args(["-0", creation_pid.trim()])
                .status()
                .unwrap()
                .success(),
            "terminal cleanup must reap the creation child"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn panicking_creation_task_reports_once_and_unlocks_the_correlated_form() {
        let mut app = preview_app();
        let mut id = None;
        for key in [KeyCode::Char('n'), KeyCode::Enter, KeyCode::Enter] {
            let result = reduce(&mut app, Event::Key(KeyEvent::new(key, KeyModifiers::NONE)));
            if let Some(Action::StartCreation { id: started, .. }) = result.actions.first() {
                id = Some(*started);
            }
        }
        let id = id.expect("create submission emits its correlated start action");
        let (cancel, _cancellation) = tokio::sync::oneshot::channel();
        let mut task = Some(super::CreationTask {
            id,
            cancel,
            join: tokio::spawn(async { panic!("creation test panic") }),
        });
        let (creation_tx, mut progress) = mpsc::unbounded_channel();

        tokio::time::timeout(Duration::from_secs(1), async {
            while !task.as_ref().is_some_and(|task| task.join.is_finished()) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("panicking creation task must finish");
        assert!(super::reap_finished_creation_task(&mut task, &creation_tx).await);
        assert!(!super::reap_finished_creation_task(&mut task, &creation_tx).await);

        let task_progress = tokio::time::timeout(Duration::from_secs(1), progress.recv())
            .await
            .expect("supervision must forward the failed task")
            .expect("creation progress channel remains open");
        assert!(matches!(
            task_progress,
            CreationProgress::TaskFailed { id: failed, .. } if failed == id
        ));
        assert!(progress.try_recv().is_err());

        let dir = TempDir::new().unwrap();
        let (tmux, _) = fake_snapshot_tmux(&dir);
        let mut terminal = Terminal::new(TestBackend::new(100, 30)).unwrap();
        let mut preview_tick = preview_interval();
        let (preview_tx, _) = mpsc::unbounded_channel();
        let (creation_tx, _) = mpsc::unbounded_channel();
        let effects = apply_event(
            &mut terminal,
            &mut app,
            Event::CreationProgress(task_progress),
            &tmux,
            None,
            "/dev/ttys001",
            &mut preview_tick,
            &preview_tx,
            &creation_tx,
            &mut task,
        )
        .await
        .unwrap();

        assert!(!effects.mutated);
        assert!(!effects.refresh_now);
        assert!(matches!(
            app.pending_creation.as_ref().map(|pending| &pending.state),
            Some(pane_dash::app::PendingCreationState::Error(error))
                if error.contains("creation worker ended abnormally")
        ));
        assert!(progress.try_recv().is_err());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn cleanup_creation_task_cancels_and_reaps_the_active_child() {
        let dir = TempDir::new().unwrap();
        let pid_file = dir.path().join("pid");
        let executable = dir.path().join("fake-tmux");
        fs::write(
            &executable,
            format!(
                "#!/bin/sh\necho $$ > '{}'\nwhile :; do sleep 1; done\n",
                pid_file.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        let request = build_request(
            CreateContext::NewSession,
            &CreateDraft {
                name: String::new(),
                cwd: String::new(),
                command: String::new(),
            },
        )
        .unwrap();
        let (tx, mut progress) = mpsc::unbounded_channel();
        let mut task = None;
        start_creation(
            &mut task,
            &tx,
            TmuxExec::new(executable),
            pane_dash::creation::CreationId(9),
            request,
        )
        .await;
        assert!(matches!(
            progress.recv().await,
            Some(CreationProgress::Stage { .. })
        ));
        tokio::time::timeout(Duration::from_secs(1), async {
            while fs::read_to_string(&pid_file)
                .unwrap_or_default()
                .trim()
                .is_empty()
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let pid = fs::read_to_string(&pid_file).unwrap().trim().to_owned();

        cleanup_creation_task(&mut task).await;

        assert!(task.is_none());
        assert!(
            !std::process::Command::new("kill")
                .args(["-0", &pid])
                .status()
                .unwrap()
                .success()
        );
        let events: Vec<_> = std::iter::from_fn(|| progress.try_recv().ok()).collect();
        assert!(matches!(
            events.as_slice(),
            [CreationProgress::TimedOut { .. }]
        ));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn loop_error_cleanup_reaps_the_active_creation_child_and_preserves_error() {
        let dir = TempDir::new().unwrap();
        let pid_file = dir.path().join("pid");
        let executable = dir.path().join("fake-tmux");
        fs::write(
            &executable,
            format!(
                "#!/bin/sh\necho $$ > '{}'\nwhile :; do sleep 1; done\n",
                pid_file.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        let request = build_request(
            CreateContext::NewSession,
            &CreateDraft {
                name: String::new(),
                cwd: String::new(),
                command: String::new(),
            },
        )
        .unwrap();
        let (tx, mut progress) = mpsc::unbounded_channel();
        let mut task = None;
        start_creation(
            &mut task,
            &tx,
            TmuxExec::new(executable),
            pane_dash::creation::CreationId(10),
            request,
        )
        .await;
        let _ = progress.recv().await;
        tokio::time::timeout(Duration::from_secs(1), async {
            while fs::read_to_string(&pid_file)
                .unwrap_or_default()
                .trim()
                .is_empty()
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let pid = fs::read_to_string(&pid_file).unwrap().trim().to_owned();

        let error = super::finish_creation_task_result(
            &mut task,
            Err::<(), _>(anyhow::anyhow!("loop failed")),
        )
        .await
        .unwrap_err();

        assert_eq!(error.to_string(), "loop failed");
        assert!(task.is_none());
        assert!(
            !std::process::Command::new("kill")
                .args(["-0", &pid])
                .status()
                .unwrap()
                .success()
        );
    }

    #[test]
    fn formats_the_cold_frame_measurement_for_the_probe() {
        assert_eq!(
            bench_first_frame_message(12.345),
            "pane-dash coldframe_ms=12.345"
        );
    }

    #[test]
    fn formats_the_config_to_frame_measurement_for_the_probe() {
        assert_eq!(
            bench_config_to_frame_message(12.345),
            "pane-dash config_to_frame_ms=12.345"
        );
    }

    #[test]
    fn parses_safe_portable_client_tty_arguments() {
        assert_eq!(
            parse_args_from([
                "/dev/cu.usbserial-1".to_owned(),
                "$7".to_owned(),
                "%3".to_owned(),
            ])
            .unwrap(),
            (
                "/dev/cu.usbserial-1".to_owned(),
                "$7".to_owned(),
                "%3".to_owned(),
                false,
            )
        );
    }

    #[test]
    fn rejects_unsafe_client_tty_arguments_before_one_shot_actions() {
        let error = parse_args_from(["/dev/tty:1".to_owned(), "$7".to_owned(), "%3".to_owned()])
            .unwrap_err();

        assert!(error.to_string().contains("invalid client tty"));
    }

    #[test]
    fn classifies_connection_messages_by_kind_and_generation() {
        let pending = Some(2);
        let active = Some(3);

        for kind in [
            ConnectionMessageKind::Connected,
            ConnectionMessageKind::Failed,
            ConnectionMessageKind::TopologyChanged,
            ConnectionMessageKind::FocusChanged,
            ConnectionMessageKind::SessionChanged,
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
            classify_connection_message(ConnectionMessageKind::FocusChanged, 3, pending, active),
            ConnectionRoute::FocusChanged
        );
        assert_eq!(
            classify_connection_message(ConnectionMessageKind::SessionChanged, 3, pending, active),
            ConnectionRoute::SessionChanged
        );
        assert_eq!(
            classify_connection_message(ConnectionMessageKind::Terminated, 3, pending, active),
            ConnectionRoute::ChannelEnded
        );
    }

    #[test]
    fn accepted_clean_snapshots_require_the_launch_session_but_tolerate_drops() {
        let matching = parse(&valid_record());
        assert!(snapshot_keeps_launch_session(&matching, "$1"));
        assert!(!snapshot_keeps_launch_session(&matching, "$9"));

        let mut renamed_bytes = valid_record();
        renamed_bytes.splice(4..11, b"renamed".iter().copied());
        let renamed = parse(&renamed_bytes);
        assert!(snapshot_keeps_launch_session(&renamed, "$1"));

        let dropped = parse(b"\x1ebad\n");
        assert!(dropped.dropped > 0);
        assert!(snapshot_keeps_launch_session(&dropped, "$9"));
    }

    #[test]
    fn current_session_changed_only_quits_when_the_launch_id_changes() {
        assert!(!source_session_changed_requires_quit("$7", "$7"));
        assert!(source_session_changed_requires_quit("$7", "$8"));
    }

    #[test]
    fn relayed_focus_updates_preview_state_and_respects_inspect_mode() {
        let mut app = preview_app();
        assert!(reduce(&mut app, Event::TerminalFocus(false)).changed);
        assert!(!app.preview.terminal_focused);
        assert!(reduce(&mut app, Event::PreviewTick).actions.is_empty());

        let resumed = reduce(&mut app, Event::TerminalFocus(true));
        assert!(app.preview.terminal_focused);
        assert!(matches!(
            resumed.actions.as_slice(),
            [Action::CapturePreview { .. }]
        ));

        reduce(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Char('u'), KeyModifiers::CONTROL)),
        );
        reduce(&mut app, Event::TerminalFocus(false));
        assert!(
            reduce(&mut app, Event::TerminalFocus(true))
                .actions
                .is_empty()
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
            "/dev/ttys001",
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
        in_flight_snapshot.spawned(4, 0);
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
            "/dev/ttys001",
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
