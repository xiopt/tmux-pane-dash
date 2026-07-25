use crate::app::{ActionOutcome, JumpTarget};
use crate::control::{ControlHandle, is_safe_client_tty};
use crate::model::PaneId;
use crate::tmux_arg::{Field, encode};
use crate::tmux_exec::TmuxExec;

pub async fn send_text(tmux: &TmuxExec, pane_id: &PaneId, text: &str) -> ActionOutcome {
    let Ok(readback) = tmux.display_pane_id(pane_id).await else {
        return ActionOutcome::Vanished;
    };
    let readback = String::from_utf8_lossy(&readback);
    let readback = readback.trim_end_matches(['\r', '\n']);
    if readback != pane_id.0 {
        return ActionOutcome::Vanished;
    }
    let text = match encode(text, Field::Plain) {
        Ok(text) => text,
        Err(error) => return ActionOutcome::Failed(error.to_string()),
    };
    if tmux.send_keys_literal(pane_id, text).await.is_err()
        || tmux.send_enter(pane_id).await.is_err()
    {
        return ActionOutcome::Vanished;
    }
    ActionOutcome::Success
}

/// Kills the exact pane selected in the dashboard. A target that disappeared
/// after rendering is the normal TOCTOU case and is intentionally silent.
pub async fn kill_pane(tmux: &TmuxExec, pane_id: &PaneId) -> ActionOutcome {
    if tmux
        .run_silent(&["kill-pane".into(), "-t".into(), pane_id.0.clone()])
        .await
    {
        ActionOutcome::Success
    } else {
        ActionOutcome::Vanished
    }
}

/// Builds the one-shot tmux argv vectors for a jump action.
///
/// Session switches deliberately omit `-Z`: zoom is a pane property, and a
/// session-header action has no pane to zoom or whose zoom state to preserve.
pub fn jump_commands(client_tty: &str, target: &JumpTarget, zoom: bool) -> Vec<Vec<String>> {
    match target {
        JumpTarget::Session(session_id) => vec![vec![
            "switch-client".into(),
            "-c".into(),
            client_tty.into(),
            "-t".into(),
            session_id.0.clone(),
        ]],
        JumpTarget::Pane(pane_id) => {
            let switch = vec![
                "switch-client".into(),
                "-Z".into(),
                "-c".into(),
                client_tty.into(),
                "-t".into(),
                pane_id.0.clone(),
            ];
            if zoom {
                vec![
                    vec![
                        "resize-pane".into(),
                        "-Z".into(),
                        "-t".into(),
                        pane_id.0.clone(),
                    ],
                    switch,
                ]
            } else {
                vec![switch]
            }
        }
    }
}

/// Executes a jump. A disappearing pane/session is a normal TOCTOU race, so
/// a failed one-shot is intentionally reported only as an unsuccessful action.
pub async fn execute_jump(
    tmux: &TmuxExec,
    control: Option<&ControlHandle>,
    client_tty: &str,
    target: &JumpTarget,
    zoom: bool,
) -> bool {
    if !is_safe_client_tty(client_tty) {
        return false;
    }

    if zoom
        && let JumpTarget::Pane(pane_id) = target
        && !tmux
            .run_silent(&[
                "resize-pane".into(),
                "-Z".into(),
                "-t".into(),
                pane_id.0.clone(),
            ])
            .await
    {
        return false;
    }

    if let Some(control) = control {
        let target = match target {
            JumpTarget::Session(session_id) => &session_id.0,
            JumpTarget::Pane(pane_id) => &pane_id.0,
        };
        return control.jump(client_tty, target).await.unwrap_or(false);
    }

    let commands = jump_commands(client_tty, target, false);
    tmux.run_silent(&commands[0]).await
}

#[cfg(test)]
mod tests {
    use crate::app::{ActionOutcome, JumpTarget};
    use crate::tmux_exec::TmuxExec;

    use super::{execute_jump, jump_commands, kill_pane, send_text};

