use ansi_to_tui::IntoText;
use ratatui::text::{Line, Span};

use crate::model::PaneId;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviewFrame {
    pub pane_id: PaneId,
    pub lines: Vec<Line<'static>>,
}

/// Parses a pane capture into owned, styled terminal lines.
///
/// A malformed capture is deliberately rendered as lossily decoded plain text:
/// preview failure must never interrupt the dashboard event loop.
pub fn parse_preview(pane_id: PaneId, bytes: Vec<u8>) -> PreviewFrame {
    let lines = if std::str::from_utf8(&bytes).is_ok() {
        bytes
            .into_text()
            .map(|text| {
                let mut lines = text.lines.into_iter().map(own_line).collect::<Vec<_>>();
                if bytes.ends_with(b"\n") {
                    lines.push(Line::default());
                }
                lines
            })
            .unwrap_or_else(|_| fallback_lines(&bytes))
    } else {
        fallback_lines(&bytes)
    };

    PreviewFrame { pane_id, lines }
}

fn own_line(line: Line<'static>) -> Line<'static> {
    Line {
        style: line.style,
        alignment: line.alignment,
        spans: line
            .spans
            .into_iter()
            .map(|span| Span::styled(span.content.into_owned(), span.style))
            .collect(),
    }
}

fn fallback_lines(bytes: &[u8]) -> Vec<Line<'static>> {
    String::from_utf8_lossy(bytes)
        .split('\n')
        .map(|line| Line::raw(line.strip_suffix('\r').unwrap_or(line).to_owned()))
        .collect()
}
