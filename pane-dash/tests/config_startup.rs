use pane_dash::{
    app::{AppState, Event, reduce},
    config::{LoadedUiConfig, load_ui_config},
    model::{Model, ModelConfig},
    options::DashConfig,
    ui,
};
use ratatui::{Terminal, backend::TestBackend, style::Color};
use std::{
    ffi::OsStr,
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    thread,
    time::{Duration, Instant},
};
use tempfile::TempDir;

#[test]
fn app_state_keeps_explicit_loaded_config_immutable_through_reducer_events() {
    let loaded = LoadedUiConfig::default();
    let expected_palette = loaded.palette;
    let expected_warnings = loaded
        .warning_texts()
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let mut app = AppState::new(
        Model::build(&[], &ModelConfig::default(), 0),
        DashConfig::default(),
        loaded,
    );

    reduce(&mut app, Event::Tick { now: 60 });
    reduce(&mut app, Event::SnapshotFailed("offline".into()));

    assert_eq!(app.palette(), &expected_palette);
    assert_eq!(
        app.config_warnings()
            .iter()
            .map(|warning| warning.text())
            .map(str::to_owned)
            .collect::<Vec<_>>(),
        expected_warnings
    );
}

#[test]
fn production_loader_uses_isolated_child_environments_for_valid_invalid_missing_and_concurrent_configs()
 {
    let valid = child_home("accent = \"red\"\n");
    let invalid = child_home("accent = \"invalid\"\n");
    let missing = TempDir::new().unwrap();

    let valid_result = run_child(valid.path(), "probe");
    assert!(valid_result.contains("accent=Red"));
    assert!(valid_result.contains("warnings="));

    let invalid_result = run_child(invalid.path(), "probe");
    assert!(invalid_result.contains("accent=Cyan"));
    assert!(invalid_result.contains("invalid color 'invalid' for 'accent'"));

    let missing_result = run_child(missing.path(), "probe");
    assert!(missing_result.contains("accent=Cyan"));
    assert!(missing_result.contains("warnings="));
    assert!(!missing_result.contains("config:"));

    let blue = child_home("accent = \"blue\"\n");
    let red = child_home("accent = \"red\"\n");
    let (blue_result, red_result) = std::thread::scope(|scope| {
        let blue = scope.spawn(|| run_child(blue.path(), "probe"));
        let red = scope.spawn(|| run_child(red.path(), "probe"));
        (blue.join().unwrap(), red.join().unwrap())
    });
    assert!(blue_result.contains("accent=Blue"));
    assert!(red_result.contains("accent=Red"));
}

#[cfg(unix)]
#[test]
fn production_loader_reports_non_utf8_config_in_an_isolated_child() {
    let home = child_home_bytes(b"accent = \"\xff\"");
    let result = run_child(home.path(), "probe");

    assert!(result.contains("not valid UTF-8"));
}

#[test]
fn config_to_test_frame_reports_present_and_missing_config_timings() {
    let present = child_home(&exact_1024_config("red"));
    let missing = TempDir::new().unwrap();

    let present_samples = parse_samples(&run_child(present.path(), "perf-present"));
    let missing_samples = parse_samples(&run_child(missing.path(), "perf-missing"));
    let present_p95 = percentile_95(&present_samples);
    let missing_p95 = percentile_95(&missing_samples);

    eprintln!(
        "config_startup present config_to_frame_ms p50={:.3} p95={present_p95:.3}",
        median(&present_samples)
    );
    eprintln!(
        "config_startup missing config_to_frame_ms p50={:.3} p95={missing_p95:.3}",
        median(&missing_samples)
    );
    assert_eq!(present_samples.len(), 100);
    assert_eq!(missing_samples.len(), 100);
}

