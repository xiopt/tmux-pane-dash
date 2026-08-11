#![cfg(unix)]

use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tempfile::TempDir;

struct Harness {
    dir: TempDir,
    tmux_socket: PathBuf,
    socket: PathBuf,
    no_sessions: PathBuf,
    clients: PathBuf,
    focus: PathBuf,
    status: PathBuf,
    server_stderr: PathBuf,
    server: Option<Child>,
}

impl Harness {
    fn new(with_stale_socket: bool) -> Self {
        let mut harness = Self::setup(with_stale_socket);
        harness.start_service();
        harness.wait_for_socket();
        harness
    }

    fn setup(with_stale_socket: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let tmux_socket = dir.path().join("tmux,notification-server");
        let socket = dir.path().join(".pane-dash-notify-4242.sock");
        let no_sessions = dir.path().join("no-sessions");
        let clients = dir.path().join("clients");
        let focus = dir.path().join("focus");
        let status = dir.path().join("status");
        let server_stderr = dir.path().join("server.stderr");
        let log = dir.path().join("tmux.log");
        let fake_tmux = dir.path().join("tmux");
        fs::write(
            &fake_tmux,
            format!(
                r#"#!/bin/sh
printf '%s\n' "$@" >> {log}
printf '%s\n' '---' >> {log}
if [ "$1" = -S ]; then shift 2; fi
case "$1" in
  display-message) printf '%s\037$1\037@1\n' "$4" ;;
  list-clients) cat {clients} 2>/dev/null || true ;;
  list-sessions) if [ -f "$TMUX_NOTIFY_NO_SESSIONS" ]; then exit 1; fi; printf '$1\n' ;;
  show-option)
    if [ "$2" = -gqv ]; then
      case "$3" in
        @pane_dash_focus_*) cat {focus} 2>/dev/null || true ;;
      esac
    fi
    ;;
  set-option)
    if [ "$2" = -g ] && [ "$3" = @pane_dash_notify_status ]; then
      printf '%s' "$4" > {status}
    fi
    ;;
