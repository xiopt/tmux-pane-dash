use std::io;
use std::path::PathBuf;
use std::process::{ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio::time::Instant;

use crate::creation::{CreationError, ValidatedCwd};
use crate::model::PaneId;

pub const SNAPSHOT_FORMAT: &str = "\x1e#{session_id}\x1f#{session_name}\x1f#{window_id}\x1f#{window_index}\x1f#{window_name}\x1f#{pane_id}\x1f#{pane_index}\x1f#{pane_active}\x1f#{pane_current_command}\x1f#{pane_current_path}\x1f#{pane_dead}\x1f#{@pane_dash_status}\x1f#{@pane_dash_status_since}\x1f#{@pane_dash_heartbeat}\x1f#{@pane_dash_title}\x1f#{@pane_dash_model}\x1f#{@pane_dash_opencode_session}\x1f#{@pane_dash_tag}\x1f#{@pane_dash_group}";
pub const NOTIFICATION_TARGET_FORMAT: &str = "#{pane_id}\x1f#{session_id}\x1f#{window_id}";
pub const NOTIFICATION_CLIENT_FORMAT: &str = "#{client_tty}\x1f#{client_activity}\x1f#{pane_id}\x1f#{client_width}\x1f#{client_control_mode}";

const STREAM_CHUNK_BYTES: usize = 8 * 1024;
const READER_CLEANUP_GRACE: Duration = Duration::from_millis(100);
type StreamCapture = Arc<Mutex<Vec<u8>>>;

#[derive(Debug, Clone)]
pub struct TmuxExec {
    bin: PathBuf,
    socket: Option<PathBuf>,
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
    TimedOut { stdout: Vec<u8> },
    #[error("creation cancelled")]
    Cancelled,
}

enum CreationCompletion<T> {
    Exited(T),
    TimedOut,
    Cancelled,
}

async fn arbitrate_creation_completion<T>(
    cancellation: &mut oneshot::Receiver<()>,
    deadline: Instant,
    child_exit: impl std::future::Future<Output = T>,
) -> CreationCompletion<T> {
    tokio::select! {
        biased;
        _ = &mut *cancellation => CreationCompletion::Cancelled,
        _ = tokio::time::sleep_until(deadline) => CreationCompletion::TimedOut,
        result = child_exit => CreationCompletion::Exited(result),
    }
}

impl TmuxExec {
    pub fn new(bin: impl Into<PathBuf>) -> Self {
        Self {
            bin: bin.into(),
            socket: None,
        }
    }

    pub fn with_socket(bin: impl Into<PathBuf>, socket: impl Into<PathBuf>) -> Self {
        Self {
            bin: bin.into(),
            socket: Some(socket.into()),
        }
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

    pub async fn resolve_notification_target(
        &self,
        pane_id: &PaneId,
    ) -> Result<(PaneId, crate::model::SessionId, crate::model::WindowId)> {
        let output = self
            .run_dynamic(&[
                "display-message".into(),
                "-p".into(),
                "-t".into(),
                pane_id.0.clone(),
                NOTIFICATION_TARGET_FORMAT.into(),
            ])
            .await
            .context("tmux resolve notification target")?;
        let value = String::from_utf8(output).context("tmux returned non-UTF-8 target")?;
        let value = value.trim_end_matches(['\r', '\n']);
        let mut fields = value.split('\x1f');
        let Some(pane) = fields.next().filter(|value| valid_machine_id(value, '%')) else {
            bail!("tmux returned an invalid notification target")
        };
        let Some(session) = fields.next().filter(|value| valid_machine_id(value, '$')) else {
            bail!("tmux returned an invalid notification target")
        };
        let Some(window) = fields.next().filter(|value| valid_machine_id(value, '@')) else {
            bail!("tmux returned an invalid notification target")
        };
        if fields.next().is_some() {
            bail!("tmux returned an invalid notification target")
        }
        Ok((
            PaneId::from(pane),
            crate::model::SessionId::from(session),
            crate::model::WindowId::from(window),
        ))
    }

    pub async fn list_sessions(&self) -> Result<Vec<u8>> {
        self.run(["list-sessions", "-F", "#{session_id}"])
            .await
            .context("tmux list sessions")
    }

    pub async fn list_notification_clients(&self) -> Result<Vec<u8>> {
        self.run(["list-clients", "-F", NOTIFICATION_CLIENT_FORMAT])
            .await
            .context("tmux list notification clients")
    }

    pub async fn notification_focus(&self, client_tty: &str) -> Result<Vec<u8>> {
        let option = format!("@pane_dash_focus_{client_tty}");
        self.run_dynamic(&["show-option".into(), "-gqv".into(), option])
            .await
            .context("tmux read notification focus relay")
    }

    pub async fn set_notification_status(&self, status: &str) -> Result<()> {
        self.run_dynamic(&[
            "set-option".into(),
            "-g".into(),
            "@pane_dash_notify_status".into(),
            status.into(),
        ])
        .await
        .context("tmux set @pane_dash_notify_status")?;
        Ok(())
    }

    pub async fn refresh_client_status(&self, client_tty: &str) -> Result<()> {
        self.run_dynamic(&[
            "refresh-client".into(),
            "-S".into(),
            "-t".into(),
            client_tty.into(),
        ])
        .await
        .context("tmux refresh client status")?;
        Ok(())
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
        let mut command = Command::new(self.bin());
        self.add_socket(&mut command);
        command
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
        match cancellation.try_recv() {
            Ok(()) | Err(tokio::sync::oneshot::error::TryRecvError::Closed) => {
                return Err(TmuxCommandError::Cancelled);
            }
            Err(tokio::sync::oneshot::error::TryRecvError::Empty) => {}
        }
        if Instant::now() >= deadline {
            return Err(TmuxCommandError::TimedOut { stdout: Vec::new() });
        }
        if let Some(cwd) = cwd {
            cwd.revalidate()?;
        }
        let mut command = Command::new(self.bin());
        self.add_socket(&mut command);
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
        let stdout_capture = Arc::new(Mutex::new(Vec::new()));
        let stderr_capture = Arc::new(Mutex::new(Vec::new()));
        let stdout_reader = tokio::spawn(read_stream(stdout, Arc::clone(&stdout_capture)));
        let stderr_reader = tokio::spawn(read_stream(stderr, Arc::clone(&stderr_capture)));
        let stdout_abort = stdout_reader.abort_handle();
        let stderr_abort = stderr_reader.abort_handle();
        let mut streams = tokio::spawn({
            let stdout_capture = Arc::clone(&stdout_capture);
            let stderr_capture = Arc::clone(&stderr_capture);
            async move {
                tokio::join!(
                    collect_stream(stdout_reader, stdout_capture, "stdout"),
                    collect_stream(stderr_reader, stderr_capture, "stderr")
                )
            }
        });
        let completion = arbitrate_creation_completion(cancellation, deadline, child.wait()).await;
        if matches!(
            completion,
            CreationCompletion::TimedOut | CreationCompletion::Cancelled
        ) {
            let _ = child.kill().await;
            let _ = child.wait().await;
            finish_streams(&mut streams, stdout_abort, stderr_abort).await;
            return Err(match completion {
                CreationCompletion::TimedOut => TmuxCommandError::TimedOut {
                    stdout: captured(&stdout_capture),
                },
                CreationCompletion::Cancelled => TmuxCommandError::Cancelled,
                CreationCompletion::Exited(_) => unreachable!(),
            });
        }
        let (stdout, stderr) = tokio::select! {
            biased;
            _ = &mut *cancellation => {
                finish_streams(&mut streams, stdout_abort, stderr_abort).await;
                return Err(TmuxCommandError::Cancelled);
            }
            _ = tokio::time::sleep_until(deadline) => {
                finish_streams(&mut streams, stdout_abort, stderr_abort).await;
                return Err(TmuxCommandError::TimedOut {
                    stdout: captured(&stdout_capture),
                });
            }
            streams = &mut streams => streams.map_err(|source| TmuxCommandError::ReaderJoin {
                stream: "collection",
                source,
            })?,
        };
        let stdout = stdout?;
        let stderr = stderr?;
        match completion {
            CreationCompletion::Exited(Ok(status)) if status.success() => Ok(stdout),
            CreationCompletion::Exited(Ok(status)) => Err(TmuxCommandError::Exit {
                status,
                stderr: String::from_utf8_lossy(&stderr).trim().to_owned(),
            }),
            CreationCompletion::Exited(Err(source)) => Err(TmuxCommandError::Read {
                stream: "child",
                source,
            }),
            CreationCompletion::TimedOut => Err(TmuxCommandError::TimedOut {
                stdout: captured(&stdout_capture),
            }),
            CreationCompletion::Cancelled => Err(TmuxCommandError::Cancelled),
        }
    }

    pub async fn startup(&self) -> Result<(Vec<u8>, Vec<u8>)> {
        let (snapshot, options) = tokio::join!(self.snapshot(), self.show_options());
        Ok((snapshot?, options?))
    }

    async fn run<const N: usize>(&self, args: [&str; N]) -> Result<Vec<u8>> {
        let mut command = Command::new(self.bin());
        command.env("LC_ALL", "C.UTF-8");
        self.add_socket(&mut command);
        let output = command
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
        let mut command = Command::new(self.bin());
        command.env("LC_ALL", "C.UTF-8");
        self.add_socket(&mut command);
        let output = command
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

    fn add_socket(&self, command: &mut Command) {
        if let Some(socket) = &self.socket {
            command.arg("-S").arg(socket);
        }
    }
}

fn valid_machine_id(value: &str, prefix: char) -> bool {
    value
        .strip_prefix(prefix)
        .is_some_and(|tail| !tail.is_empty() && tail.bytes().all(|byte| byte.is_ascii_digit()))
}

async fn read_stream<R>(mut stream: R, capture: StreamCapture) -> io::Result<()>
where
    R: AsyncRead + Unpin,
{
    let mut chunk = [0_u8; STREAM_CHUNK_BYTES];
    loop {
        let count = stream.read(&mut chunk).await?;
        if count == 0 {
            return Ok(());
        }
        capture
            .lock()
            .expect("stream capture mutex poisoned")
            .extend_from_slice(&chunk[..count]);
    }
}

fn captured(capture: &StreamCapture) -> Vec<u8> {
    capture
        .lock()
        .expect("stream capture mutex poisoned")
        .clone()
}

async fn collect_stream(
    reader: JoinHandle<io::Result<()>>,
    capture: StreamCapture,
    stream: &'static str,
) -> std::result::Result<Vec<u8>, TmuxCommandError> {
    reader
        .await
        .map_err(|source| TmuxCommandError::ReaderJoin { stream, source })?
        .map_err(|source| TmuxCommandError::Read { stream, source })?;
    Ok(captured(&capture))
}

async fn finish_streams<T>(
    streams: &mut JoinHandle<T>,
    stdout_abort: tokio::task::AbortHandle,
    stderr_abort: tokio::task::AbortHandle,
) {
    if tokio::time::timeout(READER_CLEANUP_GRACE, &mut *streams)
        .await
        .is_err()
    {
        stdout_abort.abort();
        stderr_abort.abort();
        let _ = streams.await;
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::future;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::time::Duration;

    use crate::model::{Model, ModelConfig};
    use crate::snapshot::parse;

    use super::{READER_CLEANUP_GRACE, SNAPSHOT_FORMAT, TmuxCommandError, TmuxExec};

    fn shell_quote(path: &Path) -> String {
        format!("'{}'", path.display().to_string().replace('\'', "'\"'\"'"))
    }

    fn real_tmux() -> PathBuf {
        std::env::var_os("TMUX_BIN")
            .unwrap_or_else(|| "tmux".into())
            .into()
    }

    fn wait_for_pid_exit(pid: &str) {
        let started = std::time::Instant::now();
        while Command::new("kill")
            .args(["-0", pid])
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
        {
            assert!(started.elapsed() < Duration::from_secs(2));
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    async fn wait_for_file(path: &Path) {
        tokio::time::timeout(Duration::from_secs(1), async {
            while !path.exists() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("fake executable must reach its synchronization point");
    }

    #[test]
    fn bin_returns_the_configured_executable_path() {
        let exec = TmuxExec::new("/usr/local/bin/tmux-custom");

        assert_eq!(exec.bin(), Path::new("/usr/local/bin/tmux-custom"));
    }

    #[tokio::test]
    async fn startup_issues_only_snapshot_and_global_options_commands() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("argv.log");
        let executable = dir.path().join("fake-tmux");
        fs::write(
            &executable,
            format!("#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\n", log.display()),
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();

        TmuxExec::new(executable).startup().await.unwrap();

        let call_log = fs::read_to_string(log).unwrap();
        let mut calls = call_log.lines().collect::<Vec<_>>();
        calls.sort_unstable();
        assert_eq!(
            calls,
            [
                format!("list-panes -a -F {SNAPSHOT_FORMAT}"),
                "show-options -g".to_owned(),
            ]
        );
    }

    #[tokio::test]
    async fn creation_runner_retains_valid_timeout_stdout_drains_large_streams_and_reaps_child() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("direct-child.pid");
        let wrote_file = dir.path().join("wrote-output");
        let executable = dir.path().join("fake-tmux");
        fs::write(
            &executable,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$$\" > {pid}\nprintf '%%44\\n'\ndd if=/dev/zero bs=1024 count=256 2>/dev/null\ndd if=/dev/zero bs=1024 count=256 1>&2 2>/dev/null\ntouch {wrote}\ntrap 'exit 143' HUP INT TERM\nwhile :; do sleep 1; done\n",
                pid = shell_quote(&pid_file),
                wrote = shell_quote(&wrote_file),
            ),
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        let (_cancel, mut cancellation) = tokio::sync::oneshot::channel();

        let exec = TmuxExec::new(executable);
        let task = tokio::spawn(async move {
            exec.run_argv_until(
                &["anything".into()],
                None,
                tokio::time::Instant::now() + Duration::from_secs(1),
                &mut cancellation,
            )
            .await
        });
        wait_for_file(&wrote_file).await;

        let error = task.await.unwrap().unwrap_err();

        assert!(matches!(
            error,
            TmuxCommandError::TimedOut { ref stdout }
                if stdout.len() == 4 + 256 * 1024 && stdout.starts_with(b"%44\n")
        ));
        let pid = fs::read_to_string(pid_file).expect("direct child pid");
        wait_for_pid_exit(pid.trim());
    }

    #[tokio::test]
    async fn creation_runner_drains_large_stdout_and_stderr_before_returning_exit_error() {
        let dir = tempfile::tempdir().unwrap();
        let executable = dir.path().join("fake-tmux");
        fs::write(
            &executable,
            "#!/bin/sh\ndd if=/dev/zero bs=1024 count=256 2>/dev/null\ndd if=/dev/zero bs=1024 count=256 1>&2 2>/dev/null\necho failed 1>&2\nexit 7\n",
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        let (_cancel, mut cancellation) = tokio::sync::oneshot::channel();

        let error = TmuxExec::new(executable)
            .run_argv_until(
                &["anything".into()],
                None,
                tokio::time::Instant::now() + Duration::from_secs(1),
                &mut cancellation,
            )
            .await
            .unwrap_err();

        assert!(matches!(error, TmuxCommandError::Exit { .. }));
    }

    #[tokio::test(start_paused = true)]
    async fn creation_runner_bounds_retained_descendant_streams_after_child_exit() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("retained-pipe.pid");
        let wrote_file = dir.path().join("wrote-output");
        let executable = dir.path().join("fake-tmux");
        fs::write(
            &executable,
            format!(
                "#!/bin/sh\n(sleep 60) &\nprintf '%s\\n' \"$!\" > {pid}\nprintf '%%44\\n'\ntouch {wrote}\n",
                pid = shell_quote(&pid_file),
                wrote = shell_quote(&wrote_file),
            ),
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        let (_cancel, mut cancellation) = tokio::sync::oneshot::channel();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(60 * 60);

        let exec = TmuxExec::new(executable);
        let task = tokio::spawn(async move {
            exec.run_argv_until(&["anything".into()], None, deadline, &mut cancellation)
                .await
        });
        tokio::task::yield_now().await;

        let ready_by = std::time::Instant::now() + Duration::from_secs(1);
        while !pid_file.exists() || !wrote_file.exists() {
            assert!(
                std::time::Instant::now() < ready_by,
                "fake executable must write its pid and stdout marker before the deadline"
            );
            tokio::task::yield_now().await;
        }

        tokio::time::advance(deadline - tokio::time::Instant::now()).await;
        tokio::time::advance(Duration::from_nanos(1)).await;
        let completed_by = std::time::Instant::now() + Duration::from_secs(1);
        while !task.is_finished() {
            assert!(
                std::time::Instant::now() < completed_by,
                "retained descendant must not hold stream collection open"
            );
            tokio::task::yield_now().await;
            tokio::time::advance(READER_CLEANUP_GRACE).await;
        }
        let error = task.await.unwrap().unwrap_err();

        let pid = fs::read_to_string(&pid_file)
            .expect("retained pipe descendant pid")
            .trim()
            .to_owned();
        assert!(
            Command::new("kill")
                .args(["-TERM", &pid])
                .status()
                .expect("terminate retained pipe descendant")
                .success()
        );
        wait_for_pid_exit(&pid);

        assert!(matches!(
            error,
            TmuxCommandError::TimedOut { ref stdout } if stdout == b"%44\n"
        ));
    }

    #[tokio::test]
    async fn creation_runner_bounds_retained_descendant_streams_after_live_child_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let direct_pid_file = dir.path().join("direct-child.pid");
        let retained_pid_file = dir.path().join("retained-pipe.pid");
        let wrote_file = dir.path().join("wrote-output");
        let executable = dir.path().join("fake-tmux");
        fs::write(
            &executable,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$$\" > {direct_pid}\n(sleep 60) &\nprintf '%s\\n' \"$!\" > {retained_pid}\nprintf '%%44\\n'\ntouch {wrote}\ntrap 'exit 143' HUP INT TERM\nwhile :; do sleep 1; done\n",
                direct_pid = shell_quote(&direct_pid_file),
                retained_pid = shell_quote(&retained_pid_file),
                wrote = shell_quote(&wrote_file),
            ),
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        let (_cancel, mut cancellation) = tokio::sync::oneshot::channel();
        let deadline = tokio::time::Instant::now() + Duration::from_millis(100);
        let started = std::time::Instant::now();

        let exec = TmuxExec::new(executable);
        let task = tokio::spawn(async move {
            exec.run_argv_until(&["anything".into()], None, deadline, &mut cancellation)
                .await
        });
        wait_for_file(&wrote_file).await;

        let error = task.await.unwrap().unwrap_err();
        assert!(started.elapsed() < Duration::from_millis(500));
        assert!(matches!(
            error,
            TmuxCommandError::TimedOut { ref stdout } if stdout == b"%44\n"
        ));

        let direct_pid = fs::read_to_string(direct_pid_file).expect("direct child pid");
        wait_for_pid_exit(direct_pid.trim());

        let retained_pid = fs::read_to_string(retained_pid_file).expect("retained descendant pid");
        let retained_pid = retained_pid.trim();
        assert!(
            Command::new("kill")
                .args(["-TERM", retained_pid])
                .status()
                .expect("terminate retained pipe descendant")
                .success()
        );
        wait_for_pid_exit(retained_pid);
    }

    #[tokio::test]
    async fn creation_runner_does_not_spawn_after_an_expired_deadline() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("spawned");
        let executable = dir.path().join("fake-tmux");
        fs::write(
            &executable,
            format!("#!/bin/sh\ntouch '{}'\n", marker.display()),
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        let (_cancel, mut cancellation) = tokio::sync::oneshot::channel();

        let error = TmuxExec::new(executable)
            .run_argv_until(
                &["anything".into()],
                None,
                tokio::time::Instant::now() - std::time::Duration::from_millis(1),
                &mut cancellation,
            )
            .await
            .unwrap_err();

        assert!(matches!(
            error,
            TmuxCommandError::TimedOut { ref stdout } if stdout.is_empty()
        ));
        assert!(!marker.exists());
    }

    #[tokio::test]
    async fn creation_runner_retains_malformed_timeout_stdout() {
        let dir = tempfile::tempdir().unwrap();
        let wrote_file = dir.path().join("wrote-output");
        let executable = dir.path().join("fake-tmux");
        fs::write(
            &executable,
            format!(
                "#!/bin/sh\nprintf '%%44\\377'\ntouch {}\nwhile :; do sleep 1; done\n",
                shell_quote(&wrote_file)
            ),
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        let (_cancel, mut cancellation) = tokio::sync::oneshot::channel();

        let exec = TmuxExec::new(executable);
        let task = tokio::spawn(async move {
            exec.run_argv_until(
                &["anything".into()],
                None,
                tokio::time::Instant::now() + Duration::from_secs(1),
                &mut cancellation,
            )
            .await
        });
        wait_for_file(&wrote_file).await;

        let error = task.await.unwrap().unwrap_err();
        assert!(matches!(
            error,
            TmuxCommandError::TimedOut { ref stdout } if stdout == b"%44\xff"
        ));
    }

    #[tokio::test]
    async fn creation_runner_discards_timeout_stdout_when_cancelled_after_write() {
        let dir = tempfile::tempdir().unwrap();
        let wrote_file = dir.path().join("wrote-output");
        let executable = dir.path().join("fake-tmux");
        fs::write(
            &executable,
            format!(
                "#!/bin/sh\nprintf '%%44\\n'\ntouch {}\nwhile :; do sleep 1; done\n",
                shell_quote(&wrote_file)
            ),
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        let (cancel, mut cancellation) = tokio::sync::oneshot::channel();

        let exec = TmuxExec::new(executable);
        let task = tokio::spawn(async move {
            exec.run_argv_until(
                &["anything".into()],
                None,
                tokio::time::Instant::now() + Duration::from_secs(1),
                &mut cancellation,
            )
            .await
        });
        wait_for_file(&wrote_file).await;
        cancel.send(()).unwrap();

        assert!(matches!(
            task.await.unwrap().unwrap_err(),
            TmuxCommandError::Cancelled
        ));
    }

    #[tokio::test]
    async fn creation_runner_prefers_cancellation_when_deadline_and_cancel_are_ready() {
        let (_cancel, mut cancellation) = tokio::sync::oneshot::channel::<()>();
        drop(_cancel);

        let error = TmuxExec::new("/must-not-spawn")
            .run_argv_until(
                &["anything".into()],
                None,
                tokio::time::Instant::now() - std::time::Duration::from_millis(1),
                &mut cancellation,
            )
            .await
            .unwrap_err();

        assert!(matches!(error, TmuxCommandError::Cancelled));
    }

    #[tokio::test]
    async fn creation_completion_arbitration_prefers_deadline_over_an_already_ready_child_exit() {
        let (_cancel, mut cancellation) = tokio::sync::oneshot::channel::<()>();

        let completion = super::arbitrate_creation_completion(
            &mut cancellation,
            tokio::time::Instant::now() - std::time::Duration::from_millis(1),
            future::ready(()),
        )
        .await;

        assert!(matches!(completion, super::CreationCompletion::TimedOut));
    }

    struct ScratchServer<'a> {
        socket: &'a str,
    }

    impl Drop for ScratchServer<'_> {
        fn drop(&mut self) {
            let _ = Command::new(real_tmux())
                .args(["-L", self.socket, "kill-server"])
                .status();
        }
    }

    #[tokio::test]
    #[ignore = "requires tmux"]
    async fn scratch_server_snapshot_builds_status_memberships() {
        let socket = "pd_rust_it";
        let tmux = |args: &[&str]| {
            let status = Command::new(real_tmux())
                .args(["-L", socket])
                .args(args)
                .status()
                .unwrap();
            assert!(status.success());
        };
        let _ = Command::new(real_tmux())
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
            format!(
                "#!/bin/sh\nexec {} -L {socket} \"$@\"\n",
                real_tmux().display()
            ),
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
