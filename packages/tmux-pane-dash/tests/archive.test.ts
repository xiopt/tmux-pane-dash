import { expect, test } from "bun:test"
import { gzipSync } from "node:zlib"
import { extractArchive } from "../src/archive"
import { inspectPayload, verifyBinary } from "../src/archive"
import { internalManifest, installedFixture } from "./helpers/fixture"
import { rm } from "node:fs/promises"

const encoder = new TextEncoder()

function octal(value: number, width: number) { return `${value.toString(8).padStart(width - 1, "0")}\0` }
function put(block: Uint8Array, offset: number, value: string) { block.set(encoder.encode(value), offset) }
function entry(path: string, body = new Uint8Array(), mode = "0644", type = "0") {
  const header = new Uint8Array(512)
  put(header, 0, path); put(header, 100, octal(Number.parseInt(mode, 8), 8)); put(header, 124, octal(body.length, 12))
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

test("rejects duplicate, noncanonical, malformed metadata, and cleans the partial root", async () => {
  const limits = { maxEntries: 64, maxTotalBytes: 268435456, maxFileBytes: 134217728, timeoutMs: 30000 } as const
  for (const value of [archive(entry("README.md"), entry("README.md")), archive(entry("scripts//open.sh")), archive(entry("README.md", new Uint8Array(), "0755")), archive(...Array.from({ length: 65 }, () => entry("README.md")))]) {
    let writes = 0, removed = 0
    await expect(extractArchive({ archive: chunks(value), stagingRoot: "/stage", fs: { writeFileExclusive: async () => { writes += 1 }, rm: async () => { removed += 1 } } as never, clock: { nowMs: () => 0 }, limits })).rejects.toThrow()
    expect(removed).toBe(1)
    expect(writes).toBeLessThanOrEqual(1)
  }
})

test("inspects the exact payload schema and constrains binary execution", async () => {
  const h = await installedFixture()
  try {
    await expect(inspectPayload(h.versionDirectory, internalManifest(), h.context.deps)).resolves.toBeUndefined()
    await expect(verifyBinary("/stage/bin/pane-dash", "0.1.0", { ...h.context.deps, spawn: async (_path, args, options) => { expect(args).toEqual(["--version"]); expect(options).toEqual({ timeoutMs: 5000, env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" }, maxOutputBytes: 4096 }); return { code: 0, stdout: "0.1.0\n", stderr: "" } } })).resolves.toBeUndefined()
    await expect(verifyBinary("/stage/bin/pane-dash", "0.1.0", { ...h.context.deps, spawn: async () => ({ code: 0, stdout: "wrong\n", stderr: "" }) })).rejects.toThrow("E_BINARY_VERSION")
  } finally { await rm(h.root, { recursive: true, force: true }) }
})