esac
"#,
                log = shell_quote(&log),
                clients = shell_quote(&clients),
                focus = shell_quote(&focus),
                status = shell_quote(&status),
            ),
        )
        .unwrap();
        fs::set_permissions(&fake_tmux, fs::Permissions::from_mode(0o755)).unwrap();
        if with_stale_socket {
            fs::write(&socket, b"stale").unwrap();
        }

        Self {
            dir,
            tmux_socket,
            socket,
            no_sessions,
            clients,
            focus,
            status,
            server_stderr,
            server: None,
        }
    }

    fn started_with_startup(clients: &str, focus: Option<&str>, status: &str) -> Self {
        let mut harness = Self::setup(false);
        fs::write(&harness.clients, clients).unwrap();
        if let Some(focus) = focus {
            fs::write(&harness.focus, focus).unwrap();
        }
        fs::write(&harness.status, status).unwrap();
        harness.start_service();
        harness.wait_for_socket();
        harness
    }

    fn start_service(&mut self) {
        let path = format!(
            "{}:{}",
            self.dir.path().display(),
            std::env::var_os("PATH")
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_default()
        );
        let server = Command::new(env!("CARGO_BIN_EXE_pane-dash"))
            .args([
                "notify",
                "serve",
                "--tmux-socket",
                self.tmux_socket.to_str().unwrap(),
                "--server-pid",
                "4242",
            ])
            .env("PATH", path)
            .env("TMUX_NOTIFY_LOG", self.log_path())
            .env("TMUX_NOTIFY_NO_SESSIONS", &self.no_sessions)
            .env("TMUX_NOTIFY_CLIENTS", &self.clients)
            .env("TMUX_NOTIFY_FOCUS", &self.focus)
            .env("TMUX_NOTIFY_STATUS", &self.status)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::from(fs::File::create(&self.server_stderr).unwrap()))
            .spawn()
            .unwrap();
        self.server = Some(server);
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
            .env("TMUX_NOTIFY_CLIENTS", &self.clients)
            .env("TMUX_NOTIFY_FOCUS", &self.focus)
            .env("TMUX_NOTIFY_STATUS", &self.status)
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
        let ready = self.client(&["notify", "list"]);
        assert!(
            ready.status.success(),
            "notification service did not finish startup: {}",
            String::from_utf8_lossy(&ready.stderr)
        );
    }

    fn socket_identity(&self) -> (u64, u64) {
        let metadata = fs::metadata(&self.socket).unwrap();
        (metadata.dev(), metadata.ino())
    }

    fn wait_for_socket_replacement(&mut self, old_identity: (u64, u64)) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if fs::metadata(&self.socket).is_ok_and(|metadata| {
                metadata.file_type().is_socket() && (metadata.dev(), metadata.ino()) != old_identity
            }) {
                return;
            }
            if Instant::now() >= deadline {
                let status = self.server.as_mut().unwrap().try_wait().unwrap();
                let stderr = fs::read_to_string(&self.server_stderr).unwrap_or_default();
                panic!("notification service did not replace the socket; child={status:?}; stderr={stderr}");
            }
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn raw_request(&self, request: Value) -> (Value, usize) {
        let mut stream = UnixStream::connect(&self.socket).unwrap();
        let mut frame = serde_json::to_vec(&request).unwrap();
        frame.push(b'\n');
        stream.write_all(&frame).unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).unwrap();
        let frame_len = response.len();
        assert_eq!(response.pop(), Some(b'\n'));
        (serde_json::from_slice(&response).unwrap(), frame_len)
    }

    fn log(&self) -> String {
        fs::read_to_string(self.log_path()).unwrap_or_default()
    }

    fn command_count(&self, command: &str) -> usize {
        self.log().matches(&format!("{command}\n")).count()
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

fn read_frame(stream: &mut UnixStream) -> Vec<u8> {
    let mut frame = Vec::new();
    loop {
        let mut byte = [0_u8; 1];
        stream.read_exact(&mut byte).unwrap();
        frame.push(byte[0]);
        if byte[0] == b'\n' {
            return frame;
        }
    }
}

fn legacy_owner(path: &Path, shutdown_delay: Duration) -> thread::JoinHandle<()> {
    let path = path.to_owned();
    let listener = UnixListener::bind(&path).unwrap();
    listener.set_nonblocking(true).unwrap();
    thread::spawn(move || {
        let (mut ping, _) = loop {
            match listener.accept() {
                Ok(connection) => break connection,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(5));
                }
                Err(error) => panic!("legacy owner failed to accept ping: {error}"),
            }
        };
        ping.set_nonblocking(false).unwrap();
        let request: Value = serde_json::from_slice(&read_frame(&mut ping)).unwrap();
        assert_eq!(request["op"], "ping");
        ping.write_all(b"{\"ok\":true,\"version\":1,\"outcome\":\"pong\"}\n")
            .unwrap();
        drop(ping);

        listener.set_nonblocking(false).unwrap();
        let (mut shutdown, _) = listener.accept().unwrap();
        let request: Value = serde_json::from_slice(&read_frame(&mut shutdown)).unwrap();
        assert_eq!(request["op"], "shutdown");
        thread::sleep(shutdown_delay);
        shutdown
            .write_all(b"{\"ok\":true,\"outcome\":\"stopped\"}\n")
            .unwrap();
        drop(shutdown);
        drop(listener);
        let _ = fs::remove_file(&path);
    })
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
    assert_eq!(harness.command_count("set-option"), 1);

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
    assert_eq!(harness.command_count("set-option"), 1);
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
fn owner_start_clears_stale_status_seeds_focus_and_refreshes_once() {
    let harness = Harness::started_with_startup(
        "/dev/ttys001\x1f10\x1f%1\x1f80\x1f0\n/dev/ttys002\x1f20\x1f%2\x1f100\x1f0\n",
        Some("1"),
        "stale",
    );
    assert_eq!(fs::read_to_string(&harness.status).unwrap(), "");
    assert_eq!(harness.command_count("set-option"), 1);
    assert_eq!(harness.command_count("refresh-client"), 1);
    assert!(harness.log().contains("@pane_dash_focus_/dev/ttys002\n"));

    let published = harness.client(&[
        "notify",
        "publish",
        "--event-id",
        "startup-focused",
        "--kind",
        "question",
        "--message",
        "look",
        "--pane",
        "%2",
    ]);
    assert_eq!(json(&published)["outcome"], "suppressed");
    let listed = harness.client(&["notify", "list"]);
    assert_eq!(json(&listed)["snapshot"], Value::Array(Vec::new()));
}

