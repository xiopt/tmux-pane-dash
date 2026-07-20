use std::cell::{RefCell, RefMut};
use std::collections::{HashMap, HashSet};

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

use crate::model::{Model, ModelConfig, PaneId, Row, SessionId, WindowId};
use crate::options::DashConfig;
use crate::snapshot::ParseOutcome;

type Selection = (SessionId, WindowId, PaneId);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Grouped,
    Flat,
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
        Self {
            mode: if cfg.group_default {
                Mode::Grouped
            } else {
                Mode::Flat
            },
            model,
            cfg,
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
            for (index, row) in self.model.rows(grouped).iter().enumerate() {
                let focus =
                    match row {
                        Row::SessionHeader { session_id, .. } => {
                            Some(Focus::Header(session_id.clone()))
                        }
                        Row::Pane {
                            session_id,
                            window_id,
                            pane_id,
                            ..
                        } if !grouped || !self.collapsed.contains(session_id) => Some(Focus::Pane(
                            (session_id.clone(), window_id.clone(), pane_id.clone()),
                        )),
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
        self.model
            .rows(self.grouped())
            .iter()
            .filter_map(|row| match row {
                Row::SessionHeader { session_id, .. } => Some(Focus::Header(session_id.clone())),
                Row::Pane {
                    session_id,
                    window_id,
                    pane_id,
                    ..
                } if !self.grouped() || !self.collapsed.contains(session_id) => Some(Focus::Pane(
                    (session_id.clone(), window_id.clone(), pane_id.clone()),
                )),
                Row::Pane { .. } => None,
            })
            .collect()
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
            state.collapsed.clear();
            state.pending_key = None;
            state.focus = state.selection.clone().map(Focus::Pane);
            state.invalidate_render_cache();
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
        });
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

    use crate::app::{Action, AppState, Event, JumpTarget, Mode, reduce};
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
}
