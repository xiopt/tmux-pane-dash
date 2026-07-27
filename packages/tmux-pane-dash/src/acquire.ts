import { createHash } from "node:crypto"
import { open, rm } from "node:fs/promises"
import { join } from "node:path"
import type { ReleaseAssetRecord } from "./contracts"
import { extractArchive, inspectPayload, type ArchiveLimits, type InternalManifest, verifyBinary } from "./archive"
import { nodeFsOps, type FsOps } from "./fs"
import type { Dependencies, FetchResponse } from "./runtime"
import { selectTarget } from "./platform"

type SecureDependencies = Dependencies & { fetch: NonNullable<Dependencies["fetch"]> }
export type AcquireContext = { versionDirectory: string; stagingRoot: string; record: ReleaseAssetRecord; deps: Dependencies; fs?: FsOps; limits?: ArchiveLimits }
const MAX = 64 * 1024 * 1024
const noSecrets: Record<string, never> = {}
const fail = (code: string): never => { throw new Error(code) }
function header(response: FetchResponse, name: string) { return response.headers instanceof Headers ? response.headers.get(name) : response.headers?.[name] ?? response.headers?.[name.toLowerCase()] ?? null }
function initial(record: ReleaseAssetRecord) { const url = new URL(record.url), expected = `/xiopt/tmux-pane-dash/releases/download/v0.1.0/${record.asset}`; if (url.href !== record.url || url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || url.hostname !== "github.com" || url.pathname !== expected || url.search || url.hash) fail("E_DOWNLOAD_URL"); return url }
function redirect(location: string | null) { if (!location) fail("E_REDIRECT"); let url: URL; try { url = new URL(location) } catch { fail("E_REDIRECT") }; if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || url.hostname !== "release-assets.githubusercontent.com" || url.hash) fail("E_REDIRECT"); return url }
async function* body(source: FetchResponse["body"]): AsyncIterable<Uint8Array> { if (!source) fail("E_DOWNLOAD_BODY"); if (Symbol.asyncIterator in Object(source)) { yield* source as AsyncIterable<Uint8Array>; return }; const reader = (source as ReadableStream<Uint8Array>).getReader(); try { for (;;) { const next = await reader.read(); if (next.done) break; yield next.value } } finally { reader.releaseLock() } }
export async function downloadAsset(record: ReleaseAssetRecord, destination: string, deps: Dependencies): Promise<void> {
  if (!Number.isSafeInteger(record.size) || record.size < 0 || record.size > MAX) fail("E_ARCHIVE_SIZE")
  const secure = deps as SecureDependencies, controller = new AbortController(), timerOps = deps.timers ?? { setTimeout, clearTimeout }, timers = new Set<unknown>(), cancel = () => controller.abort()
  const timer = (ms: number) => { const id = timerOps.setTimeout(cancel, ms); timers.add(id); return id }; timer(120_000)
  const signals = deps.signals ?? { on: (signal: "HUP" | "INT" | "TERM", callback: () => void) => process.once(signal, callback), off: (signal: "HUP" | "INT" | "TERM", callback: () => void) => process.removeListener(signal, callback) }; for (const signal of ["HUP", "INT", "TERM"] as const) signals.on(signal, cancel)
  try {
    const request = async (url: URL) => { const responseTimer = timer(30_000); try { return await secure.fetch(url.href, { redirect: "manual", signal: controller.signal, headers: noSecrets }) } finally { timerOps.clearTimeout(responseTimer); timers.delete(responseTimer) } }
    let url = initial(record), response = await request(url)
    for (let count = 0; response.status >= 300 && response.status < 400; count += 1) { if (count >= 2) fail("E_REDIRECT"); url = redirect(header(response, "location")); response = await request(url) }
    if (response.status < 200 || response.status >= 300) fail("E_DOWNLOAD_STATUS")
    const file = await open(destination, "wx", 0o600); const hash = createHash("sha256"); let count = 0, progress = timer(30_000)
    try { for await (const chunk of body(response.body)) { timerOps.clearTimeout(progress); timers.delete(progress); progress = timer(30_000); count += chunk.length; if (count > record.size || count > MAX) fail("E_ARCHIVE_SIZE"); hash.update(chunk); await file.write(chunk) } } finally { timerOps.clearTimeout(progress); timers.delete(progress); await file.close() }
    if (count !== record.size || hash.digest("hex") !== record.sha256) fail("E_ARCHIVE_HASH")
  } catch (error) { await rm(destination, { force: true }); throw error } finally { for (const id of timers) timerOps.clearTimeout(id); for (const signal of ["HUP", "INT", "TERM"] as const) signals.off(signal, cancel) }
}
export async function acquireRelease(context: AcquireContext): Promise<{ kind: "reused" | "staged"; versionDirectory: string }> {
  const fs = context.fs ?? (context.deps as SecureDependencies).fs ?? nodeFsOps()
  if (selectTarget(context.deps.platform, context.deps.arch) && !context.record.target) fail("E_PLATFORM")
  try { const manifest = JSON.parse(new TextDecoder().decode(await fs.readFile(join(context.versionDirectory, "manifest.json")))) as InternalManifest; await inspectPayload(context.versionDirectory, manifest, { ...context.deps, fs } as any); if (manifest.version !== "0.1.0" || manifest.target !== context.record.target || manifest.asset !== context.record.asset) fail("E_VERSION"); await verifyBinary(join(context.versionDirectory, "bin/pane-dash"), manifest.version, context.deps); return { kind: "reused", versionDirectory: context.versionDirectory } } catch { /* invalid installations are never repaired */ }
  await fs.rm(context.stagingRoot); await fs.mkdir(context.stagingRoot); const archive = join(context.stagingRoot, ".download.tar.gz")
  try { await downloadAsset(context.record, archive, context.deps); const data = await fs.readFile(archive); async function* stream() { yield data }; await extractArchive({ archive: stream(), stagingRoot: context.stagingRoot, fs, clock: { nowMs: context.deps.nowMs ?? Date.now }, limits: context.limits ?? { maxEntries: 64, maxTotalBytes: 268435456, maxFileBytes: 134217728, timeoutMs: 30000 } }); const manifest = JSON.parse(new TextDecoder().decode(await fs.readFile(join(context.stagingRoot, "manifest.json")))) as InternalManifest; await inspectPayload(context.stagingRoot, manifest, { ...context.deps, fs }); if (manifest.version !== "0.1.0" || manifest.target !== context.record.target || manifest.asset !== context.record.asset) fail("E_VERSION"); await verifyBinary(join(context.stagingRoot, "bin/pane-dash"), manifest.version, context.deps); return { kind: "staged", versionDirectory: context.stagingRoot } } catch (error) { await fs.rm(context.stagingRoot); throw error }
}