#[test]
fn startup_seed_chooses_the_most_recent_normal_client() {
    let harness = Harness::started_with_startup(
        "/dev/ttys003\x1f99\x1f%3\x1f80\x1f1\nnot-a-tty\x1f98\x1f%4\x1f80\x1f0\n/dev/ttys002\x1f20\x1f%2\x1f100\x1f0\n/dev/ttys001\x1f20\x1f%1\x1f80\x1f0\n",
        Some("1"),
        "",
    );
    assert!(harness.log().contains("@pane_dash_focus_/dev/ttys002\n"));
    assert!(
        harness
            .log()
            .contains("refresh-client\n-S\n-t\n/dev/ttys002\n")
    );

    let published = harness.client(&[
        "notify",
        "publish",
        "--event-id",
        "deterministic-startup",
        "--kind",
        "question",
        "--message",
        "look",
        "--pane",
        "%2",
    ]);
    assert_eq!(json(&published)["outcome"], "suppressed");
}

#[test]
fn startup_without_focus_relay_does_not_suppress() {
    let harness = Harness::started_with_startup("/dev/ttys001\x1f20\x1f%1\x1f80\x1f0\n", None, "");
    let published = harness.client(&[
        "notify",
        "publish",
        "--event-id",
        "unfocused-startup",
        "--kind",
        "question",
        "--message",
        "look",
        "--pane",
        "%1",
    ]);
    assert_eq!(json(&published)["outcome"], "queued");
}

