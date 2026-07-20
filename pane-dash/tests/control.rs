use pane_dash::control::{
    CONTROL_SNAPSHOT_COMMAND, GuardId, ProtocolEvent, ProtocolParser, jump_command,
};

fn guard(timestamp: u64, command_number: u64) -> GuardId {
    GuardId {
        timestamp,
        command_number,
    }
}

fn response(id: GuardId, ok: bool, data: &[u8]) -> ProtocolEvent {
    ProtocolEvent::Response {
        id,
        ok,
        data: data.to_vec(),
    }
}

#[test]
fn parses_matching_end_with_binary_response_from_wire_fixture() {
    let fixture = include_bytes!("../../spike/results/tmux_3.7b/30_wire_framing_raw.bin");
    let mut parser = ProtocolParser::default();
    let events: Vec<_> = fixture
        .split_inclusive(|byte| *byte == b'\n')
        .flat_map(|line| parser.push_line(line))
        .collect();

    assert!(events.contains(&response(
        guard(1_784_499_811, 302),
        true,
        b"\x1e$0\x1f%0\n"
    )));
}

#[test]
fn parses_matching_error() {
    let mut parser = ProtocolParser::default();
    assert!(parser.push_line(b"%begin 10 20 1\n").is_empty());
    assert_eq!(
        parser.push_line(b"%error 10 20 1\n"),
        vec![response(guard(10, 20), false, b"")]
    );
}

#[test]
fn preserves_wrong_guard_ids_as_response_data() {
    let mut parser = ProtocolParser::default();
    parser.push_line(b"%begin 1784499811 306 1\n");
    assert!(parser.push_line(b"evil\n").is_empty());
    assert!(parser.push_line(b"%end 1 1 1\n").is_empty());
    assert!(parser.push_line(b"after\n").is_empty());
    assert_eq!(
        parser.push_line(b"%end 1784499811 306 1\n"),
        vec![response(
            guard(1_784_499_811, 306),
            true,
            b"evil\n%end 1 1 1\nafter\n"
        )]
    );
}

#[test]
fn preserves_notification_nested_begin_and_exit_lines_inside_response() {
    let mut parser = ProtocolParser::default();
    parser.push_line(b"%begin 5 6 1\n");
    for line in [
        b"%window-add @2\n".as_slice(),
        b"%begin 7 8 1\n",
        b"%exit\n",
    ] {
        assert!(parser.push_line(line).is_empty());
    }
    assert_eq!(
        parser.push_line(b"%end 5 6 1\n"),
        vec![response(
            guard(5, 6),
            true,
            b"%window-add @2\n%begin 7 8 1\n%exit\n"
        )]
    );
}

#[test]
fn consumes_each_normative_topology_token_with_arguments_from_notify_fixture() {
    let fixture = include_bytes!("../../spike/results/tmux_3.7b/20_notify_scope_raw.txt");
    let mut parser = ProtocolParser::default();
    let events: Vec<_> = fixture
        .split_inclusive(|byte| *byte == b'\n')
        .flat_map(|line| parser.push_line(line))
        .filter(|event| matches!(event, ProtocolEvent::TopologyChanged))
        .collect();

    assert_eq!(events.len(), 14);
    assert!(
        events
            .iter()
            .all(|event| *event == ProtocolEvent::TopologyChanged)
    );
}

#[test]
fn consumes_each_normative_topology_token_with_arguments() {
    let mut parser = ProtocolParser::default();
    for line in [
        b"%window-add @1\n".as_slice(),
        b"%window-close @1\n",
        b"%window-renamed @1 name\n",
        b"%layout-change @1 layout visible-layout *\n",
        b"%window-pane-changed @1 %1\n",
        b"%session-window-changed $1 @1\n",
        b"%sessions-changed extra\n",
        b"%session-renamed $1 renamed\n",
        b"%unlinked-window-add @1\n",
        b"%unlinked-window-close @1\n",
        b"%unlinked-window-renamed @1 renamed\n",
    ] {
        assert_eq!(parser.push_line(line), vec![ProtocolEvent::TopologyChanged]);
    }
}

#[test]
fn ignores_unconsumed_unknown_and_stray_guard_lines() {
    let mut parser = ProtocolParser::default();
    for line in [
        b"%client-detached /dev/ttys001\n".as_slice(),
        b"%session-changed $0 base\n",
        b"%pane-mode-changed %1\n",
        b"%unknown value\n",
        b"%end 1 2 3\n",
        b"%error 1 2 3\n",
    ] {
        assert!(parser.push_line(line).is_empty());
    }
}

