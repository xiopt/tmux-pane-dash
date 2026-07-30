#![cfg(unix)]

use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;
use tempfile::TempDir;

struct Harness {
    dir: TempDir,
    tmux_socket: PathBuf,
    socket: PathBuf,
    no_sessions: PathBuf,
    server: Option<Child>,
}

impl Harness {
    fn new(with_stale_socket: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let tmux_socket = dir.path().join("tmux,notification-server");
        let socket = dir.path().join(".pane-dash-notify-4242.sock");
        let no_sessions = dir.path().join("no-sessions");
        let log = dir.path().join("tmux.log");
        let fake_tmux = dir.path().join("tmux");
        fs::write(
            &fake_tmux,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" >> {log}\nprintf '%s\\n' '---' >> {log}\nif [ \"$1\" = -S ]; then shift 2; fi\ncase \"$1\" in\n  display-message) printf '%s\\037$1\\037@1\\n' \"$4\" ;;\n  list-sessions) if [ -f \"$TMUX_NOTIFY_NO_SESSIONS\" ]; then exit 1; fi; printf '$1\\n' ;;\nesac\n",
                log = shell_quote(&log),
            ),
        )
        .unwrap();
        fs::set_permissions(&fake_tmux, fs::Permissions::from_mode(0o755)).unwrap();
        if with_stale_socket {
            fs::write(&socket, b"stale").unwrap();
        }

        let path = format!(
            "{}:{}",
            dir.path().display(),
            std::env::var_os("PATH")
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_default()
        );
        let server = Command::new(env!("CARGO_BIN_EXE_pane-dash"))
            .args([
                "notify",
                "serve",
                "--tmux-socket",
                tmux_socket.to_str().unwrap(),
                "--server-pid",
                "4242",
            ])
            .env("PATH", path)
            .env("TMUX_NOTIFY_LOG", &log)
            .env("TMUX_NOTIFY_NO_SESSIONS", &no_sessions)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut harness = Self {
            dir,
            tmux_socket,
            socket,
            no_sessions,
            server: Some(server),
        };
        harness.wait_for_socket();
        harness
    }

    fn identity(&self) -> String {
        format!("{},4242,0", self.tmux_socket.display())
    }

    fn client(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_pane-dash"))
            .args(args)
            .env("TMUX", self.identity())
            .env("TMUX_PANE", "%1")
            .env("PATH", self.command_path())
            .env("TMUX_NOTIFY_LOG", self.log_path())
            .env("TMUX_NOTIFY_NO_SESSIONS", &self.no_sessions)
            .output()
            .unwrap()
    }

    fn command_path(&self) -> String {
        format!(
            "{}:{}",
            self.dir.path().display(),
            std::env::var_os("PATH")
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_default()
        )
    }

    fn log_path(&self) -> PathBuf {
        self.dir.path().join("tmux.log")
    }

    fn wait_for_socket(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while !fs::metadata(&self.socket).is_ok_and(|metadata| metadata.file_type().is_socket()) {
            assert!(
                Instant::now() < deadline,
                "notification service did not bind"
            );
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn log(&self) -> String {
        fs::read_to_string(self.log_path()).unwrap_or_default()
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        if self.server.is_some() {
            let _ = self.client(&["notify", "shutdown"]);
        }
        if let Some(mut server) = self.server.take() {
            if server.try_wait().unwrap().is_none() {
                let _ = server.kill();
            }
            let _ = server.wait();
        }
        let _ = fs::remove_file(&self.socket);
    }
}

fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.display().to_string().replace('\'', "'\"'\"'"))
}

fn json(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
        panic!(
            "invalid JSON: {error}; status={}; stderr={}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        )
    })
}

#[test]
fn cli_derives_the_per_server_socket_from_a_comma_containing_tmux_path() {
    let harness = Harness::new(false);
    let output = harness.client(&["notify", "list"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(json(&output)["snapshot"], Value::Array(Vec::new()));

    let malformed = harness.client(&[
        "notify",
        "click",
        "--range",
        "not-a-range",
        "--client",
        "/dev/ttys001",
    ]);
    assert!(!malformed.status.success());
}

#[test]
fn service_socket_is_private_and_same_owner_second_service_exits() {
    let mut harness = Harness::new(false);
    let mode = fs::metadata(&harness.socket).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);

    let second = Command::new(env!("CARGO_BIN_EXE_pane-dash"))
        .args([
            "notify",
            "serve",
            "--tmux-socket",
            harness.tmux_socket.to_str().unwrap(),
            "--server-pid",
            "4242",
        ])
        .env("PATH", harness.command_path())
        .env("TMUX_NOTIFY_LOG", harness.log_path())
        .env("TMUX_NOTIFY_NO_SESSIONS", &harness.no_sessions)
        .output()
        .unwrap();
    assert!(
        second.status.success(),
        "{}",
        String::from_utf8_lossy(&second.stderr)
    );
    assert!(harness.socket.exists());
    assert!(
        harness
            .server
            .as_mut()
            .unwrap()
            .try_wait()
            .unwrap()
            .is_none()
    );
}

#[test]
fn stale_socket_is_replaced_once() {
    let harness = Harness::new(true);
    assert!(
        fs::metadata(&harness.socket)
            .unwrap()
            .file_type()
            .is_socket()
    );
}

#[test]
fn oversized_frame_is_rejected_without_mutating_state() {
    let harness = Harness::new(false);
    let mut stream = std::os::unix::net::UnixStream::connect(&harness.socket).unwrap();
    let request = format!(
        "{{\"op\":\"publish\",\"event_id\":\"too-large\",\"kind\":\"error\",\"message\":\"{}\",\"pane\":\"%1\"}}\n",
        "x".repeat(5_000)
    );
    stream.write_all(request.as_bytes()).unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).unwrap();
    let response: Value = serde_json::from_slice(&response).unwrap();
    assert_eq!(response["ok"], false);
    assert_eq!(response["outcome"], "malformed");

    let listed = harness.client(&["notify", "list"]);
    assert!(listed.status.success());
    assert_eq!(json(&listed)["snapshot"], Value::Array(Vec::new()));
    assert!(!harness.log().contains("display-message"));
}

