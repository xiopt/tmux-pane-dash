use ratatui::Frame;
use ratatui::layout::{Alignment, Constraint, Layout, Rect};
use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use crate::app::{
    AppState, CreateField, CreateModal, Modal, Mode, PendingCreationState, status_index,
};
use crate::creation::{CreateContext, display_error};
use crate::model::{Row, Status};
use crate::palette::{Palette, selection_style};

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

#[derive(Clone, Copy)]
enum HelpEntry {
    Heading(&'static str),
    Key(&'static str),
    Text(&'static str),
    Status(Status, &'static str),
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
    preview_block(app.palette(), layout.dashboard.horizontal)
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

fn preview_block(palette: &Palette, horizontal: bool) -> Block<'static> {
    Block::default()
        .borders(if horizontal {
            Borders::LEFT
        } else {
            Borders::TOP
        })
        .border_style(Style::default().fg(palette.border))
}

pub fn render(frame: &mut Frame, app: &AppState, now: u64) {
    let layout = full_layout(app, frame.area());
    let list_area = layout.dashboard.list;
    let pending_height = u16::from(app.pending_creation.is_some() && list_area.height > 0);
    if let Some(pending) = &app.pending_creation {
        let pending_area = Rect::new(list_area.x, list_area.y, list_area.width, pending_height);
        frame.render_widget(
            Paragraph::new(pending_line(pending, now, list_area.width, app.palette())),
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
            .style(Style::default().fg(app.palette().dim)),
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
        Modal::Help(_) => render_help(frame, centered_modal_rect(area, 96, 30), app.palette()),
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
            let block = Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(app.palette().border))
                .title(Span::styled(
                    title,
                    Style::default().fg(app.palette().accent),
                ));
            let inner = block.inner(modal_area);
            frame.render_widget(block, modal_area);
            if inner.width == 0 || inner.height == 0 {
                return;
            }
            let input = truncate_to_width(&literal_input(text), usize::from(inner.width));
            let mut lines = vec![Line::styled(input, Style::default().fg(app.palette().text))];
            if inner.height > 1 {
                lines.push(Line::styled(
                    truncate_to_width("Enter send | Esc cancel", usize::from(inner.width)),
                    Style::default().fg(app.palette().dim),
                ));
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
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(app.palette().border))
                    .title(Span::styled(
                        title,
                        Style::default().fg(app.palette().accent),
                    )),
                modal_area,
            );
        }
        Modal::Create(CreateModal::Choice { choices, selected }) => {
            let modal_area = centered_modal_rect(area, 70, choices.len().saturating_add(4) as u16);
            frame.render_widget(Clear, modal_area);
            render_create_choice(frame, modal_area, choices, *selected, app.palette());
        }
        Modal::Create(CreateModal::Form(form)) => {
            let modal_area = centered_modal_rect(area, 70, 10);
            frame.render_widget(Clear, modal_area);
            render_create_form(frame, modal_area, form, app.palette());
        }
    }
}

fn render_help(frame: &mut Frame, area: Rect, palette: &Palette) {
    frame.render_widget(Clear, area);
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(palette.border))
        .title(Span::styled("Help", Style::default().fg(palette.accent)));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if inner.width == 0 || inner.height == 0 {
        return;
    }

    let [content, footer] =
        Layout::vertical([Constraint::Min(0), Constraint::Length(1)]).areas(inner);
    let keys = help_keys();
    let details = help_details();
    if content.width >= 72 {
        let [left, right] =
            Layout::horizontal([Constraint::Percentage(50), Constraint::Percentage(50)])
                .areas(content);
        render_help_entries(frame, left, &keys, palette);
        render_help_entries(frame, right, &details, palette);
    } else {
        let mut entries = keys;
        entries.extend(details);
        render_help_entries(frame, content, &entries, palette);
    }
    frame.render_widget(
        Paragraph::new(Line::styled(
            truncate_to_width("?, Esc, q close help", usize::from(footer.width)),
            Style::default().fg(palette.dim),
        )),
        footer,
    );
}

fn help_keys() -> Vec<HelpEntry> {
    vec![
        HelpEntry::Heading("Keys — navigation and modes"),
        HelpEntry::Key("j/k or ↑/↓: move; g/G: first/last."),
        HelpEntry::Key("h/l or za: collapse/expand session in grouped mode."),
        HelpEntry::Key(
            "/: filter; text edits query; Backspace deletes; Esc returns to navigation and retains query.",
        ),
        HelpEntry::Key("Enter: jump; Ctrl-z: zoom then jump."),
        HelpEntry::Key("Ctrl-s: send line; x: kill; n: create."),
        HelpEntry::Key("Ctrl-u/Ctrl-d: inspect preview half-page up/down; Ctrl-r: follow bottom."),
        HelpEntry::Key("s: grouped/flat; ?: help; navigation q/Esc: close popup."),
        HelpEntry::Key("Send: text/Backspace, Enter send, Esc cancel."),
        HelpEntry::Key("Kill: y/Y confirm; any other key cancels, except inert ?."),
        HelpEntry::Key("Create choice: j/k or ↑/↓, Enter, Esc."),
        HelpEntry::Key("Create form: text/Backspace, Tab/↓ and Shift-Tab/↑, Enter, Esc."),
        HelpEntry::Key(
            "Locked create submission: q/Esc closes the popup; all other keys are inert.",
        ),
    ]
}

fn help_details() -> Vec<HelpEntry> {
    vec![
        HelpEntry::Heading("Six statuses and glyphs"),
        HelpEntry::Status(
            Status::NeedsInput,
            "waiting for a permission or question response.",
        ),
        HelpEntry::Status(Status::Working, "busy or retrying."),
        HelpEntry::Status(Status::Idle, "known idle."),
        HelpEntry::Status(
            Status::Error,
            "agent error latched until work/user activity clears it.",
        ),
        HelpEntry::Status(Status::Unknown, "no companion-plugin status is available."),
        HelpEntry::Status(
            Status::Stale,
            "plugin heartbeat exceeded the configured stale threshold.",
        ),
        HelpEntry::Heading("Concepts and alerts"),
        HelpEntry::Text(
            "Grouped mode shows session headers and supports local collapse; flat mode status-sorts pane rows.",
        ),
        HelpEntry::Text(
            "Filter is live and retained; matching grouped results temporarily expose collapsed sessions.",
        ),
        HelpEntry::Text(
            "Inspect pauses only selected-pane preview capture; topology/status snapshots continue.",
        ),
        HelpEntry::Text(
            "live updates lost — polling means control transport degraded to bounded fallback polling; other alert rows report runtime action/snapshot failures, config warnings, or dropped malformed records.",
        ),
        HelpEntry::Heading("Configuration"),
        HelpEntry::Text(
            "Path: nonempty $XDG_CONFIG_HOME/tmux-pane-dash/config.toml, otherwise nonempty $HOME/.config/tmux-pane-dash/config.toml.",
        ),
        HelpEntry::Text("Precedence: @pane-dash-theme built-in -> TOML theme -> per-slot colors."),
        HelpEntry::Text("Built-ins: dark, light, terminal-native."),
        HelpEntry::Text("Colors: canonical ANSI names, #RRGGBB, or ansi:0..255."),
        HelpEntry::Text(
            "Slots, in order: text, dim, accent, needs_input, working, idle, error, unknown, stale, warning, degrade, border, status_bar, selection_fg, selection_bg.",
        ),
        HelpEntry::Text("Config is read once per popup; reopen to reload."),
    ]
}

fn render_help_entries(frame: &mut Frame, area: Rect, entries: &[HelpEntry], palette: &Palette) {
    if area.width == 0 || area.height == 0 {
        return;
    }
    let mut lines = Vec::new();
    for entry in entries {
        if lines.len() >= usize::from(area.height) {
            break;
        }
        let remaining = usize::from(area.height).saturating_sub(lines.len());
        lines.extend(help_entry_lines(
            *entry,
            usize::from(area.width),
            palette,
            remaining,
        ));
    }
    frame.render_widget(Paragraph::new(lines), area);
}

fn help_entry_lines(
    entry: HelpEntry,
    width: usize,
    palette: &Palette,
    limit: usize,
) -> Vec<Line<'static>> {
    let (text, style) = match entry {
        HelpEntry::Heading(text) => (text, Style::default().fg(palette.accent)),
        HelpEntry::Key(text) => (text, Style::default().fg(palette.text)),
        HelpEntry::Text(text) => (text, Style::default().fg(palette.dim)),
        HelpEntry::Status(status, description) => {
            let prefix = format!("{} {}: ", status_glyph(status), status_text(status));
            let mut descriptions =
                wrap_help_segments(description, width.saturating_sub(prefix.width()), limit);
            let first_description = descriptions.first().map_or("", String::as_str);
            let mut rendered = vec![Line::from(vec![
                Span::styled(
                    truncate_to_width(status_glyph(status), width),
                    Style::default().fg(status_color(status, palette)),
                ),
                Span::styled(
                    truncate_to_width(
                        &format!(" {}: {first_description}", status_text(status)),
                        width.saturating_sub(status_glyph(status).width()),
                    ),
                    Style::default().fg(palette.dim),
                ),
            ])];
            for description in descriptions.drain(1..) {
                if rendered.len() == limit {
                    break;
                }
                rendered.push(Line::styled(description, Style::default().fg(palette.dim)));
            }
            return rendered;
        }
    };
    wrap_help_text(text, width, style, limit)
}

