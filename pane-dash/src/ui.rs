use ratatui::Frame;
use ratatui::layout::{Alignment, Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use crate::app::{
    AppState, CreateField, CreateModal, Modal, Mode, PendingCreationState, status_index,
};
use crate::creation::{CreateContext, display_error};
use crate::model::{Row, Status};

pub use crate::app::format_age;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DashboardAreas {
    pub list: Rect,
    pub preview: Rect,
    pub horizontal: bool,
}

struct FullLayout {
    alerts: Vec<Line<'static>>,
    alerts_area: Rect,
    status_area: Rect,
    dashboard: DashboardAreas,
}

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

pub fn dashboard_areas(content: Rect) -> DashboardAreas {
    let horizontal = content.width >= 100;
    let [list, preview] = if horizontal {
        Layout::horizontal([Constraint::Percentage(45), Constraint::Percentage(55)]).areas(content)
    } else {
        Layout::vertical([Constraint::Percentage(45), Constraint::Percentage(55)]).areas(content)
    };
    DashboardAreas {
        list,
        preview,
        horizontal,
    }
}

pub fn preview_inner_height(app: &AppState, full_area: Rect) -> u16 {
    let layout = full_layout(app, full_area);
    preview_block(layout.dashboard.horizontal)
        .inner(layout.dashboard.preview)
        .height
}

fn full_layout(app: &AppState, full_area: Rect) -> FullLayout {
    let alerts = alert_lines(app, full_area.width);
    let alert_height = alerts
        .len()
        .min(full_area.height.saturating_sub(1) as usize) as u16;
    let [content, alerts_area, status_area] = Layout::vertical([
        Constraint::Min(0),
        Constraint::Length(alert_height),
        Constraint::Length(1),
    ])
    .areas(full_area);
    FullLayout {
        alerts,
        alerts_area,
        status_area,
        dashboard: dashboard_areas(content),
    }
}

fn preview_block(horizontal: bool) -> Block<'static> {
    Block::default().borders(if horizontal {
        Borders::LEFT
    } else {
        Borders::TOP
    })
}

pub fn render(frame: &mut Frame, app: &AppState, now: u64) {
    let layout = full_layout(app, frame.area());
    let list_area = layout.dashboard.list;
    let pending_height = u16::from(app.pending_creation.is_some() && list_area.height > 0);
    if let Some(pending) = &app.pending_creation {
        let pending_area = Rect::new(list_area.x, list_area.y, list_area.width, pending_height);
        frame.render_widget(
            Paragraph::new(pending_line(pending, now, list_area.width)),
            pending_area,
        );
    }
    let list_area = Rect::new(
        list_area.x,
        list_area.y.saturating_add(pending_height),
        list_area.width,
        list_area.height.saturating_sub(pending_height),
    );
    let grouped = matches!(app.mode, Mode::Grouped);
    let rows = app.model.rows(grouped);
    let cache = app.render_cache();
    if cache.visible_rows.is_empty() && list_area.height > 0 {
        let hint_area = Rect::new(
            list_area.x,
            list_area.y.saturating_add(list_area.height / 2),
            list_area.width,
            1,
        );
        frame.render_widget(
            Paragraph::new(if app.model.memberships().is_empty() {
                "no opencode panes found"
            } else {
                "no panes match filter"
            })
            .alignment(Alignment::Center)
            .style(Style::default().fg(palette::DIM)),
            hint_area,
        );
    } else {
        let focused_index = app
            .focus()
            .and_then(|focus| cache.focus_indices.get(focus).copied());
        let offset = scroll_offset(
            focused_index,
            cache.visible_rows.len(),
            list_area.height as usize,
        );
        let lines = cache
            .visible_rows
            .iter()
            .enumerate()
            .skip(offset)
            .take(list_area.height as usize)
            .map(|(index, row_index)| {
                row_line(
                    &rows[*row_index],
                    app,
                    index == focused_index.unwrap_or(usize::MAX),
                    now,
                    list_area.width,
                )
            })
            .collect::<Vec<_>>();
        frame.render_widget(Paragraph::new(lines), list_area);
    }
    render_preview(frame, app, layout.dashboard);
    if !layout.alerts.is_empty() {
        frame.render_widget(Paragraph::new(layout.alerts), layout.alerts_area);
    }
    frame.render_widget(
        status_bar(app, cache.status_counts, layout.status_area.width),
        layout.status_area,
    );
    render_modal(frame, app);
}

