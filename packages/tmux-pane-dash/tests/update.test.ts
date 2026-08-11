import { expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { update } from "../src/commands/update"
import { setup } from "../src/commands/setup"
import { managedRoot, readOwnership } from "../src/ownership"
import { archiveRecord, releaseArchive, transactionFixture } from "./helpers/fixture"

function manifest(version: "0.1.2" | "0.1.3") {
  const tag = `v${version}`, name = `tmux-pane-dash-${tag}-x86_64-unknown-linux-musl.tar.gz`, archive = releaseArchive(version, "x86_64-unknown-linux-musl", name)
  const asset = { ...archiveRecord(archive), asset: name, url: `https://github.com/xiopt/tmux-pane-dash/releases/download/${tag}/${name}` }
  const target = (rustTarget: string) => {
    const assetName = `tmux-pane-dash-${tag}-${rustTarget}.tar.gz`
    return { ...asset, target: rustTarget, asset: assetName, url: `https://github.com/xiopt/tmux-pane-dash/releases/download/${tag}/${assetName}` }
  }
  return { schemaVersion: 1, repository: "xiopt/tmux-pane-dash", version, tag, assets: { "linux-x64": asset, "linux-arm64": target("aarch64-unknown-linux-musl"), "darwin-x64": target("x86_64-apple-darwin"), "darwin-arm64": target("aarch64-apple-darwin") } }
}
async function* body(bytes: Uint8Array) { yield bytes }

test("update without ownership is usage and performs no fetch", async () => {
  const h = await transactionFixture()
  try { await expect(update(h.deps)).rejects.toMatchObject({ code: "E_USAGE" }); expect(h.calls.fetch).toBe(0) } finally { await h.cleanup() }
})

test("update replaces only the ownership-proven exact OpenCode package entry", async () => {
  const h = await transactionFixture(), config = join(h.outside, ".config", "opencode", "opencode.json")
  try {
    await mkdir(join(h.outside, ".config", "opencode"), { recursive: true }); await writeFile(config, "{}\n")
    const oldArchive = releaseArchive("0.1.2", "x86_64-unknown-linux-musl", "tmux-pane-dash-v0.1.2-x86_64-unknown-linux-musl.tar.gz"), oldDeps = { ...h.deps, env: { XDG_DATA_HOME: join(h.outside, "data"), HOME: h.outside }, executingVersion: "0.1.2", manifest: manifest("0.1.2"), spawn: async (path: string) => ({ code: 0, stdout: path === "opencode" ? "1.18.15\n" : "pane-dash 0.1.2\n", stderr: "" }), fetch: async () => ({ status: 200, body: body(oldArchive) }) }
    await setup({ name: "setup", tmux: false, opencode: true, migrate: false, allowDowngrade: false }, oldDeps)
    const newArchive = releaseArchive("0.1.3", "x86_64-unknown-linux-musl", "tmux-pane-dash-v0.1.3-x86_64-unknown-linux-musl.tar.gz"), newDeps = { ...oldDeps, executingVersion: "0.1.3", manifest: manifest("0.1.3"), spawn: async (path: string) => ({ code: 0, stdout: path === "opencode" ? "1.18.15\n" : "pane-dash 0.1.3\n", stderr: "" }), fetch: async () => ({ status: 200, body: body(newArchive) }) }
    await update(newDeps)
    expect(await readFile(config, "utf8")).toContain("@xiopt/pane-dash-opencode@0.1.3")
    expect(await readFile(join(h.outside, ".config", "opencode", "tui.json"), "utf8")).toContain("@xiopt/pane-dash-opencode@0.1.3")
    const ownership = await readOwnership(await managedRoot(newDeps.env), newDeps)
    expect(ownership?.currentTarget).toBe("versions/0.1.3")
    expect(ownership?.components.opencode?.packageEntries).toEqual(["@xiopt/pane-dash-opencode@0.1.3"])
    expect(ownership?.components.opencodeTui?.packageEntries).toEqual(["@xiopt/pane-dash-opencode@0.1.3"])
    expect(ownership?.components.opencodeTui?.created).toBeTrue()
  } finally { await h.cleanup() }
})
