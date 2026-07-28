import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { assertDowngradeAllowed, compareVersions, runCli } from "../src/runtime"
import { nodeDependencies } from "../src/dependencies"
import { CliError } from "../src/errors"

const manifest = { schemaVersion: 1, repository: "xiopt/tmux-pane-dash", version: "0.1.0", tag: "v0.1.0", assets: {
  "darwin-arm64": { target: "aarch64-apple-darwin", asset: "tmux-pane-dash-v0.1.0-aarch64-apple-darwin.tar.gz", url: "https://github.com/xiopt/tmux-pane-dash/releases/download/v0.1.0/tmux-pane-dash-v0.1.0-aarch64-apple-darwin.tar.gz", sha256: "0".repeat(64), size: 1 },
  "darwin-x64": { target: "x86_64-apple-darwin", asset: "tmux-pane-dash-v0.1.0-x86_64-apple-darwin.tar.gz", url: "https://github.com/xiopt/tmux-pane-dash/releases/download/v0.1.0/tmux-pane-dash-v0.1.0-x86_64-apple-darwin.tar.gz", sha256: "1".repeat(64), size: 1 },
  "linux-arm64": { target: "aarch64-unknown-linux-musl", asset: "tmux-pane-dash-v0.1.0-aarch64-unknown-linux-musl.tar.gz", url: "https://github.com/xiopt/tmux-pane-dash/releases/download/v0.1.0/tmux-pane-dash-v0.1.0-aarch64-unknown-linux-musl.tar.gz", sha256: "2".repeat(64), size: 1 },
  "linux-x64": { target: "x86_64-unknown-linux-musl", asset: "tmux-pane-dash-v0.1.0-x86_64-unknown-linux-musl.tar.gz", url: "https://github.com/xiopt/tmux-pane-dash/releases/download/v0.1.0/tmux-pane-dash-v0.1.0-x86_64-unknown-linux-musl.tar.gz", sha256: "3".repeat(64), size: 1 },
} }

test("compares SemVer and applies the setup-only downgrade policy", () => {
  expect(compareVersions("0.1.0", "0.2.0")).toBe(-1)
  expect(compareVersions("0.2.0", "0.2.0")).toBe(0)
  expect(compareVersions("0.3.0", "0.2.0")).toBe(1)
  expect(() => assertDowngradeAllowed({ command: { name: "setup", tmux: true, opencode: true, migrate: false, allowDowngrade: false }, executingVersion: "0.1.0", ownedVersion: "0.2.0" })).toThrow(/E_DOWNGRADE/)
  expect(() => assertDowngradeAllowed({ command: { name: "update" }, executingVersion: "0.1.0", ownedVersion: "0.2.0" })).toThrow(/E_DOWNGRADE/)
  expect(() => assertDowngradeAllowed({ command: { name: "setup", tmux: true, opencode: true, migrate: false, allowDowngrade: true }, executingVersion: "0.1.0", ownedVersion: "0.2.0" })).not.toThrow()
})

test("returns usage before it can acquire a lock", async () => {
  let locked = false
  await expect(runCli([], { manifest, platform: "linux", arch: "x64", executingVersion: "0.1.0", lock: async () => { locked = true; return { token: "", recovered: false, release: async () => {} } } })).rejects.toThrow(CliError)
  expect(locked).toBe(false)
})

test("rejects unsupported platforms before any fetch", async () => {
  let fetched = false
  await expect(runCli(["setup"], { manifest, platform: "win32", arch: "x64", executingVersion: "0.1.0", fetch: () => { fetched = true } })).rejects.toThrow(CliError)
  expect(fetched).toBe(false)
})

test("rejects a release manifest that does not match the executing version before lock or fetch", async () => {
  const mismatchedManifest = { ...manifest, version: "0.1.1", tag: "v0.1.1", assets: Object.fromEntries(Object.entries(manifest.assets).map(([key, record]) => {
    const asset = record.asset.replaceAll("0.1.0", "0.1.1")
    return [key, { ...record, asset, url: record.url.replaceAll("0.1.0", "0.1.1") }]
  })) }
  for (const argv of [["setup"], ["update"]]) {
    let locked = false, fetched = false
    await expect(runCli(argv, { manifest: mismatchedManifest, platform: "linux", arch: "x64", executingVersion: "0.1.0", lock: async () => { locked = true; return { token: "", recovered: false, release: async () => {} } }, fetch: () => { fetched = true; throw new Error("unexpected fetch") } })).rejects.toThrow("E_VERSION")
    expect(locked).toBeFalse()
    expect(fetched).toBeFalse()
  }
})

