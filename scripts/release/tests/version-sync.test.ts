import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { inspectVersions } from "../version-sync"

const repoFixture = () => process.cwd()

const mitLicense = `MIT License

Copyright (c) 2026 xiopt
`

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value)}\n`)
}

async function synchronizedFixture(version = "0.1.0") {
  const root = await mkdtemp(join(tmpdir(), "pane-dash-version-sync-"))
  await writeFile(join(root, "VERSION"), `${version}\n`)
  await writeFile(join(root, "LICENSE"), mitLicense)
  await writeJson(join(root, "package.json"), {
    name: "tmux-pane-dash-workspace",
    private: true,
    version,
    packageManager: "bun@1.3.14",
    workspaces: ["packages/*", "opencode-plugin"],
    scripts: {
      test: "bun test scripts/release/tests opencode-plugin/tests",
      "version:check": "bun scripts/release/version-sync.ts --check",
    },
  })
  await mkdir(join(root, "pane-dash"), { recursive: true })
  await writeFile(join(root, "pane-dash", "Cargo.toml"), `[package]\nname = "pane-dash"\nversion = "${version}"\n`)
  await writeFile(join(root, "pane-dash", "Cargo.lock"), `version = 4\n\n[[package]]\nname = "pane-dash"\nversion = "${version}"\n`)
  await writeJson(join(root, "opencode-plugin", "package.json"), {
    name: "@xiopt/pane-dash-opencode",
    version,
  })
  return root
}

test("application release identities are exactly synchronized", async () => {
  const result = await inspectVersions(repoFixture())
  expect(result).toEqual({ version: "0.1.8", tag: "v0.1.8", mismatches: [] })
})

test("reports shared contract VERSION and TAG mismatches", async () => {
  const root = await synchronizedFixture()
  await writeFile(join(root, "VERSION"), "0.1.3\n")
  await writeJson(join(root, "package.json"), { version: "0.1.3" })
  await writeFile(join(root, "pane-dash", "Cargo.toml"), '[package]\nname = "pane-dash"\nversion = "0.1.3"\n')
  await writeFile(join(root, "pane-dash", "Cargo.lock"), 'version = 4\n\n[[package]]\nname = "pane-dash"\nversion = "0.1.3"\n')
  await writeJson(join(root, "opencode-plugin", "package.json"), { version: "0.1.3" })

  await expect(inspectVersions(root)).resolves.toMatchObject({
    version: "0.1.3",
    tag: "v0.1.3",
    mismatches: [
      "scripts/release/contracts.ts: VERSION 0.1.8 !== VERSION 0.1.3",
      "scripts/release/contracts.ts: TAG v0.1.8 !== v0.1.3",
    ],
  })
})

test("requires root identity files even when VERSION exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "pane-dash-version-sync-"))
  await writeFile(join(root, "VERSION"), "0.1.0\n")

  await expect(inspectVersions(root)).resolves.toMatchObject({
    mismatches: [
      "scripts/release/contracts.ts: VERSION 0.1.8 !== VERSION 0.1.0",
      "scripts/release/contracts.ts: TAG v0.1.8 !== v0.1.0",
      "package.json: missing",
      "pane-dash/Cargo.toml: missing",
      "pane-dash/Cargo.lock: missing",
    ],
  })
})

test("requires VERSION", async () => {
  const root = await synchronizedFixture()
  await Bun.file(join(root, "VERSION")).delete()

  expect((await inspectVersions(root)).mismatches).toContain("VERSION: missing")
})

test("OpenCode package is publishable and dependency-free", async () => {
  const pkg = JSON.parse(await readFile(join(repoFixture(), "opencode-plugin/package.json"), "utf8"))
  expect(pkg).toMatchObject({
    name: "@xiopt/pane-dash-opencode",
    version: "0.1.8",
    type: "module",
    main: "./dist/index.js",
    engines: { opencode: ">=1.17.20" },
    files: ["dist/index.js", "dist/tui.js", "README.md", "LICENSE"],
  })
  expect(pkg.exports).toEqual({ ".": "./dist/index.js", "./server": "./dist/index.js", "./tui": "./dist/tui.js" })
  expect(pkg.repository).toEqual({ type: "git", url: "git+https://github.com/xiopt/tmux-pane-dash.git" })
  expect(pkg.dependencies ?? {}).toEqual({})
  expect(pkg.private).toBeUndefined()
  expect(pkg.postinstall).toBeUndefined()
})

test("--check reports mismatches without rewriting files", async () => {
  const root = await synchronizedFixture()
  const versionPath = join(root, "VERSION")
  await writeFile(versionPath, "0.1.1\n")

  const child = Bun.spawn([process.execPath, join(import.meta.dir, "..", "version-sync.ts"), "--check"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(await child.exited).toBe(1)
  expect(await new Response(child.stderr).text()).toContain("package.json: version 0.1.0 !== VERSION 0.1.1")
  expect(await readFile(versionPath, "utf8")).toBe("0.1.1\n")
})

test("accepts historical packed tags, the loose current tag, duplicates, and non-v tags", async () => {
  const root = await synchronizedFixture("0.1.8")
  await mkdir(join(root, ".git", "refs", "tags"), { recursive: true })
  await writeFile(join(root, ".git", "refs", "tags", "v0.1.8"), "current\n")
  await writeFile(join(root, ".git", "packed-refs"), [
    "# pack-refs with: peeled fully-peeled",
    `${"a".repeat(40)} refs/tags/v0.1.0`,
    `${"b".repeat(40)} refs/tags/v0.1.8`,
    `^${"c".repeat(40)}`,
    `${"d".repeat(40)} refs/tags/release-not-a-version`,
    "",
  ].join("\n"))

  await expect(inspectVersions(root)).resolves.toEqual({ version: "0.1.8", tag: "v0.1.8", mismatches: [] })
})

test("rejects malformed and future v tags while retaining historical parity", async () => {
  const root = await synchronizedFixture("0.1.8")
  await mkdir(join(root, ".git", "refs", "tags"), { recursive: true })
  await writeFile(join(root, ".git", "refs", "tags", "v0.1"), "malformed\n")
  await writeFile(join(root, ".git", "packed-refs"), `${"a".repeat(40)} refs/tags/v0.1.0\n${"b".repeat(40)} refs/tags/v0.1.9\n`)

  await expect(inspectVersions(root)).resolves.toMatchObject({
    version: "0.1.8",
    tag: "v0.1.8",
    mismatches: [
      "tag v0.1: malformed v tag; expected v<major>.<minor>.<patch>",
      "tag v0.1.9: future tag is newer than VERSION 0.1.8",
    ],
  })
})

test("checks optional package, tag, and generated manifests when present", async () => {
  const root = await synchronizedFixture()
  await writeJson(join(root, "packages", "tmux-pane-dash", "package.json"), {
    name: "@xiopt/tmux-pane-dash",
    version: "0.1.1",
  })
  await writeJson(join(root, "packages", "tmux-pane-dash", "generated", "release-manifest.json"), {
    version: "0.1.1",
    tag: "v0.1.1",
  })
  await writeJson(join(root, "release", "archive", "manifest.json"), { version: "0.1.1" })
  await writeJson(join(root, "release", "release-manifest.json"), { version: "0.1.1", tag: "v0.1.1" })
  await mkdir(join(root, ".git", "refs", "tags"), { recursive: true })
  await writeFile(join(root, ".git", "refs", "tags", "v0.1.1"), "fixture\n")

  await expect(inspectVersions(root)).resolves.toEqual({
    version: "0.1.0",
    tag: "v0.1.0",
    mismatches: [
      "scripts/release/contracts.ts: VERSION 0.1.8 !== VERSION 0.1.0",
      "scripts/release/contracts.ts: TAG v0.1.8 !== v0.1.0",
      "packages/tmux-pane-dash/package.json: version 0.1.1 !== VERSION 0.1.0",
      "packages/tmux-pane-dash/generated/release-manifest.json: version 0.1.1 !== VERSION 0.1.0",
      "packages/tmux-pane-dash/generated/release-manifest.json: tag v0.1.1 !== v0.1.0",
      "release/archive/manifest.json: version 0.1.1 !== VERSION 0.1.0",
      "release/release-manifest.json: version 0.1.1 !== VERSION 0.1.0",
      "release/release-manifest.json: tag v0.1.1 !== v0.1.0",
      "tag v0.1.1: future tag is newer than VERSION 0.1.0",
    ],
  })
})
