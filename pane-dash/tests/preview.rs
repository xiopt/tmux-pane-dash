use std::{fs, os::unix::fs::PermissionsExt, process::Command};

use pane_dash::{model::PaneId, preview::parse_preview, tmux_exec::TmuxExec};
use ratatui::{
    style::{Color, Modifier, Style},
    text::Line,
};
use tempfile::TempDir;

fn line_text(line: &Line<'_>) -> String {
    line.spans
        .iter()
        .map(|span| span.content.as_ref())
        .collect()
}

fn fake_tmux(dir: &TempDir, body: &str) -> std::path::PathBuf {
    let path = dir.path().join("fake-tmux");
    fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    path
}

#[test]
fn parses_sgr_foreground_background_bold_and_reset() {
    let frame = parse_preview(
        PaneId("%7".into()),
        b"\x1b[31;44;1mhot\x1b[0m plain".to_vec(),
    );

    assert_eq!(frame.pane_id, PaneId("%7".into()));
    assert_eq!(line_text(&frame.lines[0]), "hot plain");
    assert_eq!(frame.lines[0].spans[0].style.fg, Some(Color::Red));
    assert_eq!(frame.lines[0].spans[0].style.bg, Some(Color::Blue));
    assert!(
        frame.lines[0].spans[0]
            .style
            .add_modifier
            .contains(Modifier::BOLD)
    );
    assert_eq!(frame.lines[0].spans[1].style, Style::reset());
}

#[test]
fn preserves_unicode_wide_combining_and_crlf_line_boundaries() {
    let frame = parse_preview(PaneId("%8".into()), "界e\u{301}\r\nnext\n".into());

    assert_eq!(
        frame.lines.iter().map(line_text).collect::<Vec<_>>(),
        ["界e\u{301}", "next", ""]
    );
}

#[test]
fn preserves_empty_and_trailing_physical_lines() {
    let frame = parse_preview(PaneId("%9".into()), b"\nfirst\n\n".to_vec());

    assert_eq!(
        frame.lines.iter().map(line_text).collect::<Vec<_>>(),
        ["", "first", "", ""]
    );
}

#[test]
fn malformed_or_unsupported_ansi_never_panics_or_leaks_terminal_state() {
    let result = std::panic::catch_unwind(|| {
        parse_preview(
            PaneId("%10".into()),
            b"\x1b[31mred\x1b[?9999z\x1b[0m plain\nnext".to_vec(),
        )
    });
    let frame = result.expect("malformed ANSI must not panic");

    assert_eq!(
        frame.lines.iter().map(line_text).collect::<Vec<_>>(),
        ["red plain", "next"]
    );
    let red = &frame.lines[0].spans[0];
    assert_eq!(red.style.fg, Some(Color::Red));
    let plain = frame.lines[0]
        .spans
        .iter()
        .find(|span| span.content.contains("plain"))
        .expect("plain span");
    assert_eq!(plain.style, Style::reset());
    assert!(
        frame.lines[1]
            .spans
            .iter()
            .all(|span| span.style == Style::reset())
    );

    let fallback = parse_preview(PaneId("%11".into()), b"\x1b[31mred\xff\nnext".to_vec());
    assert!(
        fallback
            .lines
            .iter()
            .flat_map(|line| &line.spans)
            .all(|span| span.style == Style::default())
    );

    let hostile = std::panic::catch_unwind(|| {
        parse_preview(
            PaneId("%12".into()),
            b"\x1b[38;5;999mcolor\x1b[0m\x1b]8;;\x07link\x1b]8;;\x07\x1b[?25l".to_vec(),
        )
    })
    .expect("hostile ANSI must not panic");
    let hostile_text = hostile.lines.iter().map(line_text).collect::<String>();
    assert_eq!(hostile_text, "colorlink");
    assert!(
        hostile
            .lines
            .iter()
            .flat_map(|line| &line.spans)
            .all(|span| !span.content.contains('\x1b')),
        "unsupported terminal controls must not leak into preview text"
    );
}

