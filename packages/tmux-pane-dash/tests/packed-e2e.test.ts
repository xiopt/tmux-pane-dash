import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readlinkSync } from "node:fs"
import { createServer } from "node:http"
import { chmod, lstat, mkdtemp, mkdir, open, readFile, readlink, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve, sep } from "node:path"
import type { Dependencies } from "../src/runtime"
import { CLI_PACKAGE_FILES, TARGETS } from "../../../scripts/release/contracts"
import { assertPackedNodeBundle } from "../../../scripts/release/verify-artifacts"
import { importPackedRuntime, packedInstallHarness, buildFixtureRelease, type ReleaseAssetRecord } from "./helpers/release-fixture"
import { installNetworkGuard } from "./helpers/network-guard"

const root = join(import.meta.dir, "../../..")
const hostKey = process.platform === "darwin" ? process.arch === "arm64" ? "darwin-arm64" : process.arch === "x64" ? "darwin-x64" : undefined : process.platform === "linux" ? process.arch === "arm64" ? "linux-arm64" : process.arch === "x64" ? "linux-x64" : undefined : undefined
const rustTarget = () => TARGETS[hostKey as keyof typeof TARGETS].rustTarget
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const missing = (error: unknown) => typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT"

async function packCli(nodeBin: string, npmCli: string) {
  const output = await mkdtemp(join(tmpdir(), "pane-dash-packed-e2e-"))
  const bundles = await mkdtemp(join(tmpdir(), "pane-dash-packed-bundles-"))
  for (const [entry, name] of [["src/cli.ts", "cli.js"], ["src/runtime.ts", "runtime.js"]] as const) {
    const build = Bun.spawn([process.execPath, "build", join("packages/tmux-pane-dash", entry), "--outfile", join(bundles, name), "--target=node", "--format=esm"], { cwd: root, stdout: "pipe", stderr: "pipe" })
    const [code, stderr] = await Promise.all([build.exited, new Response(build.stderr).text()])
    if (code !== 0) throw new Error(`CLI bundle failed: ${stderr}`)
    expect(await readFile(join(bundles, name))).toEqual(await readFile(join(root, "packages/tmux-pane-dash/dist", name)))
  }
  const pack = Bun.spawn([nodeBin, npmCli, "pack", "--json", "--workspace", "packages/tmux-pane-dash", "--pack-destination", output], { cwd: root, stdout: "pipe", stderr: "pipe" })
  const [code, stdout] = await Promise.all([pack.exited, new Response(pack.stdout).text()])
  expect(code).toBe(0)
  await rm(bundles, { recursive: true, force: true })
  return { output, tarball: join(output, (JSON.parse(stdout) as Array<{ filename: string }>)[0]!.filename) }
}

async function fixtureManifest(version: "0.1.1" | "0.1.2", selected: ReleaseAssetRecord) {
  const text = await readFile(join(import.meta.dir, "fixtures", version, "manifest-template.json"), "utf8")
  const key = hostKey!.replace("-", "_").toUpperCase()
  return JSON.parse(text.replace(`__${key}_SHA256__`, selected.sha256).replace(`__${key}_SIZE__`, String(selected.size)).replaceAll(/__[A-Z0-9_]+_SHA256__/g, "0".repeat(64)).replaceAll(/__[A-Z0-9_]+_SIZE__/g, "0"))
}

