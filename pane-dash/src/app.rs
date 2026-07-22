use std::cell::{RefCell, RefMut};
use std::collections::{HashMap, HashSet};

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

use crate::config::{ConfigWarning, LoadedUiConfig};
use crate::creation::{
    CreateContext, CreateDraft, CreateStage, CreationProgress, CreationResolution, SplitDirection,
    build_request, display_error,
};
use crate::filter::ranked_row_indices;
use crate::model::{Model, ModelConfig, PaneId, Row, SessionId, WindowId, is_discovered};
use crate::options::DashConfig;
use crate::preview::PreviewFrame;
use crate::snapshot::ParseOutcome;

type Selection = (SessionId, WindowId, PaneId);
const CREATION_VERIFICATION_TIMEOUT_SECS: u64 = 10;

pub use crate::creation::CreationId;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Grouped,
    Flat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputMode {
    Navigation,
    Filter,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    Jump {
        target: JumpTarget,
        zoom: bool,
    },
    ToggleGroup(bool),
    CapturePreview {
        sequence: u64,
        pane_id: PaneId,
    },
    SendText {
        pane_id: PaneId,
        text: String,
    },
    KillPane {
        pane_id: PaneId,
    },
    StartCreation {
        id: CreationId,
        request: crate::creation::CreateRequest,
    },
    CreationMutation,
    RefreshNow,
    Quit,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JumpTarget {
    Session(SessionId),
    Pane(PaneId),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Modal {
    Send {
        pane_id: PaneId,
        command: String,
        text: String,
    },
    Kill {
        pane_id: PaneId,
    },
    Create(CreateModal),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CreateChoiceKind {
    Right,
    Left,
    Bottom,
    Top,
    NewWindow,
    NewSession,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateChoice {
    pub label: &'static str,
    pub kind: CreateChoiceKind,
    pub context: CreateContext,
    pub cwd: String,
}

impl CreateChoice {
    pub fn new(kind: CreateChoiceKind, context: CreateContext, cwd: String) -> Self {
        let label = match kind {
            CreateChoiceKind::Right => "Split right",
            CreateChoiceKind::Left => "Split left",
            CreateChoiceKind::Bottom => "Split bottom",
            CreateChoiceKind::Top => "Split top",
            CreateChoiceKind::NewWindow => "New window",
            CreateChoiceKind::NewSession => "New session",
        };
        Self {
            label,
            kind,
            context,
            cwd,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CreateField {
    Name,
    Cwd,
    Command,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateForm {
    pub kind: CreateContext,
    pub field: CreateField,
    pub draft: CreateDraft,
    pub submitting: bool,
    pub error: Option<String>,
    pub linked_session_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CreateModal {
    Choice {
        choices: Vec<CreateChoice>,
        selected: usize,
    },
    Form(CreateForm),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PendingCreationState {
    Creating,
    Created {
        pane_id: PaneId,
    },
    Tagging {
        pane_id: PaneId,
    },
    Sending {
        pane_id: PaneId,
    },
    Entering {
        pane_id: PaneId,
    },
    AwaitingSnapshot {
        pane_id: PaneId,
        resolution: CreationResolution,
    },
    Error(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingCreation {
    pub id: CreationId,
    pub initiating_session: Option<SessionId>,
    pub state: PendingCreationState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActionOutcome {
    Success,
    Vanished,
    Failed(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompletedAction {
    Send,
    Kill,
}

#[derive(Debug)]
pub enum Event {
    Key(KeyEvent),
    Snapshot {
        outcome: ParseOutcome,
        observed_at: u64,
    },
    SnapshotFailed(String),
    Tick {
        now: u64,
    },
    PreviewTick,
    PreviewViewport(u16),
    TerminalFocus(bool),
    PreviewCaptured {
        sequence: u64,
        pane_id: PaneId,
        result: Result<PreviewFrame, String>,
    },
    ActionFinished {
        kind: CompletedAction,
        pane_id: PaneId,
        outcome: ActionOutcome,
    },
    CreationProgress(CreationProgress),
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct ReduceResult {
    pub actions: Vec<Action>,
    pub changed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) enum Focus {
    Header(SessionId),
    Pane(Selection),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviewState {
    pub target: Option<PaneId>,
    pub frame: Option<PreviewFrame>,
    pub error: Option<String>,
    pub inspect: bool,
    pub lines_from_bottom: usize,
    pub viewport_height: u16,
    pub terminal_focused: bool,
    pub next_sequence: u64,
    pub in_flight: Option<(u64, PaneId)>,
}

impl Default for PreviewState {
    fn default() -> Self {
        Self {
            target: None,
            frame: None,
            error: None,
            inspect: false,
            lines_from_bottom: 0,
            viewport_height: 20,
            terminal_focused: true,
            next_sequence: 0,
            in_flight: None,
        }
    }
}

#[derive(Default)]
pub(crate) struct RenderCache {
    revision: Option<u64>,
    pub visible_rows: Vec<usize>,
    pub focus_indices: HashMap<Focus, usize>,
    pub status_counts: [usize; 6],
    #[cfg(test)]
    rebuild_count: usize,
}

pub struct AppState {
    pub model: Model,
    pub cfg: DashConfig,
    palette: crate::palette::Palette,
    config_warnings: Box<[ConfigWarning]>,
    pub mode: Mode,
    pub input_mode: InputMode,
    pub filter_query: String,
    pub selection: Option<Selection>,
    pub collapsed: HashSet<SessionId>,
    pub should_quit: bool,
    pub pending_action: Option<Action>,
    pub consecutive_failures: u32,
    pub dropped_records: usize,
    pub banner: Option<String>,
    pub transport_degraded: bool,
    pub preview: PreviewState,
    pub modal: Option<Modal>,
    pub pending_creation: Option<PendingCreation>,
    pub ephemeral_panes: HashSet<PaneId>,
    reducer_now: Option<u64>,
    creation_verification_deadline: Option<u64>,
    focus: Option<Focus>,
    pending_key: Option<KeyCode>,
    render_cache: RefCell<RenderCache>,
    render_revision: u64,
    next_age_deadline: Option<u64>,
    age_deadline_revision: Option<u64>,
    next_creation_id: u64,
    #[cfg(test)]
    age_deadline_rebuild_count: usize,
}

impl AppState {
    pub fn new(model: Model, cfg: DashConfig, loaded_ui: LoadedUiConfig) -> Self {
        let mode = if model.grouped() {
            Mode::Grouped
        } else {
            Mode::Flat
        };
        Self {
            mode,
            model,
            cfg,
            palette: loaded_ui.palette,
            config_warnings: loaded_ui.warnings().into(),
            input_mode: InputMode::Navigation,
            filter_query: String::new(),
            selection: None,
            collapsed: HashSet::new(),
            should_quit: false,
            pending_action: None,
            consecutive_failures: 0,
            dropped_records: 0,
            banner: None,
            transport_degraded: false,
            preview: PreviewState::default(),
            modal: None,
            pending_creation: None,
            ephemeral_panes: HashSet::new(),
            reducer_now: None,
            creation_verification_deadline: None,
            focus: None,
            pending_key: None,
            render_cache: RefCell::new(RenderCache::default()),
            render_revision: 0,
            next_age_deadline: None,
            age_deadline_revision: None,
            next_creation_id: 1,
            #[cfg(test)]
            age_deadline_rebuild_count: 0,
        }
    }

    pub fn model_config(&self) -> ModelConfig {
        ModelConfig {
            match_pattern: self.cfg.match_pattern.clone(),
            stale_secs: self.cfg.stale_secs,
        }
    }

    pub fn palette(&self) -> &crate::palette::Palette {
        &self.palette
    }

    pub fn config_warnings(&self) -> &[ConfigWarning] {
        &self.config_warnings
    }

    fn grouped(&self) -> bool {
        self.mode == Mode::Grouped
    }

    pub(crate) fn focus(&self) -> Option<&Focus> {
        self.focus.as_ref()
    }

    pub fn selected_pane(&self) -> Option<PaneId> {
        match &self.focus {
            Some(Focus::Pane((_, _, pane_id))) => Some(pane_id.clone()),
            Some(Focus::Header(_)) | None => None,
        }
    }

    pub(crate) fn render_cache(&self) -> RefMut<'_, RenderCache> {
        let mut cache = self.render_cache.borrow_mut();
        if cache.revision != Some(self.render_revision) {
            cache.revision = Some(self.render_revision);
            #[cfg(test)]
            {
                cache.rebuild_count += 1;
            }
            cache.visible_rows.clear();
            cache.focus_indices.clear();
            cache.status_counts = [0; 6];

            let grouped = self.grouped();
            for index in ranked_row_indices(&self.model, grouped, &self.filter_query) {
                let row = &self.model.rows(grouped)[index];
                let focus = match row {
                    Row::SessionHeader { session_id, .. } => {
                        Some(Focus::Header(session_id.clone()))
                    }
                    Row::Pane {
                        session_id,
                        window_id,
                        pane_id,
                        ..
                    } if !self.session_is_collapsed(session_id) => Some(Focus::Pane((
                        session_id.clone(),
                        window_id.clone(),
                        pane_id.clone(),
                    ))),
                    Row::Pane { .. } => None,
                };
                if let Some(focus) = focus {
                    let visible_index = cache.visible_rows.len();
                    cache.visible_rows.push(index);
                    cache.focus_indices.insert(focus, visible_index);
                }
            }
            for pane in self.model.panes().values() {
                cache.status_counts[status_index(pane.status)] += 1;
            }
        }
        cache
    }

    pub fn prepare_render(&mut self, now: u64) {
        let cache = self.render_cache();
        let visible_rows = if self.age_deadline_revision != Some(self.render_revision) {
            cache.visible_rows.clone()
        } else {
            Vec::new()
        };
        drop(cache);
        if self.age_deadline_revision != Some(self.render_revision) {
            self.next_age_deadline = visible_rows
                .iter()
                .filter_map(|index| match &self.model.rows(self.grouped())[*index] {
                    Row::Pane {
                        status_since: Some(since),
                        ..
                    } => Some(next_age_boundary(*since, now)),
                    _ => None,
                })
                .min();
            self.age_deadline_revision = Some(self.render_revision);
            #[cfg(test)]
            {
                self.age_deadline_rebuild_count += 1;
            }
        }
    }

    fn invalidate_render_cache(&mut self) {
        self.render_revision = self.render_revision.wrapping_add(1);
        self.next_age_deadline = None;
        self.age_deadline_revision = None;
    }

    fn visible_rows(&self) -> Vec<Focus> {
        let grouped = self.grouped();
        let cache = self.render_cache();
        cache
            .visible_rows
            .iter()
            .map(|index| &self.model.rows(grouped)[*index])
            .map(|row| match row {
                Row::SessionHeader { session_id, .. } => Focus::Header(session_id.clone()),
                Row::Pane {
                    session_id,
                    window_id,
                    pane_id,
                    ..
                } => Focus::Pane((session_id.clone(), window_id.clone(), pane_id.clone())),
            })
            .collect()
    }

    pub(crate) fn session_is_collapsed(&self, session_id: &SessionId) -> bool {
        self.grouped() && self.filter_query.is_empty() && self.collapsed.contains(session_id)
    }

    fn reconcile_focus(&mut self) {
        let visible = self.visible_rows();
        if !self
            .focus
            .as_ref()
            .is_some_and(|focus| visible.contains(focus))
        {
            self.focus = visible.first().cloned();
        }
        self.sync_selection();
    }

    fn update_filter(&mut self, edit: impl FnOnce(&mut String)) {
        edit(&mut self.filter_query);
        self.invalidate_render_cache();
        self.reconcile_focus();
    }

    fn sync_selection(&mut self) {
        self.selection = match &self.focus {
            Some(Focus::Pane(selection)) => Some(selection.clone()),
            Some(Focus::Header(_)) | None => None,
        };
    }
}

pub fn reduce(state: &mut AppState, event: Event) -> ReduceResult {
    let mut result = match event {
        Event::Key(key) => reduce_key(state, key),
        Event::Snapshot {
            outcome,
            observed_at,
        } => reduce_snapshot(state, outcome, observed_at),
        Event::SnapshotFailed(error) => reduce_snapshot_failure(state, error),
        Event::Tick { now } => reduce_tick(state, now),
        Event::PreviewTick => reduce_preview_tick(state),
        Event::PreviewViewport(height) => reduce_preview_viewport(state, height),
        Event::TerminalFocus(focused) => reduce_terminal_focus(state, focused),
        Event::PreviewCaptured {
            sequence,
            pane_id,
            result,
        } => reduce_preview_captured(state, sequence, pane_id, result),
        Event::ActionFinished {
            kind,
            pane_id,
            outcome,
        } => reduce_action_finished(state, kind, pane_id, outcome),
        Event::CreationProgress(progress) => reduce_creation_progress(state, progress),
    };
    sync_preview_target(state, &mut result);
    result
}

fn reduce_action_finished(
    state: &mut AppState,
    kind: CompletedAction,
    pane_id: PaneId,
    outcome: ActionOutcome,
) -> ReduceResult {
    let message = match (kind, outcome) {
        (CompletedAction::Send, ActionOutcome::Success) => None,
        (CompletedAction::Send, ActionOutcome::Vanished) => {
            Some(format!("pane {} vanished, aborted", pane_id.0))
        }
        (CompletedAction::Send, ActionOutcome::Failed(error)) => Some(error),
        (CompletedAction::Kill, ActionOutcome::Failed(error)) => Some(error),
        (CompletedAction::Kill, ActionOutcome::Success | ActionOutcome::Vanished) => {
            return ReduceResult::default();
        }
    };
    let changed = state.banner != message;
    state.banner = message;
    ReduceResult {
        actions: Vec::new(),
        changed,
    }
}

fn sync_preview_target(state: &mut AppState, result: &mut ReduceResult) {
    let target = state.selected_pane();
    if state.preview.target == target {
        return;
    }
    state.preview.target = target;
    state.preview.frame = None;
    state.preview.error = None;
    state.preview.inspect = false;
    state.preview.lines_from_bottom = 0;
    state.preview.in_flight = None;
    if state.preview.target.is_some() {
        request_preview(state, result);
    }
    result.changed = true;
}

fn request_preview(state: &mut AppState, result: &mut ReduceResult) {
    let Some(pane_id) = state.preview.target.clone() else {
        return;
    };
    state.preview.next_sequence = state.preview.next_sequence.wrapping_add(1);
    let sequence = state.preview.next_sequence;
    state.preview.in_flight = Some((sequence, pane_id.clone()));
    if state.preview.terminal_focused {
        result
            .actions
            .push(Action::CapturePreview { sequence, pane_id });
    }
}

fn reduce_preview_tick(state: &mut AppState) -> ReduceResult {
    let mut result = ReduceResult::default();
    if state.preview.target.is_some()
        && !state.preview.inspect
        && state.preview.terminal_focused
        && state.preview.in_flight.is_none()
    {
        request_preview(state, &mut result);
    }
    result
}

fn reduce_preview_viewport(state: &mut AppState, height: u16) -> ReduceResult {
    let old_height = state.preview.viewport_height;
    let old_offset = state.preview.lines_from_bottom;
    state.preview.viewport_height = height;
    clamp_preview_offset(state);
    ReduceResult {
        actions: Vec::new(),
        changed: old_height != height || old_offset != state.preview.lines_from_bottom,
    }
}

fn reduce_terminal_focus(state: &mut AppState, focused: bool) -> ReduceResult {
    if state.preview.terminal_focused == focused {
        return ReduceResult::default();
    }
    state.preview.terminal_focused = focused;
    if !focused {
        state.preview.in_flight = None;
        return ReduceResult {
            actions: Vec::new(),
            changed: true,
        };
    }
    let mut result = ReduceResult {
        actions: Vec::new(),
        changed: true,
    };
    if state.preview.target.is_some() && !state.preview.inspect {
        request_preview(state, &mut result);
    }
    result
}

fn reduce_preview_captured(
    state: &mut AppState,
    sequence: u64,
    pane_id: PaneId,
    result: Result<PreviewFrame, String>,
) -> ReduceResult {
    if state.preview.target.as_ref() != Some(&pane_id)
        || state.preview.in_flight.as_ref() != Some(&(sequence, pane_id.clone()))
    {
        return ReduceResult::default();
    }
    let old_frame = state.preview.frame.clone();
    let old_error = state.preview.error.clone();
    let old_offset = state.preview.lines_from_bottom;
    state.preview.in_flight = None;
    match result {
        Ok(frame) => {
            state.preview.frame = Some(frame);
            state.preview.error = None;
            state.preview.lines_from_bottom = 0;
        }
        Err(error) => {
            state.preview.frame = None;
            state.preview.error = Some(short_preview_error(error));
        }
    }
    ReduceResult {
        actions: Vec::new(),
        changed: state.preview.frame != old_frame
            || state.preview.error != old_error
            || state.preview.lines_from_bottom != old_offset,
    }
}

fn short_preview_error(error: String) -> String {
    let error = error.lines().next().unwrap_or_default().trim();
    let short = error.chars().take(160).collect::<String>();
    if short.is_empty() {
        "preview capture failed".into()
    } else {
        short
    }
}

fn clamp_preview_offset(state: &mut AppState) {
    let line_count = state
        .preview
        .frame
        .as_ref()
        .map_or(0, |frame| frame.lines.len());
    let max_offset = line_count.saturating_sub(usize::from(state.preview.viewport_height));
    state.preview.lines_from_bottom = state.preview.lines_from_bottom.min(max_offset);
}

fn reduce_tick(state: &mut AppState, now: u64) -> ReduceResult {
    observe_creation_time(state, now);
    let age_changed = state
        .next_age_deadline
        .is_some_and(|deadline| now >= deadline);
    if age_changed {
        state.age_deadline_revision = None;
    }
    let verification_changed = expire_creation_verification(state, now);
    ReduceResult {
        actions: Vec::new(),
        changed: age_changed || verification_changed,
    }
}

fn observe_creation_time(state: &mut AppState, now: u64) {
    if state.reducer_now.is_none_or(|previous| now > previous) {
        state.reducer_now = Some(now);
    }
    if matches!(
        state
            .pending_creation
            .as_ref()
            .map(|pending| &pending.state),
        Some(PendingCreationState::AwaitingSnapshot { .. })
    ) && state.creation_verification_deadline.is_none()
    {
        state.creation_verification_deadline = Some(now + CREATION_VERIFICATION_TIMEOUT_SECS);
    }
}

fn expire_creation_verification(state: &mut AppState, now: u64) -> bool {
    if state
        .creation_verification_deadline
        .is_none_or(|deadline| now < deadline)
    {
        return false;
    }
    let Some(PendingCreation {
        state: PendingCreationState::AwaitingSnapshot { pane_id, .. },
        ..
    }) = state.pending_creation.take()
    else {
        return false;
    };
    state.creation_verification_deadline = None;
    state.banner = Some(format!(
        "unable to verify pane {} after creation",
        pane_id.0
    ));
    state.invalidate_render_cache();
    true
}

fn next_age_boundary(since: u64, now: u64) -> u64 {
    let age = now.saturating_sub(since);
    let unit = if age < 60 {
        1
    } else if age < 3_600 {
        60
    } else if age < 86_400 {
        3_600
    } else {
        86_400
    };
    since.saturating_add((age / unit + 1).saturating_mul(unit))
}

pub fn format_age(status_since: Option<u64>, now: u64) -> String {
    let Some(since) = status_since else {
        return "-".into();
    };
    let age = now.saturating_sub(since);
    if age >= 86_400 {
        format!("{}d", age / 86_400)
    } else if age >= 3_600 {
        format!("{}h", age / 3_600)
    } else if age >= 60 {
        format!("{}m", age / 60)
    } else {
        format!("{age}s")
    }
}

pub(crate) fn status_index(status: crate::model::Status) -> usize {
    match status {
        crate::model::Status::NeedsInput => 0,
        crate::model::Status::Working => 1,
        crate::model::Status::Idle => 2,
        crate::model::Status::Error => 3,
        crate::model::Status::Unknown => 4,
        crate::model::Status::Stale => 5,
    }
}

fn reduce_key(state: &mut AppState, key: KeyEvent) -> ReduceResult {
    if state.modal.is_some() {
        return reduce_modal_key(state, key);
    }
    let mut result = ReduceResult::default();
    if key.code == KeyCode::Char('s') && key.modifiers == KeyModifiers::CONTROL {
        return open_send_modal(state);
    }
    if key.modifiers == KeyModifiers::CONTROL {
        match key.code {
            KeyCode::Char('u') => {
                result.changed = inspect_preview(state, true);
                return result;
            }
            KeyCode::Char('d') => {
                result.changed = inspect_preview(state, false);
                return result;
            }
            KeyCode::Char('r') => {
                let changed = state.preview.inspect || state.preview.lines_from_bottom != 0;
                state.preview.inspect = false;
                state.preview.lines_from_bottom = 0;
                if state.preview.target.is_some() && state.preview.terminal_focused {
                    request_preview(state, &mut result);
                    result.changed = true;
                } else {
                    result.changed = changed;
                }
                return result;
            }
            _ => {}
        }
    }
    if state.input_mode == InputMode::Filter {
        match key.code {
            KeyCode::Esc => {
                state.input_mode = InputMode::Navigation;
                result.changed = true;
            }
            KeyCode::Backspace if !state.filter_query.is_empty() => {
                state.update_filter(|query| {
                    query.pop();
                });
                result.changed = true;
            }
            KeyCode::Char(character)
                if key.modifiers == KeyModifiers::NONE || key.modifiers == KeyModifiers::SHIFT =>
            {
                state.update_filter(|query| query.push(character));
                result.changed = true;
            }
            _ => {}
        }
        return result;
    }
    if state.pending_key.take().is_some() {
        if key.code == KeyCode::Char('a') && key.modifiers == KeyModifiers::NONE {
            toggle_collapsed(state, &mut result);
        }
        return result;
    }
    let mut move_focus = |offset: isize| {
        let visible = state.visible_rows();
        if visible.is_empty() {
            return;
        }
        let index = state
            .focus
            .as_ref()
            .and_then(|focus| visible.iter().position(|row| row == focus));
        let next = match (index, offset) {
            (Some(index), offset) => {
                (index as isize + offset).clamp(0, visible.len() as isize - 1) as usize
            }
            (None, offset) if offset < 0 => visible.len() - 1,
            (None, _) => 0,
        };
        if state.focus.as_ref() != Some(&visible[next]) {
            state.focus = Some(visible[next].clone());
            state.sync_selection();
            result.changed = true;
        }
    };

    match key.code {
        KeyCode::Enter => emit_jump(state, false, &mut result),
        KeyCode::Char('/') if key.modifiers == KeyModifiers::NONE => {
            state.input_mode = InputMode::Filter;
            result.changed = true;
        }
        KeyCode::Char('j') | KeyCode::Down => move_focus(1),
        KeyCode::Char('k') | KeyCode::Up => move_focus(-1),
        KeyCode::Char('g') => set_focus(state, 0, &mut result),
        KeyCode::Char('G') => {
            let last = state.visible_rows().len().saturating_sub(1);
            set_focus(state, last, &mut result);
        }
        KeyCode::Char('h') => set_collapsed(state, true, &mut result),
        KeyCode::Char('l') => set_collapsed(state, false, &mut result),
        KeyCode::Char('z') if key.modifiers == KeyModifiers::NONE => {
            state.pending_key = Some(KeyCode::Char('z'))
        }
        KeyCode::Char('s') if key.modifiers == KeyModifiers::NONE => {
            state.mode = if state.grouped() {
                Mode::Flat
            } else {
                Mode::Grouped
            };
            state.pending_key = None;
            state.invalidate_render_cache();
            state.reconcile_focus();
            result.actions.push(Action::ToggleGroup(state.grouped()));
            result.changed = true;
        }
        KeyCode::Char('x') if key.modifiers == KeyModifiers::NONE => {
            return open_kill_modal(state);
        }
        KeyCode::Char('n') if key.modifiers == KeyModifiers::NONE => {
            return open_create_modal(state);
        }
        KeyCode::Char('z') if key.modifiers == KeyModifiers::CONTROL => {
            emit_jump(state, true, &mut result)
        }
        KeyCode::Char('q') | KeyCode::Esc => {
            state.should_quit = true;
            result.actions.push(Action::Quit);
            result.changed = true;
        }
        _ => {}
    }
    result
}

fn open_send_modal(state: &mut AppState) -> ReduceResult {
    let Some(pane_id) = state.selected_pane() else {
        let message = Some("select a pane, not a session".into());
        let changed = state.banner != message;
        state.banner = message;
        return ReduceResult {
            actions: Vec::new(),
            changed,
        };
    };
    let command = state
        .model
        .panes()
        .get(&pane_id)
        .map(|pane| pane.command.clone())
        .unwrap_or_default();
    let modal = Some(Modal::Send {
        pane_id,
        command,
        text: String::new(),
    });
    let changed = state.modal != modal;
    state.modal = modal;
    ReduceResult {
        actions: Vec::new(),
        changed,
    }
}

fn open_kill_modal(state: &mut AppState) -> ReduceResult {
    let Some(pane_id) = state.selected_pane() else {
        let message = Some("select a pane, not a session".into());
        let changed = state.banner != message;
        state.banner = message;
        return ReduceResult {
            actions: Vec::new(),
            changed,
        };
    };
    let modal = Some(Modal::Kill { pane_id });
    let changed = state.modal != modal;
    state.modal = modal;
    ReduceResult {
        actions: Vec::new(),
        changed,
    }
}

fn open_create_modal(state: &mut AppState) -> ReduceResult {
    if state.pending_creation.is_some() {
        return ReduceResult::default();
    }
    let modal = if state.model.panes().is_empty() {
        CreateModal::Form(create_form(
            CreateContext::NewSession,
            String::new(),
            state.cfg.new_command.clone(),
        ))
    } else {
        let choices = match &state.focus {
            Some(Focus::Pane((session_id, _, pane_id))) => {
                pane_create_choices(state, session_id, pane_id)
            }
            Some(Focus::Header(session_id)) => {
                let cwd = session_default_cwd(state, session_id);
                vec![
                    CreateChoice::new(
                        CreateChoiceKind::NewWindow,
                        CreateContext::NewWindow {
                            target: session_id.clone(),
                        },
                        cwd.clone(),
                    ),
                    CreateChoice::new(CreateChoiceKind::NewSession, CreateContext::NewSession, cwd),
                ]
            }
            None => vec![CreateChoice::new(
                CreateChoiceKind::NewSession,
                CreateContext::NewSession,
                String::new(),
            )],
        };
        CreateModal::Choice {
            choices,
            selected: 0,
        }
    };
    state.modal = Some(Modal::Create(modal));
    ReduceResult {
        actions: Vec::new(),
        changed: true,
    }
}

fn pane_create_choices(
    state: &AppState,
    session_id: &SessionId,
    pane_id: &PaneId,
) -> Vec<CreateChoice> {
    let cwd = state
        .model
        .panes()
        .get(pane_id)
        .map(|pane| pane.path.clone())
        .unwrap_or_default();
    let linked_session_count = state
        .model
        .memberships()
        .iter()
        .filter(|membership| membership.pane_id == *pane_id)
        .map(|membership| &membership.session_id)
        .collect::<HashSet<_>>()
        .len();
    let split = |kind, direction| {
        CreateChoice::new(
            kind,
            CreateContext::Split {
                target: pane_id.clone(),
                initiating_session: session_id.clone(),
                linked_session_count,
                direction,
            },
            cwd.clone(),
        )
    };
    vec![
        split(CreateChoiceKind::Right, SplitDirection::Right),
        split(CreateChoiceKind::Left, SplitDirection::Left),
        split(CreateChoiceKind::Bottom, SplitDirection::Bottom),
        split(CreateChoiceKind::Top, SplitDirection::Top),
        CreateChoice::new(
            CreateChoiceKind::NewWindow,
            CreateContext::NewWindow {
                target: session_id.clone(),
            },
            cwd.clone(),
        ),
        CreateChoice::new(CreateChoiceKind::NewSession, CreateContext::NewSession, cwd),
    ]
}

fn session_default_cwd(state: &AppState, session_id: &SessionId) -> String {
    let mut memberships: Vec<_> = state
        .model
        .memberships()
        .iter()
        .filter(|membership| &membership.session_id == session_id)
        .collect();
    memberships.sort_by_key(|membership| {
        (
            membership.window_index,
            membership.pane_index,
            membership.window_id.clone(),
            membership.pane_id.clone(),
        )
    });
    memberships
        .iter()
        .find(|membership| membership.pane_active)
        .or_else(|| memberships.first())
        .and_then(|membership| state.model.panes().get(&membership.pane_id))
        .map(|pane| pane.path.clone())
        .unwrap_or_default()
}

fn create_form(kind: CreateContext, cwd: String, command: String) -> CreateForm {
    let linked_session_count = match &kind {
        CreateContext::Split {
            linked_session_count,
            ..
        } => *linked_session_count,
        CreateContext::NewWindow { .. } | CreateContext::NewSession => 0,
    };
    let field = if matches!(kind, CreateContext::Split { .. }) {
        CreateField::Cwd
    } else {
        CreateField::Name
    };
    CreateForm {
        kind,
        field,
        draft: CreateDraft {
            name: String::new(),
            cwd,
            command,
        },
        submitting: false,
        error: None,
        linked_session_count,
    }
}

fn reduce_modal_key(state: &mut AppState, key: KeyEvent) -> ReduceResult {
    let Some(modal) = state.modal.take() else {
        return ReduceResult::default();
    };
    match modal {
        Modal::Send {
            pane_id,
            command,
            mut text,
        } => match key.code {
            KeyCode::Esc => ReduceResult {
                actions: Vec::new(),
                changed: true,
            },
            KeyCode::Backspace if !text.is_empty() => {
                text.pop();
                state.modal = Some(Modal::Send {
                    pane_id,
                    command,
                    text,
                });
                ReduceResult {
                    actions: Vec::new(),
                    changed: true,
                }
            }
            KeyCode::Enter => ReduceResult {
                actions: (!text.is_empty())
                    .then_some(Action::SendText { pane_id, text })
                    .into_iter()
                    .collect(),
                changed: true,
            },
            KeyCode::Char(character)
                if key.modifiers == KeyModifiers::NONE || key.modifiers == KeyModifiers::SHIFT =>
            {
                text.push(character);
                state.modal = Some(Modal::Send {
                    pane_id,
                    command,
                    text,
                });
                ReduceResult {
                    actions: Vec::new(),
                    changed: true,
                }
            }
            _ => {
                state.modal = Some(Modal::Send {
                    pane_id,
                    command,
                    text,
                });
                ReduceResult::default()
            }
        },
        Modal::Kill { pane_id } => match key.code {
            KeyCode::Char('y' | 'Y')
                if key.modifiers == KeyModifiers::NONE || key.modifiers == KeyModifiers::SHIFT =>
            {
                ReduceResult {
                    actions: vec![Action::KillPane { pane_id }],
                    changed: true,
                }
            }
            _ => ReduceResult {
                actions: Vec::new(),
                changed: true,
            },
        },
        Modal::Create(modal) => reduce_create_modal_key(state, modal, key),
    }
}

fn reduce_create_modal_key(
    state: &mut AppState,
    modal: CreateModal,
    key: KeyEvent,
) -> ReduceResult {
    match modal {
        CreateModal::Choice {
            choices,
            mut selected,
        } => match key.code {
            KeyCode::Esc => ReduceResult {
                actions: Vec::new(),
                changed: true,
            },
            KeyCode::Char('j') | KeyCode::Down => {
                selected = (selected + 1).min(choices.len().saturating_sub(1));
                state.modal = Some(Modal::Create(CreateModal::Choice { choices, selected }));
                ReduceResult {
                    actions: Vec::new(),
                    changed: true,
                }
            }
            KeyCode::Char('k') | KeyCode::Up => {
                selected = selected.saturating_sub(1);
                state.modal = Some(Modal::Create(CreateModal::Choice { choices, selected }));
                ReduceResult {
                    actions: Vec::new(),
                    changed: true,
                }
            }
            KeyCode::Enter => {
                let Some(choice) = choices.get(selected) else {
                    state.modal = Some(Modal::Create(CreateModal::Choice { choices, selected }));
                    return ReduceResult::default();
                };
                let context = choice.context.clone();
                let cwd = choice.cwd.clone();
                state.modal = Some(Modal::Create(CreateModal::Form(create_form(
                    context,
                    cwd,
                    state.cfg.new_command.clone(),
                ))));
                ReduceResult {
                    actions: Vec::new(),
                    changed: true,
                }
            }
            _ => {
                state.modal = Some(Modal::Create(CreateModal::Choice { choices, selected }));
                ReduceResult::default()
            }
        },
        CreateModal::Form(form) if form.submitting => {
            if matches!(key.code, KeyCode::Char('q') | KeyCode::Esc) {
                state.should_quit = true;
                ReduceResult {
                    actions: vec![Action::Quit],
                    changed: true,
                }
            } else {
                state.modal = Some(Modal::Create(CreateModal::Form(form)));
                ReduceResult::default()
            }
        }
        CreateModal::Form(mut form) => reduce_create_form_key(state, &mut form, key),
    }
}

fn reduce_create_form_key(
    state: &mut AppState,
    form: &mut CreateForm,
    key: KeyEvent,
) -> ReduceResult {
    match key.code {
        KeyCode::Esc => {
            if matches!(
                state.pending_creation,
                Some(PendingCreation {
                    state: PendingCreationState::Error(_),
                    ..
                })
            ) {
                state.pending_creation = None;
            }
            ReduceResult {
                actions: Vec::new(),
                changed: true,
            }
        }
        KeyCode::Tab | KeyCode::Down => {
            form.field = next_create_field(&form.kind, form.field, true);
            state.modal = Some(Modal::Create(CreateModal::Form(form.clone())));
            ReduceResult {
                actions: Vec::new(),
                changed: true,
            }
        }
        KeyCode::BackTab | KeyCode::Up => {
            form.field = next_create_field(&form.kind, form.field, false);
            state.modal = Some(Modal::Create(CreateModal::Form(form.clone())));
            ReduceResult {
                actions: Vec::new(),
                changed: true,
            }
        }
        KeyCode::Backspace => {
            create_field_value_mut(form).pop();
            state.modal = Some(Modal::Create(CreateModal::Form(form.clone())));
            ReduceResult {
                actions: Vec::new(),
                changed: true,
            }
        }
        KeyCode::Char(character)
            if key.modifiers == KeyModifiers::NONE || key.modifiers == KeyModifiers::SHIFT =>
        {
            create_field_value_mut(form).push(character);
            state.modal = Some(Modal::Create(CreateModal::Form(form.clone())));
            ReduceResult {
                actions: Vec::new(),
                changed: true,
            }
        }
        KeyCode::Enter => match build_request(form.kind.clone(), &form.draft) {
            Err(error) => {
                form.error = Some(display_error(&error.to_string()));
                state.modal = Some(Modal::Create(CreateModal::Form(form.clone())));
                ReduceResult {
                    actions: Vec::new(),
                    changed: true,
                }
            }
            Ok(request) => {
                let id = CreationId(state.next_creation_id);
                state.next_creation_id = state
                    .next_creation_id
                    .checked_add(1)
                    .expect("creation ID exhausted");
                state.pending_creation = Some(PendingCreation {
                    id,
                    initiating_session: match &form.kind {
                        CreateContext::Split {
                            initiating_session, ..
                        } => Some(initiating_session.clone()),
                        CreateContext::NewWindow { target } => Some(target.clone()),
                        CreateContext::NewSession => None,
                    },
                    state: PendingCreationState::Creating,
                });
                form.submitting = true;
                form.error = None;
                state.modal = Some(Modal::Create(CreateModal::Form(form.clone())));
                ReduceResult {
                    actions: vec![Action::StartCreation { id, request }],
                    changed: true,
                }
            }
        },
        _ => {
            state.modal = Some(Modal::Create(CreateModal::Form(form.clone())));
            ReduceResult::default()
        }
    }
}

fn create_field_value_mut(form: &mut CreateForm) -> &mut String {
    match form.field {
        CreateField::Name => &mut form.draft.name,
        CreateField::Cwd => &mut form.draft.cwd,
        CreateField::Command => &mut form.draft.command,
    }
}

fn next_create_field(context: &CreateContext, field: CreateField, forward: bool) -> CreateField {
    let fields = if matches!(context, CreateContext::Split { .. }) {
        [CreateField::Cwd, CreateField::Command].as_slice()
    } else {
        [CreateField::Name, CreateField::Cwd, CreateField::Command].as_slice()
    };
    let index = fields
        .iter()
        .position(|candidate| *candidate == field)
        .unwrap_or(0);
    let next = if forward {
        (index + 1) % fields.len()
    } else {
        (index + fields.len() - 1) % fields.len()
    };
    fields[next]
}

fn reduce_creation_progress(state: &mut AppState, progress: CreationProgress) -> ReduceResult {
    let id = match &progress {
        CreationProgress::Stage { id, .. }
        | CreationProgress::CreateFailed { id, .. }
        | CreationProgress::Created { id, .. }
        | CreationProgress::Finished { id, .. }
        | CreationProgress::TimedOut { id }
        | CreationProgress::TaskFailed { id, .. } => *id,
    };
    if state.pending_creation.as_ref().map(|pending| pending.id) != Some(id) {
        return ReduceResult::default();
    }

    match progress {
        CreationProgress::CreateFailed { error, .. } => {
            if !matches!(
                state
                    .pending_creation
                    .as_ref()
                    .map(|pending| &pending.state),
                Some(PendingCreationState::Creating)
            ) {
                return ReduceResult::default();
            }
            let error = display_error(&error);
            if let Some(pending) = state.pending_creation.as_mut() {
                pending.state = PendingCreationState::Error(error.clone());
            }
            if let Some(Modal::Create(CreateModal::Form(form))) = state.modal.as_mut() {
                form.submitting = false;
                form.error = Some(error);
            }
            state.invalidate_render_cache();
            ReduceResult {
                actions: Vec::new(),
                changed: true,
            }
        }
        CreationProgress::Created { pane_id, .. } => {
            if !matches!(
                state
                    .pending_creation
                    .as_ref()
                    .map(|pending| &pending.state),
                Some(PendingCreationState::Creating)
            ) {
                return ReduceResult::default();
            }
            if let Some(pending) = state.pending_creation.as_mut() {
                pending.state = PendingCreationState::Created { pane_id };
            }
            state.modal = None;
            state.invalidate_render_cache();
            ReduceResult {
                actions: Vec::new(),
                changed: true,
            }
        }
        CreationProgress::Stage { stage, pane_id, .. } => {
            let Some(pane_id) = pane_id else {
                return ReduceResult::default();
            };
            if let Some(next) =
                next_creation_stage(state.pending_creation.as_ref(), stage, &pane_id)
                && let Some(pending) = state.pending_creation.as_mut()
            {
                pending.state = next;
                state.invalidate_render_cache();
                return ReduceResult {
                    actions: Vec::new(),
                    changed: true,
                };
            }
            ReduceResult::default()
        }
        CreationProgress::Finished {
            pane_id,
            resolution,
            ..
        } => finish_creation(state, pane_id, resolution),
        CreationProgress::TimedOut { .. } => {
            if matches!(
                state
                    .pending_creation
                    .as_ref()
                    .map(|pending| &pending.state),
                Some(PendingCreationState::Creating)
            ) {
                let error = "creation timed out".to_owned();
                if let Some(pending) = state.pending_creation.as_mut() {
                    pending.state = PendingCreationState::Error(error.clone());
                }
                if let Some(Modal::Create(CreateModal::Form(form))) = state.modal.as_mut() {
                    form.submitting = false;
                    form.error = Some(error);
                }
                state.invalidate_render_cache();
                return ReduceResult {
                    actions: Vec::new(),
                    changed: true,
                };
            }
            let Some((pane_id, stage)) = pending_timeout_target(state.pending_creation.as_ref())
            else {
                return ReduceResult::default();
            };
            finish_creation(state, pane_id, CreationResolution::TimedOut { stage })
        }
        CreationProgress::TaskFailed { error, .. } => {
            if matches!(
                state
                    .pending_creation
                    .as_ref()
                    .map(|pending| &pending.state),
                Some(PendingCreationState::Creating)
            ) {
                return reduce_creation_progress(
                    state,
                    CreationProgress::CreateFailed { id, error },
                );
            }
            let Some((pane_id, stage)) = pending_timeout_target(state.pending_creation.as_ref())
            else {
                return ReduceResult::default();
            };
            let resolution = if stage == CreateStage::Tag {
                CreationResolution::TagFailed(error)
            } else {
                CreationResolution::CommandFailed { stage, error }
            };
            finish_creation(state, pane_id, resolution)
        }
    }
}

fn next_creation_stage(
    pending: Option<&PendingCreation>,
    stage: CreateStage,
    pane_id: &PaneId,
) -> Option<PendingCreationState> {
    match (&pending?.state, stage) {
        (PendingCreationState::Created { pane_id: bound }, CreateStage::Tag)
            if bound == pane_id =>
        {
            Some(PendingCreationState::Tagging {
                pane_id: pane_id.clone(),
            })
        }
        (PendingCreationState::Tagging { pane_id: bound }, CreateStage::SendCommand)
            if bound == pane_id =>
        {
            Some(PendingCreationState::Sending {
                pane_id: pane_id.clone(),
            })
        }
        (PendingCreationState::Sending { pane_id: bound }, CreateStage::SendEnter)
            if bound == pane_id =>
        {
            Some(PendingCreationState::Entering {
                pane_id: pane_id.clone(),
            })
        }
        _ => None,
    }
}

fn pending_timeout_target(pending: Option<&PendingCreation>) -> Option<(PaneId, CreateStage)> {
    match &pending?.state {
        PendingCreationState::Created { pane_id } | PendingCreationState::Tagging { pane_id } => {
            Some((pane_id.clone(), CreateStage::Tag))
        }
        PendingCreationState::Sending { pane_id } => {
            Some((pane_id.clone(), CreateStage::SendCommand))
        }
        PendingCreationState::Entering { pane_id } => {
            Some((pane_id.clone(), CreateStage::SendEnter))
        }
        PendingCreationState::Creating
        | PendingCreationState::AwaitingSnapshot { .. }
        | PendingCreationState::Error(_) => None,
    }
}

fn finish_creation(
    state: &mut AppState,
    pane_id: PaneId,
    resolution: CreationResolution,
) -> ReduceResult {
    let Some(pending) = state.pending_creation.as_mut() else {
        return ReduceResult::default();
    };
    if !matches!(
        (&pending.state, &resolution),
        (PendingCreationState::Created { pane_id: bound }, CreationResolution::TimedOut { stage: CreateStage::Tag })
            | (PendingCreationState::Created { pane_id: bound }, CreationResolution::TagFailed(_))
            | (PendingCreationState::Tagging { pane_id: bound }, CreationResolution::Success)
            | (PendingCreationState::Tagging { pane_id: bound }, CreationResolution::TagFailed(_))
            | (PendingCreationState::Tagging { pane_id: bound }, CreationResolution::TimedOut { stage: CreateStage::Tag })
            | (PendingCreationState::Sending { pane_id: bound }, CreationResolution::CommandFailed { stage: CreateStage::SendCommand, .. })
            | (PendingCreationState::Sending { pane_id: bound }, CreationResolution::TimedOut { stage: CreateStage::SendCommand })
            | (PendingCreationState::Entering { pane_id: bound }, CreationResolution::Success)
            | (PendingCreationState::Entering { pane_id: bound }, CreationResolution::CommandFailed { stage: CreateStage::SendEnter, .. })
            | (PendingCreationState::Entering { pane_id: bound }, CreationResolution::TimedOut { stage: CreateStage::SendEnter })
            if bound == &pane_id
    ) {
        return ReduceResult::default();
    }
    let resolution = match resolution {
        CreationResolution::TagFailed(error) => {
            CreationResolution::TagFailed(display_error(&error))
        }
        CreationResolution::CommandFailed { stage, error } => CreationResolution::CommandFailed {
            stage,
            error: display_error(&error),
        },
        resolution => resolution,
    };
    pending.state = PendingCreationState::AwaitingSnapshot {
        pane_id,
        resolution,
    };
    state.creation_verification_deadline = state
        .reducer_now
        .map(|now| now + CREATION_VERIFICATION_TIMEOUT_SECS);
    state.invalidate_render_cache();
    ReduceResult {
        actions: vec![Action::CreationMutation, Action::RefreshNow],
        changed: true,
    }
}

fn inspect_preview(state: &mut AppState, up: bool) -> bool {
    let old_inspect = state.preview.inspect;
    let old_in_flight = state.preview.in_flight.clone();
    let old_offset = state.preview.lines_from_bottom;
    state.preview.inspect = true;
    state.preview.in_flight = None;
    let half_page = usize::from(state.preview.viewport_height / 2).max(1);
    if up {
        let line_count = state
            .preview
            .frame
            .as_ref()
            .map_or(0, |frame| frame.lines.len());
        let max_offset = line_count.saturating_sub(usize::from(state.preview.viewport_height));
        state.preview.lines_from_bottom = state
            .preview
            .lines_from_bottom
            .saturating_add(half_page)
            .min(max_offset);
    } else {
        state.preview.lines_from_bottom = state.preview.lines_from_bottom.saturating_sub(half_page);
    }
    state.preview.inspect != old_inspect
        || state.preview.in_flight != old_in_flight
        || state.preview.lines_from_bottom != old_offset
}

fn set_focus(state: &mut AppState, index: usize, result: &mut ReduceResult) {
    let visible = state.visible_rows();
    let Some(focus) = visible.get(index) else {
        return;
    };
    if state.focus.as_ref() != Some(focus) {
        state.focus = Some(focus.clone());
        state.sync_selection();
        result.changed = true;
    }
}

fn session_at_focus(state: &AppState) -> Option<SessionId> {
    match &state.focus {
        Some(Focus::Header(session_id)) => Some(session_id.clone()),
        Some(Focus::Pane((session_id, _, _))) => Some(session_id.clone()),
        None => None,
    }
}

fn set_collapsed(state: &mut AppState, collapsed: bool, result: &mut ReduceResult) {
    if !state.grouped() {
        return;
    }
    let Some(session_id) = session_at_focus(state) else {
        return;
    };
    let header_session = session_id.clone();
    if if collapsed {
        state.collapsed.insert(session_id)
    } else {
        state.collapsed.remove(&session_id)
    } {
        if collapsed {
            state.focus = Some(Focus::Header(header_session));
            state.sync_selection();
        }
        state.invalidate_render_cache();
        result.changed = true;
    }
}

fn toggle_collapsed(state: &mut AppState, result: &mut ReduceResult) {
    let Some(session_id) = session_at_focus(state) else {
        return;
    };
    set_collapsed(state, !state.collapsed.contains(&session_id), result);
}

fn emit_jump(state: &mut AppState, zoom: bool, result: &mut ReduceResult) {
    let (target, zoom) = match &state.focus {
        Some(Focus::Pane((_, _, pane_id))) => (Some(JumpTarget::Pane(pane_id.clone())), zoom),
        Some(Focus::Header(session_id)) => (Some(JumpTarget::Session(session_id.clone())), false),
        None => (None, false),
    };
    if let Some(target) = target {
        let action = Action::Jump { target, zoom };
        state.pending_action = Some(action.clone());
        result.actions.push(action);
        result.changed = true;
    }
}

fn reduce_snapshot(state: &mut AppState, outcome: ParseOutcome, observed_at: u64) -> ReduceResult {
    observe_creation_time(state, observed_at);
    let old_visible = state.visible_rows();
    let old_focus = state.focus.clone();
    let dropped_changed = state.dropped_records != outcome.dropped;
    let awaiting_snapshot = matches!(
        state
            .pending_creation
            .as_ref()
            .map(|pending| &pending.state),
        Some(PendingCreationState::AwaitingSnapshot { .. })
    );
    let model_config = state.model_config();
    let selection = reconcile_snapshot_presence(state, &outcome, &model_config);
    let verification_expired = expire_creation_verification(state, observed_at);
    let creation_resolved = awaiting_snapshot && state.pending_creation.is_none();
    let model = Model::build_with_ephemeral(
        &outcome.records,
        &model_config,
        observed_at,
        &state.ephemeral_panes,
    );
    let mode = if model.grouped() {
        Mode::Grouped
    } else {
        Mode::Flat
    };
    let recovered = state.consecutive_failures != 0 || state.banner.is_some();
    if model.content_hash() == state.model.content_hash()
        && mode == state.mode
        && !recovered
        && !dropped_changed
        && selection.is_none()
        && !creation_resolved
        && !verification_expired
    {
        return ReduceResult::default();
    }
    state.model = model;
    state.mode = mode;
    state.invalidate_render_cache();
    state.consecutive_failures = 0;
    state.dropped_records = outcome.dropped;
    if !creation_resolved {
        state.banner = None;
    }
    state
        .collapsed
        .retain(|session_id| state.model.sessions().contains_key(session_id));
    if let Some((initiating_session, pane_id)) = selection {
        state.filter_query.clear();
        state.input_mode = InputMode::Navigation;
        if let Some(session_id) = initiating_session.as_ref() {
            state.collapsed.remove(session_id);
        }
        state.focus = selection_focus(&state.model, initiating_session.as_ref(), &pane_id);
    } else {
        let visible = state.visible_rows();
        state.focus = old_focus
            .clone()
            .filter(|focus| visible.contains(focus))
            .or_else(|| {
                let old_index =
                    old_focus.and_then(|focus| old_visible.iter().position(|row| row == &focus))?;
                visible
                    .get(old_index)
                    .cloned()
                    .or_else(|| visible.last().cloned())
            })
            .or_else(|| visible.first().cloned());
    }
    state.sync_selection();
    ReduceResult {
        actions: Vec::new(),
        changed: true,
    }
}

fn reconcile_snapshot_presence(
    state: &mut AppState,
    outcome: &ParseOutcome,
    model_config: &ModelConfig,
) -> Option<(Option<SessionId>, PaneId)> {
    state.ephemeral_panes.retain(|pane_id| {
        let raw_present = outcome.raw_panes.contains(&pane_id.0);
        let records: Vec<_> = outcome
            .records
            .iter()
            .filter(|record| record.pane_id == pane_id.0)
            .collect();
        if records.iter().any(|record| !record.pane_dead) {
            return !records
                .iter()
                .any(|record| is_discovered(record, model_config));
        }
        if raw_present {
            return false;
        }
        !absence_is_trustworthy(outcome, pane_id)
    });

    let pending = state.pending_creation.clone()?;
    let PendingCreationState::AwaitingSnapshot {
        pane_id,
        resolution,
    } = pending.state
    else {
        return None;
    };
    let records: Vec<_> = outcome
        .records
        .iter()
        .filter(|record| record.pane_id == pane_id.0)
        .collect();
    let live = records.iter().any(|record| !record.pane_dead);
    let known_dead = records.iter().any(|record| record.pane_dead);

    if live {
        if matches!(resolution, CreationResolution::TagFailed(_))
            && !records
                .iter()
                .any(|record| is_discovered(record, model_config))
        {
            state.ephemeral_panes.insert(pane_id.clone());
        }
        state.pending_creation = None;
        state.creation_verification_deadline = None;
        state.banner = creation_snapshot_banner(&pane_id, &resolution, false);
        return Some((pending.initiating_session, pane_id));
    }
    if known_dead
        || (!outcome.raw_panes.contains(&pane_id.0) && absence_is_trustworthy(outcome, &pane_id))
    {
        state.ephemeral_panes.remove(&pane_id);
        state.pending_creation = None;
        state.creation_verification_deadline = None;
        state.banner = creation_snapshot_banner(&pane_id, &resolution, true);
    }
    None
}

fn absence_is_trustworthy(outcome: &ParseOutcome, pane_id: &PaneId) -> bool {
    !outcome.ambiguous_panes.contains(&pane_id.0) && outcome.unattributable_dropped == 0
}

fn selection_focus(
    model: &Model,
    initiating_session: Option<&SessionId>,
    pane_id: &PaneId,
) -> Option<Focus> {
    let mut fallback = None;
    for row in model.rows(true) {
        let Row::Pane {
            session_id,
            window_id,
            pane_id: row_pane_id,
            ..
        } = row
        else {
            continue;
        };
        if row_pane_id != pane_id {
            continue;
        }
        let focus = Focus::Pane((session_id.clone(), window_id.clone(), row_pane_id.clone()));
        if initiating_session.is_some_and(|initiating_session| initiating_session == session_id) {
            return Some(focus);
        }
        fallback.get_or_insert(focus);
    }
    fallback
}

fn creation_snapshot_banner(
    pane_id: &PaneId,
    resolution: &CreationResolution,
    gone: bool,
) -> Option<String> {
    if gone {
        return Some(match resolution {
            CreationResolution::Success | CreationResolution::TagFailed(_) => {
                "pane exited before tagging".to_owned()
            }
            CreationResolution::CommandFailed { stage, .. }
            | CreationResolution::TimedOut { stage } => {
                format!(
                    "pane {} exited before {}",
                    pane_id.0,
                    creation_stage_name(*stage)
                )
            }
        });
    }
    match resolution {
        CreationResolution::Success => None,
        CreationResolution::TagFailed(error) => Some(format!(
            "pane {} created, tagging failed: {error}",
            pane_id.0
        )),
        CreationResolution::CommandFailed { stage, error } => Some(format!(
            "pane {} created, {} failed: {error}",
            pane_id.0,
            creation_stage_name(*stage)
        )),
        CreationResolution::TimedOut { stage } => Some(format!(
            "pane {} created, {} timed out",
            pane_id.0,
            creation_stage_name(*stage)
        )),
    }
}

fn creation_stage_name(stage: CreateStage) -> &'static str {
    match stage {
        CreateStage::Create => "creation",
        CreateStage::Tag => "tagging",
        CreateStage::SendCommand => "command send",
        CreateStage::SendEnter => "Enter",
    }
}

fn reduce_snapshot_failure(state: &mut AppState, error: String) -> ReduceResult {
    state.consecutive_failures = state.consecutive_failures.saturating_add(1);
    state.banner = Some(format!(
        "snapshot failed ({}): {error}",
        state.consecutive_failures
    ));
    ReduceResult {
        actions: Vec::new(),
        changed: true,
    }
}

#[cfg(test)]
mod tests {
    use crate::config::LoadedUiConfig;
    use std::collections::HashSet;

    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    use ratatui::{
        style::{Color, Style},
        text::{Line, Span},
    };

    use crate::app::{
        Action, ActionOutcome, AppState, CompletedAction, CreateChoiceKind, CreateForm,
        CreateModal, CreationId, Event, Focus, InputMode, JumpTarget, Modal, Mode, PendingCreation,
        PendingCreationState, reduce,
    };
    use crate::creation::{CreateContext, CreateStage, CreationProgress, CreationResolution};
    use crate::model::{Model, ModelConfig, PaneId, Row, SessionId, Status, WindowId};
    use crate::preview::{PreviewFrame, parse_preview};
    use crate::snapshot::{ParseOutcome, RawRecord};

    fn record(session: &str, window: &str, pane: &str, pane_index: u32) -> RawRecord {
        RawRecord {
            session_id: session.into(),
            session_name: session.into(),
            window_id: window.into(),
            window_index: 0,
            window_name: window.into(),
            pane_id: pane.into(),
            pane_index,
            pane_active: pane_index == 0,
            pane_current_command: "opencode".into(),
            pane_current_path: "/tmp".into(),
            pane_dead: false,
            status: "working".into(),
            status_since: Some(1),
            heartbeat: Some(1),
            title: String::new(),
            model: String::new(),
            tag: String::new(),
            group: "1".into(),
        }
    }

    fn state(records: Vec<RawRecord>) -> AppState {
        AppState::new(
            Model::build(&records, &ModelConfig::default(), 10),
            crate::options::DashConfig::default(),
            LoadedUiConfig::default(),
        )
    }

    fn state_with_new_command(records: Vec<RawRecord>, new_command: &str) -> AppState {
        let config = crate::options::DashConfig {
            new_command: new_command.into(),
            ..crate::options::DashConfig::default()
        };
        AppState::new(
            Model::build(&records, &ModelConfig::default(), 10),
            config,
            LoadedUiConfig::default(),
        )
    }

    fn key(code: KeyCode) -> Event {
        Event::Key(KeyEvent::new(code, KeyModifiers::NONE))
    }

    fn control_key(code: KeyCode) -> Event {
        Event::Key(KeyEvent::new(code, KeyModifiers::CONTROL))
    }

    fn shift_key(code: KeyCode) -> Event {
        Event::Key(KeyEvent::new(code, KeyModifiers::SHIFT))
    }

    fn key_with_modifiers(code: KeyCode, modifiers: KeyModifiers) -> Event {
        Event::Key(KeyEvent::new(code, modifiers))
    }

    fn enter_query(app: &mut AppState, query: &str) {
        reduce(app, key(KeyCode::Char('/')));
        for character in query.chars() {
            reduce(app, key(KeyCode::Char(character)));
        }
    }

    #[test]
    fn config_warnings_are_immutable_across_runtime_events() {
        let warnings = [
            "config: invalid color for text; ignored",
            "config: ignored 2 additional warnings",
        ];
        let mut app = AppState::new(
            Model::build(&[record("$1", "@1", "%1", 0)], &ModelConfig::default(), 10),
            crate::options::DashConfig::default(),
            LoadedUiConfig::with_test_warnings(crate::palette::Palette::dark(), &warnings),
        );
        let expected = app
            .config_warnings()
            .iter()
            .map(|warning| warning.text().to_owned())
            .collect::<Vec<_>>();

        reduce(&mut app, snapshot(vec![record("$1", "@1", "%1", 0)], 20));
        reduce(&mut app, Event::SnapshotFailed("temporary failure".into()));
        app.transport_degraded = true;
        app.transport_degraded = false;
        app.banner = Some("action failed".into());
        enter_query(&mut app, "opencode");
        reduce(&mut app, key(KeyCode::Esc));
        reduce(&mut app, key(KeyCode::Char('m')));
        reduce(&mut app, key(KeyCode::Char('n')));
        reduce(&mut app, key(KeyCode::Esc));
        reduce(&mut app, Event::Tick { now: 21 });

        assert_eq!(
            app.config_warnings()
                .iter()
                .map(|warning| warning.text())
                .collect::<Vec<_>>(),
            expected.iter().map(String::as_str).collect::<Vec<_>>()
        );
    }

    #[test]
    fn n_opens_contextual_creation_choices_and_uses_pane_cwd() {
        let mut app = state(vec![record("$1", "@1", "%1", 0)]);
        app.focus = Some(Focus::Pane(("$1".into(), "@1".into(), "%1".into())));
        app.sync_selection();

        let result = reduce(&mut app, key(KeyCode::Char('n')));

        assert!(result.changed);
        let Some(Modal::Create(CreateModal::Choice { choices, selected })) = &app.modal else {
            panic!("expected creation choices");
        };
        assert_eq!(*selected, 0);
        assert_eq!(
            choices.iter().map(|choice| choice.kind).collect::<Vec<_>>(),
            [
                CreateChoiceKind::Right,
                CreateChoiceKind::Left,
                CreateChoiceKind::Bottom,
                CreateChoiceKind::Top,
                CreateChoiceKind::NewWindow,
                CreateChoiceKind::NewSession,
            ]
        );
        assert!(choices.iter().all(|choice| choice.cwd == "/tmp"));
    }

    #[test]
    fn n_uses_header_active_pane_cwd_and_empty_and_retained_no_focus_contexts() {
        let mut active = record("$1", "@1", "%1", 0);
        active.pane_current_path = "/active".into();
        let mut fallback = record("$1", "@2", "%2", 1);
        fallback.window_index = 1;
        fallback.pane_active = false;
        fallback.pane_current_path = "/fallback".into();
        let mut app = state(vec![fallback, active]);
        app.focus = Some(Focus::Header("$1".into()));
        reduce(&mut app, key(KeyCode::Char('n')));
        assert!(matches!(
            app.modal,
            Some(Modal::Create(CreateModal::Choice { ref choices, selected: 0 }))
                if choices.iter().map(|choice| choice.kind).eq([CreateChoiceKind::NewWindow, CreateChoiceKind::NewSession])
                    && choices.iter().all(|choice| choice.cwd == "/active")
        ));

        let mut empty = state(Vec::new());
        reduce(&mut empty, key(KeyCode::Char('n')));
        assert!(matches!(
            empty.modal,
            Some(Modal::Create(CreateModal::Form(_)))
        ));

        let mut retained = state(vec![record("$1", "@1", "%1", 0)]);
        enter_query(&mut retained, "does-not-match");
        reduce(&mut retained, key(KeyCode::Esc));
        reduce(&mut retained, key(KeyCode::Char('n')));
        assert!(matches!(
            retained.modal,
            Some(Modal::Create(CreateModal::Choice { ref choices, selected: 0 }))
                if choices.len() == 1 && choices[0].kind == CreateChoiceKind::NewSession && choices[0].cwd.is_empty()
        ));
    }

    #[test]
    fn fresh_creation_forms_use_the_configured_command_in_every_context() {
        let command = "λ;$(echo literal)";

        let mut empty = state_with_new_command(Vec::new(), command);
        reduce(&mut empty, key(KeyCode::Char('n')));
        assert!(matches!(
            empty.modal,
            Some(Modal::Create(CreateModal::Form(ref form))) if form.draft.command == command
        ));

        let record = record("$1", "@1", "%1", 0);
        let mut pane = state_with_new_command(vec![record.clone()], command);
        pane.focus = Some(Focus::Pane(("$1".into(), "@1".into(), "%1".into())));
        pane.sync_selection();
        reduce(&mut pane, key(KeyCode::Char('n')));
        reduce(&mut pane, key(KeyCode::Enter));
        assert!(matches!(
            pane.modal,
            Some(Modal::Create(CreateModal::Form(ref form))) if form.draft.command == command
        ));

        let mut header = state_with_new_command(vec![record.clone()], command);
        header.focus = Some(Focus::Header("$1".into()));
        reduce(&mut header, key(KeyCode::Char('n')));
        reduce(&mut header, key(KeyCode::Enter));
        assert!(matches!(
            header.modal,
            Some(Modal::Create(CreateModal::Form(ref form))) if form.draft.command == command
        ));

        let mut no_focus = state_with_new_command(vec![record], command);
        enter_query(&mut no_focus, "does-not-match");
        reduce(&mut no_focus, key(KeyCode::Esc));
        reduce(&mut no_focus, key(KeyCode::Char('n')));
        reduce(&mut no_focus, key(KeyCode::Enter));
        assert!(matches!(
            no_focus.modal,
            Some(Modal::Create(CreateModal::Form(ref form))) if form.draft.command == command
        ));
    }

    #[test]
    fn creation_command_edits_survive_stage_one_failure_but_cancel_reopens_the_default() {
        let command = "λ;$(echo literal)";
        let mut app = state_with_new_command(Vec::new(), command);
        reduce(&mut app, key(KeyCode::Char('n')));
        reduce(&mut app, key(KeyCode::Tab));
        reduce(&mut app, key(KeyCode::Tab));
        reduce(&mut app, key(KeyCode::Char('!')));
        reduce(&mut app, key(KeyCode::Enter));
        reduce(
            &mut app,
            Event::CreationProgress(CreationProgress::CreateFailed {
                id: CreationId(1),
                error: "failed".into(),
            }),
        );
        assert!(matches!(
            app.modal,
            Some(Modal::Create(CreateModal::Form(ref form)))
                if !form.submitting && form.draft.command == "λ;$(echo literal)!"
        ));

        reduce(&mut app, key(KeyCode::Esc));
        reduce(&mut app, key(KeyCode::Char('n')));
        assert!(matches!(
            app.modal,
            Some(Modal::Create(CreateModal::Form(ref form))) if form.draft.command == command
        ));
    }

    #[test]
    fn creation_form_validates_edits_and_correlates_stage_one_failures() {
        let mut app = state(Vec::new());
        reduce(&mut app, key(KeyCode::Char('n')));
        reduce(&mut app, key(KeyCode::Char('λ')));
        reduce(&mut app, shift_key(KeyCode::Char('X')));
        reduce(&mut app, key(KeyCode::Backspace));
        reduce(&mut app, key(KeyCode::Tab));
        reduce(&mut app, key(KeyCode::Char('\u{1}')));
        let validation = reduce(&mut app, key(KeyCode::Enter));
        assert!(validation.actions.is_empty());
        assert!(
            matches!(app.modal, Some(Modal::Create(CreateModal::Form(ref form))) if form.error.is_some())
        );

        reduce(&mut app, key(KeyCode::Backspace));
        let submitted = reduce(&mut app, key(KeyCode::Enter));
        assert!(matches!(
            submitted.actions.as_slice(),
            [Action::StartCreation {
                id: CreationId(1),
                ..
            }]
        ));
        assert!(matches!(
            app.pending_creation.as_ref().map(|pending| &pending.state),
            Some(PendingCreationState::Creating)
        ));
        assert!(
            matches!(app.modal, Some(Modal::Create(CreateModal::Form(ref form))) if form.submitting)
        );

        reduce(
            &mut app,
            Event::CreationProgress(CreationProgress::CreateFailed {
                id: CreationId(1),
                error: "bad\u{1b}error".into(),
            }),
        );
        assert!(
            matches!(app.modal, Some(Modal::Create(CreateModal::Form(ref form))) if !form.submitting && form.error.as_deref() == Some("bad\\u{1b}error"))
        );
        let retry = reduce(&mut app, key(KeyCode::Enter));
        assert!(matches!(
            retry.actions.as_slice(),
            [Action::StartCreation {
                id: CreationId(2),
                ..
            }]
        ));
    }

    #[test]
    fn creation_terminal_progress_is_correlated_and_emits_once_in_order() {
        let mut app = state(Vec::new());
        reduce(&mut app, key(KeyCode::Char('n')));
        let start = reduce(&mut app, key(KeyCode::Enter));
        let id = match start.actions.as_slice() {
            [Action::StartCreation { id, .. }] => *id,
            actions => panic!("expected start action, got {actions:?}"),
        };
        assert_eq!(
            reduce(
                &mut app,
                Event::CreationProgress(CreationProgress::Created {
                    id,
                    pane_id: "%9".into(),
                }),
            )
            .actions,
            []
        );
        assert!(app.modal.is_none());
        reduce(
            &mut app,
            Event::CreationProgress(CreationProgress::Stage {
                id,
                stage: CreateStage::Tag,
                pane_id: Some("%9".into()),
            }),
        );
        let finished = reduce(
            &mut app,
            Event::CreationProgress(CreationProgress::Finished {
                id,
                pane_id: "%9".into(),
                resolution: CreationResolution::Success,
            }),
        );
        assert_eq!(
            finished.actions,
            vec![Action::CreationMutation, Action::RefreshNow]
        );
        assert_eq!(
            reduce(
                &mut app,
                Event::CreationProgress(CreationProgress::Finished {
                    id,
                    pane_id: "%9".into(),
                    resolution: CreationResolution::Success,
                }),
            )
            .actions,
            []
        );
        assert!(matches!(
            app.pending_creation.as_ref().map(|pending| &pending.state),
            Some(PendingCreationState::AwaitingSnapshot { .. })
        ));
        assert!(!reduce(&mut app, key(KeyCode::Char('n'))).changed);
        assert!(app.modal.is_none());
    }

    #[test]
    fn creation_split_form_counts_linked_sessions_and_cycles_only_relevant_fields() {
        let first = record("$1", "@1", "%1", 0);
        let mut linked = first.clone();
        linked.session_id = "$2".into();
        linked.window_id = "@2".into();
        let mut app = state(vec![first, linked]);
        app.focus = Some(Focus::Pane(("$1".into(), "@1".into(), "%1".into())));
        app.sync_selection();

        reduce(&mut app, key(KeyCode::Char('n')));
        reduce(&mut app, key(KeyCode::Enter));
        let form = match app.modal.as_ref() {
            Some(Modal::Create(CreateModal::Form(form))) => form,
            modal => panic!("expected split form, got {modal:?}"),
        };
        assert!(matches!(form.kind, CreateContext::Split { .. }));
        assert_eq!(form.linked_session_count, 2);
        assert_eq!(form.field, crate::app::CreateField::Cwd);
        assert!(form.draft.name.is_empty());

        reduce(&mut app, key(KeyCode::Tab));
        assert!(
            matches!(app.modal, Some(Modal::Create(CreateModal::Form(ref form))) if form.field == crate::app::CreateField::Command)
        );
        reduce(&mut app, key(KeyCode::BackTab));
        assert!(
            matches!(app.modal, Some(Modal::Create(CreateModal::Form(ref form))) if form.field == crate::app::CreateField::Cwd)
        );
    }

    #[test]
    fn creation_header_cwd_falls_back_to_lowest_topology_and_modal_input_is_exclusive() {
        let mut later = record("$1", "@2", "%2", 3);
        later.window_index = 2;
        later.pane_active = false;
        later.pane_current_path = "/later".into();
        let mut first = record("$1", "@1", "%1", 1);
        first.window_index = 1;
        first.pane_active = false;
        first.pane_current_path = "/first".into();
        let mut app = state(vec![later, first]);
        app.focus = Some(Focus::Header("$1".into()));
        let before_mode = app.mode;

        reduce(&mut app, key(KeyCode::Char('n')));
        assert!(matches!(
            app.modal,
            Some(Modal::Create(CreateModal::Choice { ref choices, .. }))
                if choices.iter().all(|choice| choice.cwd == "/first")
        ));
        reduce(&mut app, key(KeyCode::Char('s')));
        assert_eq!(app.mode, before_mode);
        reduce(&mut app, key(KeyCode::Esc));
        assert!(app.modal.is_none());
    }

    #[test]
    fn creation_stage_failures_ignore_stale_ids_and_error_dismissal_allows_reopen() {
        let mut app = state(Vec::new());
        let original_hash = app.model.content_hash();
        reduce(&mut app, key(KeyCode::Char('n')));
        let start = reduce(&mut app, key(KeyCode::Enter));
        assert!(matches!(
            start.actions.as_slice(),
            [Action::StartCreation {
                id: CreationId(1),
                ..
            }]
        ));
        let stale = reduce(
            &mut app,
            Event::CreationProgress(CreationProgress::CreateFailed {
                id: CreationId(99),
                error: "stale".into(),
            }),
        );
        assert!(!stale.changed);
        assert!(
            matches!(app.modal, Some(Modal::Create(CreateModal::Form(ref form))) if form.submitting)
        );

        reduce(
            &mut app,
            Event::CreationProgress(CreationProgress::CreateFailed {
                id: CreationId(1),
                error: "failed".into(),
            }),
        );
        reduce(&mut app, key(KeyCode::Esc));
        assert!(app.modal.is_none());
        assert!(app.pending_creation.is_none());
        assert_eq!(app.model.content_hash(), original_hash);
        reduce(&mut app, key(KeyCode::Char('n')));
        assert!(matches!(
            app.modal,
            Some(Modal::Create(CreateModal::Form(_)))
        ));
    }

    #[test]
    fn creation_choices_freeze_context_across_snapshot_focus_changes() {
        let mut original = record("$1", "@1", "%1", 0);
        original.pane_current_path = "/original".into();
        let mut app = state(vec![original]);
        app.focus = Some(Focus::Pane(("$1".into(), "@1".into(), "%1".into())));
        app.sync_selection();
        reduce(&mut app, key(KeyCode::Char('n')));

        let mut replacement = record("$2", "@2", "%2", 0);
        replacement.pane_current_path = "/replacement".into();
        reduce(&mut app, snapshot(vec![replacement], 11));
        for _ in 0..4 {
            reduce(&mut app, key(KeyCode::Char('j')));
        }
        reduce(&mut app, key(KeyCode::Enter));

        assert!(matches!(
            app.modal,
            Some(Modal::Create(CreateModal::Form(CreateForm {
                kind: CreateContext::NewWindow { ref target },
                ref draft,
                ..
            }))) if target == &SessionId::from("$1") && draft.cwd == "/original"
        ));
    }

    #[test]
    fn creation_progress_requires_order_and_a_bound_matching_pane() {
        let mut app = state(Vec::new());
        reduce(&mut app, key(KeyCode::Char('n')));
        let start = reduce(&mut app, key(KeyCode::Enter));
        let id = match start.actions.as_slice() {
            [Action::StartCreation { id, .. }] => *id,
            actions => panic!("expected start action, got {actions:?}"),
        };
        reduce(
            &mut app,
            Event::CreationProgress(CreationProgress::Created {
                id,
                pane_id: "%1".into(),
            }),
        );

        let cases = [
            (CreateStage::SendCommand, Some("%1"), false),
            (CreateStage::Tag, Some("%2"), false),
            (CreateStage::Tag, Some("%1"), true),
            (CreateStage::Tag, Some("%1"), false),
            (CreateStage::SendEnter, Some("%1"), false),
            (CreateStage::SendCommand, Some("%2"), false),
            (CreateStage::SendCommand, Some("%1"), true),
            (CreateStage::SendEnter, Some("%1"), true),
        ];
        for (stage, pane_id, changes) in cases {
            let result = reduce(
                &mut app,
                Event::CreationProgress(CreationProgress::Stage {
                    id,
                    stage,
                    pane_id: pane_id.map(PaneId::from),
                }),
            );
            assert_eq!(result.changed, changes, "{stage:?} {pane_id:?}");
            assert!(result.actions.is_empty());
        }
    }

    #[test]
    fn creation_timeout_derives_the_active_stage_and_rejects_illegal_terminals() {
        let start = |app: &mut AppState| {
            reduce(app, key(KeyCode::Char('n')));
            match reduce(app, key(KeyCode::Enter)).actions.as_slice() {
                [Action::StartCreation { id, .. }] => *id,
                actions => panic!("expected start action, got {actions:?}"),
            }
        };
        let enter_stage = |app: &mut AppState, id, stage| {
            reduce(
                app,
                Event::CreationProgress(CreationProgress::Stage {
                    id,
                    stage,
                    pane_id: Some("%1".into()),
                }),
            );
        };
        let states = [
            (Vec::new(), CreateStage::Tag),
            (vec![CreateStage::Tag], CreateStage::Tag),
            (
                vec![CreateStage::Tag, CreateStage::SendCommand],
                CreateStage::SendCommand,
            ),
            (
                vec![
                    CreateStage::Tag,
                    CreateStage::SendCommand,
                    CreateStage::SendEnter,
                ],
                CreateStage::SendEnter,
            ),
        ];
        for (stages, expected_stage) in states {
            let mut app = state(Vec::new());
            let id = start(&mut app);
            reduce(
                &mut app,
                Event::CreationProgress(CreationProgress::Created {
                    id,
                    pane_id: "%1".into(),
                }),
            );
            for stage in stages {
                enter_stage(&mut app, id, stage);
            }
            let result = reduce(
                &mut app,
                Event::CreationProgress(CreationProgress::TimedOut { id }),
            );
            assert_eq!(
                result.actions,
                vec![Action::CreationMutation, Action::RefreshNow]
            );
            assert!(matches!(
                app.pending_creation,
                Some(PendingCreation {
                    state: PendingCreationState::AwaitingSnapshot {
                        pane_id: ref actual_pane,
                        resolution: CreationResolution::TimedOut { stage },
                    },
                    ..
                }) if actual_pane == &PaneId::from("%1") && stage == expected_stage
            ));
            assert!(
                !reduce(
                    &mut app,
                    Event::CreationProgress(CreationProgress::TimedOut { id })
                )
                .changed
            );
        }

        let mut precreate = state(Vec::new());
        let id = start(&mut precreate);
        let timeout = reduce(
            &mut precreate,
            Event::CreationProgress(CreationProgress::TimedOut { id }),
        );
        assert!(timeout.actions.is_empty());
        assert!(matches!(
            precreate.pending_creation,
            Some(PendingCreation {
                state: PendingCreationState::Error(_),
                ..
            })
        ));

        let mut terminal = state(Vec::new());
        let id = start(&mut terminal);
        reduce(
            &mut terminal,
            Event::CreationProgress(CreationProgress::Created {
                id,
                pane_id: "%1".into(),
            }),
        );
        enter_stage(&mut terminal, id, CreateStage::Tag);
        let wrong = reduce(
            &mut terminal,
            Event::CreationProgress(CreationProgress::Finished {
                id,
                pane_id: "%2".into(),
                resolution: CreationResolution::Success,
            }),
        );
        assert!(!wrong.changed);
        assert!(wrong.actions.is_empty());
    }

    #[test]
    fn creation_worker_failure_unlocks_precreate_and_finishes_postcreate_once() {
        let start = |app: &mut AppState| {
            reduce(app, key(KeyCode::Char('n')));
            match reduce(app, key(KeyCode::Enter)).actions.as_slice() {
                [Action::StartCreation { id, .. }] => *id,
                actions => panic!("expected start action, got {actions:?}"),
            }
        };
        let mut precreate = state(Vec::new());
        let id = start(&mut precreate);
        assert!(
            reduce(
                &mut precreate,
                Event::CreationProgress(CreationProgress::TaskFailed {
                    id,
                    error: "panic".into()
                })
            )
            .changed
        );
        assert!(matches!(
            precreate.modal,
            Some(Modal::Create(CreateModal::Form(ref form))) if !form.submitting && form.error.as_deref() == Some("panic")
        ));

        let mut postcreate = state(Vec::new());
        let id = start(&mut postcreate);
        reduce(
            &mut postcreate,
            Event::CreationProgress(CreationProgress::Created {
                id,
                pane_id: "%1".into(),
            }),
        );
        let result = reduce(
            &mut postcreate,
            Event::CreationProgress(CreationProgress::TaskFailed {
                id,
                error: "panic".into(),
            }),
        );
        assert_eq!(
            result.actions,
            vec![Action::CreationMutation, Action::RefreshNow]
        );
        assert!(
            !reduce(
                &mut postcreate,
                Event::CreationProgress(CreationProgress::TaskFailed {
                    id,
                    error: "panic".into()
                })
            )
            .changed
        );
    }

    #[test]
    fn focusing_a_pane_starts_an_immediate_preview_capture() {
        let mut app = state(vec![record("$1", "@1", "%1", 0)]);

        reduce(&mut app, key(KeyCode::Char('j')));
        let result = reduce(&mut app, key(KeyCode::Char('j')));

        assert_eq!(app.selected_pane(), Some(PaneId("%1".into())));
        assert_eq!(app.preview.target, Some(PaneId("%1".into())));
        assert_eq!(
            result.actions,
            vec![Action::CapturePreview {
                sequence: 1,
                pane_id: PaneId("%1".into()),
            }]
        );
    }

    fn select_first_pane(app: &mut AppState) -> (u64, PaneId) {
        reduce(app, key(KeyCode::Char('j')));
        let result = reduce(app, key(KeyCode::Char('j')));
        match result.actions.as_slice() {
            [Action::CapturePreview { sequence, pane_id }] => (*sequence, pane_id.clone()),
            actions => panic!("expected one capture action, got {actions:?}"),
        }
    }

    #[test]
    fn header_focus_clears_preview_and_stale_results_are_ignored_after_target_change() {
        let mut app = state(vec![
            record("$a", "@a", "%a", 0),
            record("$a", "@a", "%b", 1),
        ]);
        let (first_sequence, first_pane) = select_first_pane(&mut app);
        let result = reduce(&mut app, key(KeyCode::Char('j')));
        let (second_sequence, second_pane) = match result.actions.as_slice() {
            [Action::CapturePreview { sequence, pane_id }] => (*sequence, pane_id.clone()),
            actions => panic!("expected replacement capture, got {actions:?}"),
        };
        assert!(second_sequence > first_sequence);
        let result = reduce(
            &mut app,
            Event::PreviewCaptured {
                sequence: first_sequence,
                pane_id: first_pane,
                result: Ok(parse_preview(PaneId::from("%a"), b"stale".to_vec())),
            },
        );
        assert!(!result.changed);
        assert_eq!(app.preview.frame, None);
        assert_eq!(app.preview.in_flight, Some((second_sequence, second_pane)));

        reduce(&mut app, key(KeyCode::Char('k')));
        reduce(&mut app, key(KeyCode::Char('k')));
        assert_eq!(app.selected_pane(), None);
        assert_eq!(app.preview.target, None);
        assert_eq!(app.preview.frame, None);
        assert_eq!(app.preview.error, None);
        assert_eq!(app.preview.in_flight, None);
    }

    #[test]
    fn current_preview_results_follow_bottom_and_store_short_errors() {
        let mut app = state(vec![record("$a", "@a", "%a", 0)]);
        let (sequence, pane_id) = select_first_pane(&mut app);
        let frame = parse_preview(pane_id.clone(), b"one\ntwo\nthree".to_vec());
        app.preview.lines_from_bottom = 2;
        reduce(
            &mut app,
            Event::PreviewCaptured {
                sequence,
                pane_id: pane_id.clone(),
                result: Ok(frame.clone()),
            },
        );
        assert_eq!(app.preview.frame, Some(frame));
        assert_eq!(app.preview.lines_from_bottom, 0);
        assert_eq!(app.preview.in_flight, None);

        let result = reduce(&mut app, Event::PreviewTick);
        let sequence = match result.actions.as_slice() {
            [Action::CapturePreview { sequence, .. }] => *sequence,
            actions => panic!("expected periodic capture, got {actions:?}"),
        };
        reduce(
            &mut app,
            Event::PreviewCaptured {
                sequence,
                pane_id,
                result: Err(format!("first line\n{}", "x".repeat(300))),
            },
        );
        assert_eq!(app.preview.frame, None);
        assert_eq!(app.preview.error.as_deref(), Some("first line"));
        assert_eq!(app.preview.in_flight, None);
    }

    #[test]
    fn identical_preview_results_clear_in_flight_without_redrawing() {
        let mut app = state(vec![record("$a", "@a", "%a", 0)]);
        let (sequence, pane_id) = select_first_pane(&mut app);
        let frame = parse_preview(pane_id.clone(), b"same".to_vec());
        reduce(
            &mut app,
            Event::PreviewCaptured {
                sequence,
                pane_id: pane_id.clone(),
                result: Ok(frame.clone()),
            },
        );
        let sequence = match reduce(&mut app, Event::PreviewTick).actions.as_slice() {
            [Action::CapturePreview { sequence, .. }] => *sequence,
            actions => panic!("expected capture, got {actions:?}"),
        };
        let result = reduce(
            &mut app,
            Event::PreviewCaptured {
                sequence,
                pane_id,
                result: Ok(frame),
            },
        );
        assert_eq!(app.preview.in_flight, None);
        assert!(!result.changed);
    }

    #[test]
    fn repeated_identical_preview_failures_clear_in_flight_without_redrawing() {
        let mut app = state(vec![record("$a", "@a", "%a", 0)]);
        let (sequence, pane_id) = select_first_pane(&mut app);
        let failure = format!("capture failed\n{}", "x".repeat(300));

        let result = reduce(
            &mut app,
            Event::PreviewCaptured {
                sequence,
                pane_id: pane_id.clone(),
                result: Err(failure.clone()),
            },
        );
        assert!(result.changed);
        assert_eq!(app.preview.error.as_deref(), Some("capture failed"));

        let sequence = match reduce(&mut app, Event::PreviewTick).actions.as_slice() {
            [Action::CapturePreview { sequence, .. }] => *sequence,
            actions => panic!("expected capture, got {actions:?}"),
        };
        let result = reduce(
            &mut app,
            Event::PreviewCaptured {
                sequence,
                pane_id,
                result: Err(failure),
            },
        );

        assert_eq!(app.preview.in_flight, None);
        assert!(!result.changed);
    }

    #[test]
    fn style_only_preview_frame_difference_redraws() {
        let mut app = state(vec![record("$a", "@a", "%a", 0)]);
        let (sequence, pane_id) = select_first_pane(&mut app);
        let plain_frame = parse_preview(pane_id.clone(), b"same".to_vec());
        reduce(
            &mut app,
            Event::PreviewCaptured {
                sequence,
                pane_id: pane_id.clone(),
                result: Ok(plain_frame),
            },
        );

        let sequence = match reduce(&mut app, Event::PreviewTick).actions.as_slice() {
            [Action::CapturePreview { sequence, .. }] => *sequence,
            actions => panic!("expected capture, got {actions:?}"),
        };
        let styled_frame = PreviewFrame {
            pane_id: pane_id.clone(),
            lines: vec![Line::from(Span::styled(
                "same",
                Style::default().fg(Color::Red),
            ))],
        };
        let result = reduce(
            &mut app,
            Event::PreviewCaptured {
                sequence,
                pane_id,
                result: Ok(styled_frame),
            },
        );

        assert!(result.changed);
    }

    #[test]
    fn successful_preview_after_error_redraws_even_when_restoring_prior_frame() {
        let mut app = state(vec![record("$a", "@a", "%a", 0)]);
        let (sequence, pane_id) = select_first_pane(&mut app);
        let frame = parse_preview(pane_id.clone(), b"same".to_vec());
        reduce(
            &mut app,
            Event::PreviewCaptured {
                sequence,
                pane_id: pane_id.clone(),
                result: Ok(frame.clone()),
            },
        );

        let sequence = match reduce(&mut app, Event::PreviewTick).actions.as_slice() {
            [Action::CapturePreview { sequence, .. }] => *sequence,
            actions => panic!("expected capture, got {actions:?}"),
        };
        reduce(
            &mut app,
            Event::PreviewCaptured {
                sequence,
                pane_id: pane_id.clone(),
                result: Err("capture failed".into()),
            },
        );
        assert_eq!(app.preview.error.as_deref(), Some("capture failed"));

        let sequence = match reduce(&mut app, Event::PreviewTick).actions.as_slice() {
            [Action::CapturePreview { sequence, .. }] => *sequence,
            actions => panic!("expected capture, got {actions:?}"),
        };
        let result = reduce(
            &mut app,
            Event::PreviewCaptured {
                sequence,
                pane_id,
                result: Ok(frame),
            },
        );

        assert_eq!(app.preview.error, None);
        assert!(result.changed);
    }

    #[test]
    fn accepted_preview_success_reset_to_bottom_redraws() {
        let mut app = state(vec![record("$a", "@a", "%a", 0)]);
        let (sequence, pane_id) = select_first_pane(&mut app);
        let frame = parse_preview(pane_id.clone(), b"one\ntwo\nthree\nfour".to_vec());
        reduce(
            &mut app,
            Event::PreviewCaptured {
                sequence,
                pane_id: pane_id.clone(),
                result: Ok(frame.clone()),
            },
        );
        reduce(&mut app, Event::PreviewViewport(2));

        let sequence = match reduce(&mut app, Event::PreviewTick).actions.as_slice() {
            [Action::CapturePreview { sequence, .. }] => *sequence,
            actions => panic!("expected capture, got {actions:?}"),
        };
        // PreviewTick established this accepted request; model a pre-existing scroll offset
        // without constructing the in-flight request directly.
        app.preview.lines_from_bottom = 1;
        assert!(app.preview.lines_from_bottom > 0);

        let result = reduce(
            &mut app,
            Event::PreviewCaptured {
                sequence,
                pane_id,
                result: Ok(frame),
            },
        );

        assert_eq!(app.preview.lines_from_bottom, 0);
        assert!(result.changed);
    }

    #[test]
    fn inspect_controls_clamp_half_pages_even_while_filtering() {
        let mut app = state(vec![record("$a", "@a", "%a", 0)]);
        let (sequence, pane_id) = select_first_pane(&mut app);
        reduce(
            &mut app,
            Event::PreviewCaptured {
                sequence,
                pane_id,
                result: Ok(parse_preview(
                    PaneId::from("%a"),
                    b"1\n2\n3\n4\n5\n6\n7\n8\n9\n10".to_vec(),
                )),
            },
        );
        reduce(&mut app, Event::PreviewViewport(4));
        enter_query(&mut app, "a");
        reduce(&mut app, control_key(KeyCode::Char('u')));
        assert!(app.preview.inspect);
        assert_eq!(app.preview.lines_from_bottom, 2);
        reduce(&mut app, control_key(KeyCode::Char('u')));
        assert_eq!(app.preview.lines_from_bottom, 4);
        reduce(&mut app, control_key(KeyCode::Char('u')));
        assert_eq!(app.preview.lines_from_bottom, 6);
        reduce(&mut app, control_key(KeyCode::Char('d')));
        assert_eq!(app.preview.lines_from_bottom, 4);
        let result = reduce(&mut app, control_key(KeyCode::Char('r')));
        assert!(!app.preview.inspect);
        assert_eq!(app.preview.lines_from_bottom, 0);
        assert!(matches!(
            result.actions.as_slice(),
            [Action::CapturePreview { .. }]
        ));
    }

    #[test]
    fn focus_pause_resume_and_same_target_do_not_duplicate_requests() {
        let mut app = state(vec![record("$a", "@a", "%a", 0)]);
        let (sequence, pane_id) = select_first_pane(&mut app);
        assert!(reduce(&mut app, Event::PreviewTick).actions.is_empty());
        reduce(&mut app, Event::TerminalFocus(false));
        assert_eq!(app.preview.in_flight, None);
        assert!(reduce(&mut app, Event::PreviewTick).actions.is_empty());
        let resumed = reduce(&mut app, Event::TerminalFocus(true));
        let resumed_sequence = match resumed.actions.as_slice() {
            [Action::CapturePreview { sequence, .. }] => *sequence,
            actions => panic!("expected resume capture, got {actions:?}"),
        };
        assert!(resumed_sequence > sequence);
        assert!(
            reduce(&mut app, Event::TerminalFocus(true))
                .actions
                .is_empty()
        );
        reduce(
            &mut app,
            Event::PreviewCaptured {
                sequence: resumed_sequence,
                pane_id,
                result: Ok(parse_preview(PaneId::from("%a"), b"frame".to_vec())),
            },
        );
        reduce(&mut app, control_key(KeyCode::Char('u')));
        assert!(app.preview.inspect);
        assert!(reduce(&mut app, Event::PreviewTick).actions.is_empty());
    }

    #[test]
    fn snapshots_preserve_inspect_for_same_pane_and_clear_vanished_selection() {
        let record = record("$a", "@a", "%a", 0);
        let mut app = state(vec![record.clone()]);
        let (sequence, pane_id) = select_first_pane(&mut app);
        reduce(
            &mut app,
            Event::PreviewCaptured {
                sequence,
                pane_id,
                result: Ok(parse_preview(PaneId::from("%a"), b"frame".to_vec())),
            },
        );
        reduce(&mut app, control_key(KeyCode::Char('u')));
        reduce(&mut app, snapshot(vec![record], 11));
        assert!(app.preview.inspect);
        assert_eq!(app.preview.target, Some(PaneId::from("%a")));

        reduce(&mut app, snapshot(vec![], 12));
        assert_eq!(app.preview.target, None);
        assert_eq!(app.preview.frame, None);
        assert!(!app.preview.inspect);
    }

    #[test]
    fn focus_regain_preserves_inspect_frame_and_offset_until_ctrl_r() {
        let mut app = state(vec![record("$a", "@a", "%a", 0)]);
        let (sequence, pane_id) = select_first_pane(&mut app);
        let frame = parse_preview(pane_id.clone(), b"1\n2\n3\n4\n5\n6\n7\n8\n9\n10".to_vec());
        reduce(
            &mut app,
            Event::PreviewCaptured {
                sequence,
                pane_id,
                result: Ok(frame.clone()),
            },
        );
        reduce(&mut app, Event::PreviewViewport(4));
        reduce(&mut app, control_key(KeyCode::Char('u')));
        let offset = app.preview.lines_from_bottom;
        assert!(offset > 0);

        reduce(&mut app, Event::TerminalFocus(false));
        let resumed = reduce(&mut app, Event::TerminalFocus(true));
        assert!(resumed.actions.is_empty());
        assert_eq!(app.preview.frame, Some(frame));
        assert_eq!(app.preview.lines_from_bottom, offset);
        assert!(app.preview.inspect);

        let result = reduce(&mut app, control_key(KeyCode::Char('r')));
        assert!(matches!(
            result.actions.as_slice(),
            [Action::CapturePreview { .. }]
        ));
    }

    fn visible_pane_ids(app: &AppState) -> Vec<String> {
        let rows = app.model.rows(app.grouped());
        app.render_cache()
            .visible_rows
            .iter()
            .filter_map(|index| match &rows[*index] {
                Row::Pane { pane_id, .. } => Some(pane_id.0.clone()),
                Row::SessionHeader { .. } => None,
            })
            .collect()
    }

    fn snapshot(records: Vec<RawRecord>, observed_at: u64) -> Event {
        Event::Snapshot {
            outcome: ParseOutcome {
                raw_panes: records
                    .iter()
                    .map(|record| record.pane_id.clone())
                    .collect(),
                records,
                ambiguous_panes: Default::default(),
                dropped: 0,
                unattributable_dropped: 0,
            },
            observed_at,
        }
    }

    #[test]
    fn tag_failure_reconciles_live_undiscovered_pane_as_ephemeral_in_initiating_membership() {
        let mut app = state(vec![record("$other", "@other", "%other", 0)]);
        app.pending_creation = Some(PendingCreation {
            id: CreationId(1),
            initiating_session: Some("$start".into()),
            state: PendingCreationState::AwaitingSnapshot {
                pane_id: "%new".into(),
                resolution: CreationResolution::TagFailed("tag bad".into()),
            },
        });
        let mut created = record("$start", "@start", "%new", 1);
        created.pane_current_command = "shell".into();
        created.status.clear();
        created.tag.clear();

        let result = reduce(&mut app, snapshot(vec![created], 11));

        assert!(result.changed);
        assert!(app.pending_creation.is_none());
        assert!(app.ephemeral_panes.contains(&PaneId::from("%new")));
        assert!(app.model.panes().contains_key(&PaneId::from("%new")));
        assert_eq!(
            app.focus(),
            Some(&Focus::Pane((
                SessionId::from("$start"),
                WindowId::from("@start"),
                PaneId::from("%new"),
            )))
        );
        assert_eq!(
            app.banner.as_deref(),
            Some("pane %new created, tagging failed: tag bad")
        );
    }

    #[test]
    fn ephemeral_created_pane_is_pruned_by_the_next_trustworthy_absent_snapshot() {
        let mut app = state(Vec::new());
        app.ephemeral_panes.insert(PaneId::from("%new"));
        let mut created = record("$start", "@start", "%new", 0);
        created.pane_current_command = "shell".into();
        created.status.clear();
        created.tag.clear();
        reduce(&mut app, snapshot(vec![created], 11));
        assert!(app.model.panes().contains_key(&PaneId::from("%new")));

        reduce(&mut app, snapshot(Vec::new(), 12));

        assert!(!app.ephemeral_panes.contains(&PaneId::from("%new")));
        assert!(!app.model.panes().contains_key(&PaneId::from("%new")));
    }

    #[test]
    fn discovered_created_pane_selects_the_initiating_link_without_ephemeral_membership() {
        let mut app = state(Vec::new());
        app.pending_creation = Some(PendingCreation {
            id: CreationId(1),
            initiating_session: Some("$start".into()),
            state: PendingCreationState::AwaitingSnapshot {
                pane_id: "%new".into(),
                resolution: CreationResolution::Success,
            },
        });
        let mut other = record("$other", "@other", "%new", 0);
        other.tag = "dash-created".into();
        let mut initiator = other.clone();
        initiator.session_id = "$start".into();
        initiator.window_id = "@start".into();

        reduce(&mut app, snapshot(vec![other, initiator], 11));

        assert!(app.ephemeral_panes.is_empty());
        assert_eq!(app.model.memberships().len(), 2);
        assert_eq!(
            app.focus(),
            Some(&Focus::Pane((
                SessionId::from("$start"),
                WindowId::from("@start"),
                PaneId::from("%new"),
            )))
        );
    }

    #[test]
    fn dead_pane_after_tag_failure_clears_pending_without_ephemeral_membership() {
        let mut app = state(Vec::new());
        app.pending_creation = Some(PendingCreation {
            id: CreationId(1),
            initiating_session: Some("$start".into()),
            state: PendingCreationState::AwaitingSnapshot {
                pane_id: "%new".into(),
                resolution: CreationResolution::TagFailed("tag bad".into()),
            },
        });
        let mut dead = record("$start", "@start", "%new", 0);
        dead.pane_dead = true;
        dead.pane_current_command = "shell".into();
        dead.status.clear();
        dead.tag.clear();

        reduce(&mut app, snapshot(vec![dead], 11));

        assert!(app.pending_creation.is_none());
        assert!(app.ephemeral_panes.is_empty());
        assert_eq!(app.banner.as_deref(), Some("pane exited before tagging"));
    }

    #[test]
    fn dropped_snapshot_does_not_clear_awaiting_or_ephemeral_created_pane() {
        let mut app = state(Vec::new());
        app.ephemeral_panes.insert(PaneId::from("%old"));
        app.pending_creation = Some(PendingCreation {
            id: CreationId(1),
            initiating_session: None,
            state: PendingCreationState::AwaitingSnapshot {
                pane_id: "%new".into(),
                resolution: CreationResolution::Success,
            },
        });

        reduce(
            &mut app,
            Event::Snapshot {
                outcome: ParseOutcome {
                    records: Vec::new(),
                    raw_panes: Default::default(),
                    ambiguous_panes: Default::default(),
                    dropped: 1,
                    unattributable_dropped: 1,
                },
                observed_at: 11,
            },
        );

        assert!(app.pending_creation.is_some());
        assert!(app.ephemeral_panes.contains(&PaneId::from("%old")));
    }

    #[test]
    fn unrelated_attributed_drop_does_not_pin_an_absent_ephemeral_pane() {
        let mut app = state(Vec::new());
        app.ephemeral_panes.insert(PaneId::from("%new"));
        let mut created = record("$start", "@start", "%new", 0);
        created.status.clear();
        created.tag.clear();
        created.pane_current_command = "shell".into();
        reduce(&mut app, snapshot(vec![created], 11));

        reduce(
            &mut app,
            Event::Snapshot {
                outcome: ParseOutcome {
                    records: Vec::new(),
                    raw_panes: Default::default(),
                    ambiguous_panes: HashSet::from(["%other".into()]),
                    dropped: 1,
                    unattributable_dropped: 0,
                },
                observed_at: 12,
            },
        );

        assert!(!app.ephemeral_panes.contains(&PaneId::from("%new")));
        assert!(!app.model.panes().contains_key(&PaneId::from("%new")));
    }

    #[test]
    fn target_or_unattributable_drop_defers_absence_reconciliation() {
        for (ambiguous_panes, unattributable_dropped) in
            [(HashSet::from(["%new".into()]), 0), (HashSet::new(), 1)]
        {
            let mut app = state(Vec::new());
            app.pending_creation = Some(PendingCreation {
                id: CreationId(1),
                initiating_session: None,
                state: PendingCreationState::AwaitingSnapshot {
                    pane_id: "%new".into(),
                    resolution: CreationResolution::Success,
                },
            });

            reduce(
                &mut app,
                Event::Snapshot {
                    outcome: ParseOutcome {
                        records: Vec::new(),
                        raw_panes: Default::default(),
                        ambiguous_panes,
                        dropped: 1,
                        unattributable_dropped,
                    },
                    observed_at: 11,
                },
            );

            assert!(app.pending_creation.is_some());
        }
    }

    #[test]
    fn ordinary_500_pane_snapshot_builds_the_model_once() {
        let records: Vec<_> = (0..500)
            .map(|index| record("$start", "@start", &format!("%{index}"), index))
            .collect();
        let mut app = state(records.clone());
        crate::model::reset_build_count();

        reduce(&mut app, snapshot(records, 11));

        assert_eq!(crate::model::build_count(), 1);
    }

    #[test]
    fn fallback_selection_uses_grouped_topology_not_snapshot_input_order() {
        let selected = |records: Vec<RawRecord>| {
            let mut app = state(Vec::new());
            app.pending_creation = Some(PendingCreation {
                id: CreationId(1),
                initiating_session: None,
                state: PendingCreationState::AwaitingSnapshot {
                    pane_id: "%new".into(),
                    resolution: CreationResolution::Success,
                },
            });
            reduce(&mut app, snapshot(records, 11));
            app.focus().cloned()
        };
        let mut alpha = record("$alpha", "@alpha", "%new", 0);
        alpha.session_name = "alpha".into();
        alpha.tag = "dash-created".into();
        let mut zeta = alpha.clone();
        zeta.session_id = "$zeta".into();
        zeta.session_name = "zeta".into();
        zeta.window_id = "@zeta".into();

        assert_eq!(
            selected(vec![zeta.clone(), alpha.clone()]),
            selected(vec![alpha, zeta])
        );
        assert_eq!(
            selected(vec![record("$alpha", "@alpha", "%new", 0)]),
            Some(Focus::Pane((
                SessionId::from("$alpha"),
                WindowId::from("@alpha"),
                PaneId::from("%new"),
            )))
        );
    }

    #[test]
    fn created_pane_selection_clears_filter_and_expands_initiating_session() {
        let mut app = state(Vec::new());
        enter_query(&mut app, "missing");
        app.collapsed.insert(SessionId::from("$start"));
        app.pending_creation = Some(PendingCreation {
            id: CreationId(1),
            initiating_session: Some("$start".into()),
            state: PendingCreationState::AwaitingSnapshot {
                pane_id: "%new".into(),
                resolution: CreationResolution::Success,
            },
        });
        let mut created = record("$start", "@start", "%new", 0);
        created.tag = "dash-created".into();

        reduce(&mut app, snapshot(vec![created], 11));

        assert!(app.filter_query.is_empty());
        assert_eq!(app.input_mode, InputMode::Navigation);
        assert!(!app.collapsed.contains(&SessionId::from("$start")));
        assert_eq!(app.selected_pane(), Some(PaneId::from("%new")));
    }

    #[test]
    fn success_gone_clears_pending_with_the_tagging_exit_toast() {
        let mut app = state(Vec::new());
        app.pending_creation = Some(PendingCreation {
            id: CreationId(1),
            initiating_session: None,
            state: PendingCreationState::AwaitingSnapshot {
                pane_id: "%new".into(),
                resolution: CreationResolution::Success,
            },
        });

        reduce(&mut app, snapshot(Vec::new(), 11));

        assert!(app.pending_creation.is_none());
        assert_eq!(app.banner.as_deref(), Some("pane exited before tagging"));
    }

    #[test]
    fn command_stage_resolution_uses_exact_present_and_gone_banners() {
        for (stage, present, gone) in [
            (
                CreateStage::SendCommand,
                "pane %new created, command send failed: oops",
                "pane %new exited before command send",
            ),
            (
                CreateStage::SendEnter,
                "pane %new created, Enter failed: oops",
                "pane %new exited before Enter",
            ),
        ] {
            let pending = || PendingCreation {
                id: CreationId(1),
                initiating_session: None,
                state: PendingCreationState::AwaitingSnapshot {
                    pane_id: "%new".into(),
                    resolution: CreationResolution::CommandFailed {
                        stage,
                        error: "oops".into(),
                    },
                },
            };
            let mut present_app = state(Vec::new());
            present_app.pending_creation = Some(pending());
            let mut pane = record("$start", "@start", "%new", 0);
            pane.tag = "dash-created".into();
            reduce(&mut present_app, snapshot(vec![pane], 11));
            assert_eq!(present_app.banner.as_deref(), Some(present));

            let mut gone_app = state(Vec::new());
            gone_app.pending_creation = Some(pending());
            reduce(&mut gone_app, snapshot(Vec::new(), 11));
            assert_eq!(gone_app.banner.as_deref(), Some(gone));
        }
    }

    #[test]
    fn natural_discovery_replaces_popup_local_ephemeral_membership() {
        let mut app = state(Vec::new());
        assert!(app.ephemeral_panes.is_empty());
        app.ephemeral_panes.insert(PaneId::from("%new"));
        let mut pane = record("$start", "@start", "%new", 0);
        pane.status.clear();
        pane.pane_current_command = "shell".into();
        pane.tag.clear();
        reduce(&mut app, snapshot(vec![pane.clone()], 11));
        assert!(app.ephemeral_panes.contains(&PaneId::from("%new")));

        pane.tag = "dash-created".into();
        reduce(&mut app, snapshot(vec![pane], 12));

        assert!(app.ephemeral_panes.is_empty());
        assert!(app.model.panes().contains_key(&PaneId::from("%new")));
    }

    #[test]
    fn ambiguous_snapshot_verification_expires_at_the_ten_second_tick_boundary() {
        let mut app = state(Vec::new());
        app.pending_creation = Some(PendingCreation {
            id: CreationId(1),
            initiating_session: None,
            state: PendingCreationState::AwaitingSnapshot {
                pane_id: "%new".into(),
                resolution: CreationResolution::Success,
            },
        });
        let ambiguous = || Event::Snapshot {
            outcome: ParseOutcome {
                records: Vec::new(),
                raw_panes: Default::default(),
                ambiguous_panes: HashSet::from(["%new".into()]),
                dropped: 1,
                unattributable_dropped: 0,
            },
            observed_at: 100,
        };

        reduce(&mut app, ambiguous());
        reduce(&mut app, Event::Tick { now: 109 });
        assert!(app.pending_creation.is_some());
        let timeout = reduce(&mut app, Event::Tick { now: 110 });

        assert!(app.pending_creation.is_none());
        assert_eq!(timeout.actions, Vec::<Action>::new());
        assert_eq!(
            app.banner.as_deref(),
            Some("unable to verify pane %new after creation")
        );
        assert!(!app.ephemeral_panes.contains(&PaneId::from("%new")));
    }

    #[test]
    fn terminal_creation_uses_the_latest_reducer_clock_for_its_verification_deadline() {
        let mut app = state(Vec::new());
        reduce(&mut app, Event::Tick { now: 50 });
        app.pending_creation = Some(PendingCreation {
            id: CreationId(1),
            initiating_session: None,
            state: PendingCreationState::Tagging {
                pane_id: "%new".into(),
            },
        });

        reduce(
            &mut app,
            Event::CreationProgress(CreationProgress::Finished {
                id: CreationId(1),
                pane_id: "%new".into(),
                resolution: CreationResolution::Success,
            }),
        );
        reduce(
            &mut app,
            Event::Snapshot {
                outcome: ParseOutcome {
                    records: Vec::new(),
                    raw_panes: Default::default(),
                    ambiguous_panes: HashSet::from(["%new".into()]),
                    dropped: 1,
                    unattributable_dropped: 0,
                },
                observed_at: 51,
            },
        );
        assert!(app.pending_creation.is_some());
        assert!(!reduce(&mut app, Event::Tick { now: 59 }).changed);
        let timeout = reduce(&mut app, Event::Tick { now: 60 });

        assert!(timeout.changed);
        assert!(timeout.actions.is_empty());
        assert!(app.pending_creation.is_none());
        assert_eq!(
            app.banner.as_deref(),
            Some("unable to verify pane %new after creation")
        );
    }

    #[test]
    fn ephemeral_membership_invalidates_cache_and_counts_linked_pane_once() {
        let mut app = state(Vec::new());
        let _ = app.render_cache();
        let initial_rebuilds = app.render_cache.borrow().rebuild_count;
        app.ephemeral_panes.insert(PaneId::from("%new"));
        let mut first = record("$first", "@first", "%new", 0);
        first.pane_current_command = "shell".into();
        first.status.clear();
        first.tag.clear();
        let mut linked = first.clone();
        linked.session_id = "$second".into();
        linked.window_id = "@second".into();

        reduce(&mut app, snapshot(vec![first, linked], 11));
        let cache = app.render_cache();
        assert_eq!(cache.rebuild_count, initial_rebuilds + 1);
        assert_eq!(cache.status_counts[4], 1);
        drop(cache);
        enter_query(&mut app, "new");
        assert_eq!(visible_pane_ids(&app), vec!["%new", "%new"]);
        let rebuilds_before_removal = app.render_cache.borrow().rebuild_count;

        reduce(&mut app, snapshot(Vec::new(), 12));
        let cache = app.render_cache();
        assert_eq!(cache.rebuild_count, rebuilds_before_removal + 1);
        assert!(cache.visible_rows.is_empty());
    }

    #[test]
    fn successful_tag_does_not_protect_a_pane_after_ordinary_discovery_stops() {
        let mut app = state(Vec::new());
        app.pending_creation = Some(PendingCreation {
            id: CreationId(1),
            initiating_session: None,
            state: PendingCreationState::AwaitingSnapshot {
                pane_id: "%new".into(),
                resolution: CreationResolution::Success,
            },
        });
        let mut tagged = record("$start", "@start", "%new", 0);
        tagged.tag = "dash-created".into();
        reduce(&mut app, snapshot(vec![tagged.clone()], 11));
        assert!(app.model.panes().contains_key(&PaneId::from("%new")));

        tagged.tag.clear();
        tagged.status.clear();
        tagged.pane_current_command = "shell".into();
        reduce(&mut app, snapshot(vec![tagged], 12));

        assert!(app.ephemeral_panes.is_empty());
        assert!(!app.model.panes().contains_key(&PaneId::from("%new")));
    }

    #[test]
    fn repeated_ephemeral_snapshot_is_idempotent_after_initial_reconciliation() {
        let mut app = state(Vec::new());
        app.ephemeral_panes.insert(PaneId::from("%new"));
        let mut created = record("$start", "@start", "%new", 0);
        created.status.clear();
        created.tag.clear();
        created.pane_current_command = "shell".into();

        assert!(reduce(&mut app, snapshot(vec![created.clone()], 11)).changed);
        assert!(!reduce(&mut app, snapshot(vec![created], 12)).changed);
    }

    #[test]
    fn successful_snapshot_clears_regular_failure_without_clearing_transport_degraded() {
        let mut app = state(vec![record("$a", "@a", "%a", 0)]);
        app.transport_degraded = true;
        reduce(&mut app, Event::SnapshotFailed("temporary failure".into()));
        assert!(app.banner.is_some());

        reduce(&mut app, snapshot(vec![record("$b", "@b", "%b", 0)], 20));

        assert_eq!(app.banner, None);
        assert!(app.transport_degraded);
        assert!(app.model.panes().contains_key(&PaneId("%b".into())));
        assert!(!app.model.panes().contains_key(&PaneId("%a".into())));
    }

    #[test]
    fn moves_across_grouped_rows_and_skips_collapsed_panes() {
        let mut app = state(vec![
            record("$a", "@a", "%a", 0),
            record("$a", "@a", "%b", 1),
            record("$b", "@b", "%c", 0),
        ]);
        reduce(&mut app, key(KeyCode::Char('j')));
        reduce(&mut app, key(KeyCode::Char('j')));
        assert_eq!(
            app.selection,
            Some((
                SessionId::from("$a"),
                WindowId::from("@a"),
                PaneId::from("%a")
            ))
        );
        reduce(&mut app, key(KeyCode::Char('h')));
        reduce(&mut app, key(KeyCode::Char('j')));
        reduce(&mut app, key(KeyCode::Char('j')));
        reduce(&mut app, key(KeyCode::Char('j')));
        assert_eq!(
            app.selection,
            Some((
                SessionId::from("$b"),
                WindowId::from("@b"),
                PaneId::from("%c")
            ))
        );
    }

    #[test]
    fn g_and_g_move_to_first_and_last_visible_panes() {
        let mut app = state(vec![
            record("$a", "@a", "%a", 0),
            record("$b", "@b", "%b", 0),
        ]);
        reduce(&mut app, key(KeyCode::Char('G')));
        assert_eq!(
            app.selection,
            Some((
                SessionId::from("$b"),
                WindowId::from("@b"),
                PaneId::from("%b")
            ))
        );
        reduce(&mut app, key(KeyCode::Char('g')));
        reduce(&mut app, key(KeyCode::Char('j')));
        assert_eq!(
            app.selection,
            Some((
                SessionId::from("$a"),
                WindowId::from("@a"),
                PaneId::from("%a")
            ))
        );
    }

    #[test]
    fn selected_membership_survives_snapshot_rebuild() {
        let mut app = state(vec![
            record("$a", "@a", "%a", 0),
            record("$b", "@b", "%b", 0),
        ]);
        reduce(&mut app, key(KeyCode::Char('G')));
        reduce(
            &mut app,
            snapshot(
                vec![record("$b", "@b", "%b", 0), record("$a", "@a", "%a", 0)],
                10,
            ),
        );
        assert_eq!(
            app.selection,
            Some((
                SessionId::from("$b"),
                WindowId::from("@b"),
                PaneId::from("%b")
            ))
        );
    }

    #[test]
    fn vanished_selection_chooses_next_row_then_previous() {
        let mut app = state(vec![
            record("$a", "@a", "%a", 0),
            record("$a", "@a", "%b", 1),
            record("$a", "@a", "%c", 2),
        ]);
        reduce(&mut app, key(KeyCode::Char('j')));
        reduce(&mut app, key(KeyCode::Char('j')));
        reduce(&mut app, key(KeyCode::Char('j')));
        reduce(
            &mut app,
            snapshot(
                vec![record("$a", "@a", "%a", 0), record("$a", "@a", "%c", 2)],
                10,
            ),
        );
        assert_eq!(
            app.selection,
            Some((
                SessionId::from("$a"),
                WindowId::from("@a"),
                PaneId::from("%c")
            ))
        );
    }

    #[test]
    fn toggle_mode_emits_action_and_changes_rows() {
        let mut app = state(vec![record("$a", "@a", "%a", 0)]);
        assert!(matches!(app.model.rows(true)[0], Row::SessionHeader { .. }));
        let result = reduce(&mut app, key(KeyCode::Char('s')));
        assert_eq!(
            result.actions,
            vec![
                Action::ToggleGroup(false),
                Action::CapturePreview {
                    sequence: 1,
                    pane_id: PaneId::from("%a"),
                },
            ]
        );
        assert_eq!(app.mode, Mode::Flat);
        assert!(matches!(app.model.rows(false)[0], Row::Pane { .. }));
    }

    #[test]
    fn quit_keys_emit_quit() {
        for event in [key(KeyCode::Char('q')), key(KeyCode::Esc)] {
            let mut app = state(vec![]);
            let result = reduce(&mut app, event);
            assert_eq!(result.actions, vec![Action::Quit]);
            assert!(app.should_quit);
        }
    }

    #[test]
    fn enter_and_ctrl_z_target_headers_and_panes_with_expected_zoom() {
        for (code, modifiers, zoom) in [
            (KeyCode::Enter, KeyModifiers::NONE, false),
            (KeyCode::Char('z'), KeyModifiers::CONTROL, true),
        ] {
            let mut header_app = state(vec![record("$a", "@a", "%a", 0)]);
            reduce(&mut header_app, key(KeyCode::Char('j')));
            assert_eq!(
                reduce(&mut header_app, Event::Key(KeyEvent::new(code, modifiers))).actions,
                vec![Action::Jump {
                    target: JumpTarget::Session(SessionId::from("$a")),
                    zoom: false,
                }]
            );

            let mut pane_app = state(vec![record("$a", "@a", "%a", 0)]);
            reduce(&mut pane_app, key(KeyCode::Char('j')));
            reduce(&mut pane_app, key(KeyCode::Char('j')));
            assert_eq!(
                reduce(&mut pane_app, Event::Key(KeyEvent::new(code, modifiers))).actions,
                vec![Action::Jump {
                    target: JumpTarget::Pane(PaneId::from("%a")),
                    zoom,
                }]
            );
        }
    }

    #[test]
    fn snapshot_observation_time_controls_staleness_deterministically() {
        let mut record = record("$a", "@a", "%a", 0);
        record.heartbeat = Some(50);
        let mut app = state(vec![record.clone()]);
        reduce(&mut app, snapshot(vec![record], 111));
        assert!(matches!(
            app.model.rows(true)[1],
            Row::Pane {
                status: Status::Stale,
                ..
            }
        ));
    }

    #[test]
    fn snapshot_reconciles_live_group_mode_without_losing_selection() {
        let mut app = state(vec![record("$a", "@a", "%a", 0)]);
        reduce(&mut app, key(KeyCode::Char('j')));
        reduce(&mut app, key(KeyCode::Char('j')));
        let mut flat = record("$a", "@a", "%a", 0);
        flat.group = "0".into();
        reduce(&mut app, snapshot(vec![flat], 10));
        assert_eq!(app.mode, Mode::Flat);
        assert_eq!(
            app.selection,
            Some((
                SessionId::from("$a"),
                WindowId::from("@a"),
                PaneId::from("%a")
            ))
        );
    }

    #[test]
    fn za_toggles_and_other_second_keys_cancel_the_sequence() {
        let mut app = state(vec![record("$a", "@a", "%a", 0)]);
        reduce(&mut app, key(KeyCode::Char('j')));
        reduce(&mut app, key(KeyCode::Char('j')));
        reduce(&mut app, key(KeyCode::Char('z')));
        reduce(&mut app, key(KeyCode::Char('a')));
        assert!(app.collapsed.contains(&SessionId::from("$a")));
        reduce(&mut app, key(KeyCode::Char('l')));
        reduce(&mut app, key(KeyCode::Char('z')));
        reduce(&mut app, key(KeyCode::Char('x')));
        reduce(&mut app, key(KeyCode::Char('a')));
        assert!(!app.collapsed.contains(&SessionId::from("$a")));
    }

    #[test]
    fn tick_redraws_only_when_a_displayed_age_changes() {
        let mut record = record("$a", "@a", "%a", 0);
        record.status_since = Some(999);
        let mut app = state(vec![record]);
        app.prepare_render(1_000);

        assert!(!reduce(&mut app, Event::Tick { now: 1_000 }).changed);
        assert!(reduce(&mut app, Event::Tick { now: 1_001 }).changed);
        app.prepare_render(1_001);
        assert!(!reduce(&mut app, Event::Tick { now: 1_001 }).changed);
    }

    #[test]
    fn tick_ignores_age_changes_in_collapsed_sessions() {
        let mut record = record("$a", "@a", "%a", 0);
        record.status_since = Some(999);
        let mut app = state(vec![record]);
        reduce(&mut app, key(KeyCode::Char('j')));
        reduce(&mut app, key(KeyCode::Char('h')));
        app.prepare_render(1_000);

        assert!(!reduce(&mut app, Event::Tick { now: 1_001 }).changed);
    }

    #[test]
    fn render_cache_reuses_visible_rows_and_counts_until_its_key_changes() {
        let mut linked = record("$b", "@b", "%a", 0);
        linked.status = "needs_input".into();
        let mut app = state(vec![record("$a", "@a", "%a", 0), linked]);

        let cache = app.render_cache();
        assert_eq!(cache.visible_rows.len(), 4);
        assert_eq!(cache.status_counts[0], 1);
        drop(cache);

        reduce(&mut app, key(KeyCode::Char('j')));
        reduce(&mut app, key(KeyCode::Char('h')));
        let cache = app.render_cache();
        assert_eq!(cache.visible_rows.len(), 3);
        assert_eq!(cache.status_counts[0], 1);
    }

    #[test]
    fn selection_move_does_not_rebuild_the_render_cache() {
        let mut app = state(vec![record("$a", "@a", "%a", 0)]);
        app.prepare_render(1_000);
        let rebuilds = app.render_cache.borrow().rebuild_count;

        reduce(&mut app, key(KeyCode::Char('j')));
        app.prepare_render(1_000);

        assert_eq!(app.render_cache.borrow().rebuild_count, rebuilds);
    }

    #[test]
    fn many_panes_use_one_global_age_deadline_between_rebuilds() {
        let records = (0..100)
            .map(|index| {
                let mut record = record("$a", "@a", &format!("%{index}"), index as u32);
                record.status_since = Some(940);
                record.heartbeat = Some(1_000);
                record
            })
            .collect();
        let mut app = state(records);
        app.prepare_render(1_000);
        assert_eq!(app.age_deadline_rebuild_count, 1);

        for now in 1_001..=1_003 {
            assert!(!reduce(&mut app, Event::Tick { now }).changed);
            assert_eq!(app.age_deadline_rebuild_count, 1);
        }
        assert!(reduce(&mut app, Event::Tick { now: 1_060 }).changed);
        app.prepare_render(1_060);
        assert_eq!(app.age_deadline_rebuild_count, 2);
    }

    #[test]
    fn slash_edits_live_filter_and_escape_keeps_the_query() {
        let mut auth = record("$a", "@a", "%auth", 0);
        auth.title = "auth".into();
        let mut app = state(vec![auth, record("$b", "@b", "%worker", 0)]);

        let result = reduce(&mut app, key(KeyCode::Char('/')));
        assert!(result.changed);
        assert_eq!(app.input_mode, InputMode::Filter);
        reduce(&mut app, key(KeyCode::Char('a')));
        reduce(&mut app, key(KeyCode::Char('u')));
        assert_eq!(app.filter_query, "au");
        assert_eq!(visible_pane_ids(&app), vec!["%auth"]);

        let result = reduce(&mut app, key(KeyCode::Esc));
        assert!(result.changed);
        assert_eq!(app.input_mode, InputMode::Navigation);
        assert_eq!(app.filter_query, "au");
        assert_eq!(visible_pane_ids(&app), vec!["%auth"]);
    }

    #[test]
    fn backspace_rebuilds_projection_and_stays_in_filter_mode() {
        let mut app = state(vec![
            record("$a", "@a", "%x", 0),
            record("$b", "@b", "%y", 0),
        ]);
        enter_query(&mut app, "x");
        let _ = app.render_cache();

        reduce(&mut app, key(KeyCode::Backspace));

        assert!(app.filter_query.is_empty());
        assert_eq!(app.input_mode, InputMode::Filter);
        assert_eq!(visible_pane_ids(&app).len(), 2);
    }

    #[test]
    fn backspace_removes_one_unicode_scalar() {
        let mut app = state(vec![record("$a", "@a", "%a", 0)]);
        enter_query(&mut app, "é💡");

        reduce(&mut app, key(KeyCode::Backspace));
        assert_eq!(app.filter_query, "é");
        reduce(&mut app, key(KeyCode::Backspace));
        assert!(app.filter_query.is_empty());
    }

    #[test]
    fn filter_mode_ignores_modified_characters_and_navigation_actions() {
        let mut app = state(vec![
            record("$a", "@a", "%a", 0),
            record("$b", "@b", "%b", 0),
        ]);
        reduce(&mut app, key(KeyCode::Char('/')));
        reduce(&mut app, control_key(KeyCode::Char('x')));
        reduce(
            &mut app,
            key_with_modifiers(KeyCode::Char('x'), KeyModifiers::ALT),
        );
        reduce(
            &mut app,
            key_with_modifiers(KeyCode::Char('x'), KeyModifiers::SUPER),
        );
        reduce(
            &mut app,
            key_with_modifiers(
                KeyCode::Char('x'),
                KeyModifiers::CONTROL | KeyModifiers::SHIFT,
            ),
        );
        reduce(&mut app, key(KeyCode::Char('x')));
        reduce(&mut app, key(KeyCode::Char('j')));
        reduce(&mut app, key(KeyCode::Enter));
        reduce(&mut app, key(KeyCode::Char('z')));
        reduce(&mut app, key(KeyCode::Char('a')));

        assert_eq!(app.filter_query, "xjza");
        assert!(app.focus().is_none());
        assert!(app.pending_action.is_none());
        assert!(app.collapsed.is_empty());
    }

    #[test]
    fn filter_mode_accepts_shift_modified_characters() {
        let mut app = state(vec![record("$a", "@a", "%a", 0)]);

        reduce(&mut app, key(KeyCode::Char('/')));
        let result = reduce(&mut app, shift_key(KeyCode::Char('X')));

        assert!(result.changed);
        assert_eq!(app.filter_query, "X");
    }

    #[test]
    fn backspace_on_an_empty_filter_query_is_a_noop() {
        let mut app = state(vec![record("$a", "@a", "%a", 0)]);

        reduce(&mut app, key(KeyCode::Char('/')));
        let result = reduce(&mut app, key(KeyCode::Backspace));

        assert!(!result.changed);
        assert_eq!(app.input_mode, InputMode::Filter);
        assert!(app.filter_query.is_empty());
    }

    #[test]
    fn unmatched_query_clears_focus() {
        let mut app = state(vec![record("$a", "@a", "%a", 0)]);
        reduce(&mut app, key(KeyCode::Char('j')));
        enter_query(&mut app, "no-match");

        assert!(app.focus().is_none());
        assert!(app.selection.is_none());
    }

    #[test]
    fn query_keeps_matching_focus_or_selects_first_visible_result() {
        let mut alpha = record("$a", "@a", "%alpha", 0);
        alpha.title = "alpha".into();
        alpha.group = "0".into();
        let mut beta = record("$b", "@b", "%beta", 0);
        beta.title = "beta".into();
        beta.group = "0".into();
        let mut app = state(vec![alpha, beta]);
        reduce(&mut app, key(KeyCode::Char('G')));

        enter_query(&mut app, "beta");
        assert_eq!(
            app.selection.as_ref().map(|(_, _, pane)| pane.0.as_str()),
            Some("%beta")
        );

        reduce(&mut app, key(KeyCode::Backspace));
        reduce(&mut app, key(KeyCode::Backspace));
        reduce(&mut app, key(KeyCode::Backspace));
        reduce(&mut app, key(KeyCode::Backspace));
        for character in "alpha".chars() {
            reduce(&mut app, key(KeyCode::Char(character)));
        }
        assert_eq!(app.filter_query, "alpha");
        assert_eq!(visible_pane_ids(&app), vec!["%alpha"]);
        assert_eq!(
            app.selection.as_ref().map(|(_, _, pane)| pane.0.as_str()),
            Some("%alpha")
        );
    }

    #[test]
    fn filtering_temporarily_expands_collapsed_sessions_and_clearing_restores_collapse() {
        let mut matching = record("$a", "@a", "%a", 0);
        matching.title = "needle".into();
        let mut app = state(vec![matching]);
        app.collapsed.insert("$a".into());

        enter_query(&mut app, "needle");
        assert_eq!(visible_pane_ids(&app), vec!["%a"]);
        for _ in "needle".chars() {
            reduce(&mut app, key(KeyCode::Backspace));
        }

        assert!(app.collapsed.contains(&SessionId::from("$a")));
        assert!(visible_pane_ids(&app).is_empty());
    }

    #[test]
    fn collapse_keys_mutate_stored_state_while_filtering() {
        let mut matching = record("$a", "@a", "%a", 0);
        matching.title = "needle".into();
        let mut app = state(vec![matching]);
        enter_query(&mut app, "needle");
        reduce(&mut app, key(KeyCode::Esc));

        reduce(&mut app, key(KeyCode::Char('h')));
        assert!(app.collapsed.contains(&SessionId::from("$a")));
        assert_eq!(visible_pane_ids(&app), vec!["%a"]);
        reduce(&mut app, key(KeyCode::Char('l')));
        assert!(!app.collapsed.contains(&SessionId::from("$a")));
        reduce(&mut app, key(KeyCode::Esc));
        reduce(&mut app, key(KeyCode::Char('z')));
        reduce(&mut app, key(KeyCode::Char('a')));
        assert!(app.collapsed.contains(&SessionId::from("$a")));
    }

    #[test]
    fn collapse_survives_mode_toggles_and_snapshots_but_dead_sessions_are_removed() {
        let mut app = state(vec![
            record("$a", "@a", "%a", 0),
            record("$b", "@b", "%b", 0),
        ]);
        app.collapsed.insert("$a".into());
        reduce(&mut app, key(KeyCode::Char('s')));
        reduce(&mut app, key(KeyCode::Char('s')));
        assert!(app.collapsed.contains(&SessionId::from("$a")));

        reduce(&mut app, snapshot(vec![record("$a", "@a", "%a", 0)], 11));
        assert_eq!(
            app.collapsed,
            std::collections::HashSet::from([SessionId::from("$a")])
        );
        reduce(&mut app, snapshot(vec![record("$b", "@b", "%b", 0)], 12));
        assert!(app.collapsed.is_empty());
    }

    #[test]
    fn flat_mode_shows_panes_from_a_session_collapsed_in_grouped_mode() {
        let mut app = state(vec![
            record("$a", "@a", "%a", 0),
            record("$a", "@a", "%b", 1),
            record("$b", "@b", "%c", 0),
        ]);
        reduce(&mut app, key(KeyCode::Char('j')));
        reduce(&mut app, key(KeyCode::Char('j')));
        reduce(&mut app, key(KeyCode::Char('h')));
        assert!(app.collapsed.contains(&SessionId::from("$a")));
        assert_eq!(visible_pane_ids(&app), vec!["%c"]);

        reduce(&mut app, key(KeyCode::Char('s')));

        assert_eq!(app.mode, Mode::Flat);
        assert_eq!(visible_pane_ids(&app), vec!["%a", "%b", "%c"]);

        reduce(&mut app, key(KeyCode::Char('s')));

        assert!(app.collapsed.contains(&SessionId::from("$a")));
        assert_eq!(visible_pane_ids(&app), vec!["%c"]);
    }

    #[test]
    fn escape_quits_only_from_navigation_and_za_is_navigation_only() {
        let mut app = state(vec![record("$a", "@a", "%a", 0)]);
        reduce(&mut app, key(KeyCode::Char('/')));
        let result = reduce(&mut app, key(KeyCode::Esc));
        assert!(result.actions.is_empty());
        assert!(!app.should_quit);
        reduce(&mut app, key(KeyCode::Char('/')));
        reduce(&mut app, key(KeyCode::Char('z')));
        reduce(&mut app, key(KeyCode::Char('a')));
        assert!(app.collapsed.is_empty());
        reduce(&mut app, key(KeyCode::Esc));
        let result = reduce(&mut app, key(KeyCode::Esc));
        assert_eq!(result.actions, vec![Action::Quit]);
    }

    #[test]
    fn active_query_survives_snapshot_grouped_flat_reconciliation() {
        let mut app = state(vec![record("$a", "@a", "%a", 0)]);
        enter_query(&mut app, "a");
        let mut flat = record("$a", "@a", "%a", 0);
        flat.group = "0".into();

        reduce(&mut app, snapshot(vec![flat], 11));

        assert_eq!(app.mode, Mode::Flat);
        assert_eq!(app.filter_query, "a");
        assert_eq!(visible_pane_ids(&app), vec!["%a"]);
    }

    #[test]
    fn toggling_filtered_header_to_flat_focuses_the_first_matching_pane() {
        let mut matching = record("$a", "@a", "%a", 0);
        matching.title = "needle".into();
        let mut app = state(vec![matching]);
        enter_query(&mut app, "needle");
        assert!(matches!(app.focus(), Some(Focus::Header(_))));
        reduce(&mut app, key(KeyCode::Esc));

        reduce(&mut app, key(KeyCode::Char('s')));

        assert_eq!(app.mode, Mode::Flat);
        assert_eq!(
            app.selection,
            Some((
                SessionId::from("$a"),
                WindowId::from("@a"),
                PaneId::from("%a")
            ))
        );
    }

    #[test]
    fn snapshot_with_first_query_match_focuses_it_when_focus_was_empty() {
        let mut unmatched = record("$a", "@a", "%a", 0);
        unmatched.group = "0".into();
        let mut app = state(vec![unmatched]);
        enter_query(&mut app, "needle");
        assert!(app.focus().is_none());

        let mut matching = record("$a", "@a", "%a", 0);
        matching.group = "0".into();
        matching.title = "needle".into();
        reduce(&mut app, snapshot(vec![matching], 11));

        assert_eq!(
            app.selection,
            Some((
                SessionId::from("$a"),
                WindowId::from("@a"),
                PaneId::from("%a")
            ))
        );
    }

    #[test]
    fn new_uses_snapshot_group_mode_over_config_default() {
        let mut flat = record("$a", "@a", "%a", 0);
        flat.group = "0".into();
        let model = Model::build(&[flat], &ModelConfig::default(), 10);
        let cfg = crate::options::DashConfig {
            group_default: true,
            ..Default::default()
        };

        let app = AppState::new(model, cfg, LoadedUiConfig::default());

        assert_eq!(app.mode, Mode::Flat);
    }

    #[test]
    fn query_edits_rebuild_a_materialized_cache_once_and_reads_reuse_it() {
        let mut app = state(vec![record("$a", "@a", "%a", 0)]);
        let _ = app.render_cache();
        let initial_rebuilds = app.render_cache.borrow().rebuild_count;
        reduce(&mut app, key(KeyCode::Char('/')));
        reduce(&mut app, key(KeyCode::Char('a')));
        let _ = app.render_cache();
        assert_eq!(
            app.render_cache.borrow().rebuild_count,
            initial_rebuilds + 1
        );
        let _ = app.render_cache();
        assert_eq!(
            app.render_cache.borrow().rebuild_count,
            initial_rebuilds + 1
        );

        reduce(&mut app, key(KeyCode::Backspace));
        let _ = app.render_cache();
        assert_eq!(
            app.render_cache.borrow().rebuild_count,
            initial_rebuilds + 2
        );
        reduce(&mut app, key(KeyCode::Backspace));
        let _ = app.render_cache();
        assert_eq!(
            app.render_cache.borrow().rebuild_count,
            initial_rebuilds + 2
        );
    }

    #[test]
    fn send_modal_exclusively_edits_literal_text_and_emits_one_action() {
        let mut app = state(vec![record("$a", "@a", "%a", 0)]);
        reduce(&mut app, key(KeyCode::Char('j')));
        reduce(&mut app, key(KeyCode::Char('j')));
        reduce(
            &mut app,
            key_with_modifiers(KeyCode::Char('s'), KeyModifiers::CONTROL),
        );
        assert_eq!(
            app.modal,
            Some(Modal::Send {
                pane_id: PaneId::from("%a"),
                command: "opencode".into(),
                text: String::new(),
            })
        );

        let empty_submit = reduce(&mut app, key(KeyCode::Enter));
        assert_eq!(app.modal, None);
        assert!(empty_submit.actions.is_empty());

        reduce(
            &mut app,
            key_with_modifiers(KeyCode::Char('s'), KeyModifiers::CONTROL),
        );

        reduce(&mut app, key(KeyCode::Char('é')));
        reduce(&mut app, shift_key(KeyCode::Char('X')));
        reduce(&mut app, key(KeyCode::Backspace));
        let ignored = reduce(
            &mut app,
            key_with_modifiers(KeyCode::Char('j'), KeyModifiers::CONTROL),
        );
        assert!(ignored.actions.is_empty());
        assert_eq!(
            app.modal,
            Some(Modal::Send {
                pane_id: PaneId::from("%a"),
                command: "opencode".into(),
                text: "é".into(),
            })
        );

        let submitted = reduce(&mut app, key(KeyCode::Enter));
        assert_eq!(app.modal, None);
        assert_eq!(
            submitted.actions,
            vec![Action::SendText {
                pane_id: PaneId::from("%a"),
                text: "é".into(),
            }]
        );
    }

    #[test]
    fn send_modal_reports_non_pane_selection_and_action_outcomes() {
        let mut app = state(vec![record("$a", "@a", "%a", 0)]);
        reduce(
            &mut app,
            key_with_modifiers(KeyCode::Char('s'), KeyModifiers::CONTROL),
        );
        assert_eq!(app.banner.as_deref(), Some("select a pane, not a session"));

        reduce(&mut app, key(KeyCode::Char('j')));
        reduce(
            &mut app,
            Event::ActionFinished {
                kind: CompletedAction::Send,
                pane_id: PaneId::from("%a"),
                outcome: ActionOutcome::Vanished,
            },
        );
        assert_eq!(app.banner.as_deref(), Some("pane %a vanished, aborted"));

        reduce(
            &mut app,
            Event::ActionFinished {
                kind: CompletedAction::Send,
                pane_id: PaneId::from("%a"),
                outcome: ActionOutcome::Success,
            },
        );
        assert_eq!(app.banner, None);
    }

    #[test]
    fn kill_modal_confirms_only_unmodified_or_shift_y_and_blocks_all_other_keys() {
        let mut app = state(vec![record("$a", "@a", "%a", 0)]);

        reduce(&mut app, key(KeyCode::Char('x')));
        assert_eq!(app.banner.as_deref(), Some("select a pane, not a session"));

        reduce(&mut app, key(KeyCode::Char('j')));
        reduce(&mut app, key(KeyCode::Char('j')));

        for cancelled_key in [
            key(KeyCode::Char('j')),
            key(KeyCode::Char('n')),
            shift_key(KeyCode::Char('N')),
            key(KeyCode::Enter),
            key(KeyCode::Esc),
            key(KeyCode::Char('k')),
            key(KeyCode::Char('z')),
            key(KeyCode::Backspace),
            key_with_modifiers(KeyCode::Char('y'), KeyModifiers::CONTROL),
        ] {
            reduce(&mut app, key(KeyCode::Char('x')));
            assert_eq!(
                app.modal,
                Some(Modal::Kill {
                    pane_id: PaneId::from("%a")
                })
            );
            let preserved = (
                app.selected_pane(),
                app.focus.clone(),
                app.mode,
                app.filter_query.clone(),
                app.pending_action.clone(),
                app.should_quit,
            );

            let cancelled = reduce(&mut app, cancelled_key);
            assert!(cancelled.actions.is_empty());
            assert_eq!(app.modal, None);
            assert_eq!(
                (
                    app.selected_pane(),
                    app.focus.clone(),
                    app.mode,
                    app.filter_query.clone(),
                    app.pending_action.clone(),
                    app.should_quit,
                ),
                preserved
            );
        }

        reduce(&mut app, key(KeyCode::Char('x')));
        let confirmed = reduce(&mut app, shift_key(KeyCode::Char('Y')));
        assert_eq!(app.modal, None);
        assert_eq!(
            confirmed.actions,
            vec![Action::KillPane {
                pane_id: PaneId::from("%a"),
            }]
        );
    }

    #[test]
    fn kill_outcomes_are_silent_except_for_failures() {
        let mut app = state(vec![record("$a", "@a", "%a", 0)]);
        app.banner = Some("unrelated failure".into());

        for outcome in [ActionOutcome::Success, ActionOutcome::Vanished] {
            let result = reduce(
                &mut app,
                Event::ActionFinished {
                    kind: CompletedAction::Kill,
                    pane_id: PaneId::from("%a"),
                    outcome,
                },
            );
            assert!(!result.changed);
            assert_eq!(app.banner.as_deref(), Some("unrelated failure"));
        }

        reduce(
            &mut app,
            Event::ActionFinished {
                kind: CompletedAction::Kill,
                pane_id: PaneId::from("%a"),
                outcome: ActionOutcome::Failed("kill failed".into()),
            },
        );
        assert_eq!(app.banner.as_deref(), Some("kill failed"));
    }
}