#[test]
fn reachable_version_mismatch_shuts_down_old_owner_before_replacing_socket() {
    let mut harness = Harness::setup(false);
    let legacy = legacy_owner(&harness.socket, Duration::from_millis(700));
    let old_identity = harness.socket_identity();
    harness.start_service();
    harness.wait_for_socket_replacement(old_identity);

    thread::sleep(Duration::from_millis(700));
    let listed = harness.client(&["notify", "list"]);
    assert!(
        listed.status.success(),
        "{}",
        String::from_utf8_lossy(&listed.stderr)
    );
    assert_eq!(json(&listed)["snapshot"], Value::Array(Vec::new()));
    assert!(
        harness
            .server
            .as_mut()
            .unwrap()
            .try_wait()
            .unwrap()
            .is_none()
    );
    legacy.join().unwrap();
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
    let response: Value = serde_json::from_slice(&read_frame(&mut stream)).unwrap();
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
        "v1",
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
fn paged_list_fetches_all_maximum_notifications_with_bounded_frames() {
    let harness = Harness::new(false);
    let message = "x".repeat(pane_dash::notifications::MAX_MESSAGE_SCALARS);
    let kinds = ["error", "permission", "question", "finished"];

    for index in 0..64 {
        let event_id = format!("{index:0>128}");
        let output = harness.client(&[
            "notify",
            "publish",
            "--event-id",
            event_id.as_str(),
            "--kind",
            kinds[index % kinds.len()],
            "--message",
            message.as_str(),
            "--pane",
            "%1",
        ]);
        assert!(
            output.status.success(),
            "publish {index} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    let mut after_cursor = Value::Null;
    let mut sequences = Vec::new();
    let mut pages = 0;
    loop {
        let (page, frame_len) = harness.raw_request(json!({
            "op": "list",
            "after_cursor": after_cursor.clone(),
        }));
        assert!(frame_len <= 4 * 1024);
        assert_eq!(page["ok"], true);
        sequences.extend(
            page["snapshot"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| item["sequence"].as_u64().unwrap()),
        );
        after_cursor = page["next_cursor"].clone();
        pages += 1;
        assert!(pages <= 64);
        if after_cursor.is_null() {
            break;
        }
    }

    let mut expected: Vec<_> = (0..64)
        .map(|index| (4 - (index % kinds.len()) as u8, index as u64 + 1))
        .collect();
    expected.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1)));
    assert_eq!(
        sequences,
        expected
            .into_iter()
            .map(|(_, sequence)| sequence)
            .collect::<Vec<_>>()
    );

    let listed = harness.client(&["notify", "list"]);
    assert!(listed.status.success());
    assert_eq!(json(&listed)["snapshot"].as_array().unwrap().len(), 64);
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
                "v1",
                "--client",
                "/dev/ttys001",
            ])
        });
        let right = scope.spawn(|| {
            harness.client(&[
                "notify",
                "click",
                "--range",
                "v1",
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
        "--acknowledge",
        "0",
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
fn manual_focus_acknowledges_old_events_and_allows_later_events_over_ipc() {
    let harness = Harness::new(false);

    let permission = harness.client(&[
        "notify",
        "publish",
        "--event-id",
        "permission",
        "--kind",
        "permission",
        "--message",
        "approve",
        "--pane",
        "%1",
    ]);
    assert_eq!(json(&permission)["outcome"], "queued");

    let acknowledged = harness.client(&[
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
        "--acknowledge",
        "1",
    ]);
    assert!(acknowledged.status.success());
    assert!(
        json(&harness.client(&["notify", "list"]))["snapshot"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(fs::read_to_string(&harness.status).unwrap(), "");

    let moved_away = harness.client(&[
        "notify",
        "hook",
        "focus",
        "--client",
        "/dev/ttys001",
        "--pane",
        "%2",
        "--width",
        "80",
        "--focused",
        "1",
        "--acknowledge",
        "1",
    ]);
    assert!(moved_away.status.success());

    let finished = harness.client(&[
        "notify",
        "publish",
        "--event-id",
        "finished",
        "--kind",
        "finished",
        "--message",
        "done",
        "--pane",
        "%1",
    ]);
    assert_eq!(json(&finished)["outcome"], "queued");
    let listed = json(&harness.client(&["notify", "list"]));
    let snapshot = listed["snapshot"].as_array().unwrap();
    assert_eq!(snapshot.len(), 1);
    assert_eq!(snapshot[0]["event_id"], "finished");
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

/// A cursor item dismissed between pages must not restart paging at the head.
/// The service resolves the cursor by locating its sort key in the current
/// snapshot; when it is gone, the next page must still advance past that key.
#[test]
fn paged_list_does_not_replay_items_when_the_cursor_item_is_dismissed() {
    let harness = Harness::new(false);
    let kinds = [
        "finished", "error", "finished", "error", "finished", "finished",
    ];
    for (index, kind) in kinds.iter().enumerate() {
        let event_id = format!("page-race-{index}");
        let output = harness.client(&[
            "notify",
            "publish",
            "--event-id",
            event_id.as_str(),
            "--kind",
            kind,
            "--message",
            "message",
            "--pane",
            "%1",
        ]);
        assert!(output.status.success(), "publish {index} failed");
    }

    let (first_page, _) = harness.raw_request(json!({ "op": "list", "after_cursor": null }));
    assert_eq!(first_page["ok"], true);
    let first_sequences: Vec<u64> = first_page["snapshot"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["sequence"].as_u64().unwrap())
        .collect();
    let cursor = first_page["next_cursor"].clone();
    let cursor_sequence = cursor["sequence"].as_u64().unwrap();
    assert!(first_sequences.contains(&cursor_sequence));

    // Dismiss exactly the item the cursor points at, then resume paging.
    let cursor_event_id = first_page["snapshot"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["sequence"].as_u64() == Some(cursor_sequence))
        .unwrap()["event_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let dismissed = harness.raw_request(json!({
        "op": "select",
        "event_id": cursor_event_id,
        "client": "/dev/ttys001",
    }));
    assert_eq!(dismissed.0["outcome"], "selected");

    let (second_page, _) = harness.raw_request(json!({
        "op": "list",
        "after_cursor": cursor,
    }));
    assert_eq!(second_page["ok"], true);
    let second_sequences: Vec<u64> = second_page["snapshot"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["sequence"].as_u64().unwrap())
        .collect();

    let replayed: Vec<u64> = second_sequences
        .iter()
        .copied()
        .filter(|sequence| first_sequences.contains(sequence))
        .collect();
    assert!(
        replayed.is_empty(),
        "page after a dismissed cursor replayed already-delivered items {replayed:?}; \
         first page was {first_sequences:?}, second page was {second_sequences:?}"
    );
    assert!(
        second_sequences.contains(&1),
        "page after a dismissed priority cursor skipped an older lower-priority item; \
         second page was {second_sequences:?}"
    );
}

#[test]
fn startup_seeds_once_and_does_not_poll() {
    let harness = Harness::new(false);
    thread::sleep(Duration::from_millis(150));
    assert_eq!(harness.command_count("set-option"), 1);
    assert_eq!(harness.command_count("list-clients"), 1);
    assert_eq!(harness.command_count("show-option"), 0);
    assert_eq!(harness.command_count("refresh-client"), 0);
}
