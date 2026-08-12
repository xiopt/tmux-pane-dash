import { expect, test } from "bun:test"
import { lstat, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { doctor } from "../src/commands/doctor"
import { setup } from "../src/commands/setup"
import { uninstall } from "../src/commands/uninstall"
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

test("OpenCode setup rejects unsupported TUI versions before fetch", async () => {
  const h = await transactionFixture()
  try {
    const directory = join(h.outside, ".config", "opencode")
    await mkdir(directory, { recursive: true }); await writeFile(join(directory, "opencode.json"), "{}\n")
    const deps = { ...h.deps, env: { XDG_DATA_HOME: join(h.outside, "data"), HOME: h.outside }, manifest: manifest(), spawn: async () => ({ code: 0, stdout: "1.17.20\n", stderr: "" }) }
    await expect(setup({ name: "setup", tmux: false, opencode: true, migrate: false, allowDowngrade: false }, deps)).rejects.toMatchObject({ code: "E_OPENCODE_VERSION" })
    expect(h.calls.fetch).toBe(0)
  } finally { await h.cleanup() }
})

test("TUI config conflicts are rejected before fetch", async () => {
  const h = await transactionFixture()
  try {
    const directory = join(h.outside, ".config", "opencode")
    await mkdir(directory, { recursive: true }); await writeFile(join(directory, "opencode.json"), "{}\n"); await writeFile(join(directory, "tui.json"), '{"plugin":["custom-pane-dash"]}\n')
    const deps = { ...h.deps, env: { XDG_DATA_HOME: join(h.outside, "data"), HOME: h.outside }, manifest: manifest() }
    await expect(setup({ name: "setup", tmux: false, opencode: true, migrate: false, allowDowngrade: false }, deps)).rejects.toMatchObject({ code: "E_CONFIG_CONFLICT" })
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
    const versionRoot = join(await managedRoot(deps.env), "versions", deps.executingVersion)
    expect(ownership?.components.tmux?.marker).toContain("schema=1")
    expect(ownership?.components.opencode?.packageEntries).toEqual(["@xiopt/pane-dash-opencode@0.1.0"])
    expect(ownership?.components.opencodeTui?.packageEntries).toEqual(["@xiopt/pane-dash-opencode@0.1.0"])
    expect(await readFile(join(h.outside, ".config", "opencode", "tui.json"), "utf8")).toContain("@xiopt/pane-dash-opencode@0.1.0")
    expect(ownership?.files.every(file => file.logicalPath.startsWith(`${versionRoot}/`) && file.resolvedPath.startsWith(`${versionRoot}/`) && !file.logicalPath.includes("/transactions/") && !file.resolvedPath.includes("/transactions/"))).toBeTrue()
    await Promise.all(ownership!.files.flatMap(file => [lstat(file.logicalPath), lstat(file.resolvedPath)]))
    const report = await doctor({ ...deps, doctorFs: { readFile: async path => new Uint8Array(await readFile(path)), stat: async path => {
      const info = await lstat(path)
      return { kind: info.isFile() ? "file" as const : info.isDirectory() ? "directory" as const : info.isSymbolicLink() ? "symlink" as const : "other" as const, mode: info.mode & 0o777, size: info.size, dev: info.dev, ino: info.ino }
    }, readdir, readlink } })
    expect(report.checks.find(check => check.id === "inventory.entries")?.status).toBe("ok")
    expect(report.checks.find(check => check.id === "inventory.metadata")?.status).toBe("ok")
    const fetches = h.calls.fetch
    await setup({ name: "setup", tmux: true, opencode: true, migrate: false, allowDowngrade: false }, deps)
    expect(h.calls.fetch).toBe(fetches)
  } finally { await h.cleanup() }
})

test("setup rejects an OpenCode edit made during acquisition without publishing planned bytes", async () => {
  const h = await transactionFixture(), archive = releaseArchive(), config = join(h.outside, ".config", "opencode", "opencode.json"), edited = '{"plugin":["user/plugin"]}\n'
  try {
    await mkdir(join(h.outside, ".config", "opencode"), { recursive: true }); await writeFile(config, "{}\n")
    const deps = { ...h.deps, env: { XDG_DATA_HOME: join(h.outside, "data"), HOME: h.outside }, manifest: manifest(), fetch: async () => { await writeFile(config, edited); return { status: 200, body: body(archive) } } }
    await expect(setup({ name: "setup", tmux: false, opencode: true, migrate: false, allowDowngrade: false }, deps)).rejects.toMatchObject({ code: "E_RECOVERY" })
    expect(await readFile(config, "utf8")).toBe(edited)
    expect(await Bun.file(join(await managedRoot(deps.env), "current")).exists()).toBeFalse()
  } finally { await h.cleanup() }
})

test("setup rejects a swapped OpenCode symlink chain during acquisition", async () => {
  const h = await transactionFixture(), archive = releaseArchive(), directory = join(h.outside, ".config", "opencode"), config = join(directory, "opencode.json"), original = join(directory, "original.json"), replacement = join(directory, "replacement.json"), edited = '{"plugin":["user/plugin"]}\n'
  try {
    await mkdir(directory, { recursive: true }); await writeFile(original, "{}\n"); await writeFile(replacement, edited); await symlink("original.json", config)
    const deps = { ...h.deps, env: { XDG_DATA_HOME: join(h.outside, "data"), HOME: h.outside }, manifest: manifest(), fetch: async () => { await rm(config); await symlink("replacement.json", config); return { status: 200, body: body(archive) } } }
    await expect(setup({ name: "setup", tmux: false, opencode: true, migrate: false, allowDowngrade: false }, deps)).rejects.toMatchObject({ code: "E_RECOVERY" })
    expect(await readlink(config)).toBe("replacement.json")
    expect(await readFile(replacement, "utf8")).toBe(edited)
    expect(await Bun.file(join(await managedRoot(deps.env), "current")).exists()).toBeFalse()
  } finally { await h.cleanup() }
})

test("disabled setup preserves ownership and config for the omitted component", async () => {
  const h = await transactionFixture(), archive = releaseArchive(), config = join(h.outside, ".config", "opencode", "opencode.json")
  try {
    await mkdir(join(h.outside, ".config", "opencode"), { recursive: true }); await writeFile(config, "{}\n")
    const deps = { ...h.deps, env: { XDG_DATA_HOME: join(h.outside, "data"), HOME: h.outside }, manifest: manifest(), fetch: async () => ({ status: 200, body: body(archive) }) }
    await setup({ name: "setup", tmux: true, opencode: true, migrate: false, allowDowngrade: false }, deps)
    const before = await readFile(config, "utf8")
    await setup({ name: "setup", tmux: true, opencode: false, migrate: false, allowDowngrade: false }, deps)
    expect(await readFile(config, "utf8")).toBe(before)
    expect((await readOwnership(await managedRoot(deps.env), deps))?.components.opencode).not.toBeNull()
    await uninstall(deps)
    expect(await readFile(config, "utf8")).not.toContain("@xiopt/pane-dash-opencode")
    expect(await Bun.file(join(h.outside, ".config", "opencode", "tui.json")).exists()).toBeFalse()
    expect(await readFile(join(h.outside, ".tmux.conf"), "utf8")).not.toContain("tmux-pane-dash (@xiopt/tmux-pane-dash)")
  } finally { await h.cleanup() }
})

test("setup --no-tmux preserves prior tmux ownership and config", async () => {
  const h = await transactionFixture(), archive = releaseArchive(), config = join(h.outside, ".config", "opencode", "opencode.json"), tmux = join(h.outside, ".tmux.conf")
  try {
    await mkdir(join(h.outside, ".config", "opencode"), { recursive: true }); await writeFile(config, "{}\n")
    const deps = { ...h.deps, env: { XDG_DATA_HOME: join(h.outside, "data"), HOME: h.outside }, manifest: manifest(), fetch: async () => ({ status: 200, body: body(archive) }) }
    await setup({ name: "setup", tmux: true, opencode: true, migrate: false, allowDowngrade: false }, deps)
    const before = await readFile(tmux, "utf8")
    await setup({ name: "setup", tmux: false, opencode: true, migrate: false, allowDowngrade: false }, deps)
    expect(await readFile(tmux, "utf8")).toBe(before)
    expect((await readOwnership(await managedRoot(deps.env), deps))?.components.tmux).not.toBeNull()
  } finally { await h.cleanup() }
})