    fn real_tmux() -> std::path::PathBuf {
        std::env::var_os("TMUX_BIN")
            .unwrap_or_else(|| "tmux".into())
            .into()
    }

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(ToString::to_string).collect()
    }

    #[test]
    fn builds_pane_jump_with_client_and_zoom_preservation() {
        assert_eq!(
            jump_commands("/dev/ttys001", &JumpTarget::Pane("%42".into()), false),
            vec![args(&[
                "switch-client",
                "-Z",
                "-c",
                "/dev/ttys001",
                "-t",
                "%42"
            ])]
        );
    }

    #[test]
    fn builds_zoom_then_pane_jump_as_two_commands() {
        assert_eq!(
            jump_commands("/dev/ttys001", &JumpTarget::Pane("%42".into()), true),
            vec![
                args(&["resize-pane", "-Z", "-t", "%42"]),
                args(&["switch-client", "-Z", "-c", "/dev/ttys001", "-t", "%42"]),
            ]
        );
    }

    #[test]
    fn builds_session_jump_without_zoom_flag() {
        assert_eq!(
            jump_commands("/dev/ttys001", &JumpTarget::Session("$3".into()), true),
            vec![args(&["switch-client", "-c", "/dev/ttys001", "-t", "$3"])]
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unsafe_client_tty_does_not_run_one_shot_jump() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        use tempfile::TempDir;

        let dir = TempDir::new().unwrap();
        let invoked = dir.path().join("invoked");
        let fake = dir.path().join("fake-tmux");
        fs::write(&fake, format!("#!/bin/sh\ntouch '{}'", invoked.display())).unwrap();
        fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).unwrap();

        assert!(
            !execute_jump(
                &TmuxExec::new(&fake),
                None,
                "/dev/tty:1",
                &JumpTarget::Pane("%42".into()),
                false,
            )
            .await
        );
        assert!(!invoked.exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn kill_pane_runs_one_exact_argv_without_a_precheck_or_shell() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        use tempfile::TempDir;

        let dir = TempDir::new().unwrap();
        let log = dir.path().join("log");
        let fake = dir.path().join("fake-tmux");
        fs::write(
            &fake,
            format!("#!/bin/sh\nprintf '<%s>\\n' \"$@\" >> '{}'", log.display()),
        )
        .unwrap();
        fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).unwrap();

        assert_eq!(
            kill_pane(
                &TmuxExec::new(&fake),
                &crate::model::PaneId::from("%42; touch pwned")
            )
            .await,
            ActionOutcome::Success
        );
        assert_eq!(
            fs::read_to_string(log).unwrap(),
            "<kill-pane>\n<-t>\n<%42; touch pwned>\n"
        );
        assert!(!dir.path().join("pwned").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn kill_pane_maps_every_tmux_failure_to_vanished() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        use tempfile::TempDir;

        let dir = TempDir::new().unwrap();
        let fake = dir.path().join("fake-tmux");
        fs::write(&fake, "#!/bin/sh\nexit 1").unwrap();
        fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).unwrap();

        assert_eq!(
            kill_pane(&TmuxExec::new(&fake), &crate::model::PaneId::from("%42")).await,
            ActionOutcome::Vanished
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn send_text_prechecks_then_delivers_literal_argv_and_enter() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        use tempfile::TempDir;

        let dir = TempDir::new().unwrap();
        let log = dir.path().join("log");
        let fake = dir.path().join("fake-tmux");
        fs::write(
            &fake,
            format!(
                "#!/bin/sh\nprintf '<%s>\\n' \"$@\" >> '{}'\nif [ \"$1\" = display-message ]; then printf '%%42\\r\\n'; fi",
                log.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).unwrap();

        let outcome = send_text(
            &TmuxExec::new(&fake),
            &crate::model::PaneId::from("%42"),
            "spaces 'quotes' x; kill-server #[x] \\ newline\nユニコード -leading;",
        )
        .await;

        assert_eq!(outcome, ActionOutcome::Success);
        assert_eq!(
            fs::read_to_string(log).unwrap(),
            "<display-message>\n<-p>\n<-t>\n<%42>\n<#{pane_id}>\n<send-keys>\n<-l>\n<-t>\n<%42>\n<-->\n<spaces 'quotes' x; kill-server #[x] \\ newline\nユニコード -leading\\;>\n<send-keys>\n<-t>\n<%42>\n<Enter>\n"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn failed_literal_send_does_not_invoke_enter_and_nul_stops_after_precheck() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        use tempfile::TempDir;

        let dir = TempDir::new().unwrap();
        let log = dir.path().join("log");
        let fake = dir.path().join("fake-tmux");
        fs::write(
            &fake,
            format!(
                "#!/bin/sh\nprintf '<%s>\\n' \"$@\" >> '{}'\nif [ \"$1\" = display-message ]; then printf '%%42'; else exit 1; fi",
                log.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).unwrap();
        let tmux = TmuxExec::new(&fake);

        assert_eq!(
            send_text(&tmux, &crate::model::PaneId::from("%42"), "text").await,
            ActionOutcome::Vanished
        );
        assert_eq!(
            fs::read_to_string(&log).unwrap(),
            "<display-message>\n<-p>\n<-t>\n<%42>\n<#{pane_id}>\n<send-keys>\n<-l>\n<-t>\n<%42>\n<-->\n<text>\n"
        );

        fs::write(&log, "").unwrap();
        assert!(matches!(
            send_text(&tmux, &crate::model::PaneId::from("%42"), "bad\0text").await,
            ActionOutcome::Failed(_)
        ));
        assert_eq!(
            fs::read_to_string(log).unwrap(),
            "<display-message>\n<-p>\n<-t>\n<%42>\n<#{pane_id}>\n"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn send_text_rejects_nul_and_maps_missing_or_failed_targets_to_vanished() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        use tempfile::TempDir;

        let dir = TempDir::new().unwrap();
        let fake = dir.path().join("fake-tmux");
        fs::write(
            &fake,
            "#!/bin/sh\nif [ \"$1\" = display-message ]; then printf '%s' '%42'; else exit 1; fi",
        )
        .unwrap();
        fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).unwrap();
        let tmux = TmuxExec::new(&fake);

        assert!(matches!(
            send_text(&tmux, &crate::model::PaneId::from("%42"), "ok").await,
            ActionOutcome::Vanished
        ));
        assert!(matches!(
            send_text(&tmux, &crate::model::PaneId::from("%42"), "bad\0text").await,
            ActionOutcome::Failed(_)
        ));

        fs::write(
            &fake,
            "#!/bin/sh\nif [ \"$1\" = display-message ]; then printf '%s' '%other'; else exit 1; fi",
        )
        .unwrap();
        assert!(matches!(
            send_text(&tmux, &crate::model::PaneId::from("%42"), "ok").await,
            ActionOutcome::Vanished
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    #[ignore = "requires tmux >=3.6"]
    async fn real_tmux_send_text_roundtrips_hostile_literal_without_killing_server() {
        use std::os::unix::fs::PermissionsExt;
        use std::process::Command;

        struct ScratchServer(std::path::PathBuf);
        impl Drop for ScratchServer {
            fn drop(&mut self) {
                let _ = Command::new(real_tmux())
                    .arg("-S")
                    .arg(&self.0)
                    .arg("kill-server")
                    .output();
            }
        }

        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("socket");
        let _ = Command::new(real_tmux())
            .arg("-S")
            .arg(&socket)
            .arg("kill-server")
            .output();
        let _server = ScratchServer(socket.clone());
        assert!(
            Command::new(real_tmux())
                .arg("-S")
                .arg(&socket)
                .args(["-f", "/dev/null", "new-session", "-d", "-s", "send", "cat"])
                .status()
                .unwrap()
                .success()
        );
        let wrapper = dir.path().join("tmux-send");
        std::fs::write(
            &wrapper,
            format!(
                "#!/bin/sh\nexec {} -S '{}' \"$@\"\n",
                real_tmux().display(),
                socket.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
        let tmux = TmuxExec::new(&wrapper);
        let pane_id = crate::model::PaneId::from(
            String::from_utf8(
                Command::new(real_tmux())
                    .arg("-S")
                    .arg(&socket)
                    .args(["display-message", "-p", "-t", "send:0.0", "#{pane_id}"])
                    .output()
                    .unwrap()
                    .stdout,
            )
            .unwrap()
            .trim(),
        );
        let text = "x; kill-server #[literal] \\ newline\nユニコード";

        assert_eq!(
            send_text(&tmux, &pane_id, text).await,
            ActionOutcome::Success
        );
        let captured = tmux.capture_pane(&pane_id).await.unwrap();
        assert!(String::from_utf8_lossy(&captured).contains(text));
        assert!(
            Command::new(real_tmux())
                .arg("-S")
                .arg(&socket)
                .args(["has-session", "-t", "send"])
                .status()
                .unwrap()
                .success()
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    #[ignore = "requires tmux"]
    async fn real_tmux_kill_pane_removes_the_target_from_an_isolated_server() {
        use std::os::unix::fs::PermissionsExt;
        use std::process::Command;

        struct ScratchServer(std::path::PathBuf);
        impl Drop for ScratchServer {
            fn drop(&mut self) {
                let _ = Command::new(real_tmux())
                    .arg("-S")
                    .arg(&self.0)
                    .arg("kill-server")
                    .output();
            }
        }

        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("socket");
        let _server = ScratchServer(socket.clone());
        assert!(
            Command::new(real_tmux())
                .arg("-S")
                .arg(&socket)
                .args([
                    "-f",
                    "/dev/null",
                    "new-session",
                    "-d",
                    "-s",
                    "kill",
                    "sleep 60"
                ])
                .status()
                .unwrap()
                .success()
        );
        assert!(
            Command::new(real_tmux())
                .arg("-S")
                .arg(&socket)
                .args(["split-window", "-d", "-t", "kill:0", "sleep 60"])
                .status()
                .unwrap()
                .success()
        );
        let pane_id = String::from_utf8(
            Command::new(real_tmux())
                .arg("-S")
                .arg(&socket)
                .args(["display-message", "-p", "-t", "kill:0.1", "#{pane_id}"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap();
        let pane_id = crate::model::PaneId::from(pane_id.trim());
        let wrapper = dir.path().join("tmux-kill");
        std::fs::write(
            &wrapper,
            format!(
                "#!/bin/sh\nexec {} -S '{}' \"$@\"\n",
                real_tmux().display(),
                socket.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();

        assert_eq!(
            kill_pane(&TmuxExec::new(wrapper), &pane_id).await,
            ActionOutcome::Success
        );
        let remaining = String::from_utf8(
            Command::new(real_tmux())
                .arg("-S")
                .arg(&socket)
                .args(["list-panes", "-a", "-F", "#{pane_id}"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap();
        assert!(!remaining.lines().any(|id| id == pane_id.0));
    }

    #[cfg(unix)]
    #[tokio::test]
    #[ignore = "requires tmux"]
    async fn real_tmux_pane_disappearing_between_zoom_and_jump_is_silent() {
        use std::os::unix::fs::PermissionsExt;
        use std::process::Command;

        struct ScratchServer(std::path::PathBuf);
        impl Drop for ScratchServer {
            fn drop(&mut self) {
                let _ = Command::new(real_tmux())
                    .arg("-S")
                    .arg(&self.0)
                    .arg("kill-server")
                    .output();
            }
        }

        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("socket");
        let _server = ScratchServer(socket.clone());
        assert!(
            Command::new(real_tmux())
                .arg("-S")
                .arg(&socket)
                .args([
                    "-f",
                    "/dev/null",
                    "new-session",
                    "-d",
                    "-s",
                    "jump",
                    "sleep 60"
                ])
                .status()
                .unwrap()
                .success()
        );
        assert!(
            Command::new(real_tmux())
                .arg("-S")
                .arg(&socket)
                .args(["split-window", "-d", "-t", "jump:0", "sleep 60"])
                .status()
                .unwrap()
                .success()
        );
        let pane_id = String::from_utf8(
            Command::new(real_tmux())
                .arg("-S")
                .arg(&socket)
                .args(["display-message", "-p", "-t", "jump:0.1", "#{pane_id}"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap();
        let pane_id = crate::model::PaneId::from(pane_id.trim());
        let wrapper = dir.path().join("tmux-race");
        std::fs::write(
            &wrapper,
            format!(
                "#!/bin/sh\nif [ \"$1\" = resize-pane ]; then\n  {tmux} -S '{socket}' \"$@\" || exit $?\n  {tmux} -S '{socket}' kill-pane -t \"$4\"\n  exit $?\nfi\nexec {tmux} -S '{socket}' \"$@\"\n",
                tmux = real_tmux().display(),
                socket = socket.display(),
            ),
        )
        .unwrap();
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();

        assert!(
            !execute_jump(
                &TmuxExec::new(wrapper),
                None,
                "/dev/tty1",
                &JumpTarget::Pane(pane_id.clone()),
                true,
            )
            .await
        );
        let remaining = String::from_utf8(
            Command::new(real_tmux())
                .arg("-S")
                .arg(&socket)
                .args(["list-panes", "-a", "-F", "#{pane_id}"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap();
        assert!(!remaining.lines().any(|id| id == pane_id.0));
    }

    #[cfg(unix)]
    mod unix {
        use std::{fs, os::unix::fs::PermissionsExt, path::Path};

        use tempfile::TempDir;
        use tokio::time::{Duration, timeout};

        use crate::{
            control::{ControlEvent, connect_control},
            tmux_exec::TmuxExec,
        };

        use super::*;

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

        fn control_fake(log: &Path, response: &str) -> String {
            format!(
                "if [ \"$1\" = -C ]; then\n  printf '%s\\n' '%begin 1 1 1' '%end 1 1 1'\n  while IFS= read -r command; do\n    printf 'control\\n%s\\n' \"$command\" >> '{}'\n    printf '%%begin 2 2 1\\n%%{response} 2 2 1\\n'\n  done\nelse\n  printf 'one\\n' >> '{}'\n  printf '%s\\n' \"$@\" >> '{}'\nfi",
                log.display(),
                log.display(),
                log.display(),
            )
        }

        #[tokio::test]
        async fn control_jump_returns_true_for_end_and_false_for_error() {
            for (response, expected) in [("end", true), ("error", false)] {
                let dir = TempDir::new().unwrap();
                let log = dir.path().join("log");
                let fake = fake_tmux(&dir, &control_fake(&log, response));
                let tmux = TmuxExec::new(&fake);
                let (control, _events) = connect_control(&fake, "$7").await.unwrap();

                assert_eq!(
                    execute_jump(
                        &tmux,
                        Some(&control),
                        "/dev/ttys001",
                        &JumpTarget::Pane("%42".into()),
                        false,
                    )
                    .await,
                    expected
                );
                assert_eq!(
                    marker(&log).await,
                    "control\nswitch-client -Z -c /dev/ttys001 -t %42\n"
                );
            }
        }

        #[tokio::test]
        async fn terminated_control_returns_false_without_a_jump() {
            let dir = TempDir::new().unwrap();
            let fake = fake_tmux(&dir, "printf '%s\\n' '%begin 1 1 1' '%end 1 1 1' '%exit'");
            let tmux = TmuxExec::new(&fake);
            let (control, mut events) = connect_control(&fake, "$7").await.unwrap();

            assert!(matches!(
                timeout(Duration::from_secs(2), events.recv())
                    .await
                    .unwrap(),
                Some(ControlEvent::Terminated(_))
            ));
            assert!(
                !execute_jump(
                    &tmux,
                    Some(&control),
                    "/dev/ttys001",
                    &JumpTarget::Pane("%42".into()),
                    false,
                )
                .await
            );
        }

        #[tokio::test]
        async fn zoomed_pane_resizes_before_a_successful_control_jump() {
            let dir = TempDir::new().unwrap();
            let log = dir.path().join("log");
            let fake = fake_tmux(&dir, &control_fake(&log, "end"));
            let tmux = TmuxExec::new(&fake);
            let (control, _events) = connect_control(&fake, "$7").await.unwrap();

            assert!(
                execute_jump(
                    &tmux,
                    Some(&control),
                    "/dev/ttys001",
                    &JumpTarget::Pane("%42".into()),
                    true,
                )
                .await
            );
            assert_eq!(
                marker(&log).await,
                "one\nresize-pane\n-Z\n-t\n%42\ncontrol\nswitch-client -Z -c /dev/ttys001 -t %42\n"
            );
        }

        #[tokio::test]
        async fn failed_pane_resize_does_not_send_a_control_jump() {
            let dir = TempDir::new().unwrap();
            let log = dir.path().join("log");
            let fake = fake_tmux(
                &dir,
                &format!(
                    "if [ \"$1\" = -C ]; then\n  printf '%s\\n' '%begin 1 1 1' '%end 1 1 1'\n  while IFS= read -r command; do printf 'control\\n%s\\n' \"$command\" >> '{}'; done\nelse\n  printf 'one\\n' >> '{}'\n  printf '%s\\n' \"$@\" >> '{}'\n  exit 1\nfi",
                    log.display(),
                    log.display(),
                    log.display(),
                ),
            );
            let tmux = TmuxExec::new(&fake);
            let (control, _events) = connect_control(&fake, "$7").await.unwrap();

            assert!(
                !execute_jump(
                    &tmux,
                    Some(&control),
                    "/dev/ttys001",
                    &JumpTarget::Pane("%42".into()),
                    true,
                )
                .await
            );
            assert_eq!(marker(&log).await, "one\nresize-pane\n-Z\n-t\n%42\n");
        }

        #[tokio::test]
        async fn degraded_pane_jump_uses_one_fixed_id_switch_and_propagates_exit_status() {
            for (exit_status, expected) in [(0, true), (1, false)] {
                let dir = TempDir::new().unwrap();
                let log = dir.path().join("log");
                let fake = fake_tmux(
                    &dir,
                    &format!(
                        "printf '%s\\n' \"$@\" > '{}'\nexit {exit_status}",
                        log.display()
                    ),
                );
                let tmux = TmuxExec::new(&fake);

                assert_eq!(
                    execute_jump(
                        &tmux,
                        None,
                        "/dev/ttys001",
                        &JumpTarget::Pane("%42".into()),
                        false,
                    )
                    .await,
                    expected
                );
                assert_eq!(
                    marker(&log).await,
                    "switch-client\n-Z\n-c\n/dev/ttys001\n-t\n%42\n"
                );
            }
        }

        #[tokio::test]
        async fn degraded_zoomed_pane_resizes_then_switches_while_session_only_switches() {
            let dir = TempDir::new().unwrap();
            let log = dir.path().join("log");
            let fake = fake_tmux(
                &dir,
                &format!(
                    "printf '%s ' \"$@\" >> '{}'\nprintf '\\n' >> '{}'",
                    log.display(),
                    log.display()
                ),
            );
            let tmux = TmuxExec::new(&fake);

            assert!(
                execute_jump(
                    &tmux,
                    None,
                    "/dev/ttys001",
                    &JumpTarget::Pane("%42".into()),
                    true,
                )
                .await
            );
            assert!(
                execute_jump(
                    &tmux,
                    None,
                    "/dev/ttys001",
                    &JumpTarget::Session("$7".into()),
                    true,
                )
                .await
            );
            assert_eq!(
                marker(&log).await,
                "resize-pane -Z -t %42 \nswitch-client -Z -c /dev/ttys001 -t %42 \nswitch-client -c /dev/ttys001 -t $7 \n"
            );
        }

        #[tokio::test]
        async fn degraded_jump_passes_malicious_looking_values_as_single_arguments() {
            let dir = TempDir::new().unwrap();
            let log = dir.path().join("log");
            let fake = fake_tmux(
                &dir,
                &format!("printf '<%s>\\n' \"$@\" > '{}'", log.display()),
            );
            let tmux = TmuxExec::new(&fake);

            assert!(
                execute_jump(
                    &tmux,
                    None,
                    "/dev/tty1",
                    &JumpTarget::Pane("%42;touch-pwned".into()),
                    false,
                )
                .await
            );
            assert_eq!(
                marker(&log).await,
                "<switch-client>\n<-Z>\n<-c>\n</dev/tty1>\n<-t>\n<%42;touch-pwned>\n"
            );
            assert!(!dir.path().join("pwned").exists());
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    #[ignore = "requires tmux"]
    async fn real_tmux_missing_target_is_a_silent_unsuccessful_jump() {
        use std::os::unix::fs::PermissionsExt;
        use std::process::Command;

        struct ScratchServer(std::path::PathBuf);
        impl Drop for ScratchServer {
            fn drop(&mut self) {
                let _ = Command::new(real_tmux())
                    .arg("-S")
                    .arg(&self.0)
                    .arg("kill-server")
                    .output();
            }
        }

        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("socket");
        let _server = ScratchServer(socket.clone());
        assert!(
            Command::new(real_tmux())
                .arg("-S")
                .arg(&socket)
                .args([
                    "-f",
                    "/dev/null",
                    "new-session",
                    "-d",
                    "-s",
                    "jump",
                    "sleep 60"
                ])
                .status()
                .unwrap()
                .success()
        );

        let log = dir.path().join("argv");
        let wrapper = dir.path().join("tmux-jump");
        std::fs::write(
            &wrapper,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\nexec {} -S '{}' \"$@\"\n",
                log.display(),
                real_tmux().display(),
                socket.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();

        let tmux = crate::tmux_exec::TmuxExec::new(wrapper);
        assert!(
            !super::execute_jump(
                &tmux,
                None,
                "/dev/tty999999",
                &JumpTarget::Pane("%999999".into()),
                false,
            )
            .await
        );
        assert_eq!(
            std::fs::read_to_string(log).unwrap(),
            "switch-client\n-Z\n-c\n/dev/tty999999\n-t\n%999999\n"
        );
    }
}
