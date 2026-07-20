use ratatui::Frame;
use ratatui::layout::{Alignment, Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use crate::app::{AppState, Mode};
use crate::model::{Row, Status};

pub mod palette {
    use ratatui::style::Color;

    pub const TEXT: Color = Color::Gray;
    pub const DIM: Color = Color::DarkGray;
    pub const ACCENT: Color = Color::Cyan;
    pub const NEEDS_INPUT: Color = Color::Red;
    pub const WORKING: Color = Color::Yellow;
    pub const IDLE: Color = Color::Gray;
    pub const ERROR: Color = Color::Red;
    pub const STATUS_BAR: Color = Color::DarkGray;
    pub const DEGRADE: Color = Color::Red;
}

pub fn render(frame: &mut Frame, app: &AppState, now: u64) {
    let [list_area, status_area] =
        Layout::vertical([Constraint::Min(0), Constraint::Length(1)]).areas(frame.area());
    let rows = visible_rows(app);
    if rows.is_empty() {
        let hint_area = Rect::new(
            list_area.x,
            list_area.y.saturating_add(list_area.height / 2),
            list_area.width,
            1,
        );
        frame.render_widget(
            Paragraph::new("no opencode panes found")
                .alignment(Alignment::Center)
                .style(Style::default().fg(palette::DIM)),
            hint_area,
        );
    } else {
        let selected = app.selection.as_ref();
        let selected_index = rows.iter().position(|row| match row {
            Row::Pane {
                session_id,
                window_id,
                pane_id,
                ..
            } => selected == Some(&(session_id.clone(), window_id.clone(), pane_id.clone())),
            Row::SessionHeader { .. } => false,
        });
        let offset = scroll_offset(selected_index, rows.len(), list_area.height as usize);
        let lines = rows
            .iter()
            .enumerate()
            .skip(offset)
            .take(list_area.height as usize)
            .map(|(index, row)| {
                row_line(
                    row,
                    app,
                    index == selected_index.unwrap_or(usize::MAX),
                    now,
                    list_area.width,
                )
            })
            .collect::<Vec<_>>();
        frame.render_widget(Paragraph::new(lines), list_area);
    }
    frame.render_widget(status_bar(app), status_area);
}

fn visible_rows(app: &AppState) -> Vec<&Row> {
    let grouped = matches!(app.mode, Mode::Grouped);
    app.model
        .rows(grouped)
        .iter()
        .filter(|row| match row {
            Row::Pane { session_id, .. } => !grouped || !app.collapsed.contains(session_id),
            Row::SessionHeader { .. } => true,
        })
        .collect()
}

fn scroll_offset(selected: Option<usize>, row_count: usize, height: usize) -> usize {
    if height == 0 || row_count <= height {
        return 0;
    }
    selected
        .unwrap_or(0)
        .saturating_sub(height.saturating_sub(1))
        .min(row_count - height)
}

fn row_line(row: &Row, app: &AppState, selected: bool, now: u64, width: u16) -> Line<'static> {
    let mut spans = match row {
        Row::SessionHeader {
            session_id,
            name,
            pane_count,
            working_count,
            ..
        } => {
            let marker = if app.collapsed.contains(session_id) {
                "▸"
            } else {
                "▾"
            };
            let mut spans = vec![Span::styled(
                format!("{marker} {name} ({pane_count})"),
                Style::default().fg(palette::ACCENT),
            )];
            if *working_count > 0 {
                let suffix = format!("{working_count} working");
                let used = spans.iter().map(|span| span.content.width()).sum::<usize>();
                spans.push(Span::raw(
                    " ".repeat(
                        usize::from(width)
                            .saturating_sub(used + suffix.width())
                            .max(1),
                    ),
                ));
                spans.push(Span::styled(suffix, Style::default().fg(palette::WORKING)));
            }
            spans
        }
        Row::Pane {
            session_id,
            window_index,
            pane_index,
            command,
            title,
            tag,
            model,
            status,
            status_since,
            ..
        } => {
            let (indent, session) = if matches!(app.mode, Mode::Grouped) {
                ("  ", String::new())
            } else {
                ("", app.model.sessions()[session_id].name.clone())
            };
            let label = [title, tag, command]
                .iter()
                .find(|value| !value.is_empty())
                .map_or("", |value| value.as_str());
            let prefix = if session.is_empty() {
                format!(
                    "{indent} {:<11} {:>3} {:>4}.{: <2} ",
                    status_text(*status),
                    format_age(*status_since, now),
                    window_index,
                    pane_index
                )
            } else {
                format!(
                    " {:<11} {:>3} {:>4}.{: <2} {:<10} ",
                    status_text(*status),
                    format_age(*status_since, now),
                    window_index,
                    pane_index,
                    session
                )
            };
            let label = truncate_to_width(
                label,
                usize::from(width).saturating_sub(prefix.width() + model.width() + 3),
            );
            vec![
                Span::raw(indent),
                Span::styled(
                    status_glyph(*status),
                    Style::default().fg(status_color(*status)),
                ),
                Span::raw(prefix.trim_start_matches(indent).to_owned()),
                Span::styled(model.clone(), Style::default().fg(palette::DIM)),
                Span::raw("  "),
                Span::styled(label, Style::default().fg(palette::TEXT)),
            ]
        }
    };
    let used = spans.iter().map(|span| span.content.width()).sum::<usize>();
    spans.push(Span::raw(
        " ".repeat(usize::from(width).saturating_sub(used)),
    ));
    Line::from(spans).style(if selected {
        Style::default().add_modifier(Modifier::REVERSED)
    } else {
        Style::default()
    })
}

