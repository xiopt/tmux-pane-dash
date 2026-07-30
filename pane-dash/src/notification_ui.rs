use std::io;

use anyhow::{Context, Result};
use crossterm::event::{
    DisableFocusChange, EnableFocusChange, Event as CrosstermEvent, EventStream,
};
use crossterm::execute;
use crossterm::terminal::{
    EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode,
};
use futures_util::StreamExt;
use ratatui::backend::{Backend, CrosstermBackend};
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph};
use ratatui::{Frame, Terminal};

use crate::notification_service::{
    NotificationClient, NotificationItem, NotificationSelectOutcome,
};
use crate::notifications::{EventId, NotificationKind};
use crate::palette::Palette;
use crate::ui::truncate_to_width;

const FOOTER: &str = "j/k or ↑/↓  Enter select  q/Esc close";
const STALE_BANNER: &str = "Selection stale; list refreshed";
const FAILED_BANNER: &str = "Selection failed; list refreshed";
const REFRESH_FAILED_BANNER: &str = "Selection stale; refresh failed";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotificationListState {
    items: Vec<NotificationItem>,
    selected: usize,
    banner: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NotificationListAction {
    None,
    Quit,
    Select(EventId),
}

impl NotificationListState {
    pub fn new(items: Vec<NotificationItem>) -> Self {
        let mut state = Self {
            items: Vec::new(),
            selected: 0,
            banner: None,
        };
        state.accept_snapshot(items);
        state
    }

    pub fn accept_snapshot(&mut self, items: Vec<NotificationItem>) {
        self.items = items;
        self.selected = self.selected.min(self.items.len().saturating_sub(1));
    }

    pub fn accept_refresh(&mut self, items: Vec<NotificationItem>, banner: impl Into<String>) {
        self.accept_snapshot(items);
        self.banner = Some(banner.into());
    }

    pub fn items(&self) -> &[NotificationItem] {
        &self.items
    }

    pub fn selected_index(&self) -> usize {
        self.selected
    }

    pub fn banner(&self) -> Option<&str> {
        self.banner.as_deref()
    }

    pub fn handle_key(&mut self, key: crossterm::event::KeyEvent) -> NotificationListAction {
        match key.code {
            crossterm::event::KeyCode::Char('j') | crossterm::event::KeyCode::Down => {
                self.selected = self
                    .selected
                    .saturating_add(1)
                    .min(self.items.len().saturating_sub(1));
                NotificationListAction::None
            }
            crossterm::event::KeyCode::Char('k') | crossterm::event::KeyCode::Up => {
                self.selected = self.selected.saturating_sub(1);
                NotificationListAction::None
            }
            crossterm::event::KeyCode::Enter => self
                .items
                .get(self.selected)
                .map_or(NotificationListAction::None, |item| {
                    NotificationListAction::Select(item.event_id().clone())
                }),
            crossterm::event::KeyCode::Char('q') | crossterm::event::KeyCode::Esc => {
                NotificationListAction::Quit
            }
            _ => NotificationListAction::None,
        }
    }
}

struct TerminalGuard;

impl TerminalGuard {
    fn enter() -> Result<Self> {
        enable_raw_mode().context("enable raw mode")?;
        if let Err(error) = execute!(io::stdout(), EnterAlternateScreen) {
            let _ = disable_raw_mode();
            return Err(error).context("enter alternate screen");
        }
        if let Err(error) = execute!(io::stdout(), EnableFocusChange) {
            let _ = execute!(io::stdout(), LeaveAlternateScreen);
            let _ = disable_raw_mode();
            return Err(error).context("enable terminal focus events");
        }
        Ok(Self)
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = execute!(io::stdout(), DisableFocusChange);
        let _ = execute!(io::stdout(), LeaveAlternateScreen);
        let _ = disable_raw_mode();
    }
}

fn install_panic_cleanup() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = execute!(io::stdout(), DisableFocusChange);
        let _ = execute!(io::stdout(), LeaveAlternateScreen);
        let _ = disable_raw_mode();
        previous(info);
    }));
}