async function fixtureServer(releases: readonly ReleaseAssetRecord[]) {
  const requests = new Map<string, number>(), records = new Map(releases.map(release => [release.url, release]))
  const server = createServer((request, response) => {
    const release = [...records.values()].find(item => request.url === `/fixtures/${item.asset}`)
    if (!release) { response.writeHead(404); response.end(); return }
    requests.set(release.url, (requests.get(release.url) ?? 0) + 1)
    response.writeHead(200, { "content-length": String(release.size) }); response.end(release.bytes)
  })
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  const port = (server.address() as { port: number }).port, origin = `http://127.0.0.1:${port}`
  return {
    origin, requestsFor: (version: string) => [...records.values()].filter(record => record.asset.includes(`v${version}-`)).reduce((total, record) => total + (requests.get(record.url) ?? 0), 0),
    fetch: async (url: string, init: Parameters<NonNullable<Dependencies["fetch"]>>[1]) => {
      const release = records.get(url)
      if (!release) throw new Error(`fixture fetch rejected non-immutable URL: ${url}`)
      return fetch(`${origin}/fixtures/${release.asset}`, init)
    },
    close: async () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

function runtimeDependencies(input: { manifest: unknown; version: string; fetch: NonNullable<Dependencies["fetch"]>; env: Record<string, string>; output: string[] }): Dependencies {
  const within = (base: string, path: string) => { const full = resolve(base, path); if (!full.startsWith(`${resolve(base)}${sep}`)) throw new Error("payload escapes root"); return full }
  const fs = {
    async mkdir(path: string) { await mkdir(path, { recursive: true, mode: 0o700 }) },
    async mkdirPayloadDirectory(base: string, path: string, mode: number) { const full = within(base, path); await mkdir(full, { mode: mode & 0o777 }); await chmod(full, mode & 0o777) },
    async readFile(path: string) { return new Uint8Array(await readFile(path)) },
    async writeFileExclusive(base: string, path: string, bytes: Uint8Array, mode: number) { const file = await open(within(base, path), "wx", mode & 0o777); try { await file.writeFile(bytes) } finally { await file.close() } },
    async openExclusive(path: string, mode: number) { return open(path, "wx", mode & 0o777) }, async write(file: unknown, bytes: Uint8Array) { await (file as { writeFile(bytes: Uint8Array): Promise<void> }).writeFile(bytes) }, async close(file: unknown) { await (file as { close(): Promise<void> }).close() },
    async stat(path: string) { const item = await lstat(path); return { kind: item.isFile() ? "file" as const : item.isDirectory() ? "directory" as const : item.isSymbolicLink() ? "symlink" as const : "other" as const, mode: item.mode & 0o7777, size: item.size, dev: item.dev, ino: item.ino } }, async readdir(path: string) { return readdir(path) }, async rm(path: string) { await rm(path, { recursive: true, force: true }) },
  }
  const spawn: NonNullable<Dependencies["spawn"]> = async (path, args, options) => { const child = Bun.spawn([path, ...args], { env: options.env, stdout: "pipe", stderr: "pipe" }); const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); return { code, stdout, stderr } }
  return { manifest: input.manifest, executingVersion: input.version, platform: process.platform, arch: process.arch, fetch: input.fetch, fs, doctorFs: { ...fs, readlink }, env: input.env, spawn, doctorOutput: text => input.output.push(text), nowMs: Date.now, pid: () => process.pid, uid: () => process.getuid?.() ?? 0, isPidAlive: pid => { try { process.kill(pid, 0); return true } catch { return false } } }
}

async function cli(runtime: { runCli(argv: readonly string[], deps: Dependencies): Promise<number> }, argv: readonly string[], deps: Dependencies) {
  return runtime.runCli(argv, deps)
}

function expectTmuxServerOk(report: unknown) {
  const checks = (report as { checks?: Array<{ id?: string; status?: string }> }).checks
  const tmuxServer = checks?.find(check => check.id === "tmux.server")
  expect(tmuxServer?.status).toBe("ok")
}

async function launchBoundPopup(rootPath: string, env: Record<string, string>, tmuxBin: string) {
  const logicalPath = join(rootPath, "current", "bin", "pane-dash"), resolvedPath = await realpath(logicalPath), binary = await lstat(resolvedPath)
  const socket = `pd${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`, session = `pane_dash_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`
  const runTmux = async (args: readonly string[]) => {
    const child = Bun.spawn([tmuxBin, "-L", socket, ...args], { env: { ...env, TMUX: "", TMUX_PANE: "" }, stdout: "pipe", stderr: "pipe" })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(code, stderr).toBe(0)
    return stdout.trim()
  }
  expect(env.TMUX_TMPDIR.startsWith(dirname(env.HOME))).toBe(true)
  await runTmux(["-f", "/dev/null", "new-session", "-d", "-s", session, "-x", "160", "-y", "48", "sleep 600"])
  const paneId = await runTmux(["new-window", "-d", "-t", session, "-P", "-F", "#{pane_id}", "sleep 600"])
  const sessionId = await runTmux(["display-message", "-p", "-t", paneId, "#{session_id}"])
  if (!/^%[1-9][0-9]*$/.test(paneId) || !/^\$[0-9]+$/.test(sessionId)) throw new Error(`invalid tmux identities: ${paneId} ${sessionId}`)
  await runTmux(["respawn-pane", "-k", "-t", paneId, resolvedPath, "/dev/null", sessionId, paneId])
  const panePid = await runTmux(["display-message", "-p", "-t", paneId, "#{pane_pid}"])
  if (!/^[1-9][0-9]*$/.test(panePid)) throw new Error(`invalid tmux pane pid: ${panePid}`)
  const alive = async () => {
    const dead = await runTmux(["display-message", "-p", "-t", paneId, "#{pane_dead}"])
    if (dead !== "0") return false
    try { process.kill(Number(panePid), 0); return true } catch { return false }
  }
  expect(await alive()).toBe(true)
  return {
    logicalPath, resolvedPath, dev: binary.dev, ino: binary.ino, paneId, panePid: Number(panePid), session: sessionId, socket,
    alive,
    version: async () => {
      const child = Bun.spawn([resolvedPath, "--version"], { env, stdout: "pipe", stderr: "pipe" })
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      expect(code, stderr).toBe(0)
      return stdout.trim().replace("pane-dash ", "")
    },
    cleanup: async () => { await runTmux(["kill-server"]).catch(() => undefined) },
  }
}

async function realHomeState() {
  const home = process.env.HOME
  if (!home) throw new Error("real HOME is unavailable")
  return Promise.all([join(home, ".local", "share", "tmux-pane-dash"), join(home, ".config", "opencode", "opencode.json"), join(home, ".tmux.conf")].map(async path => {
    try {
      const info = await lstat(path)
      return { path, present: true, lstat: { mode: info.mode, size: info.size, dev: info.dev, ino: info.ino, symlink: info.isSymbolicLink() }, bytes: Array.from(await readFile(path)) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, present: false }
      throw error
    }
  }))
}

type NodeState =
  | { present: false }
  | { present: true; kind: "file"; mode: number; bytes: number[]; sha256: string }
  | { present: true; kind: "symlink"; mode: number; dev: number; ino: number; target: string }
  | { present: true; kind: "directory"; mode: number; entries: Record<string, NodeState> }
  | { present: true; kind: "other"; mode: number }

async function pathState(path: string): Promise<NodeState> {
  let info
  try { info = await lstat(path) } catch (error) { if (missing(error)) return { present: false }; throw error }
  if (info.isSymbolicLink()) return { present: true, kind: "symlink", mode: info.mode & 0o7777, dev: info.dev, ino: info.ino, target: await readlink(path) }
  if (info.isFile()) { const bytes = await readFile(path); return { present: true, kind: "file", mode: info.mode & 0o7777, bytes: Array.from(bytes), sha256: sha(bytes) } }
  if (info.isDirectory()) return { present: true, kind: "directory", mode: info.mode & 0o7777, entries: Object.fromEntries(await Promise.all((await readdir(path)).sort().map(async name => [name, await pathState(join(path, name))]))) }
  return { present: true, kind: "other", mode: info.mode & 0o7777 }
}

async function configState(logicalPath: string) {
  const logical = await pathState(logicalPath)
  if (!logical.present) return { logical, resolved: logical }
  let resolvedPath: string
  try { resolvedPath = await realpath(logicalPath) } catch (error) { if (missing(error)) throw new Error(`present config has no resolved target: ${logicalPath}`); throw error }
  return { logical, resolvedPath, resolved: await pathState(resolvedPath) }
}

async function lifecycleConfigState(env: Record<string, string>) {
  return {
    tmux: await configState(join(env.HOME, ".tmux.conf")),
    opencode: await configState(join(env.XDG_CONFIG_HOME, "opencode", "opencode.json")),
  }
}

async function directoryEntries(path: string): Promise<string[] | null> {
  try { return (await readdir(path)).sort() } catch (error) { if (missing(error)) return null; throw error }
}

async function assertNoTransactionJournals(managed: string) {
  expect((await directoryEntries(join(managed, "transactions")) ?? []).filter(entry => entry !== "lock")).toEqual([])
}

async function componentEnvironment(rootPath: string, name: string) {
  const env = { HOME: join(rootPath, `${name}-home`), XDG_DATA_HOME: join(rootPath, `${name}-data`), XDG_CONFIG_HOME: join(rootPath, `${name}-config`) }
  const tmux = join(env.HOME, ".tmux.conf"), opencode = join(env.XDG_CONFIG_HOME, "opencode", "opencode.json")
  await Promise.all([mkdir(dirname(tmux), { recursive: true }), mkdir(dirname(opencode), { recursive: true }), mkdir(env.XDG_DATA_HOME, { recursive: true })])
  await writeFile(tmux, `set -g status ${name}`, { mode: 0o640 }); await writeFile(opencode, `{"sentinel":"${name}","plugin":[]}\n`, { mode: 0o600 })
  return { env, tmux, opencode, baseline: await lifecycleConfigState(env) }
}

async function fixedPathTmux() {
  const child = Bun.spawn(["/bin/sh", "-c", "PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin; command -v tmux"], { stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (code !== 0) throw new Error(`fixed PATH cannot resolve tmux: ${stderr}`)
  return realpath(stdout.trim())
}

test("isolation: local pack install is offline before package JavaScript runs", async () => {
  expect(process.env.TARGET_KEY ?? hostKey).toBe(hostKey)
  const nodeBin = process.env.NODE_20_BIN, npmCli = process.env.NPM_20_CLI
  expect(nodeBin).toMatch(/^\//); expect(npmCli).toMatch(/^\//)
  const packed = await packCli(nodeBin!, npmCli!)
  try {
    const h = await packedInstallHarness({ nodeBin: nodeBin!, npmCli: npmCli!, tarball: packed.tarball })
    try {
      await h.runner.run([nodeBin!, npmCli!, "install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", packed.tarball], { cwd: h.project, env: h.env, timeoutMs: 60_000 })
      expect(h.sentinel.requests).toEqual([])
      expect((await h.runner.run([nodeBin!, "--version"], { cwd: h.project, env: h.env, timeoutMs: 5_000 })).stdout.trim()).toBe("v20.0.0")
      const unpacked = join(h.project, "node_modules", "@xiopt", "tmux-pane-dash")
      const unpackedTarball = await mkdtemp(join(tmpdir(), "pane-dash-packed-files-"))
      const untar = Bun.spawn(["tar", "-xzf", packed.tarball, "-C", unpackedTarball], { stdout: "pipe", stderr: "pipe" })
      expect(await untar.exited).toBe(0)
      const paths = (await readdir(join(unpackedTarball, "package"), { recursive: true })).filter(path => !["dist", "generated", "payload"].includes(path)).map(path => `package/${path}`).sort()
      expect(paths).toEqual([...CLI_PACKAGE_FILES].sort())
      const textPaths = CLI_PACKAGE_FILES.filter(path => !path.includes("/payload/"))
      const files = await Promise.all(textPaths.map(async path => [path, await readFile(join(unpackedTarball, path), "utf8")] as const))
      for (const [path, content] of files) {
        expect(content, path).not.toMatch(/(?:127\.0\.0\.1|localhost|(?:endpoint|manifest|version|checksum|root)[-_]?(?:override|url|path))/i)
      }
      const bundle = files.map(([, content]) => content).join("\n")
      assertPackedNodeBundle(files.find(([path]) => path === "package/dist/cli.js")![1])
      assertPackedNodeBundle(files.find(([path]) => path === "package/dist/runtime.js")![1])
      const manifest = JSON.parse(await readFile(join(unpackedTarball, "package/generated/release-manifest.json"), "utf8"))
      const payload = await readFile(join(unpackedTarball, `package/payload/${manifest.assets["darwin-arm64"].asset}`))
      expect(payload.length).toBe(manifest.assets["darwin-arm64"].size)
      expect(sha(payload)).toBe(manifest.assets["darwin-arm64"].sha256)
      const urls = [...bundle.matchAll(/https?:\/\/[^\s"']+/g)].map(([url]) => url)
      expect(urls.every(url => /^https:\/\/github\.com(?::443)?\/xiopt\/tmux-pane-dash(?:\.git|#|\/|$)/.test(url)), urls.join("\n")).toBe(true)
      const metadata = JSON.parse(await readFile(join(unpacked, "package.json"), "utf8")) as Record<string, unknown>
      expect(metadata.exports).toBeUndefined()
      expect(metadata.main).toBeUndefined()
      expect(metadata.bin).toEqual({ "tmux-pane-dash": "dist/cli.js" })
      const runtime = await importPackedRuntime(unpacked)
      const removeGuard = installNetworkGuard("http://127.0.0.1:1")
      try { expect(runtime.runCli).toBeFunction() } finally { removeGuard() }
      console.log("local-pack-install=PASS registry-requests=0 node=v20.0.0 runtime-file-url=PASS")
    } finally { await h.cleanup() }
  } finally { await rm(packed.output, { recursive: true, force: true }) }
})

test.if(process.platform === "darwin" && process.arch === "arm64")("packed CLI setup uses its bundled payload without a network request", async () => {
  expect(process.env.TARGET_KEY ?? hostKey).toBe(hostKey)
  const nodeBin = process.env.NODE_20_BIN, npmCli = process.env.NPM_20_CLI
  expect(nodeBin).toMatch(/^\//); expect(npmCli).toMatch(/^\//)
  const packed = await packCli(nodeBin!, npmCli!)
  try {
    const h = await packedInstallHarness({ nodeBin: nodeBin!, npmCli: npmCli!, tarball: packed.tarball })
    try {
      await h.runner.run([nodeBin!, npmCli!, "install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", packed.tarball], { cwd: h.project, env: h.env, timeoutMs: 60_000 })
      const installed = join(h.project, "node_modules", "@xiopt", "tmux-pane-dash")
      const setup = await h.runner.run([nodeBin!, join(installed, "dist", "cli.js"), "setup", "--no-opencode"], { cwd: h.project, env: h.env, timeoutMs: 60_000 })
      expect(setup.code, setup.stderr).toBe(0)
      expect(h.sentinel.requests).toEqual([])
      expect(await Bun.file(join(h.env.XDG_DATA_HOME, "tmux-pane-dash", "current", "bin", "pane-dash")).exists()).toBeTrue()
      expect(await Bun.file(join(h.env.HOME, ".tmux.conf")).text()).toContain("tmux-pane-dash")
    } finally { await h.cleanup() }
  } finally { await rm(packed.output, { recursive: true, force: true }) }
})

test("lifecycle: packed runtime installs, updates, rolls back, and uninstalls on the matching host", async () => {
  expect(process.env.TARGET_KEY ?? hostKey).toBe(hostKey)
  const nodeBin = process.env.NODE_20_BIN!, npmCli = process.env.NPM_20_CLI!
  const packed = await packCli(nodeBin, npmCli), h = await packedInstallHarness({ nodeBin, npmCli, tarball: packed.tarball })
  const fixtureRoot = await mkdtemp(join(tmpdir(), "pane-dash-lifecycle-"))
  try {
    await h.runner.run([nodeBin, npmCli, "install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", packed.tarball], { cwd: h.project, env: h.env, timeoutMs: 60_000 })
    expect(h.sentinel.requests).toEqual([])
    const unpacked = join(h.project, "node_modules", "@xiopt", "tmux-pane-dash"), runtime = await importPackedRuntime(unpacked)
    const tmuxTarget = join(fixtureRoot, "tmux.conf"), openCodeTarget = join(fixtureRoot, "opencode.json")
    await mkdir(join(h.env.XDG_CONFIG_HOME, "opencode"), { recursive: true })
    await writeFile(tmuxTarget, "set -g status off", { mode: 0o640 }); await writeFile(openCodeTarget, "{\"plugin\":[]}\n", { mode: 0o600 })
    await symlink(tmuxTarget, join(h.env.HOME, ".tmux.conf")); await symlink(openCodeTarget, join(h.env.XDG_CONFIG_HOME, "opencode", "opencode.json"))
    const releases = await Promise.all((["0.1.1", "0.1.2"] as const).map(version => buildFixtureRelease({ version, target: rustTarget(), binary: "pane-dash", root })))
    const server = await fixtureServer(releases), guard = installNetworkGuard(server.origin), output: string[] = []
    const managed = join(h.env.XDG_DATA_HOME, "tmux-pane-dash")
    const tmuxBin = await realpath(process.env.TMUX_BIN ?? (() => { throw new Error("TMUX_BIN required") })())
    h.env.PATH = `${dirname(tmuxBin)}:${h.env.PATH}`
    const harnessTmux = async (args: readonly string[]) => {
      const child = Bun.spawn([tmuxBin, ...args], { env: { ...h.env, TMUX: "", TMUX_PANE: "" }, stdout: "pipe", stderr: "pipe" })
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
      expect(code, stderr).toBe(0)
    }
      const homeBefore = await realHomeState(), configBaseline = await lifecycleConfigState(h.env)
    try {
      const oldDeps = runtimeDependencies({ manifest: await fixtureManifest("0.1.1", releases[0]!), version: "0.1.1", fetch: server.fetch, env: h.env, output })
      await cli(runtime, ["setup"], oldDeps)
      await harnessTmux(["-f", join(h.env.HOME, ".tmux.conf"), "new-session", "-d", "-s", "doctor", "sleep 600"])
      const initialDoctor = await cli(runtime, ["doctor", "--json"], oldDeps), initialReport = JSON.parse(output.pop()!)
      expect(initialDoctor, JSON.stringify(initialReport)).toBe(0)
      expect(initialReport).toMatchObject({ schemaVersion: 1, healthy: true })
      expectTmuxServerOk(initialReport)
      await cli(runtime, ["setup"], oldDeps); expect(server.requestsFor("0.1.1")).toBe(1)
      expect(await fixedPathTmux()).toBe(tmuxBin)
      expect(h.env.TMUX_TMPDIR.startsWith(dirname(h.env.HOME))).toBe(true)
      const newDeps = runtimeDependencies({ manifest: await fixtureManifest("0.1.2", releases[1]!), version: "0.1.2", fetch: server.fetch, env: h.env, output })
      const oldPopup = await launchBoundPopup(managed, h.env, tmuxBin)
      try {
        expect(await oldPopup.version()).toBe("0.1.1")

        const observer = join(fixtureRoot, "deny-net-observer.json"), shim = join(fixtureRoot, "deny-net.cjs")
        await writeFile(shim, `const fs = require("node:fs"), net = require("node:net"), dns = require("node:dns"), attempts = [];
const deny = name => { attempts.push(name); throw new Error("network denied: " + name) };
globalThis.fetch = () => deny("fetch");
net.Socket.prototype.connect = function () { return deny("net.Socket.connect") };
dns.lookup = function () { return deny("dns.lookup") };
process.on("exit", () => fs.writeFileSync(process.env.PANE_DASH_DENY_NET_OBSERVER, JSON.stringify(attempts)));
`)
        const observed = await h.runner.run([nodeBin, "--require", shim, join(unpacked, "dist", "cli.js"), "doctor", "--json"], { cwd: h.project, env: { ...h.env, PANE_DASH_DENY_NET_OBSERVER: observer }, timeoutMs: 15_000 })
        const ordinary = await h.runner.run([nodeBin, join(unpacked, "dist", "cli.js"), "doctor", "--json"], { cwd: h.project, env: h.env, timeoutMs: 15_000 })
        const observedReport = JSON.parse(observed.stdout), ordinaryReport = JSON.parse(ordinary.stdout)
        expect(observed.stdout).toBe(ordinary.stdout); expect(observedReport).toMatchObject({ schemaVersion: 1, healthy: true }); expectTmuxServerOk(observedReport); expectTmuxServerOk(ordinaryReport); expect(await readFile(observer, "utf8")).toBe("[]")

        await cli(runtime, ["update"], newDeps)
        expect(await oldPopup.alive()).toBe(true); expect(await oldPopup.version()).toBe("0.1.1")
        const persistedOld = await lstat(oldPopup.resolvedPath)
        expect(`${persistedOld.dev}:${persistedOld.ino}`).toBe(`${oldPopup.dev}:${oldPopup.ino}`)
        const currentResolved = await realpath(join(managed, "current", "bin", "pane-dash")), current = await lstat(currentResolved)
        expect(`${current.dev}:${current.ino}`).not.toBe(`${oldPopup.dev}:${oldPopup.ino}`)
        const newPopup = await launchBoundPopup(managed, h.env, tmuxBin)
        try { expect(await newPopup.alive()).toBe(true); expect(await newPopup.version()).toBe("0.1.2") } finally { await newPopup.cleanup() }
        expect(await cli(runtime, ["doctor", "--json"], newDeps)).toBe(0); const postUpdateReport = JSON.parse(output.pop()!); expect(postUpdateReport).toMatchObject({ schemaVersion: 1, healthy: true }); expectTmuxServerOk(postUpdateReport)
      } finally { await oldPopup.cleanup() }
      await expect(cli(runtime, ["setup"], oldDeps)).rejects.toThrow("E_DOWNGRADE")
      await expect(cli(runtime, ["update"], oldDeps)).rejects.toThrow("E_DOWNGRADE")
      await cli(runtime, ["setup", "--allow-downgrade"], oldDeps)
      await cli(runtime, ["update"], newDeps)

      const rollbackBaseline = { current: await readlink(join(managed, "current")), configs: await lifecycleConfigState(h.env), ownership: await pathState(join(managed, "state", "ownership.json")), versions: await directoryEntries(join(managed, "versions")) }
      expect(rollbackBaseline.current).toBe("versions/0.1.2")
      const rollback = { ...oldDeps }
      Object.defineProperty(rollback, "signal", { get: () => readlinkSync(join(managed, "current")) === "versions/0.1.1" ? "TERM" : undefined })
      await expect(cli(runtime, ["setup", "--allow-downgrade"], rollback)).rejects.toThrow("E_SIGNAL_TERM")
      expect(await readlink(join(managed, "current"))).toBe(rollbackBaseline.current)
      expect(await lifecycleConfigState(h.env)).toEqual(rollbackBaseline.configs)
      expect(await pathState(join(managed, "state", "ownership.json"))).toEqual(rollbackBaseline.ownership)
      expect(await directoryEntries(join(managed, "versions"))).toEqual(rollbackBaseline.versions)
      await assertNoTransactionJournals(managed)

      expect(await cli(runtime, ["uninstall"], newDeps)).toBe(0)
      expect(await lifecycleConfigState(h.env)).toEqual(configBaseline)
      expect(await pathState(join(managed, "current"))).toEqual({ present: false })
      expect(await pathState(join(managed, "state", "ownership.json"))).toEqual({ present: false })
      expect(await directoryEntries(join(managed, "versions"))).toBeNull()
      await assertNoTransactionJournals(managed)
      const afterFirstUninstall = { managed: await pathState(managed), configs: await lifecycleConfigState(h.env) }
      expect(await cli(runtime, ["uninstall"], newDeps)).toBe(0)
      expect({ managed: await pathState(managed), configs: await lifecycleConfigState(h.env) }).toEqual(afterFirstUninstall)

      for (const component of ["no-tmux", "no-opencode"] as const) {
        const isolated = await componentEnvironment(fixtureRoot, component)
        const deps = runtimeDependencies({ manifest: await fixtureManifest("0.1.1", releases[0]!), version: "0.1.1", fetch: server.fetch, env: isolated.env, output })
        await cli(runtime, component === "no-tmux" ? ["setup", "--no-tmux"] : ["setup", "--no-opencode"], deps)
        const ownership = JSON.parse(await readFile(join(isolated.env.XDG_DATA_HOME, "tmux-pane-dash", "state", "ownership.json"), "utf8"))
        const enabled = component === "no-tmux" ? "opencode" : "tmux", disabled = component === "no-tmux" ? "tmux" : "opencode"
        expect(ownership.components[disabled]).toBeNull()
        expect(Object.keys(ownership.components[enabled]).sort()).toEqual(["baselineBackup", "logicalPath", "marker", "packageEntries", "resolvedPath"])
        expect(await lifecycleConfigState(isolated.env)).not.toEqual(isolated.baseline)
        expect(await readFile(component === "no-tmux" ? isolated.opencode : isolated.tmux, "utf8")).toContain(component === "no-tmux" ? "@xiopt/pane-dash-opencode@0.1.1" : "tmux-pane-dash")
        expect(component === "no-tmux" ? await configState(isolated.tmux) : await configState(isolated.opencode)).toEqual(component === "no-tmux" ? isolated.baseline.tmux : isolated.baseline.opencode)
        await cli(runtime, ["uninstall"], deps)
        expect(await lifecycleConfigState(isolated.env)).toEqual(isolated.baseline)
      }

      const migration = await componentEnvironment(fixtureRoot, "migration"), legacyRoot = join(fixtureRoot, "legacy", "tmux-pane-dash", "opencode-plugin"), legacyTarget = join(legacyRoot, "pane-dash.ts"), legacyLink = join(migration.env.XDG_CONFIG_HOME, "opencode", "plugin", "pane-dash.ts")
      await mkdir(legacyRoot, { recursive: true }); await writeFile(legacyTarget, "export const legacy = true\n"); await mkdir(dirname(legacyLink), { recursive: true }); await symlink(legacyTarget, legacyLink)
      const migrationDeps = runtimeDependencies({ manifest: await fixtureManifest("0.1.1", releases[0]!), version: "0.1.1", fetch: server.fetch, env: migration.env, output })
      await cli(runtime, ["setup", "--no-tmux", "--migrate"], migrationDeps)
      expect(await pathState(legacyLink)).toEqual({ present: false }); expect(await readFile(legacyTarget, "utf8")).toBe("export const legacy = true\n")
      const migratedOwnership = JSON.parse(await readFile(join(migration.env.XDG_DATA_HOME, "tmux-pane-dash", "state", "ownership.json"), "utf8"))
      expect(migratedOwnership.migrations).toEqual([{ from: legacyLink, to: await realpath(legacyTarget), sha256: "" }])
      expect(await readFile(migration.opencode, "utf8")).toContain("@xiopt/pane-dash-opencode@0.1.1")
      await assertNoTransactionJournals(join(migration.env.XDG_DATA_HOME, "tmux-pane-dash"))
      await cli(runtime, ["uninstall"], migrationDeps)
      expect(await lifecycleConfigState(migration.env)).toEqual(migration.baseline)

      const conflict = await componentEnvironment(fixtureRoot, "migration-conflict"), conflictLink = join(conflict.env.XDG_CONFIG_HOME, "opencode", "plugin", "pane-dash.ts"), conflictOther = join(conflict.env.XDG_CONFIG_HOME, "opencode", "plugins", "pane-dash.ts"), conflictManaged = join(conflict.env.XDG_DATA_HOME, "tmux-pane-dash")
      await mkdir(dirname(conflictLink), { recursive: true }); await mkdir(dirname(conflictOther), { recursive: true }); await symlink(legacyTarget, conflictLink); await symlink(legacyTarget, conflictOther)
      const conflictBefore = { links: [await readlink(conflictLink), await readlink(conflictOther)], configs: await lifecycleConfigState(conflict.env), managed: await pathState(conflictManaged), requests: server.requestsFor("0.1.1") }
      const conflictDeps = runtimeDependencies({ manifest: await fixtureManifest("0.1.1", releases[0]!), version: "0.1.1", fetch: server.fetch, env: conflict.env, output })
      await expect(cli(runtime, ["setup", "--no-tmux", "--migrate"], conflictDeps)).rejects.toThrow("E_CONFIG_CONFLICT")
      expect([await readlink(conflictLink), await readlink(conflictOther)]).toEqual(conflictBefore.links)
      expect(await lifecycleConfigState(conflict.env)).toEqual(conflictBefore.configs)
      expect(await pathState(conflictManaged)).toEqual(conflictBefore.managed)
      expect(server.requestsFor("0.1.1")).toBe(conflictBefore.requests)
      await assertNoTransactionJournals(conflictManaged)

      expect(await lifecycleConfigState(h.env)).toEqual(configBaseline)
      expect(await realHomeState()).toEqual(homeBefore)
      expect(await fixedPathTmux()).toBe(tmuxBin); expect(h.env.TMUX_TMPDIR.startsWith(dirname(h.env.HOME))).toBe(true)
      expect(h.sentinel.requests).toEqual([]); expect(server.requestsFor("0.1.1") + server.requestsFor("0.1.2")).toBeGreaterThan(0)
      console.log("production-bin-no-override=PASS setup doctor reuse update old-popup new-popup doctor uninstall: PASS public-network-requests=0 real-home-writes=0 default-tmux-uses=0")
    } finally { await harnessTmux(["kill-server"]).catch(() => undefined); guard(); await server.close() }
  } finally { await rm(fixtureRoot, { recursive: true, force: true }); await h.cleanup(); await rm(packed.output, { recursive: true, force: true }) }
}, 240_000)
