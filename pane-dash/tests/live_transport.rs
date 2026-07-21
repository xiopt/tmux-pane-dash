#![cfg(unix)]

use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use pane_dash::{
    actions::{kill_pane, send_text},
    app::ActionOutcome,
    control::{ControlEvent, ControlHandle, connect_control},
    model::{Model, ModelConfig, PaneId, Status},
    preview::parse_preview,
    snapshot::parse,
    tmux_exec::TmuxExec,
    transport::{SnapshotCompletion, TransportCoordinator, TransportDirective, TransportInput},
};
use tempfile::TempDir;
use tokio::time::{Instant, timeout};

const FRESHNESS_BUDGET: Duration = Duration::from_millis(120);
const FALLBACK_BUDGET: Duration = Duration::from_millis(1100);
const PREVIEW_BUDGET: Duration = Duration::from_millis(500);
const DEBOUNCE: Duration = Duration::from_millis(50);

/// Exercises the real control-channel and one-shot paths without relying on a
/// user's tmux server, configuration, environment, or fixed socket path.
#[tokio::test(flavor = "current_thread")]
#[ignore = "requires tmux >= 3.6"]
async fn live_transport_freshness_harness() {
    let harness = Harness::new();
    harness.create_session("live", "exec cat");
    let live_id = harness.session_id("live");
    let initial_pane = harness.pane_id("live:0.0");
    harness.set_pane_option(&initial_pane, "@pane_dash_tag", "live-test");
    harness.create_session("other", "exec cat");
    let other_initial = harness.pane_id("other:0.0");
    harness.set_pane_option(&other_initial, "@pane_dash_tag", "live-other");

    let (control, mut events) = timeout(
        Duration::from_secs(2),
        connect_control(harness.wrapper(), &live_id),
    )
    .await
    .expect("control attach timed out")
    .expect("control attach failed");
    let exec = TmuxExec::new(harness.wrapper());
    let mut transport = connected_transport();

    assert_eq!(
        transport.input(TransportInput::RefreshNow),
        vec![TransportDirective::ChannelSnapshot]
    );
    let initial = channel_model(&control, &mut transport).await;
    assert!(
        initial.panes().contains_key(&initial_pane),
        "initial model lost tagged pane"
    );
    assert!(
        initial.panes()[&initial_pane].tag == "live-test",
        "initial model did not retain pane tag"
    );

    drain_events(&mut events);
    let split_started = Instant::now();
    let split_pane = harness.split("live:0", "exec sleep 60");
    harness.set_pane_option(&split_pane, "@pane_dash_tag", "live-split");
    assert!(
        harness
            .output(["list-panes", "-a", "-F", "#{pane_id}"])
            .lines()
            .any(|pane_id| pane_id == split_pane.0),
        "one-shot split did not retain {}",
        split_pane.0
    );
    assert_notification_snapshot(
        &control,
        &mut events,
        &mut transport,
        "attached_split",
        split_started,
        |model| model.panes().contains_key(&split_pane),
    )
    .await;

    let kill_target = harness.split("live:0", "exec sleep 60");
    harness.set_pane_option(&kill_target, "@pane_dash_tag", "live-kill");
    wait_topology(&mut events, "setup_kill").await;
    drain_events(&mut events);
    let kill_started = Instant::now();
    assert_eq!(kill_pane(&exec, &kill_target).await, ActionOutcome::Success);
    assert_notification_snapshot(
        &control,
        &mut events,
        &mut transport,
        "attached_kill",
        kill_started,
        |model| !model.panes().contains_key(&kill_target),
    )
    .await;

    drain_events(&mut events);
    let new_started = Instant::now();
    harness.run(["new-window", "-d", "-t", "live", "-n", "fresh", "exec cat"]);
    let fresh_pane = harness.pane_id("live:fresh.0");
    harness.set_pane_option(&fresh_pane, "@pane_dash_tag", "live-fresh");
    assert_notification_snapshot(
        &control,
        &mut events,
        &mut transport,
        "attached_new_window",
        new_started,
        |model| {
            model
                .windows()
                .values()
                .any(|window| window.name == "fresh")
        },
    )
    .await;

    drain_events(&mut events);
    let rename_started = Instant::now();
    harness.run(["rename-window", "-t", "live:fresh", "renamed"]);
    assert_notification_snapshot(
        &control,
        &mut events,
        &mut transport,
        "attached_rename",
        rename_started,
        |model| {
            model
                .windows()
                .values()
                .any(|window| window.name == "renamed")
        },
    )
    .await;

    harness.create_session("linked", "exec cat");
    harness.run(["link-window", "-s", "live:0", "-t", "linked:1"]);
    wait_topology(&mut events, "link_window").await;
    drain_events(&mut events);
    let linked_started = Instant::now();
    let linked_pane = harness.split("live:0", "exec sleep 60");
    harness.set_pane_option(&linked_pane, "@pane_dash_tag", "live-linked");
    assert_notification_snapshot(
        &control,
        &mut events,
        &mut transport,
        "linked_split",
        linked_started,
        |model| {
            let memberships = model
                .memberships()
                .iter()
                .filter(|membership| membership.pane_id == linked_pane)
                .collect::<Vec<_>>();
            memberships.len() == 2
                && memberships
                    .iter()
                    .any(|membership| model.sessions()[&membership.session_id].name == "live")
                && memberships
                    .iter()
                    .any(|membership| model.sessions()[&membership.session_id].name == "linked")
        },
    )
    .await;

    drain_events(&mut events);
    let mut fallback_tick = tokio::time::interval(Duration::from_secs(1));
    fallback_tick.tick().await;
    let fallback_started = Instant::now();
    let other_pane = harness.split("other:0", "exec sleep 60");
    harness.set_pane_option(&other_pane, "@pane_dash_tag", "live-other-split");
    let quiet = timeout(Duration::from_millis(100), events.recv()).await;
    assert!(
        quiet.is_err(),
        "other-session change unexpectedly drove a relied-upon notification: {quiet:?}"
    );
    timeout(FALLBACK_BUDGET, fallback_tick.tick())
        .await
        .expect("other-session fallback tick timed out");
    let directives = transport.input(TransportInput::FallbackTick);
    assert_eq!(directives, vec![TransportDirective::ChannelSnapshot]);
    let fallback = channel_model(&control, &mut transport).await;
    assert!(fallback.panes().contains_key(&other_pane));
    metric(
        "other_session_fallback",
        fallback_started.elapsed(),
        FALLBACK_BUDGET,
    );

    let mut status_tick = tokio::time::interval(Duration::from_secs(1));
    status_tick.tick().await;
    let status_started = Instant::now();
    let status_since = unix_seconds();
    harness.set_pane_option(&initial_pane, "@pane_dash_status", "working");
    harness.set_pane_option(
        &initial_pane,
        "@pane_dash_status_since",
        &status_since.to_string(),
    );
    harness.set_pane_option(
        &initial_pane,
        "@pane_dash_heartbeat",
        &status_since.to_string(),
    );
    let quiet = timeout(Duration::from_millis(100), events.recv()).await;
    assert!(
        quiet.is_err(),
        "pane-option update unexpectedly drove a relied-upon notification: {quiet:?}"
    );
    timeout(FALLBACK_BUDGET, status_tick.tick())
        .await
        .expect("pane-status fallback tick timed out");
    assert_eq!(
        transport.input(TransportInput::FallbackTick),
        vec![TransportDirective::ChannelSnapshot]
    );
    let status_model = channel_model(&control, &mut transport).await;
    let pane = &status_model.panes()[&initial_pane];
    assert_eq!(pane.status, Status::Working);
    assert_eq!(pane.status_since, Some(status_since));
    metric(
        "pane_status_fallback",
        status_started.elapsed(),
        FALLBACK_BUDGET,
    );

    let marker = "LIVE_PREVIEW_MARKER_42; tmux kill-server #[literal]";
    let preview_started = Instant::now();
    assert_eq!(
        send_text(&exec, &initial_pane, marker).await,
        ActionOutcome::Success
    );
    wait_preview_marker(&exec, &initial_pane, marker, preview_started).await;
    assert_eq!(kill_pane(&exec, &linked_pane).await, ActionOutcome::Success);
    assert!(
        exec.capture_pane(&linked_pane).await.is_err(),
        "disappeared preview target unexpectedly captured"
    );
    harness.run(["has-session", "-t", "live"]);

    // The wrapper records only the control process after this point, allowing a
    // direct EOF/exit assertion without a terminal client or global process scan.
    harness.clear_log();
    let (terminating, mut termination_events) = connect_control(harness.wrapper(), &live_id)
        .await
        .expect("second control attach failed");
    let control_pid = harness.logged_pid();
    harness.kill_pid(control_pid);
    let terminated = timeout(Duration::from_secs(2), termination_events.recv())
        .await
        .expect("control termination timed out")
        .expect("control event channel closed before termination");
    assert!(matches!(terminated, ControlEvent::Terminated(_)));
    match timeout(Duration::from_millis(200), termination_events.recv()).await {
        Ok(None) => {}
        Ok(Some(event)) => panic!("control emitted a duplicate termination: {event:?}"),
        Err(_) => panic!("control event channel remained open after termination"),
    }
    assert!(
        terminating.snapshot().await.is_err(),
        "terminated control accepted a snapshot"
    );
}