pub async fn run(client_tty: String) -> Result<()> {
    let client = NotificationClient::from_environment()?;
    let items = client.list().await.context("list notifications")?;
    let mut state = NotificationListState::new(items);

    let _terminal = TerminalGuard::enter()?;
    install_panic_cleanup();
    let mut terminal = Terminal::new(CrosstermBackend::new(io::stdout()))?;
    redraw(&mut terminal, &state)?;

    let mut input = EventStream::new();
    while let Some(event) = input.next().await {
        match event.context("read terminal event")? {
            CrosstermEvent::Key(key) => match state.handle_key(key) {
                NotificationListAction::Quit => break,
                NotificationListAction::Select(event_id) => {
                    let banner = match client.select(&event_id, &client_tty).await {
                        Ok(NotificationSelectOutcome::Routed) => break,
                        Ok(NotificationSelectOutcome::Stale) => STALE_BANNER,
                        Err(_) => FAILED_BANNER,
                    };
                    match client.list().await {
                        Ok(items) => state.accept_refresh(items, banner),
                        Err(_) => state.accept_refresh(state.items.clone(), REFRESH_FAILED_BANNER),
                    }
                    redraw(&mut terminal, &state)?;
                }
                NotificationListAction::None => redraw(&mut terminal, &state)?,
            },
            CrosstermEvent::Resize(_, _) => redraw(&mut terminal, &state)?,
            _ => {}
        }
    }
    Ok(())
}

fn redraw<B>(terminal: &mut Terminal<B>, state: &NotificationListState) -> Result<()>
where
    B: Backend,
    B::Error: std::error::Error + Send + Sync + 'static,
{
    terminal.draw(|frame| render(frame, state))?;
    Ok(())
}

pub fn render(frame: &mut Frame, state: &NotificationListState) {
    let palette = Palette::terminal_native();
    let area = frame.area();
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(palette.border))
        .title(" Notifications ");
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if inner.height == 0 {
        return;
    }

    let footer_area = Rect::new(
        inner.x,
        inner.y.saturating_add(inner.height.saturating_sub(1)),
        inner.width,
        1,
    );
    let mut body = Rect::new(
        inner.x,
        inner.y,
        inner.width,
        inner.height.saturating_sub(1),
    );
    frame.render_widget(
        Paragraph::new(truncate_to_width(FOOTER, footer_area.width as usize))
            .style(Style::default().fg(palette.dim)),
        footer_area,
    );

    if let Some(banner) = state.banner()
        && body.height > 0
    {
        let banner_area = Rect::new(body.x, body.y, body.width, 1);
        frame.render_widget(
            Paragraph::new(truncate_to_width(banner, body.width as usize))
                .style(Style::default().fg(palette.warning)),
            banner_area,
        );
        body.y = body.y.saturating_add(1);
        body.height = body.height.saturating_sub(1);
    }
    if body.height == 0 {
        return;
    }

    if state.items().is_empty() {
        let empty = Rect::new(
            body.x,
            body.y.saturating_add(body.height.saturating_sub(1) / 2),
            body.width,
            1,
        );
        frame.render_widget(
            Paragraph::new(truncate_to_width("No notifications", body.width as usize))
                .style(Style::default().fg(palette.dim)),
            empty,
        );
        return;
    }

    let height = body.height as usize;
    let selected = state.selected_index();
    let start = selected
        .saturating_sub(height / 2)
        .min(state.items().len().saturating_sub(height));
    let lines = state
        .items()
        .iter()
        .enumerate()
        .skip(start)
        .take(height)
        .map(|(index, item)| item_line(item, index == selected, body.width as usize, &palette))
        .collect::<Vec<_>>();
    frame.render_widget(Paragraph::new(lines), body);
}

fn item_line(
    item: &NotificationItem,
    selected: bool,
    width: usize,
    palette: &Palette,
) -> Line<'static> {
    let target = format!(
        "{}/{}/{}",
        item.target().session_id().0,
        item.target().window_id().0,
        item.target().pane_id().0
    );
    let text = format!("[{}] {}  {}", item.kind_label(), item.message(), target);
    let style = if selected {
        Style::default()
            .fg(palette.accent)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(kind_color(item.kind(), palette))
    };
    Line::from(Span::styled(truncate_to_width(&text, width), style))
}

fn kind_color(kind: NotificationKind, palette: &Palette) -> ratatui::style::Color {
    match kind {
        NotificationKind::Error => palette.error,
        NotificationKind::Permission => palette.warning,
        NotificationKind::Question => palette.needs_input,
        NotificationKind::Finished => palette.idle,
    }
}

#[cfg(test)]
mod tests {
    use super::{NotificationListAction, NotificationListState, render};
    use crate::notification_service::NotificationItem;
    use crate::notifications::{EventId, NotificationKind, NotificationTarget};
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;