#[test]
fn emits_exit_outside_a_response_block_from_lifecycle_fixtures() {
    for fixture in [
        include_bytes!("../../spike/results/tmux_3.7b/70_serverkill.txt").as_slice(),
        include_bytes!("../../spike/results/tmux_3.7b/70_destroy_off.txt").as_slice(),
    ] {
        let mut parser = ProtocolParser::default();
        let events: Vec<_> = fixture
            .split_inclusive(|byte| *byte == b'\n')
            .flat_map(|line| parser.push_line(line))
            .collect();
        assert_eq!(events.last(), Some(&ProtocolEvent::Exit));
    }
}

#[test]
fn finish_is_empty_outside_a_response_and_idempotent() {
    let mut parser = ProtocolParser::default();
    assert!(parser.finish().is_empty());
    assert!(parser.finish().is_empty());
}

#[test]
fn finish_reports_and_clears_an_open_response() {
    let mut parser = ProtocolParser::default();
    parser.push_line(b"%begin 10 20 1\n");
    parser.push_line(b"partial\n");
    assert_eq!(parser.finish(), vec![ProtocolEvent::MalformedResponse]);
    assert!(parser.finish().is_empty());
}

#[test]
fn ignores_malformed_numeric_guards() {
    let mut parser = ProtocolParser::default();
    for line in [
        b"%begin invalid 20 1\n".as_slice(),
        b"%begin 10 invalid 1\n",
        b"%begin 999999999999999999999999999999 20 1\n",
    ] {
        assert!(parser.push_line(line).is_empty());
    }
    assert!(parser.finish().is_empty());
}

#[test]
fn ignores_begins_with_missing_or_nonnumeric_flags() {
    for line in [b"%begin 10 20\n".as_slice(), b"%begin 10 20 invalid\n"] {
        let mut parser = ProtocolParser::default();
        assert!(parser.push_line(line).is_empty());
        assert!(parser.finish().is_empty());
    }
}

#[test]
fn preserves_matching_closes_with_missing_or_nonnumeric_flags_as_data() {
    for (close, ok) in [("%end", true), ("%error", false)] {
        for flags in ["", " invalid"] {
            let mut parser = ProtocolParser::default();
            parser.push_line(b"%begin 10 20 0\n");
            let malformed = format!("{close} 10 20{flags}\n");
            assert!(parser.push_line(malformed.as_bytes()).is_empty());
            assert_eq!(
                parser.push_line(format!("{close} 10 20 0\n").as_bytes()),
                vec![response(guard(10, 20), ok, malformed.as_bytes())]
            );
        }
    }
}

#[test]
fn builds_the_exact_control_snapshot_command() {
    assert_eq!(
        CONTROL_SNAPSHOT_COMMAND,
        "list-panes -a -F \"\\036#{session_id}\\037#{session_name}\\037#{window_id}\\037#{window_index}\\037#{window_name}\\037#{pane_id}\\037#{pane_index}\\037#{pane_active}\\037#{pane_current_command}\\037#{pane_current_path}\\037#{pane_dead}\\037#{@pane_dash_status}\\037#{@pane_dash_status_since}\\037#{@pane_dash_heartbeat}\\037#{@pane_dash_title}\\037#{@pane_dash_model}\\037#{@pane_dash_tag}\\037#{@pane_dash_group}\"\n"
    );
}

#[test]
fn builds_safe_pane_and_session_jump_commands() {
    assert_eq!(
        jump_command("/dev/ttys001", "%42"),
        Some("switch-client -Z -c /dev/ttys001 -t %42\n".into())
    );
    assert_eq!(
        jump_command("/dev/ttys001", "$3"),
        Some("switch-client -c /dev/ttys001 -t $3\n".into())
    );
}

#[test]
fn rejects_invalid_jump_ttys_and_targets() {
    for tty in [
        "tty",
        " /dev/ttys001",
        "/dev/tty 1",
        "/dev/tty\t1",
        "/dev/tty\n1",
        "/dev/tty\r1",
        "/dev/tty\u{b}1",
        "/dev/tty\u{c}1",
        "/dev/tty\\1",
        "/dev/tty\"1",
        "/dev/tty;1",
        "/dev/tty\0",
        "/dev/tty\u{1f}",
    ] {
        assert_eq!(jump_command(tty, "%1"), None, "tty: {tty:?}");
    }
    for target in [
        "1", "@1", " %1", "% 1", "%\t1", "%\n1", "%\r1", "%\u{b}1", "%\u{c}1", "%\\1", "%\"1",
        "%1;", "%\0", "%1\u{1f}",
    ] {
        assert_eq!(
            jump_command("/dev/ttys001", target),
            None,
            "target: {target:?}"
        );
    }
}