fn wrap_help_text(text: &str, width: usize, style: Style, limit: usize) -> Vec<Line<'static>> {
    wrap_help_segments(text, width, limit)
        .into_iter()
        .map(|line| Line::styled(line, style))
        .collect()
}

fn wrap_help_segments(text: &str, width: usize, limit: usize) -> Vec<String> {
    if width == 0 || limit == 0 {
        return Vec::new();
    }
    let mut lines = Vec::new();
    let mut current = String::new();
    for word in text.split_whitespace() {
        let separator = usize::from(!current.is_empty());
        if current.width() + separator + word.width() > width && !current.is_empty() {
            lines.push(current);
            if lines.len() == limit {
                return lines;
            }
            current = String::new();
        }
        if !current.is_empty() {
            current.push(' ');
        }
        if word.width() > width {
            current.push_str(&truncate_to_width(word, width));
        } else {
            current.push_str(word);
        }
    }
    if !current.is_empty() && lines.len() < limit {
        lines.push(current);
    }
    lines
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
    palette: &Palette,
) {
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(palette.border))
        .title(Span::styled("Create", Style::default().fg(palette.accent)));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if inner.width == 0 || inner.height == 0 {
        return;
    }
    let choice_slots = if inner.height > 1 {
        inner.height.saturating_sub(1) as usize
    } else {
        1
    };
    let start = selected
        .saturating_sub(choice_slots.saturating_sub(1))
        .min(choices.len().saturating_sub(choice_slots));
    let mut lines = choices
        .iter()
        .enumerate()
        .skip(start)
        .take(choice_slots)
        .map(|(index, choice)| {
            let active = index == selected;
            let text = pad_to_width(
                &truncate_to_width(choice.label, usize::from(inner.width)),
                usize::from(inner.width),
            );
            Line::from(Span::styled(
                text,
                selected_style(
                    Style::default().fg(if active { palette.accent } else { palette.text }),
                    active,
                    palette,
                ),
            ))
        })
        .collect::<Vec<_>>();
    if lines.len() < inner.height as usize {
        lines.push(Line::styled(
            truncate_to_width(
                "↑↓ select | Enter choose | Esc cancel",
                usize::from(inner.width),
            ),
            Style::default().fg(palette.dim),
        ));
    }
    frame.render_widget(Paragraph::new(lines), inner);
}

