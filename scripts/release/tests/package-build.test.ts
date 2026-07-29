import { expect, test } from "bun:test"
import { cp, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { canonicalJson } from "../canonical-json"
import { buildPackages, parsePackageBuildArgs } from "../package-build"
import { verifyPackages } from "../verify-artifacts"

const root = process.cwd()
const outputPaths = [
  "packages/tmux-pane-dash/generated/release-manifest.json",
  "packages/tmux-pane-dash/dist/cli.js",
  "packages/tmux-pane-dash/dist/runtime.js",
  "opencode-plugin/dist/index.js",
] as const

async function copy(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true })
  await cp(source, destination, { recursive: true })
}

async function fixtureRoot(): Promise<string> {
  const fixture = await mkdtemp(join(tmpdir(), "tmux-pane-dash-package-build-test-"))
  await copy(join(root, "package.json"), join(fixture, "package.json"))
  await copy(join(root, "packages/tmux-pane-dash/src"), join(fixture, "packages/tmux-pane-dash/src"))
  for (const path of ["package.json", "README.md", "LICENSE", "generated/release-manifest.json", "dist/cli.js", "dist/runtime.js"]) {
    await copy(join(root, "packages/tmux-pane-dash", path), join(fixture, "packages/tmux-pane-dash", path))
  }
  await copy(join(root, "opencode-plugin/pane-dash.ts"), join(fixture, "opencode-plugin/pane-dash.ts"))
  await copy(join(root, "opencode-plugin/src"), join(fixture, "opencode-plugin/src"))
  for (const path of ["package.json", "README.md", "LICENSE", "dist/index.js"]) {
    await copy(join(root, "opencode-plugin", path), join(fixture, "opencode-plugin", path))
  }
  return fixture
}

async function expectedManifest(fixture: string, mutate?: (manifest: Record<string, any>) => void): Promise<{ path: string; bytes: Uint8Array; value: Record<string, any> }> {
  const value = JSON.parse(await readFile(join(root, "packages/tmux-pane-dash/generated/release-manifest.json"), "utf8")) as Record<string, any>
  for (const [index, asset] of Object.values(value.assets as Record<string, { sha256: string }>).entries()) asset.sha256 = String(index + 1).repeat(64)
  mutate?.(value)
  const bytes = canonicalJson(value)
  const path = join(fixture, "release-manifest.json")
  await writeFile(path, bytes)
  return { path, bytes, value }
}

async function snapshots(fixture: string): Promise<Uint8Array[]> {
  return Promise.all(outputPaths.map(path => readFile(join(fixture, path))))
}

async function assertNoTemporaryOutputs(fixture: string): Promise<void> {
  for (const directory of ["packages/tmux-pane-dash/generated", "packages/tmux-pane-dash/dist", "opencode-plugin/dist"]) {
    expect((await readdir(join(fixture, directory))).filter(name => name.includes("package-build")).sort()).toEqual([])
  }
}

