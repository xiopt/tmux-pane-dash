import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireRelease, downloadAsset } from "../src/acquire"
import { archiveRecord, asset, fixtureDependencies, installedFixture, internalManifest, record, releaseArchive, releaseManifest } from "./helpers/fixture"

const encoder = new TextEncoder()
async function* chunks(bytes: Uint8Array) { yield bytes }
function response(bytes: Uint8Array, status = 200, headers: Record<string, string> = {}) { return { status, headers, body: chunks(bytes) } }
function goodDownload() { const bytes = releaseArchive(); return { bytes, record: archiveRecord(bytes) } }
async function temp(name: string) { return await mkdtemp(join(tmpdir(), `${name}-`)) }
async function mkdtemp(prefix: string) { return await (await import("node:fs/promises")).mkdtemp(prefix) }

test("fixture records ordered operation arguments and injects named nth faults", async () => {
  const h = fixtureDependencies({ fault: { name: "fs.stat", nth: 2 } })
  await expect(h.fs.stat("one")).rejects.toThrow(/ENOENT/)
  await expect(h.fs.stat("two")).rejects.toThrow("fault:fs.stat:2")
  expect(h.operations.map(({ name }) => name)).toEqual(["fs.stat", "fs.stat"])
  expect(h.operations[0]?.args).toEqual(["one"])
})