fn render_create_form(
    frame: &mut Frame,
    area: Rect,
    form: &crate::app::CreateForm,
    palette: &Palette,
) {
    let title = match form.kind {
        CreateContext::Split { .. } => "Create split",
        CreateContext::NewWindow { .. } => "Create window",
        CreateContext::NewSession => "Create session",
    };
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(palette.border))
        .title(Span::styled(title, Style::default().fg(palette.accent)));
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
    let active_index = fields
        .iter()
        .position(|(field, _, _)| *field == form.field)
        .unwrap_or(0);
    let field_lines = fields
        .into_iter()
        .map(|(field, label, value)| {
            let prefix = format!("{label}: ");
            let value = literal_input(value);
            let text = if field == form.field && !form.submitting {
                format!(
                    "{prefix}{}",
                    truncate_tail_to_width(
                        &value,
                        usize::from(inner.width).saturating_sub(prefix.width()),
                    )
                )
            } else {
                truncate_to_width(&format!("{prefix}{value}"), usize::from(inner.width))
            };
            let active = field == form.field && !form.submitting;
            Line::styled(
                pad_to_width(&text, usize::from(inner.width)),
                selected_style(
                    Style::default().fg(if active {
                        palette.accent
                    } else if form.submitting {
                        palette.dim
                    } else {
                        palette.text
                    }),
                    active,
                    palette,
                ),
            )
        })
        .collect::<Vec<_>>();
    let linked_notice = (form.linked_session_count > 1).then(|| {
        Line::styled(
            truncate_to_width(
                &format!(
                    "linked window: split appears in {} sessions",
                    form.linked_session_count
                ),
                usize::from(inner.width),
            ),
            Style::default().fg(palette.dim),
        )
    });
    let validation_error = form.error.as_ref().map(|error| {
        Line::styled(
            truncate_to_width(
                &format!("ERROR: {}", literal_input(&display_error(error))),
                usize::from(inner.width),
            ),
            Style::default().fg(palette.error),
        )
    });
    let footer = Line::styled(
        truncate_to_width(
            if form.submitting {
                "submitting... (locked)"
            } else {
                "Tab/↑↓ field | Enter submit | Esc cancel"
            },
            usize::from(inner.width),
        ),
        Style::default().fg(palette.dim),
    );
    let mut lines = field_lines.clone();
    if let Some(linked_notice) = &linked_notice {
        lines.push(linked_notice.clone());
    }
    if let Some(validation_error) = &validation_error {
        lines.push(validation_error.clone());
    }
    lines.push(footer.clone());
    let visible = if lines.len() <= inner.height as usize {
        lines
    } else if form.submitting {
        let start = lines.len().saturating_sub(inner.height as usize);
        lines.into_iter().skip(start).collect()
    } else {
        let mut visible = vec![field_lines[active_index].clone()];
        for line in [
            validation_error.as_ref(),
            linked_notice.as_ref(),
            Some(&footer),
        ] {
            if visible.len() >= inner.height as usize {
                break;
            }
            if let Some(line) = line {
                visible.push(line.clone());
            }
        }
        for (index, line) in field_lines.iter().enumerate() {
            if visible.len() >= inner.height as usize {
                break;
            }
            if index != active_index {
                visible.push(line.clone());
            }
        }
        visible
    };
    frame.render_widget(Paragraph::new(visible), inner);
}

