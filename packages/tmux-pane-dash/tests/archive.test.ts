import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { gunzipSync, gzipSync } from "node:zlib"
import { extractArchive } from "../src/archive"
import { inspectPayload, verifyBinary } from "../src/archive"
import { internalManifest, installedFixture, payload, releaseArchive } from "./helpers/fixture"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { nodeFsOps } from "../src/fs"

const encoder = new TextEncoder()

function octal(value: number, width: number) { return `${value.toString(8).padStart(width - 1, "0")}\0` }
function put(block: Uint8Array, offset: number, value: string) { block.set(encoder.encode(value), offset) }
function entry(path: string, body = new Uint8Array(), mode = "0644", type = "0") {
  const header = new Uint8Array(512)
  put(header, 0, path); put(header, 100, octal(Number.parseInt(mode, 8), 8)); put(header, 108, octal(0, 8)); put(header, 116, octal(0, 8)); put(header, 124, octal(body.length, 12)); put(header, 136, octal(0, 12))
  header.fill(32, 148, 156); put(header, 156, type); put(header, 257, "ustar\0"); put(header, 263, "00")
  put(header, 148, octal(header.reduce((sum, value) => sum + value, 0), 8))
  const result = new Uint8Array(512 + Math.ceil(body.length / 512) * 512); result.set(header); result.set(body, 512)
  return result
}
function archive(...entries: Uint8Array[]) {
  const tar = new Uint8Array(entries.reduce((size, value) => size + value.length, 1024)); let offset = 0
  for (const value of entries) { tar.set(value, offset); offset += value.length }
  return gzipSync(tar, { mtime: 0 })
}
async function* chunks(value: Uint8Array) { yield value }
const limits = { maxEntries: 64, maxTotalBytes: 268435456, maxFileBytes: 134217728, timeoutMs: 30000 } as const

function largeReleaseArchive() {
  const readme = new Uint8Array(72 * 1024)
  let state = 0x12345678
  for (let index = 0; index < readme.length; index += 1) { state = (state * 1664525 + 1013904223) >>> 0; readme[index] = state >>> 24 }
  const manifest = internalManifest(), readmeFile = manifest.files.find((file) => file.path === "README.md")!
  readmeFile.size = readme.length
  readmeFile.sha256 = createHash("sha256").update(readme).digest("hex")
  const entries = [entry("bin", new Uint8Array(), "0755", "5"), entry("scripts", new Uint8Array(), "0755", "5"), ...[...payload].map(([path, [content, mode]]) => entry(path, path === "README.md" ? readme : encoder.encode(content), mode.toString(8))), entry("manifest.json", encoder.encode(JSON.stringify(manifest)))]
  return { bytes: archive(...entries), manifest }
}

test("rejects hostile ustar paths and unsupported entry types before filesystem writes", async () => {
  for (const [path, type] of [["/absolute", "0"], ["", "0"], [".", "0"], ["a/../b", "0"], ["a\\b", "0"], ["unexpected", "0"], ["bin/pane-dash", "1"], ["bin/pane-dash", "2"], ["bin/pane-dash", "3"], ["bin/pane-dash", "4"], ["bin/pane-dash", "5"], ["bin/pane-dash", "6"], ["bin/pane-dash", "7"], ["PaxHeader", "x"], ["GNU", "g"]] as const) {
    await expect(extractArchive({ archive: chunks(archive(entry(path, new Uint8Array(), "0644", type))), stagingRoot: "/stage", fs: {} as never, clock: { nowMs: () => 0 }, limits: { maxEntries: 64, maxTotalBytes: 268435456, maxFileBytes: 134217728, timeoutMs: 30000 } })).rejects.toThrow()
  }
})

