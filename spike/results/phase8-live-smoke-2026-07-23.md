# Phase 8 live-smoke closure evidence — 2026-07-23

## Environment and scope

- Platform: macOS 15.7.7, Darwin 24.6 arm64; tmux 3.7b; Ghostty.
- One real `/dev/ttys000` client was used. Its geometry was 149×118 before the
  Ghostty restart and 149×58 at final verification.
- Phase 8 begins after Phase 7 at `bf61876`; its plan is `15d2c3d` and the
  final closure gate is `1efcd82`.
- The manual second-client item was **not run** by contract: only one real
  client was available. The isolated concurrent-popup live harness passed; this
  is automated coverage, not a manual second-client pass.

## User-observed live checklist

- Wide dashboard: horizontal list/preview, six status glyphs, grouped and flat
  views, collapse, retained punctuation filtering, and Help all passed.
- Preview/actions: follow, inspect, resume, Enter jump, kill cancellation and
  confirmation, exact literal send with no injection sentinel, and Ctrl-Z
  zoom/jump ordering all passed.
- Creation: representative split, new-session duplicate-name correction, and
  normal new-window creation passed.
- The synchronous interactive `after-new-window` hook exposed the partial-create
  timeout boundary: after about ten seconds, a valid pane ID was retained with
  no later tag/send and no leaked process. The correction was designed,
  TDD-tested, and reviewed in `4b4b3fc..1c98e74`. After the operator safely
  removed the hook, the user confirmed both the predicted partial result and
  normal creation. The original hook was restored exactly:
  `after-new-window[0] command-prompt -I "#{window_name}" "rename-window %%"`.
- At 55% width, the initial Help reachability and light-on-dark visibility issue
  were found. Scrollable Help was designed, planned, implemented, and
  review-approved in `5b50198..1efcd82`. In the dark 55%×30 retry, the user
  scrolled first-to-final Help content using `j`/`k`, arrows, Ctrl-U/Ctrl-D,
  PageUp/PageDown, and `g`/`G`; inspect/focus behavior was preserved and
  resumed. Light-theme transparency remains documented: it is not changed to
  paint a background and can be low contrast on a dark terminal.
- Themes: dark/light were observed; terminal-native and a magenta custom
  override passed; exact invalid-color and near-miss warnings appeared; a
  close/reopen cyan reload produced no warnings. The isolated XDG home was
  removed.
- Lifecycle: with detach-on-destroy off, the popup retargeted to base and then
  disappeared with no process; with it on, the client detached to shell, the
  popup disappeared, and reattachment returned to base. Source sessions were
  gone.
- Engine routing: explicit fzf 0.73.1 fallback passed; after restoring the
  absent engine option, the Rust absolute `open.sh`/`bin` binding was active.
- High churn: twenty capacity-safe create/status/kill cycles had zero driver
  errors and settled at exactly one idle row. The user confirmed responsive
  navigation and Help with no freeze. An earlier burst stopped after four due
  to tmux no-space and was invalidated, so it is not counted.

## Cleanup evidence

- No Phase 8/smoke sessions, options, groups, new-command, themes, engine
  override, or XDG state remain. Detach-on-destroy is on; the original hook is
  restored; no exact `pane-dash` process remains.
- Stale test process groups and pane-dash scratch servers were removed. Only
  the project `.cortexkit/magic-context` runtime remains untracked; it is not a
  Phase 8 artifact.
- The final binding is Rust-first per the approved rollout, rather than the
  prior legacy binding.

## Final whole-project gate

At `1efcd82`, the following command categories passed: format, Clippy,
ShellCheck, PTY helper; Cargo all-targets (**452 active, 14 ignored**); serial
ignored (**14**); Bats (**110**); Bun (**41**); `integration.sh` (**6**),
`pane_dash_integration.sh` (**5**), `rust_engine_integration.sh` (**1**), and
quoting (**2**); plus the full Rust live/source-package/config/control/preview/
creation/live gates. The fresh full-bound run passed; its timing-sensitive
cleanup retry is recorded with that run. The release binary measured
**1,781,424 bytes**, below the 5 MB budget. The final verifier reported PASS.

No timings are asserted beyond the observed partial-create boundary above.
