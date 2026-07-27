import { createHash } from "node:crypto"
import { join } from "node:path"
import { createInflateRaw } from "node:zlib"
import type { Dependencies } from "./runtime"
import { canonicalPayloadPath, type FsOps } from "./fs"

const inventory = new Map<string, 0o755 | 0o644>([["bin/pane-dash", 0o755], ["pane_dash.tmux", 0o755], ["scripts/open.sh", 0o755], ["scripts/tag.sh", 0o755], ["README.md", 0o644], ["LICENSE", 0o644], ["VERSION", 0o644], ["manifest.json", 0o644]])
const directories = new Map<string, 0o755>([["bin", 0o755], ["scripts", 0o755]])
const text = new TextDecoder("utf-8", { fatal: true })
const MAX_COMPRESSED_BYTES = 64 * 1024 * 1024
const MAX_GZIP_HEADER_BYTES = 64 * 1024
export interface ArchiveLimits { maxEntries: number; maxTotalBytes: number; maxFileBytes: number; timeoutMs: number }
export type InternalManifest = { schemaVersion: 1; product: "tmux-pane-dash"; version: string; target: string; asset: string; files: Array<{ path: string; sha256: string; size: number; mode: "0755" | "0644" }> }

const fail = (reason: string): never => { throw new Error(`E_ARCHIVE_ENTRY: ${reason}`) }
const allZero = (value: Uint8Array) => value.every((byte) => byte === 0)
const crcTable = (() => { const table = new Uint32Array(256); for (let value = 0; value < 256; value += 1) { let crc = value; for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; table[value] = crc >>> 0 } return table })()
const crc32 = (crc: number, bytes: Uint8Array) => { let value = crc; for (const byte of bytes) value = (value >>> 8) ^ crcTable[(value ^ byte) & 0xff]!; return value >>> 0 }
const littleEndian = (bytes: Uint8Array, offset: number) => (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0
function gzipHeaderLength(bytes: Uint8Array): number | undefined {
  if (bytes.length < 10) return undefined
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 8 || (bytes[3]! & 0xe0)) fail("gzip header")
  const flags = bytes[3]!, has = (flag: number) => (flags & flag) !== 0
  let offset = 10
  if (has(4)) { if (bytes.length < offset + 2) return undefined; const length = bytes[offset]! | (bytes[offset + 1]! << 8); offset += 2 + length; if (bytes.length < offset) return undefined }
  for (const flag of [8, 16]) if (has(flag)) { const end = bytes.indexOf(0, offset); if (end < 0) return undefined; offset = end + 1 }
  if (has(2)) { if (bytes.length < offset + 2) return undefined; if (((crc32(0xffffffff, bytes.subarray(0, offset)) ^ 0xffffffff) & 0xffff) !== (bytes[offset]! | (bytes[offset + 1]! << 8))) fail("gzip header"); offset += 2 }
  return offset
}
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
  private inflated = 0
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
      if (fileMode === undefined || mode !== fileMode || size > this.limits.maxFileBytes) fail("file")
      this.current = { path, mode: fileMode, size, remaining: size, padding: Math.ceil(size / 512) * 512 - size, body: [] }
      if (size === 0) { await this.finishFile(); this.current = undefined }
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
    if ((this.inflated += chunk.length) > this.limits.maxTotalBytes) fail("total size")
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
    const inflate = createInflateRaw(), parser = new TarParser(input.stagingRoot, input.fs, input.limits, wait)
    let compressed = 0, header = new Uint8Array(), body = false, finished = false, footer = new Uint8Array(), crc = 0xffffffff, size = 0
    const output = (async () => { for await (const chunk of inflate) { crc = crc32(crc, chunk); size = (size + chunk.length) >>> 0; await parser.push(chunk) } })(); void output.catch(() => undefined)
    const write = async (chunk: Uint8Array) => {
      if (finished) {
        footer = pieces([footer, chunk], footer.length + chunk.length)
        if (footer.length > 8) fail("gzip member")
        return
      }
      const before = inflate.bytesWritten
      await wait(new Promise<void>((resolve, reject) => inflate.write(chunk, (error) => error ? reject(error) : resolve())))
      const consumed = inflate.bytesWritten - before
      if (consumed < chunk.length) {
        footer = chunk.slice(consumed); finished = true
        if (footer.length > 8) fail("gzip member")
      }
    }
    const writer = (async () => {
      try {
        for await (const chunk of input.archive) {
          compressed += chunk.length; if (compressed > MAX_COMPRESSED_BYTES) fail("compressed size")
          if (!body) {
            header = pieces([header, chunk], header.length + chunk.length)
            if (header.length > MAX_GZIP_HEADER_BYTES) fail("gzip header")
            const length = gzipHeaderLength(header)
            if (length === undefined) continue
            body = true; await write(header.slice(length)); header = new Uint8Array()
          } else await write(chunk)
        }
        if (!body || !finished || footer.length !== 8) fail("gzip footer")
        await wait(new Promise<void>((resolve, reject) => inflate.end((error) => error ? reject(error) : resolve())))
      } catch (error) { inflate.destroy(error instanceof Error ? error : new Error("gzip")); throw error }
    })()
    try { await wait(writer); await output; if (((crc ^ 0xffffffff) >>> 0) !== littleEndian(footer, 0) || size !== littleEndian(footer, 4)) fail("gzip footer"); parser.finish() } catch (error) { await output.catch(() => undefined); if (error instanceof Error && error.message.startsWith("E_ARCHIVE_ENTRY")) throw error; fail("gzip") }
  } catch (error) { try { await input.fs.rm(input.stagingRoot) } catch {} if (error instanceof Error && error.message.startsWith("E_ARCHIVE_ENTRY")) throw error; if (error instanceof Error && error.message === "timeout") fail("timeout"); fail("gzip") } finally { clearTimeout(timer) }
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