#[test]
fn real_binary_startup_loads_configured_header_accent_within_budget() {
    let script = script_path().unwrap_or_else(|| {
        panic!("script executable unavailable; the real PTY startup gate cannot run")
    });
    let fixture = tempfile::tempdir().unwrap();
    let xdg_config = fixture.path().join("xdg");
    let config_dir = xdg_config.join("tmux-pane-dash");
    fs::create_dir_all(&config_dir).unwrap();
    fs::write(config_dir.join("config.toml"), exact_1024_config("#010203")).unwrap();

    let fake_bin = fixture.path().join("bin");
    fs::create_dir(&fake_bin).unwrap();
    write_fake_tmux(&fake_bin.join("tmux"));

    let binary = std::env::var_os("CARGO_BIN_EXE_pane-dash")
        .map(PathBuf::from)
        .unwrap_or_else(|| panic!("CARGO_BIN_EXE_pane-dash is unavailable"));
    let mut coldframe_samples = Vec::with_capacity(100);
    let mut config_to_frame_samples = Vec::with_capacity(100);
    let mut all_tmux_calls = Vec::with_capacity(200);

    for run in 0..100 {
        let transcript = fixture.path().join(format!("startup-{run}.log"));
        let tmux_log = fixture.path().join(format!("tmux-{run}.log"));
        let mut child = real_startup_command(
            &script,
            &transcript,
            &binary,
            &fake_bin,
            &tmux_log,
            &xdg_config,
        )
        .spawn()
        .unwrap();
        let status = wait_for_exit(&mut child, Duration::from_secs(5));
        let output = fs::read(&transcript).unwrap();
        assert!(
            status.success(),
            "real startup run {run} failed: {}",
            String::from_utf8_lossy(&output)
        );

        coldframe_samples.push(parse_metric(&output, "pane-dash coldframe_ms="));
        config_to_frame_samples.push(parse_metric(&output, "pane-dash config_to_frame_ms="));
        let calls = tmux_calls(&tmux_log);
        assert_eq!(
            calls,
            [
                format!("list-panes -a -F {SNAPSHOT_FORMAT}"),
                "show-options -g".to_owned(),
            ],
            "unexpected tmux traffic on run {run}"
        );
        all_tmux_calls.extend(calls);

        if run == 0 {
            assert!(
                String::from_utf8_lossy(&output).contains("grouped (1)"),
                "the first frame did not render the grouped session header: {}",
                String::from_utf8_lossy(&output)
            );
            assert!(
                String::from_utf8_lossy(&output).contains("\x1b[38;2;1;2;3;49m▾ grouped (1)"),
                "the first frame did not emit the configured truecolor header accent: {}",
                String::from_utf8_lossy(&output)
            );
        }
    }

    let coldframe_p95 = percentile_95(&coldframe_samples);
    let config_to_frame_p95 = percentile_95(&config_to_frame_samples);
    eprintln!(
        "config_startup real coldframe_ms p50={:.3} p95={coldframe_p95:.3}",
        median(&coldframe_samples)
    );
    eprintln!(
        "config_startup real config_to_frame_ms p50={:.3} p95={config_to_frame_p95:.3}",
        median(&config_to_frame_samples)
    );
    assert!(
        coldframe_p95 <= 100.0,
        "real startup coldframe p95 was {coldframe_p95:.3}ms"
    );
    assert_eq!(
        all_tmux_calls
            .iter()
            .filter(|call| call.starts_with("list-panes -a -F "))
            .count(),
        100
    );
    assert_eq!(
        all_tmux_calls
            .iter()
            .filter(|call| call.as_str() == "show-options -g")
            .count(),
        100
    );
}