fn render_modal(frame: &mut Frame, app: &AppState) {
    let Some(modal) = &app.modal else {
        return;
    };
    let area = frame.area();
    if area.width == 0 || area.height == 0 {
        return;
    }
    match modal {
        Modal::Send {
            pane_id,
            command,
            text,
        } => {
            let modal_area = centered_modal_rect(area, 70, 5);
            frame.render_widget(Clear, modal_area);
            let width = modal_area.width;
            let title = truncate_to_width(
                &format!("Send to {} (running: {})", pane_id.0, command),
                usize::from(width.saturating_sub(4)),
            );
            let block = Block::default().borders(Borders::ALL).title(title);
            let inner = block.inner(modal_area);
            frame.render_widget(block, modal_area);
            if inner.width == 0 || inner.height == 0 {
                return;
            }
            let input = truncate_to_width(&literal_input(text), usize::from(inner.width));
            let mut lines = vec![Line::raw(input)];
            if inner.height > 1 {
                lines.push(Line::raw(truncate_to_width(
                    "Enter send | Esc cancel",
                    usize::from(inner.width),
                )));
            }
            frame.render_widget(Paragraph::new(lines), inner);
        }
        Modal::Kill { pane_id } => {
            let modal_area = centered_modal_rect(area, 70, 5);
            frame.render_widget(Clear, modal_area);
            let width = modal_area.width;
            let title = truncate_to_width(
                &format!("Kill pane {}? [y/N]", pane_id.0),
                usize::from(width.saturating_sub(4)),
            );
            frame.render_widget(
                Block::default().borders(Borders::ALL).title(title),
                modal_area,
            );
        }
        Modal::Create(CreateModal::Choice { choices, selected }) => {
            let modal_area = centered_modal_rect(area, 70, choices.len().saturating_add(4) as u16);
            frame.render_widget(Clear, modal_area);
            render_create_choice(frame, modal_area, choices, *selected);
        }
        Modal::Create(CreateModal::Form(form)) => {
            let modal_area = centered_modal_rect(area, 70, 10);
            frame.render_widget(Clear, modal_area);
            render_create_form(frame, modal_area, form);
        }
    }
}

fn centered_modal_rect(area: Rect, desired_width: u16, desired_height: u16) -> Rect {
    let width = area.width.min(desired_width);
    let height = area.height.min(desired_height);
    Rect::new(
        area.x.saturating_add(area.width.saturating_sub(width) / 2),
        area.y
            .saturating_add(area.height.saturating_sub(height) / 2),
        width,
        height,
    )
}

fn render_create_choice(
    frame: &mut Frame,
    area: Rect,
    choices: &[crate::app::CreateChoice],
    selected: usize,
) {
    let block = Block::default().borders(Borders::ALL).title("Create");
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if inner.width == 0 || inner.height == 0 {
        return;
    }
    let mut lines = choices
        .iter()
        .enumerate()
        .take(inner.height.saturating_sub(1) as usize)
        .map(|(index, choice)| {
            Line::from(Span::styled(
                truncate_to_width(choice.label, usize::from(inner.width)),
                if index == selected {
                    Style::default()
                        .fg(palette::ACCENT)
                        .add_modifier(Modifier::REVERSED)
                } else {
                    Style::default().fg(palette::TEXT)
                },
            ))
        })
        .collect::<Vec<_>>();
    if lines.len() < inner.height as usize {
        lines.push(Line::styled(
            truncate_to_width(
                "↑↓ select | Enter choose | Esc cancel",
                usize::from(inner.width),
            ),
            Style::default().fg(palette::DIM),
        ));
    }
    frame.render_widget(Paragraph::new(lines), inner);
}

