#!/usr/bin/env bash
# Verify the explicit filesystem source package builds without Git or network access.
set -euo pipefail
set -m

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
MANIFEST=(.github .gitignore LICENSE Makefile README.md VERSION bun.lock package.json opencode-plugin packages pane-dash pane_dash.tmux release scripts spike tests tools)
EXPECTED_WORKFLOWS=(ci.yml opencode-weekly.yml release.yml)
scratch_root="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/pane-dash-source-package.XXXXXX")" && pwd -P)"
archive="$scratch_root/pane-dash-source.tar"
scratch="$scratch_root/extracted source [*] (meta)"
cargo_target_dir="$scratch_root/cargo-target"
sentinel_bin="$scratch_root/sentinels"
tmux_bin="$(command -v "${TMUX_BIN:-tmux}")"
socket="pd-source-package-$$"
declare -a active_pids=()
declare -a active_process_groups=()
wrapped_binary_backup=""

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

sha256_stream() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
  else
    sha256sum | awk '{print $1}'
  fi
}

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

mode_of() {
  local value
  if value=$(stat -c '%a' "$1" 2>/dev/null) && [[ "$value" =~ ^[0-7]{3,4}$ ]]; then
    printf '%s\n' "$value"
    return 0
  fi
  if value=$(stat -f '%Lp' "$1" 2>/dev/null) && [[ "$value" =~ ^[0-7]{3,4}$ ]]; then
    printf '%s\n' "$value"
    return 0
  fi
  return 1
}

shell_quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
  printf "'"
}

source_tar() {
  COPYFILE_DISABLE=1 tar -C "$ROOT" \
    --exclude='.git' --exclude='.git/*' --exclude='*/.git' --exclude='*/.git/*' \
    --exclude='.cortexkit' --exclude='.cortexkit/*' --exclude='*/.cortexkit' --exclude='*/.cortexkit/*' \
    --exclude='pane-dash/target' --exclude='pane-dash/target/*' --exclude='*/target' --exclude='*/target/*' \
    --exclude='*/dist' --exclude='*/dist/*' --exclude='release/dist' --exclude='release/dist/*' \
    --exclude='node_modules' --exclude='*/node_modules' --exclude='*.tgz' --exclude='*.tar.gz' --exclude='*.sha256' \
    --exclude='bin/pane-dash' --exclude='*/bin/pane-dash' --exclude='.pane-dash.tmp.*' --exclude='*/.pane-dash.tmp.*' \
    --exclude='.DS_Store' --exclude='*/.DS_Store' --exclude='._*' --exclude='*/._*' \
    "$@" "${MANIFEST[@]}"
}

content_manifest_sha256() {
  python3 - "$ROOT" "${MANIFEST[@]}" <<'PY' | sha256_stream
import fnmatch
import os
import stat
import sys

root, *manifest = sys.argv[1:]

def forbidden(relative):
    parts = relative.split(os.sep)
    name = parts[-1]
    return (
        any(part in {".git", ".cortexkit", "target", "dist", "node_modules"} for part in parts)
        or name == ".DS_Store"
        or fnmatch.fnmatch(name, ".pane-dash.tmp.*")
        or fnmatch.fnmatch(name, "._*")
        or (len(parts) >= 2 and parts[-2:] == ["bin", "pane-dash"])
    )

paths = []
for entry in manifest:
    absolute = os.path.join(root, entry)
    if os.path.islink(absolute) or os.path.isfile(absolute):
        paths.append(absolute)
        continue
    for directory, directories, files in os.walk(absolute, followlinks=False):
        directories.sort()
        files.sort()
        for name in directories + files:
            path = os.path.join(directory, name)
            if os.path.islink(path) or os.path.isfile(path):
                paths.append(path)

output = sys.stdout.buffer
for path in sorted(paths, key=lambda candidate: os.path.relpath(candidate, root).encode()):
    relative = os.path.relpath(path, root)
    if forbidden(relative):
        continue
    if "\n" in relative:
        raise SystemExit(f"unsupported newline in source-manifest path: {relative!r}")
    metadata = os.lstat(path)
    mode = stat.S_IMODE(metadata.st_mode)
    output.write(relative.encode() + b"\0" + f"{mode:04o}".encode() + b"\0")
    if stat.S_ISLNK(metadata.st_mode):
        target = os.readlink(path)
        if "\n" in target:
            raise SystemExit(f"unsupported newline in source-manifest symlink target: {relative!r}")
        output.write(b"L\0" + target.encode() + b"\0")
    elif stat.S_ISREG(metadata.st_mode):
        output.write(b"F\0")
        with open(path, "rb") as source:
            while chunk := source.read(1024 * 1024):
                output.write(chunk)
        output.write(b"\0")
    else:
        raise SystemExit(f"unsupported source-manifest entry: {relative!r}")
PY
}