/// Captured from OpenCode 1.17.20 in a 120x36 isolated tmux pane attached through
/// a headless WezTerm terminal emulator; machine-specific paths are width-preserving ASCII.
#[test]
fn parses_real_interactive_opencode_fixture_with_geometry_and_styles() {
    let bytes = include_bytes!("fixtures/opencode-alt-screen.ansi").to_vec();
    assert!(
        bytes.contains(&0x1b),
        "fixture must retain real ANSI escapes"
    );

    let frame = parse_preview(PaneId("%fixture".into()), bytes);
    let lines = frame.lines.iter().map(line_text).collect::<Vec<_>>();
    let display = lines.join("\n");
    assert!(display.contains("Ask anything..."));
    assert!(display.contains("/connect to add an AI provider"));
    assert!(display.contains("fixture-project:master"));
    assert!(
        !display.contains("Commands:"),
        "fixture must not be CLI help"
    );
    assert!(!display.contains("Usage:"), "fixture must not be CLI help");
    assert_eq!(
        lines.len(),
        37,
        "fixed 120x36 tmux capture geometry plus trailing LF"
    );
    let prompt = frame
        .lines
        .iter()
        .flat_map(|line| &line.spans)
        .find(|span| span.content.contains("Ask anything..."))
        .expect("interactive prompt span");
    assert_eq!(prompt.style.fg, Some(Color::Rgb(128, 128, 128)));
    assert!(
        frame
            .lines
            .iter()
            .flat_map(|line| &line.spans)
            .any(|span| { span.style != Style::default() })
    );
}

#[tokio::test]
async fn capture_pane_passes_exact_argv_and_preserves_arbitrary_bytes() {
    let dir = TempDir::new().unwrap();
    let argv = dir.path().join("argv.bin");
    let fake = fake_tmux(
        &dir,
        &format!(
            "printf '%s\\0' \"$@\" > '{}'\nprintf '\\033[31mbytes\\377'",
            argv.display()
        ),
    );

    let output = TmuxExec::new(fake)
        .capture_pane(&PaneId("%41".into()))
        .await
        .unwrap();

    assert_eq!(fs::read(argv).unwrap(), b"capture-pane\0-p\0-e\0-t\0%41\0");
    assert_eq!(output, b"\x1b[31mbytes\xff");
}

#[tokio::test]
async fn capture_pane_returns_error_for_a_nonzero_tmux_exit() {
    let dir = TempDir::new().unwrap();
    let fake = fake_tmux(&dir, "printf 'missing pane' >&2\nexit 1");

    assert!(
        TmuxExec::new(fake)
            .capture_pane(&PaneId("%gone".into()))
            .await
            .is_err()
    );
}

#[tokio::test]
#[ignore = "requires installed tmux >= 3.6"]
async fn real_tmux_capture_parses_styles_and_rejects_a_disappeared_pane() {
    struct Server(String);

    impl Drop for Server {
        fn drop(&mut self) {
            let _ = Command::new("tmux")
                .args(["-L", &self.0, "kill-server"])
                .status();
        }
    }

    let socket = format!("pd_preview_it_{}", std::process::id());
    let _server = Server(socket.clone());
    let tmux = |args: &[&str]| {
        Command::new("tmux")
            .args(["-L", &socket])
            .args(args)
            .output()
            .unwrap()
    };
    let created = tmux(&[
        "-f",
        "/dev/null",
        "new-session",
        "-d",
        "-s",
        "preview",
        "printf 'normal\\n\\033[31;1mred-marker\\033[0m\\n'; sleep 30",
    ]);
    assert!(created.status.success(), "{created:?}");
    let pane =
        String::from_utf8(tmux(&["display-message", "-p", "-t", "preview", "#{pane_id}"]).stdout)
            .unwrap()
            .trim()
            .to_owned();
    let wrapper_dir = TempDir::new().unwrap();
    let wrapper = fake_tmux(&wrapper_dir, &format!("exec tmux -L '{socket}' \"$@\""));
    let exec = TmuxExec::new(wrapper);

    let mut bytes = Vec::new();
    for _ in 0..20 {
        bytes = exec.capture_pane(&PaneId(pane.clone())).await.unwrap();
        if bytes
            .windows(b"normal".len())
            .any(|window| window == b"normal")
        {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(
        bytes
            .windows(b"normal".len())
            .any(|window| window == b"normal")
    );
    assert!(bytes.contains(&0x1b));
    let frame = parse_preview(PaneId(pane.clone()), bytes);
    let marker = frame
        .lines
        .iter()
        .flat_map(|line| &line.spans)
        .find(|span| span.content.contains("red-marker"))
        .expect("red marker");
    assert_eq!(marker.style.fg, Some(Color::Red));
    assert!(marker.style.add_modifier.contains(Modifier::BOLD));

    let killed = tmux(&["kill-pane", "-t", &pane]);
    assert!(killed.status.success(), "{killed:?}");
    assert!(exec.capture_pane(&PaneId(pane)).await.is_err());
}
