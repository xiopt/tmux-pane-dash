import { createHash } from "node:crypto"
import { gzipSync } from "node:zlib"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { nodeFsOps, type FsOps } from "../../src/fs"
import type { Dependencies, FetchResponse } from "../../src/runtime"

export const asset = "tmux-pane-dash-v0.1.0-x86_64-unknown-linux-musl.tar.gz"
export const record = { target: "x86_64-unknown-linux-musl", asset, url: `https://github.com/xiopt/tmux-pane-dash/releases/download/v0.1.0/${asset}`, sha256: "", size: 0 }
export const payload = new Map<string, [string, number]>([["bin/pane-dash", ["binary", 0o755]], ["pane_dash.tmux", ["tmux", 0o755]], ["scripts/open.sh", ["open", 0o755]], ["scripts/tag.sh", ["tag", 0o755]], ["README.md", ["readme", 0o644]], ["LICENSE", ["license", 0o644]], ["VERSION", ["0.1.0\n", 0o644]]])
export type Operation = { name: string; args: readonly unknown[] }
export type Fault = { name: string; nth?: number }

export function internalManifest(version = "0.1.0", target = record.target, name = asset) { return { asset: name, files: [...payload].sort(([a], [b]) => Buffer.from(a).compare(Buffer.from(b))).map(([path, [content, mode]]) => ({ mode: mode.toString(8).padStart(4, "0") as "0755" | "0644", path, sha256: createHash("sha256").update(content).digest("hex"), size: Buffer.byteLength(content) })), product: "tmux-pane-dash" as const, schemaVersion: 1 as const, target, version } }

export function fixtureDependencies(input: { responses?: FetchResponse[]; fault?: Fault; timers?: { setTimeout(callback: () => void, milliseconds: number): unknown; clearTimeout(timer: unknown): void }; signals?: Dependencies["signals"] } = {}) {
  const calls = { fetch: 0, child: 0, fs: 0, timer: 0, signal: 0 }, operations: Operation[] = [], occurrences = new Map<string, number>(), base = nodeFsOps()
  const call = (name: string, ...args: unknown[]) => {
    operations.push({ name, args }); const nth = (occurrences.get(name) ?? 0) + 1; occurrences.set(name, nth)
    if (input.fault?.name === name && (input.fault.nth ?? 1) === nth) throw new Error(`fault:${name}:${nth}`)
  }
  const wrap = <K extends keyof FsOps>(name: K) => async (...args: Parameters<FsOps[K]>) => { calls.fs += 1; call(`fs.${name}`, ...args); return (base[name] as (...values: Parameters<FsOps[K]>) => ReturnType<FsOps[K]>)(...args) }
  const fs: FsOps = { mkdir: wrap("mkdir"), mkdirPayloadDirectory: wrap("mkdirPayloadDirectory"), readFile: wrap("readFile"), writeFileExclusive: wrap("writeFileExclusive"), openExclusive: wrap("openExclusive"), write: wrap("write"), close: wrap("close"), stat: wrap("stat"), readdir: wrap("readdir"), rm: wrap("rm") }
  const deps: Dependencies = {
    manifest: {}, platform: "linux", arch: "x64", executingVersion: "0.1.0", fs, nowMs: () => 0,
    fetch: async (url, init) => { calls.fetch += 1; call("fetch", url, init); return input.responses?.shift() ?? { status: 500 } },
    spawn: async (path, args, options) => { calls.child += 1; call("spawn", path, args, options); return { code: 0, stdout: "pane-dash 0.1.0\n", stderr: "" } },
    timers: input.timers ?? { setTimeout: (callback, milliseconds) => { calls.timer += 1; call("timer.setTimeout", milliseconds); return callback }, clearTimeout: (timer) => { call("timer.clearTimeout", timer) } },
    signals: input.signals ?? { on: (signal, callback) => { calls.signal += 1; call("signal.on", signal, callback) }, off: (signal, callback) => { calls.signal += 1; call("signal.off", signal, callback) } },
  }
  return { calls, deps, fs, operations }
}

const encoder = new TextEncoder()
function octal(value: number, width: number) { return `${value.toString(8).padStart(width - 1, "0")}\0` }
function put(block: Uint8Array, offset: number, value: string) { block.set(encoder.encode(value), offset) }
function tarEntry(path: string, bytes: Uint8Array, mode: number, type = "0") { const header = new Uint8Array(512); put(header, 0, path); put(header, 100, octal(mode, 8)); put(header, 108, octal(0, 8)); put(header, 116, octal(0, 8)); put(header, 124, octal(bytes.length, 12)); put(header, 136, octal(0, 12)); header.fill(32, 148, 156); put(header, 156, type); put(header, 257, "ustar\0"); put(header, 263, "00"); put(header, 148, octal(header.reduce((sum, value) => sum + value, 0), 8)); const entry = new Uint8Array(512 + Math.ceil(bytes.length / 512) * 512); entry.set(header); entry.set(bytes, 512); return entry }

/** A real deterministic gzip/ustar asset accepted by the production parser. */
export function releaseArchive(version = "0.1.0", target = record.target, name = asset) {
  const entries = [tarEntry("bin", new Uint8Array(), 0o755, "5"), tarEntry("scripts", new Uint8Array(), 0o755, "5"), ...[...payload].map(([path, [content, mode]]) => tarEntry(path, encoder.encode(content), mode)), tarEntry("manifest.json", encoder.encode(JSON.stringify(internalManifest(version, target, name))), 0o644)]
  const length = entries.reduce((total, entry) => total + entry.length, 1024), tar = new Uint8Array(length); let offset = 0
  for (const entry of entries) { tar.set(entry, offset); offset += entry.length }
  return gzipSync(tar, { mtime: 0 })
}

export function archiveRecord(bytes = releaseArchive()) { return { ...record, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } }
export async function installedFixture(version = "0.1.0") {
  const root = await mkdtemp(join(tmpdir(), "pane-dash-acquire-")), versionDirectory = join(root, version); await mkdir(versionDirectory, { recursive: true })
  for (const [path, [content, mode]] of payload) { const file = join(versionDirectory, path); await mkdir(join(file, ".."), { recursive: true }); await writeFile(file, content, { mode }) }
  await writeFile(join(versionDirectory, "manifest.json"), JSON.stringify(internalManifest(version)), { mode: 0o644 })
  const h = fixtureDependencies()
  return { root, versionDirectory, calls: h.calls, operations: h.operations, context: { versionDirectory, stagingRoot: join(root, "stage"), record: { ...record }, deps: h.deps, fs: h.fs } }
}
