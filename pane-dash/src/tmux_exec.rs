use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use tokio::process::Command;

use crate::model::PaneId;

pub const SNAPSHOT_FORMAT: &str = "\x1e#{session_id}\x1f#{session_name}\x1f#{window_id}\x1f#{window_index}\x1f#{window_name}\x1f#{pane_id}\x1f#{pane_index}\x1f#{pane_active}\x1f#{pane_current_command}\x1f#{pane_current_path}\x1f#{pane_dead}\x1f#{@pane_dash_status}\x1f#{@pane_dash_status_since}\x1f#{@pane_dash_heartbeat}\x1f#{@pane_dash_title}\x1f#{@pane_dash_model}\x1f#{@pane_dash_tag}\x1f#{@pane_dash_group}";

#[derive(Debug, Clone)]
pub struct TmuxExec {
    bin: PathBuf,
}

impl TmuxExec {
    pub fn new(bin: impl Into<PathBuf>) -> Self {
        Self { bin: bin.into() }
    }

    pub async fn snapshot(&self) -> Result<Vec<u8>> {
        self.run(["list-panes", "-a", "-F", SNAPSHOT_FORMAT])
            .await
            .context("tmux list-panes snapshot")
    }

    pub async fn show_options(&self) -> Result<Vec<u8>> {
        self.run(["show-options", "-g"])
            .await
            .context("tmux show-options -g")
    }

    pub async fn capture_pane(&self, pane_id: &PaneId) -> Result<Vec<u8>> {
        self.run(["capture-pane", "-p", "-e", "-t", &pane_id.0])
            .await
            .context("tmux capture-pane")
    }

    pub async fn set_group(&self, on: bool) -> Result<()> {
        let value = if on { "1" } else { "0" };
        self.run(["set-option", "-g", "@pane_dash_group", value])
            .await
            .context("tmux set @pane_dash_group")?;
        Ok(())
    }

    /// Runs a TOCTOU-sensitive action command without surfacing expected tmux
    /// failures (for example, a pane disappearing between rendering and jump).
    pub async fn run_silent(&self, args: &[String]) -> bool {
        Command::new(&self.bin)
            .args(args)
            .output()
            .await
            .is_ok_and(|output| output.status.success())
    }

    pub async fn startup(&self) -> Result<(Vec<u8>, Vec<u8>)> {
        let (snapshot, options) = tokio::join!(self.snapshot(), self.show_options());
        Ok((snapshot?, options?))
    }

    async fn run<const N: usize>(&self, args: [&str; N]) -> Result<Vec<u8>> {
        let output = Command::new(&self.bin)
            .args(args)
            .output()
            .await
            .with_context(|| format!("spawn {}", self.bin.display()))?;
        if !output.status.success() {
            bail!(
                "{} exited {}: {}",
                self.bin.display(),
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Ok(output.stdout)
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;

    use crate::model::{Model, ModelConfig};
    use crate::snapshot::parse;

    use super::TmuxExec;

    struct ScratchServer<'a> {
        socket: &'a str,
    }

    impl Drop for ScratchServer<'_> {
        fn drop(&mut self) {
            let _ = Command::new("tmux")
                .args(["-L", self.socket, "kill-server"])
                .status();
        }
    }

    #[tokio::test]
    #[ignore = "requires tmux"]
    async fn scratch_server_snapshot_builds_status_memberships() {
        let socket = "pd_rust_it";
        let tmux = |args: &[&str]| {
            let status = Command::new("tmux")
                .args(["-L", socket])
                .args(args)
                .status()
                .unwrap();
            assert!(status.success());
        };
        let _ = Command::new("tmux")
            .args(["-L", socket, "kill-server"])
            .status();
        let _server = ScratchServer { socket };
        tmux(&[
            "-f",
            "/dev/null",
            "new-session",
            "-d",
            "-s",
            "one",
            "sleep 60",
        ]);
        tmux(&["new-session", "-d", "-s", "two", "sleep 60"]);
        tmux(&[
            "set-option",
            "-p",
            "-t",
            "one:0.0",
            "@pane_dash_status",
            "working",
        ]);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            .to_string();
        tmux(&[
            "set-option",
            "-p",
            "-t",
            "one:0.0",
            "@pane_dash_heartbeat",
            &now,
        ]);
        tmux(&[
            "set-option",
            "-p",
            "-t",
            "two:0.0",
            "@pane_dash_tag",
            "test",
        ]);

        let dir = tempfile::tempdir().unwrap();
        let wrapper = dir.path().join("tmux-pd-rust-it");
        fs::write(
            &wrapper,
            format!("#!/bin/sh\nexec tmux -L {socket} \"$@\"\n"),
        )
        .unwrap();
        fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).unwrap();
        let exec = TmuxExec::new(&wrapper);
        let bytes = exec.snapshot().await.unwrap();
        let outcome = parse(&bytes);
        let model = Model::build(&outcome.records, &ModelConfig::default(), 1);
        assert_eq!(model.memberships().len(), 2);
        assert!(
            model
                .panes()
                .values()
                .any(|pane| matches!(pane.status, crate::model::Status::Working))
        );

        exec.set_group(false).await.unwrap();
        let bytes = exec.snapshot().await.unwrap();
        let outcome = parse(&bytes);
        let model = Model::build(&outcome.records, &ModelConfig::default(), 1);
        assert!(!model.grouped());

        exec.set_group(true).await.unwrap();
        let bytes = exec.snapshot().await.unwrap();
        let outcome = parse(&bytes);
        let model = Model::build(&outcome.records, &ModelConfig::default(), 1);
        assert!(model.grouped());
    }
}
