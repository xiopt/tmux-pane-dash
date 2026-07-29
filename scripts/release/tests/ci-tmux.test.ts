import { expect, test } from "bun:test"
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = process.cwd()
const scriptPath = join(root, "scripts/release/ci-tmux.sh")
const writeExecutable = async (path: string, source: string): Promise<void> => {
  await writeFile(path, source)
  await chmod(path, 0o755)
}
const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

test("CI tmux helper pins the official 3.6a source and checksum in RUNNER_TEMP", async () => {
  const source = await readFile(scriptPath, "utf8")
  expect(source).toContain("https://github.com/tmux/tmux/releases/download/3.6a/tmux-3.6a.tar.gz")
  expect(source).toContain("b6d8d9c76585db8ef5fa00d4931902fa4b8cbe8166f528f44fc403961a3f3759")
  expect(source).toContain('mktemp -d "$runner_temp/tmux-3.6a.')
  expect(source).toContain('mktemp -d "$runner_temp/tmux-3.6a-install.')
  expect(source).toContain('cd -- "$source_dir"')
  expect(source).toContain('libutf8proc-dev')
  expect(source).toContain('brew install libevent ncurses pkg-config utf8proc')
  expect(source).toContain('utf8proc_prefix=$(brew --prefix utf8proc)')
  expect(source).toContain('export CPPFLAGS="-I$event_prefix/include -I$ncurses_prefix/include -I$utf8proc_prefix/include ${CPPFLAGS:-}"')
  expect(source).toContain('export LDFLAGS="-L$event_prefix/lib -L$ncurses_prefix/lib -L$utf8proc_prefix/lib ${LDFLAGS:-}"')
  expect(source).toContain('export PKG_CONFIG_PATH="$event_prefix/lib/pkgconfig:$ncurses_prefix/lib/pkgconfig:$utf8proc_prefix/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"')
  expect(source).toContain('env HOME="$build_root/home" TMPDIR="$build_root/tmp" ./configure --prefix="$install_root" --enable-utf8proc >&2')
  expect(source).toContain('make -C "$source_dir" -j"$jobs" >&2')
  expect(source).toContain('make -C "$source_dir" install >&2')
  expect(source).not.toContain("$HOME/.local")
  expect(source).not.toContain("NODE_AUTH_TOKEN")
})

