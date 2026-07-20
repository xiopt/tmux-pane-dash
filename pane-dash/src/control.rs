/// Fixed control-channel snapshot command. The format uses tmux's textual octal
/// escapes so the protocol command itself contains no raw record separators.
pub const CONTROL_SNAPSHOT_COMMAND: &str = "list-panes -a -F \"\\036#{session_id}\\037#{session_name}\\037#{window_id}\\037#{window_index}\\037#{window_name}\\037#{pane_id}\\037#{pane_index}\\037#{pane_active}\\037#{pane_current_command}\\037#{pane_current_path}\\037#{pane_dead}\\037#{@pane_dash_status}\\037#{@pane_dash_status_since}\\037#{@pane_dash_heartbeat}\\037#{@pane_dash_title}\\037#{@pane_dash_model}\\037#{@pane_dash_tag}\\037#{@pane_dash_group}\"\n";

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
    if !client_tty.starts_with('/') || !(target.starts_with('%') || target.starts_with('$')) {
        return None;
    }
    if !is_safe_control_argument(client_tty) || !is_safe_control_argument(target) {
        return None;
    }

    let zoom = if target.starts_with('%') { " -Z" } else { "" };
    Some(format!("switch-client{zoom} -c {client_tty} -t {target}\n"))
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
