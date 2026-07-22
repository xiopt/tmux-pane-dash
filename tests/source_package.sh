#!/usr/bin/env bash
# Verify that the filesystem source package builds and installs without Git or network access.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
scratch_root="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/pane-dash-source-package.XXXXXX")" && pwd -P)"
archive="$scratch_root/pane-dash-source.tar"
scratch="$scratch_root/extracted source '\$dollar;semi#hash\`tick\`"
sentinel_bin="$scratch_root/git sentinel"

cleanup() {
  rm -rf "$scratch_root"
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

mode_of() {
  stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"
}

shell_quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
  printf "'"
}

checkout_fingerprint() {
  tar -C "$ROOT" \
    --exclude='./.git' --exclude='./.cortexkit' \
    --exclude='./pane-dash/target' --exclude='./bin/pane-dash' \
    --exclude='./bin/.pane-dash.tmp.*' \
    -cf - . | shasum -a 256 | awk '{print $1}'
}

before="$(checkout_fingerprint)"

tar -C "$ROOT" \
  --exclude='./.git' --exclude='./.cortexkit' \
  --exclude='./pane-dash/target' --exclude='./bin/pane-dash' \
  --exclude='./bin/.pane-dash.tmp.*' \
  -cf "$archive" .

mkdir -p "$scratch"
tar -C "$scratch" -xf "$archive"

extracted="$scratch"
[ ! -e "$extracted/.git" ] || fail 'source archive contains .git'
[ ! -e "$extracted/bin/pane-dash" ] || fail 'source archive contains prebuilt pane-dash'
[ -f "$extracted/pane-dash/Cargo.lock" ] || fail 'source archive is missing Cargo.lock'
[ -d "$extracted/pane-dash/src" ] || fail 'source archive is missing Rust source'
[ -d "$extracted/scripts" ] || fail 'source archive is missing scripts'
[ -d "$extracted/tests" ] || fail 'source archive is missing tests'

mkdir -p "$sentinel_bin"
git_sentinel_log="$scratch_root/git-invocations.log"
export GIT_SENTINEL_LOG="$git_sentinel_log"
cat > "$sentinel_bin/git" <<'EOF'
#!/bin/sh
printf 'git invoked\n' >> "$GIT_SENTINEL_LOG"
printf 'git invoked\n' >&2
exit 97
EOF
chmod 755 "$sentinel_bin/git"

export CARGO_NET_OFFLINE=true
install_root="$scratch_root/install destination"
[ ! -e "$install_root" ] || fail 'install destination exists before build'

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
binary_pid=$!
deadline=$((SECONDS + 2))
while kill -0 "$binary_pid" 2>/dev/null; do
  [ "$SECONDS" -lt "$deadline" ] || {
    kill "$binary_pid" 2>/dev/null || :
    wait "$binary_pid" 2>/dev/null || :
    fail 'pane-dash did not exit within two seconds without arguments'
  }
  sleep 0.05
done
if wait "$binary_pid"; then
  binary_status=0
else
  binary_status=$?
fi
[ "$binary_status" -eq 1 ] || fail "pane-dash without arguments exited $binary_status, expected 1"
grep -Fx 'Error: expected client_tty session_id pane_id' "$stderr" >/dev/null ||
  fail 'pane-dash stderr did not contain the exact expected argument identities'

tmux_stub_dir="$scratch_root/tmux stub"
mkdir -p "$tmux_stub_dir/global"
: > "$tmux_stub_dir/calls.log"
PATH="$extracted/tests/stubs:$sentinel_bin:$PATH" \
  TMUX_STUB_DIR="$tmux_stub_dir" \
  "$extracted/pane_dash.tmux"

expected_binding="bind-key$(printf '\037')D$(printf '\037')run-shell$(printf '\037')$(shell_quote "$extracted/scripts/open.sh") $(shell_quote "$binary") '#{client_tty}' '#{session_id}' '#{pane_id}'$(printf '\037')"
actual_binding="$(sed -n '5p' "$tmux_stub_dir/calls.log")"
[ "$actual_binding" = "$expected_binding" ] || fail 'absent engine did not bind the exact extracted local binary'
[ ! -e "$git_sentinel_log" ] || fail 'Git sentinel was invoked while loading plugin'

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

after="$(checkout_fingerprint)"
[ "$before" = "$after" ] || fail 'source packaging changed the original checkout'

archive_bytes="$(wc -c < "$archive" | tr -d ' ')"
if command -v shasum >/dev/null 2>&1; then
  archive_sha256="$(shasum -a 256 "$archive" | cut -d ' ' -f 1)"
else
  archive_sha256="$(sha256sum "$archive" | cut -d ' ' -f 1)"
fi
printf 'source-package archive_bytes=%s sha256=%s mode=0755 offline=pass\n' "$archive_bytes" "$archive_sha256"