test("CI tmux helper reuses only an existing tmux at or above 3.6", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "pane-dash-ci-tmux-test-"))
  const fake = join(fixture, "tmux")
  await writeFile(fake, "#!/bin/sh\nprintf 'tmux 3.6a\\n'\n")
  await chmod(fake, 0o755)
  try {
    const child = Bun.spawn(["bash", scriptPath], { env: { ...process.env, PATH: "/usr/bin:/bin", TMUX_BIN: fake }, stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(code, stderr).toBe(0)
    expect(stdout.trim()).toBe(await realpath(fake))
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test("CI tmux helper runs configure and make from the extracted source directory", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "pane-dash-ci-tmux-slow-test-"))
  const bin = join(fixture, "bin")
  const caller = join(fixture, "caller")
  const runnerTemp = join(fixture, "runner-temp")
  const deps = join(fixture, "deps")
  const log = join(fixture, "cwd.log")
  const configure = join(fixture, "configure")
  const fakeTmux = join(fixture, "tmux")

  try {
    await Promise.all([
      mkdir(bin, { recursive: true }),
      mkdir(caller, { recursive: true }),
      mkdir(runnerTemp, { recursive: true }),
      mkdir(join(deps, "libevent"), { recursive: true }),
      mkdir(join(deps, "ncurses"), { recursive: true }),
      mkdir(join(deps, "utf8proc"), { recursive: true }),
    ])
    await Promise.all([
      writeExecutable(fakeTmux, "#!/bin/sh\nprintf 'tmux 3.5\\n'\n"),
      writeExecutable(join(bin, "awk"), "#!/bin/sh\nread -r line || :\nprintf 'b6d8d9c76585db8ef5fa00d4931902fa4b8cbe8166f528f44fc403961a3f3759\\n'\n"),
      writeExecutable(join(bin, "basename"), "#!/bin/sh\nexec /usr/bin/basename \"$@\"\n"),
      writeExecutable(join(bin, "brew"), `#!/bin/sh
set -eu
case "$1" in
  install)
    [ "$#" -eq 5 ]
    [ "$2" = libevent ]
    [ "$3" = ncurses ]
    [ "$4" = pkg-config ]
    [ "$5" = utf8proc ]
    ;;
  --prefix)
    case "$2" in
      libevent) printf '%s/libevent\\n' "$CI_TMUX_DEPS" ;;
      ncurses) printf '%s/ncurses\\n' "$CI_TMUX_DEPS" ;;
      utf8proc) printf '%s/utf8proc\\n' "$CI_TMUX_DEPS" ;;
      *) exit 64 ;;
    esac
    ;;
  *) exit 64 ;;
esac
`),
      writeExecutable(join(bin, "curl"), `#!/bin/sh
set -eu
output=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output=$2; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$output" ]
printf 'fixture-archive\\n' > "$output"
`),
      writeExecutable(join(bin, "dirname"), "#!/bin/sh\nexec /usr/bin/dirname \"$@\"\n"),
      writeExecutable(join(bin, "env"), "#!/bin/sh\nexec /usr/bin/env \"$@\"\n"),
      writeExecutable(configure, `#!/bin/sh
set -eu
case "$1" in
  --prefix=*) prefix=\${1#*=} ;;
  *) exit 64 ;;
esac
[ -d "$HOME" ]
[ -d "$TMPDIR" ]
[ "$#" -ge 2 ]
[ "$2" = --enable-utf8proc ]
case "$CPPFLAGS" in
  *"-I$CI_TMUX_DEPS/utf8proc/include"*) ;;
  *) exit 65 ;;
esac
case "$LDFLAGS" in
  *"-L$CI_TMUX_DEPS/utf8proc/lib"*) ;;
  *) exit 66 ;;
esac
case "$PKG_CONFIG_PATH" in
  *"$CI_TMUX_DEPS/utf8proc/lib/pkgconfig"*) ;;
  *) exit 67 ;;
esac
current=$(pwd -P)
printf 'configure\\t%s\\t%s\\t%s\\n' "$current" "$HOME" "$TMPDIR" >> "$CI_TMUX_LOG"
printf '%s\\n' "$prefix" > ci-tmux-prefix
: > Makefile
`),
      writeExecutable(join(bin, "getconf"), "#!/bin/sh\nprintf '2\\n'\n"),
      writeExecutable(join(bin, "make"), `#!/bin/sh
set -eu
[ "$1" = -C ]
source=$2
shift 2
cd "$source"
current=$(pwd -P)
[ "$current" = "$source" ]
[ -f Makefile ]
printf 'make\\t%s\\t%s\\n' "$current" "$1" >> "$CI_TMUX_LOG"
if [ "$1" = install ]; then
  prefix=$(/bin/cat ci-tmux-prefix)
  /bin/mkdir -p "$prefix/bin"
  /bin/cat > "$prefix/bin/tmux" <<'TMUX'
#!/bin/sh
printf 'tmux 3.6a\\n'
TMUX
  /bin/chmod +x "$prefix/bin/tmux"
fi
`),
      writeExecutable(join(bin, "mkdir"), "#!/bin/sh\nexec /bin/mkdir \"$@\"\n"),
      writeExecutable(join(bin, "mktemp"), "#!/bin/sh\nexec /usr/bin/mktemp \"$@\"\n"),
      writeExecutable(join(bin, "rm"), "#!/bin/sh\nexec /bin/rm \"$@\"\n"),
      writeExecutable(join(bin, "shasum"), "#!/bin/sh\nprintf 'fixture\\n'\n"),
      writeExecutable(join(bin, "tar"), `#!/bin/sh
set -eu
destination=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -C) destination=$2; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$destination" ]
source="$destination/tmux-3.6a"
/bin/mkdir -p "$source"
/bin/cp "$CI_TMUX_CONFIGURE" "$source/configure"
/bin/chmod +x "$source/configure"
`),
    ])

    const child = Bun.spawn(["/bin/bash", scriptPath], {
      cwd: caller,
      env: {
        ...process.env,
        CI_TMUX_CONFIGURE: configure,
        CI_TMUX_DEPS: deps,
        CI_TMUX_LOG: log,
        PATH: bin,
        RUNNER_TEMP: runnerTemp,
        TMUX_BIN: fakeTmux,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(code, stderr).toBe(0)
    expect(stdout.trim()).toMatch(/\/tmux-3\.6a-install\.[^/]+\/bin\/tmux$/)

    const records = (await readFile(log, "utf8")).trim().split("\n")
    const configureRecord = records.find((record) => record.startsWith("configure\t"))
    if (!configureRecord) throw new Error(`missing configure cwd record: ${records.join("; ")}`)
    const configureFields = configureRecord.split("\t")
    const configureCwd = configureFields[1]
    if (!configureCwd) throw new Error(`missing configure cwd: ${configureRecord}`)
    const makeCwds = records.filter((record) => record.startsWith("make\t")).map((record) => record.split("\t")[1])
    expect(makeCwds).toEqual([configureCwd, configureCwd])
    expect(configureCwd).toContain("/src/tmux-3.6a")
    expect(configureCwd).not.toBe(await realpath(caller))
    expect(await pathExists(join(caller, "Makefile"))).toBe(false)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})