test("rejects malformed gzip and tar structure", async () => {
  const badChecksum = entry("README.md"); badChecksum[148] ^= 1
  for (const value of [new Uint8Array([1, 2, 3]), archive(badChecksum), gzipSync(new Uint8Array(513))]) {
    await expect(extractArchive({ archive: chunks(value), stagingRoot: "/stage", fs: {} as never, clock: { nowMs: () => 0 }, limits: { maxEntries: 64, maxTotalBytes: 268435456, maxFileBytes: 134217728, timeoutMs: 30000 } })).rejects.toThrow()
  }
})

test("accepts a large valid archive delivered in one chunk but rejects an oversized incomplete gzip header", async () => {
  const { bytes, manifest } = largeReleaseArchive(), root = await mkdtemp(join(tmpdir(), "pane-dash-gzip-header-"))
  const incompleteHeader = new Uint8Array(64 * 1024 + 1).fill(0x61)
  incompleteHeader.set([0x1f, 0x8b, 8, 8])
  expect(bytes.length).toBeGreaterThan(64 * 1024)
  try {
    await expect(extractArchive({ archive: chunks(bytes), stagingRoot: root, fs: nodeFsOps(), clock: { nowMs: () => 0 }, limits })).resolves.toBeUndefined()
    await expect(inspectPayload(root, manifest, { fs: nodeFsOps() })).resolves.toBeUndefined()
    await expect(extractArchive({ archive: chunks(incompleteHeader), stagingRoot: "/stage", fs: { rm: async () => undefined } as never, clock: { nowMs: () => 0 }, limits })).rejects.toThrow("E_ARCHIVE_ENTRY: gzip header")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("accepts a single stored-DEFLATE member containing a gzip signature and rejects a real second member", async () => {
  const tar = new Uint8Array(gunzipSync(releaseArchive())), marker = encoder.encode("readme"), index = tar.findIndex((byte, offset) => marker.every((value, part) => tar[offset + part] === value))
  expect(index).toBeGreaterThanOrEqual(0)
  tar.set([0x1f, 0x8b, 0x08], index)
  const member = gzipSync(tar, { level: 0, mtime: 0 }), raw = member.subarray(10, -8)
  expect(raw.some((byte, offset) => byte === 0x1f && raw[offset + 1] === 0x8b && raw[offset + 2] === 0x08)).toBeTrue()
  const root = await mkdtemp(join(tmpdir(), "pane-dash-gzip-")), second = await mkdtemp(join(tmpdir(), "pane-dash-gzip-"))
  try {
    await expect(extractArchive({ archive: chunks(member), stagingRoot: root, fs: nodeFsOps(), clock: { nowMs: () => 0 }, limits })).resolves.toBeUndefined()
    await expect(extractArchive({ archive: chunks(new Uint8Array([...member, ...member])), stagingRoot: second, fs: nodeFsOps(), clock: { nowMs: () => 0 }, limits })).rejects.toThrow("E_ARCHIVE_ENTRY: gzip")
  } finally { await rm(root, { recursive: true, force: true }); await rm(second, { recursive: true, force: true }) }
})

test("accepts a valid gzip footer split across streamed chunks", async () => {
  const value = releaseArchive(), footerStart = value.length - 8
  for (let footerBytes = 1; footerBytes < 8; footerBytes += 1) {
    const root = await mkdtemp(join(tmpdir(), "pane-dash-gzip-footer-"))
    try {
      async function* split() {
        const before = footerStart - (footerBytes + 1)
        yield value.subarray(0, before)
        yield value.subarray(before, footerStart)
        yield value.subarray(footerStart, footerStart + footerBytes)
        yield value.subarray(footerStart + footerBytes)
      }
      await expect(extractArchive({ archive: split(), stagingRoot: root, fs: nodeFsOps(), clock: { nowMs: () => 0 }, limits })).resolves.toBeUndefined()
    } finally { await rm(root, { recursive: true, force: true }) }
  }
})

test("bounds trailing zero blocks by total inflated tar bytes", async () => {
  const tar = gunzipSync(releaseArchive()), value = gzipSync(new Uint8Array([...tar, ...new Uint8Array(512 * 32)]), { mtime: 0 })
  const root = await mkdtemp(join(tmpdir(), "pane-dash-tar-zeros-"))
  try {
    await expect(extractArchive({ archive: chunks(value), stagingRoot: root, fs: nodeFsOps(), clock: { nowMs: () => 0 }, limits: { ...limits, maxTotalBytes: tar.length + 512 } })).rejects.toThrow("E_ARCHIVE_ENTRY")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("rejects duplicate, noncanonical, malformed metadata, and cleans the partial root", async () => {
  const limits = { maxEntries: 64, maxTotalBytes: 268435456, maxFileBytes: 134217728, timeoutMs: 30000 } as const
  for (const [value, maximumWrites] of [[archive(entry("README.md"), entry("README.md")), 1], [archive(entry("scripts//open.sh")), 0], [archive(entry("README.md", new Uint8Array(), "0755")), 0], [archive(...Array.from({ length: 65 }, () => entry("README.md"))), 64]] as const) {
    let writes = 0, removed = 0
    await expect(extractArchive({ archive: chunks(value), stagingRoot: "/stage", fs: { writeFileExclusive: async () => { writes += 1 }, rm: async () => { removed += 1 } } as never, clock: { nowMs: () => 0 }, limits })).rejects.toThrow()
    expect(removed).toBe(1)
    expect(writes).toBeLessThanOrEqual(maximumWrites)
  }
})

test("preserves parser errors when cleanup fails and bounds delayed input and pending writes", async () => {
  const invalid = archive(entry("README.md", new Uint8Array(), "0755"))
  await expect(extractArchive({ archive: chunks(invalid), stagingRoot: "/stage", fs: { rm: async () => { throw new Error("cleanup") } } as never, clock: { nowMs: () => 0 }, limits })).rejects.toThrow("E_ARCHIVE_ENTRY: file")
  async function* delayed() { await new Promise((resolve) => setTimeout(resolve, 20)); yield releaseArchive() }
  await expect(extractArchive({ archive: delayed(), stagingRoot: "/stage", fs: { rm: async () => undefined } as never, clock: { nowMs: () => 0 }, limits: { ...limits, timeoutMs: 1 } })).rejects.toThrow("E_ARCHIVE_ENTRY: timeout")
  const root = await mkdtemp(join(tmpdir(), "pane-dash-write-"))
  try {
    const fs = nodeFsOps(), blocked = { ...fs, writeFileExclusive: async () => await new Promise<void>(() => {}) }
    await expect(Promise.race([extractArchive({ archive: chunks(releaseArchive()), stagingRoot: root, fs: blocked, clock: { nowMs: () => 0 }, limits: { ...limits, timeoutMs: 1 } }), new Promise((_, reject) => setTimeout(() => reject(new Error("did not settle")), 100))])).rejects.toThrow("E_ARCHIVE_ENTRY: timeout")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("inspects the exact payload schema and constrains binary execution", async () => {
  const h = await installedFixture()
  try {
    await expect(inspectPayload(h.versionDirectory, internalManifest(), h.context.deps)).resolves.toBeUndefined()
    await expect(verifyBinary("/stage/bin/pane-dash", "0.1.0", { ...h.context.deps, spawn: async (_path, args, options) => { expect(args).toEqual(["--version"]); expect(options).toEqual({ timeoutMs: 5000, env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" }, maxOutputBytes: 4096 }); return { code: 0, stdout: "pane-dash 0.1.0\n", stderr: "" } } })).resolves.toBeUndefined()
    for (const result of [{ code: 0, stdout: "wrong\n", stderr: "" }, { code: 1, stdout: "pane-dash 0.1.0\n", stderr: "" }, { code: 0, stdout: "pane-dash 0.1.0\n", stderr: "noise" }, { code: 0, stdout: "x".repeat(4097), stderr: "" }]) await expect(verifyBinary("/stage/bin/pane-dash", "0.1.0", { ...h.context.deps, spawn: async () => result })).rejects.toThrow("E_BINARY_VERSION")
  } finally { await rm(h.root, { recursive: true, force: true }) }
})
