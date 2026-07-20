use std::cell::{RefCell, RefMut};
use std::collections::{HashMap, HashSet};

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

use crate::filter::ranked_row_indices;
use crate::model::{Model, ModelConfig, PaneId, Row, SessionId, WindowId};
use crate::options::DashConfig;
use crate::snapshot::ParseOutcome;

type Selection = (SessionId, WindowId, PaneId);

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
    Jump { target: JumpTarget, zoom: bool },
    ToggleGroup(bool),
    Quit,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JumpTarget {
    Session(SessionId),
    Pane(PaneId),
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
    focus: Option<Focus>,
    pending_key: Option<KeyCode>,
    render_cache: RefCell<RenderCache>,
    render_revision: u64,
    next_age_deadline: Option<u64>,
    age_deadline_revision: Option<u64>,
    #[cfg(test)]
    age_deadline_rebuild_count: usize,
}

impl AppState {
    pub fn new(model: Model, cfg: DashConfig) -> Self {
        let mode = if model.grouped() {
            Mode::Grouped
        } else {
            Mode::Flat
        };
        Self {
            mode,
            model,
            cfg,
            input_mode: InputMode::Navigation,
            filter_query: String::new(),
            selection: None,
            collapsed: HashSet::new(),
            should_quit: false,
            pending_action: None,
            consecutive_failures: 0,
            dropped_records: 0,
            banner: None,
            focus: None,
            pending_key: None,
            render_cache: RefCell::new(RenderCache::default()),
            render_revision: 0,
            next_age_deadline: None,
            age_deadline_revision: None,
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

    fn grouped(&self) -> bool {
        self.mode == Mode::Grouped
    }

    pub(crate) fn focus(&self) -> Option<&Focus> {
        self.focus.as_ref()
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
        self.filter_query.is_empty() && self.collapsed.contains(session_id)
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
    match event {
        Event::Key(key) => reduce_key(state, key),
        Event::Snapshot {
            outcome,
            observed_at,
        } => reduce_snapshot(state, outcome, observed_at),
        Event::SnapshotFailed(error) => reduce_snapshot_failure(state, error),
        Event::Tick { now } => reduce_tick(state, now),
    }
}

fn reduce_tick(state: &mut AppState, now: u64) -> ReduceResult {
    let changed = state
        .next_age_deadline
        .is_some_and(|deadline| now >= deadline);
    if changed {
        state.age_deadline_revision = None;
    }
    ReduceResult {
        actions: Vec::new(),
        changed,
    }
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
    let mut result = ReduceResult::default();
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
            KeyCode::Char(character) if key.modifiers == KeyModifiers::NONE => {
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
        KeyCode::Enter => emit_jump(state, false, &mut result),
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
    let old_visible = state.visible_rows();
    let old_focus = state.focus.clone();
    let dropped_changed = state.dropped_records != outcome.dropped;
    let model = Model::build(&outcome.records, &state.model_config(), observed_at);
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
    {
        return ReduceResult::default();
    }
    state.model = model;
    state.mode = mode;
    state.invalidate_render_cache();
    state.consecutive_failures = 0;
    state.dropped_records = outcome.dropped;
    state.banner = None;
    state
        .collapsed
        .retain(|session_id| state.model.sessions().contains_key(session_id));
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
    state.sync_selection();
    ReduceResult {
        actions: Vec::new(),
        changed: true,
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
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

    use crate::app::{Action, AppState, Event, Focus, InputMode, JumpTarget, Mode, reduce};
    use crate::model::{Model, ModelConfig, PaneId, Row, SessionId, Status, WindowId};
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
        )
    }

    fn key(code: KeyCode) -> Event {
        Event::Key(KeyEvent::new(code, KeyModifiers::NONE))
    }

    fn control_key(code: KeyCode) -> Event {
        Event::Key(KeyEvent::new(code, KeyModifiers::CONTROL))
    }

    fn modified_key(code: KeyCode) -> Event {
        Event::Key(KeyEvent::new(code, KeyModifiers::SHIFT))
    }

    fn enter_query(app: &mut AppState, query: &str) {
        reduce(app, key(KeyCode::Char('/')));
        for character in query.chars() {
            reduce(app, key(KeyCode::Char(character)));
        }
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
                records,
                dropped: 0,
            },
            observed_at,
        }
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
        assert_eq!(result.actions, vec![Action::ToggleGroup(false)]);
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
    fn enter_and_ctrl_z_target_session_headers_without_zoom() {
        for event in [key(KeyCode::Enter), control_key(KeyCode::Char('z'))] {
            let mut app = state(vec![record("$a", "@a", "%a", 0)]);
            reduce(&mut app, key(KeyCode::Char('j')));
            let result = reduce(&mut app, event);
            assert_eq!(
                result.actions,
                vec![Action::Jump {
                    target: JumpTarget::Session(SessionId::from("$a")),
                    zoom: false,
                }]
            );
        }
    }

    #[test]
    fn enter_and_ctrl_z_target_panes_with_expected_zoom() {
        for (event, zoom) in [
            (key(KeyCode::Enter), false),
            (control_key(KeyCode::Char('z')), true),
        ] {
            let mut app = state(vec![record("$a", "@a", "%a", 0)]);
            reduce(&mut app, key(KeyCode::Char('j')));
            reduce(&mut app, key(KeyCode::Char('j')));
            let result = reduce(&mut app, event);
            assert_eq!(
                result.actions,
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
        reduce(&mut app, modified_key(KeyCode::Char('x')));
        reduce(&mut app, key(KeyCode::Char('j')));
        reduce(&mut app, key(KeyCode::Enter));
        reduce(&mut app, key(KeyCode::Char('z')));
        reduce(&mut app, key(KeyCode::Char('a')));

        assert_eq!(app.filter_query, "jza");
        assert!(app.focus().is_none());
        assert!(app.pending_action.is_none());
        assert!(app.collapsed.is_empty());
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

        let app = AppState::new(model, cfg);

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
}
