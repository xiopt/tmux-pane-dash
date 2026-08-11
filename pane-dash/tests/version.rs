use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
};

fn sentinel_dir() -> PathBuf {
    std::env::temp_dir().join(format!("pane-dash-version-{}", std::process::id()))
}

struct SentinelDir {
    path: PathBuf,
}

impl SentinelDir {
    fn new() -> Self {
        let path = sentinel_dir();
        fs::remove_dir_all(&path).ok();
        fs::create_dir_all(&path).expect("create sentinel directory");
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for SentinelDir {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.path).ok();
    }
}

fn failing_tmux_path(dir: &Path) -> PathBuf {
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

fn tmux_sentinel_calls(dir: &Path) -> usize {
    fs::read_to_string(dir.join("calls"))
        .unwrap_or_default()
        .lines()
        .count()
}

#[test]
fn version_is_recognized_before_bench_identity_and_tmux() {
    let sentinel = SentinelDir::new();
    let tmux = failing_tmux_path(sentinel.path());
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
    assert_eq!(output.stdout, b"pane-dash 0.1.6\n");
    assert!(output.stderr.is_empty());
    assert_eq!(tmux_sentinel_calls(sentinel.path()), 0);
}
