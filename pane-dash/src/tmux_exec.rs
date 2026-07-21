use std::io;
use std::path::PathBuf;
use std::process::{ExitStatus, Stdio};

use anyhow::{Context, Result, bail};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::oneshot;
use tokio::time::Instant;

use crate::creation::{CreationError, ValidatedCwd};
use crate::model::PaneId;

pub const SNAPSHOT_FORMAT: &str = "\x1e#{session_id}\x1f#{session_name}\x1f#{window_id}\x1f#{window_index}\x1f#{window_name}\x1f#{pane_id}\x1f#{pane_index}\x1f#{pane_active}\x1f#{pane_current_command}\x1f#{pane_current_path}\x1f#{pane_dead}\x1f#{@pane_dash_status}\x1f#{@pane_dash_status_since}\x1f#{@pane_dash_heartbeat}\x1f#{@pane_dash_title}\x1f#{@pane_dash_model}\x1f#{@pane_dash_tag}\x1f#{@pane_dash_group}";

#[derive(Debug, Clone)]
pub struct TmuxExec {
    bin: PathBuf,
}

#[derive(Debug, thiserror::Error)]
pub enum TmuxCommandError {
    #[error("creation cwd validation failed: {0}")]
    Cwd(#[from] CreationError),
    #[error("failed to spawn {}: {source}", bin.display())]
    Spawn {
        bin: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("failed to read creation {stream}: {source}")]
    Read {
        stream: &'static str,
        #[source]
        source: io::Error,
    },
    #[error("creation {stream} reader task failed: {source}")]
    ReaderJoin {
        stream: &'static str,
        #[source]
        source: tokio::task::JoinError,
    },
    #[error("tmux exited {status}: {stderr}")]
    Exit { status: ExitStatus, stderr: String },
    #[error("creation timed out")]
    TimedOut,
    #[error("creation cancelled")]
    Cancelled,
}

impl TmuxExec {
    pub fn new(bin: impl Into<PathBuf>) -> Self {
        Self { bin: bin.into() }
    }

    pub(crate) fn bin(&self) -> &std::path::Path {
        &self.bin
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

    pub async fn display_pane_id(&self, pane_id: &PaneId) -> Result<Vec<u8>> {
        self.run_dynamic(&[
            "display-message".into(),
            "-p".into(),
            "-t".into(),
            pane_id.0.clone(),
            "#{pane_id}".into(),
        ])
        .await
        .context("tmux display pane id")
    }

    pub async fn send_keys_literal(&self, pane_id: &PaneId, text: String) -> Result<()> {
        self.run_dynamic(&[
            "send-keys".into(),
            "-l".into(),
            "-t".into(),
            pane_id.0.clone(),
            "--".into(),
            text,
        ])
        .await
        .context("tmux send literal keys")?;
        Ok(())
    }

    pub async fn send_enter(&self, pane_id: &PaneId) -> Result<()> {
        self.run_dynamic(&[
            "send-keys".into(),
            "-t".into(),
            pane_id.0.clone(),
            "Enter".into(),
        ])
        .await
        .context("tmux send enter")?;
        Ok(())
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
        Command::new(self.bin())
            .args(args)
            .output()
            .await
            .is_ok_and(|output| output.status.success())
    }

    pub async fn run_argv_until(
        &self,
        args: &[String],
        cwd: Option<&ValidatedCwd>,
        deadline: Instant,
        cancellation: &mut oneshot::Receiver<()>,
    ) -> std::result::Result<Vec<u8>, TmuxCommandError> {
        if let Some(cwd) = cwd {
            cwd.revalidate()?;
        }
        let mut command = Command::new(self.bin());
        command
            .args(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(cwd) = cwd {
            command.current_dir(cwd.as_path());
        }
        let mut child = command.spawn().map_err(|source| TmuxCommandError::Spawn {
            bin: self.bin.clone(),
            source,
        })?;
        let stdout = child.stdout.take().ok_or_else(|| TmuxCommandError::Read {
            stream: "stdout",
            source: io::Error::other("stdout was not piped"),
        })?;
        let stderr = child.stderr.take().ok_or_else(|| TmuxCommandError::Read {
            stream: "stderr",
            source: io::Error::other("stderr was not piped"),
        })?;
        let stdout_reader = tokio::spawn(read_stream(stdout));
        let stderr_reader = tokio::spawn(read_stream(stderr));
        enum Completion {
            Exited(std::result::Result<ExitStatus, io::Error>),
            TimedOut,
            Cancelled,
        }
        let completion = tokio::select! {
            result = child.wait() => Completion::Exited(result),
            _ = tokio::time::sleep_until(deadline) => Completion::TimedOut,
            _ = &mut *cancellation => Completion::Cancelled,
        };
        if matches!(completion, Completion::TimedOut | Completion::Cancelled) {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        let (stdout, stderr) = tokio::join!(
            collect_stream(stdout_reader, "stdout"),
            collect_stream(stderr_reader, "stderr")
        );
        let stdout = stdout?;
        let stderr = stderr?;
        match completion {
            Completion::Exited(Ok(status)) if status.success() => Ok(stdout),
            Completion::Exited(Ok(status)) => Err(TmuxCommandError::Exit {
                status,
                stderr: String::from_utf8_lossy(&stderr).trim().to_owned(),
            }),
            Completion::Exited(Err(source)) => Err(TmuxCommandError::Read {
                stream: "child",
                source,
            }),
            Completion::TimedOut => Err(TmuxCommandError::TimedOut),
            Completion::Cancelled => Err(TmuxCommandError::Cancelled),
        }
    }

    pub async fn startup(&self) -> Result<(Vec<u8>, Vec<u8>)> {
        let (snapshot, options) = tokio::join!(self.snapshot(), self.show_options());
        Ok((snapshot?, options?))
    }

    async fn run<const N: usize>(&self, args: [&str; N]) -> Result<Vec<u8>> {
        let output = Command::new(self.bin())
            .args(args)
            .output()
            .await
            .with_context(|| format!("spawn {}", self.bin().display()))?;
        if !output.status.success() {
            bail!(
                "{} exited {}: {}",
                self.bin().display(),
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Ok(output.stdout)
    }

    async fn run_dynamic(&self, args: &[String]) -> Result<Vec<u8>> {
        let output = Command::new(self.bin())
            .args(args)
            .output()
            .await
            .with_context(|| format!("spawn {}", self.bin().display()))?;
        if !output.status.success() {
            bail!(
                "{} exited {}: {}",
                self.bin().display(),
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Ok(output.stdout)
    }
}

async fn read_stream<R: tokio::io::AsyncRead + Unpin>(mut stream: R) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    stream.read_to_end(&mut bytes).await?;
    Ok(bytes)
}

async fn collect_stream(
    reader: tokio::task::JoinHandle<io::Result<Vec<u8>>>,
    stream: &'static str,
) -> std::result::Result<Vec<u8>, TmuxCommandError> {
    reader
        .await
        .map_err(|source| TmuxCommandError::ReaderJoin { stream, source })?
        .map_err(|source| TmuxCommandError::Read { stream, source })
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    use std::process::Command;

    use crate::model::{Model, ModelConfig};
    use crate::snapshot::parse;

    use super::TmuxExec;

    #[test]
    fn bin_returns_the_configured_executable_path() {
        let exec = TmuxExec::new("/usr/local/bin/tmux-custom");

        assert_eq!(exec.bin(), Path::new("/usr/local/bin/tmux-custom"));
    }

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
