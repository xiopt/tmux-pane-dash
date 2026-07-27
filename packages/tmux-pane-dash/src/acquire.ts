import { createHash } from "node:crypto"
import { join } from "node:path"
import type { ReleaseAssetRecord } from "./contracts"
import { extractArchive, inspectPayload, type ArchiveLimits, type InternalManifest, verifyBinary } from "./archive"
import type { FsOps } from "./fs"
import { CliError } from "./errors"
import type { Dependencies, FetchResponse } from "./runtime"
import { selectTarget } from "./platform"
import { parseReleaseManifest, selectRelease } from "./manifest"

export type AcquireContext = { versionDirectory: string; stagingRoot: string; record: ReleaseAssetRecord; deps: Dependencies; fs?: FsOps; limits?: ArchiveLimits }
const MAX = 64 * 1024 * 1024
const signals = ["HUP", "INT", "TERM"] as const
const emptyHeaders: Record<string, never> = {}
const archiveLimits: ArchiveLimits = { maxEntries: 64, maxTotalBytes: 268435456, maxFileBytes: 134217728, timeoutMs: 30000 }

function fail(code: string): never { throw new CliError(code) }
function code(error: unknown) { return error instanceof CliError ? error.code : error instanceof Error ? error.message.split(":", 1)[0] : "" }
function isMissing(error: unknown) { return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT" }
function isValidatedCorruption(error: unknown) { return isMissing(error) || error instanceof SyntaxError || /^(E_ARCHIVE_ENTRY|E_BINARY_VERSION|E_VERSION)/.test(code(error)) }

function initialUrl(record: ReleaseAssetRecord, tag: string): string {
  let parsed: URL
  try { parsed = new URL(record.url) } catch { fail("E_DOWNLOAD_URL") }
  const expectedPath = `/xiopt/tmux-pane-dash/releases/download/${tag}/${record.asset}`
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || (parsed.port && parsed.port !== "443") || parsed.hostname !== "github.com" || parsed.pathname !== expectedPath || parsed.search || parsed.hash) fail("E_DOWNLOAD_URL")
  const exact = `https://github.com/xiopt/tmux-pane-dash/releases/download/${tag}/${record.asset}`
  const explicit = `https://github.com:443/xiopt/tmux-pane-dash/releases/download/${tag}/${record.asset}`
  if (record.url !== exact && record.url !== explicit) fail("E_DOWNLOAD_URL")
  return record.url
}

function location(response: FetchResponse): string | null {
  if (response.headers instanceof Headers) return response.headers.get("location")
  for (const [name, value] of Object.entries(response.headers ?? {})) if (name.toLowerCase() === "location") return value ?? null
  return null
}

function redirectUrl(value: string | null): string {
  if (!value) fail("E_REDIRECT")
  let parsed: URL
  try { parsed = new URL(value) } catch { fail("E_REDIRECT") }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || (parsed.port && parsed.port !== "443") || parsed.hostname !== "release-assets.githubusercontent.com" || parsed.hash) fail("E_REDIRECT")
  return value
}

async function* responseBody(source: FetchResponse["body"]): AsyncIterable<Uint8Array> {
  if (!source) fail("E_DOWNLOAD_BODY")
  if (Symbol.asyncIterator in Object(source)) { yield* source as AsyncIterable<Uint8Array>; return }
  const reader = (source as ReadableStream<Uint8Array>).getReader()
  try { for (;;) { const part = await reader.read(); if (part.done) return; yield part.value } } finally { reader.releaseLock() }
}

