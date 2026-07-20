use pane_dash::control::{
    CONTROL_SNAPSHOT_COMMAND, GuardId, ProtocolEvent, ProtocolParser, jump_command,
};

#[cfg(unix)]
mod actor_tests {
    use std::{fs, os::unix::fs::PermissionsExt, path::Path};

    use pane_dash::control::{CONTROL_SNAPSHOT_COMMAND, ControlEvent, connect_control};
    use tempfile::TempDir;
    use tokio::time::{Duration, timeout};

    fn fake_tmux(dir: &TempDir, body: &str) -> std::path::PathBuf {
        let path = dir.path().join("fake-tmux");
        fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&path, permissions).unwrap();
        path
    }

    async fn marker(path: &Path) -> String {
        timeout(Duration::from_secs(2), async {
            loop {
                if let Ok(contents) = fs::read_to_string(path)
                    && !contents.is_empty()
                {
                    return contents;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("marker timed out")
    }

    #[tokio::test]
    async fn connects_with_exact_control_attach_argv() {
        let dir = TempDir::new().unwrap();
        let argv = dir.path().join("argv");
        let fake = fake_tmux(
            &dir,
            &format!(
                "printf '%s\\n' \"$@\" > '{}'\nprintf '%s\\n' '%begin 1 1 1' '%end 1 1 1'\nwhile IFS= read -r _; do :; done",
                argv.display()
            ),
        );

        let (_handle, _events) = connect_control(fake, "$7").await.unwrap();

        assert_eq!(
            marker(&argv).await,
            "-C\nattach-session\n-f\nno-output,ignore-size\n-t\n$7\n"
        );
    }

    #[tokio::test]
    async fn rejects_invalid_session_ids_before_spawning() {
        let dir = TempDir::new().unwrap();
        let invoked = dir.path().join("invoked");
        let fake = fake_tmux(&dir, &format!("echo invoked > '{}'", invoked.display()));

        assert!(connect_control(fake, "$ bad").await.is_err());
        assert!(!invoked.exists());
    }

    #[tokio::test]
    async fn failed_attach_handshake_returns_error_and_reaps_child() {
        let dir = TempDir::new().unwrap();
        let fake = fake_tmux(
            &dir,
            "printf '%s\\n' '%begin 1 1 1' '%error 1 1 1'\nwhile IFS= read -r _; do :; done",
        );

        assert!(connect_control(fake, "$7").await.is_err());
    }

    #[tokio::test]
    async fn serializes_concurrent_requests_fifo_and_preserves_binary_snapshot() {
        let dir = TempDir::new().unwrap();
        let commands = dir.path().join("commands");
        let fake = fake_tmux(
            &dir,
            &format!(
                "printf '%s\\n' '%begin 1 1 1' '%end 1 1 1'\nn=1\nwhile IFS= read -r command; do\n  printf '%s\\n' \"$command\" >> '{}'\n  n=$((n + 1))\n  printf '%%begin 2 %s 1\\n' \"$n\"\n  if [ \"$n\" = 2 ]; then printf '\\036$7\\037%%1\\n'; fi\n  printf '%%end 2 %s 1\\n' \"$n\"\ndone",
                commands.display()
            ),
        );
        let (handle, _events) = connect_control(fake, "$7").await.unwrap();
        let snapshot = handle.snapshot();
        let jump = handle.jump("/dev/ttys001", "%2");
        let (snapshot, jump) = tokio::join!(snapshot, jump);

        assert_eq!(snapshot.unwrap(), b"\x1e$7\x1f%1\n");
        assert!(jump.unwrap());
        assert_eq!(
            marker(&commands).await,
            format!("{CONTROL_SNAPSHOT_COMMAND}switch-client -Z -c /dev/ttys001 -t %2\n")
        );
    }

    #[tokio::test]
    async fn snapshot_error_is_an_error_and_jump_error_is_false() {
        let dir = TempDir::new().unwrap();
        let fake = fake_tmux(
            &dir,
            "printf '%s\\n' '%begin 1 1 1' '%end 1 1 1'\nn=1\nwhile IFS= read -r _; do\n n=$((n + 1)); printf '%%begin 2 %s 1\\n%%error 2 %s 1\\n' \"$n\" \"$n\"\ndone",
        );
        let (handle, _events) = connect_control(fake, "$7").await.unwrap();

        assert!(handle.snapshot().await.is_err());
        assert!(!handle.jump("/dev/ttys001", "%2").await.unwrap());
    }

    #[tokio::test]
    async fn forwards_recognized_notifications_and_ignores_unknown_tokens() {
        let dir = TempDir::new().unwrap();
        let fake = fake_tmux(
            &dir,
            "printf '%s\\n' '%begin 1 1 1' '%end 1 1 1' '%window-add @3' '%future-token ignored'\nwhile IFS= read -r _; do :; done",
        );
        let (_handle, mut events) = connect_control(fake, "$7").await.unwrap();

        assert_eq!(
            timeout(Duration::from_secs(2), events.recv())
                .await
                .unwrap(),
            Some(ControlEvent::TopologyChanged)
        );
        assert!(
            timeout(Duration::from_millis(50), events.recv())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn exit_emits_one_termination_and_fails_the_active_request() {
        let dir = TempDir::new().unwrap();
        let fake = fake_tmux(
            &dir,
            "printf '%s\\n' '%begin 1 1 1' '%end 1 1 1'\nIFS= read -r _\nprintf '%s\\n' '%exit'\nwhile IFS= read -r _; do :; done",
        );
        let (handle, mut events) = connect_control(fake, "$7").await.unwrap();

        assert!(handle.snapshot().await.is_err());
        assert!(matches!(
            timeout(Duration::from_secs(2), events.recv())
                .await
                .unwrap(),
            Some(ControlEvent::Terminated(_))
        ));
        assert_eq!(events.recv().await, None);
    }

    #[tokio::test]
    async fn eof_emits_one_termination_and_fails_the_active_request() {
        let dir = TempDir::new().unwrap();
        let fake = fake_tmux(
            &dir,
            "printf '%s\\n' '%begin 1 1 1' '%end 1 1 1'\nIFS= read -r _\nexit 0",
        );
        let (handle, mut events) = connect_control(fake, "$7").await.unwrap();

        assert!(handle.snapshot().await.is_err());
        assert!(matches!(
            timeout(Duration::from_secs(2), events.recv())
                .await
                .unwrap(),
            Some(ControlEvent::Terminated(_))
        ));
        assert_eq!(events.recv().await, None);
    }

    #[tokio::test]
    async fn exit_fails_active_and_queued_replies() {
        let dir = TempDir::new().unwrap();
        let ready = dir.path().join("ready");
        let release = dir.path().join("release");
        std::process::Command::new("mkfifo")
            .arg(&release)
            .status()
            .unwrap();
        let fake = fake_tmux(
            &dir,
            &format!(
                "printf '%s\\n' '%begin 1 1 1' '%end 1 1 1'\nIFS= read -r _\necho ready > '{}'\nIFS= read -r _ < '{}'\nprintf '%s\\n' '%exit'",
                ready.display(),
                release.display()
            ),
        );
        let (handle, _events) = connect_control(fake, "$7").await.unwrap();
        let first_handle = handle.clone();
        let first = tokio::spawn(async move { first_handle.snapshot().await });
        marker(&ready).await;
        let second_handle = handle.clone();
        let second = tokio::spawn(async move { second_handle.jump("/dev/ttys001", "%2").await });
        tokio::task::yield_now().await;
        fs::write(&release, "go\n").unwrap();

        assert!(first.await.unwrap().is_err());
        assert!(second.await.unwrap().is_err());
    }

    #[tokio::test]
    async fn malformed_eof_fails_active_and_queued_requests_as_one_termination() {
        let dir = TempDir::new().unwrap();
        let ready = dir.path().join("ready");
        let release = dir.path().join("release");
        let commands = dir.path().join("commands");
        std::process::Command::new("mkfifo")
            .arg(&release)
            .status()
            .unwrap();
        let fake = fake_tmux(
            &dir,
            &format!(
                "printf '%s\\n' '%begin 1 1 1' '%end 1 1 1'\nIFS= read -r command\nprintf '%s\\n' \"$command\" > '{}'\necho ready > '{}'\nIFS= read -r _ < '{}'\nprintf '%s\\n' '%begin 2 2 1' 'partial response'\nexit 0",
                commands.display(),
                ready.display(),
                release.display()
            ),
        );
        let (handle, mut events) = connect_control(fake, "$7").await.unwrap();
        let first_handle = handle.clone();
        let first = tokio::spawn(async move { first_handle.snapshot().await });
        marker(&ready).await;
        let second_handle = handle.clone();
        let second = tokio::spawn(async move { second_handle.jump("/dev/ttys001", "%2").await });
        tokio::task::yield_now().await;
        fs::write(&release, "go\n").unwrap();

        let first = first.await.unwrap().unwrap_err().to_string();
        let second = second.await.unwrap().unwrap_err().to_string();
        assert_eq!(first, second);
        assert!(matches!(
            timeout(Duration::from_secs(2), events.recv())
                .await
                .unwrap(),
            Some(ControlEvent::Terminated(_))
        ));
        assert_eq!(events.recv().await, None);
        assert_eq!(marker(&commands).await, CONTROL_SNAPSHOT_COMMAND);
    }

    #[tokio::test]
    async fn dropping_all_handles_closes_stdin_and_reaps_the_child() {
        let dir = TempDir::new().unwrap();
        let exited = dir.path().join("exited");
        let fake = fake_tmux(
            &dir,
            &format!(
                "printf '%s\\n' '%begin 1 1 1' '%end 1 1 1'\nwhile IFS= read -r _; do :; done\necho exited > '{}'",
                exited.display()
            ),
        );
        let (handle, _events) = connect_control(fake, "$7").await.unwrap();
        drop(handle);

        assert_eq!(marker(&exited).await, "exited\n");
    }

    #[tokio::test]
    #[ignore = "requires installed tmux >= 3.6 and macOS script(1) PTY support"]
    async fn real_tmux_control_actor() {
        use std::process::{Command, Stdio};

        struct Server(String);
        impl Drop for Server {
            fn drop(&mut self) {
                let _ = Command::new("tmux")
                    .args(["-L", &self.0, "kill-server"])
                    .status();
            }
        }
        fn tmux(socket: &str, args: &[&str]) -> String {
            let output = Command::new("tmux")
                .args(["-L", socket])
                .args(args)
                .output()
                .unwrap();
            assert!(output.status.success(), "tmux {:?}: {:?}", args, output);
            String::from_utf8(output.stdout).unwrap()
        }

        let socket = format!("pd_control_it_{}", std::process::id());
        let _server = Server(socket.clone());
        let bin_dir = TempDir::new().unwrap();
        let tmux_bin = fake_tmux(&bin_dir, &format!("exec tmux -L '{}' \"$@\"", socket));
        tmux(
            &socket,
            &["-f", "/dev/null", "new-session", "-d", "-s", "first"],
        );
        tmux(&socket, &["new-session", "-d", "-s", "second"]);
        let first_id = tmux(
            &socket,
            &["display-message", "-p", "-t", "first", "#{session_id}"],
        )
        .trim()
        .to_owned();
        let second_id = tmux(
            &socket,
            &["display-message", "-p", "-t", "second", "#{session_id}"],
        )
        .trim()
        .to_owned();
        let mut pty = Command::new("script")
            .args([
                "-q",
                "/dev/null",
                "tmux",
                "-L",
                &socket,
                "attach-session",
                "-t",
                "first",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let client_tty = timeout(Duration::from_secs(2), async {
            loop {
                let tty = tmux(&socket, &["list-clients", "-F", "#{client_tty}"]);
                if let Some(tty) = tty.lines().find(|tty| tty.starts_with('/')) {
                    return tty.to_owned();
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();

        let (handle, mut events) = connect_control(tmux_bin, &first_id).await.unwrap();
        let snapshot = handle.snapshot().await.unwrap();
        assert!(snapshot.starts_with(b"\x1e"));
        assert!(!pane_dash::snapshot::parse(&snapshot).records.is_empty());
        tmux(&socket, &["rename-window", "-t", "first:0", "renamed"]);
        assert_eq!(
            timeout(Duration::from_secs(2), events.recv())
                .await
                .unwrap(),
            Some(ControlEvent::TopologyChanged)
        );
        assert!(handle.jump(&client_tty, &second_id).await.unwrap());
        assert_eq!(
            tmux(
                &socket,
                &["display-message", "-p", "-t", &client_tty, "#{session_id}"]
            )
            .trim(),
            second_id
        );

        drop(handle);
        tmux(&socket, &["detach-client", "-t", &client_tty]);
        let _ = pty.kill();
        std::thread::spawn(move || {
            let _ = pty.wait();
        });
    }
}

fn guard(timestamp: u64, command_number: u64) -> GuardId {
    GuardId {
        timestamp,
        command_number,
    }
}

fn response(id: GuardId, ok: bool, data: &[u8]) -> ProtocolEvent {
    ProtocolEvent::Response {
        id,
        ok,
        data: data.to_vec(),
    }
}

#[test]
fn parses_matching_end_with_binary_response_from_wire_fixture() {
    let fixture = include_bytes!("../../spike/results/tmux_3.7b/30_wire_framing_raw.bin");
    let mut parser = ProtocolParser::default();
    let events: Vec<_> = fixture
        .split_inclusive(|byte| *byte == b'\n')
        .flat_map(|line| parser.push_line(line))
        .collect();

    assert!(events.contains(&response(
        guard(1_784_499_811, 302),
        true,
        b"\x1e$0\x1f%0\n"
    )));
}

#[test]
fn parses_matching_error() {
    let mut parser = ProtocolParser::default();
    assert!(parser.push_line(b"%begin 10 20 1\n").is_empty());
    assert_eq!(
        parser.push_line(b"%error 10 20 1\n"),
        vec![response(guard(10, 20), false, b"")]
    );
}

#[test]
fn preserves_wrong_guard_ids_as_response_data() {
    let mut parser = ProtocolParser::default();
    parser.push_line(b"%begin 1784499811 306 1\n");
    assert!(parser.push_line(b"evil\n").is_empty());
    assert!(parser.push_line(b"%end 1 1 1\n").is_empty());
    assert!(parser.push_line(b"after\n").is_empty());
    assert_eq!(
        parser.push_line(b"%end 1784499811 306 1\n"),
        vec![response(
            guard(1_784_499_811, 306),
            true,
            b"evil\n%end 1 1 1\nafter\n"
        )]
    );
}

#[test]
fn preserves_notification_nested_begin_and_exit_lines_inside_response() {
    let mut parser = ProtocolParser::default();
    parser.push_line(b"%begin 5 6 1\n");
    for line in [
        b"%window-add @2\n".as_slice(),
        b"%begin 7 8 1\n",
        b"%exit\n",
    ] {
        assert!(parser.push_line(line).is_empty());
    }
    assert_eq!(
        parser.push_line(b"%end 5 6 1\n"),
        vec![response(
            guard(5, 6),
            true,
            b"%window-add @2\n%begin 7 8 1\n%exit\n"
        )]
    );
}

#[test]
fn consumes_each_normative_topology_token_with_arguments_from_notify_fixture() {
    let fixture = include_bytes!("../../spike/results/tmux_3.7b/20_notify_scope_raw.txt");
    let mut parser = ProtocolParser::default();
    let events: Vec<_> = fixture
        .split_inclusive(|byte| *byte == b'\n')
        .flat_map(|line| parser.push_line(line))
        .filter(|event| matches!(event, ProtocolEvent::TopologyChanged))
        .collect();

    assert_eq!(events.len(), 14);
    assert!(
        events
            .iter()
            .all(|event| *event == ProtocolEvent::TopologyChanged)
    );
}

#[test]
fn consumes_each_normative_topology_token_with_arguments() {
    let mut parser = ProtocolParser::default();
    for line in [
        b"%window-add @1\n".as_slice(),
        b"%window-close @1\n",
        b"%window-renamed @1 name\n",
        b"%layout-change @1 layout visible-layout *\n",
        b"%window-pane-changed @1 %1\n",
        b"%session-window-changed $1 @1\n",
        b"%sessions-changed extra\n",
        b"%session-renamed $1 renamed\n",
        b"%unlinked-window-add @1\n",
        b"%unlinked-window-close @1\n",
        b"%unlinked-window-renamed @1 renamed\n",
    ] {
        assert_eq!(parser.push_line(line), vec![ProtocolEvent::TopologyChanged]);
    }
}

#[test]
fn ignores_unconsumed_unknown_and_stray_guard_lines() {
    let mut parser = ProtocolParser::default();
    for line in [
        b"%client-detached /dev/ttys001\n".as_slice(),
        b"%session-changed $0 base\n",
        b"%pane-mode-changed %1\n",
        b"%unknown value\n",
        b"%end 1 2 3\n",
        b"%error 1 2 3\n",
    ] {
        assert!(parser.push_line(line).is_empty());
    }
}

#[test]
fn emits_exit_outside_a_response_block_from_lifecycle_fixtures() {
    for fixture in [
        include_bytes!("../../spike/results/tmux_3.7b/70_serverkill.txt").as_slice(),
        include_bytes!("../../spike/results/tmux_3.7b/70_destroy_off.txt").as_slice(),
    ] {
        let mut parser = ProtocolParser::default();
        let events: Vec<_> = fixture
            .split_inclusive(|byte| *byte == b'\n')
            .flat_map(|line| parser.push_line(line))
            .collect();
        assert_eq!(events.last(), Some(&ProtocolEvent::Exit));
    }
}

#[test]
fn finish_is_empty_outside_a_response_and_idempotent() {
    let mut parser = ProtocolParser::default();
    assert!(parser.finish().is_empty());
    assert!(parser.finish().is_empty());
}

#[test]
fn finish_reports_and_clears_an_open_response() {
    let mut parser = ProtocolParser::default();
    parser.push_line(b"%begin 10 20 1\n");
    parser.push_line(b"partial\n");
    assert_eq!(parser.finish(), vec![ProtocolEvent::MalformedResponse]);
    assert!(parser.finish().is_empty());
}

#[test]
fn ignores_malformed_numeric_guards() {
    let mut parser = ProtocolParser::default();
    for line in [
        b"%begin invalid 20 1\n".as_slice(),
        b"%begin 10 invalid 1\n",
        b"%begin 999999999999999999999999999999 20 1\n",
    ] {
        assert!(parser.push_line(line).is_empty());
    }
    assert!(parser.finish().is_empty());
}

#[test]
fn ignores_begins_with_missing_or_nonnumeric_flags() {
    for line in [b"%begin 10 20\n".as_slice(), b"%begin 10 20 invalid\n"] {
        let mut parser = ProtocolParser::default();
        assert!(parser.push_line(line).is_empty());
        assert!(parser.finish().is_empty());
    }
}

#[test]
fn preserves_matching_closes_with_missing_or_nonnumeric_flags_as_data() {
    for (close, ok) in [("%end", true), ("%error", false)] {
        for flags in ["", " invalid"] {
            let mut parser = ProtocolParser::default();
            parser.push_line(b"%begin 10 20 0\n");
            let malformed = format!("{close} 10 20{flags}\n");
            assert!(parser.push_line(malformed.as_bytes()).is_empty());
            assert_eq!(
                parser.push_line(format!("{close} 10 20 0\n").as_bytes()),
                vec![response(guard(10, 20), ok, malformed.as_bytes())]
            );
        }
    }
}

#[test]
fn builds_the_exact_control_snapshot_command() {
    assert_eq!(
        CONTROL_SNAPSHOT_COMMAND,
        "list-panes -a -F \"\\036#{session_id}\\037#{session_name}\\037#{window_id}\\037#{window_index}\\037#{window_name}\\037#{pane_id}\\037#{pane_index}\\037#{pane_active}\\037#{pane_current_command}\\037#{pane_current_path}\\037#{pane_dead}\\037#{@pane_dash_status}\\037#{@pane_dash_status_since}\\037#{@pane_dash_heartbeat}\\037#{@pane_dash_title}\\037#{@pane_dash_model}\\037#{@pane_dash_tag}\\037#{@pane_dash_group}\"\n"
    );
}

#[test]
fn builds_safe_pane_and_session_jump_commands() {
    assert_eq!(
        jump_command("/dev/ttys001", "%42"),
        Some("switch-client -Z -c /dev/ttys001 -t %42\n".into())
    );
    assert_eq!(
        jump_command("/dev/ttys001", "$3"),
        Some("switch-client -c /dev/ttys001 -t $3\n".into())
    );
}

#[test]
fn rejects_invalid_jump_ttys_and_targets() {
    for tty in [
        "tty",
        " /dev/ttys001",
        "/dev/tty 1",
        "/dev/tty\t1",
        "/dev/tty\n1",
        "/dev/tty\r1",
        "/dev/tty\u{b}1",
        "/dev/tty\u{c}1",
        "/dev/tty\\1",
        "/dev/tty\"1",
        "/dev/tty;1",
        "/dev/tty\0",
        "/dev/tty\u{1f}",
    ] {
        assert_eq!(jump_command(tty, "%1"), None, "tty: {tty:?}");
    }
    for target in [
        "1", "@1", " %1", "% 1", "%\t1", "%\n1", "%\r1", "%\u{b}1", "%\u{c}1", "%\\1", "%\"1",
        "%1;", "%\0", "%1\u{1f}",
    ] {
        assert_eq!(
            jump_command("/dev/ttys001", target),
            None,
            "target: {target:?}"
        );
    }
}
