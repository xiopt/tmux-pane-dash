import { createHash } from "node:crypto"
import { join } from "node:path"
import { createGunzip } from "node:zlib"
import type { Dependencies } from "./runtime"
import { canonicalPayloadPath, type FsOps } from "./fs"

const inventory = new Map<string, 0o755 | 0o644>([["bin/pane-dash", 0o755], ["pane_dash.tmux", 0o755], ["scripts/open.sh", 0o755], ["scripts/tag.sh", 0o755], ["README.md", 0o644], ["LICENSE", 0o644], ["VERSION", 0o644], ["manifest.json", 0o644]])
const directories = new Map<string, 0o755>([["bin", 0o755], ["scripts", 0o755]])
const text = new TextDecoder("utf-8", { fatal: true })
const MAX_COMPRESSED_BYTES = 64 * 1024 * 1024
export interface ArchiveLimits { maxEntries: number; maxTotalBytes: number; maxFileBytes: number; timeoutMs: number }
export type InternalManifest = { schemaVersion: 1; product: "tmux-pane-dash"; version: string; target: string; asset: string; files: Array<{ path: string; sha256: string; size: number; mode: "0755" | "0644" }> }

const fail = (reason: string): never => { throw new Error(`E_ARCHIVE_ENTRY: ${reason}`) }
const allZero = (value: Uint8Array) => value.every((byte) => byte === 0)
function field(header: Uint8Array, offset: number, length: number): string {
  const value = header.subarray(offset, offset + length), nul = value.indexOf(0)
  if (nul < 0 || value.subarray(nul + 1).some((byte) => byte !== 0)) fail("header field")
  try { return text.decode(value.subarray(0, nul)) } catch { return fail("header encoding") }
}
function octal(header: Uint8Array, offset: number, length: number): number {
  const value = field(header, offset, length)
  if (!/^[0-7]+$/.test(value)) fail("number")
  const result = Number.parseInt(value, 8)
  if (!Number.isSafeInteger(result)) fail("number")
  return result
}
function checksum(header: Uint8Array): void {
  const expected = octal(header, 148, 8); let actual = 0
  for (let index = 0; index < 512; index += 1) actual += index >= 148 && index < 156 ? 32 : header[index]
  if (actual !== expected) fail("checksum")
}
function headerIsSafe(header: Uint8Array): void {
  // Producer metadata is accepted only as normalized octal and is intentionally ignored.
  octal(header, 108, 8); octal(header, 116, 8); octal(header, 136, 12)
  for (const [offset, length] of [[157, 100], [265, 32], [297, 32], [329, 8], [337, 8], [345, 155], [500, 12]] as const) if (!allZero(header.subarray(offset, offset + length))) fail("metadata")
  if (field(header, 257, 6) !== "ustar" || text.decode(header.subarray(263, 265)) !== "00") fail("format")
}
const pieces = (chunks: Uint8Array[], length: number) => { const result = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length }; return result }

class TarParser {
  private pending = new Uint8Array()
  private entries = 0
  private total = 0
  private seen = new Set<string>()
  private ended = false
  private zeroBlocks = 0
  private current?: { path: string; mode: 0o755 | 0o644; size: number; remaining: number; padding: number; body: Uint8Array[] }
  constructor(private readonly root: string, private readonly fs: FsOps, private readonly limits: ArchiveLimits, private readonly wait: <T>(promise: Promise<T>) => Promise<T>) {}
  private async header(header: Uint8Array) {
    if (this.ended) { if (!allZero(header)) fail("trailing data"); this.zeroBlocks += 1; return }
    if (allZero(header)) { this.ended = true; this.zeroBlocks = 1; return }
    checksum(header); headerIsSafe(header)
    let path: string
    try { path = canonicalPayloadPath(field(header, 0, 100)) } catch { fail("path") }
    const mode = octal(header, 100, 8), size = octal(header, 124, 12), type = String.fromCharCode(header[156] || 48)
    if (++this.entries > this.limits.maxEntries) fail("entries")
    if (this.seen.has(path)) fail("duplicate")
    this.seen.add(path)
    const fileMode = inventory.get(path), directoryMode = directories.get(path)
    if (type === "0" || type === "\0") {
      if (fileMode === undefined || mode !== fileMode || size > this.limits.maxFileBytes || (this.total += size) > this.limits.maxTotalBytes) fail("file")
      this.current = { path, mode: fileMode, size, remaining: size, padding: Math.ceil(size / 512) * 512 - size, body: [] }
      if (size === 0) await this.finishFile()
    } else if (type === "5") {
      if (directoryMode === undefined || mode !== directoryMode || size !== 0) fail("type")
      await this.wait(this.fs.mkdirPayloadDirectory(this.root, path, directoryMode))
    } else fail("type")
  }
  private async finishFile() {
    const current = this.current!
    await this.wait(this.fs.writeFileExclusive(this.root, current.path, pieces(current.body, current.size), current.mode))
  }
  async push(chunk: Uint8Array) {
    this.pending = this.pending.length ? pieces([this.pending, chunk], this.pending.length + chunk.length) : chunk
    for (;;) {
      if (this.current) {
        const current = this.current
        if (current.remaining) {
          if (!this.pending.length) return
          const take = Math.min(current.remaining, this.pending.length); current.body.push(this.pending.slice(0, take)); this.pending = this.pending.slice(take); current.remaining -= take
          if (current.remaining) return
        }
        if (current.padding) {
          if (this.pending.length < current.padding) return
          if (!allZero(this.pending.subarray(0, current.padding))) fail("padding")
          this.pending = this.pending.slice(current.padding); current.padding = 0
        }
        await this.finishFile(); this.current = undefined; continue
      }
      if (this.pending.length < 512) return
      const header = this.pending.slice(0, 512); this.pending = this.pending.slice(512)
      await this.header(header)
    }
  }
  finish() {
    if (this.current || this.pending.length) fail(this.current ? "truncated body" : "truncated header")
    if (!this.ended || this.zeroBlocks < 2) fail("terminal zeros")
    if ([...inventory.keys(), ...directories.keys()].some((path) => !this.seen.has(path))) fail("inventory")
  }
}

