import { createHash } from "node:crypto"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { nodeFsOps, type FsOps } from "../../src/fs"
import type { Dependencies, FetchResponse } from "../../src/runtime"

export const asset = "tmux-pane-dash-v0.1.0-x86_64-unknown-linux-musl.tar.gz"
export const record = { target: "x86_64-unknown-linux-musl", asset, url: `https://github.com/xiopt/tmux-pane-dash/releases/download/v0.1.0/${asset}`, sha256: "", size: 0 }
export const payload = new Map<string, [string, number]>([["bin/pane-dash", ["binary", 0o755]], ["pane_dash.tmux", ["tmux", 0o755]], ["scripts/open.sh", ["open", 0o755]], ["scripts/tag.sh", ["tag", 0o755]], ["README.md", ["readme", 0o644]], ["LICENSE", ["license", 0o644]], ["VERSION", ["0.1.0\n", 0o644]]])
export function internalManifest(version = "0.1.0") { return { asset, files: [...payload].sort(([a], [b]) => Buffer.from(a).compare(Buffer.from(b))).map(([path, [content, mode]]) => ({ mode: mode.toString(8).padStart(4, "0") as "0755" | "0644", path, sha256: createHash("sha256").update(content).digest("hex"), size: Buffer.byteLength(content) })), product: "tmux-pane-dash" as const, schemaVersion: 1 as const, target: record.target, version } }
export function fixtureDependencies(input: { responses?: FetchResponse[]; fault?: string } = {}) {
  const calls = { fetch: 0, child: 0, fs: 0, timer: 0, signal: 0 }; const fs = nodeFsOps(); const fail = (name: string) => { if (input.fault === name) throw new Error(`fault:${name}`) }
  const counted: FsOps = {
    mkdir: async (path) => { calls.fs += 1; fail("fs.mkdir"); return fs.mkdir(path) }, mkdirPayloadDirectory: async (...args) => { calls.fs += 1; fail("fs.mkdirPayloadDirectory"); return fs.mkdirPayloadDirectory(...args) }, readFile: async (path) => { calls.fs += 1; fail("fs.readFile"); return fs.readFile(path) }, writeFileExclusive: async (...args) => { calls.fs += 1; fail("fs.writeFileExclusive"); return fs.writeFileExclusive(...args) }, openExclusive: async (...args) => { calls.fs += 1; fail("fs.openExclusive"); return fs.openExclusive(...args) }, write: async (...args) => { calls.fs += 1; fail("fs.write"); return fs.write(...args) }, close: async (...args) => { calls.fs += 1; fail("fs.close"); return fs.close(...args) }, stat: async (path) => { calls.fs += 1; fail("fs.stat"); return fs.stat(path) }, readdir: async (path) => { calls.fs += 1; fail("fs.readdir"); return fs.readdir(path) }, rm: async (path) => { calls.fs += 1; return fs.rm(path) },
  }
  const deps: Dependencies = { manifest: {}, platform: "linux", arch: "x64", executingVersion: "0.1.0", fs: counted, nowMs: () => 0, fetch: async () => { calls.fetch += 1; fail("fetch"); return input.responses?.shift() ?? { status: 500 } }, spawn: async () => { calls.child += 1; fail("child"); return { code: 0, stdout: "pane-dash 0.1.0\n", stderr: "" } }, timers: { setTimeout: (callback) => { calls.timer += 1; fail("timer"); return callback }, clearTimeout: () => {} }, signals: { on: () => { calls.signal += 1; fail("signal") }, off: () => { calls.signal += 1 } } }
  return { calls, deps, fs: counted }
}
export async function installedFixture(version = "0.1.0") {
  const root = await mkdtemp(join(tmpdir(), "pane-dash-acquire-")), versionDirectory = join(root, version); await mkdir(versionDirectory, { recursive: true })
  for (const [path, [content, mode]] of payload) { const file = join(versionDirectory, path); await mkdir(join(file, ".."), { recursive: true }); await writeFile(file, content, { mode }) }
  await writeFile(join(versionDirectory, "manifest.json"), JSON.stringify(internalManifest(version)), { mode: 0o644 })
  const h = fixtureDependencies()
  return { root, versionDirectory, calls: h.calls, context: { versionDirectory, stagingRoot: join(root, "stage"), record: { ...record }, deps: h.deps, fs: h.fs } }
}
