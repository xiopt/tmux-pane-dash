import { expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  SOURCE_ARCHIVE_PREFIX,
  SOURCE_EXECUTABLES,
  SOURCE_MANIFEST,
  SOURCE_ROOTS,
  buildSourceArchive,
  collectSourceManifest,
  inspectSourceArchive,
  sourceArchiveName,
  sourceManifestDigest,
} from "../source-manifest"

const fileRoots = new Set([".gitignore", "LICENSE", "Makefile", "README.md", "VERSION", "bun.lock", "package.json", "pane_dash.tmux"])
const allDirectories = SOURCE_ROOTS.filter((path) => !fileRoots.has(path))
const sensitiveNames = [".env", ".env.local", ".npmrc", "credentials.json", "password.txt", "secret.json", "token.txt", "auth-material.json"] as const
const sensitivePathCases = sensitiveNames.flatMap((name) => [
  { scope: "top-level", path: name, kind: "file" as const },
  { scope: "nested", path: `packages/tmux-pane-dash/src/${name}`, kind: "directory" as const },
])
const benignNearMisses = ["tokenizer.ts", "authentication.ts", "author.ts", "secretary.md", "passwordless.txt"] as const

async function writeFixture(root: string): Promise<void> {
  for (const path of allDirectories) await mkdir(join(root, path), { recursive: true })
  await mkdir(join(root, ".github", "workflows"), { recursive: true })
  for (const path of SOURCE_ROOTS.filter((entry) => fileRoots.has(entry))) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), `${path}\n`)
  }
  for (const workflow of ["ci.yml", "opencode-weekly.yml", "release.yml"]) await writeFile(join(root, ".github", "workflows", workflow), `${workflow}\n`)
  await mkdir(join(root, "docs", "committed"), { recursive: true })
  await writeFile(join(root, "docs", "committed", "guide.md"), "committed documentation\n")
  await writeFile(join(root, "scripts", "open.sh"), "#!/bin/sh\n")
  await chmod(join(root, "scripts", "open.sh"), 0o755)
  await writeFile(join(root, "pane_dash.tmux"), "run-shell true\n")
  await chmod(join(root, "pane_dash.tmux"), 0o755)
}

async function temporaryFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tmux-pane-dash-source-test-"))
  await writeFixture(root)
  return root
}

test("the source manifest names the approved roots and executable policy", async () => {
  expect(SOURCE_MANIFEST).toEqual(SOURCE_ROOTS)
  expect(SOURCE_ROOTS).toEqual([
    ".github",
    ".gitignore",
    "LICENSE",
    "Makefile",
    "README.md",
    "VERSION",
    "bun.lock",
    "package.json",
    "docs",
    "opencode-plugin",
    "packages",
    "pane-dash",
    "pane_dash.tmux",
    "release",
    "scripts",
    "spike",
    "tests",
    "tools",
  ])
  expect(SOURCE_EXECUTABLES).toContain("scripts/release/clean-room.sh")
  expect(SOURCE_EXECUTABLES).toContain("scripts/release/ci-tmux.sh")
  expect(SOURCE_EXECUTABLES).toContain("scripts/release/public-smoke.sh")
  expect(SOURCE_EXECUTABLES).toContain("tests/source_package.sh")
  expect(SOURCE_EXECUTABLES).not.toContain("packages/tmux-pane-dash/dist/cli.js")
})

