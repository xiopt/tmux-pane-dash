import { createHash } from "node:crypto"
import { join } from "node:path"
import { gunzipSync } from "node:zlib"
import type { Dependencies } from "./runtime"
import { canonicalPayloadPath, type FsOps } from "./fs"

const inventory = new Map<string, 0o755 | 0o644>([["bin/pane-dash", 0o755], ["pane_dash.tmux", 0o755], ["scripts/open.sh", 0o755], ["scripts/tag.sh", 0o755], ["README.md", 0o644], ["LICENSE", 0o644], ["VERSION", 0o644], ["manifest.json", 0o644]])
const directories = new Map([["bin", 0o755], ["scripts", 0o755]])
const text = new TextDecoder("utf-8", { fatal: true })
const MAX_COMPRESSED_BYTES = 64 * 1024 * 1024
export interface ArchiveLimits { maxEntries: 64; maxTotalBytes: 268435456; maxFileBytes: 134217728; timeoutMs: 30000 }
export type InternalManifest = { schemaVersion: 1; product: "tmux-pane-dash"; version: string; target: string; asset: string; files: Array<{ path: string; sha256: string; size: number; mode: "0755" | "0644" }> }

const fail = (reason: string): never => { throw new Error(`E_ARCHIVE_ENTRY: ${reason}`) }
const allZero = (value: Uint8Array) => value.every((byte) => byte === 0)
function string(header: Uint8Array, offset: number, length: number): string {
  const value = header.subarray(offset, offset + length), nul = value.indexOf(0)
  if (nul < 0 || value.subarray(nul + 1).some((byte) => byte !== 0)) fail("header field")
  try { return text.decode(value.subarray(0, nul)) } catch { fail("header encoding") }
}
function octal(header: Uint8Array, offset: number, length: number): number {
  const value = string(header, offset, length)
  if (!/^[0-7]+$/.test(value)) fail("number")
  const result = Number.parseInt(value, 8)
  if (!Number.isSafeInteger(result)) fail("number")
  return result
}
function checksum(header: Uint8Array): void {
  const expected = octal(header, 148, 8); let actual = 0
  for (let i = 0; i < 512; i += 1) actual += i >= 148 && i < 156 ? 32 : header[i]
  if (actual !== expected) fail("checksum")
}
async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []; let size = 0
  for await (const chunk of source) { size += chunk.length; if (size > MAX_COMPRESSED_BYTES) fail("compressed size"); chunks.push(chunk) }
  const result = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length }
  return result
}
function inflate(source: Uint8Array): Uint8Array {
  try {
    const result = (gunzipSync as any)(source, { info: true })
    if (!result?.buffer || result.engine?.bytesWritten !== source.length) fail("gzip member")
    return new Uint8Array(result.buffer)
  } catch (error) { if (error instanceof Error && error.message.startsWith("E_ARCHIVE_ENTRY")) throw error; fail("gzip") }
}
function headerIsSafe(header: Uint8Array): void {
  // Release archives carry no identity, time, device, link, prefix, or extension metadata.
  for (const [offset, length] of [[108, 8], [116, 8], [136, 12], [157, 100], [329, 8], [337, 8], [345, 155], [500, 12]] as const) if (!allZero(header.subarray(offset, offset + length))) fail("metadata")
  if (string(header, 257, 6) !== "ustar" || string(header, 263, 2) !== "00") fail("format")
}
async function extract(input: { archive: AsyncIterable<Uint8Array>; stagingRoot: string; fs: FsOps; nowMs: () => number; limits: ArchiveLimits }): Promise<void> {
  const started = input.nowMs(), tar = inflate(await collect(input.archive)); let offset = 0, entries = 0, total = 0
  const seen = new Set<string>()
  while (offset < tar.length) {
    if (input.nowMs() - started > input.limits.timeoutMs) fail("timeout")
    if (offset + 512 > tar.length) fail("truncated header")
    const header = tar.subarray(offset, offset + 512)
    if (allZero(header)) {
      if (offset + 1024 !== tar.length || !allZero(tar.subarray(offset, offset + 1024))) fail("trailing data")
      offset += 1024
      break
    }
    checksum(header); headerIsSafe(header)
    const path = canonicalPayloadPath(string(header, 0, 100)), mode = octal(header, 100, 8), size = octal(header, 124, 12), type = String.fromCharCode(header[156] || 48)
    const fileMode = inventory.get(path), directoryMode = directories.get(path), padded = Math.ceil(size / 512) * 512
    if (++entries > input.limits.maxEntries || seen.has(path) || offset + 512 + padded > tar.length) fail(seen.has(path) ? "duplicate" : "truncated body")
    seen.add(path)
    if (type === "0" || type === "\0") {
      if (fileMode === undefined || mode !== fileMode || size > input.limits.maxFileBytes || (total += size) > input.limits.maxTotalBytes) fail("file")
      await input.fs.writeFileExclusive(input.stagingRoot, path, tar.subarray(offset + 512, offset + 512 + size), fileMode)
    } else if (type !== "5" || directoryMode === undefined || mode !== directoryMode || size !== 0) fail("type")
    offset += 512 + padded
  }
  if (offset !== tar.length || [...inventory.keys()].some((path) => !seen.has(path))) fail("inventory")
}
export async function extractArchive(input: { archive: AsyncIterable<Uint8Array>; stagingRoot: string; fs: FsOps; clock: Pick<Dependencies, "nowMs">; limits: ArchiveLimits }): Promise<void> {
  if (!input.clock.nowMs) fail("clock")
  try { await extract({ ...input, nowMs: input.clock.nowMs }) } catch (error) { await input.fs.rm(input.stagingRoot); throw error }
}
const manifestKeys = ["schemaVersion", "product", "version", "target", "asset", "files"]
function validManifest(value: InternalManifest): void {
  const paths = [...inventory.keys()].filter((path) => path !== "manifest.json").sort((a, b) => Buffer.from(a).compare(Buffer.from(b)))
  if (!value || Object.keys(value).join("\0") !== manifestKeys.join("\0") || value.schemaVersion !== 1 || value.product !== "tmux-pane-dash" || typeof value.version !== "string" || typeof value.target !== "string" || typeof value.asset !== "string" || !Array.isArray(value.files) || value.files.length !== paths.length) fail("manifest")
  for (let index = 0; index < paths.length; index += 1) {
    const item = value.files[index], mode = inventory.get(paths[index])!.toString(8).padStart(4, "0")
    if (!item || Object.keys(item).join("\0") !== "path\0sha256\0size\0mode" || item.path !== paths[index] || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.size) || item.size < 0 || item.mode !== mode) fail("manifest")
  }
}
export async function inspectPayload(root: string, manifest: InternalManifest, deps: Dependencies): Promise<void> {
  validManifest(manifest)
  if (!deps.fs) fail("filesystem")
  const found: string[] = []
  const walk = async (base: string, relative = ""): Promise<void> => {
    for (const name of await deps.fs!.readdir(base)) {
      const child = relative ? `${relative}/${name}` : name, info = await deps.fs!.stat(join(base, name))
      if (info.kind === "directory") await walk(join(base, name), child)
      else found.push(child)
    }
  }
  await walk(root)
  if (found.length !== inventory.size || found.some((path) => !inventory.has(path))) fail("filesystem inventory")
  for (const [path, mode] of inventory) {
    const info = await deps.fs.stat(join(root, path)), content = await deps.fs.readFile(join(root, path))
    if (info.kind !== "file" || (info.mode & 0o777) !== mode || info.size !== content.length) fail("filesystem metadata")
    if (path !== "manifest.json") {
      const item = manifest.files.find((candidate) => candidate.path === path)!
      if (item.size !== content.length || item.sha256 !== createHash("sha256").update(content).digest("hex")) fail("filesystem hash")
    }
  }
}
export async function verifyBinary(path: string, version: string, deps: Dependencies): Promise<void> {
  if (!deps.spawn) throw new Error("E_BINARY_VERSION: unavailable")
  const result = await deps.spawn(path, ["--version"], { timeoutMs: 5000, env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" }, maxOutputBytes: 4096 })
  if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > 4096 || result.code !== 0 || result.stdout !== `${version}\n` || result.stderr !== "") throw new Error("E_BINARY_VERSION: self check failed")
}
