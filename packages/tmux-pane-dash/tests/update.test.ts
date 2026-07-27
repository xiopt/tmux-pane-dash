import { expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { update } from "../src/commands/update"
import { setup } from "../src/commands/setup"
import { managedRoot, readOwnership } from "../src/ownership"
import { archiveRecord, releaseArchive, transactionFixture } from "./helpers/fixture"

function manifest() { const asset = archiveRecord(releaseArchive()); return { schemaVersion: 1, repository: "xiopt/tmux-pane-dash", version: "0.1.0", tag: "v0.1.0", assets: { "linux-x64": asset, "linux-arm64": { ...asset, target: "aarch64-unknown-linux-musl", asset: "tmux-pane-dash-v0.1.0-aarch64-unknown-linux-musl.tar.gz", url: "https://github.com/xiopt/tmux-pane-dash/releases/download/v0.1.0/tmux-pane-dash-v0.1.0-aarch64-unknown-linux-musl.tar.gz" }, "darwin-x64": { ...asset, target: "x86_64-apple-darwin", asset: "tmux-pane-dash-v0.1.0-x86_64-apple-darwin.tar.gz", url: "https://github.com/xiopt/tmux-pane-dash/releases/download/v0.1.0/tmux-pane-dash-v0.1.0-x86_64-apple-darwin.tar.gz" }, "darwin-arm64": { ...asset, target: "aarch64-apple-darwin", asset: "tmux-pane-dash-v0.1.0-aarch64-apple-darwin.tar.gz", url: "https://github.com/xiopt/tmux-pane-dash/releases/download/v0.1.0/tmux-pane-dash-v0.1.0-aarch64-apple-darwin.tar.gz" } } } }
async function* body(bytes: Uint8Array) { yield bytes }

test("update without ownership is usage and performs no fetch", async () => {
  const h = await transactionFixture()
  try { await expect(update(h.deps)).rejects.toMatchObject({ code: "E_USAGE" }); expect(h.calls.fetch).toBe(0) } finally { await h.cleanup() }
})

test("update replaces only the ownership-proven exact OpenCode package entry", async () => {
  const h = await transactionFixture(), config = join(h.outside, ".config", "opencode", "opencode.json")
  try {
    await mkdir(join(h.outside, ".config", "opencode"), { recursive: true }); await writeFile(config, "{}\n")
    const oldArchive = releaseArchive("0.1.0"), oldDeps = { ...h.deps, env: { XDG_DATA_HOME: join(h.outside, "data"), HOME: h.outside }, manifest: manifest(), fetch: async () => ({ status: 200, body: body(oldArchive) }) }
    await setup({ name: "setup", tmux: false, opencode: true, migrate: false, allowDowngrade: false }, oldDeps)
    const newArchive = releaseArchive("0.1.0"), newDeps = { ...oldDeps, executingVersion: "0.1.1", fetch: async () => ({ status: 200, body: body(newArchive) }) }
    await update(newDeps)
    expect(await readFile(config, "utf8")).toContain("@xiopt/pane-dash-opencode@0.1.1")
    const ownership = await readOwnership(await managedRoot(newDeps.env), newDeps)
    expect(ownership?.currentTarget).toBe("versions/0.1.1")
    expect(ownership?.components.opencode?.packageEntries).toEqual(["@xiopt/pane-dash-opencode@0.1.1"])
  } finally { await h.cleanup() }
})
