import { expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { setup } from "../src/commands/setup"
import { managedRoot, readOwnership } from "../src/ownership"
import { archiveRecord, releaseArchive, transactionFixture } from "./helpers/fixture"

function manifest() { const asset = archiveRecord(releaseArchive()); return { schemaVersion: 1, repository: "xiopt/tmux-pane-dash", version: "0.1.0", tag: "v0.1.0", assets: { "linux-x64": asset, "linux-arm64": { ...asset, target: "aarch64-unknown-linux-musl", asset: "tmux-pane-dash-v0.1.0-aarch64-unknown-linux-musl.tar.gz", url: "https://github.com/xiopt/tmux-pane-dash/releases/download/v0.1.0/tmux-pane-dash-v0.1.0-aarch64-unknown-linux-musl.tar.gz" }, "darwin-x64": { ...asset, target: "x86_64-apple-darwin", asset: "tmux-pane-dash-v0.1.0-x86_64-apple-darwin.tar.gz", url: "https://github.com/xiopt/tmux-pane-dash/releases/download/v0.1.0/tmux-pane-dash-v0.1.0-x86_64-apple-darwin.tar.gz" }, "darwin-arm64": { ...asset, target: "aarch64-apple-darwin", asset: "tmux-pane-dash-v0.1.0-aarch64-apple-darwin.tar.gz", url: "https://github.com/xiopt/tmux-pane-dash/releases/download/v0.1.0/tmux-pane-dash-v0.1.0-aarch64-apple-darwin.tar.gz" } } } }
async function* body(bytes: Uint8Array) { yield bytes }

test("conflicts are rejected before fetch and leave the tree unchanged", async () => {
  const h = await transactionFixture()
  try {
    await writeFile(join(h.outside, ".tmux.conf"), "set -g @plugin 'xiopt/tmux-pane-dash'\n")
    await expect(setup({ name: "setup", tmux: true, opencode: false, migrate: false, allowDowngrade: false }, { ...h.deps, env: { XDG_DATA_HOME: join(h.outside, "data"), HOME: h.outside }, manifest: manifest() })).rejects.toMatchObject({ code: "E_CONFIG_CONFLICT" })
    expect(h.calls.fetch).toBe(0)
  } finally { await h.cleanup() }
})

test("fresh setup owns both components and equal setup reuses the verified payload", async () => {
  const h = await transactionFixture(), archive = releaseArchive()
  try {
    await mkdir(join(h.outside, ".config", "opencode"), { recursive: true }); await writeFile(join(h.outside, ".config", "opencode", "opencode.json"), "{}\n")
    const deps = { ...h.deps, env: { XDG_DATA_HOME: join(h.outside, "data"), HOME: h.outside }, manifest: manifest(), fetch: async () => { h.calls.fetch += 1; return { status: 200, body: body(archive) } } }
    await setup({ name: "setup", tmux: true, opencode: true, migrate: false, allowDowngrade: false }, deps)
    const ownership = await readOwnership(await managedRoot(deps.env), deps)
    expect(ownership?.components.tmux?.marker).toContain("schema=1")
    expect(ownership?.components.opencode?.packageEntries).toEqual(["@xiopt/pane-dash-opencode@0.1.0"])
    const fetches = h.calls.fetch
    await setup({ name: "setup", tmux: true, opencode: true, migrate: false, allowDowngrade: false }, deps)
    expect(h.calls.fetch).toBe(fetches)
  } finally { await h.cleanup() }
})
