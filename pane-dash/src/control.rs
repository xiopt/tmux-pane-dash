/// Fixed control-channel snapshot command. The format uses tmux's textual octal
/// escapes so the protocol command itself contains no raw record separators.
pub const CONTROL_SNAPSHOT_COMMAND: &str = "list-panes -a -F \"\\036#{session_id}\\037#{session_name}\\037#{window_id}\\037#{window_index}\\037#{window_name}\\037#{pane_id}\\037#{pane_index}\\037#{pane_active}\\037#{pane_current_command}\\037#{pane_current_path}\\037#{pane_dead}\\037#{@pane_dash_status}\\037#{@pane_dash_status_since}\\037#{@pane_dash_heartbeat}\\037#{@pane_dash_title}\\037#{@pane_dash_model}\\037#{@pane_dash_opencode_session}\\037#{@pane_dash_tag}\\037#{@pane_dash_group}\"\n";

/// Every attach handshake and written control command has exactly two seconds
/// to receive its matching response; `tokio::time` provides the monotonic clock.
pub const CONTROL_RESPONSE_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ControlEvent {
    TopologyChanged,
    FocusChanged(bool),
    SessionChanged(String),
    Terminated(String),
}

#[derive(Debug, Clone)]
pub struct ControlHandle {
    requests: mpsc::Sender<Request>,
    termination: Arc<Mutex<Option<String>>>,
}

impl ControlHandle {
    pub async fn snapshot(&self) -> Result<Vec<u8>> {
        let (reply, response) = oneshot::channel();
        self.requests
            .send(Request::Snapshot { reply })
            .await
            .map_err(|_| self.termination_error())?;
        response
            .await
            .map_err(|_| anyhow!("tmux control actor stopped before replying"))?
    }

    pub async fn jump(&self, client_tty: &str, target: &str) -> Result<bool> {
        let command = jump_command(client_tty, target)
            .ok_or_else(|| anyhow!("invalid tmux control jump arguments"))?;
        let (reply, response) = oneshot::channel();
        self.requests
            .send(Request::Jump { command, reply })
            .await
            .map_err(|_| self.termination_error())?;
        response
            .await
            .map_err(|_| anyhow!("tmux control actor stopped before replying"))?
    }

    pub async fn subscribe_focus(&self, client_tty: &str) -> Result<()> {
        let command = focus_subscription_command(client_tty)
            .ok_or_else(|| anyhow!("invalid tmux control focus subscription client tty"))?;
        let (reply, response) = oneshot::channel();
        self.requests
            .send(Request::SubscribeFocus { command, reply })
            .await
            .map_err(|_| self.termination_error())?;
        response
            .await
            .map_err(|_| anyhow!("tmux control actor stopped before replying"))?
    }

    fn termination_error(&self) -> anyhow::Error {
        anyhow!(
            "{}",
            self.termination
                .lock()
                .expect("control termination state poisoned")
                .as_deref()
                .unwrap_or("tmux control actor is not running")
        )
    }
}

