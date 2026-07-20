use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use pane_dash::app::{AppState, Event, Mode, reduce};
use pane_dash::model::{Model, ModelConfig};
use pane_dash::options::DashConfig;
use pane_dash::snapshot::RawRecord;
use pane_dash::ui::{format_age, render, truncate_to_width};
use ratatui::Terminal;
use ratatui::backend::TestBackend;

const NOW: u64 = 1_000;

fn record(session: &str, pane_id: &str, status: &str, title: &str) -> RawRecord {
    RawRecord {
        session_id: format!("${session}"),
        session_name: session.into(),
        window_id: format!("@{session}"),
        window_index: 1,
        window_name: "project".into(),
        pane_id: pane_id.into(),
        pane_index: 2,
        pane_active: true,
        pane_current_command: "opencode".into(),
        pane_current_path: "/tmp".into(),
        pane_dead: false,
        status: status.into(),
        status_since: Some(880),
        heartbeat: Some(NOW),
        title: title.into(),
        model: "sonnet".into(),
        tag: "important".into(),
        group: "1".into(),
    }
}

fn app(records: Vec<RawRecord>) -> AppState {
    AppState::new(
        Model::build(&records, &ModelConfig::default(), NOW),
        DashConfig::default(),
    )
}

fn draw(app: &AppState, width: u16, height: u16) -> String {
    let backend = TestBackend::new(width, height);
    let mut terminal = Terminal::new(backend).unwrap();
    terminal.draw(|frame| render(frame, app, NOW)).unwrap();
    let buffer = terminal.backend().buffer();
    (0..height)
        .map(|y| {
            (0..width)
                .map(|x| buffer[(x, y)].symbol())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn grouped_render_with_a_collapsed_session_at_80x24() {
    let mut state = app(vec![
        record("dash", "%1", "needs_input", "Fix auth refactor"),
        record("dash", "%2", "working", "Add retry logic"),
        record("web", "%3", "idle", "Inspect deployment"),
    ]);
    state.collapsed.insert("$web".into());

    insta::assert_snapshot!(draw(&state, 80, 24));
}

#[test]
fn grouped_render_at_160x50() {
    let state = app(vec![
        record("dash", "%1", "needs_input", "Fix auth refactor"),
        record("dash", "%2", "working", "Add retry logic"),
    ]);

    insta::assert_snapshot!(draw(&state, 160, 50));
}

#[test]
fn flat_render_includes_session_name() {
    let mut state = app(vec![record("dash", "%1", "working", "Add retry logic")]);
    state.mode = Mode::Flat;

    insta::assert_snapshot!(draw(&state, 80, 24));
}

#[test]
fn wide_labels_are_truncated_without_splitting_characters() {
    let state = app(vec![record(
        "dash",
        "%1",
        "working",
        "東京の長いタイトルabc",
    )]);

    insta::assert_snapshot!(draw(&state, 40, 8));
}

#[test]
fn selected_row_is_reversed() {
    let mut state = app(vec![record("dash", "%1", "working", "Add retry logic")]);
    reduce(
        &mut state,
        Event::Key(KeyEvent::new(KeyCode::Char('j'), KeyModifiers::NONE)),
    );
    reduce(
        &mut state,
        Event::Key(KeyEvent::new(KeyCode::Char('j'), KeyModifiers::NONE)),
    );

    insta::assert_snapshot!(draw(&state, 80, 24));
    let backend = TestBackend::new(80, 24);
    let mut terminal = Terminal::new(backend).unwrap();
    terminal.draw(|frame| render(frame, &state, NOW)).unwrap();
    assert!(
        terminal.backend().buffer()[(0, 1)]
            .style()
            .add_modifier
            .contains(ratatui::style::Modifier::REVERSED)
    );
}

#[test]
fn degraded_and_dropped_indicators_render() {
    let mut state = app(vec![record("dash", "%1", "error", "Build failed")]);
    state.consecutive_failures = 2;
    state.dropped_records = 3;

    insta::assert_snapshot!(draw(&state, 80, 24));
}

#[test]
fn empty_dashboard_shows_centered_hint() {
    insta::assert_snapshot!(draw(&app(vec![]), 80, 24));
}

#[test]
fn age_humanization_uses_largest_unit() {
    assert_eq!(format_age(Some(995), NOW), "5s");
    assert_eq!(format_age(Some(880), NOW), "2m");
    assert_eq!(format_age(Some(0), 10_800), "3h");
    assert_eq!(format_age(Some(0), 86_400), "1d");
    assert_eq!(format_age(None, NOW), "-");
}

#[test]
fn truncation_respects_display_width_for_wide_characters() {
    assert_eq!(truncate_to_width("東京abc", 5), "東京a");
    assert_eq!(truncate_to_width("東京abc", 4), "東京");
    assert_eq!(truncate_to_width("東京abc", 3), "東");
}