fn render_create_form(frame: &mut Frame, area: Rect, form: &crate::app::CreateForm) {
    let title = match form.kind {
        CreateContext::Split { .. } => "Create split",
        CreateContext::NewWindow { .. } => "Create window",
        CreateContext::NewSession => "Create session",
    };
    let block = Block::default().borders(Borders::ALL).title(title);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if inner.width == 0 || inner.height == 0 {
        return;
    }
    let mut fields = Vec::new();
    if !matches!(form.kind, CreateContext::Split { .. }) {
        fields.push((CreateField::Name, "name", &form.draft.name));
    }
    fields.extend([
        (CreateField::Cwd, "cwd", &form.draft.cwd),
        (CreateField::Command, "command", &form.draft.command),
    ]);
    let mut lines = fields
        .into_iter()
        .map(|(field, label, value)| {
            let text = truncate_to_width(
                &format!("{label}: {}", literal_input(value)),
                usize::from(inner.width),
            );
            let active = field == form.field && !form.submitting;
            Line::styled(
                text,
                if active {
                    Style::default()
                        .fg(palette::ACCENT)
                        .add_modifier(Modifier::REVERSED)
                } else {
                    Style::default().fg(if form.submitting {
                        palette::DIM
                    } else {
                        palette::TEXT
                    })
                },
            )
        })
        .collect::<Vec<_>>();
    if form.linked_session_count > 1 {
        lines.push(Line::styled(
            truncate_to_width(
                &format!(
                    "linked window: split appears in {} sessions",
                    form.linked_session_count
                ),
                usize::from(inner.width),
            ),
            Style::default().fg(palette::DIM),
        ));
    }
    if let Some(error) = &form.error {
        lines.push(Line::styled(
            truncate_to_width(
                &format!("ERROR: {}", literal_input(&display_error(error))),
                usize::from(inner.width),
            ),
            Style::default().fg(palette::ERROR),
        ));
    }
    lines.push(Line::styled(
        truncate_to_width(
            if form.submitting {
                "submitting... (locked)"
            } else {
                "Tab/↑↓ field | Enter submit | Esc cancel"
            },
            usize::from(inner.width),
        ),
        Style::default().fg(palette::DIM),
    ));
    let scroll = lines.len().saturating_sub(inner.height as usize) as u16;
    frame.render_widget(Paragraph::new(lines).scroll((0, scroll)), inner);
}

fn pending_line(pending: &crate::app::PendingCreation, now: u64, width: u16) -> Line<'static> {
    let spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let (text, style) = match &pending.state {
        PendingCreationState::Creating => (
            format!("{} creating...", spinner[now as usize % spinner.len()]),
            Style::default().fg(palette::WORKING),
        ),
        PendingCreationState::Created { .. } | PendingCreationState::Tagging { .. } => (
            format!("{} tagging...", spinner[now as usize % spinner.len()]),
            Style::default().fg(palette::WORKING),
        ),
        PendingCreationState::Sending { .. } => (
            format!(
                "{} sending command...",
                spinner[now as usize % spinner.len()]
            ),
            Style::default().fg(palette::WORKING),
        ),
        PendingCreationState::Entering { .. } => (
            format!("{} sending Enter...", spinner[now as usize % spinner.len()]),
            Style::default().fg(palette::WORKING),
        ),
        PendingCreationState::AwaitingSnapshot { .. } => (
            format!(
                "{} waiting for snapshot...",
                spinner[now as usize % spinner.len()]
            ),
            Style::default().fg(palette::WORKING),
        ),
        PendingCreationState::Error(error) => (
            format!("ERROR: {}", literal_input(&display_error(error))),
            Style::default().fg(palette::ERROR),
        ),
    };
    Line::styled(truncate_to_width(&text, usize::from(width)), style)
}

fn literal_input(text: &str) -> String {
    const MAX_SCALARS: usize = 512;

    text.chars()
        .take(MAX_SCALARS)
        .map(|character| match character {
            '\0'..='\u{1f}' => char::from_u32(0x2400 + character as u32).unwrap(),
            '\u{7f}' => '␡',
            _ => character,
        })
        .collect()
}

fn render_preview(frame: &mut Frame, app: &AppState, areas: DashboardAreas) {
    let block = preview_block(areas.horizontal);
    let inner = block.inner(areas.preview);
    frame.render_widget(block, areas.preview);
    if inner.width == 0 || inner.height == 0 {
        return;
    }

    let paragraph = match (&app.preview.target, &app.preview.frame, &app.preview.error) {
        (None, _, _) => {
            Paragraph::new("select a pane to preview").style(Style::default().fg(palette::DIM))
        }
        (Some(_), _, Some(error)) => Paragraph::new(format!("preview unavailable: {error}"))
            .style(Style::default().fg(palette::DIM)),
        (Some(_), Some(preview), None) => {
            let start = preview_scroll(app, preview.lines.len(), inner.height);
            Paragraph::new(preview.lines.clone()).scroll((start, 0))
        }
        (Some(_), None, None) => {
            Paragraph::new("capturing pane…").style(Style::default().fg(palette::DIM))
        }
    };
    frame.render_widget(paragraph, inner);
}

fn preview_scroll(app: &AppState, line_count: usize, inner_height: u16) -> u16 {
    let follow_start = line_count.saturating_sub(usize::from(inner_height));
    let start = if app.preview.inspect {
        follow_start.saturating_sub(app.preview.lines_from_bottom)
    } else {
        follow_start
    };
    u16::try_from(start).unwrap_or(u16::MAX)
}

