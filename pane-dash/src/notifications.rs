use std::collections::{HashSet, VecDeque};

use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use crate::model::{PaneId, SessionId, WindowId};

pub const QUEUE_CAPACITY: usize = 64;
pub const DEDUP_HISTORY_CAPACITY: usize = 256;
pub const MAX_MESSAGE_SCALARS: usize = 256;
pub const DEFAULT_STATUS_WIDTH: usize = 80;

const MAX_EVENT_ID_BYTES: usize = 128;
const VISIBLE_RANGE_PREFIX: &str = "pane-dash-visible-";
const MORE_RANGE_NAME: &str = "pane-dash-more";
const ELLIPSIS: &str = "…";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum NotificationKind {
    Error,
    Permission,
    Question,
    Finished,
}

impl NotificationKind {
    pub fn priority(self) -> u8 {
        match self {
            Self::Error => 4,
            Self::Permission => 3,
            Self::Question => 2,
            Self::Finished => 1,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::Permission => "permission",
            Self::Question => "question",
            Self::Finished => "finished",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotificationTarget {
    session_id: SessionId,
    window_id: WindowId,
    pane_id: PaneId,
}

impl NotificationTarget {
    pub fn new(
        session_id: impl Into<SessionId>,
        window_id: impl Into<WindowId>,
        pane_id: impl Into<PaneId>,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            window_id: window_id.into(),
            pane_id: pane_id.into(),
        }
    }

    pub fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    pub fn window_id(&self) -> &WindowId {
        &self.window_id
    }

    pub fn pane_id(&self) -> &PaneId {
        &self.pane_id
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotificationEvent {
    pub kind: NotificationKind,
    pub event_id: String,
    pub message: String,
    pub target: NotificationTarget,
}

impl NotificationEvent {
    pub fn new(
        kind: NotificationKind,
        event_id: impl Into<String>,
        message: impl Into<String>,
        target: NotificationTarget,
    ) -> Self {
        Self {
            kind,
            event_id: event_id.into(),
            message: message.into(),
            target,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveClient {
    client_id: String,
    focused: bool,
    current_pane: Option<PaneId>,
}

impl ActiveClient {
    pub fn new(client_id: impl Into<String>, focused: bool, current_pane: Option<PaneId>) -> Self {
        Self {
            client_id: client_id.into(),
            focused,
            current_pane,
        }
    }

    pub fn client_id(&self) -> &str {
        &self.client_id
    }

    pub fn focused(&self) -> bool {
        self.focused
    }

    pub fn current_pane(&self) -> Option<&PaneId> {
        self.current_pane.as_ref()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct EventId(String);

impl EventId {
    pub fn new(value: impl Into<String>) -> Result<Self, NotificationError> {
        let value = value.into();
        if value.is_empty() {
            return Err(NotificationError::EmptyEventId);
        }
        if value.len() > MAX_EVENT_ID_BYTES {
            return Err(NotificationError::EventIdTooLong);
        }
        if value
            .bytes()
            .any(|byte| !(byte.is_ascii_graphic() || byte == b' '))
        {
            return Err(NotificationError::EventIdContainsControl);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for EventId {
    type Error = NotificationError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl TryFrom<&str> for EventId {
    type Error = NotificationError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notification {
    kind: NotificationKind,
    event_id: EventId,
    message: String,
    target: NotificationTarget,
    sequence: u64,
}

impl Notification {
    pub fn kind(&self) -> NotificationKind {
        self.kind
    }

    pub fn event_id(&self) -> &EventId {
        &self.event_id
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    pub fn target(&self) -> &NotificationTarget {
        &self.target
    }

    pub fn sequence(&self) -> u64 {
        self.sequence
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotificationSnapshot {
    items: Vec<Notification>,
}

impl NotificationSnapshot {
    pub fn items(&self) -> &[Notification] {
        &self.items
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RouteIntent {
    Pane(NotificationTarget),
    List,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum NotificationError {
    #[error("notification event ID is empty")]
    EmptyEventId,
    #[error("notification event ID is too long")]
    EventIdTooLong,
    #[error("notification event ID contains a control character")]
    EventIdContainsControl,
    #[error("notification sequence space is exhausted")]
    SequenceExhausted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApplyOutcome {
    Published { sequence: u64 },
    SuppressedByFocus,
    Duplicate,
    QueueFull,
    RemovedStale { count: usize },
    ClickedVisible { sequence: u64 },
    ClickedMore,
    IgnoredClick,
    ActiveClientUpdated,
    StatusWidthUpdated,
    Rejected(NotificationError),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApplyResult {
    pub outcome: ApplyOutcome,
    pub changed: bool,
    pub snapshot: NotificationSnapshot,
    pub status_row: String,
    pub route: Option<RouteIntent>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NotificationCommand {
    Publish(NotificationEvent),
    SetActiveClient(Option<ActiveClient>),
    RemoveStalePanes(Vec<PaneId>),
    Click(String),
    SetStatusWidth(usize),
}

#[derive(Debug, Clone)]
pub struct NotificationState {
    queue: VecDeque<Notification>,
    dedup_history: VecDeque<EventId>,
    next_sequence: u64,
    active_client: Option<ActiveClient>,
    status_width: usize,
}

impl Default for NotificationState {
    fn default() -> Self {
        Self::new()
    }
}

impl NotificationState {
    pub fn new() -> Self {
        Self::with_status_width(DEFAULT_STATUS_WIDTH)
    }

    pub fn with_status_width(status_width: usize) -> Self {
        Self {
            queue: VecDeque::new(),
            dedup_history: VecDeque::new(),
            next_sequence: 1,
            active_client: None,
            status_width,
        }
    }

    pub fn apply(&mut self, command: NotificationCommand) -> ApplyResult {
        let (outcome, changed, route) = match command {
            NotificationCommand::Publish(event) => self.publish(event),
            NotificationCommand::SetActiveClient(client) => self.set_active_client(client),
            NotificationCommand::RemoveStalePanes(pane_ids) => self.remove_stale_panes(pane_ids),
            NotificationCommand::Click(token) => self.click(&token),
            NotificationCommand::SetStatusWidth(width) => self.set_status_width(width),
        };

        ApplyResult {
            outcome,
            changed,
            snapshot: self.snapshot(),
            status_row: self.render_status_row(self.status_width),
            route,
        }
    }

    pub fn snapshot(&self) -> NotificationSnapshot {
        NotificationSnapshot {
            items: self.ordered_notifications().into_iter().cloned().collect(),
        }
    }

    pub fn render_status_row(&self, width: usize) -> String {
        let ordered = self.ordered_notifications();
        let Some(visible) = ordered.first() else {
            return String::new();
        };

        let visible_name = format!("{VISIBLE_RANGE_PREFIX}{}", visible.sequence);
        let visible_text = notification_text(visible);
        let more_count = ordered.len().saturating_sub(1);
        if more_count == 0 {
            return format_range(&visible_name, &truncate_to_width(&visible_text, width));
        }

        let more_text = format!("+{more_count} more");
        let more_width = more_text.width();
        let (visible_width, more_width, separator) = if width > more_width {
            (width - more_width - 1, more_width, " ")
        } else {
            (0, width, "")
        };
        let visible_text = truncate_to_width(&visible_text, visible_width);
        let more_text = truncate_to_width(&more_text, more_width);

        format!(
            "{}{}{}",
            format_range(&visible_name, &visible_text),
            separator,
            format_range(MORE_RANGE_NAME, &more_text),
        )
    }

    pub fn len(&self) -> usize {
        self.queue.len()
    }

    pub fn is_empty(&self) -> bool {
        self.queue.is_empty()
    }

    pub fn remembered_event_count(&self) -> usize {
        self.dedup_history.len()
    }

    fn publish(&mut self, event: NotificationEvent) -> (ApplyOutcome, bool, Option<RouteIntent>) {
        let event_id = match EventId::new(event.event_id) {
            Ok(event_id) => event_id,
            Err(error) => return (ApplyOutcome::Rejected(error), false, None),
        };

        if self.dedup_history.contains(&event_id) {
            return (ApplyOutcome::Duplicate, false, None);
        }

        if self.is_focus_suppressed(&event.target) {
            self.remember_event(event_id);
            return (ApplyOutcome::SuppressedByFocus, true, None);
        }

        let eviction_index = self.eviction_index(event.kind);
        if self.queue.len() == QUEUE_CAPACITY && eviction_index.is_none() {
            return (ApplyOutcome::QueueFull, false, None);
        }

        let Some(sequence) = self.reserve_sequence() else {
            return (
                ApplyOutcome::Rejected(NotificationError::SequenceExhausted),
                false,
                None,
            );
        };

        if let Some(index) = eviction_index {
            self.queue.remove(index);
        }

        let notification = Notification {
            kind: event.kind,
            event_id: event_id.clone(),
            message: bound_message(&event.message),
            target: event.target,
            sequence,
        };
        self.queue.push_back(notification);
        self.remember_event(event_id);
        (ApplyOutcome::Published { sequence }, true, None)
    }

    fn set_active_client(
        &mut self,
        client: Option<ActiveClient>,
    ) -> (ApplyOutcome, bool, Option<RouteIntent>) {
        let changed = self.active_client != client;
        self.active_client = client;
        (ApplyOutcome::ActiveClientUpdated, changed, None)
    }

    fn remove_stale_panes(
        &mut self,
        pane_ids: Vec<PaneId>,
    ) -> (ApplyOutcome, bool, Option<RouteIntent>) {
        let stale: HashSet<_> = pane_ids.into_iter().collect();
        let before = self.queue.len();
        self.queue
            .retain(|notification| !stale.contains(notification.target.pane_id()));
        let removed = before - self.queue.len();
        (
            ApplyOutcome::RemovedStale { count: removed },
            removed > 0,
            None,
        )
    }

    fn click(&mut self, token: &str) -> (ApplyOutcome, bool, Option<RouteIntent>) {
        if token == MORE_RANGE_NAME {
            return if self.queue.len() > 1 {
                (ApplyOutcome::ClickedMore, false, Some(RouteIntent::List))
            } else {
                (ApplyOutcome::IgnoredClick, false, None)
            };
        }

        let Some(sequence) = parse_visible_range(token) else {
            return (ApplyOutcome::IgnoredClick, false, None);
        };
        let ordered = self.ordered_notifications();
        let Some(visible) = ordered.first() else {
            return (ApplyOutcome::IgnoredClick, false, None);
        };
        if visible.sequence != sequence {
            return (ApplyOutcome::IgnoredClick, false, None);
        }

        let Some(target) = self
            .queue
            .iter()
            .find(|notification| notification.sequence == sequence)
            .map(|notification| notification.target.clone())
        else {
            return (ApplyOutcome::IgnoredClick, false, None);
        };
        self.queue
            .retain(|notification| notification.sequence != sequence);
        (
            ApplyOutcome::ClickedVisible { sequence },
            true,
            Some(RouteIntent::Pane(target)),
        )
    }

    fn set_status_width(&mut self, width: usize) -> (ApplyOutcome, bool, Option<RouteIntent>) {
        let changed = self.status_width != width;
        self.status_width = width;
        (ApplyOutcome::StatusWidthUpdated, changed, None)
    }

    fn is_focus_suppressed(&self, target: &NotificationTarget) -> bool {
        self.active_client.as_ref().is_some_and(|client| {
            client.focused && client.current_pane.as_ref() == Some(target.pane_id())
        })
    }

    fn remember_event(&mut self, event_id: EventId) {
        if self.dedup_history.len() == DEDUP_HISTORY_CAPACITY {
            self.dedup_history.pop_front();
        }
        self.dedup_history.push_back(event_id);
    }

    fn reserve_sequence(&mut self) -> Option<u64> {
        let sequence = self.next_sequence;
        self.next_sequence = sequence.checked_add(1)?;
        Some(sequence)
    }

    fn eviction_index(&self, kind: NotificationKind) -> Option<usize> {
        if self.queue.len() < QUEUE_CAPACITY {
            return None;
        }

        let lowest_priority = self
            .queue
            .iter()
            .map(|notification| notification.kind.priority())
            .min()?;
        if kind.priority() <= lowest_priority {
            return None;
        }

        self.queue
            .iter()
            .enumerate()
            .filter(|(_, notification)| notification.kind.priority() == lowest_priority)
            .max_by_key(|(_, notification)| notification.sequence)
            .map(|(index, _)| index)
    }

    fn ordered_notifications(&self) -> Vec<&Notification> {
        let mut ordered: Vec<_> = self.queue.iter().collect();
        ordered.sort_by(|left, right| {
            right
                .kind
                .priority()
                .cmp(&left.kind.priority())
                .then_with(|| left.sequence.cmp(&right.sequence))
        });
        ordered
    }
}

fn notification_text(notification: &Notification) -> String {
    if notification.message.is_empty() {
        notification.kind.label().to_owned()
    } else {
        format!("{}: {}", notification.kind.label(), notification.message)
    }
}

fn bound_message(value: &str) -> String {
    value
        .chars()
        .filter_map(|character| {
            if matches!(character, '\n' | '\r' | '\t' | '\u{2028}' | '\u{2029}') {
                Some(' ')
            } else if character.is_control() {
                None
            } else {
                Some(character)
            }
        })
        .take(MAX_MESSAGE_SCALARS)
        .collect()
}

fn truncate_to_width(value: &str, max_width: usize) -> String {
    if value.width() <= max_width {
        return value.to_owned();
    }
    if max_width == 0 {
        return String::new();
    }

    let ellipsis_width = ELLIPSIS.width();
    let content_width = max_width.saturating_sub(ellipsis_width);
    let mut result = String::new();
    let mut width = 0;
    for grapheme in value.graphemes(true) {
        let grapheme_width = grapheme.width();
        if width + grapheme_width > content_width {
            break;
        }
        result.push_str(grapheme);
        width += grapheme_width;
    }
    result.push_str(ELLIPSIS);
    result
}

fn escape_tmux_format(value: &str) -> String {
    value.replace('#', "##")
}

fn format_range(name: &str, value: &str) -> String {
    format!(
        "#[range=user|{name}]{}#[norange]",
        escape_tmux_format(value)
    )
}

fn parse_visible_range(value: &str) -> Option<u64> {
    let digits = value.strip_prefix(VISIBLE_RANGE_PREFIX)?;
    if digits.is_empty()
        || (digits.len() > 1 && digits.starts_with('0'))
        || !digits.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let sequence = digits.parse::<u64>().ok()?;
    (sequence.to_string() == digits).then_some(sequence)
}

#[cfg(test)]
mod tests {
    use unicode_width::UnicodeWidthStr;

    use super::*;

    fn target(pane_id: &str) -> NotificationTarget {
        NotificationTarget::new("$1", "@1", pane_id)
    }

    fn event(id: &str, kind: NotificationKind, pane_id: &str) -> NotificationEvent {
        NotificationEvent::new(kind, id, "message", target(pane_id))
    }

    fn publish(
        state: &mut NotificationState,
        id: &str,
        kind: NotificationKind,
        pane_id: &str,
    ) -> ApplyResult {
        state.apply(NotificationCommand::Publish(event(id, kind, pane_id)))
    }

    fn published_sequence(result: &ApplyResult) -> u64 {
        match result.outcome {
            ApplyOutcome::Published { sequence } => sequence,
            ref outcome => panic!("expected publish, got {outcome:?}"),
        }
    }

    fn visible_content(row: &str) -> String {
        let mut content = String::new();
        let mut characters = row.chars().peekable();
        while let Some(character) = characters.next() {
            if character == '#' && characters.peek() == Some(&'[') {
                characters.next();
                for character in characters.by_ref() {
                    if character == ']' {
                        break;
                    }
                }
            } else if character == '#' && characters.peek() == Some(&'#') {
                characters.next();
                content.push('#');
            } else {
                content.push(character);
            }
        }
        content
    }

    #[test]
    fn priority_order_keeps_oldest_sequence_first_within_each_kind() {
        let mut state = NotificationState::new();
        publish(&mut state, "finished", NotificationKind::Finished, "%1");
        let first_error = publish(&mut state, "error-1", NotificationKind::Error, "%2");
        publish(&mut state, "question", NotificationKind::Question, "%3");
        publish(&mut state, "permission", NotificationKind::Permission, "%4");
        let second_error = publish(&mut state, "error-2", NotificationKind::Error, "%5");

        let items = state.snapshot().items().to_vec();
        assert_eq!(
            items.iter().map(Notification::kind).collect::<Vec<_>>(),
            vec![
                NotificationKind::Error,
                NotificationKind::Error,
                NotificationKind::Permission,
                NotificationKind::Question,
                NotificationKind::Finished,
            ]
        );
        assert_eq!(items[0].sequence(), published_sequence(&first_error));
        assert_eq!(items[1].sequence(), published_sequence(&second_error));
    }

    #[test]
    fn duplicate_accepted_and_focus_suppressed_ids_are_successful_noops_on_repeat() {
        let mut state = NotificationState::new();
        let first = publish(&mut state, "accepted", NotificationKind::Finished, "%1");
        assert!(first.changed);
        let duplicate = publish(&mut state, "accepted", NotificationKind::Finished, "%1");
        assert_eq!(duplicate.outcome, ApplyOutcome::Duplicate);
        assert!(!duplicate.changed);
        assert_eq!(state.len(), 1);

        state.apply(NotificationCommand::SetActiveClient(Some(
            ActiveClient::new("client", true, Some(PaneId::from("%2"))),
        )));
        let suppressed = publish(&mut state, "suppressed", NotificationKind::Question, "%2");
        assert_eq!(suppressed.outcome, ApplyOutcome::SuppressedByFocus);
        assert!(suppressed.changed);
        assert_eq!(state.len(), 1);
        let duplicate_suppressed =
            publish(&mut state, "suppressed", NotificationKind::Question, "%2");
        assert_eq!(duplicate_suppressed.outcome, ApplyOutcome::Duplicate);
        assert!(!duplicate_suppressed.changed);
    }

    #[test]
    fn queue_and_dedup_history_have_their_independent_bounds() {
        let mut state = NotificationState::new();
        for index in 0..QUEUE_CAPACITY {
            let result = publish(
                &mut state,
                &format!("finished-{index}"),
                NotificationKind::Finished,
                &format!("%{index}"),
            );
            assert!(matches!(result.outcome, ApplyOutcome::Published { .. }));
        }
        assert_eq!(state.len(), QUEUE_CAPACITY);

        let rejected = publish(
            &mut state,
            "retry-after-rejection",
            NotificationKind::Finished,
            "%rejected",
        );
        assert_eq!(rejected.outcome, ApplyOutcome::QueueFull);
        assert!(!rejected.changed);

        let admitted = publish(
            &mut state,
            "higher-priority",
            NotificationKind::Error,
            "%error",
        );
        assert!(matches!(admitted.outcome, ApplyOutcome::Published { .. }));
        assert_eq!(state.len(), QUEUE_CAPACITY);

        state.apply(NotificationCommand::RemoveStalePanes(vec![PaneId::from(
            "%0",
        )]));
        let retry = publish(
            &mut state,
            "retry-after-rejection",
            NotificationKind::Finished,
            "%rejected",
        );
        assert!(matches!(retry.outcome, ApplyOutcome::Published { .. }));
        assert_eq!(state.len(), QUEUE_CAPACITY);

        let mut dedup = NotificationState::new();
        dedup.apply(NotificationCommand::SetActiveClient(Some(
            ActiveClient::new("client", true, Some(PaneId::from("%focused"))),
        )));
        for index in 0..DEDUP_HISTORY_CAPACITY {
            let result = publish(
                &mut dedup,
                &format!("suppressed-{index}"),
                NotificationKind::Question,
                "%focused",
            );
            assert_eq!(result.outcome, ApplyOutcome::SuppressedByFocus);
        }
        assert_eq!(dedup.len(), 0);
        assert_eq!(dedup.remembered_event_count(), DEDUP_HISTORY_CAPACITY);
        assert_eq!(
            publish(
                &mut dedup,
                "suppressed-256",
                NotificationKind::Question,
                "%focused",
            )
            .outcome,
            ApplyOutcome::SuppressedByFocus
        );

        dedup.apply(NotificationCommand::SetActiveClient(Some(
            ActiveClient::new("client", false, Some(PaneId::from("%focused"))),
        )));
        let evicted_id = publish(
            &mut dedup,
            "suppressed-0",
            NotificationKind::Finished,
            "%other",
        );
        assert!(matches!(evicted_id.outcome, ApplyOutcome::Published { .. }));
        assert_eq!(dedup.remembered_event_count(), DEDUP_HISTORY_CAPACITY);
    }

    #[test]
    fn only_a_focused_active_client_on_the_origin_pane_suppresses() {
        let mut state = NotificationState::new();
        assert!(matches!(
            publish(&mut state, "no-client", NotificationKind::Error, "%1").outcome,
            ApplyOutcome::Published { .. }
        ));

        state.apply(NotificationCommand::SetActiveClient(Some(
            ActiveClient::new("client", true, None),
        )));
        assert!(matches!(
            publish(&mut state, "unknown-pane", NotificationKind::Error, "%2").outcome,
            ApplyOutcome::Published { .. }
        ));

        state.apply(NotificationCommand::SetActiveClient(Some(
            ActiveClient::new("client", false, Some(PaneId::from("%3"))),
        )));
        assert!(matches!(
            publish(&mut state, "unfocused", NotificationKind::Error, "%3").outcome,
            ApplyOutcome::Published { .. }
        ));

        state.apply(NotificationCommand::SetActiveClient(Some(
            ActiveClient::new("client", true, Some(PaneId::from("%4"))),
        )));
        assert!(matches!(
            publish(&mut state, "other-pane", NotificationKind::Error, "%3").outcome,
            ApplyOutcome::Published { .. }
        ));
        assert_eq!(
            publish(&mut state, "focused-origin", NotificationKind::Error, "%4").outcome,
            ApplyOutcome::SuppressedByFocus
        );
    }

    #[test]
    fn stale_pane_removal_is_bulk_and_does_not_touch_dedup_history() {
        let mut state = NotificationState::new();
        publish(&mut state, "one", NotificationKind::Error, "%1");
        publish(&mut state, "two", NotificationKind::Question, "%2");
        publish(&mut state, "three", NotificationKind::Finished, "%1");

        let result = state.apply(NotificationCommand::RemoveStalePanes(vec![
            PaneId::from("%1"),
            PaneId::from("%missing"),
        ]));
        assert_eq!(result.outcome, ApplyOutcome::RemovedStale { count: 2 });
        assert!(result.changed);
        assert_eq!(result.snapshot.len(), 1);
        assert_eq!(result.snapshot.items()[0].event_id().as_str(), "two");
        assert_eq!(state.remembered_event_count(), 3);
    }

    #[test]
    fn event_ids_are_validated_and_messages_are_bounded() {
        let mut state = NotificationState::new();
        for invalid_id in ["", "bad\nnewline", "bad\u{7f}", "é"] {
            let result = state.apply(NotificationCommand::Publish(NotificationEvent::new(
                NotificationKind::Error,
                invalid_id,
                "message",
                target("%invalid"),
            )));
            assert!(matches!(result.outcome, ApplyOutcome::Rejected(_)));
            assert!(!result.changed);
        }
        assert!(EventId::new("x".repeat(MAX_EVENT_ID_BYTES)).is_ok());
        assert_eq!(
            EventId::new("x".repeat(MAX_EVENT_ID_BYTES + 1)),
            Err(NotificationError::EventIdTooLong)
        );
        let result = state.apply(NotificationCommand::Publish(NotificationEvent::new(
            NotificationKind::Error,
            "x".repeat(MAX_EVENT_ID_BYTES + 1),
            "message",
            target("%invalid"),
        )));
        assert!(matches!(result.outcome, ApplyOutcome::Rejected(_)));
        assert!(!result.changed);
        assert!(state.is_empty());
        assert_eq!(state.remembered_event_count(), 0);

        let sanitized_message = "one\ntwo\rthree\tfour\u{1b}five\u{2028}six";
        let result = state.apply(NotificationCommand::Publish(NotificationEvent::new(
            NotificationKind::Finished,
            "sanitized",
            sanitized_message,
            target("%sanitized"),
        )));
        assert!(matches!(result.outcome, ApplyOutcome::Published { .. }));
        assert_eq!(
            result.snapshot.items()[0].message(),
            "one two three fourfive six"
        );

        let long_message = "界".repeat(MAX_MESSAGE_SCALARS + 1);
        let result = state.apply(NotificationCommand::Publish(NotificationEvent::new(
            NotificationKind::Error,
            "bounded",
            long_message,
            target("%bounded"),
        )));
        assert!(matches!(result.outcome, ApplyOutcome::Published { .. }));
        let message = result
            .snapshot
            .items()
            .iter()
            .find(|notification| notification.event_id().as_str() == "bounded")
            .expect("bounded notification is present")
            .message();
        assert_eq!(message, "界".repeat(MAX_MESSAGE_SCALARS));
        assert_eq!(message.chars().count(), MAX_MESSAGE_SCALARS);
        assert!(message.width() > 160);
        let row = state.render_status_row(12);
        assert!(visible_content(&row).width() <= 12);
        assert!(row.contains(ELLIPSIS));
    }

    #[test]
    fn stale_visible_token_cannot_dismiss_a_new_visible_item() {
        let mut state = NotificationState::new();
        let old = publish(&mut state, "old", NotificationKind::Finished, "%1");
        let old_sequence = published_sequence(&old);
        let current = publish(&mut state, "current", NotificationKind::Error, "%2");
        let current_sequence = published_sequence(&current);

        let stale = state.apply(NotificationCommand::Click(format!(
            "{VISIBLE_RANGE_PREFIX}{old_sequence}"
        )));
        assert_eq!(stale.outcome, ApplyOutcome::IgnoredClick);
        assert!(!stale.changed);
        assert_eq!(state.len(), 2);

        let more = state.apply(NotificationCommand::Click(MORE_RANGE_NAME.to_owned()));
        assert_eq!(more.outcome, ApplyOutcome::ClickedMore);
        assert_eq!(more.route, Some(RouteIntent::List));
        assert!(!more.changed);

        let clicked = state.apply(NotificationCommand::Click(format!(
            "{VISIBLE_RANGE_PREFIX}{current_sequence}"
        )));
        assert_eq!(
            clicked.outcome,
            ApplyOutcome::ClickedVisible {
                sequence: current_sequence
            }
        );
        assert_eq!(clicked.route, Some(RouteIntent::Pane(target("%2"))));
        assert_eq!(state.len(), 1);
    }

    #[test]
    fn rendering_is_bounded_clickable_and_safe_for_tmux_formats() {
        let empty = NotificationState::new();
        assert_eq!(empty.render_status_row(80), "");

        let mut one = NotificationState::new();
        publish(&mut one, "one", NotificationKind::Error, "%1");
        let row = one.render_status_row(80);
        assert!(row.contains("#[range=user|pane-dash-visible-1]"));
        assert!(!row.contains("pane-dash-more"));
        assert_eq!(row.matches("#[range=user|").count(), 1);
        assert_eq!(row.matches("#[norange]").count(), 1);
        assert!(visible_content(&row).width() <= 80);

        let mut hostile = NotificationState::new();
        let hostile_event = NotificationEvent::new(
            NotificationKind::Question,
            "hostile",
            "ask#now\nnext\t\u{1b}[31m界",
            target("%hostile"),
        );
        hostile.apply(NotificationCommand::Publish(hostile_event));
        let hostile_row = hostile.render_status_row(80);
        assert!(hostile_row.contains("##"));
        assert!(!hostile_row.contains('\n'));
        assert!(!hostile_row.contains('\t'));
        assert!(!hostile_row.contains('\u{1b}'));
        assert!(visible_content(&hostile_row).width() <= 80);
        assert!(
            hostile.snapshot().items()[0]
                .message()
                .chars()
                .all(|character| { !character.is_control() })
        );

        let mut many = NotificationState::new();
        publish(&mut many, "one", NotificationKind::Finished, "%1");
        publish(&mut many, "two", NotificationKind::Permission, "%2");
        let normal = many.render_status_row(80);
        assert!(normal.contains("#[range=user|pane-dash-visible-2]"));
        assert!(normal.contains("#[range=user|pane-dash-more]"));
        assert!(normal.contains("+1 more"));
        assert_eq!(normal.matches("#[range=user|").count(), 2);
        assert_eq!(normal.matches("#[norange]").count(), 2);
        assert!(visible_content(&normal).width() <= 80);

        let narrow = many.render_status_row(12);
        assert!(narrow.contains("#[range=user|pane-dash-visible-2]"));
        assert!(narrow.contains("#[range=user|pane-dash-more]"));
        assert!(narrow.contains("+1 more"));
        assert_eq!(narrow.matches("#[range=user|").count(), 2);
        assert!(visible_content(&narrow).width() <= 12);
    }
}
