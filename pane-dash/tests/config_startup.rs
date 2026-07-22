use pane_dash::{
    app::{AppState, Event, reduce},
    config::{LoadedUiConfig, load_ui_config},
    model::{Model, ModelConfig},
    options::DashConfig,
    ui,
};
use ratatui::{Terminal, backend::TestBackend, style::Color};
use std::{fs, os::unix::fs::PermissionsExt, path::Path, process::Command, time::Instant};
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
fn config_to_first_test_frame_stays_within_the_startup_budget() {
    let present = child_home(&exact_1024_config());
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
    assert!(present_p95 <= 100.0, "present p95 was {present_p95:.3}ms");
    assert!(missing_p95 <= 100.0, "missing p95 was {missing_p95:.3}ms");
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

fn exact_1024_config() -> String {
    let mut config = "accent = \"red\"\n".to_owned();
    config.push_str(&format!("#{}\n", "x".repeat(1_024 - config.len() - 2)));
    assert_eq!(config.len(), 1_024);
    config
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