test("package build accepts only the canonical release contract and exact four-asset inventory", async () => {
  const fixture = await fixtureRoot()
  try {
    const invalid = [
      { name: "wrong version", mutate: (manifest: Record<string, any>) => { manifest.version = "0.1.1"; manifest.tag = "v0.1.1"; for (const asset of Object.values(manifest.assets) as Array<Record<string, string>>) { asset.asset = asset.asset.replace("v0.1.0", "v0.1.1"); asset.url = asset.url.replace("/v0.1.0/", "/v0.1.1/").replace("v0.1.0-", "v0.1.1-") } } },
      { name: "wrong tag", mutate: (manifest: Record<string, any>) => { manifest.tag = "v0.1.1" } },
      { name: "wrong inventory", mutate: (manifest: Record<string, any>) => { delete manifest.assets["linux-x64"] } },
      { name: "wrong URL", mutate: (manifest: Record<string, any>) => { manifest.assets["darwin-arm64"].url = "https://example.test/release.tar.gz" } },
      { name: "wrong hash", mutate: (manifest: Record<string, any>) => { manifest.assets["darwin-arm64"].sha256 = "z".repeat(64) } },
    ]
    for (const candidate of invalid) {
      const expected = await expectedManifest(fixture, candidate.mutate)
      await expect(buildPackages({ root: fixture, releaseManifestPath: expected.path }), candidate.name).rejects.toThrow()
    }

    const nonCanonical = await expectedManifest(fixture)
    await writeFile(nonCanonical.path, JSON.stringify(nonCanonical.value, null, 2) + "\n")
    await expect(buildPackages({ root: fixture, releaseManifestPath: nonCanonical.path })).rejects.toThrow("not canonical")
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test("package build atomically publishes exact outputs, embeds every release identity, and rejects production no-ops", async () => {
  const fixture = await fixtureRoot()
  try {
    const expected = await expectedManifest(fixture)
    await buildPackages({ root: fixture, releaseManifestPath: expected.path, requireChange: true })
    expect(await readFile(join(fixture, outputPaths[0]!))).toEqual(expected.bytes)
    const cli = await readFile(join(fixture, outputPaths[1]!), "utf8")
    expect(cli).toContain("0.1.0")
    expect(cli).toContain("v0.1.0")
    for (const asset of Object.values(expected.value.assets) as Array<{ asset: string; url: string; sha256: string }>) {
      expect(cli).toContain(asset.asset)
      expect(cli).toContain(asset.url)
      expect(cli).toContain(asset.sha256)
    }
    const directBuild = await mkdtemp(join(tmpdir(), "tmux-pane-dash-direct-build-test-"))
    try {
      for (const [entry, filename] of [["cli.ts", "cli.js"], ["runtime.ts", "runtime.js"]] as const) {
        const child = Bun.spawn([process.execPath, "build", join("packages/tmux-pane-dash/src", entry), "--outfile", join(directBuild, filename), "--target=node", "--format=esm"], { cwd: fixture, stdout: "pipe", stderr: "pipe" })
        expect(await child.exited, filename).toBe(0)
        expect(await readFile(join(directBuild, filename))).toEqual(await readFile(join(fixture, "packages/tmux-pane-dash/dist", filename)))
      }
    } finally {
      await rm(directBuild, { recursive: true, force: true })
    }
    const published = await snapshots(fixture)
    await expect(buildPackages({ root: fixture, releaseManifestPath: expected.path, requireChange: true })).rejects.toThrow("no-op")
    expect(await snapshots(fixture)).toEqual(published)
    await assertNoTemporaryOutputs(fixture)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test("package build leaves all committed outputs unchanged and cleans temporary files after a bundle failure", async () => {
  const fixture = await fixtureRoot()
  try {
    const expected = await expectedManifest(fixture)
    const before = await snapshots(fixture)
    await writeFile(join(fixture, "opencode-plugin/pane-dash.ts"), "export const broken = ;\n")
    await expect(buildPackages({ root: fixture, releaseManifestPath: expected.path })).rejects.toThrow()
    expect(await snapshots(fixture)).toEqual(before)
    await assertNoTemporaryOutputs(fixture)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test("package-build flag parsing rejects malformed and duplicate flags", () => {
  expect(parsePackageBuildArgs(["--release-manifest", "manifest.json"])).toEqual({ releaseManifestPath: "manifest.json", requireChange: false })
  expect(parsePackageBuildArgs(["--require-change", "--release-manifest", "manifest.json"])).toEqual({ releaseManifestPath: "manifest.json", requireChange: true })
  for (const args of [
    [],
    ["--release-manifest"],
    ["--release-manifest", "one", "--release-manifest", "two"],
    ["--require-change", "--require-change", "--release-manifest", "manifest.json"],
    ["--release-manifest=manifest.json"],
    ["--release-manifest", "--require-change"],
    ["--unknown", "manifest.json"],
  ]) expect(() => parsePackageBuildArgs(args)).toThrow("usage")
})

async function nodeTool(name: string): Promise<string> {
  const path = Bun.which(name)
  if (!path) throw new Error(`${name} is unavailable`)
  return path
}

async function npmTool(node: string): Promise<string> {
  const candidate = await nodeTool("npm")
  const probe = Bun.spawn([node, candidate, "--version"], { stdout: "pipe", stderr: "pipe" })
  if (await probe.exited === 0) return candidate
  const roots = [dirname(dirname(node)), dirname(dirname(candidate))]
  for (const path of roots.map(base => join(base, "lib", "node_modules", "npm", "bin", "npm-cli.js"))) {
    const direct = Bun.spawn([node, path, "--version"], { stdout: "pipe", stderr: "pipe" })
    if (await direct.exited === 0) return path
  }
  throw new Error("npm CLI is unavailable")
}

async function withNpmEnvironment<T>(callback: () => Promise<T>): Promise<T> {
  const previous = { node: process.env.NODE_20_BIN, npm: process.env.NPM_20_CLI }
  process.env.NODE_20_BIN = await nodeTool("node")
  process.env.NPM_20_CLI = await npmTool(process.env.NODE_20_BIN)
  try {
    return await callback()
  } finally {
    if (previous.node === undefined) delete process.env.NODE_20_BIN
    else process.env.NODE_20_BIN = previous.node
    if (previous.npm === undefined) delete process.env.NPM_20_CLI
    else process.env.NPM_20_CLI = previous.npm
  }
}

test("verifyPackages binds source and packed manifests and all packed CLI identities to the expected release", async () => {
  const fixture = await fixtureRoot()
  try {
    const expected = await expectedManifest(fixture)
    await buildPackages({ root: fixture, releaseManifestPath: expected.path })
    await withNpmEnvironment(async () => {
      await expect(verifyPackages(fixture, expected.path)).resolves.toBeUndefined()
      const wrong = await expectedManifest(fixture, manifest => { manifest.assets["linux-x64"].sha256 = "f".repeat(64) })
      await expect(verifyPackages(fixture, wrong.path)).rejects.toThrow("source generated")
      await writeFile(expected.path, expected.bytes)
      await writeFile(join(fixture, "packages/tmux-pane-dash/generated/release-manifest.json"), expected.bytes)

      const realNpm = process.env.NPM_20_CLI!
      const mutatingNpm = join(fixture, "mutating-npm.cjs")
      await writeFile(mutatingNpm, `const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const real = childProcess.spawnSync(process.execPath, [process.env.REAL_NPM, ...process.argv.slice(2)], { encoding: "utf8" });
process.stderr.write(real.stderr || "");
if (real.status !== 0) { process.stdout.write(real.stdout || ""); process.exit(real.status || 1); }
const metadata = JSON.parse(real.stdout);
const filename = metadata[0].filename;
const destinationIndex = process.argv.indexOf("--pack-destination");
const destination = destinationIndex >= 0 ? process.argv[destinationIndex + 1] : process.cwd();
const archive = path.isAbsolute(filename) ? filename : path.join(destination, filename);
const extracted = fs.mkdtempSync(path.join(os.tmpdir(), "package-build-tar-") );
try {
  childProcess.execFileSync("tar", ["-xzf", archive, "-C", extracted]);
  fs.writeFileSync(path.join(extracted, "package", "generated", "release-manifest.json"), "{}\\n");
  childProcess.execFileSync("tar", ["-czf", archive, "-C", extracted, "package"]);
} finally { fs.rmSync(extracted, { recursive: true, force: true }); }
process.stdout.write(real.stdout);
`, { mode: 0o700 })
      process.env.REAL_NPM = realNpm
      process.env.NPM_20_CLI = mutatingNpm
      await expect(verifyPackages(fixture, expected.path)).rejects.toThrow("packed generated")
      process.env.NPM_20_CLI = realNpm
      delete process.env.REAL_NPM

      const staleCli = await readFile(join(fixture, "packages/tmux-pane-dash/dist/cli.js"), "utf8")
      await writeFile(join(fixture, "packages/tmux-pane-dash/dist/cli.js"), staleCli.replace(expected.value.assets["darwin-arm64"].sha256, "0".repeat(64)))
      await expect(verifyPackages(fixture, expected.path)).rejects.toThrow("packed CLI")
    })
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test("verify-artifacts package mode rejects malformed and duplicate manifest flags", async () => {
  const script = join(root, "scripts/release/verify-artifacts.ts")
  for (const args of [
    ["--packages", "--release-manifest"],
    ["--packages", "--release-manifest", "one", "--release-manifest", "two"],
    ["--release-manifest", "one", "--packages"],
  ]) {
    const child = Bun.spawn([process.execPath, script, ...args], { stdout: "pipe", stderr: "pipe" })
    expect(await child.exited, args.join(" ")).not.toBe(0)
  }
})
