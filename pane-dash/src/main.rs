use std::io;
use std::time::Duration;

use anyhow::{Context, Result};
use crossterm::event::{Event as CrosstermEvent, EventStream};
use crossterm::execute;
use crossterm::terminal::{
    EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode,
};
use futures_util::StreamExt;
use pane_dash::actions::execute_jump;
use pane_dash::app::{Action, AppState, Event, reduce};
use pane_dash::model::{Model, ModelConfig};
use pane_dash::options::parse_show_options;
use pane_dash::snapshot::parse;
use pane_dash::tmux_exec::TmuxExec;
use pane_dash::ui;
use ratatui::{Terminal, backend::CrosstermBackend};
use tokio::sync::mpsc;

struct TerminalGuard;

struct SnapshotResponse {
    seq: u64,
    generation: u64,
    observed_at: u64,
    result: Result<Vec<u8>>,
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

    fn accepts(&mut self, seq: u64, generation: u64) -> bool {
        if seq <= self.last_seq {
            return false;
        }
        self.last_seq = seq;
        generation == self.current
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
    let (client_tty, _session_id, _pane_id, bench_first_frame) = parse_args()?;
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
        return Ok(());
    }

    let mut input = EventStream::new();
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    let (snapshot_tx, mut snapshots) = mpsc::unbounded_channel();
    let mut snapshot_pending = false;
    let mut next_snapshot_seq = 0_u64;
    let mut snapshot_generation = SnapshotGeneration::default();
    while !app.should_quit {
        tokio::select! {
            event = input.next() => match event {
                Some(Ok(CrosstermEvent::Key(key))) => {
                    if apply_event(&mut terminal, &mut app, Event::Key(key), &tmux, &client_tty).await? {
                        snapshot_generation.record_successful_mutation();
                    }
                },
                Some(Ok(CrosstermEvent::Resize(_, _))) => redraw(&mut terminal, &mut app)?,
                Some(Ok(_)) => {},
                Some(Err(error)) => return Err(error).context("read terminal event"),
                None => app.should_quit = true,
            },
            _ = tick.tick() => {
                if !snapshot_pending {
                    next_snapshot_seq = next_snapshot_seq.wrapping_add(1);
                    snapshot_pending = true;
                    let snapshot_tmux = tmux.clone();
                    let tx = snapshot_tx.clone();
                    let seq = next_snapshot_seq;
                    let generation = snapshot_generation.current();
                    tokio::spawn(async move {
                        let result = snapshot_tmux.snapshot().await;
                        let _ = tx.send(SnapshotResponse { seq, generation, observed_at: now_secs(), result });
                    });
                }
                if apply_event(&mut terminal, &mut app, Event::Tick { now: now_secs() }, &tmux, &client_tty).await? {
                    snapshot_generation.record_successful_mutation();
                }
            },
            response = snapshots.recv() => if let Some(response) = response {
                snapshot_pending = false;
                if snapshot_generation.accepts(response.seq, response.generation) {
                    let event = match response.result {
                        Ok(bytes) => Event::Snapshot { outcome: parse(&bytes), observed_at: response.observed_at },
                        Err(error) => Event::SnapshotFailed(error.to_string()),
                    };
                    if apply_event(&mut terminal, &mut app, event, &tmux, &client_tty).await? {
                        snapshot_generation.record_successful_mutation();
                    }
                }
            },
        }
    }
    let _ = client_tty;
    Ok(())
}

async fn apply_event(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    app: &mut AppState,
    event: Event,
    tmux: &TmuxExec,
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
                if execute_jump(tmux, client_tty, &target, zoom).await {
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
    use super::SnapshotGeneration;

    #[test]
    fn discards_snapshot_launched_before_a_successful_local_mutation() {
        let mut guard = SnapshotGeneration::default();
        let stale_generation = guard.current();
        guard.record_successful_mutation();
        assert!(!guard.accepts(1, stale_generation));

        let fresh_generation = guard.current();
        assert!(guard.accepts(2, fresh_generation));
    }
}