async fn assert_notification_snapshot<A>(
    control: &ControlHandle,
    events: &mut tokio::sync::mpsc::UnboundedReceiver<ControlEvent>,
    transport: &mut TransportCoordinator,
    label: &str,
    started: Instant,
    assertion: A,
) where
    A: Fn(&Model) -> bool,
{
    wait_topology(events, label).await;
    assert_eq!(
        transport.input(TransportInput::TopologyChanged),
        vec![TransportDirective::StartDebounce]
    );
    tokio::time::sleep(DEBOUNCE).await;
    assert_eq!(
        transport.input(TransportInput::DebounceElapsed),
        vec![TransportDirective::ChannelSnapshot]
    );
    loop {
        let model = raw_channel_model(control).await;
        if assertion(&model) {
            assert_eq!(
                transport.snapshot_completed(SnapshotCompletion::Valid),
                Vec::<TransportDirective>::new()
            );
            metric(label, started.elapsed(), FRESHNESS_BUDGET);
            return;
        }
        assert!(
            started.elapsed() < FRESHNESS_BUDGET,
            "{label} snapshot did not include mutation: {model:?}"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

async fn channel_model(control: &ControlHandle, transport: &mut TransportCoordinator) -> Model {
    let model = raw_channel_model(control).await;
    assert_eq!(
        transport.snapshot_completed(SnapshotCompletion::Valid),
        Vec::<TransportDirective>::new()
    );
    model
}

async fn wait_preview_marker(exec: &TmuxExec, pane_id: &PaneId, marker: &str, started: Instant) {
    let mut last_capture = "no capture attempted".to_owned();
    loop {
        let elapsed = started.elapsed();
        assert!(
            elapsed < PREVIEW_BUDGET,
            "preview marker was not visible within {PREVIEW_BUDGET:?}; last_capture={last_capture}"
        );
        let remaining = PREVIEW_BUDGET.saturating_sub(elapsed);
        match timeout(remaining, exec.capture_pane(pane_id)).await {
            Ok(Ok(bytes)) => {
                let byte_count = bytes.len();
                let preview = parse_preview(pane_id.clone(), bytes);
                if preview
                    .lines
                    .iter()
                    .any(|line| line.to_string().contains(marker))
                {
                    metric("preview_capture", started.elapsed(), PREVIEW_BUDGET);
                    return;
                }
                last_capture = format!(
                    "capture succeeded without marker (bytes={byte_count}, lines={})",
                    preview.lines.len()
                );
            }
            Ok(Err(error)) => last_capture = format!("capture failed: {error:#}"),
            Err(_) => {
                panic!(
                    "preview capture timed out within {PREVIEW_BUDGET:?}; last_capture={last_capture}"
                )
            }
        }

        let elapsed = started.elapsed();
        assert!(
            elapsed < PREVIEW_BUDGET,
            "preview marker was not visible within {PREVIEW_BUDGET:?}; last_capture={last_capture}"
        );
        tokio::time::sleep(Duration::from_millis(5).min(PREVIEW_BUDGET - elapsed)).await;
    }
}

async fn raw_channel_model(control: &ControlHandle) -> Model {
    let bytes = timeout(Duration::from_secs(1), control.snapshot())
        .await
        .expect("channel snapshot timed out")
        .expect("channel snapshot failed");
    let outcome = parse(&bytes);
    assert_eq!(
        outcome.dropped, 0,
        "channel snapshot contained malformed records"
    );
    assert!(!outcome.records.is_empty(), "channel snapshot was empty");
    Model::build(&outcome.records, &ModelConfig::default(), unix_seconds())
}

fn connected_transport() -> TransportCoordinator {
    let (mut transport, directives) = TransportCoordinator::new();
    assert_eq!(directives, vec![TransportDirective::Connect]);
    assert!(transport.input(TransportInput::Connected).is_empty());
    transport
}

async fn wait_topology(
    events: &mut tokio::sync::mpsc::UnboundedReceiver<ControlEvent>,
    label: &str,
) {
    let event = timeout(Duration::from_millis(750), events.recv())
        .await
        .unwrap_or_else(|_| panic!("{label}: timed out waiting for topology notification"))
        .unwrap_or_else(|| panic!("{label}: control event channel closed"));
    match event {
        ControlEvent::TopologyChanged => {}
        ControlEvent::FocusChanged(_) => {}
        ControlEvent::Terminated(reason) => panic!("{label}: control terminated: {reason}"),
    }
}

fn drain_events(events: &mut tokio::sync::mpsc::UnboundedReceiver<ControlEvent>) {
    while let Ok(event) = events.try_recv() {
        assert!(
            matches!(
                event,
                ControlEvent::TopologyChanged | ControlEvent::FocusChanged(_)
            ),
            "control terminated while draining: {event:?}"
        );
    }
}

fn metric(label: &str, elapsed: Duration, budget: Duration) {
    println!(
        "LIVE_METRIC {label}_ms={} budget_ms={}",
        elapsed.as_millis(),
        budget.as_millis()
    );
    assert!(elapsed <= budget, "{label}: {elapsed:?} exceeds {budget:?}");
}

fn unix_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

struct Harness {
    dir: TempDir,
    socket: PathBuf,
    wrapper: PathBuf,
    log: PathBuf,
}

impl Harness {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("create tempdir");
        let socket = dir.path().join("socket");
        let wrapper = dir.path().join("tmux-isolated");
        let log = dir.path().join("control-pids");
        fs::write(
            &wrapper,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$$\" >> {}\nexec tmux -S {} \"$@\"\n",
                shell_quote(&log),
                shell_quote(&socket),
            ),
        )
        .expect("write tmux wrapper");
        fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755))
            .expect("make wrapper executable");
        Self {
            dir,
            socket,
            wrapper,
            log,
        }
    }

    fn wrapper(&self) -> &Path {
        &self.wrapper
    }

    fn run<const N: usize>(&self, args: [&str; N]) {
        let output = Command::new("tmux")
            .arg("-S")
            .arg(&self.socket)
            .args(args)
            .output()
            .expect("spawn isolated tmux");
        assert!(
            output.status.success(),
            "tmux failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn output<const N: usize>(&self, args: [&str; N]) -> String {
        let output = Command::new("tmux")
            .arg("-S")
            .arg(&self.socket)
            .args(args)
            .output()
            .expect("spawn isolated tmux");
        assert!(
            output.status.success(),
            "tmux failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).expect("tmux output was not UTF-8")
    }

    fn create_session(&self, name: &str, command: &str) {
        let output = Command::new("tmux")
            .args(["-f", "/dev/null", "-S"])
            .arg(&self.socket)
            .args(["new-session", "-d", "-s", name, command])
            .output()
            .expect("spawn isolated tmux");
        assert!(
            output.status.success(),
            "tmux failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn session_id(&self, name: &str) -> String {
        self.output(["display-message", "-p", "-t", name, "#{session_id}"])
            .trim()
            .to_owned()
    }

    fn pane_id(&self, target: &str) -> PaneId {
        PaneId::from(
            self.output(["display-message", "-p", "-t", target, "#{pane_id}"])
                .trim(),
        )
    }

    fn split(&self, target: &str, command: &str) -> PaneId {
        PaneId::from(
            self.output([
                "split-window",
                "-d",
                "-P",
                "-F",
                "#{pane_id}",
                "-t",
                target,
                command,
            ])
            .trim(),
        )
    }

    fn set_pane_option(&self, pane_id: &PaneId, name: &str, value: &str) {
        self.run(["set-option", "-p", "-t", &pane_id.0, name, value]);
    }

    fn clear_log(&self) {
        fs::write(&self.log, "").expect("clear control log");
    }

    fn logged_pid(&self) -> u32 {
        fs::read_to_string(&self.log)
            .expect("read control log")
            .lines()
            .last()
            .expect("wrapper did not record control PID")
            .parse()
            .expect("wrapper recorded invalid PID")
    }

    fn kill_pid(&self, pid: u32) {
        self.run_command("/bin/kill", &["-TERM", &pid.to_string()]);
    }

    fn run_command(&self, program: &str, args: &[&str]) {
        assert!(
            Command::new(program)
                .args(args)
                .status()
                .expect("spawn helper command")
                .success()
        );
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        let _ = Command::new("tmux")
            .arg("-S")
            .arg(&self.socket)
            .arg("kill-server")
            .output();
        let _ = self.dir.path();
    }
}

fn shell_quote(value: &Path) -> String {
    format!("'{}'", value.display().to_string().replace('\'', "'\"'\"'"))
}