#[test]
fn publish_list_and_click_round_trip_with_exact_targeting() {
    let harness = Harness::new(false);
    let published = harness.client(&[
        "notify",
        "publish",
        "--event-id",
        "event-1",
        "--kind",
        "error",
        "--message",
        "failed",
        "--pane",
        "%1",
    ]);
    assert!(published.status.success());
    assert_eq!(json(&published)["outcome"], "queued");

    let listed = harness.client(&["notify", "list"]);
    let item = &json(&listed)["snapshot"][0];
    assert_eq!(item["event_id"], "event-1");
    assert_eq!(item["pane_id"], "%1");

    let clicked = harness.client(&[
        "notify",
        "click",
        "--range",
        "pane-dash-visible-1",
        "--client",
        "/dev/ttys001",
    ]);
    assert!(clicked.status.success());
    assert_eq!(json(&clicked)["route"]["pane_id"], "%1");
    let empty = harness.client(&["notify", "list"]);
    assert!(json(&empty)["snapshot"].as_array().unwrap().is_empty());
    assert!(harness.log().contains("display-message\n-p\n-t\n%1\n"));
    assert!(
        harness
            .log()
            .contains("#{pane_id}\x1f#{session_id}\x1f#{window_id}")
    );
    assert!(
        harness
            .log()
            .contains("switch-client\n-Z\n-c\n/dev/ttys001\n-t\n%1\n")
    );
}

#[test]
fn concurrent_clicks_dismiss_and_route_only_once() {
    let harness = Harness::new(false);
    assert!(
        harness
            .client(&[
                "notify",
                "publish",
                "--event-id",
                "event-1",
                "--kind",
                "finished",
                "--message",
                "done",
                "--pane",
                "%1",
            ])
            .status
            .success()
    );

    let (left, right) = thread::scope(|scope| {
        let left = scope.spawn(|| {
            harness.client(&[
                "notify",
                "click",
                "--range",
                "pane-dash-visible-1",
                "--client",
                "/dev/ttys001",
            ])
        });
        let right = scope.spawn(|| {
            harness.client(&[
                "notify",
                "click",
                "--range",
                "pane-dash-visible-1",
                "--client",
                "/dev/ttys001",
            ])
        });
        (left.join().unwrap(), right.join().unwrap())
    });
    let outcomes = [
        json(&left)["outcome"].clone(),
        json(&right)["outcome"].clone(),
    ];
    assert!(outcomes.contains(&Value::String("clicked".to_owned())));
    assert!(outcomes.contains(&Value::String("ignored".to_owned())));
    assert_eq!(harness.log().matches("switch-client").count(), 1);
}

#[test]
fn focus_suppresses_and_pane_exit_cleans_up_over_ipc() {
    let harness = Harness::new(false);
    let focused = harness.client(&[
        "notify",
        "hook",
        "focus",
        "--client",
        "/dev/ttys001",
        "--pane",
        "%1",
        "--width",
        "80",
        "--focused",
        "1",
    ]);
    assert!(focused.status.success());

    let suppressed = harness.client(&[
        "notify",
        "publish",
        "--event-id",
        "focused",
        "--kind",
        "question",
        "--message",
        "look",
        "--pane",
        "%1",
    ]);
    assert_eq!(json(&suppressed)["outcome"], "suppressed");

    let queued = harness.client(&[
        "notify",
        "publish",
        "--event-id",
        "other",
        "--kind",
        "question",
        "--message",
        "look",
        "--pane",
        "%2",
    ]);
    assert_eq!(json(&queued)["outcome"], "queued");
    let exited = harness.client(&["notify", "hook", "pane-exited", "--pane", "%2"]);
    assert!(exited.status.success());
    let listed = harness.client(&["notify", "list"]);
    assert!(json(&listed)["snapshot"].as_array().unwrap().is_empty());
}

#[test]
fn session_closed_only_stops_after_the_last_session_is_gone() {
    let mut harness = Harness::new(false);
    let alive = harness.client(&["notify", "hook", "session-closed"]);
    assert_eq!(json(&alive)["outcome"], "server_alive");
    assert!(
        harness
            .server
            .as_mut()
            .unwrap()
            .try_wait()
            .unwrap()
            .is_none()
    );

    fs::write(&harness.no_sessions, b"").unwrap();
    let stopped = harness.client(&["notify", "hook", "session-closed"]);
    assert_eq!(json(&stopped)["outcome"], "stopped");
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if harness
            .server
            .as_mut()
            .unwrap()
            .try_wait()
            .unwrap()
            .is_some()
        {
            break;
        }
        assert!(Instant::now() < deadline, "service did not stop");
        thread::sleep(Duration::from_millis(5));
    }
    assert!(!harness.socket.exists());
}

#[test]
fn idle_service_does_not_call_tmux_or_poll() {
    let harness = Harness::new(false);
    thread::sleep(Duration::from_millis(150));
    assert_eq!(harness.log(), "");
}