fn alert_lines(app: &AppState, width: u16) -> Vec<Line<'static>> {
    let mut alerts = Vec::new();
    if app.transport_degraded {
        push_alert(
            &mut alerts,
            "live updates lost — polling",
            Style::default().fg(palette::DEGRADE),
            width,
        );
    }
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
            let marker = if app.session_is_collapsed(session_id) {
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
            let mut spans = vec![
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
            ];
            let label = truncate_to_width(
                label,
                usize::from(width)
                    .saturating_sub(spans.iter().map(|span| span.content.width()).sum::<usize>()),
            );
            spans.push(Span::styled(label, Style::default().fg(palette::TEXT)));
            spans
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

fn status_bar(app: &AppState, counts: [usize; 6], width: u16) -> Paragraph<'static> {
    let statuses = [
        Status::NeedsInput,
        Status::Working,
        Status::Idle,
        Status::Error,
        Status::Unknown,
        Status::Stale,
    ];
    let verbose_counts = statuses
        .into_iter()
        .filter_map(|status| {
            let count = counts[status_index(status)];
            (count > 0).then(|| format!("{} {count}", status_text(status)))
        })
        .chain(std::iter::once(format!(
            "{} panes",
            counts.iter().sum::<usize>()
        )))
        .collect::<Vec<_>>()
        .join("  ");
    let compact_counts = statuses
        .into_iter()
        .filter_map(|status| {
            let count = counts[status_index(status)];
            (count > 0).then(|| format!("{}{}", compact_status_token(status), count))
        })
        .chain(std::iter::once(format!(
            "P{}",
            counts.iter().sum::<usize>()
        )))
        .collect::<String>();
    let mode = match app.mode {
        Mode::Grouped => "grouped",
        Mode::Flat => "flat",
    };
    let query_is_visible =
        app.input_mode == crate::app::InputMode::Filter || !app.filter_query.is_empty();
    let (full_suffix, compact_suffix, narrow_suffix) = status_suffixes(app, mode, query_is_visible);
    let options = [
        (&verbose_counts, "  ", &full_suffix),
        (&compact_counts, "  ", &full_suffix),
        (&compact_counts, " ", &compact_suffix),
        (&compact_counts, " ", &narrow_suffix),
    ];
    let fallback = (&compact_counts, " ", &narrow_suffix);
    let fits = |(counts, separator, suffix): &&(&String, &str, &String), query_width| {
        counts.width() + separator.width() + suffix.width() + query_width <= usize::from(width)
    };
    let (counts, separator, suffix) = if query_is_visible && !app.filter_query.is_empty() {
        options
            .iter()
            .find(|option| fits(option, app.filter_query.width()))
            .copied()
            .unwrap_or(fallback)
    } else {
        options
            .iter()
            .find(|option| fits(option, 0))
            .copied()
            .unwrap_or(fallback)
    };
    let available_query_width =
        usize::from(width).saturating_sub(counts.width() + separator.width() + suffix.width());
    let query = if query_is_visible {
        truncate_to_width(&app.filter_query, available_query_width)
    } else {
        String::new()
    };
    let spans = vec![Span::styled(
        format!("{counts}{separator}{suffix}{query}"),
        Style::default().fg(palette::STATUS_BAR),
    )];
    Paragraph::new(Line::from(spans))
}

fn status_suffixes(app: &AppState, mode: &str, query_is_visible: bool) -> (String, String, String) {
    let (mut parts, prompt) = match app.input_mode {
        crate::app::InputMode::Filter => (vec![mode], Some("FILTER:")),
        crate::app::InputMode::Navigation if query_is_visible => {
            (vec![mode, "NAV"], Some("filter:"))
        }
        crate::app::InputMode::Navigation => (vec![mode, "NAV"], None),
    };
    if app.preview.inspect {
        parts.push("INSPECT");
    }
    if let Some(prompt) = prompt {
        parts.push(prompt);
    }
    let full = parts.join(" | ");
    let compact = parts.join(" ");
    let narrow = parts
        .iter()
        .map(|part| if *part == "NAV" { "N" } else { part })
        .collect::<Vec<_>>()
        .join(" ");
    if prompt.is_some() {
        (
            format!("{full} "),
            format!("{compact} "),
            format!("{narrow} "),
        )
    } else {
        (full, compact, narrow)
    }
}

fn compact_status_token(status: Status) -> char {
    match status {
        Status::NeedsInput => 'N',
        Status::Working => 'W',
        Status::Idle => 'I',
        Status::Error => 'E',
        Status::Unknown => 'U',
        Status::Stale => 'S',
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