test("the checked-in tree includes committed source roots and docs but no generated output", async () => {
  const entries = await collectSourceManifest(process.cwd())
  const paths = entries.map((entry) => entry.path)

  for (const path of SOURCE_ROOTS) expect(paths.some((entry) => entry === path || entry.startsWith(`${path}/`))).toBe(true)
  expect(paths).toContain("docs/superpowers/specs/2026-07-23-v0.1-release-distribution-design.md")
  expect(paths).toContain("scripts/release/clean-room.sh")
  expect(paths).toContain("scripts/release/ci-tmux.sh")
  expect(paths).toContain(".github/workflows/ci.yml")
  expect(paths).toContain(".github/workflows/opencode-weekly.yml")
  expect(paths).toContain(".github/workflows/release.yml")
  expect(paths).toContain("release/verify-npm-provenance.ts")
  expect(paths).toContain("release/tests/verify-npm-provenance.test.ts")
  expect(entries.find((entry) => entry.path === "scripts/release/ci-tmux.sh")?.mode).toBe("0755")
  expect(paths).toContain("packages/tmux-pane-dash/src/cli.ts")
  expect(paths).toContain("opencode-plugin/src/state.ts")
  expect(paths.some((path) => path.includes("/dist/") || path.endsWith("/target") || path.includes("/target/"))).toBe(false)
  expect(paths.some((path) => path.startsWith("release/dist/") || path.startsWith("release\\dist\\"))).toBe(false)
})

