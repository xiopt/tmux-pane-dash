import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
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
  await expect(runCli([], { manifest, platform: "linux", arch: "x64", executingVersion: "0.1.0", lock: () => { locked = true } })).rejects.toThrow(CliError)
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
    await expect(runCli(argv, { manifest: mismatchedManifest, platform: "linux", arch: "x64", executingVersion: "0.1.0", lock: () => { locked = true }, fetch: () => { fetched = true; throw new Error("unexpected fetch") } })).rejects.toThrow("E_VERSION")
    expect(locked).toBeFalse()
    expect(fetched).toBeFalse()
  }
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
  expect(nodeDependencies().pid?.()).toBe(process.pid)
  const home = await mkdtemp(join(tmpdir(), "pane-dash-runtime-home-"))
  try {
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "..", "dist", "cli.js"), "doctor", "--json"], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH!, HOME: home } })
    expect(await child.exited).toBe(1)
    expect(JSON.parse(await new Response(child.stdout).text())).toMatchObject({ schemaVersion: 1, healthy: false })
    expect(await new Response(child.stderr).text()).toBe("")
  } finally { await rm(home, { recursive: true, force: true }) }
})
