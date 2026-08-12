use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

use crate::model::{PaneId, SessionId};
use crate::tmux_arg::{self, Field};
use crate::tmux_exec::{TmuxCommandError, TmuxExec};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct CreationId(pub u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SplitDirection {
    Right,
    Left,
    Bottom,
    Top,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CreateStage {
    Create,
    Tag,
    SendCommand,
    SendEnter,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CreationResolution {
    Success,
    TagFailed(String),
    CommandFailed { stage: CreateStage, error: String },
    TimedOut { stage: CreateStage },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CreationProgress {
    Stage {
        id: CreationId,
        stage: CreateStage,
        pane_id: Option<PaneId>,
    },
    CreateFailed {
        id: CreationId,
        error: String,
    },
    Created {
        id: CreationId,
        pane_id: PaneId,
    },
    Finished {
        id: CreationId,
        pane_id: PaneId,
        resolution: CreationResolution,
    },
    TimedOut {
        id: CreationId,
    },
    TaskFailed {
        id: CreationId,
        error: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CreateContext {
    Split {
        target: PaneId,
        initiating_session: SessionId,
        linked_session_count: usize,
        direction: SplitDirection,
    },
    NewWindow {
        target: SessionId,
    },
    NewSession,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateDraft {
    pub name: String,
    pub cwd: String,
    pub command: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CreationField {
    Name,
    Cwd,
    Command,
}

impl std::fmt::Display for CreationField {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Name => "name",
            Self::Cwd => "cwd",
            Self::Command => "command",
        })
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CreationError {
    #[error("{field} is invalid: {reason}")]
    Field {
        field: CreationField,
        reason: String,
    },
    #[error("invalid tmux {kind} target: {value}")]
    InvalidTarget { kind: &'static str, value: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedCwd(PathBuf);

impl ValidatedCwd {
    pub fn new(path: PathBuf) -> Result<Self, CreationError> {
        validate_cwd(&path)?;
        Ok(Self(path))
    }

    pub fn as_path(&self) -> &Path {
        &self.0
    }

    pub fn revalidate(&self) -> Result<(), CreationError> {
        validate_cwd(&self.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateRequest {
    pub context: CreateContext,
    pub argv: Vec<String>,
    pub cwd: Option<ValidatedCwd>,
    pub command: Option<String>,
}

pub fn attach_command(source_url: &str, directory: &str, session_id: &str) -> String {
    format!(
        "exec opencode attach {} --dir {} --session {}",
        shell_single_quote(source_url),
        shell_single_quote(directory),
        shell_single_quote(session_id),
    )
}

fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

pub const CREATION_TIMEOUT: Duration = Duration::from_secs(10);

pub async fn run_creation(
    tmux: TmuxExec,
    id: CreationId,
    request: CreateRequest,
    progress: mpsc::UnboundedSender<CreationProgress>,
    mut cancellation: oneshot::Receiver<()>,
) {
    run_creation_until(
        tmux,
        id,
        request,
        progress,
        Instant::now() + CREATION_TIMEOUT,
        &mut cancellation,
    )
    .await;
}

async fn run_creation_until(
    tmux: TmuxExec,
    id: CreationId,
    request: CreateRequest,
    progress: mpsc::UnboundedSender<CreationProgress>,
    deadline: Instant,
    cancellation: &mut oneshot::Receiver<()>,
) {
    let send = |event| {
        let _ = progress.send(event);
    };
    send(CreationProgress::Stage {
        id,
        stage: CreateStage::Create,
        pane_id: None,
    });
    let output = match tmux
        .run_argv_until(&request.argv, request.cwd.as_ref(), deadline, cancellation)
        .await
    {
        Ok(output) => output,
        Err(TmuxCommandError::TimedOut { stdout }) => {
            let Ok(pane_id) = parse_pane_id(&stdout) else {
                send(CreationProgress::TimedOut { id });
                return;
            };
            send(CreationProgress::Created {
                id,
                pane_id: pane_id.clone(),
            });
            send(CreationProgress::Finished {
                id,
                pane_id,
                resolution: CreationResolution::TimedOut {
                    stage: CreateStage::Create,
                },
            });
            return;
        }
        Err(TmuxCommandError::Cancelled) => {
            send(CreationProgress::TimedOut { id });
            return;
        }
        Err(error) => {
            send(CreationProgress::CreateFailed {
                id,
                error: error.to_string(),
            });
            return;
        }
    };
    let pane_id = match parse_pane_id(&output) {
        Ok(pane_id) => pane_id,
        Err(error) => {
            send(CreationProgress::CreateFailed { id, error });
            return;
        }
    };
    send(CreationProgress::Created {
        id,
        pane_id: pane_id.clone(),
    });
    send(CreationProgress::Stage {
        id,
        stage: CreateStage::Tag,
        pane_id: Some(pane_id.clone()),
    });
    let tag = vec![
        "set-option".into(),
        "-p".into(),
        "-t".into(),
        pane_id.0.clone(),
        "@pane_dash_tag".into(),
        "dash-created".into(),
    ];
    match tmux
        .run_argv_until(&tag, None, deadline, cancellation)
        .await
    {
        Ok(_) => {}
        Err(TmuxCommandError::TimedOut { .. } | TmuxCommandError::Cancelled) => {
            send(CreationProgress::TimedOut { id });
            return;
        }
        Err(error) => {
            send(CreationProgress::Finished {
                id,
                pane_id,
                resolution: CreationResolution::TagFailed(error.to_string()),
            });
            return;
        }
    }
    let Some(command) = request.command else {
        send(CreationProgress::Finished {
            id,
            pane_id,
            resolution: CreationResolution::Success,
        });
        return;
    };
    send(CreationProgress::Stage {
        id,
        stage: CreateStage::SendCommand,
        pane_id: Some(pane_id.clone()),
    });
    let send_command = vec![
        "send-keys".into(),
        "-l".into(),
        "-t".into(),
        pane_id.0.clone(),
        "--".into(),
        command,
    ];
    if let Err(error) = tmux
        .run_argv_until(&send_command, None, deadline, cancellation)
        .await
    {
        let resolution = match error {
            TmuxCommandError::TimedOut { .. } | TmuxCommandError::Cancelled => {
                send(CreationProgress::TimedOut { id });
                return;
            }
            error => CreationResolution::CommandFailed {
                stage: CreateStage::SendCommand,
                error: error.to_string(),
            },
        };
        send(CreationProgress::Finished {
            id,
            pane_id,
            resolution,
        });
        return;
    }
    send(CreationProgress::Stage {
        id,
        stage: CreateStage::SendEnter,
        pane_id: Some(pane_id.clone()),
    });
    let enter = vec![
        "send-keys".into(),
        "-t".into(),
        pane_id.0.clone(),
        "Enter".into(),
    ];
    let resolution = match tmux
        .run_argv_until(&enter, None, deadline, cancellation)
        .await
    {
        Ok(_) => CreationResolution::Success,
        Err(TmuxCommandError::TimedOut { .. } | TmuxCommandError::Cancelled) => {
            send(CreationProgress::TimedOut { id });
            return;
        }
        Err(error) => CreationResolution::CommandFailed {
            stage: CreateStage::SendEnter,
            error: error.to_string(),
        },
    };
    send(CreationProgress::Finished {
        id,
        pane_id,
        resolution,
    });
}

fn parse_pane_id(output: &[u8]) -> Result<PaneId, String> {
    let value =
        std::str::from_utf8(output).map_err(|_| "create returned non-UTF-8 pane ID".to_owned())?;
    let value = value.strip_suffix('\n').unwrap_or(value);
    if value.starts_with('%')
        && value.len() > 1
        && value[1..].bytes().all(|byte| byte.is_ascii_digit())
    {
        Ok(PaneId::from(value))
    } else {
        Err("create returned an invalid pane ID".to_owned())
    }
}

pub fn build_request(
    context: CreateContext,
    draft: &CreateDraft,
) -> Result<CreateRequest, CreationError> {
    let cwd = if draft.cwd.is_empty() {
        None
    } else {
        Some(ValidatedCwd::new(PathBuf::from(&draft.cwd))?)
    };
    let command = optional_command(&draft.command)?;

    let argv = match &context {
        CreateContext::NewSession => {
            let mut argv = argv(["new-session", "-d", "-P", "-F", "#{pane_id}"]);
            if let Some(name) = optional_name(&draft.name)? {
                argv.extend(["-s".into(), name]);
            }
            argv
        }
        CreateContext::NewWindow { target } => {
            validate_target("session", &target.0, '$')?;
            let mut argv = argv([
                "new-window",
                "-d",
                "-P",
                "-F",
                "#{pane_id}",
                "-t",
                &target.0,
            ]);
            if let Some(name) = optional_name(&draft.name)? {
                argv.extend(["-n".into(), name]);
            }
            argv
        }
        CreateContext::Split {
            target, direction, ..
        } => {
            validate_target("pane", &target.0, '%')?;
            let mut argv = argv(["split-window", "-d", "-P", "-F", "#{pane_id}"]);
            argv.extend(
                match direction {
                    SplitDirection::Right => ["-h"].as_slice(),
                    SplitDirection::Left => ["-b", "-h"].as_slice(),
                    SplitDirection::Bottom => ["-v"].as_slice(),
                    SplitDirection::Top => ["-b", "-v"].as_slice(),
                }
                .iter()
                .map(|flag| (*flag).to_owned()),
            );
            argv.extend(["-t".into(), target.0.clone()]);
            argv
        }
    };

    Ok(CreateRequest {
        context,
        argv,
        cwd,
        command,
    })
}

pub fn display_error(raw: &str) -> String {
    const MAX_SCALARS: usize = 512;

    let mut display = String::new();
    let mut scalar_count = 0;
    for character in raw.chars() {
        let visible = if character.is_control() {
            format!("\\u{{{:x}}}", character as u32)
        } else {
            character.to_string()
        };
        let visible_scalars = visible.chars().count();
        if scalar_count + visible_scalars > MAX_SCALARS {
            break;
        }
        display.push_str(&visible);
        scalar_count += visible_scalars;
    }
    display
}

fn argv<const N: usize>(arguments: [&str; N]) -> Vec<String> {
    arguments.into_iter().map(str::to_owned).collect()
}

fn optional_name(value: &str) -> Result<Option<String>, CreationError> {
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    tmux_arg::encode(value, Field::Expanded)
        .map(Some)
        .map_err(|error| CreationError::Field {
            field: CreationField::Name,
            reason: error.to_string(),
        })
}

fn optional_command(value: &str) -> Result<Option<String>, CreationError> {
    if value.is_empty() {
        return Ok(None);
    }
    tmux_arg::encode(value, Field::Plain)
        .map(Some)
        .map_err(|error| CreationError::Field {
            field: CreationField::Command,
            reason: error.to_string(),
        })
}

fn validate_cwd(path: &Path) -> Result<(), CreationError> {
    if path
        .as_os_str()
        .to_string_lossy()
        .chars()
        .any(|character| matches!(character as u32, 0x00..=0x1f))
    {
        return Err(CreationError::Field {
            field: CreationField::Cwd,
            reason: "contains C0 control bytes".into(),
        });
    }
    Ok(())
}

fn validate_target(kind: &'static str, value: &str, prefix: char) -> Result<(), CreationError> {
    if value.starts_with(prefix)
        && value.len() > prefix.len_utf8()
        && value[1..].bytes().all(|byte| byte.is_ascii_digit())
    {
        return Ok(());
    }
    Err(CreationError::InvalidTarget {
        kind,
        value: value.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    use std::time::Duration;

    use super::{
        CreateContext, CreateDraft, CreateStage, CreationError, CreationField, CreationId,
        CreationProgress, CreationResolution, SplitDirection, ValidatedCwd, attach_command,
        build_request, display_error, run_creation, run_creation_until,
    };
    use crate::model::{PaneId, SessionId};
    use crate::tmux_exec::TmuxExec;
    use tokio::time::Instant;

    fn draft(name: &str, cwd: &str, command: &str) -> CreateDraft {
        CreateDraft {
            name: name.into(),
            cwd: cwd.into(),
            command: command.into(),
        }
    }

    #[test]
    fn attach_command_single_quotes_every_exact_hostile_value() {
        assert_eq!(
            attach_command(
                "http://127.0.0.1:53550/a'b;$(touch nope)",
                "/work/a b/'quoted';$(touch nope)",
                "ses_'x;$(touch nope)",
            ),
            "exec opencode attach 'http://127.0.0.1:53550/a'\"'\"'b;$(touch nope)' --dir '/work/a b/'\"'\"'quoted'\"'\"';$(touch nope)' --session 'ses_'\"'\"'x;$(touch nope)'"
        );
        assert_eq!(
            attach_command("", "", ""),
            "exec opencode attach '' --dir '' --session ''"
        );
    }

    fn split(direction: SplitDirection) -> CreateContext {
        CreateContext::Split {
            target: PaneId::from("%7"),
            initiating_session: SessionId::from("$3"),
            linked_session_count: 2,
            direction,
        }
    }

    fn fake_workflow_tmux(
        dir: &tempfile::TempDir,
        fail_at: Option<usize>,
    ) -> (TmuxExec, std::path::PathBuf) {
        let log = dir.path().join("argv.log");
        let count = dir.path().join("invocation-count");
        let executable = dir.path().join("fake-tmux");
        let fail = fail_at.map_or(0, |value| value);
        fs::write(
            &executable,
            format!(
                "#!/bin/sh\ncount=0\nif [ -f '{count}' ]; then count=$(cat '{count}'); fi\ncount=$((count + 1))\nprintf '%s' \"$count\" > '{count}'\nprintf '%s\\t' \"$@\" >> '{log}'\nprintf '\\n' >> '{log}'\nif [ \"$count\" -eq {fail} ]; then echo \"failure-$count\" >&2; exit 17; fi\nif [ \"$1\" = new-session ]; then printf '%%44\\n'; fi\n",
                count = count.display(),
                log = log.display(),
            ),
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        (TmuxExec::new(executable), log)
    }

    fn logged_argv(log: &Path) -> Vec<Vec<String>> {
        fs::read_to_string(log)
            .unwrap_or_default()
            .lines()
            .map(|line| {
                line.strip_suffix('\t')
                    .expect("fake tmux records a trailing argument delimiter")
                    .split('\t')
                    .map(str::to_owned)
                    .collect()
            })
            .collect()
    }

    async fn run_workflow(
        tmux: TmuxExec,
        request: super::CreateRequest,
    ) -> Vec<super::CreationProgress> {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let (_cancel, cancellation) = tokio::sync::oneshot::channel();
        run_creation(tmux, super::CreationId(99), request, tx, cancellation).await;
        std::iter::from_fn(|| rx.try_recv().ok()).collect()
    }

    async fn run_timed_out_stage_one(
        payload: &[u8],
        cancel_after_output: bool,
    ) -> (Vec<CreationProgress>, Vec<Vec<String>>) {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("argv.log");
        let marker = dir.path().join("output-written");
        let executable = dir.path().join("fake-tmux");
        let escaped_payload = payload
            .iter()
            .map(|byte| format!("\\{byte:03o}"))
            .collect::<String>();
        fs::write(
            &executable,
            format!(
                "#!/bin/sh\nprintf '%s\\t' \"$@\" >> '{log}'\nprintf '\\n' >> '{log}'\nprintf '{escaped_payload}'\ntouch '{marker}'\nwhile :; do sleep 1; done\n",
                log = log.display(),
                marker = marker.display(),
            ),
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();

        let request = build_request(CreateContext::NewSession, &draft("", "", "echo hi")).unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let (cancel, mut cancellation) = tokio::sync::oneshot::channel();
        let workflow = run_creation_until(
            TmuxExec::new(executable),
            CreationId(99),
            request,
            tx,
            Instant::now() + Duration::from_millis(250),
            &mut cancellation,
        );

        if cancel_after_output {
            let cancel_when_output_written = async move {
                while !marker.exists() {
                    tokio::task::yield_now().await;
                }
                cancel.send(()).unwrap();
            };
            tokio::join!(workflow, cancel_when_output_written);
        } else {
            workflow.await;
        }

        (
            std::iter::from_fn(|| rx.try_recv().ok()).collect(),
            logged_argv(&log),
        )
    }

    #[test]
    fn builds_exact_new_session_argv_with_trimmed_name() {
        let request = build_request(
            CreateContext::NewSession,
            &draft("  team  ", "/tmp/a b", "opencode"),
        )
        .unwrap();

        assert_eq!(
            request.argv,
            ["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "team"]
        );
        assert_eq!(request.cwd.unwrap().as_path(), Path::new("/tmp/a b"));
        assert_eq!(request.command.as_deref(), Some("opencode"));
    }

    #[test]
    fn whitespace_only_name_omits_name_flags() {
        let session =
            build_request(CreateContext::NewSession, &draft(" \u{2003} ", "", "")).unwrap();
        let window = build_request(
            CreateContext::NewWindow {
                target: SessionId::from("$3"),
            },
            &draft(" \u{2003} ", "", ""),
        )
        .unwrap();

        assert_eq!(
            session.argv,
            ["new-session", "-d", "-P", "-F", "#{pane_id}"]
        );
        assert_eq!(
            window.argv,
            ["new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "$3"]
        );
    }

    #[test]
    fn builds_exact_new_window_argv() {
        let request = build_request(
            CreateContext::NewWindow {
                target: SessionId::from("$3"),
            },
            &draft("window", "", ""),
        )
        .unwrap();

        assert_eq!(
            request.argv,
            [
                "new-window",
                "-d",
                "-P",
                "-F",
                "#{pane_id}",
                "-t",
                "$3",
                "-n",
                "window"
            ]
        );
    }

    #[test]
    fn builds_exact_split_argv_for_every_direction() {
        let expected = [
            (SplitDirection::Right, vec!["-h"]),
            (SplitDirection::Left, vec!["-b", "-h"]),
            (SplitDirection::Bottom, vec!["-v"]),
            (SplitDirection::Top, vec!["-b", "-v"]),
        ];

        for (direction, flags) in expected {
            let request = build_request(split(direction), &draft("ignored", "", "")).unwrap();
            let mut argv = vec!["split-window", "-d", "-P", "-F", "#{pane_id}"];
            argv.extend(flags);
            argv.extend(["-t", "%7"]);
            assert_eq!(request.argv, argv, "{direction:?}");
        }
    }

    #[test]
    fn names_encode_hash_and_trailing_semicolon_in_every_named_context() {
        let expected_name = "a##{x}\\;";
        let session = build_request(CreateContext::NewSession, &draft("a#{x};", "", "")).unwrap();
        let window = build_request(
            CreateContext::NewWindow {
                target: SessionId::from("$3"),
            },
            &draft("a#{x};", "", ""),
        )
        .unwrap();

        assert_eq!(session.argv.last(), Some(&expected_name.to_owned()));
        assert_eq!(window.argv.last(), Some(&expected_name.to_owned()));
    }

    #[test]
    fn leading_dash_name_is_accepted() {
        let request = build_request(CreateContext::NewSession, &draft("-team", "", "")).unwrap();

        assert_eq!(request.argv.last(), Some(&"-team".to_owned()));
    }

    #[test]
    fn name_rejections_identify_the_name_field() {
        for value in ["bad#[style]", "bad\\name", "bad\0name"] {
            assert!(matches!(
                build_request(CreateContext::NewSession, &draft(value, "", "")),
                Err(CreationError::Field {
                    field: CreationField::Name,
                    ..
                })
            ));
        }
    }

    #[test]
    fn non_nul_control_in_name_identifies_the_name_field() {
        assert!(matches!(
            build_request(CreateContext::NewSession, &draft("bad\x01name", "", "")),
            Err(CreationError::Field {
                field: CreationField::Name,
                ..
            })
        ));
    }

    #[test]
    fn cwd_is_verbatim_not_an_argv_element_and_never_uses_c_flag() {
        let cwd = " /tmp/#[ space\\;ü ";
        let request = build_request(CreateContext::NewSession, &draft("", cwd, "")).unwrap();

        assert_eq!(request.cwd.unwrap().as_path(), Path::new(cwd));
        assert!(
            !request
                .argv
                .iter()
                .any(|argument| argument == "-c" || argument == cwd)
        );
    }

    #[test]
    fn empty_cwd_is_none() {
        let request = build_request(CreateContext::NewSession, &draft("", "", "")).unwrap();

        assert_eq!(request.cwd, None);
    }

    #[test]
    fn every_c0_byte_in_cwd_is_rejected_but_del_is_accepted() {
        for byte in 0_u8..=0x1f {
            let cwd = format!("/tmp/a{}b", char::from(byte));
            assert!(matches!(
                build_request(CreateContext::NewSession, &draft("", &cwd, "")),
                Err(CreationError::Field {
                    field: CreationField::Cwd,
                    ..
                })
            ));
        }

        let cwd = "/tmp/a\u{7f}b";
        assert_eq!(
            build_request(CreateContext::NewSession, &draft("", cwd, ""))
                .unwrap()
                .cwd
                .unwrap()
                .as_path(),
            Path::new(cwd)
        );
    }

    #[test]
    fn validated_cwd_revalidates_the_original_path() {
        let cwd = ValidatedCwd::new("/tmp/hostile #[ \\ ü;".into()).unwrap();

        assert!(cwd.revalidate().is_ok());
    }

    #[test]
    fn command_is_plain_encoded_or_omitted() {
        let command = "λ;$(echo literal)#hash";
        let request = build_request(CreateContext::NewSession, &draft("", "", command)).unwrap();
        let empty = build_request(CreateContext::NewSession, &draft("", "", "")).unwrap();

        assert_eq!(
            request.command,
            Some(crate::tmux_arg::encode(command, crate::tmux_arg::Field::Plain).unwrap())
        );
        assert_eq!(empty.command, None);
    }

    #[test]
    fn command_whitespace_is_preserved() {
        let request =
            build_request(CreateContext::NewSession, &draft("", "", "  echo hi  ")).unwrap();

        assert_eq!(request.command.as_deref(), Some("  echo hi  "));
    }

    #[test]
    fn nul_command_identifies_the_command_field() {
        assert!(matches!(
            build_request(CreateContext::NewSession, &draft("", "", "echo\0no")),
            Err(CreationError::Field {
                field: CreationField::Command,
                ..
            })
        ));
    }

    #[test]
    fn malformed_machine_targets_are_rejected() {
        assert!(matches!(
            build_request(
                CreateContext::NewWindow {
                    target: SessionId::from("not-a-session"),
                },
                &draft("", "", ""),
            ),
            Err(CreationError::InvalidTarget { .. })
        ));
        assert!(matches!(
            build_request(
                CreateContext::Split {
                    target: PaneId::from("not-a-pane"),
                    initiating_session: SessionId::from("$3"),
                    linked_session_count: 0,
                    direction: SplitDirection::Right,
                },
                &draft("", "", ""),
            ),
            Err(CreationError::InvalidTarget { .. })
        ));
    }

    #[test]
    fn display_error_escapes_controls_preserves_unicode_and_caps_scalars() {
        assert_eq!(
            display_error("bad\u{1b}[31mred\nπ"),
            "bad\\u{1b}[31mred\\u{a}π"
        );
        assert_eq!(display_error(&"é".repeat(513)), "é".repeat(512));
        assert_eq!(
            display_error(&format!("{}\n", "x".repeat(511))),
            "x".repeat(511)
        );
    }

    #[tokio::test]
    async fn workflow_emits_the_four_stages_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let executable = dir.path().join("fake-tmux");
        fs::write(
            &executable,
            "#!/bin/sh\ncase \"$1\" in new-session) printf '%%44\\n' ;; esac\n",
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        let request = build_request(CreateContext::NewSession, &draft("", "", "echo hi")).unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let (_cancel, cancellation) = tokio::sync::oneshot::channel();

        run_creation(
            TmuxExec::new(executable),
            super::CreationId(1),
            request,
            tx,
            cancellation,
        )
        .await;

        let progress: Vec<_> = std::iter::from_fn(|| rx.try_recv().ok()).collect();
        assert_eq!(
            progress,
            vec![
                super::CreationProgress::Stage {
                    id: super::CreationId(1),
                    stage: super::CreateStage::Create,
                    pane_id: None,
                },
                super::CreationProgress::Created {
                    id: super::CreationId(1),
                    pane_id: PaneId::from("%44"),
                },
                super::CreationProgress::Stage {
                    id: super::CreationId(1),
                    stage: super::CreateStage::Tag,
                    pane_id: Some(PaneId::from("%44")),
                },
                super::CreationProgress::Stage {
                    id: super::CreationId(1),
                    stage: super::CreateStage::SendCommand,
                    pane_id: Some(PaneId::from("%44")),
                },
                super::CreationProgress::Stage {
                    id: super::CreationId(1),
                    stage: super::CreateStage::SendEnter,
                    pane_id: Some(PaneId::from("%44")),
                },
                super::CreationProgress::Finished {
                    id: super::CreationId(1),
                    pane_id: PaneId::from("%44"),
                    resolution: super::CreationResolution::Success,
                },
            ]
        );
    }

    #[tokio::test]
    async fn workflow_failures_stop_at_the_failed_invocation_with_exact_argv() {
        let expected = [
            vec!["new-session", "-d", "-P", "-F", "#{pane_id}"],
            vec![
                "set-option",
                "-p",
                "-t",
                "%44",
                "@pane_dash_tag",
                "dash-created",
            ],
            vec!["send-keys", "-l", "-t", "%44", "--", "echo hi"],
            vec!["send-keys", "-t", "%44", "Enter"],
        ];

        for fail_at in 1..=4 {
            let dir = tempfile::tempdir().unwrap();
            let (tmux, log) = fake_workflow_tmux(&dir, Some(fail_at));
            let progress = run_workflow(
                tmux,
                build_request(CreateContext::NewSession, &draft("", "", "echo hi")).unwrap(),
            )
            .await;

            assert_eq!(
                logged_argv(&log),
                expected[..fail_at]
                    .iter()
                    .map(|argv| argv.iter().map(|argument| (*argument).to_owned()).collect())
                    .collect::<Vec<Vec<_>>>(),
                "failure at invocation {fail_at} must not run later stages"
            );
            let terminal: Vec<_> = progress
                .iter()
                .filter(|event| {
                    matches!(
                        event,
                        super::CreationProgress::CreateFailed { .. }
                            | super::CreationProgress::Finished { .. }
                            | super::CreationProgress::TimedOut { .. }
                    )
                })
                .collect();
            assert_eq!(terminal.len(), 1, "failure at invocation {fail_at}");
            match (fail_at, terminal[0]) {
                (1, super::CreationProgress::CreateFailed { .. }) => {}
                (
                    2,
                    super::CreationProgress::Finished {
                        resolution: super::CreationResolution::TagFailed(error),
                        ..
                    },
                ) if error.contains("failure-2") => {}
                (
                    3,
                    super::CreationProgress::Finished {
                        resolution:
                            super::CreationResolution::CommandFailed {
                                stage: super::CreateStage::SendCommand,
                                error,
                            },
                        ..
                    },
                ) if error.contains("failure-3") => {}
                (
                    4,
                    super::CreationProgress::Finished {
                        resolution:
                            super::CreationResolution::CommandFailed {
                                stage: super::CreateStage::SendEnter,
                                error,
                            },
                        ..
                    },
                ) if error.contains("failure-4") => {}
                (_, event) => {
                    panic!("unexpected terminal event for invocation {fail_at}: {event:?}")
                }
            }
        }
    }

    #[tokio::test]
    async fn workflow_empty_command_skips_send_command_and_enter() {
        let dir = tempfile::tempdir().unwrap();
        let (tmux, log) = fake_workflow_tmux(&dir, None);
        let progress = run_workflow(
            tmux,
            build_request(CreateContext::NewSession, &draft("", "", "")).unwrap(),
        )
        .await;

        assert_eq!(
            logged_argv(&log),
            vec![
                vec!["new-session", "-d", "-P", "-F", "#{pane_id}"],
                vec![
                    "set-option",
                    "-p",
                    "-t",
                    "%44",
                    "@pane_dash_tag",
                    "dash-created",
                ],
            ]
            .into_iter()
            .map(|argv| argv.into_iter().map(str::to_owned).collect::<Vec<_>>())
            .collect::<Vec<_>>()
        );
        assert!(matches!(
            progress.last(),
            Some(super::CreationProgress::Finished {
                resolution: super::CreationResolution::Success,
                ..
            })
        ));
    }

    #[tokio::test]
    async fn workflow_stops_after_malformed_pane_output_or_invalid_cwd() {
        let dir = tempfile::tempdir().unwrap();
        let malformed_log = dir.path().join("malformed.log");
        let malformed = dir.path().join("malformed-tmux");
        fs::write(
            &malformed,
            format!(
                "#!/bin/sh\nprintf '%s\\t' \"$@\" >> '{}'\nprintf '\\n' >> '{}'\nprintf 'not-a-pane\\n'\n",
                malformed_log.display(),
                malformed_log.display(),
            ),
        )
        .unwrap();
        fs::set_permissions(&malformed, fs::Permissions::from_mode(0o755)).unwrap();
        let malformed_progress = run_workflow(
            TmuxExec::new(malformed),
            build_request(CreateContext::NewSession, &draft("", "", "echo hi")).unwrap(),
        )
        .await;
        assert_eq!(logged_argv(&malformed_log).len(), 1);
        assert!(matches!(
            malformed_progress.as_slice(),
            [
                super::CreationProgress::Stage {
                    stage: super::CreateStage::Create,
                    ..
                },
                super::CreationProgress::CreateFailed { .. },
            ]
        ));

        let (tmux, workflow_log) = fake_workflow_tmux(&dir, None);
        let invalid_cwd = dir.path().join("deleted-before-spawn");
        let invalid_progress = run_workflow(
            tmux,
            build_request(
                CreateContext::NewSession,
                &draft("", invalid_cwd.to_str().unwrap(), "echo hi"),
            )
            .unwrap(),
        )
        .await;
        assert!(
            !workflow_log.exists(),
            "invalid cwd must fail before invoking tmux"
        );
        assert!(matches!(
            invalid_progress.as_slice(),
            [
                super::CreationProgress::Stage {
                    stage: super::CreateStage::Create,
                    ..
                },
                super::CreationProgress::CreateFailed { .. },
            ]
        ));
    }

    #[tokio::test]
    async fn workflow_timeout_promotes_only_parser_proven_stage_one_output() {
        for payload in [b"%42".as_slice(), b"%42\n".as_slice()] {
            let (progress, invocations) = run_timed_out_stage_one(payload, false).await;

            assert_eq!(
                progress,
                vec![
                    CreationProgress::Stage {
                        id: CreationId(99),
                        stage: CreateStage::Create,
                        pane_id: None,
                    },
                    CreationProgress::Created {
                        id: CreationId(99),
                        pane_id: PaneId::from("%42"),
                    },
                    CreationProgress::Finished {
                        id: CreationId(99),
                        pane_id: PaneId::from("%42"),
                        resolution: CreationResolution::TimedOut {
                            stage: CreateStage::Create,
                        },
                    },
                ],
                "accepted payload: {payload:?}"
            );
            assert_eq!(invocations.len(), 1);
        }

        for payload in [
            b"".as_slice(),
            b"%".as_slice(),
            b"42\n".as_slice(),
            b"%42\n%43\n".as_slice(),
            b"%42\nextra".as_slice(),
            b"%42\xff".as_slice(),
        ] {
            let (progress, invocations) = run_timed_out_stage_one(payload, false).await;

            assert_eq!(
                progress,
                vec![
                    CreationProgress::Stage {
                        id: CreationId(99),
                        stage: CreateStage::Create,
                        pane_id: None,
                    },
                    CreationProgress::TimedOut { id: CreationId(99) },
                ],
                "rejected payload: {payload:?}"
            );
            assert_eq!(invocations.len(), 1);
        }
    }

    #[tokio::test]
    async fn workflow_timeout_cancellation_never_promotes_buffered_stage_one_output() {
        let (progress, invocations) = run_timed_out_stage_one(b"%42\n", true).await;

        assert_eq!(
            progress,
            vec![
                CreationProgress::Stage {
                    id: CreationId(99),
                    stage: CreateStage::Create,
                    pane_id: None,
                },
                CreationProgress::TimedOut { id: CreationId(99) },
            ]
        );
        assert_eq!(invocations.len(), 1);
    }
}