#[test]
fn child_config_probe() {
    let Some(mode) = std::env::var_os("PANE_DASH_CONFIG_STARTUP_CHILD") else {
        return;
    };
    let output = std::env::var_os("PANE_DASH_CONFIG_STARTUP_OUTPUT").unwrap();
    let config = load_ui_config("dark");
    let mut app = AppState::new(
        Model::build(&[], &ModelConfig::default(), 0),
        DashConfig::default(),
        config,
    );
    let warnings_before_events = app
        .config_warnings()
        .iter()
        .map(|warning| warning.text().to_owned())
        .collect::<Vec<_>>();
    reduce(&mut app, Event::SnapshotFailed("offline".into()));
    reduce(&mut app, Event::Tick { now: 60 });
    assert_eq!(
        app.config_warnings()
            .iter()
            .map(|warning| warning.text())
            .collect::<Vec<_>>(),
        warnings_before_events
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>()
    );

    let contents = if mode == "probe" {
        format!(
            "accent={:?}\nwarnings={}\n",
            app.palette().accent,
            app.config_warnings()
                .iter()
                .map(|warning| warning.text())
                .collect::<Vec<_>>()
                .join("\n")
        )
    } else {
        let mut samples = Vec::with_capacity(100);
        for _ in 0..100 {
            let started = Instant::now();
            let loaded = load_ui_config("dark");
            app = AppState::new(
                Model::build(&[], &ModelConfig::default(), 0),
                DashConfig::default(),
                loaded,
            );
            assert_eq!(
                app.palette().accent,
                if mode == "perf-present" {
                    Color::Red
                } else {
                    Color::Cyan
                }
            );
            let mut terminal = Terminal::new(TestBackend::new(80, 24)).unwrap();
            terminal.draw(|frame| ui::render(frame, &app, 0)).unwrap();
            samples.push(started.elapsed().as_secs_f64() * 1_000.0);
        }
        samples
            .into_iter()
            .map(|sample| format!("{sample:.6}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    fs::write(output, contents).unwrap();
}

fn child_home(contents: &str) -> TempDir {
    child_home_bytes(contents.as_bytes())
}

fn child_home_bytes(contents: &[u8]) -> TempDir {
    let home = TempDir::new().unwrap();
    let directory = home.path().join("tmux-pane-dash");
    fs::create_dir(&directory).unwrap();
    fs::write(directory.join("config.toml"), contents).unwrap();
    home
}

fn run_child(home: &Path, mode: &str) -> String {
    let output = tempfile::NamedTempFile::new().unwrap();
    let tmux_bin = tempfile::tempdir().unwrap();
    let tmux_log = tmux_bin.path().join("tmux.log");
    let tmux = tmux_bin.path().join("tmux");
    fs::write(
        &tmux,
        format!("#!/bin/sh\nprintf called >> '{}'\n", tmux_log.display()),
    )
    .unwrap();
    fs::set_permissions(&tmux, fs::Permissions::from_mode(0o755)).unwrap();
    let status = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "child_config_probe", "--nocapture"])
        .env_clear()
        .env("PANE_DASH_CONFIG_STARTUP_CHILD", mode)
        .env("PANE_DASH_CONFIG_STARTUP_OUTPUT", output.path())
        .env("XDG_CONFIG_HOME", home)
        .env("HOME", home)
        .env("PATH", tmux_bin.path())
        .status()
        .unwrap();
    assert!(status.success());
    assert!(
        !tmux_log.exists(),
        "loading UI config must not execute tmux"
    );
    fs::read_to_string(output.path()).unwrap()
}

fn exact_1024_config(accent: &str) -> String {
    let mut config = format!("accent = \"{accent}\"\n");
    config.push_str(&format!("#{}\n", "x".repeat(1_024 - config.len() - 2)));
    assert_eq!(config.len(), 1_024);
    config
}

const SNAPSHOT_FORMAT: &str = "\x1e#{session_id}\x1f#{session_name}\x1f#{window_id}\x1f#{window_index}\x1f#{window_name}\x1f#{pane_id}\x1f#{pane_index}\x1f#{pane_active}\x1f#{pane_current_command}\x1f#{pane_current_path}\x1f#{pane_dead}\x1f#{@pane_dash_status}\x1f#{@pane_dash_status_since}\x1f#{@pane_dash_heartbeat}\x1f#{@pane_dash_title}\x1f#{@pane_dash_model}\x1f#{@pane_dash_tag}\x1f#{@pane_dash_group}";

fn script_path() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|directory| directory.join("script"))
        .find(|path| path.is_file())
}

