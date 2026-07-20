use std::collections::HashSet;

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
    Jump { pane_id: PaneId, zoom: bool },
    ToggleGroup(bool),
    Quit,
}

#[derive(Debug)]
pub enum Event {
    Key(KeyEvent),
    Snapshot(ParseOutcome),
    Tick,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct ReduceResult {
    pub actions: Vec<Action>,
    pub changed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Focus {
    Header(SessionId),
    Pane(Selection),
}

pub struct AppState {
    pub model: Model,
    pub cfg: DashConfig,
    pub mode: Mode,
    pub selection: Option<Selection>,
    pub collapsed: HashSet<SessionId>,
    pub should_quit: bool,
    pub pending_action: Option<Action>,
    focus: Option<Focus>,
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
            focus: None,
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

    fn target_for_session(&self, session_id: &SessionId) -> Option<PaneId> {
        self.model
            .rows(true)
            .iter()
            .find_map(|row| match row {
                Row::Pane {
                    session_id: row_session,
                    pane_id,
                    pane_active: true,
                    ..
                } if row_session == session_id => Some(pane_id.clone()),
                _ => None,
            })
            .or_else(|| {
                self.model.rows(true).iter().find_map(|row| match row {
                    Row::Pane {
                        session_id: row_session,
                        pane_id,
                        ..
                    } if row_session == session_id => Some(pane_id.clone()),
                    _ => None,
                })
            })
    }
}

pub fn reduce(state: &mut AppState, event: Event) -> ReduceResult {
    match event {
        Event::Key(key) => reduce_key(state, key),
        Event::Snapshot(outcome) => reduce_snapshot(state, outcome),
        Event::Tick => ReduceResult::default(),
    }
}

fn reduce_key(state: &mut AppState, key: KeyEvent) -> ReduceResult {
    let mut result = ReduceResult::default();
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
            toggle_collapsed(state, &mut result)
        }
        KeyCode::Char('s') if key.modifiers == KeyModifiers::NONE => {
            state.mode = if state.grouped() {
                Mode::Flat
            } else {
                Mode::Grouped
            };
            state.collapsed.clear();
            state.focus = state.selection.clone().map(Focus::Pane);
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
    let pane_id = match &state.focus {
        Some(Focus::Pane((_, _, pane_id))) => Some(pane_id.clone()),
        Some(Focus::Header(session_id)) => state.target_for_session(session_id),
        None => None,
    };
    if let Some(pane_id) = pane_id {
        let action = Action::Jump { pane_id, zoom };
        state.pending_action = Some(action.clone());
        result.actions.push(action);
        result.changed = true;
    }
}

fn reduce_snapshot(state: &mut AppState, outcome: ParseOutcome) -> ReduceResult {
    let old_visible = state.visible_rows();
    let old_focus = state.focus.clone();
    let model = Model::build(&outcome.records, &state.model_config(), now_secs());
    if model.content_hash() == state.model.content_hash() {
        return ReduceResult::default();
    }
    state.model = model;
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

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

    use crate::app::{Action, AppState, Event, Mode, reduce};
    use crate::model::{Model, ModelConfig, PaneId, Row, SessionId, WindowId};
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
            Event::Snapshot(ParseOutcome {
                records: vec![record("$b", "@b", "%b", 0), record("$a", "@a", "%a", 0)],
                dropped: 0,
            }),
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
            Event::Snapshot(ParseOutcome {
                records: vec![record("$a", "@a", "%a", 0), record("$a", "@a", "%c", 2)],
                dropped: 0,
            }),
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
}
