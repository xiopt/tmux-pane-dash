import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { gunzipSync, gzipSync } from "node:zlib"
import { ARCHIVE_PAYLOAD, TARGETS, VERSION } from "./contracts"
import { canonicalJson } from "./canonical-json"
import { internalManifest, type RustTarget } from "./manifest"

const encoder = new TextEncoder()
const octal = (value: number, width: number) => `${value.toString(8).padStart(width - 1, "0")}\0`
const bytes = (value: string) => encoder.encode(value)
const write = (block: Uint8Array, offset: number, value: string) => block.set(bytes(value), offset)

function tarEntry(path: string, content: Uint8Array, mode: string, epoch: number, type = "0"): Uint8Array {
  const header = new Uint8Array(512); write(header, 0, path); write(header, 100, octal(Number.parseInt(mode, 8), 8)); write(header, 108, octal(0, 8)); write(header, 116, octal(0, 8)); write(header, 124, octal(content.length, 12)); write(header, 136, octal(epoch, 12)); header.fill(32, 148, 156); write(header, 156, type); write(header, 257, "ustar\0"); write(header, 263, "00")
  const sum = header.reduce((total, byte) => total + byte, 0); write(header, 148, octal(sum, 8))
  const size = 512 + Math.ceil(content.length / 512) * 512; const entry = new Uint8Array(size); entry.set(header); entry.set(content, 512); return entry
}

export async function buildArchive(input: { target: RustTarget; binary: string; output: string; epoch: number; root?: string; version?: string }): Promise<string> {
  const config = Object.values(TARGETS).find((candidate) => candidate.rustTarget === input.target)
  if (!config || !Number.isSafeInteger(input.epoch) || input.epoch < 0) throw new Error("invalid archive input")
  const root = input.root ?? process.cwd(); const staging = await Bun.file(input.binary).arrayBuffer(); const stage = join(dirname(input.output), `.archive-${crypto.randomUUID()}`)
    await mkdir(join(stage, "bin"), { recursive: true, mode: 0o755 }); await mkdir(join(stage, "scripts"), { recursive: true, mode: 0o755 }); await chmod(join(stage, "bin"), 0o755); await chmod(join(stage, "scripts"), 0o755)
  try {
    await writeFile(join(stage, "bin/pane-dash"), new Uint8Array(staging)); await chmod(join(stage, "bin/pane-dash"), 0o755)
    for (const [path, mode] of ARCHIVE_PAYLOAD) if (path !== "bin/pane-dash" && path !== "manifest.json") { await writeFile(join(stage, path), await readFile(join(root, path))); await chmod(join(stage, path), Number.parseInt(mode, 8)) }
    const asset = config.asset.replace(`v${VERSION}`, `v${input.version ?? VERSION}`)
    await writeFile(join(stage, "manifest.json"), canonicalJson(await internalManifest({ target: input.target, asset, root: stage, version: input.version })))
    const paths = ARCHIVE_PAYLOAD.map(([path]) => path).sort((a, b) => Buffer.from(a).compare(Buffer.from(b)))
    const directories = [tarEntry("bin", new Uint8Array(), "0755", input.epoch, "5"), tarEntry("scripts", new Uint8Array(), "0755", input.epoch, "5")]
    const entries = [...directories, ...await Promise.all(paths.map(async (path) => tarEntry(path, await readFile(join(stage, path)), ARCHIVE_PAYLOAD.find(([name]) => name === path)![1], input.epoch)))]
    const tar = new Uint8Array(entries.reduce((total, entry) => total + entry.length, 1024)); let offset = 0; for (const entry of entries) { tar.set(entry, offset); offset += entry.length }
    await writeFile(input.output, gzipSync(tar, { mtime: 0, filename: "" }))
  } finally { await rm(stage, { recursive: true, force: true }) }
  return input.output
}

export async function inspectArchive(path: string, expectedEpoch: number): Promise<Array<[string, "file" | "directory", string]>> {
  if (!Number.isSafeInteger(expectedEpoch) || expectedEpoch < 0) throw new Error("invalid archive epoch")
  const tar = gunzipSync(await readFile(path)); const entries: Array<[string, "file" | "directory", string]> = []
  const field = (header: Uint8Array, offset: number, length: number) => new TextDecoder().decode(header.subarray(offset, offset + length)).replace(/\0.*$/, "").trim()
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512); if (header.every((byte) => byte === 0)) break
    const name = field(header, 0, 100), size = Number.parseInt(field(header, 124, 12), 8), mode = Number.parseInt(field(header, 100, 8), 8), uid = Number.parseInt(field(header, 108, 8), 8), gid = Number.parseInt(field(header, 116, 8), 8), mtime = Number.parseInt(field(header, 136, 12), 8)
    const type = header[156] || 48
    if (type !== 48 && type !== 53) throw new Error("archive entry type is not allowed")
    if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(mode) || !Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || !Number.isSafeInteger(mtime) || mtime < 0 || uid !== 0 || gid !== 0 || field(header, 265, 32) || field(header, 297, 32)) throw new Error("archive header metadata is not normalized")
    if (mtime !== expectedEpoch) throw new Error("archive header epoch does not match tag commit")
    if ((type === 53 && (size !== 0 || !["bin", "scripts"].includes(name))) || (type === 48 && ["bin", "scripts"].includes(name))) throw new Error("archive entry type is invalid")
    entries.push([name, type === 53 ? "directory" : "file", mode.toString(8).padStart(4, "0")]); offset += 512 + Math.ceil(size / 512) * 512
  }
  const expected = new Map([...ARCHIVE_PAYLOAD, ["bin", "0755"], ["scripts", "0755"]] as const); if (entries.length !== expected.size || new Set(entries.map(([name]) => name)).size !== entries.length || entries.some(([name, type, mode]) => expected.get(name) !== mode || (["bin", "scripts"].includes(name)) !== (type === "directory"))) throw new Error("archive inventory is not exact")
  return [["bin", "directory", "0755"], ["scripts", "directory", "0755"], ...ARCHIVE_PAYLOAD.map(([name, mode]) => [name, "file", mode])] as Array<[string, "file" | "directory", string]>
}