fn status_bar(app: &AppState) -> Paragraph<'static> {
    let mut counts = [0_usize; 6];
    for row in app.model.rows(false) {
        if let Row::Pane { status, .. } = row {
            counts[status_index(*status)] += 1;
        }
    }
    let mut pieces = [
        Status::NeedsInput,
        Status::Working,
        Status::Idle,
        Status::Error,
        Status::Unknown,
        Status::Stale,
    ]
    .into_iter()
    .filter_map(|status| {
        let count = counts[status_index(status)];
        (count > 0).then(|| format!("{} {count}", status_text(status)))
    })
    .collect::<Vec<_>>();
    pieces.push(format!("{} panes", counts.iter().sum::<usize>()));
    pieces.push(match app.mode {
        Mode::Grouped => "[grouped]".into(),
        Mode::Flat => "[flat]".into(),
    });
    if app.dropped_records > 0 {
        pieces.push(format!("dropped: {}", app.dropped_records));
    }
    let mut spans = vec![Span::styled(
        pieces.join("  "),
        Style::default().fg(palette::STATUS_BAR),
    )];
    if app.consecutive_failures > 0 {
        spans.push(Span::raw("  "));
        spans.push(Span::styled(
            format!("⚠ polling failures: {}", app.consecutive_failures),
            Style::default().fg(palette::DEGRADE),
        ));
    }
    Paragraph::new(Line::from(spans))
}

fn status_index(status: Status) -> usize {
    match status {
        Status::NeedsInput => 0,
        Status::Working => 1,
        Status::Idle => 2,
        Status::Error => 3,
        Status::Unknown => 4,
        Status::Stale => 5,
    }
}
fn status_glyph(status: Status) -> &'static str {
    match status {
        Status::NeedsInput => "●",
        Status::Working => "◐",
        Status::Idle => "○",
        Status::Error => "✗",
        Status::Unknown => "?",
        Status::Stale => "⊘",
    }
}
fn status_text(status: Status) -> &'static str {
    match status {
        Status::NeedsInput => "needs_input",
        Status::Working => "working",
        Status::Idle => "idle",
        Status::Error => "error",
        Status::Unknown => "unknown",
        Status::Stale => "stale",
    }
}

fn status_color(status: Status) -> Color {
    match status {
        Status::NeedsInput => palette::NEEDS_INPUT,
        Status::Working => palette::WORKING,
        Status::Idle => palette::IDLE,
        Status::Error => palette::ERROR,
        Status::Unknown | Status::Stale => palette::DIM,
    }
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

pub fn truncate_to_width(value: &str, max_width: usize) -> String {
    let mut result = String::new();
    let mut width = 0;
    for character in value.chars() {
        let character_width = character.width().unwrap_or(0);
        if width + character_width > max_width {
            break;
        }
        result.push(character);
        width += character_width;
    }
    result
}