test("runCli passes the exact mutation command to the lock and releases it after failure", async () => {
  const commands: string[] = [], released: string[] = []
  const deps = { manifest, platform: "linux" as const, arch: "x64" as const, executingVersion: "0.1.0", env: {}, lock: async (command: "setup" | "update" | "uninstall") => {
    commands.push(command)
    return { token: command, recovered: false, release: async () => { released.push(command) } }
  } }
  await expect(runCli(["uninstall"], deps)).rejects.toThrow("E_ROOT")
  expect(commands).toEqual(["uninstall"])
  expect(released).toEqual(["uninstall"])
})

test("runCli keeps doctor lock-free", async () => {
  let locked = false
  const output: string[] = []
  await expect(runCli(["doctor", "--json"], { manifest, platform: "linux", arch: "x64", executingVersion: "0.1.0", lock: async () => { locked = true; return { token: "", recovered: false, release: async () => {} } }, doctorOutput: text => { output.push(text) } })).resolves.toBe(1)
  expect(locked).toBeFalse()
  expect(output).toHaveLength(1)
})

test("packages the unexported runtime only as an absolute file module", async () => {
  const pkg = JSON.parse(await readFile(resolve(import.meta.dir, "..", "package.json"), "utf8"))
  expect(pkg.repository).toEqual({ type: "git", url: "git+https://github.com/xiopt/tmux-pane-dash.git" })
  expect(pkg.homepage).toBe("https://github.com/xiopt/tmux-pane-dash#readme")
  expect(pkg.bugs).toEqual({ url: "https://github.com/xiopt/tmux-pane-dash/issues" })
  expect(pkg.files).toEqual(["dist/cli.js", "dist/runtime.js", "generated/release-manifest.json", "README.md", "LICENSE"])
  expect(pkg.exports).toBeUndefined()
  await expect(import(pathToFileURL(resolve(import.meta.dir, "..", "dist", "runtime.js")).href)).resolves.toHaveProperty("runCli")
})

test("production dependencies and packed CLI construct and execute a command path", async () => {
  const deps = nodeDependencies()
  expect(deps.pid?.()).toBe(process.pid)
  expect(deps.lock).toBeFunction()
  const home = await mkdtemp(join(tmpdir(), "pane-dash-runtime-home-"))
  try {
    deps.env = { ...deps.env, XDG_DATA_HOME: home, HOME: home }
    const productionLock = deps.lock!, commands: string[] = [], releases: string[] = []
    deps.lock = async command => {
      commands.push(command)
      const handle = await productionLock(command)
      return { ...handle, release: async () => { await handle.release(); releases.push(command) } }
    }
    await expect(runCli(["uninstall"], deps)).resolves.toBe(0)
    expect(commands).toEqual(["uninstall"])
    expect(releases).toEqual(["uninstall"])
    expect(await Bun.file(join(home, "tmux-pane-dash", "transactions", "lock")).exists()).toBeFalse()
    await writeFile(join(home, "tmux-pane-dash", "unexpected"), "unsafe")
    await expect(runCli(["uninstall"], deps)).rejects.toThrow("E_CONFLICT")
    expect(releases).toEqual(["uninstall"])
    expect(await Bun.file(join(home, "tmux-pane-dash", "transactions", "lock")).exists()).toBeFalse()
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "..", "dist", "cli.js"), "doctor", "--json"], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH!, HOME: home } })
    expect(await child.exited).toBe(1)
    expect(JSON.parse(await new Response(child.stdout).text())).toMatchObject({ schemaVersion: 1, healthy: false })
    expect(await new Response(child.stderr).text()).toBe("")
  } finally { await rm(home, { recursive: true, force: true }) }
})