test("Task14 source packaging requires the three workflows and warms one disposable cache", async () => {
  const script = await readFile(join(process.cwd(), "tests/source_package.sh"), "utf8")
  expect(script).toContain("MANIFEST=(.github .gitignore LICENSE Makefile README.md VERSION bun.lock package.json docs opencode-plugin packages pane-dash pane_dash.tmux release scripts spike tests tools)")
  expect(script).toContain("ci.yml opencode-weekly.yml release.yml")
  expect(script).toContain("release/verify-npm-provenance.ts")
  expect(script).toContain("release/tests/verify-npm-provenance.test.ts")
  expect(script).toContain("BUN_INSTALL_CACHE_DIR=\"$warm_cache\"")
  expect(script).toContain("npm_config_cache=\"$warm_cache\"")
  expect(script).toContain("--offline")
  expect(script).not.toContain(".github is intentionally rejected")
  expect(script).not.toMatch(/fail ['\"]source archive contains generated release\/dist/)
})

test("source manifest excludes present generated release/dist instead of rejecting its presence", async () => {
  const root = await temporaryFixture()
  try {
    await mkdir(join(root, "release", "dist"), { recursive: true })
    await writeFile(join(root, "release", "dist", "generated.mjs"), "generated\n")
    const paths = (await collectSourceManifest(root)).map((entry) => entry.path)
    expect(paths).not.toContain("release/dist")
    expect(paths.some((path) => path.startsWith("release/dist/"))).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("source archives are byte-identical across roots, with canonical root, paths, modes, order, and mtime", async () => {
  const left = await temporaryFixture()
  const right = await temporaryFixture()
  const outputLeft = join(await mkdtemp(join(tmpdir(), "tmux-pane-dash-source-out-")), "left.tar.gz")
  const outputRight = join(await mkdtemp(join(tmpdir(), "tmux-pane-dash-source-out-")), "right.tar.gz")
  try {
    await utimes(left, new Date(100), new Date(100))
    await utimes(right, new Date(200), new Date(200))
    await buildSourceArchive({ root: left, output: outputLeft, tag: "v0.1.0", epoch: 1_721_728_000 })
    await buildSourceArchive({ root: right, output: outputRight, tag: "v0.1.0", epoch: 1_721_728_000 })
    expect(await readFile(outputLeft)).toEqual(await readFile(outputRight))

    const inventory = await inspectSourceArchive(outputLeft, { tag: "v0.1.0", epoch: 1_721_728_000 })
    expect(inventory[0]).toMatchObject({ path: "tmux-pane-dash-v0.1.0", kind: "directory", mode: "0755", mtime: 1_721_728_000 })
    expect(inventory.some((entry) => entry.path === "tmux-pane-dash-v0.1.0/docs/committed/guide.md")).toBe(true)
    expect(inventory.map((entry) => entry.path)).toEqual([...inventory.map((entry) => entry.path)].sort((a, b) => Buffer.from(a).compare(Buffer.from(b))))
    expect(inventory.every((entry) => entry.mtime === 1_721_728_000)).toBe(true)
    expect(inventory.find((entry) => entry.path.endsWith("/pane_dash.tmux"))?.mode).toBe("0755")
  } finally {
    await rm(left, { recursive: true, force: true })
    await rm(right, { recursive: true, force: true })
  }
})

test("source archives omit generated output, Cargo target, release dist, and npm cache paths", async () => {
  const root = await temporaryFixture()
  const output = join(root, "source.tar.gz")
  try {
    await mkdir(join(root, "packages/tmux-pane-dash/dist"), { recursive: true })
    await writeFile(join(root, "packages/tmux-pane-dash/dist/cli.js"), "generated\n")
    await mkdir(join(root, "pane-dash/target/debug"), { recursive: true })
    await writeFile(join(root, "pane-dash/target/debug/pane-dash"), "generated\n")
    await mkdir(join(root, ".npm-cache"), { recursive: true })
    await writeFile(join(root, ".npm-cache/index"), "cache\n")
    await buildSourceArchive({ root, output, tag: "v0.1.0", epoch: 1_721_728_000 })
    const paths = (await inspectSourceArchive(output, { tag: "v0.1.0", epoch: 1_721_728_000 })).map((entry) => entry.path)
    expect(paths.some((path) => path.includes("/dist/") || path.includes("/target/") || path.includes(".npm-cache"))).toBe(false)

    await mkdir(join(root, ".github", "workflows"), { recursive: true })
    await writeFile(join(root, ".github", "workflows", "ci.yml"), "source workflow\n")
    await mkdir(join(root, "release", "dist"), { recursive: true })
    await writeFile(join(root, "release", "dist", "generated.mjs"), "generated\n")
    await buildSourceArchive({ root, output, tag: "v0.1.0", epoch: 1_721_728_000 })
    const updatedPaths = (await inspectSourceArchive(output, { tag: "v0.1.0", epoch: 1_721_728_000 })).map((entry) => entry.path)
    expect(updatedPaths).toContain("tmux-pane-dash-v0.1.0/.github/workflows/ci.yml")
    expect(updatedPaths.some((path) => path.includes("/release/dist/"))).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("source manifests reject sensitive files and directories before any exclusion", async () => {
  for (const testCase of [
    ...sensitivePathCases,
    { scope: "nested archive", path: "packages/tmux-pane-dash/src/token.tar.gz", kind: "file" as const },
  ]) {
    const root = await temporaryFixture()
    try {
      const absolute = join(root, testCase.path)
      if (testCase.kind === "directory") await mkdir(absolute, { recursive: true })
      else {
        await mkdir(dirname(absolute), { recursive: true })
        await writeFile(absolute, "sensitive\n")
      }
      await expect(collectSourceManifest(root)).rejects.toThrow(`sensitive source path: ${testCase.path}`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test("source manifests retain benign near-miss names", async () => {
  const root = await temporaryFixture()
  try {
    for (const name of benignNearMisses) await writeFile(join(root, "scripts", name), "ordinary source\n")
    const paths = (await collectSourceManifest(root)).map((entry) => entry.path)
    for (const name of benignNearMisses) expect(paths).toContain(`scripts/${name}`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("source archives reject an executable that is not in the explicit mode allowlist", async () => {
  const root = await temporaryFixture()
  try {
    const path = join(root, "docs", "unlisted.sh")
    await writeFile(path, "#!/bin/sh\n")
    await chmod(path, 0o755)
    await expect(collectSourceManifest(root)).rejects.toThrow("unlisted executable")

    await rm(path)
    await chmod(join(root, "scripts/open.sh"), 0o744)
    await expect(collectSourceManifest(root)).rejects.toThrow("0755")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("source manifest digest and archive names are canonical", async () => {
  const root = await temporaryFixture()
  try {
    const digest = await sourceManifestDigest(root)
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    expect(sourceArchiveName("v0.1.0")).toBe(`${SOURCE_ARCHIVE_PREFIX}v0.1.0-source.tar.gz`)
    expect(() => sourceArchiveName("0.1.0")).toThrow("tag")
    expect(await stat(root)).toMatchObject({ isDirectory: expect.any(Function) })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