source_fingerprint() {
  content_manifest_sha256
}

generated_output_metadata() {
  python3 - "$ROOT" <<'PY' | sha256_stream
import os
import sys

root = sys.argv[1]
for relative_root in ("bin", "pane-dash/target"):
    absolute_root = os.path.join(root, relative_root)
    if not os.path.lexists(absolute_root):
        continue
    paths = [absolute_root]
    for directory, directories, files in os.walk(absolute_root, followlinks=False):
        directories.sort()
        files.sort()
        paths.extend(os.path.join(directory, name) for name in directories + files)
    for path in sorted(paths):
        stat = os.lstat(path)
        print(f"{os.path.relpath(path, root)}\t{stat.st_size}\t{stat.st_mtime_ns}")
PY
}

assert_no_forbidden_paths() {
  local forbidden
  forbidden="$(find "$extracted" \( \
    -name .git -o -name .cortexkit -o -name target -o -name dist -o -name node_modules -o -name pane-dash -path '*/bin/pane-dash' -o \
    -name '.pane-dash.tmp.*' -o -name .DS_Store -o -name '._*' \
  \) -print -quit)"
  [ -z "$forbidden" ] || fail "source archive contains forbidden path $forbidden"
}

terminate_and_reap() {
  local pid=$1 remaining=40 state
  local -a pids=("$pid")
  [ -n "$pid" ] || return 0
  collect_descendants "$pid"
  kill -TERM "${pids[@]}" 2>/dev/null || true
  while ((remaining--)); do
    state="$(ps -p "$pid" -o stat= 2>/dev/null || :)"
    [ -z "$state" ] || [[ "$state" == Z* ]] && break
    sleep 0.05
  done
  state="$(ps -p "$pid" -o stat= 2>/dev/null || :)"
  if [ -n "$state" ] && [[ "$state" != Z* ]]; then
    kill -KILL "${pids[@]}" 2>/dev/null || true
  fi
  wait "$pid" 2>/dev/null || true
}

collect_descendants() {
  local parent=$1 child
  while IFS= read -r child; do
    pids+=("$child")
    collect_descendants "$child"
  done < <(pgrep -P "$parent" 2>/dev/null || true)
}

assert_terminate_and_reap_regressions() {
  local leader child grandchild nested_dir state

  "$BASH" -c 'trap "" TERM; while :; do :; done' &
  leader=$!
  terminate_and_reap "$leader"
  wait "$leader" 2>/dev/null || true
  state="$(ps -p "$leader" -o stat= 2>/dev/null || :)"
  [ -z "$state" ] || fail 'terminate_and_reap did not reap a leader without descendants'

  nested_dir="$scratch_root/terminate-and-reap"
  mkdir -p "$nested_dir"
  cat > "$nested_dir/child" <<'CHILD'
#!/usr/bin/env bash
trap '' TERM
"$BASH" -c 'trap "" TERM; while :; do :; done' &
printf '%s\n' "$!" > "$1/grandchild"
while :; do :; done
CHILD
  cat > "$nested_dir/leader" <<'LEADER'
#!/usr/bin/env bash
trap '' TERM
"$BASH" "$1/child" "$1" &
printf '%s\n' "$!" > "$1/child-pid"
while :; do :; done
LEADER
  chmod 755 "$nested_dir/child" "$nested_dir/leader"
  "$BASH" "$nested_dir/leader" "$nested_dir" &
  leader=$!
  for _ in $(seq 1 40); do
    [ -s "$nested_dir/child-pid" ] && [ -s "$nested_dir/grandchild" ] && break
    sleep 0.05
  done
  if [ ! -s "$nested_dir/child-pid" ] || [ ! -s "$nested_dir/grandchild" ]; then
    fail 'terminate_and_reap regression fixture did not start nested descendants'
  fi
  child="$(<"$nested_dir/child-pid")"
  grandchild="$(<"$nested_dir/grandchild")"
  terminate_and_reap "$leader"
  wait "$leader" 2>/dev/null || true
  for leader in "$leader" "$child" "$grandchild"; do
    for _ in $(seq 1 40); do
      state="$(ps -p "$leader" -o stat= 2>/dev/null || :)"
      [ -z "$state" ] && break
      sleep 0.05
    done
    [ -z "$state" ] || fail "terminate_and_reap did not reap TERM-ignoring descendant $leader"
  done
}