fn write_fake_tmux(path: &Path) {
    let snapshot = [
        "$1", "grouped", "@1", "0", "main", "%1", "0", "1", "opencode", "/tmp", "0", "working",
        "1", "1", "Header", "model", "tag", "group",
    ]
    .join("\x1f");
    fs::write(
        path,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$PANE_DASH_TMUX_LOG\"\ncase \"$1\" in\n  list-panes) printf '%s\\n' '\x1e{snapshot}' ;;\n  show-options) printf '%s\\n' '@pane_dash_group 1' ;;\n  *) exit 1 ;;\nesac\n"
        ),
    )
    .unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

fn real_startup_command(
    script: &Path,
    transcript: &Path,
    binary: &Path,
    fake_bin: &Path,
    tmux_log: &Path,
    xdg_config: &Path,
) -> Command {
    let arguments = [
        OsStr::new("/dev/ttys001"),
        OsStr::new("$1"),
        OsStr::new("%1"),
        OsStr::new("--bench-first-frame"),
    ];
    let mut command = Command::new(script);
    #[cfg(target_os = "macos")]
    command
        .arg("-q")
        .arg(transcript)
        .arg("/bin/sh")
        .arg("-c")
        .arg("/bin/stty cols 80 rows 24; exec \"$@\"")
        .arg("pane-dash-pty")
        .arg(binary)
        .args(arguments);
    #[cfg(target_os = "linux")]
    {
        let binary_command = std::iter::once(binary.as_os_str())
            .chain(arguments)
            .map(shell_quote)
            .collect::<Vec<_>>()
            .join(" ");
        let command_line = format!("/bin/stty cols 80 rows 24; exec {binary_command}");
        command
            .arg("-q")
            .arg("-c")
            .arg(command_line)
            .arg(transcript);
    }
    command
        .env_clear()
        .env("PATH", fake_bin)
        .env("PANE_DASH_TMUX_LOG", tmux_log)
        .env("XDG_CONFIG_HOME", xdg_config)
        .env("HOME", xdg_config)
        .env("TERM", "xterm-256color")
        .env("COLORTERM", "truecolor")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

#[cfg(target_os = "linux")]
fn shell_quote(value: &OsStr) -> String {
    format!("'{}'", value.to_string_lossy().replace('\'', "'\"'\"'"))
}

fn wait_for_exit(child: &mut Child, timeout: Duration) -> ExitStatus {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("real startup process exceeded {}ms", timeout.as_millis());
        }
        thread::sleep(Duration::from_millis(5));
    }
}

fn tmux_calls(log: &Path) -> Vec<String> {
    let mut calls = fs::read_to_string(log)
        .unwrap()
        .lines()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    calls.sort_unstable();
    calls
}

fn parse_metric(output: &[u8], prefix: &str) -> f64 {
    let output = String::from_utf8_lossy(output);
    let value = output
        .find(prefix)
        .map(|offset| &output[offset + prefix.len()..])
        .unwrap_or_else(|| panic!("missing {prefix} in PTY output: {output}"));
    value
        .chars()
        .take_while(|character| character.is_ascii_digit() || *character == '.')
        .collect::<String>()
        .parse()
        .unwrap()
}

fn parse_samples(output: &str) -> Vec<f64> {
    output
        .lines()
        .map(|sample| sample.parse().unwrap())
        .collect()
}

fn median(samples: &[f64]) -> f64 {
    let mut samples = samples.to_vec();
    samples.sort_by(f64::total_cmp);
    samples[samples.len() / 2]
}

fn percentile_95(samples: &[f64]) -> f64 {
    let mut samples = samples.to_vec();
    samples.sort_by(f64::total_cmp);
    samples[(samples.len() * 95).div_ceil(100) - 1]
}