fn pending_line(
    pending: &crate::app::PendingCreation,
    now: u64,
    width: u16,
    palette: &Palette,
) -> Line<'static> {
    let spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let (text, style) = match &pending.state {
        PendingCreationState::Creating => (
            format!("{} creating...", spinner[now as usize % spinner.len()]),
            Style::default().fg(palette.working),
        ),
        PendingCreationState::Created { .. } | PendingCreationState::Tagging { .. } => (
            format!("{} tagging...", spinner[now as usize % spinner.len()]),
            Style::default().fg(palette.working),
        ),
        PendingCreationState::Sending { .. } => (
            format!(
                "{} sending command...",
                spinner[now as usize % spinner.len()]
            ),
            Style::default().fg(palette.working),
        ),
        PendingCreationState::Entering { .. } => (
            format!("{} sending Enter...", spinner[now as usize % spinner.len()]),
            Style::default().fg(palette.working),
        ),
        PendingCreationState::AwaitingSnapshot { .. } => (
            format!(
                "{} waiting for snapshot...",
                spinner[now as usize % spinner.len()]
            ),
            Style::default().fg(palette.working),
        ),
        PendingCreationState::Error(error) => (
            format!("ERROR: {}", literal_input(&display_error(error))),
            Style::default().fg(palette.error),
        ),
    };
    Line::styled(truncate_to_width(&text, usize::from(width)), style)
}

fn literal_input(text: &str) -> String {
    const MAX_SCALARS: usize = 512;

    let mut literal = String::new();
    for character in text.chars().take(MAX_SCALARS) {
        match character {
            '\0'..='\u{1f}' => literal.push(char::from_u32(0x2400 + character as u32).unwrap()),
            '\u{7f}' => literal.push('␡'),
            '\u{80}'..='\u{9f}' => literal.push_str(&format!("\\u{{{:x}}}", character as u32)),
            _ => literal.push(character),
        }
    }
    literal
}

