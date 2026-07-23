#![cfg(unix)]

//! Real-tmux creation coverage. This target serializes itself because tmux and
//! process environment state are global. The documented command retains
//! `--test-threads=1` as an additional, process-level guard.

use std::{
    env, fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::{
        OnceLock,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use pane_dash::{
    creation::{
        CreateContext, CreateDraft, CreateStage, CreationId, CreationProgress, CreationResolution,
        SplitDirection, build_request, run_creation,
    },
    model::{PaneId, SessionId},
    tmux_exec::TmuxExec,
};
use tempfile::TempDir;
use tokio::sync::{mpsc, oneshot};

static NEXT_SOCKET: AtomicUsize = AtomicUsize::new(0);
static SERIAL_TESTS: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

async fn serial_test() -> tokio::sync::MutexGuard<'static, ()> {
    SERIAL_TESTS
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

struct EnvRestore {
    name: &'static str,
    old: Option<std::ffi::OsString>,
}

impl EnvRestore {
    fn set(name: &'static str, value: &str) -> Self {
        let old = env::var_os(name);
        // SAFETY: creation integration tests serialize all environment access.
        unsafe { env::set_var(name, value) };
        Self { name, old }
    }
}

impl Drop for EnvRestore {
    fn drop(&mut self) {
        // SAFETY: creation integration tests serialize all environment access.
        unsafe {
            if let Some(value) = self.old.take() {
                env::set_var(self.name, value);
            } else {
                env::remove_var(self.name);
            }
        }
    }
}

struct Harness {
    dir: TempDir,
    socket: PathBuf,
    tmux: PathBuf,
    log: PathBuf,
    hang_pid: PathBuf,
}

impl Harness {
    fn new() -> Self {
        let dir = TempDir::new().expect("temporary directory");
        let socket = dir.path().join(format!(
            "tmux-{}-{}.sock",
            std::process::id(),
            NEXT_SOCKET.fetch_add(1, Ordering::Relaxed)
        ));
        let real_tmux = env::var_os("TMUX_BIN").unwrap_or_else(|| "tmux".into());
        let log = dir.path().join("argv.log");
        let hang_pid = dir.path().join("hung-wrapper.pid");
        let tmux = dir.path().join("tmux");
        fs::write(
            &tmux,
            format!(
                "#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\0' \"$@\" >> {log}\nprintf '\\n' >> {log}\ncase \"${{PD_CREATION_FAIL:-}}:$*\" in\n  tag:set-option*) echo 'tag stage rejected' >&2; exit 71 ;;\n  command:send-keys\\ -l*) echo 'command stage rejected' >&2; exit 72 ;;\nesac\nif [[ \"${{PD_CREATION_HANG:-}}\" == 1 && \"${{1:-}}\" == split-window ]]; then\n  printf '%s\\n' \"$$\" > {hang_pid}\n  trap 'exit 143' HUP INT TERM\n  while :; do sleep 0.1; done\nfi\nif [[ \"${{PD_CREATION_RECORD_PID:-}}\" == 1 && \"${{1:-}}\" == new-window ]]; then\n  printf '%s\\n' \"$$\" > \"${{PD_CREATION_PID_FILE}}\"\nfi\nexec {real} -S {socket} \"$@\"\n",
                log = shell_quote(&log),
                hang_pid = shell_quote(&hang_pid),
                real = shell_quote(Path::new(&real_tmux)),
                socket = shell_quote(&socket),
            ),
        )
        .expect("wrapper");
        fs::set_permissions(&tmux, fs::Permissions::from_mode(0o755)).expect("wrapper mode");

        let harness = Self {
            dir,
            socket,
            tmux,
            log,
            hang_pid,
        };
        let initial = harness.run([
            "-f",
            "/dev/null",
            "new-session",
            "-d",
            "-s",
            "base",
            "exec cat",
        ]);
        assert!(
            initial.status.success(),
            "scratch tmux new-session failed: {}",
            String::from_utf8_lossy(&initial.stderr)
        );
        harness
    }

    fn run<const N: usize>(&self, args: [&str; N]) -> Output {
        Command::new(self.real_tmux())
            .arg("-S")
            .arg(&self.socket)
            .args(args)
            .output()
            .expect("tmux command")
    }

    fn text<const N: usize>(&self, args: [&str; N]) -> String {
        let output = self.run(args);
        assert!(
            output.status.success(),
            "tmux: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).expect("tmux utf8")
    }

    fn real_tmux(&self) -> PathBuf {
        env::var_os("TMUX_BIN")
            .unwrap_or_else(|| "tmux".into())
            .into()
    }

    fn pane(&self, target: &str) -> PaneId {
        PaneId::from(
            self.text(["display-message", "-p", "-t", target, "#{pane_id}"])
                .trim(),
        )
    }

    fn session(&self, target: &str) -> SessionId {
        SessionId::from(
            self.text(["display-message", "-p", "-t", target, "#{session_id}"])
                .trim(),
        )
    }

    fn log_entries(&self) -> Vec<Vec<String>> {
        fs::read_to_string(&self.log)
            .unwrap_or_default()
            .split("\0\n")
            .filter(|entry| !entry.is_empty())
            .map(|entry| entry.split('\0').map(str::to_owned).collect())
            .collect()
    }

    fn install_blocked_new_window_hook(&self, token: &str) {
        let hook = format!("wait-for {token}");
        let output = self.run(["set-hook", "-g", "after-new-window", &hook]);
        assert!(
            output.status.success(),
            "install hook: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn release_wait(&self, token: &str) {
        let output = self.run(["wait-for", "-S", token]);
        assert!(
            output.status.success(),
            "release wait: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn remove_new_window_hook(&self) {
        let output = self.run(["set-hook", "-gu", "after-new-window"]);
        assert!(
            output.status.success(),
            "remove hook: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    async fn create(&self, context: CreateContext, draft: CreateDraft) -> Vec<CreationProgress> {
        let request = build_request(context, &draft).expect("valid creation request");
        let (sender, mut receiver) = mpsc::unbounded_channel();
        let (cancel, cancellation) = oneshot::channel();
        run_creation(
            TmuxExec::new(&self.tmux),
            CreationId(1),
            request,
            sender,
            cancellation,
        )
        .await;
        drop(cancel);
        let mut progress = Vec::new();
        while let Ok(event) = receiver.try_recv() {
            progress.push(event);
        }
        progress
    }
}

struct BlockedHookGuard<'a> {
    harness: &'a Harness,
    token: String,
    active: bool,
}

impl BlockedHookGuard<'_> {
    fn release(mut self) {
        self.harness.release_wait(&self.token);
        self.harness.remove_new_window_hook();
        self.active = false;
    }
}

impl Drop for BlockedHookGuard<'_> {
    fn drop(&mut self) {
        if self.active {
            self.harness.release_wait(&self.token);
            self.harness.remove_new_window_hook();
        }
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        let _ = Command::new(self.real_tmux())
            .arg("-S")
            .arg(&self.socket)
            .arg("kill-server")
            .status();
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut server_gone = false;
        while Instant::now() < deadline {
            server_gone = !Command::new(self.real_tmux())
                .arg("-S")
                .arg(&self.socket)
                .args(["has-session", "-t", "base"])
                .status()
                .is_ok_and(|status| status.success());
            if server_gone {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        if !std::thread::panicking() {
            assert!(
                server_gone,
                "scratch tmux server survived kill-server at socket: {}",
                self.socket.display()
            );
        }
        let _ = fs::remove_file(&self.socket);
        let _ = &self.dir;
    }
}

fn shell_quote(path: &Path) -> String {
    format!(
        "'{}'",
        path.display().to_string().replace('\'', "'\\\"'\\\"'")
    )
}

fn draft(name: &str, cwd: &Path, command: &str) -> CreateDraft {
    CreateDraft {
        name: name.into(),
        cwd: cwd.display().to_string(),
        command: command.into(),
    }
}

fn created_pane(events: &[CreationProgress]) -> PaneId {
    events
        .iter()
        .find_map(|event| match event {
            CreationProgress::Created { pane_id, .. } => Some(pane_id.clone()),
            _ => None,
        })
        .expect("created pane")
}

fn wait_for_pid_exit(pid: &str) {
    let started = Instant::now();
    while Command::new("kill")
        .args(["-0", pid])
        .status()
        .is_ok_and(|status| status.success())
    {
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "hung wrapper {pid} was not reaped"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "requires tmux >= 3.6; serial scratch server"]
async fn creation_uses_exact_targets_directions_child_cwd_and_one_shot_stages() {
    let _serial = serial_test().await;
    let harness = Harness::new();
    let cwd = harness.dir.path().join("hostile cwd #[ \\ unicode-雪");
    fs::create_dir(&cwd).expect("hostile cwd");
    let pane = harness.pane("base:0.0");
    let session = harness.session("base:0.0");

    for (direction, flags) in [
        (SplitDirection::Right, vec!["-h"]),
        (SplitDirection::Left, vec!["-b", "-h"]),
        (SplitDirection::Bottom, vec!["-v"]),
        (SplitDirection::Top, vec!["-b", "-v"]),
    ] {
        let progress = harness
            .create(
                CreateContext::Split {
                    target: pane.clone(),
                    initiating_session: session.clone(),
                    linked_session_count: 1,
                    direction,
                },
                draft("", &cwd, ""),
            )
            .await;
        assert!(matches!(
            progress.last(),
            Some(CreationProgress::Finished { .. })
        ));
        let created = created_pane(&progress);
        assert_eq!(
            harness
                .text([
                    "display-message",
                    "-p",
                    "-t",
                    &created.0,
                    "#{pane_current_path}"
                ])
                .trim(),
            cwd.canonicalize()
                .expect("canonical hostile cwd")
                .to_string_lossy()
        );
        let create = harness
            .log_entries()
            .into_iter()
            .rev()
            .find(|argv| argv.first().is_some_and(|arg| arg == "split-window"))
            .expect("split argv");
        assert!(
            flags
                .iter()
                .all(|flag| create.iter().any(|arg| arg == flag))
        );
        assert!(create.windows(2).any(|pair| pair == ["-t", &pane.0]));
        assert!(!create.iter().any(|arg| arg == "-c"));
    }

    let hostile_name = "name space; #{literal} 'quote' 雪 -hash#;";
    let progress = harness
        .create(
            CreateContext::NewWindow {
                target: session.clone(),
            },
            draft(hostile_name, &cwd, ""),
        )
        .await;
    assert!(matches!(
        progress.last(),
        Some(CreationProgress::Finished { .. })
    ));
    assert!(
        harness
            .text(["list-windows", "-t", &session.0, "-F", "#{window_name}"])
            .contains(hostile_name)
    );

    let linked_session = "linked";
    harness.text(["new-session", "-d", "-s", linked_session, "exec cat"]);
    harness.text(["link-window", "-s", "base:0", "-t", "linked:"]);
    let linked = harness
        .create(
            CreateContext::Split {
                target: pane.clone(),
                initiating_session: session.clone(),
                linked_session_count: 2,
                direction: SplitDirection::Right,
            },
            draft("", &cwd, ""),
        )
        .await;
    let linked_pane = created_pane(&linked);
    assert!(
        harness
            .text(["list-panes", "-t", "linked", "-F", "#{pane_id}"])
            .lines()
            .any(|id| id == linked_pane.0),
        "created pane must remain a member of the initiating linked window"
    );

    let session_name = "session space; #{literal} 'quote' 雪 -leading#;";
    let progress = harness
        .create(CreateContext::NewSession, draft(session_name, &cwd, ""))
        .await;
    let created = progress
        .iter()
        .find_map(|event| match event {
            CreationProgress::Created { pane_id, .. } => Some(pane_id),
            _ => None,
        })
        .expect("created session pane");
    assert!(matches!(
        progress.last(),
        Some(CreationProgress::Finished { .. })
    ));
    assert_eq!(
        harness
            .text(["display-message", "-p", "-t", &created.0, "#{session_name}"])
            .trim(),
        session_name
    );
    assert_eq!(
        harness
            .text([
                "show-options",
                "-p",
                "-v",
                "-t",
                &created.0,
                "@pane_dash_tag"
            ])
            .trim(),
        "dash-created"
    );
    assert!(
        harness
            .run(["set-option", "-p", "-u", "-t", &created.0, "@pane_dash_tag"])
            .status
            .success()
    );
    assert!(
        harness
            .run([
                "show-options",
                "-p",
                "-v",
                "-t",
                &created.0,
                "@pane_dash_tag"
            ])
            .stdout
            .is_empty(),
        "ordinary toggle removes the creation tag"
    );
    assert!(
        harness
            .run([
                "set-option",
                "-p",
                "-t",
                &created.0,
                "@pane_dash_tag",
                "cat"
            ])
            .status
            .success()
    );
    assert_eq!(
        harness
            .text([
                "show-options",
                "-p",
                "-v",
                "-t",
                &created.0,
                "@pane_dash_tag"
            ])
            .trim(),
        "cat"
    );

    assert!(
        harness
            .log_entries()
            .iter()
            .all(|argv| !argv.iter().any(|arg| arg == "-C"))
    );
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "requires tmux >= 3.6; serial scratch server"]
async fn creation_failure_boundaries_stop_later_stages_and_invalid_cwd_never_spawns() {
    let _serial = serial_test().await;
    let harness = Harness::new();
    let cwd = harness.dir.path();
    let before = harness.log_entries().len();
    let duplicate = draft("base", cwd, "echo ignored");
    let request = build_request(CreateContext::NewSession, &duplicate).expect("request");
    let (sender, mut receiver) = mpsc::unbounded_channel();
    let (_cancel, cancellation) = oneshot::channel();
    run_creation(
        TmuxExec::new(&harness.tmux),
        CreationId(2),
        request,
        sender,
        cancellation,
    )
    .await;
    let events: Vec<_> = std::iter::from_fn(|| receiver.try_recv().ok()).collect();
    assert!(
        matches!(events.last(), Some(CreationProgress::CreateFailed { error, .. }) if error.contains("duplicate session"))
    );
    assert_eq!(
        harness.log_entries()[before..]
            .iter()
            .filter(|argv| argv.first().is_some_and(|arg| arg == "send-keys"))
            .count(),
        0
    );

    let invalid = CreateDraft {
        name: String::new(),
        cwd: "bad\u{1}cwd".into(),
        command: String::new(),
    };
    assert!(build_request(CreateContext::NewSession, &invalid).is_err());
    assert_eq!(harness.log_entries().len(), before + 1);

    let _restore = EnvRestore::set("PD_CREATION_FAIL", "tag");
    let tag = harness
        .create(
            CreateContext::NewSession,
            draft("tag-failure", cwd, "echo no"),
        )
        .await;
    assert!(
        matches!(tag.last(), Some(CreationProgress::Finished { resolution: pane_dash::creation::CreationResolution::TagFailed(error), .. }) if error.contains("tag stage rejected"))
    );
    assert!(!tag.iter().any(|event| matches!(
        event,
        CreationProgress::Stage {
            stage: CreateStage::SendCommand | CreateStage::SendEnter,
            ..
        }
    )));
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "requires tmux >= 3.6; serial scratch server"]
async fn creation_commands_are_literal_and_never_replayed_on_failure_or_empty_input() {
    let _serial = serial_test().await;
    let harness = Harness::new();
    let cwd = harness.dir.path();
    let before = harness.log_entries().len();
    let empty = harness
        .create(CreateContext::NewSession, draft("empty-command", cwd, ""))
        .await;
    assert!(matches!(
        empty.last(),
        Some(CreationProgress::Finished { .. })
    ));
    let empty_request =
        build_request(CreateContext::NewSession, &draft("", cwd, "")).expect("empty name request");
    assert!(
        !empty_request
            .argv
            .iter()
            .any(|arg| arg == "-s" || arg == "-n")
    );
    let empty_name = harness
        .create(CreateContext::NewSession, draft("", cwd, ""))
        .await;
    assert!(matches!(
        empty_name.last(),
        Some(CreationProgress::Finished { .. })
    ));
    let session_create = harness
        .log_entries()
        .into_iter()
        .rev()
        .find(|argv| argv.first().is_some_and(|arg| arg == "new-session"))
        .expect("new-session argv");
    assert!(!session_create.iter().any(|arg| arg == "-n" || arg == "-s"));
    let empty_argv = harness.log_entries();
    assert!(
        !empty_argv[before..]
            .iter()
            .any(|argv| argv.first().is_some_and(|arg| arg == "send-keys"))
    );
    let window_empty = harness
        .create(
            CreateContext::NewWindow {
                target: harness.session("base:0.0"),
            },
            draft("", cwd, ""),
        )
        .await;
    assert!(matches!(
        window_empty.last(),
        Some(CreationProgress::Finished { .. })
    ));
    let create = harness
        .log_entries()
        .into_iter()
        .rev()
        .find(|argv| argv.first().is_some_and(|arg| arg == "new-window"))
        .expect("new-window argv");
    assert!(!create.iter().any(|arg| arg == "-n" || arg == "-s"));

    let sentinel = PathBuf::from(format!(
        "/tmp/pane-dash-sentinel-{}-{}",
        std::process::id(),
        NEXT_SOCKET.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_file(&sentinel);
    harness.text(["set-option", "-g", "default-command", "exec cat"]);
    let hostile = format!(
        "-leading #{{}} #{{not-a-format}} \"quoted\" 雪
touch {};",
        sentinel.display()
    );
    let before = harness.log_entries().len();
    let literal = harness
        .create(
            CreateContext::NewSession,
            draft("literal-command", cwd, &hostile),
        )
        .await;
    assert!(matches!(
        literal.last(),
        Some(CreationProgress::Finished { .. })
    ));
    let commands = &harness.log_entries()[before..];
    let sends: Vec<_> = commands
        .iter()
        .filter(|argv| argv.first().is_some_and(|arg| arg == "send-keys"))
        .collect();
    assert_eq!(
        sends.len(),
        2,
        "one literal send and one Enter, with no replay"
    );
    let literal_pane = created_pane(&literal);
    let expected_wire_command = format!(
        "{}\\;",
        hostile
            .strip_suffix(';')
            .expect("hostile command must end with a semicolon")
    );
    assert_eq!(
        sends[0],
        &vec![
            "send-keys".to_owned(),
            "-l".to_owned(),
            "-t".to_owned(),
            literal_pane.0.clone(),
            "--".to_owned(),
            expected_wire_command,
        ],
        "literal command wrapper argv must use tmux's exact escaped trailing-semicolon wire form"
    );
    assert_eq!(
        sends[1],
        &vec![
            "send-keys".to_owned(),
            "-t".to_owned(),
            literal_pane.0.clone(),
            "Enter".to_owned(),
        ]
    );
    let started = Instant::now();
    let captured = loop {
        let capture = harness.text(["capture-pane", "-p", "-t", &literal_pane.0]);
        if capture
            .lines()
            .any(|line| line.trim_end() == "-leading #{} #{not-a-format} \"quoted\" 雪")
            && capture
                .lines()
                .any(|line| line.trim_end() == format!("touch {};", sentinel.display()))
        {
            break capture;
        }
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "literal command was not visible: {capture}"
        );
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(
        captured
            .lines()
            .any(|line| line.trim_end() == "-leading #{} #{not-a-format} \"quoted\" 雪"),
        "first literal line was not exact: {captured:?}"
    );
    assert!(
        captured
            .lines()
            .any(|line| line.trim_end() == format!("touch {};", sentinel.display())),
        "second literal line was not exact: {captured:?}"
    );
    assert!(
        !sentinel.exists(),
        "hostile literal command created a sentinel"
    );

    let _restore = EnvRestore::set("PD_CREATION_FAIL", "command");
    let before = harness.log_entries().len();
    let failed = harness
        .create(
            CreateContext::NewSession,
            draft("command-failure", cwd, "echo blocked"),
        )
        .await;
    assert!(
        matches!(failed.last(), Some(CreationProgress::Finished { resolution: pane_dash::creation::CreationResolution::CommandFailed { stage: CreateStage::SendCommand, error }, .. }) if error.contains("command stage rejected"))
    );
    let failed_argv = &harness.log_entries()[before..];
    assert_eq!(
        failed_argv
            .iter()
            .filter(|argv| argv.first().is_some_and(|arg| arg == "send-keys"))
            .count(),
        1
    );
    assert!(
        !failed_argv
            .iter()
            .any(|argv| argv.last().is_some_and(|arg| arg == "Enter"))
    );
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "requires tmux >= 3.6; serial scratch server"]
async fn creation_timeout_kills_and_reaps_a_hung_stage_without_later_stages() {
    let _serial = serial_test().await;
    let harness = Harness::new();
    let _restore = EnvRestore::set("PD_CREATION_HANG", "1");
    let started = Instant::now();
    let events = harness
        .create(
            CreateContext::Split {
                target: harness.pane("base:0.0"),
                initiating_session: harness.session("base:0.0"),
                linked_session_count: 1,
                direction: SplitDirection::Right,
            },
            draft("", harness.dir.path(), "echo must-not-run"),
        )
        .await;

    assert!(started.elapsed() >= Duration::from_secs(10));
    assert!(matches!(
        events.last(),
        Some(CreationProgress::TimedOut { .. })
    ));
    let pid = fs::read_to_string(&harness.hang_pid).expect("hung wrapper pid");
    wait_for_pid_exit(pid.trim());
    assert!(
        !harness.log_entries().iter().any(|argv| {
            argv.first()
                .is_some_and(|arg| arg == "set-option" || arg == "send-keys")
        }),
        "timeout must not start tag or command stages"
    );
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "requires tmux >= 3.6; serial scratch server"]
async fn creation_timeout_recovers_real_pane_id_from_blocked_after_new_window() {
    let _serial = serial_test().await;
    let harness = Harness::new();
    let token = format!(
        "pane-dash-blocked-new-window-{}",
        NEXT_SOCKET.fetch_add(1, Ordering::Relaxed)
    );
    harness.install_blocked_new_window_hook(&token);
    let hook_guard = BlockedHookGuard {
        harness: &harness,
        token,
        active: true,
    };
    let _record_pid = EnvRestore::set("PD_CREATION_RECORD_PID", "1");
    let _pid_file = EnvRestore::set(
        "PD_CREATION_PID_FILE",
        harness.hang_pid.to_str().expect("UTF-8 PID path"),
    );
    let started = Instant::now();
    let events = harness
        .create(
            CreateContext::NewWindow {
                target: harness.session("base:0.0"),
            },
            draft("", harness.dir.path(), "echo must-not-run"),
        )
        .await;
    let elapsed = started.elapsed();

    assert!(elapsed >= Duration::from_secs(10));
    assert!(elapsed < Duration::from_secs(12));
    assert!(matches!(
        events.as_slice(),
        [
            CreationProgress::Stage {
                stage: CreateStage::Create,
                pane_id: None,
                ..
            },
            CreationProgress::Created { pane_id, .. },
            CreationProgress::Finished {
                pane_id: finished,
                resolution: CreationResolution::TimedOut {
                    stage: CreateStage::Create,
                },
                ..
            },
        ] if pane_id == finished
    ));
    let pid = fs::read_to_string(&harness.hang_pid).expect("one-shot tmux client pid");
    wait_for_pid_exit(pid.trim());
    hook_guard.release();
    let pane_id = created_pane(&events);
    assert_eq!(
        harness
            .text(["display-message", "-p", "-t", &pane_id.0, "#{pane_id}"])
            .trim(),
        pane_id.0
    );
    assert!(
        harness
            .text([
                "display-message",
                "-p",
                "-t",
                &pane_id.0,
                "#{@pane_dash_tag}"
            ])
            .trim()
            .is_empty()
    );
    assert_eq!(
        harness
            .log_entries()
            .iter()
            .filter(|argv| argv.first().is_some_and(|arg| arg == "new-window"))
            .count(),
        1
    );
    assert!(!harness.log_entries().iter().any(|argv| {
        argv.first()
            .is_some_and(|arg| arg == "set-option" || arg == "send-keys")
    }));
}
