pub mod app;
pub mod model;
pub mod options;
pub mod snapshot;
pub mod tmux_arg;
pub mod tmux_exec;

use std::io::{self, Write};
use std::time::Duration;

use anyhow::{Context, Result};
use crossterm::event::{Event as CrosstermEvent, EventStream};
use crossterm::terminal::{
    EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode,
};
use crossterm::{execute, queue};
use futures_util::StreamExt;
use tokio::sync::mpsc;

use app::{Action, AppState, Event, reduce};
use model::Model;
use options::parse_show_options;
use snapshot::parse;
use tmux_exec::TmuxExec;

struct TerminalGuard;

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
    let model = Model::build(
        &parse(&snapshot_bytes).records,
        &model::ModelConfig {
            match_pattern: cfg.match_pattern.clone(),
            stale_secs: cfg.stale_secs,
        },
        now_secs(),
    );
    let mut app = AppState::new(model, cfg);

    let _terminal = TerminalGuard::enter()?;
    install_panic_cleanup();
    redraw(&app)?;
    if bench_first_frame {
        return Ok(());
    }

    let mut input = EventStream::new();
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    let (snapshot_tx, mut snapshots) = mpsc::unbounded_channel();
    while !app.should_quit {
        tokio::select! {
            event = input.next() => if let Some(Ok(CrosstermEvent::Key(key))) = event {
                apply_event(&mut app, Event::Key(key), &tmux).await?;
            },
            _ = tick.tick() => {
                let snapshot_tmux = tmux.clone();
                let tx = snapshot_tx.clone();
                tokio::spawn(async move {
                    if let Ok(bytes) = snapshot_tmux.snapshot().await {
                        let _ = tx.send(parse(&bytes));
                    }
                });
                apply_event(&mut app, Event::Tick, &tmux).await?;
            },
            outcome = snapshots.recv() => if let Some(outcome) = outcome {
                apply_event(&mut app, Event::Snapshot(outcome), &tmux).await?;
            },
        }
    }
    let _ = client_tty;
    Ok(())
}

async fn apply_event(app: &mut AppState, event: Event, tmux: &TmuxExec) -> Result<()> {
    let result = reduce(app, event);
    for action in result.actions {
        match action {
            Action::ToggleGroup(on) => tmux.set_group(on).await?,
            Action::Jump { .. } | Action::Quit => {}
        }
    }
    if result.changed {
        redraw(app)?;
    }
    Ok(())
}

fn redraw(app: &AppState) -> Result<()> {
    let mut stdout = io::stdout();
    queue!(
        stdout,
        crossterm::terminal::Clear(crossterm::terminal::ClearType::All)
    )?;
    for row in app.model.rows(matches!(app.mode, app::Mode::Grouped)) {
        let label = match row {
            model::Row::SessionHeader { name, .. } => format!("{name}:"),
            model::Row::Pane {
                pane_id,
                title,
                command,
                ..
            } => {
                let label = if title.is_empty() { command } else { title };
                format!("  {} {label}", pane_id.0)
            }
        };
        writeln!(stdout, "{label}")?;
    }
    stdout.flush()?;
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