fn render_preview(frame: &mut Frame, app: &AppState, areas: DashboardAreas) {
    let block = preview_block(app.palette(), areas.horizontal);
    let inner = block.inner(areas.preview);
    frame.render_widget(block, areas.preview);
    if inner.width == 0 || inner.height == 0 {
        return;
    }

    let paragraph = match (&app.preview.target, &app.preview.frame, &app.preview.error) {
        (None, _, _) => {
            Paragraph::new("select a pane to preview").style(Style::default().fg(app.palette().dim))
        }
        (Some(_), _, Some(error)) => Paragraph::new(format!("preview unavailable: {error}"))
            .style(Style::default().fg(app.palette().dim)),
        (Some(_), Some(preview), None) => {
            let start = preview_scroll(app, preview.lines.len(), inner.height);
            Paragraph::new(preview.lines.clone()).scroll((start, 0))
        }
        (Some(_), None, None) => {
            Paragraph::new("capturing pane…").style(Style::default().fg(app.palette().dim))
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
            Style::default().fg(app.palette().degrade),
            width,
        );
    }
    if let Some(banner) = &app.banner {
        push_alert(
            &mut alerts,
            banner,
            Style::default().fg(app.palette().degrade),
            width,
        );
    }
    if app.consecutive_failures > 0 {
        push_alert(
            &mut alerts,
            &format!("⚠ polling failures: {}", app.consecutive_failures),
            Style::default().fg(app.palette().degrade),
            width,
        );
    }
    for warning in app.config_warnings() {
        push_alert(
            &mut alerts,
            warning.text(),
            Style::default().fg(app.palette().warning),
            width,
        );
    }
    if app.dropped_records > 0 {
        push_alert(
            &mut alerts,
            &format!("dropped: {}", app.dropped_records),
            Style::default().fg(app.palette().dim),
            width,
        );
    }
    alerts.truncate(8);
    alerts
}

fn push_alert(alerts: &mut Vec<Line<'static>>, message: &str, style: Style, width: u16) {
    alerts.push(Line::styled(
        truncate_alert(message, usize::from(width)),
        style,
    ));
}

fn truncate_alert(message: &str, width: usize) -> String {
    if width == 0 {
        return String::new();
    }
    if message.width() <= width {
        return message.to_owned();
    }
    if width == 1 {
        return "…".into();
    }
    format!("{}…", truncate_to_width(message, width - 1))
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
                Style::default().fg(app.palette().accent),
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
                spans.push(Span::styled(
                    suffix,
                    Style::default().fg(app.palette().working),
                ));
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
                    Style::default().fg(status_color(*status, app.palette())),
                ),
                Span::raw(" "),
                Span::styled(
                    status_field,
                    Style::default().fg(status_color(*status, app.palette())),
                ),
                Span::raw(suffix),
                Span::styled(context, Style::default().fg(app.palette().dim)),
                Span::raw(" "),
                Span::styled(model.clone(), Style::default().fg(app.palette().dim)),
                Span::raw("  "),
            ];
            let label = truncate_to_width(
                label,
                usize::from(width)
                    .saturating_sub(spans.iter().map(|span| span.content.width()).sum::<usize>()),
            );
            spans.push(Span::styled(label, Style::default().fg(app.palette().text)));
            spans
        }
    };
    let used = spans.iter().map(|span| span.content.width()).sum::<usize>();
    spans.push(Span::raw(
        " ".repeat(usize::from(width).saturating_sub(used)),
    ));
    if selected {
        let selection = selection_style(*app.palette());
        for span in &mut spans {
            span.style = span.style.patch(selection);
        }
    }
    Line::from(spans)
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
        Style::default().fg(app.palette().status_bar),
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

fn status_color(status: Status, palette: &Palette) -> Color {
    match status {
        Status::NeedsInput => palette.needs_input,
        Status::Working => palette.working,
        Status::Idle => palette.idle,
        Status::Error => palette.error,
        Status::Unknown => palette.unknown,
        Status::Stale => palette.stale,
    }
}

