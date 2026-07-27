import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireRelease, downloadAsset } from "../src/acquire"
import { asset, fixtureDependencies, installedFixture, record } from "./helpers/fixture"

async function* chunks(value: Uint8Array) { yield value }
const bytes = new TextEncoder().encode("release body")
function response(status = 200, location?: string) { return { status, headers: location ? { location } : {}, body: chunks(bytes) } }
function downloadRecord() { return { ...record, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } }

test("verified same version is reused without network", async () => {
  const h = await installedFixture("0.1.0")
  try { await expect(acquireRelease(h.context)).resolves.toEqual({ kind: "reused", versionDirectory: h.versionDirectory }); expect(h.calls).toMatchObject({ fetch: 0, child: 1 }) } finally { await rm(h.root, { recursive: true, force: true }) }
})

test("corrupt existing installations stage rather than repair", async () => {
  for (const mutation of ["hash", "mode", "type", "extra", "version"] as const) {
    const h = await installedFixture("0.1.0")
    try {
      if (mutation === "extra") await Bun.write(join(h.versionDirectory, "extra"), "x")
      else if (mutation === "version") await Bun.write(join(h.versionDirectory, "manifest.json"), JSON.stringify({ schemaVersion: 1, product: "tmux-pane-dash", version: "0.2.0", target: record.target, asset, files: [] }))
      else if (mutation === "hash") await Bun.write(join(h.versionDirectory, "README.md"), "changed")
      else if (mutation === "mode") await Bun.$`chmod 600 ${join(h.versionDirectory, "README.md")}`.quiet()
      else await Bun.$`rm ${join(h.versionDirectory, "README.md")}`.quiet()
      await expect(acquireRelease(h.context)).rejects.toThrow("E_DOWNLOAD_STATUS")
      expect(h.calls.fetch).toBe(1)
    } finally { await rm(h.root, { recursive: true, force: true }) }
  }
})

test("uses exact initial URL, manual redirects, and never sends ambient credentials", async () => {
  for (const [name, locations, error] of [
    ["zero redirects", [], undefined], ["one redirect", ["https://release-assets.githubusercontent.com/signed/path?sig=a"], undefined], ["two redirects", ["https://release-assets.githubusercontent.com/a?x=1", "https://release-assets.githubusercontent.com/b?x=2"], undefined],
    ["missing", [undefined], "E_REDIRECT"], ["relative", ["/signed"], "E_REDIRECT"], ["http", ["http://release-assets.githubusercontent.com/a"], "E_REDIRECT"], ["userinfo", ["https://x@release-assets.githubusercontent.com/a"], "E_REDIRECT"], ["port", ["https://release-assets.githubusercontent.com:444/a"], "E_REDIRECT"], ["other host", ["https://example.test/a"], "E_REDIRECT"], ["return github", ["https://github.com/a"], "E_REDIRECT"], ["third", ["https://release-assets.githubusercontent.com/a", "https://release-assets.githubusercontent.com/b", "https://release-assets.githubusercontent.com/c"], "E_REDIRECT"],
  ] as const) {
    const calls: Array<{ url: string; init: any }> = [], responses = locations.map((location) => response(302, location)); responses.push(response())
    const root = await mkdtemp(join(tmpdir(), "download-")), destination = join(root, "asset")
    const deps = fixtureDependencies({ responses }).deps; deps.fetch = async (url, init) => { calls.push({ url, init }); return responses.shift()! }
    try {
      const action = downloadAsset(downloadRecord(), destination, deps)
      if (error) await expect(action).rejects.toThrow(error); else await expect(action).resolves.toBeUndefined()
      expect(calls[0]?.url).toBe(downloadRecord().url)
      for (const call of calls) { expect(call.init.redirect).toBe("manual"); expect(Object.keys(call.init.headers)).toEqual([]) }
    } finally { await rm(root, { recursive: true, force: true }) }
  }
})

test("rejects unsafe initial URL, statuses, body sizes, and hash", async () => {
  const cases: Array<[string, Partial<ReturnType<typeof downloadRecord>>, any]> = [
    ["wrong URL", { url: "https://github.com/other" }, response()], ["status", {}, response(500)], ["early EOF", { size: bytes.length + 1 }, response()], ["extra bytes", { size: bytes.length - 1 }, response()], ["hash", { sha256: "0".repeat(64) }, response()], ["declared cap", { size: 64 * 1024 * 1024 + 1 }, response()],
  ]
  for (const [name, change, item] of cases) {
    const root = await mkdtemp(join(tmpdir(), `download-${name}-`)), deps = fixtureDependencies({ responses: [item] }).deps
    try { await expect(downloadAsset({ ...downloadRecord(), ...change }, join(root, "asset"), deps)).rejects.toThrow(); expect(await Bun.file(join(root, "asset")).exists()).toBeFalse() } finally { await rm(root, { recursive: true, force: true }) }
  }
})

test("response timer, stall timer, total timer, and signals abort the supplied fetch signal", async () => {
  for (const name of ["response", "stall", "total", "HUP", "INT", "TERM"] as const) {
    const scheduled: Array<() => void> = [], listeners = new Map<string, () => void>(); let aborted = false
    const deps = fixtureDependencies().deps
    deps.timers = { setTimeout: (callback) => (scheduled.push(callback), callback), clearTimeout: () => {} }
    deps.signals = { on: (signal, callback) => { listeners.set(signal, callback) }, off: () => {} }
    deps.fetch = async (_url, init) => {
      const cancelled = new Promise<never>((_, reject) => init.signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")) }, { once: true }))
      cancelled.catch(() => {})
      if (name === "response" || name === "total") return await cancelled
      return { status: 200, body: { async *[Symbol.asyncIterator]() { await cancelled; yield bytes } } }
    }
    const promise = downloadAsset(downloadRecord(), join(tmpdir(), `timer-${crypto.randomUUID()}`), deps)
    const settled = promise.catch(() => undefined)
    await Promise.resolve(); if (name === "response") scheduled[1]!(); else if (name === "total") scheduled[0]!(); else if (name === "stall") scheduled.at(-1)!(); else listeners.get(name)!()
    await Promise.race([settled, new Promise((_, reject) => setTimeout(() => reject(new Error(`${name} did not settle`)), 25))])
    expect(aborted).toBeTrue()
  }
})
