use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf, process::Command};

fn sentinel_dir() -> PathBuf {
    let path = PathBuf::from(std::env::var_os("TMPDIR").expect("clean-room TMPDIR"))
        .join(format!("pane-dash-version-{}", std::process::id()));
    fs::create_dir_all(&path).expect("create sentinel directory");
    path
}

fn failing_tmux_path() -> PathBuf {
    let dir = sentinel_dir();
    let calls = dir.join("calls");
    fs::remove_file(&calls).ok();
    let tmux = dir.join("tmux");
    fs::write(
        &tmux,
        format!("#!/bin/sh\nprintf 1 >> {}\nexit 99\n", calls.display()),
    )
    .expect("write tmux sentinel");
    fs::set_permissions(&tmux, fs::Permissions::from_mode(0o755)).expect("make tmux executable");
    tmux
}

fn tmux_sentinel_calls() -> usize {
    fs::read_to_string(sentinel_dir().join("calls"))
        .unwrap_or_default()
        .lines()
        .count()
}

#[test]
fn version_is_recognized_before_bench_identity_and_tmux() {
    let tmux = failing_tmux_path();
    let output = Command::new(env!("CARGO_BIN_EXE_pane-dash"))
        .arg("--version")
        .env("PATH", tmux.parent().expect("tmux parent"))
        .env_remove("TMUX")
        .env_remove("TMUX_PANE")
        .output()
        .expect("run pane-dash --version");

    assert_eq!(
        output.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, b"pane-dash 0.1.0\n");
    assert!(output.stderr.is_empty());
    assert_eq!(tmux_sentinel_calls(), 0);
}