fn selected_style(style: Style, selected: bool, palette: &Palette) -> Style {
    if selected {
        style.patch(selection_style(*palette))
    } else {
        style
    }
}

pub fn truncate_to_width(value: &str, max_width: usize) -> String {
    let mut result = String::new();
    let mut width = 0;
    for grapheme in value.graphemes(true) {
        let grapheme_width = grapheme.width();
        if width + grapheme_width > max_width {
            break;
        }
        result.push_str(grapheme);
        width += grapheme_width;
    }
    result
}

fn truncate_tail_to_width(value: &str, max_width: usize) -> String {
    let mut result = Vec::new();
    let mut width = 0;
    for grapheme in value.graphemes(true).rev() {
        let grapheme_width = grapheme.width();
        if width + grapheme_width > max_width {
            break;
        }
        result.push(grapheme);
        width += grapheme_width;
    }
    result.into_iter().rev().collect()
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

#[cfg(test)]
mod tests {
    use super::{alert_lines, full_layout, render};
    use crate::app::AppState;
    use crate::config::LoadedUiConfig;
    use crate::model::{Model, ModelConfig};
    use crate::options::DashConfig;
    use crate::palette::Palette;
    use crate::snapshot::RawRecord;
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;
    use ratatui::layout::Rect;
    use ratatui::style::Color;

    fn state(warnings: &[&str]) -> AppState {
        let record = RawRecord {
            session_id: "$dash".into(),
            session_name: "dash".into(),
            window_id: "@1".into(),
            window_index: 1,
            window_name: "project".into(),
            pane_id: "%1".into(),
            pane_index: 1,
            pane_active: true,
            pane_current_command: "opencode".into(),
            pane_current_path: "/tmp".into(),
            pane_dead: false,
            status: "idle".into(),
            status_since: Some(0),
            heartbeat: Some(1_000),
            title: "task".into(),
            model: "model".into(),
            tag: String::new(),
            group: "1".into(),
        };
        AppState::new(
            Model::build(&[record], &ModelConfig::default(), 1_000),
            DashConfig::default(),
            LoadedUiConfig::with_test_warnings(Palette::dark(), warnings),
        )
    }

    #[test]
    fn config_alerts_are_ordered_styled_truncated_and_height_clipped() {
        let warnings = [
            "config: invalid color for text; ignored",
            "config: invalid color for dim; ignored",
            "config: invalid color for accent; ignored",
            "config: ignored 2 additional warnings",
        ];
        let mut app = state(&warnings);
        app.transport_degraded = true;
        app.banner = Some("runtime banner".into());
        app.consecutive_failures = 2;
        app.dropped_records = 3;

        let alerts = alert_lines(&app, 160);
        assert_eq!(alerts.len(), 8);
        let text = alerts
            .iter()
            .map(|line| line.spans[0].content.as_ref())
            .collect::<Vec<_>>();
        assert_eq!(text[0], "live updates lost — polling");
        assert_eq!(text[1], "runtime banner");
        assert_eq!(text[2], "⚠ polling failures: 2");
        assert_eq!(&text[3..7], warnings);
        assert_eq!(text[7], "dropped: 3");
        for line in &alerts[..3] {
            assert_eq!(line.style.fg, Some(Color::Red));
        }
        for line in &alerts[3..7] {
            assert_eq!(line.style.fg, Some(Color::Yellow));
        }
        assert_eq!(alerts[7].style.fg, Some(Color::DarkGray));
        assert_eq!(
            alert_lines(&app, 18)[3].spans[0].content,
            "config: invalid c…"
        );
        assert_eq!(alert_lines(&app, 0).len(), 8);

        let layout = full_layout(&app, Rect::new(0, 0, 18, 6));
        assert_eq!(layout.alerts_area.height, 5);
        let backend = TestBackend::new(18, 6);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| render(frame, &app, 1_000)).unwrap();
        let buffer = terminal.backend().buffer();
        assert!(buffer[(0, 0)].symbol().starts_with("l"));
        assert!(buffer[(0, 4)].symbol().starts_with("c"));
        assert_eq!(buffer[(0, 5)].fg, Color::DarkGray);
        assert_eq!(buffer[(0, 0)].fg, Color::Red);
        assert_eq!(buffer[(0, 3)].fg, Color::Yellow);
    }
}
