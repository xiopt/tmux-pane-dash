use crate::app::JumpTarget;
use crate::control::ControlHandle;
use crate::tmux_exec::TmuxExec;

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
    use crate::app::JumpTarget;

    use super::{execute_jump, jump_commands};

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
                    "/dev/tty;touch-pwned",
                    &JumpTarget::Pane("%42;touch-pwned".into()),
                    false,
                )
                .await
            );
            assert_eq!(
                marker(&log).await,
                "<switch-client>\n<-Z>\n<-c>\n</dev/tty;touch-pwned>\n<-t>\n<%42;touch-pwned>\n"
            );
            assert!(!dir.path().join("pwned").exists());
        }
    }

    #[tokio::test]
    #[ignore = "requires tmux"]
    async fn vanished_target_is_a_silent_unsuccessful_jump() {
        let tmux = crate::tmux_exec::TmuxExec::new("tmux");
        assert!(
            !super::execute_jump(
                &tmux,
                None,
                "/definitely-not-a-tmux-client",
                &JumpTarget::Pane("%999999".into()),
                false,
            )
            .await
        );
    }
}
