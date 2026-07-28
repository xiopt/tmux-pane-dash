import { expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = process.cwd()
const scriptPath = join(root, "scripts/release/ci-tmux.sh")

test("CI tmux helper pins the official 3.6a source and checksum in RUNNER_TEMP", async () => {
  const source = await readFile(scriptPath, "utf8")
  expect(source).toContain("https://github.com/tmux/tmux/releases/download/3.6a/tmux-3.6a.tar.gz")
  expect(source).toContain("b6d8d9c76585db8ef5fa00d4931902fa4b8cbe8166f528f44fc403961a3f3759")
  expect(source).toContain('mktemp -d "$runner_temp/tmux-3.6a.')
  expect(source).toContain('mktemp -d "$runner_temp/tmux-3.6a-install.')
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