export async function downloadAsset(record: ReleaseAssetRecord, destination: string, deps: Dependencies, tag: string): Promise<void> {
  if (!Number.isSafeInteger(record.size) || record.size < 0 || record.size > MAX) fail("E_ARCHIVE_SIZE")
  if (!deps.fetch) fail("E_DOWNLOAD_FETCH")
  if (!deps.fs) fail("E_DOWNLOAD_FS")
  const controller = new AbortController(), fs = deps.fs
  let rejectAbort!: () => void
  const aborted = new Promise<never>((_, reject) => { rejectAbort = () => reject(new CliError("E_DOWNLOAD_ABORT")) })
  const abort = () => { if (!controller.signal.aborted) { controller.abort(); rejectAbort() } }
  const timers = deps.timers ?? { setTimeout, clearTimeout }
  const activeTimers = new Set<unknown>()
  const arm = (milliseconds: number) => { const handle = timers.setTimeout(abort, milliseconds); activeTimers.add(handle); return handle }
  const clear = (handle: unknown) => { if (activeTimers.delete(handle)) timers.clearTimeout(handle) }
  const signalOps = deps.signals ?? { on: (signal: typeof signals[number], callback: () => void) => process.once(signal, callback), off: (signal: typeof signals[number], callback: () => void) => process.removeListener(signal, callback) }
  const race = <T>(operation: Promise<T>) => Promise.race([operation, aborted])
  let created = false
  const registered: typeof signals[number][] = []
  try {
    arm(120_000)
    for (const signal of signals) { signalOps.on(signal, abort); registered.push(signal) }
    const request = async (url: string) => {
      const responseTimer = arm(30_000)
      try { return await race(deps.fetch!(url, { redirect: "manual", signal: controller.signal, headers: emptyHeaders })) } finally { clear(responseTimer) }
    }
    let response = await request(initialUrl(record, tag))
    for (let redirects = 0; response.status >= 300 && response.status < 400; redirects += 1) {
      if (redirects >= 2) fail("E_REDIRECT")
      response = await request(redirectUrl(location(response)))
    }
    if (response.status < 200 || response.status >= 300) fail("E_DOWNLOAD_STATUS")
    const file = await race(fs.openExclusive(destination, 0o600)); created = true
    const hash = createHash("sha256"); let size = 0; let progress = arm(30_000)
    const iterator = responseBody(response.body)[Symbol.asyncIterator]()
    try {
      for (;;) {
        const next = await race(iterator.next())
        if (next.done) break
        const chunk = next.value
        if (chunk.length) { clear(progress); progress = arm(30_000) }
        size += chunk.length
        if (size > record.size || size > MAX) fail("E_ARCHIVE_SIZE")
        hash.update(chunk)
        await race(fs.write(file, chunk))
      }
    } finally { clear(progress); await race(fs.close(file)) }
    if (size !== record.size || hash.digest("hex") !== record.sha256) fail("E_ARCHIVE_HASH")
  } catch (error) {
    if (created) await fs.rm(destination)
    throw error
  } finally {
    for (const handle of [...activeTimers]) clear(handle)
    for (const signal of registered) signalOps.off(signal, abort)
  }
}

function validateRecord(record: ReleaseAssetRecord, version: string, selected: string): void {
  const expected: Record<string, string> = { "darwin-arm64": "aarch64-apple-darwin", "darwin-x64": "x86_64-apple-darwin", "linux-arm64": "aarch64-unknown-linux-musl", "linux-x64": "x86_64-unknown-linux-musl" }
  if (record.target !== expected[selected] || record.asset !== `tmux-pane-dash-v${version}-${record.target}.tar.gz`) fail("E_PLATFORM")
}

async function validatePayload(root: string, record: ReleaseAssetRecord, version: string, deps: Dependencies, fs: FsOps): Promise<void> {
  const manifest = JSON.parse(new TextDecoder().decode(await fs.readFile(join(root, "manifest.json")))) as InternalManifest
  await inspectPayload(root, manifest, { ...deps, fs })
  if (manifest.version !== version || manifest.target !== record.target || manifest.asset !== record.asset) fail("E_VERSION")
  await verifyBinary(join(root, "bin/pane-dash"), manifest.version, deps)
}

export async function acquireRelease(context: AcquireContext): Promise<{ kind: "reused" | "staged"; versionDirectory: string }> {
  const fs = context.fs ?? context.deps.fs
  if (!fs) fail("E_FILESYSTEM")
  const manifest = parseReleaseManifest(context.deps.manifest), selected = selectTarget(context.deps.platform, context.deps.arch), record = selectRelease(manifest, context.deps.platform, context.deps.arch)
  if (context.record.target !== record.target || context.record.asset !== record.asset || context.record.url !== record.url || context.record.sha256 !== record.sha256 || context.record.size !== record.size) fail("E_PLATFORM")
  validateRecord(record, manifest.version, selected)
  try {
    await validatePayload(context.versionDirectory, record, manifest.version, context.deps, fs)
    return { kind: "reused", versionDirectory: context.versionDirectory }
  } catch (error) { if (!isValidatedCorruption(error)) throw error }
  const archive = `${context.stagingRoot}.download.tar.gz`
  await fs.rm(context.stagingRoot)
  await fs.mkdir(context.stagingRoot)
  try {
    await downloadAsset(record, archive, { ...context.deps, fs }, manifest.tag)
    const bytes = await fs.readFile(archive)
    async function* stream() { yield bytes }
    await extractArchive({ archive: stream(), stagingRoot: context.stagingRoot, fs, clock: { nowMs: context.deps.nowMs ?? Date.now }, limits: context.limits ?? archiveLimits })
    await validatePayload(context.stagingRoot, record, manifest.version, context.deps, fs)
    return { kind: "staged", versionDirectory: context.stagingRoot }
  } catch (error) {
    await fs.rm(context.stagingRoot)
    throw error
  } finally { await fs.rm(archive) }
}