    fn item(id: &str, kind: NotificationKind, pane: &str) -> NotificationItem {
        NotificationItem::new(
            EventId::try_from(id).unwrap(),
            kind,
            format!("message-{id}"),
            NotificationTarget::new("$1", "@1", pane),
        )
    }

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn draw(state: &NotificationListState, width: u16, height: u16) -> String {
        let backend = TestBackend::new(width, height);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| render(frame, state)).unwrap();
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
    fn accepts_ordered_snapshots_and_clamps_selection_after_reload() {
        let mut state = NotificationListState::new(vec![
            item("error", NotificationKind::Error, "%1"),
            item("question", NotificationKind::Question, "%2"),
            item("done", NotificationKind::Finished, "%3"),
        ]);
        assert_eq!(
            state
                .items()
                .iter()
                .map(|item| item.event_id().as_str())
                .collect::<Vec<_>>(),
            ["error", "question", "done"]
        );
        state.handle_key(key(KeyCode::Down));
        state.handle_key(key(KeyCode::Down));
        state.accept_snapshot(vec![item("replacement", NotificationKind::Error, "%4")]);

        assert_eq!(state.items()[0].event_id().as_str(), "replacement");
        assert_eq!(state.selected_index(), 0);
    }

    #[test]
    fn navigates_with_j_k_and_arrows_with_boundaries() {
        let mut state = NotificationListState::new(vec![
            item("one", NotificationKind::Finished, "%1"),
            item("two", NotificationKind::Question, "%2"),
            item("three", NotificationKind::Error, "%3"),
        ]);
        state.handle_key(key(KeyCode::Char('j')));
        state.handle_key(key(KeyCode::Down));
        assert_eq!(state.selected_index(), 2);
        state.handle_key(key(KeyCode::Char('k')));
        state.handle_key(key(KeyCode::Up));
        state.handle_key(key(KeyCode::Up));
        assert_eq!(state.selected_index(), 0);
    }

    #[test]
    fn quit_escape_and_enter_return_the_expected_intents() {
        let mut state =
            NotificationListState::new(vec![item("one", NotificationKind::Finished, "%1")]);
        assert_eq!(
            state.handle_key(key(KeyCode::Enter)),
            NotificationListAction::Select(EventId::try_from("one").unwrap())
        );
        assert_eq!(
            state.handle_key(key(KeyCode::Char('q'))),
            NotificationListAction::Quit
        );
        assert_eq!(
            state.handle_key(key(KeyCode::Esc)),
            NotificationListAction::Quit
        );
    }

    #[test]
    fn empty_state_ignores_navigation_and_enter() {
        let mut state = NotificationListState::new(Vec::new());
        state.handle_key(key(KeyCode::Char('j')));
        state.handle_key(key(KeyCode::Down));
        assert_eq!(state.selected_index(), 0);
        assert_eq!(
            state.handle_key(key(KeyCode::Enter)),
            NotificationListAction::None
        );
        assert!(state.items().is_empty());
    }

    #[test]
    fn stale_reload_clamps_selection_and_sets_banner() {
        let mut state = NotificationListState::new(vec![
            item("one", NotificationKind::Finished, "%1"),
            item("two", NotificationKind::Question, "%2"),
            item("three", NotificationKind::Error, "%3"),
        ]);
        state.handle_key(key(KeyCode::Down));
        state.handle_key(key(KeyCode::Down));
        state.accept_refresh(
            vec![item("one", NotificationKind::Finished, "%1")],
            "Selection stale; list refreshed",
        );

        assert_eq!(state.selected_index(), 0);
        assert_eq!(state.banner(), Some("Selection stale; list refreshed"));
    }

    #[test]
    fn renders_normal_list_and_explicit_empty_state() {
        let state = NotificationListState::new(vec![item("one", NotificationKind::Error, "%9")]);
        let rendered = draw(&state, 80, 8);
        assert!(rendered.contains("error"));
        assert!(rendered.contains("message-one"));
        assert!(rendered.contains("$1/@1/%9"));

        let empty = draw(&NotificationListState::new(Vec::new()), 80, 8);
        assert!(empty.contains("No notifications"));
    }

    #[test]
    fn narrow_render_never_panics() {
        let state = NotificationListState::new(vec![item("one", NotificationKind::Question, "%9")]);
        let rendered = draw(&state, 12, 3);
        assert!(!rendered.is_empty());
    }
}
