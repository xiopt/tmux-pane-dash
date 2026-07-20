use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use pane_dash::app::{AppState, Event, Mode, reduce};
use pane_dash::model::{Model, ModelConfig, PaneId};
use pane_dash::options::DashConfig;
use pane_dash::preview::PreviewFrame;
use pane_dash::snapshot::RawRecord;
use pane_dash::ui::{dashboard_areas, format_age, preview_inner_height, render, truncate_to_width};
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use unicode_width::UnicodeWidthStr;

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
    draw_at(app, width, height, NOW)
}

fn draw_at(app: &AppState, width: u16, height: u16, now: u64) -> String {
    let backend = TestBackend::new(width, height);
    let mut terminal = Terminal::new(backend).unwrap();
    terminal.draw(|frame| render(frame, app, now)).unwrap();
    let buffer = terminal.backend().buffer();
    (0..height)
        .map(|y| {
            (0..width)
                .map(|x| buffer[(x, y)].symbol())
                .collect::<String>()
                .trim_end()
                .to_owned()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn dashboard_layout_switches_at_one_hundred_columns() {
    let horizontal = dashboard_areas(Rect::new(0, 0, 160, 50));
    assert!(horizontal.horizontal);
    assert_eq!(horizontal.list, Rect::new(0, 0, 72, 50));
    assert_eq!(horizontal.preview, Rect::new(72, 0, 88, 50));

    let vertical = dashboard_areas(Rect::new(0, 0, 99, 50));
    assert!(!vertical.horizontal);
    assert_eq!(vertical.list, Rect::new(0, 0, 99, 23));
    assert_eq!(vertical.preview, Rect::new(0, 23, 99, 27));

    assert!(dashboard_areas(Rect::new(0, 0, 100, 50)).horizontal);
}

#[test]
fn preview_height_uses_the_same_vertical_layout_and_border_as_rendering() {
    let state = app(vec![record("dash", "%1", "working", "Task")]);
    assert_eq!(preview_inner_height(&state, Rect::new(0, 0, 160, 50)), 49);
    assert_eq!(preview_inner_height(&state, Rect::new(0, 0, 80, 24)), 12);
}

#[test]
fn preview_hints_distinguish_selection_waiting_and_capture_failure() {
    let state = app(vec![record("dash", "%1", "working", "Task")]);
    assert!(draw(&state, 80, 24).contains("select a pane to preview"));

    let mut waiting = app(vec![record("dash", "%1", "working", "Task")]);
    waiting.preview.target = Some(PaneId::from("%1"));
    assert!(draw(&waiting, 80, 24).contains("capturing pane…"));

    waiting.preview.error = Some("pane vanished".into());
    assert!(draw(&waiting, 80, 24).contains("preview unavailable: pane vanished"));
    insta::assert_snapshot!("preview_hints", draw(&waiting, 80, 24));
}

#[test]
fn preview_follows_bottom_and_inspect_scrolls_back_from_it() {
    let state = with_preview(
        app(vec![record("dash", "%1", "working", "Task")]),
        preview((0..20).map(|line| Line::raw(format!("line-{line:02}")))),
    );
    let followed = draw(&state, 80, 24);
    assert!(followed.contains("line-08"));
    assert!(followed.contains("line-19"));
    assert!(!followed.contains("line-07"));

    let mut inspected = state;
    inspected.preview.inspect = true;
    inspected.preview.lines_from_bottom = 3;
    let scrolled = draw(&inspected, 80, 24);
    assert!(scrolled.contains("line-05"));
    assert!(scrolled.contains("line-16"));
    assert!(!scrolled.contains("line-17"));
    insta::assert_snapshot!("preview_follow_bottom", followed);
    insta::assert_snapshot!("preview_inspect_scroll", scrolled);
}

#[test]
fn preview_preserves_span_style_and_clips_wide_combining_lines_without_wrapping() {
    let state = with_preview(
        app(vec![record("dash", "%1", "working", "Task")]),
        preview([Line::from(vec![Span::styled(
            "東京e\u{301}abcdefgh",
            Style::default()
                .fg(Color::Red)
                .bg(Color::Blue)
                .add_modifier(Modifier::BOLD),
        )])]),
    );
    let backend = TestBackend::new(100, 8);
    let mut terminal = Terminal::new(backend).unwrap();
    terminal.draw(|frame| render(frame, &state, NOW)).unwrap();
    let buffer = terminal.backend().buffer();
    assert_eq!(buffer[(46, 0)].symbol(), "東");
    assert_eq!(buffer[(46, 0)].fg, Color::Red);
    assert_eq!(buffer[(46, 0)].bg, Color::Blue);
    assert!(
        buffer[(46, 0)]
            .style()
            .add_modifier
            .contains(Modifier::BOLD)
    );
    assert!(!draw(&state, 8, 8).contains("abcdefgh"));
    insta::assert_snapshot!("preview_styled_wide_clipped", draw(&state, 100, 8));
}

#[test]
fn preview_viewport_feedback_clamps_the_inspect_offset() {
    let mut selected = app(vec![record("dash", "%1", "working", "Task")]);
    reduce(
        &mut selected,
        Event::Key(KeyEvent::new(KeyCode::Char('j'), KeyModifiers::NONE)),
    );
    reduce(
        &mut selected,
        Event::Key(KeyEvent::new(KeyCode::Char('j'), KeyModifiers::NONE)),
    );
    let mut state = with_preview(
        selected,
        preview((0..20).map(|line| Line::raw(format!("line-{line:02}")))),
    );
    state.preview.inspect = true;
    reduce(&mut state, Event::PreviewViewport(12));
    state.preview.lines_from_bottom = usize::MAX;
    reduce(&mut state, Event::PreviewViewport(12));
    assert_eq!(state.preview.viewport_height, 12);
    assert_eq!(state.preview.lines_from_bottom, 8);
}

#[test]
fn inspect_status_survives_narrow_status_truncation_with_all_counts() {
    let mut stale = record("dash", "%6", "working", "Stale");
    stale.heartbeat = Some(0);
    let mut state = with_preview(
        app(vec![
            record("dash", "%1", "needs_input", "Input"),
            record("dash", "%2", "working", "Work"),
            record("dash", "%3", "idle", "Idle"),
            record("dash", "%4", "error", "Error"),
            record("dash", "%5", "unknown", "Unknown"),
            stale,
        ]),
        preview([Line::raw("capture")]),
    );
    enter_query(&mut state, "東京e\u{301}long-query");
    state.preview.inspect = true;
    state.transport_degraded = true;

    let status = draw(&state, 40, 12).lines().last().unwrap().to_owned();
    for token in [
        "N1", "W1", "I1", "E1", "U1", "S1", "P6", "grouped", "FILTER", "INSPECT",
    ] {
        assert!(status.contains(token), "missing {token} in {status}");
    }
    insta::assert_snapshot!("degraded_inspect_narrow_status", draw(&state, 40, 12));
}

#[test]
fn tiny_dashboard_dimensions_never_panic() {
    let state = with_preview(
        app(vec![record("dash", "%1", "working", "Task")]),
        preview([Line::raw("capture")]),
    );
    for width in 0..4 {
        for height in 0..4 {
            let _ = draw(&state, width, height);
        }
    }
}

#[test]
fn degraded_alert_remains_visible_with_snapshot_and_dropped_record_alerts() {
    let mut state = app(vec![record("dash", "%1", "working", "Task")]);
    state.transport_degraded = true;
    state.banner = Some("snapshot failed (2): tmux unavailable".into());
    state.dropped_records = 1;

    let rendered = draw(&state, 80, 10);

    assert!(rendered.contains("live updates lost — polling"));
    assert!(rendered.contains("snapshot failed (2): tmux unavailable"));
    assert!(rendered.contains("dropped: 1"));
}

fn buffer_line_widths(app: &AppState, width: u16, height: u16) -> Vec<usize> {
    let backend = TestBackend::new(width, height);
    let mut terminal = Terminal::new(backend).unwrap();
    terminal.draw(|frame| render(frame, app, NOW)).unwrap();
    let buffer = terminal.backend().buffer();
    (0..height)
        .map(|y| {
            let mut used = 0;
            let mut x = 0;
            while x < width {
                let symbol_width = buffer[(x, y)].symbol().width().max(1) as u16;
                used += usize::from(symbol_width);
                x = x.saturating_add(symbol_width);
            }
            used
        })
        .collect()
}

fn enter_query(app: &mut AppState, query: &str) {
    reduce(
        app,
        Event::Key(KeyEvent::new(KeyCode::Char('/'), KeyModifiers::NONE)),
    );
    for character in query.chars() {
        reduce(
            app,
            Event::Key(KeyEvent::new(KeyCode::Char(character), KeyModifiers::NONE)),
        );
    }
}

fn clear_query(app: &mut AppState) {
    reduce(
        app,
        Event::Key(KeyEvent::new(KeyCode::Char('/'), KeyModifiers::NONE)),
    );
    for _ in app.filter_query.chars().collect::<Vec<_>>() {
        reduce(
            app,
            Event::Key(KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE)),
        );
    }
}

fn preview(lines: impl IntoIterator<Item = Line<'static>>) -> PreviewFrame {
    PreviewFrame {
        pane_id: PaneId::from("%1"),
        lines: lines.into_iter().collect(),
    }
}

fn with_preview(mut state: AppState, frame: PreviewFrame) -> AppState {
    state.preview.target = Some(PaneId::from("%1"));
    state.preview.frame = Some(frame);
    state
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

    let rendered = draw(&state, 80, 8);
    assert!(rendered.contains("東 京"));
    insta::assert_snapshot!(rendered);
}

#[test]
fn label_width_uses_the_actual_prefix_and_keeps_a_final_wide_character_in_bounds() {
    let retained = format!("{}東", "a".repeat(29));
    let title = format!("{retained}tail");
    let state = app(vec![record("dash", "%1", "working", &title)]);
    let rendered = draw(&state, 80, 8);
    assert!(rendered.contains(&retained));
    assert!(!rendered.contains("tail"));

    let backend = TestBackend::new(80, 8);
    let mut terminal = Terminal::new(backend).unwrap();
    terminal.draw(|frame| render(frame, &state, NOW)).unwrap();
    assert_eq!(terminal.backend().buffer()[(78, 1)].symbol(), "東");
    assert_eq!(terminal.backend().buffer()[(79, 1)].symbol(), " ");
}

#[test]
fn status_counts_deduplicate_linked_panes() {
    let mut linked = record("web", "%1", "needs_input", "Input");
    linked.window_id = "@web".into();
    let state = app(vec![record("dash", "%1", "needs_input", "Input"), linked]);

    let rendered = draw(&state, 80, 24);
    assert!(rendered.contains("needs_input 1"));
    assert!(rendered.contains("1 panes"));
    assert!(!rendered.contains("needs_input 2"));
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
fn focused_header_is_reversed() {
    let mut state = app(vec![record("dash", "%1", "working", "Add retry logic")]);
    reduce(
        &mut state,
        Event::Key(KeyEvent::new(KeyCode::Char('j'), KeyModifiers::NONE)),
    );

    let backend = TestBackend::new(80, 24);
    let mut terminal = Terminal::new(backend).unwrap();
    terminal.draw(|frame| render(frame, &state, NOW)).unwrap();
    assert!(
        terminal.backend().buffer()[(0, 0)]
            .style()
            .add_modifier
            .contains(ratatui::style::Modifier::REVERSED)
    );
}

#[test]
fn focused_header_scrolls_into_view() {
    let mut state = app((0..12)
        .map(|index| {
            record(
                &format!("session-{index:02}"),
                &format!("%{index}"),
                "idle",
                "Work",
            )
        })
        .collect());
    reduce(
        &mut state,
        Event::Key(KeyEvent::new(KeyCode::Char('G'), KeyModifiers::NONE)),
    );
    reduce(
        &mut state,
        Event::Key(KeyEvent::new(KeyCode::Char('k'), KeyModifiers::NONE)),
    );

    let backend = TestBackend::new(80, 4);
    let mut terminal = Terminal::new(backend).unwrap();
    terminal.draw(|frame| render(frame, &state, NOW)).unwrap();
    assert!(
        terminal.backend().buffer()[(0, 0)]
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
fn alerts_remain_visible_with_all_statuses_at_80_columns() {
    let mut stale = record("dash", "%6", "working", "Stale");
    stale.heartbeat = Some(0);
    let mut state = app(vec![
        record("dash", "%1", "needs_input", "Input"),
        record("dash", "%2", "working", "Work"),
        record("dash", "%3", "idle", "Idle"),
        record("dash", "%4", "error", "Error"),
        record("dash", "%5", "unknown", "Unknown"),
        stale,
    ]);
    state.dropped_records = 3;
    state.consecutive_failures = 2;
    state.banner = Some("snapshot failed (2): tmux unavailable".into());

    let rendered = draw(&state, 80, 24);
    assert!(rendered.contains("⚠ polling failures: 2"));
    assert!(rendered.contains("dropped: 3"));
    assert!(rendered.contains("snapshot failed (2): tmux unavailable"));
    assert!(rendered.contains("grouped | NAV"));
    insta::assert_snapshot!(rendered);
}

#[test]
fn long_banner_wraps_instead_of_clipping() {
    let mut state = app(vec![record("dash", "%1", "idle", "Idle")]);
    let banner = "x".repeat(120);
    state.banner = Some(banner.clone());

    assert!(draw(&state, 80, 24).replace('\n', "").contains(&banner));
}

#[test]
fn narrow_multiword_banner_wraps_without_losing_words() {
    let mut state = app(vec![record("dash", "%1", "idle", "Idle")]);
    state.banner = Some("123456 123456 123456".into());

    let rendered = draw(&state, 10, 8);
    assert_eq!(rendered.matches("123456").count(), 3);
}

#[test]
fn needs_input_status_text_uses_the_status_color() {
    let state = app(vec![record("dash", "%1", "needs_input", "Input")]);
    let backend = TestBackend::new(80, 24);
    let mut terminal = Terminal::new(backend).unwrap();
    terminal.draw(|frame| render(frame, &state, NOW)).unwrap();

    assert_eq!(
        terminal.backend().buffer()[(4, 1)].fg,
        ratatui::style::Color::Red
    );
}

#[test]
fn empty_dashboard_shows_centered_hint() {
    insta::assert_snapshot!(draw(&app(vec![]), 80, 24));
}

#[test]
fn filter_input_and_retained_query_are_visible() {
    let mut auth = record("dash", "%1", "working", "auth");
    auth.pane_current_path = "/work/auth".into();
    let mut state = app(vec![auth, record("dash", "%2", "idle", "worker")]);

    enter_query(&mut state, "auth");
    let editing = draw(&state, 80, 12);
    assert!(editing.contains("FILTER: auth"));
    insta::assert_snapshot!(editing);

    reduce(
        &mut state,
        Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)),
    );
    let retained = draw(&state, 80, 12);
    assert!(retained.contains("NAV"));
    assert!(retained.contains("filter: auth"));
    insta::assert_snapshot!(retained);
}

#[test]
fn no_matches_is_distinct_from_empty_dashboard() {
    let mut populated = app(vec![record("dash", "%1", "working", "Work")]);
    enter_query(&mut populated, "definitely-no-match");
    assert!(draw(&populated, 80, 12).contains("no panes match filter"));

    let mut empty = app(Vec::new());
    enter_query(&mut empty, "retained-query");
    assert!(draw(&empty, 80, 12).contains("no opencode panes found"));
}

#[test]
fn grouped_filter_expands_a_stored_collapsed_session_until_query_is_cleared() {
    let mut state = app(vec![record("web", "%1", "working", "auth")]);
    state.collapsed.insert("$web".into());

    enter_query(&mut state, "auth");
    let filtered = draw(&state, 80, 12);
    assert!(filtered.contains("▾ web (1)"));
    assert!(filtered.contains("auth"));
    insta::assert_snapshot!(filtered);

    clear_query(&mut state);
    let restored = draw(&state, 80, 12);
    assert!(restored.contains("▸ web (1)"));
    assert!(!restored.contains("auth"));
    insta::assert_snapshot!(restored);
}

#[test]
fn flat_filtered_results_render_in_fuzzy_score_order() {
    let mut state = app(vec![
        record("dash", "%1", "working", "a---b---c"),
        record("dash", "%2", "idle", "abc"),
    ]);
    state.mode = Mode::Flat;
    enter_query(&mut state, "abc");

    let rendered = draw(&state, 80, 12);
    assert!(rendered.find("sonnet  abc").unwrap() < rendered.find("a---b---c").unwrap());
}

#[test]
fn filtering_keeps_canonical_counts_and_identifies_the_current_mode() {
    let mut state = app(vec![
        record("dash", "%1", "working", "auth"),
        record("dash", "%2", "idle", "worker"),
    ]);
    enter_query(&mut state, "auth");
    let grouped = draw(&state, 80, 12);
    assert!(grouped.contains("working 1"));
    assert!(grouped.contains("idle 1"));
    assert!(grouped.contains("2 panes"));
    assert!(grouped.contains("grouped | FILTER: auth"));

    state.mode = Mode::Flat;
    let flat = draw(&state, 80, 12);
    assert!(flat.contains("flat | FILTER: auth"));
}

#[test]
fn narrow_status_truncates_unicode_query_without_losing_failure_indicators() {
    let mut stale = record("dash", "%6", "working", "Stale");
    stale.heartbeat = Some(0);
    let mut state = app(vec![
        record("dash", "%1", "needs_input", "Input"),
        record("dash", "%2", "working", "Work"),
        record("dash", "%3", "idle", "Idle"),
        record("dash", "%4", "error", "Error"),
        record("dash", "%5", "unknown", "Unknown"),
        stale,
    ]);
    state.consecutive_failures = 2;
    state.dropped_records = 3;
    state.banner = Some("snapshot failed (2): tmux unavailable".into());
    enter_query(&mut state, "東京e\u{301}long-query");

    let rendered = draw(&state, 40, 12);
    assert!(rendered.contains("⚠ polling failures: 2"));
    assert!(rendered.contains("dropped: 3"));
    assert!(rendered.contains("snapshot failed (2): tmux unavailable"));
    let status = rendered.lines().last().unwrap();
    let compact_status = status.replace(' ', "");
    assert!(status.contains("grouped"));
    assert!(status.contains("FILTER"));
    assert!(compact_status.contains("東京e\u{301}"));
    for count in ["N1", "W1", "I1", "E1", "U1", "S1", "P6"] {
        assert!(status.contains(count), "missing {count} in {status}");
    }
    assert!(!rendered.contains('\u{fffd}'));
    assert!(
        buffer_line_widths(&state, 40, 12)
            .into_iter()
            .all(|width| width <= 40)
    );
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
