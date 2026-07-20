use ratatui::Frame;
use ratatui::layout::{Alignment, Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use crate::app::{AppState, Focus, Mode};
use crate::model::{Row, Status};

pub use crate::app::format_age;

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
    let alerts = alert_lines(app, frame.area().width);
    let alert_height = alerts
        .len()
        .min(frame.area().height.saturating_sub(1) as usize) as u16;
    let [list_area, alert_area, status_area] = Layout::vertical([
        Constraint::Min(0),
        Constraint::Length(alert_height),
        Constraint::Length(1),
    ])
    .areas(frame.area());
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
        let focused_index = rows.iter().position(|row| row_is_focused(row, app.focus()));
        let offset = scroll_offset(focused_index, rows.len(), list_area.height as usize);
        let lines = rows
            .iter()
            .enumerate()
            .skip(offset)
            .take(list_area.height as usize)
            .map(|(index, row)| {
                row_line(
                    row,
                    app,
                    index == focused_index.unwrap_or(usize::MAX),
                    now,
                    list_area.width,
                )
            })
            .collect::<Vec<_>>();
        frame.render_widget(Paragraph::new(lines), list_area);
    }
    if !alerts.is_empty() {
        frame.render_widget(Paragraph::new(alerts), alert_area);
    }
    frame.render_widget(status_bar(app), status_area);
}

fn alert_lines(app: &AppState, width: u16) -> Vec<Line<'static>> {
    let mut alerts = Vec::new();
    if let Some(banner) = &app.banner {
        push_alert(
            &mut alerts,
            banner,
            Style::default().fg(palette::DEGRADE),
            width,
        );
    }
    if app.consecutive_failures > 0 {
        push_alert(
            &mut alerts,
            &format!("⚠ polling failures: {}", app.consecutive_failures),
            Style::default().fg(palette::DEGRADE),
            width,
        );
    }
    if app.dropped_records > 0 {
        push_alert(
            &mut alerts,
            &format!("dropped: {}", app.dropped_records),
            Style::default().fg(palette::DIM),
            width,
        );
    }
    alerts
}

fn push_alert(alerts: &mut Vec<Line<'static>>, message: &str, style: Style, width: u16) {
    alerts.extend(
        wrap_alert(message, usize::from(width))
            .into_iter()
            .map(|line| Line::styled(line, style)),
    );
}

fn wrap_alert(message: &str, width: usize) -> Vec<String> {
    if width == 0 {
        return Vec::new();
    }

    let mut lines = Vec::new();
    let mut line = String::new();
    for word in message.split_whitespace() {
        if word.width() > width {
            if !line.is_empty() {
                lines.push(std::mem::take(&mut line));
            }
            wrap_long_word(word, width, &mut lines);
        } else if line.is_empty() {
            line.push_str(word);
        } else if line.width() + 1 + word.width() <= width {
            line.push(' ');
            line.push_str(word);
        } else {
            lines.push(std::mem::take(&mut line));
            line.push_str(word);
        }
    }
    if !line.is_empty() || lines.is_empty() {
        lines.push(line);
    }
    lines
}

fn wrap_long_word(word: &str, width: usize, lines: &mut Vec<String>) {
    let mut line = String::new();
    for character in word.chars() {
        let character_width = character.width().unwrap_or(0);
        if !line.is_empty() && line.width() + character_width > width {
            lines.push(std::mem::take(&mut line));
        }
        line.push(character);
    }
    if !line.is_empty() {
        lines.push(line);
    }
}

fn row_is_focused(row: &Row, focus: Option<&Focus>) -> bool {
    match (row, focus) {
        (Row::SessionHeader { session_id, .. }, Some(Focus::Header(focused))) => {
            session_id == focused
        }
        (
            Row::Pane {
                session_id,
                window_id,
                pane_id,
                ..
            },
            Some(Focus::Pane((focused_session, focused_window, focused_pane))),
        ) => {
            session_id == focused_session && window_id == focused_window && pane_id == focused_pane
        }
        _ => false,
    }
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
            path,
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
            let status_field = format!("{:<11}", status_text(*status));
            let suffix = if session.is_empty() {
                format!(
                    " {:>3} {:>4}.{: <2} ",
                    format_age(*status_since, now),
                    window_index,
                    pane_index
                )
            } else {
                format!(
                    " {:>3} {:>4}.{: <2} {:<10} ",
                    format_age(*status_since, now),
                    window_index,
                    pane_index,
                    session
                )
            };
            let context = pad_to_width(&truncate_to_width(&path_basename(path), 12), 12);
            let label = truncate_to_width(
                label,
                usize::from(width).saturating_sub(
                    indent.width()
                        + status_glyph(*status).width()
                        + status_field.width()
                        + suffix.width()
                        + context.width()
                        + model.width()
                        + 3,
                ),
            );
            vec![
                Span::raw(indent),
                Span::styled(
                    status_glyph(*status),
                    Style::default().fg(status_color(*status)),
                ),
                Span::raw(" "),
                Span::styled(status_field, Style::default().fg(status_color(*status))),
                Span::raw(suffix),
                Span::styled(context, Style::default().fg(palette::DIM)),
                Span::raw(" "),
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
    let spans = vec![Span::styled(
        pieces.join("  "),
        Style::default().fg(palette::STATUS_BAR),
    )];
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

fn path_basename(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or(path)
        .to_owned()
}

fn pad_to_width(value: &str, width: usize) -> String {
    format!("{value}{}", " ".repeat(width.saturating_sub(value.width())))
}