terminate_process_group() {
  local pgid=$1 remaining=40
  python3 - "$pgid" TERM <<'PY' 2>/dev/null || true
import os, signal, sys
os.killpg(int(sys.argv[1]), getattr(signal, f"SIG{sys.argv[2]}"))
PY
  while ((remaining--)); do
    pgrep -g "$pgid" >/dev/null 2>&1 || return 0
    sleep 0.05
  done
  python3 - "$pgid" KILL <<'PY' 2>/dev/null || true
import os, signal, sys
os.killpg(int(sys.argv[1]), getattr(signal, f"SIG{sys.argv[2]}"))
PY
}

cleanup() {
  local pid pgid
  for pgid in "${active_process_groups[@]:-}"; do terminate_process_group "$pgid"; done
  for pid in "${active_pids[@]:-}"; do terminate_and_reap "$pid"; done
  TMUX='' "$tmux_bin" -L "$socket" kill-server 2>/dev/null || true
  if [ -n "$wrapped_binary_backup" ] && [ -e "$wrapped_binary_backup" ]; then
    mv -f "$wrapped_binary_backup" "${wrapped_binary_backup%.actual}"
  fi
  rm -f "$scratch/pane-dash/target" 2>/dev/null || true
  rm -rf "$cargo_target_dir"
  [ ! -e "$cargo_target_dir" ] || {
    printf 'FAIL: scratch Cargo target remains after cleanup\n' >&2
    return 1
  }
  rm -rf "$scratch_root"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

assert_terminate_and_reap_regressions

for credential in GH_TOKEN GITHUB_TOKEN NPM_TOKEN NODE_AUTH_TOKEN NPM_CONFIG_USERCONFIG npm_config_userconfig; do
  if [[ "$credential" == NPM_CONFIG_USERCONFIG || "$credential" == npm_config_userconfig ]] && [ "${!credential:-}" = "$(dirname "${HOME:-}")/npmrc" ] && [ "${npm_config_cache:-}" = "$(dirname "${HOME:-}")/npm-cache" ] && [ ! -e "${!credential:-}" ]; then
    continue
  fi
  [ -z "${!credential:-}" ] || fail "credential environment is present: $credential"
done

warm_root="$scratch_root/bun-warm"
warm_cache="$scratch_root/bun-cache"
bun_bin="${BUN_BOOTSTRAP:-$(command -v bun || true)}"
case "$bun_bin" in /*) [ -x "$bun_bin" ] || fail 'Bun bootstrap is not executable' ;; *) fail 'Bun 1.3.14 is required for the source package gate' ;; esac
[ "$($bun_bin --version 2>/dev/null)" = "1.3.14" ] || fail 'Bun 1.3.14 is required for the source package gate'
workflow_names="$(find "$ROOT/.github/workflows" -maxdepth 1 -type f -exec basename {} \; | sort | tr '\n' ' ' | sed 's/ $//')"
[ "$workflow_names" = "${EXPECTED_WORKFLOWS[*]}" ] || fail 'source tree must contain exactly ci.yml opencode-weekly.yml release.yml'
mkdir -p "$warm_root/packages/tmux-pane-dash" "$warm_root/opencode-plugin" "$warm_cache"
cp "$ROOT/package.json" "$ROOT/bun.lock" "$warm_root/"
cp "$ROOT/packages/tmux-pane-dash/package.json" "$warm_root/packages/tmux-pane-dash/"
cp "$ROOT/opencode-plugin/package.json" "$warm_root/opencode-plugin/"
BUN_INSTALL_CACHE_DIR="$warm_cache" npm_config_cache="$warm_cache" "$bun_bin" install --frozen-lockfile --ignore-scripts --cwd "$warm_root" >/dev/null
printf 'bun-cache=warm-pass\n'

before="$(source_fingerprint)"
generated_before="$(generated_output_metadata)"
source_tar -cf "$archive"

mkdir -p "$scratch"
COPYFILE_DISABLE=1 tar -C "$scratch" -xf "$archive"
extracted="$scratch"

for expected in "${MANIFEST[@]}"; do
  [ -e "$extracted/$expected" ] || fail "source archive is missing $expected"
done
  [ -f "$extracted/pane-dash/Cargo.lock" ] || fail 'source archive is missing Cargo.lock'
  [ -d "$extracted/pane-dash/src" ] || fail 'source archive is missing Rust source'
  for workflow in "${EXPECTED_WORKFLOWS[@]}"; do
    [ -f "$extracted/.github/workflows/$workflow" ] || fail "source archive is missing .github/workflows/$workflow"
  done
  [ -f "$extracted/release/verify-npm-provenance.ts" ] || fail 'source archive is missing the release verifier source'
  [ -f "$extracted/release/tests/verify-npm-provenance.test.ts" ] || fail 'source archive is missing the release verifier test'
  [ ! -e "$extracted/docs" ] || fail 'source archive contains ignored documentation'
  [ -x "$extracted/scripts/release/ci-tmux.sh" ] || fail 'source archive is missing the executable CI tmux helper'
  assert_no_forbidden_paths
  BUN_INSTALL_CACHE_DIR="$warm_cache" npm_config_cache="$warm_cache" "$bun_bin" install --frozen-lockfile --offline --ignore-scripts --cwd "$extracted" >/dev/null
  printf 'offline=bun-warm-cache-pass\n'

mkdir -p "$sentinel_bin"
for command in git curl wget nc; do
  cat > "$sentinel_bin/$command" <<EOF
#!/bin/sh
printf '%s %s\\n' '$command' "\$*" >> "\$SENTINEL_LOG/$command"
exit 97
EOF
  chmod 755 "$sentinel_bin/$command"
done
cat > "$sentinel_bin/tmux" <<EOF
#!/bin/sh
printf 'tmux %s\\n' "\$*" >> "\$SENTINEL_LOG/tmux"
exec "$tmux_bin" -L "$socket" "\$@"
EOF
chmod 755 "$sentinel_bin/tmux"
sentinel_log="$scratch_root/sentinel-log"
mkdir -p "$sentinel_log"
export SENTINEL_LOG="$sentinel_log"
export CARGO_NET_OFFLINE=true
export CARGO_TARGET_DIR="$cargo_target_dir"
mkdir -p "$CARGO_TARGET_DIR"
ln -s "$CARGO_TARGET_DIR" "$extracted/pane-dash/target"
install_root="$scratch_root/install destination"
[ ! -e "$install_root" ] || fail 'install destination exists before build'

if ! cargo --version >/dev/null 2>&1 && [ "${PANE_DASH_SOURCE_RUST_READY:-0}" != 1 ]; then
  PANE_DASH_SOURCE_RUST_READY=1 "$ROOT/tests/release/with-rust.sh" -- env \
    CARGO_NET_OFFLINE=true CARGO_TARGET_DIR="$CARGO_TARGET_DIR" "$BASH" "$ROOT/tests/source_package.sh"
  exit $?
fi

(
  cd "$extracted"
  PATH="$sentinel_bin:$PATH" make build
)

binary="$extracted/bin/pane-dash"
[ -x "$binary" ] || fail 'offline build did not create executable pane-dash'
[ "$(mode_of "$binary")" = 755 ] || fail 'offline build did not create mode 0755 pane-dash'
[ ! -e "$install_root" ] || fail 'build wrote the install destination'

stderr="$scratch_root/no-argv.stderr"
"$binary" >"$scratch_root/no-argv.stdout" 2>"$stderr" &
no_argv_pid=$!
active_pids+=("$no_argv_pid")
deadline=$((SECONDS + 2))
while kill -0 "$no_argv_pid" 2>/dev/null; do
  [ "$SECONDS" -lt "$deadline" ] || {
    terminate_and_reap "$no_argv_pid"
    fail 'pane-dash did not exit within two seconds without arguments'
  }
  sleep 0.05
done
if wait "$no_argv_pid"; then no_argv_status=0; else no_argv_status=$?; fi
active_pids=()
[ "$no_argv_status" -eq 1 ] || fail "pane-dash without arguments exited $no_argv_status, expected 1"
grep -Fx 'Error: expected client_tty session_id pane_id' "$stderr" >/dev/null ||
  fail 'pane-dash stderr did not contain the exact expected argument identities'

tmux_stub_dir="$scratch_root/tmux stub"
mkdir -p "$tmux_stub_dir/global"
: > "$tmux_stub_dir/calls.log"
PATH="$extracted/tests/stubs:$sentinel_bin:$PATH" TMUX_STUB_DIR="$tmux_stub_dir" "$extracted/pane_dash.tmux"
expected_binding="bind-key$(printf '\037')D$(printf '\037')run-shell$(printf '\037')$(shell_quote "$extracted/scripts/open.sh") $(shell_quote "$binary") '#{client_tty}' '#{session_id}' '#{pane_id}'$(printf '\037')"
actual_binding="$(sed -n '5p' "$tmux_stub_dir/calls.log")"
[ "$actual_binding" = "$expected_binding" ] || fail 'absent engine did not bind the exact extracted local binary'

wrapped_binary_backup="$binary.actual"
mv "$binary" "$wrapped_binary_backup"
route_log="$scratch_root/route.argv"
route_pid="$scratch_root/route.pid"
cat > "$binary" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$\$" > "$route_pid"
printf '%s\n' "\$@" > "$route_log"
exec "$wrapped_binary_backup" "\$@"
EOF
chmod 755 "$binary"

TMUX='' PATH="$sentinel_bin:$PATH" "$tmux_bin" -L "$socket" -f /dev/null new-session -d -s one 'sleep 120'
TMUX='' "$tmux_bin" -L "$socket" new-session -d -s two 'sleep 120'
server_path="$(TMUX='' "$tmux_bin" -L "$socket" show-environment -g PATH)"
[[ "$server_path" == *"$sentinel_bin"* ]] || fail 'isolated tmux server did not retain sentinel PATH'
{ sleep 2; printf '\002'; sleep 600; } | TMUX='' script -q /dev/null "$tmux_bin" -L "$socket" attach-session -t one >/dev/null 2>&1 &
client_one_pid=$!
active_pids+=("$client_one_pid")
active_process_groups+=("$(ps -o pgid= -p "$client_one_pid" | tr -d ' ')")
{ sleep 600; } | TMUX='' script -q /dev/null "$tmux_bin" -L "$socket" attach-session -t two >/dev/null 2>&1 &
client_two_pid=$!
active_pids+=("$client_two_pid")
active_process_groups+=("$(ps -o pgid= -p "$client_two_pid" | tr -d ' ')")
for _ in $(seq 1 30); do
  client_count="$(TMUX='' "$tmux_bin" -L "$socket" list-clients 2>/dev/null | wc -l | tr -d ' ')"
  [ "$client_count" = 2 ] && break
  sleep 0.1
done
[ "${client_count:-0}" = 2 ] || fail 'two PTY clients did not attach'
PATH="$sentinel_bin:$PATH" "$extracted/pane_dash.tmux"
real_binding="$(TMUX='' "$tmux_bin" -L "$socket" list-keys -T prefix | awk '$4 == "D" { print; exit }')"
[[ "$real_binding" == *'/bin/pane-dash'* ]] || fail "extracted shim did not bind a local binary [$real_binding]"
expected_tty="$(TMUX='' "$tmux_bin" -L "$socket" list-clients -t two -F '#{client_tty}')"
client_one_tty="$(TMUX='' "$tmux_bin" -L "$socket" list-clients -t one -F '#{client_tty}')"
expected_session="$(TMUX='' "$tmux_bin" -L "$socket" list-clients -t two -F '#{session_id}')"
expected_pane="$(TMUX='' "$tmux_bin" -L "$socket" list-clients -t two -F '#{pane_id}')"
for _ in $(seq 1 30); do
  best_tty="$(TMUX='' "$tmux_bin" -L "$socket" display-message -p '#{client_tty}')"
  [ "$best_tty" = "$client_one_tty" ] && break
  sleep 0.1
done
[ "${best_tty:-}" = "$client_one_tty" ] || fail 'noninvoking client did not become tmux best client'
TMUX='' "$tmux_bin" -L "$socket" send-keys -K -c "$expected_tty" C-b D
for _ in $(seq 1 50); do
  [ -s "$route_log" ] && [ -s "$route_pid" ] && break
  sleep 0.1
done
if [ ! -s "$route_log" ]; then
  TMUX='' "$tmux_bin" -L "$socket" show-messages >&2 || true
  cat "$sentinel_log/tmux" >&2 2>/dev/null || true
  fail 'extracted Rust route did not invoke recorder'
fi
route_actual="$(paste -sd $'\t' "$route_log")"
route_expected="$(printf '%s\t%s\t%s' "$expected_tty" "$expected_session" "$expected_pane")"
[ "$route_actual" = "$route_expected" ] || fail "extracted Rust route argv [$route_actual]"
popup_pid="$(<"$route_pid")"
for _ in $(seq 1 50); do
  control_command="$(pgrep -P "$popup_pid" 2>/dev/null | xargs -n1 ps -o command= -p 2>/dev/null | grep -- '-C attach-session' || :)"
  [ -n "$control_command" ] && break
  sleep 0.1
done
[ -n "${control_command:-}" ] || fail 'extracted popup did not start its control client'
TMUX='' "$tmux_bin" -L "$socket" send-keys -K -c "$expected_tty" q
for _ in $(seq 1 40); do
  ps -p "$popup_pid" >/dev/null 2>&1 || break
  sleep 0.05
done
TMUX='' "$tmux_bin" -L "$socket" kill-server 2>/dev/null || true
mv -f "$wrapped_binary_backup" "$binary"
wrapped_binary_backup=""

sibling="$install_root/usr/local/bin/keep"
mkdir -p "${sibling%/*}"
printf 'sibling\n' > "$sibling"
(
  cd "$extracted"
  PATH="$sentinel_bin:$PATH" make install DESTDIR="$install_root" PREFIX=/usr/local
)
installed="$install_root/usr/local/bin/pane-dash"
[ -x "$installed" ] || fail 'offline install did not create staged pane-dash'
[ "$(mode_of "$installed")" = 755 ] || fail 'offline install did not create mode 0755 pane-dash'
(
  cd "$extracted"
  PATH="$sentinel_bin:$PATH" make uninstall DESTDIR="$install_root" PREFIX=/usr/local
)
[ ! -e "$installed" ] || fail 'uninstall did not remove staged pane-dash'
[ -f "$sibling" ] || fail 'uninstall removed sibling file'
[ -d "${sibling%/*}" ] || fail 'uninstall removed destination directory'
for command in git curl wget nc; do
  [ ! -e "$sentinel_log/$command" ] || fail "$command sentinel was invoked"
done

after="$(source_fingerprint)"
generated_after="$(generated_output_metadata)"
[ "$before" = "$after" ] || fail 'source packaging changed the explicit source manifest'
[ "$generated_before" = "$generated_after" ] || fail 'source packaging changed original generated output metadata'

archive_bytes="$(wc -c < "$archive" | tr -d ' ')"
archive_run_sha256="$(sha256_file "$archive")"
content_manifest_sha256="$(content_manifest_sha256)"
[ "$before" = "$content_manifest_sha256" ] || fail 'source packaging changed the explicit source content manifest'
printf 'github=required-after-task14\n'
printf 'source-package archive_bytes=%s archive_run_sha256=%s content_manifest_sha256=%s mode=0755 offline=warm-cache-pass\n' \
  "$archive_bytes" "$archive_run_sha256" "$content_manifest_sha256"
