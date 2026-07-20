use crate::app::JumpTarget;
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
    client_tty: &str,
    target: &JumpTarget,
    zoom: bool,
) -> bool {
    for command in jump_commands(client_tty, target, zoom) {
        if !tmux.run_silent(&command).await {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use crate::app::JumpTarget;

    use super::jump_commands;

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

    #[tokio::test]
    #[ignore = "requires tmux"]
    async fn vanished_target_is_a_silent_unsuccessful_jump() {
        let tmux = crate::tmux_exec::TmuxExec::new("tmux");
        assert!(
            !super::execute_jump(
                &tmux,
                "/definitely-not-a-tmux-client",
                &JumpTarget::Pane("%999999".into()),
                false,
            )
            .await
        );
    }
}