test("reuses an exact healthy payload offline and stages a real archive outside payload", async () => {
  const reused = await installedFixture()
  try {
    await expect(acquireRelease(reused.context)).resolves.toEqual({ kind: "reused", versionDirectory: reused.versionDirectory })
    expect(reused.calls).toMatchObject({ fetch: 0, child: 1 })
  } finally { await rm(reused.root, { recursive: true, force: true }) }
  const root = await temp("stage-real"), { bytes, record: stagedRecord } = goodDownload(), h = fixtureDependencies({ responses: [response(bytes)] }); h.deps.manifest = releaseManifest(stagedRecord)
  try {
    const result = await acquireRelease({ versionDirectory: join(root, "missing"), stagingRoot: join(root, "staging"), record: stagedRecord, deps: h.deps })
    expect(result).toEqual({ kind: "staged", versionDirectory: join(root, "staging") })
    expect(await readFile(join(root, "staging", "README.md"), "utf8")).toBe("readme")
    expect(await Bun.file(`${join(root, "staging")}.download.tar.gz`).exists()).toBeFalse()
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("only validated corruptions stage; operational faults propagate without fetching", async () => {
  for (const mutation of ["same-size-hash", "file-directory", "symlink", "extra-file", "extra-directory", "wrong-version", "wrong-target", "wrong-asset", "wrong-mode", "special-mode", "missing-directory"] as const) {
      const h = await installedFixture(), { bytes, record: stagedRecord } = goodDownload()
      h.context.record = stagedRecord
      h.context.deps.manifest = releaseManifest(stagedRecord)
    try {
      const readme = join(h.versionDirectory, "README.md")
      if (mutation === "same-size-hash") await writeFile(readme, "tamale")
      if (mutation === "file-directory") { await rm(readme); await mkdir(readme) }
      if (mutation === "symlink") { await rm(readme); await symlink("LICENSE", readme) }
      if (mutation === "extra-file") await writeFile(join(h.versionDirectory, "extra"), "")
      if (mutation === "extra-directory") await mkdir(join(h.versionDirectory, "extra"))
      if (mutation === "wrong-version" || mutation === "wrong-target" || mutation === "wrong-asset") { const manifest = JSON.parse(await readFile(join(h.versionDirectory, "manifest.json"), "utf8")); manifest[mutation.slice(6)] = mutation === "wrong-version" ? "0.2.0" : "wrong"; await writeFile(join(h.versionDirectory, "manifest.json"), JSON.stringify(manifest)) }
      if (mutation === "wrong-mode" || mutation === "special-mode") await Bun.$`chmod ${mutation === "wrong-mode" ? "600" : "4755"} ${readme}`.quiet()
      if (mutation === "missing-directory") await rm(join(h.versionDirectory, "scripts"), { recursive: true })
      const before = await Bun.file(join(h.versionDirectory, "manifest.json")).text()
      h.context.deps.fetch = async () => { h.calls.fetch += 1; return response(bytes) }
      await expect(acquireRelease(h.context)).resolves.toMatchObject({ kind: "staged" })
      expect(h.calls.fetch).toBe(1)
      expect(await Bun.file(join(h.versionDirectory, "manifest.json")).text()).toBe(before)
    } finally { await rm(h.root, { recursive: true, force: true }) }
  }
  for (const name of ["fs.stat", "fs.readFile", "spawn"] as const) {
    const h = await installedFixture(); const fault = fixtureDependencies({ fault: { name } }); h.context.deps = fault.deps; h.context.fs = fault.fs
    try { await expect(acquireRelease(h.context)).rejects.toThrow(`fault:${name}:1`); expect(fault.calls.fetch).toBe(0) } finally { await rm(h.root, { recursive: true, force: true }) }
  }
})

test("rejects a payload manifest whose version differs from the selected release record", async () => {
  const h = await installedFixture()
  try {
    const bytes = releaseArchive("0.1.1"), stagedRecord = archiveRecord(bytes)
    h.context.record = stagedRecord
    h.context.deps.manifest = releaseManifest(stagedRecord)
    h.context.deps.fetch = async () => { h.calls.fetch += 1; return response(bytes) }
    await writeFile(join(h.versionDirectory, "manifest.json"), JSON.stringify(internalManifest("0.1.1")))
    await expect(acquireRelease(h.context)).rejects.toThrow("E_VERSION")
    expect(h.calls.fetch).toBe(1)
  } finally { await rm(h.root, { recursive: true, force: true }) }
})

test("rejects absent fetch, unsupported platform, and record mismatch before fetch", async () => {
  for (const change of [{ platform: "win32" as NodeJS.Platform }, { target: "wrong" }, { asset: "wrong" }]) {
    const h = await installedFixture(); Object.assign(h.context.deps, change); if ("target" in change || "asset" in change) Object.assign(h.context.record, change)
    try { await expect(acquireRelease(h.context)).rejects.toThrow(); expect(h.calls.fetch).toBe(0) } finally { await rm(h.root, { recursive: true, force: true }) }
  }
  const { record: downloadRecord } = goodDownload(), h = fixtureDependencies(); h.deps.fetch = undefined
  await expect(downloadAsset(downloadRecord, join(tmpdir(), crypto.randomUUID()), h.deps, "v0.1.0")).rejects.toThrow("E_DOWNLOAD_FETCH")
})

test("initial URL and redirect tables preserve opaque destinations and omit sensitive headers", async () => {
  const { bytes, record: downloadRecord } = goodDownload()
  for (const [name, change, redirects, error] of [
    ["valid signed", {}, ["https://release-assets.githubusercontent.com/a/../b/%2F?sig=a%2Fb&x=1"], undefined], ["two", {}, ["https://release-assets.githubusercontent.com/a", "https://release-assets.githubusercontent.com/b"], undefined],
    ["malformed", { url: "not url" }, [], "E_DOWNLOAD_URL"], ["http", { url: downloadRecord.url.replace("https:", "http:") }, [], "E_DOWNLOAD_URL"], ["userinfo", { url: downloadRecord.url.replace("https://", "https://x@") }, [], "E_DOWNLOAD_URL"], ["host", { url: downloadRecord.url.replace("github.com", "example.test") }, [], "E_DOWNLOAD_URL"], ["tag", { url: downloadRecord.url.replace("v0.1.0", "v0.2.0") }, [], "E_DOWNLOAD_URL"], ["asset", { url: downloadRecord.url.replace(asset, "other") }, [], "E_DOWNLOAD_URL"], ["query", { url: `${downloadRecord.url}?x=1` }, [], "E_DOWNLOAD_URL"], ["fragment", { url: `${downloadRecord.url}#x` }, [], "E_DOWNLOAD_URL"],
    ["relative", {}, ["/x"], "E_REDIRECT"], ["third", {}, ["https://release-assets.githubusercontent.com/a", "https://release-assets.githubusercontent.com/b", "https://release-assets.githubusercontent.com/c"], "E_REDIRECT"],
  ] as const) {
    const calls: Array<{ url: string; init: any }> = [], responses = redirects.map((value, index) => response(bytes, 302, index === 0 ? { LoCaTiOn: value } : { location: value })); responses.push(response(bytes)); const h = fixtureDependencies({ responses })
    h.deps.fetch = async (url, init) => { calls.push({ url, init }); return responses.shift()! }
    const root = await temp(name)
    try { const action = downloadAsset({ ...downloadRecord, ...change }, join(root, "download"), h.deps, "v0.1.0"); if (error) await expect(action).rejects.toThrow(error); else await expect(action).resolves.toBeUndefined(); if (calls.length) expect(calls[0]?.url).toBe((change as any).url ?? downloadRecord.url); if (name === "valid signed") expect(calls[1]?.url).toBe(redirects[0]); for (const call of calls) expect(call.init).toMatchObject({ redirect: "manual", headers: {} }) } finally { await rm(root, { recursive: true, force: true }) }
  }
})

test("cleans partial downloads for final response, body, size, hash, and exclusive collisions", async () => {
  const { bytes, record: downloadRecord } = goodDownload()
  for (const [name, recordChange, item] of [["status", {}, response(bytes, 500)], ["missing", {}, { status: 200 }], ["early", { size: bytes.length + 1 }, response(bytes)], ["extra", { size: bytes.length - 1 }, response(bytes)], ["cap", { size: 64 * 1024 * 1024 + 1 }, response(bytes)], ["hash", { sha256: "0".repeat(64) }, response(bytes)]] as const) {
    const root = await temp(name), h = fixtureDependencies({ responses: [item] }), destination = join(root, "download")
    try { await expect(downloadAsset({ ...downloadRecord, ...recordChange }, destination, h.deps, "v0.1.0")).rejects.toThrow(); expect(await Bun.file(destination).exists()).toBeFalse() } finally { await rm(root, { recursive: true, force: true }) }
  }
  const root = await temp("collision"), h = fixtureDependencies({ responses: [response(bytes)] }), destination = join(root, "download"); await writeFile(destination, "keep")
  try { await expect(downloadAsset(downloadRecord, destination, h.deps, "v0.1.0")).rejects.toThrow(); expect(await Bun.file(destination).text()).toBe("keep") } finally { await rm(root, { recursive: true, force: true }) }
})

test("timer and signal abort races settle promptly and clear every active handle once", async () => {
  for (const trigger of ["response", "stall", "total", "HUP", "INT", "TERM"] as const) {
    const handles: Array<{ callback: () => void; cleared: number }> = [], listeners = new Map<string, () => void>(), { record: downloadRecord } = goodDownload()
    const h = fixtureDependencies({ timers: { setTimeout: (callback) => (handles.push({ callback, cleared: 0 }), handles.at(-1)!), clearTimeout: (handle) => { (handle as { cleared: number }).cleared += 1 } }, signals: { on: (signal, callback) => { listeners.set(signal, callback) }, off: (signal, callback) => { expect(listeners.get(signal)).toBe(callback); listeners.delete(signal) } } })
    let signal: AbortSignal | undefined
    h.deps.fetch = async (_url, init) => { signal = init.signal; return trigger === "response" || trigger === "total" ? await new Promise(() => {}) : { status: 200, body: { async *[Symbol.asyncIterator]() { yield new Uint8Array(); await new Promise(() => {}); yield encoder.encode("x") } } } }
    const action = downloadAsset(downloadRecord, join(tmpdir(), crypto.randomUUID()), h.deps, "v0.1.0"); await Promise.resolve()
    if (trigger === "response") handles[1]?.callback(); else if (trigger === "total") handles[0]?.callback(); else if (trigger === "stall") handles.at(-1)?.callback(); else listeners.get(trigger)?.()
    await Promise.race([expect(action).rejects.toThrow("E_DOWNLOAD_ABORT"), new Promise((_, reject) => setTimeout(() => reject(new Error("did not settle")), 100))])
    expect(handles.every((handle) => handle.cleared === 1)).toBeTrue(); expect(listeners.size).toBe(0); expect(signal?.aborted).toBe(true)
  }
})