export async function extractArchive(input: { archive: AsyncIterable<Uint8Array>; stagingRoot: string; fs: FsOps; clock: Pick<Dependencies, "nowMs">; limits: ArchiveLimits }): Promise<void> {
  if (!input.clock.nowMs) fail("clock")
  const started = input.clock.nowMs(), deadline = started + input.limits.timeoutMs
  let rejectDeadline!: (error: Error) => void
  const expired = new Promise<never>((_, reject) => { rejectDeadline = reject })
  const timer = setTimeout(() => rejectDeadline(new Error("timeout")), input.limits.timeoutMs)
  const wait = async <T>(promise: Promise<T>) => {
    try { const result = await Promise.race([promise, expired]); if (input.clock.nowMs() > deadline) fail("timeout"); return result } catch (error) { if (error instanceof Error && error.message === "timeout") fail("timeout"); throw error }
  }
  try {
    const gunzip = createGunzip(), parser = new TarParser(input.stagingRoot, input.fs, input.limits, wait)
    let compressed = 0, prior = new Uint8Array(), gzipHeaders = 0
    const writer = (async () => {
      try {
        for await (const chunk of input.archive) {
          compressed += chunk.length; if (compressed > MAX_COMPRESSED_BYTES) fail("compressed size")
          const bytes = pieces([prior, chunk], prior.length + chunk.length)
          for (let index = 0; index + 2 < bytes.length; index += 1) if (bytes[index] === 0x1f && bytes[index + 1] === 0x8b && bytes[index + 2] === 8 && ++gzipHeaders > 1) fail("gzip member")
          prior = bytes.slice(Math.max(0, bytes.length - 2))
          await wait(new Promise<void>((resolve, reject) => gunzip.write(chunk, (error) => error ? reject(error) : resolve())))
        }
        if (!gunzip.destroyed) await wait(new Promise<void>((resolve, reject) => gunzip.end((error) => error ? reject(error) : resolve())))
      } catch (error) { gunzip.destroy(error instanceof Error ? error : new Error("gzip")); throw error }
    })()
    try { for await (const chunk of gunzip) await parser.push(chunk) } catch (error) { if (error instanceof Error && error.message.startsWith("E_ARCHIVE_ENTRY")) throw error; fail("gzip") }
    await wait(writer); parser.finish()
  } catch (error) { await input.fs.rm(input.stagingRoot); if (error instanceof Error && error.message.startsWith("E_ARCHIVE_ENTRY")) throw error; if (error instanceof Error && error.message === "timeout") fail("timeout"); fail("gzip") } finally { clearTimeout(timer) }
}

const manifestKeys = ["asset", "files", "product", "schemaVersion", "target", "version"]
function validManifest(value: InternalManifest): void {
  const paths = [...inventory.keys()].filter((path) => path !== "manifest.json").sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
  if (!value || Object.keys(value).join("\0") !== manifestKeys.join("\0") || value.schemaVersion !== 1 || value.product !== "tmux-pane-dash" || typeof value.version !== "string" || typeof value.target !== "string" || typeof value.asset !== "string" || !Array.isArray(value.files) || value.files.length !== paths.length) fail("manifest")
  for (let index = 0; index < paths.length; index += 1) { const item = value.files[index], mode = inventory.get(paths[index])!.toString(8).padStart(4, "0"); if (!item || Object.keys(item).join("\0") !== "mode\0path\0sha256\0size" || item.path !== paths[index] || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.size) || item.size < 0 || item.mode !== mode) fail("manifest") }
}
export async function inspectPayload(root: string, manifest: InternalManifest, deps: Dependencies): Promise<void> {
  validManifest(manifest); if (!deps.fs) fail("filesystem")
  const found: Array<[string, string, number]> = []
  const walk = async (base: string, relative = ""): Promise<void> => { for (const name of await deps.fs!.readdir(base)) { const child = relative ? `${relative}/${name}` : name, info = await deps.fs!.stat(join(base, name)); found.push([child, info.kind, info.mode]); if (info.kind === "directory") await walk(join(base, name), child) } }
  await walk(root)
  if (found.length !== inventory.size + directories.size || found.some(([path, kind, mode]) => inventory.has(path) ? kind !== "file" || mode !== inventory.get(path) : directories.has(path) ? kind !== "directory" || mode !== directories.get(path) : true)) fail("filesystem inventory")
  for (const [path, mode] of inventory) { const info = await deps.fs.stat(join(root, path)), content = await deps.fs.readFile(join(root, path)); if (info.kind !== "file" || info.mode !== mode || info.size !== content.length) fail("filesystem metadata"); if (path !== "manifest.json") { const item = manifest.files.find((candidate) => candidate.path === path)!; if (item.size !== content.length || item.sha256 !== createHash("sha256").update(content).digest("hex")) fail("filesystem hash") } }
}
export async function verifyBinary(path: string, version: string, deps: Dependencies): Promise<void> {
  if (!deps.spawn) throw new Error("E_BINARY_VERSION: unavailable")
  const result = await deps.spawn(path, ["--version"], { timeoutMs: 5000, env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" }, maxOutputBytes: 4096 })
  if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > 4096 || result.code !== 0 || result.stdout !== `pane-dash ${version}\n` || result.stderr !== "") throw new Error("E_BINARY_VERSION: self check failed")
}
