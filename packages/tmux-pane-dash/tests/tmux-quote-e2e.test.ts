import { expect, test } from "bun:test"
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { managedTmuxBlock, shellQuote } from "../src/config-tmux"

const tmux = process.env.TMUX_BIN

test("real tmux retains literal logical current routes and does not evaluate hostile roots", async () => {
  expect(tmux).toMatch(/^\//)
  const parent = await mkdtemp(join(tmpdir(), "pane-dash-tmux ")), root = join(parent, "a'b ☃ $d;`tick` $(touch sentinel)"), socket = `pd-${process.pid}-${Date.now()}`, sentinel = join(parent, "sentinel")
  try {
    const payload = join(root, "versions", "0.1.0"); await mkdir(join(payload, "scripts"), { recursive: true }); await mkdir(join(payload, "bin"), { recursive: true }); await symlink("versions/0.1.0", join(root, "current"))
    const dashboard = `${shellQuote(`${root}/current/scripts/open.sh`)} ${shellQuote(`${root}/current/bin/pane-dash`)}`
    const pane = `#!/bin/sh\nd=$(dirname "$0")\nprintf ran > "$d/ran"\n${shellQuote(tmux!)} -L ${shellQuote(socket)} bind-key -T root D run-shell "$(cat "$d/dashboard")" >"$d/out" 2>&1\nprintf '%s' "$?" > "$d/status"\n`
    await writeFile(join(payload, "pane_dash.tmux"), pane, { mode: 0o700 }); await chmod(join(payload, "pane_dash.tmux"), 0o700)
    await writeFile(join(payload, "dashboard"), dashboard)
    await writeFile(join(payload, "scripts", "open.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o700 }); await writeFile(join(payload, "bin", "pane-dash"), "#!/bin/sh\nexit 0\n", { mode: 0o700 })
    const config = join(parent, "tmux.conf"); await writeFile(config, managedTmuxBlock(root))
    const started = await Bun.$`${tmux} -L ${socket} new-session -d -s quote-e2e`.quiet(); expect(started.exitCode).toBe(0)
    const sourced = await Bun.$`${tmux} -L ${socket} source-file ${config}`.quiet(); expect(sourced.exitCode).toBe(0)
    await Bun.sleep(100)
    const binding = await Bun.$`${tmux} -L ${socket} list-keys -T root`.text()
    expect(await Bun.file(sentinel).exists()).toBeFalse()
    expect(await Bun.file(join(payload, "ran")).exists()).toBeTrue()
    expect(await Bun.file(join(payload, "status")).text()).toBe("0")
    expect(binding).toContain("current/scripts/open.sh")
    expect(binding).toContain("current/bin/pane-dash")
    expect(await readFile(config, "utf8")).toContain("current/pane_dash.tmux")
    console.log("literal-current-route=PASS command-substitution=NOT-EXECUTED")
  } finally { await Bun.$`${tmux} -L ${socket} kill-server`.quiet().catch(() => undefined); await rm(parent, { recursive: true, force: true }) }
})