pub async fn connect_control(
    tmux_bin: impl Into<PathBuf>,
    session_id: &str,
) -> Result<(ControlHandle, mpsc::UnboundedReceiver<ControlEvent>)> {
    if !is_machine_session_id(session_id) {
        bail!("invalid tmux session ID");
    }

    let mut child = Command::new(tmux_bin.into())
        .env("LC_ALL", "C.UTF-8")
        .args([
            "-C",
            "attach-session",
            "-f",
            "no-output,ignore-size",
            "-t",
            session_id,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow!("tmux stdin was not piped"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("tmux stdout was not piped"))?;
    let mut stdout = BufReader::new(stdout);

    let initial_events = match tokio::time::timeout(
        CONTROL_RESPONSE_TIMEOUT,
        consume_attach_handshake(&mut stdout),
    )
    .await
    {
        Ok(Ok(events)) => events,
        Ok(Err(error)) => {
            drop(stdin);
            let _ = child.start_kill();
            let _ = child.wait().await;
            return Err(error);
        }
        Err(_) => {
            drop(stdin);
            let _ = child.start_kill();
            let _ = child.wait().await;
            bail!("tmux control attach handshake timed out");
        }
    };

    let (requests, request_rx) = mpsc::channel(32);
    let (events, event_rx) = mpsc::unbounded_channel();
    let termination = Arc::new(Mutex::new(None));
    for event in initial_events {
        let _ = events.send(event);
    }
    tokio::spawn(control_actor(
        child,
        stdin,
        stdout,
        request_rx,
        events,
        termination.clone(),
    ));
    Ok((
        ControlHandle {
            requests,
            termination,
        },
        event_rx,
    ))
}

#[derive(Debug)]
enum Request {
    Snapshot {
        reply: oneshot::Sender<Result<Vec<u8>>>,
    },
    Jump {
        command: String,
        reply: oneshot::Sender<Result<bool>>,
    },
    SubscribeFocus {
        command: String,
        reply: oneshot::Sender<Result<()>>,
    },
}

impl Request {
    fn command(&self) -> &str {
        match self {
            Self::Snapshot { .. } => CONTROL_SNAPSHOT_COMMAND,
            Self::Jump { command, .. } => command,
            Self::SubscribeFocus { command, .. } => command,
        }
    }

    fn complete(self, ok: bool, data: Vec<u8>) {
        match self {
            Self::Snapshot { reply } => {
                let _ = reply.send(if ok {
                    Ok(data)
                } else {
                    Err(anyhow!("tmux control snapshot failed"))
                });
            }
            Self::Jump { reply, .. } => {
                let _ = reply.send(Ok(ok));
            }
            Self::SubscribeFocus { reply, .. } => {
                let _ = reply.send(if ok {
                    Ok(())
                } else {
                    Err(anyhow!("tmux control focus subscription failed"))
                });
            }
        }
    }

    fn fail(self, message: &str) {
        match self {
            Self::Snapshot { reply } => {
                let _ = reply.send(Err(anyhow!("{message}")));
            }
            Self::Jump { reply, .. } => {
                let _ = reply.send(Err(anyhow!("{message}")));
            }
            Self::SubscribeFocus { reply, .. } => {
                let _ = reply.send(Err(anyhow!("{message}")));
            }
        }
    }
}

async fn consume_attach_handshake<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
) -> Result<Vec<ControlEvent>> {
    let mut parser = ProtocolParser::default();
    let mut line = Vec::new();
    let mut events = Vec::new();
    loop {
        line.clear();
        if reader.read_until(b'\n', &mut line).await? == 0 {
            bail!("tmux control attach ended before its handshake");
        }
        if !line.ends_with(b"\n") {
            bail!("truncated tmux control line");
        }
        for event in parser.push_line(&line) {
            match event {
                ProtocolEvent::Response { ok: true, .. } => return Ok(events),
                ProtocolEvent::Response { ok: false, .. } => bail!("tmux control attach failed"),
                ProtocolEvent::MalformedResponse => bail!("malformed tmux control attach response"),
                ProtocolEvent::Exit => bail!("tmux control exited during attach"),
                ProtocolEvent::TopologyChanged | ProtocolEvent::FocusChanged(_) => {}
                ProtocolEvent::SessionChanged(session_id) => {
                    events.push(ControlEvent::SessionChanged(session_id));
                }
            }
        }
    }
}

async fn control_actor(
    mut child: Child,
    mut stdin: ChildStdin,
    mut stdout: BufReader<tokio::process::ChildStdout>,
    mut requests: mpsc::Receiver<Request>,
    events: mpsc::UnboundedSender<ControlEvent>,
    termination: Arc<Mutex<Option<String>>>,
) {
    let mut parser = ProtocolParser::default();
    let mut active: Option<Request> = None;
    let mut line = Vec::new();
    let mut terminated = None;
    let mut response_deadline = None;

    loop {
        tokio::select! {
            _ = async {
                if let Some(deadline) = response_deadline {
                    tokio::time::sleep_until(deadline).await;
                } else {
                    std::future::pending::<()>().await;
                }
            } => {
                terminated = Some("tmux control response timed out".into());
                break;
            },
            read = stdout.read_until(b'\n', &mut line) => match read {
                Ok(0) => {
                    let malformed = parser
                        .finish()
                        .into_iter()
                        .any(|event| matches!(event, ProtocolEvent::MalformedResponse));
                    terminated = Some(if !line.is_empty() {
                        "truncated tmux control line".into()
                    } else if malformed {
                        "malformed tmux control response".into()
                    } else {
                        "tmux control stdout closed".into()
                    });
                    break;
                }
                Ok(_) => {
                    if !line.ends_with(b"\n") {
                        continue;
                    }
                    let parsed = parser.push_line(&line);
                    line.clear();
                    for event in parsed {
                        match event {
                            ProtocolEvent::Response { ok, data, .. } => {
                                if let Some(request) = active.take() {
                                    response_deadline = None;
                                    request.complete(ok, data);
                                }
                            }
                            ProtocolEvent::TopologyChanged => { let _ = events.send(ControlEvent::TopologyChanged); }
                            ProtocolEvent::FocusChanged(focused) => { let _ = events.send(ControlEvent::FocusChanged(focused)); }
                            ProtocolEvent::SessionChanged(session_id) => { let _ = events.send(ControlEvent::SessionChanged(session_id)); }
                            ProtocolEvent::Exit => {
                                terminated = Some("tmux control exited".into());
                                break;
                            }
                            ProtocolEvent::MalformedResponse => {
                                terminated = Some("malformed tmux control response".into());
                                break;
                            }
                        }
                    }
                    if terminated.is_some() { break; }
                }
                Err(error) => {
                    terminated = Some(format!("tmux control read failed: {error}"));
                    break;
                }
            },
            request = requests.recv(), if active.is_none() => match request {
                Some(request) => {
                    if let Err(error) = stdin.write_all(request.command().as_bytes()).await {
                        request.fail(&format!("tmux control write failed: {error}"));
                        terminated = Some(format!("tmux control write failed: {error}"));
                        break;
                    }
                    if let Err(error) = stdin.flush().await {
                        request.fail(&format!("tmux control write failed: {error}"));
                        terminated = Some(format!("tmux control write failed: {error}"));
                        break;
                    }
                    active = Some(request);
                    response_deadline = Some(tokio::time::Instant::now() + CONTROL_RESPONSE_TIMEOUT);
                }
                None => break,
            },
        }
    }

    if let Some(reason) = terminated {
        *termination
            .lock()
            .expect("control termination state poisoned") = Some(reason.clone());
        requests.close();
        fail_requests(active, &mut requests, &reason);
        drop(requests);
        drop(stdin);
        let _ = events.send(ControlEvent::Terminated(reason));
        if child.try_wait().ok().flatten().is_none() {
            let _ = child.start_kill();
        }
    } else {
        drop(stdin);
    }
    let _ = child.wait().await;
}

fn fail_requests(active: Option<Request>, requests: &mut mpsc::Receiver<Request>, reason: &str) {
    if let Some(request) = active {
        request.fail(reason);
    }
    while let Ok(request) = requests.try_recv() {
        request.fail(reason);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GuardId {
    pub timestamp: u64,
    pub command_number: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtocolEvent {
    Response {
        id: GuardId,
        ok: bool,
        data: Vec<u8>,
    },
    TopologyChanged,
    FocusChanged(bool),
    SessionChanged(String),
    Exit,
    MalformedResponse,
}

#[derive(Debug)]
struct OpenResponse {
    id: GuardId,
    data: Vec<u8>,
}

#[derive(Debug, Default)]
pub struct ProtocolParser {
    open_response: Option<OpenResponse>,
}

impl ProtocolParser {
    pub fn push_line(&mut self, line: &[u8]) -> Vec<ProtocolEvent> {
        if let Some(open_response) = self.open_response.as_mut() {
            if let Some((kind, id)) = parse_guard(line)
                && id == open_response.id
                && matches!(kind, GuardKind::End | GuardKind::Error)
            {
                let open_response = self.open_response.take().expect("open response exists");
                return vec![ProtocolEvent::Response {
                    id,
                    ok: kind == GuardKind::End,
                    data: open_response.data,
                }];
            }
            open_response.data.extend_from_slice(line);
            return Vec::new();
        }

        match parse_guard(line) {
            Some((GuardKind::Begin, id)) => {
                self.open_response = Some(OpenResponse {
                    id,
                    data: Vec::new(),
                });
                Vec::new()
            }
            _ if topology_token(line) => vec![ProtocolEvent::TopologyChanged],
            _ if let Some(focused) = focus_subscription_changed(line) => {
                vec![ProtocolEvent::FocusChanged(focused)]
            }
            _ if let Some(session_id) = session_changed(line) => {
                vec![ProtocolEvent::SessionChanged(session_id)]
            }
            _ if first_token(line) == Some(b"%exit") => vec![ProtocolEvent::Exit],
            _ => Vec::new(),
        }
    }

    pub fn finish(&mut self) -> Vec<ProtocolEvent> {
        if self.open_response.take().is_some() {
            vec![ProtocolEvent::MalformedResponse]
        } else {
            Vec::new()
        }
    }
}

/// Builds a fixed control-channel jump command for a machine pane or session ID.
pub fn jump_command(client_tty: &str, target: &str) -> Option<String> {
    if !is_safe_client_tty(client_tty) || !(target.starts_with('%') || target.starts_with('$')) {
        return None;
    }
    if !is_safe_control_argument(target) {
        return None;
    }

    let zoom = if target.starts_with('%') { " -Z" } else { "" };
    Some(format!("switch-client{zoom} -c {client_tty} -t {target}\n"))
}

/// Builds the fixed control-mode subscription used to relay popup-owner focus.
pub fn focus_subscription_command(client_tty: &str) -> Option<String> {
    is_safe_client_tty(client_tty).then(|| {
        format!("refresh-client -B \"pane_dash_focus:1:#{{@pane_dash_focus_{client_tty}}}\"\n")
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GuardKind {
    Begin,
    End,
    Error,
}

fn parse_guard(line: &[u8]) -> Option<(GuardKind, GuardId)> {
    let mut fields = line_without_lf(line).split(|byte| byte.is_ascii_whitespace());
    let token = fields.next()?;
    let kind = match token {
        b"%begin" => GuardKind::Begin,
        b"%end" => GuardKind::End,
        b"%error" => GuardKind::Error,
        _ => return None,
    };
    let timestamp = parse_ascii_u64(fields.next()?)?;
    let command_number = parse_ascii_u64(fields.next()?)?;
    parse_ascii_u64(fields.next()?)?;
    Some((
        kind,
        GuardId {
            timestamp,
            command_number,
        },
    ))
}

fn topology_token(line: &[u8]) -> bool {
    matches!(
        first_token(line),
        Some(
            b"%window-add"
                | b"%window-close"
                | b"%window-renamed"
                | b"%layout-change"
                | b"%window-pane-changed"
                | b"%session-window-changed"
                | b"%sessions-changed"
                | b"%session-renamed"
                | b"%unlinked-window-add"
                | b"%unlinked-window-close"
                | b"%unlinked-window-renamed"
        )
    )
}

fn focus_subscription_changed(line: &[u8]) -> Option<bool> {
    let fields: Vec<_> = line_without_lf(line)
        .split(|byte| byte.is_ascii_whitespace())
        .filter(|field| !field.is_empty())
        .collect();
    match fields.as_slice() {
        [b"%subscription-changed", b"pane_dash_focus", .., b":", b"1"] if fields.len() >= 5 => {
            Some(true)
        }
        [b"%subscription-changed", b"pane_dash_focus", .., b":", b"0"] if fields.len() >= 5 => {
            Some(false)
        }
        _ => None,
    }
}

fn session_changed(line: &[u8]) -> Option<String> {
    let mut fields = line_without_lf(line)
        .split(|byte| byte.is_ascii_whitespace())
        .filter(|field| !field.is_empty());
    (fields.next()? == b"%session-changed").then_some(())?;
    let session_id = fields.next()?;
    fields.next()?;
    (session_id.starts_with(b"$")
        && session_id.len() > 1
        && session_id[1..].iter().all(u8::is_ascii_digit))
    .then(|| String::from_utf8_lossy(session_id).into_owned())
}

fn first_token(line: &[u8]) -> Option<&[u8]> {
    line_without_lf(line)
        .split(|byte| byte.is_ascii_whitespace())
        .next()
}

fn line_without_lf(line: &[u8]) -> &[u8] {
    line.strip_suffix(b"\n").unwrap_or(line)
}

fn parse_ascii_u64(value: &[u8]) -> Option<u64> {
    (!value.is_empty() && value.iter().all(u8::is_ascii_digit))
        .then(|| std::str::from_utf8(value).ok()?.parse().ok())?
}

fn is_safe_control_argument(value: &str) -> bool {
    !value.bytes().any(|byte| {
        byte.is_ascii_whitespace()
            || byte.is_ascii_control()
            || matches!(byte, b'\\' | b'\"' | b';')
    })
}

/// Returns whether `value` is a portable, syntactically safe Unix client TTY.
///
/// The value is embedded in fixed tmux control commands, so this permits only
/// a normalized-looking `/dev/` path made from an intentionally small ASCII
/// alphabet. It does not inspect the filesystem or require a particular
/// platform's device-name family.
pub fn is_safe_client_tty(value: &str) -> bool {
    const DEV_PREFIX: &str = "/dev/";
    const MAX_CLIENT_TTY_LEN: usize = 255;

    let Some(tail) = value.strip_prefix(DEV_PREFIX) else {
        return false;
    };
    if tail.is_empty() || value.len() > MAX_CLIENT_TTY_LEN {
        return false;
    }

    tail.split('/').all(|component| {
        !component.is_empty()
            && component != "."
            && component != ".."
            && component
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    })
}

fn is_machine_session_id(value: &str) -> bool {
    value.starts_with('$') && value.len() > 1 && is_safe_control_argument(value)
}
use std::{
    path::PathBuf,
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::{Result, anyhow, bail};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{mpsc, oneshot},
};
