import { chmod, mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import type { ReleaseManifest } from "../../packages/tmux-pane-dash/src/contracts"
import { parseReleaseManifest } from "../../packages/tmux-pane-dash/src/manifest"
import { canonicalJson } from "./canonical-json"
import { assertPackedNodeBundle } from "./verify-artifacts"
import { TAG, VERSION } from "./contracts"

const decoder = new TextDecoder()

export type PackageBuildInput = {
  root: string
  releaseManifestPath: string
  requireChange?: boolean
}

export type PackageBuildArgs = {
  releaseManifestPath: string
  requireChange: boolean
}

type BuildTarget = "bun" | "node"

type ManifestPluginBuilder = {
  onLoad(options: { filter: RegExp }, callback: (args: { path: string }) => { contents: Uint8Array; loader: "json" } | undefined): void
}

type ReleaseManifestPlugin = {
  name: string
  setup(build: ManifestPluginBuilder): void
}

type BuiltFile = {
  target: string
  bytes: Uint8Array
  mode: number
}

type FileSnapshot = {
  bytes?: Uint8Array
  mode?: number
}

type BeforeRename = (index: number) => void | Promise<void>

function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT"
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right))
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function usage(): never {
  throw new Error("usage: package-build.ts --release-manifest PATH [--require-change]")
}

export function parsePackageBuildArgs(args: readonly string[]): PackageBuildArgs {
  let releaseManifestPath: string | undefined
  let requireChange = false

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === "--release-manifest") {
      if (releaseManifestPath !== undefined || index + 1 >= args.length || !args[index + 1] || args[index + 1]!.startsWith("--")) usage()
      releaseManifestPath = args[index + 1]
      index += 1
    } else if (argument === "--require-change") {
      if (requireChange) usage()
      requireChange = true
    } else {
      usage()
    }
  }

  if (!releaseManifestPath) usage()
  return { releaseManifestPath, requireChange }
}

async function readReleaseManifest(path: string): Promise<{ bytes: Uint8Array; manifest: ReleaseManifest }> {
  const bytes = new Uint8Array(await readFile(path))
  let value: unknown
  try {
    value = JSON.parse(decoder.decode(bytes))
  } catch {
    throw new Error("invalid release manifest JSON")
  }

  let manifest: ReleaseManifest
  try {
    manifest = parseReleaseManifest(value)
  } catch {
    throw new Error("invalid release manifest")
  }
  if (!sameBytes(bytes, canonicalJson(value))) throw new Error("release manifest is not canonical")
  if (manifest.version !== VERSION) throw new Error("release manifest version does not match release contract")
  if (manifest.tag !== TAG) throw new Error("release manifest tag does not match release contract")
  if (Object.keys(manifest.assets).length !== 4) throw new Error("release manifest requires exactly four assets")
  return { bytes, manifest }
}

export function createReleaseManifestPlugin(manifestPath: string, bytes: Uint8Array): ReleaseManifestPlugin {
  const withoutMacPrivatePrefix = (path: string) => path.startsWith("/private/") ? path.slice("/private".length) : path
  return {
    name: "verified-release-manifest",
    setup(build) {
      build.onLoad({ filter: /[\\/]generated[\\/]release-manifest\.json$/ }, ({ path }) => withoutMacPrivatePrefix(path) === withoutMacPrivatePrefix(manifestPath) ? { contents: bytes, loader: "json" } : undefined)
    },
  }
}

async function buildBundle(input: { entrypoint: string; outdir: string; filename: string; target: BuildTarget; format?: "esm"; plugins?: ReleaseManifestPlugin[] }): Promise<Uint8Array> {
  await mkdir(input.outdir, { recursive: true })
  const result = await Bun.build({
    entrypoints: [input.entrypoint],
    outdir: input.outdir,
    naming: input.filename,
    target: input.target,
    ...(input.format ? { format: input.format } : {}),
    ...(input.plugins ? { plugins: input.plugins } : {}),
  })
  if (!result.success || result.logs.length > 0) throw new Error(`${input.filename} bundle failed: ${result.logs.map(String).join("\n")}`)
  const output = join(input.outdir, input.filename)
  const bytes = new Uint8Array(await readFile(output))
  if (bytes.length === 0) throw new Error(`${input.filename} bundle is empty`)
  return bytes
}

function assertManifestIdentities(bundle: string, manifest: ReleaseManifest): void {
  for (const identity of [manifest.version, manifest.tag, ...Object.values(manifest.assets).flatMap(asset => [asset.asset, asset.url, asset.sha256])]) {
    if (!bundle.includes(identity)) throw new Error(`CLI bundle is missing release identity: ${identity}`)
  }
}

function assertNoBuildResidue(bundle: string, buildRoot: string, label: string): void {
  const marker = ["cli-source", "tmux-pane-dash-package-build-", buildRoot].find(value => bundle.includes(value))
  if (marker) throw new Error(`${label} bundle contains temporary build residue: ${marker}`)
}

async function snapshot(path: string): Promise<FileSnapshot> {
  try {
    const [bytes, info] = await Promise.all([readFile(path), stat(path)])
    return { bytes: new Uint8Array(bytes), mode: info.mode & 0o7777 }
  } catch (error) {
    if (missing(error)) return {}
    throw error
  }
}

async function restore(path: string, previous: FileSnapshot): Promise<void> {
  if (previous.bytes === undefined || previous.mode === undefined) {
    await rm(path, { force: true })
    return
  }
  const temporary = join(dirname(path), `.${basename(path)}.package-build-restore-${crypto.randomUUID()}`)
  try {
    await writeFile(temporary, previous.bytes, { mode: previous.mode })
    await chmod(temporary, previous.mode)
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function publishAtomically(files: readonly BuiltFile[], requireChange: boolean, beforeRename?: BeforeRename): Promise<void> {
  const previous = await Promise.all(files.map(file => snapshot(file.target)))
  if (requireChange && files.every((file, index) => previous[index]!.bytes !== undefined && previous[index]!.mode === file.mode && sameBytes(previous[index]!.bytes!, file.bytes))) throw new Error("package build would be a no-op")

  const temporary: Array<string | undefined> = []
  const published: number[] = []
  try {
    for (const file of files) {
      await mkdir(dirname(file.target), { recursive: true })
      const path = join(dirname(file.target), `.${basename(file.target)}.package-build-${crypto.randomUUID()}`)
      temporary.push(path)
      await writeFile(path, file.bytes, { mode: file.mode })
      await chmod(path, file.mode)
    }
    for (let index = 0; index < files.length; index += 1) {
      const path = temporary[index]
      if (!path) throw new Error("package build temporary output is missing")
      await beforeRename?.(index)
      await rename(path, files[index]!.target)
      temporary[index] = undefined
      published.push(index)
    }
    for (const file of files) {
      const [bytes, info] = await Promise.all([readFile(file.target), stat(file.target)])
      if (!sameBytes(new Uint8Array(bytes), file.bytes) || (info.mode & 0o7777) !== file.mode) throw new Error(`published output differs: ${file.target}`)
    }
  } catch (error) {
    let rollbackError: unknown
    for (const index of published.reverse()) {
      try {
        await restore(files[index]!.target, previous[index]!)
      } catch (restoreError) {
        rollbackError ??= restoreError
      }
    }
    if (rollbackError) throw new Error(`package build publication failed and rollback failed: ${String(rollbackError)}`)
    throw error
  } finally {
    await Promise.all(temporary.filter((path): path is string => path !== undefined).map(path => rm(path, { force: true })))
  }
}

/** Test-only fault-injection seam for proving rollback restores the preimage. */
export async function publishAtomicallyForTest(files: readonly BuiltFile[], failAt: number): Promise<void> {
  await publishAtomically(files, false, index => { if (index === failAt) throw new Error("forced publish failure") })
}

export async function buildPackages(input: PackageBuildInput): Promise<void> {
  const release = await readReleaseManifest(input.releaseManifestPath)
  const payload = release.manifest.assets["darwin-arm64"]
  const payloadBytes = new Uint8Array(await readFile(join(dirname(resolve(input.releaseManifestPath)), payload.asset)))
  if (payloadBytes.length !== payload.size || sha256(payloadBytes) !== payload.sha256) throw new Error("darwin-arm64 package payload differs from release manifest")
  const root = resolve(input.root)
  const packageRoot = join(root, "packages", "tmux-pane-dash")
  const buildRoot = await mkdtemp(join(tmpdir(), "tmux-pane-dash-package-build-"))
  try {
    const manifestPath = join(packageRoot, "generated", "release-manifest.json")
    const manifestPlugin = createReleaseManifestPlugin(manifestPath, release.bytes)
    const nodeBundleDirectory = join(buildRoot, "node")
    const cli = await buildBundle({ entrypoint: join(packageRoot, "src", "cli.ts"), outdir: nodeBundleDirectory, filename: "cli.js", target: "node", format: "esm", plugins: [manifestPlugin] })
    const runtime = await buildBundle({ entrypoint: join(packageRoot, "src", "runtime.ts"), outdir: nodeBundleDirectory, filename: "runtime.js", target: "node", format: "esm", plugins: [manifestPlugin] })
    const opencode = await buildBundle({ entrypoint: join(root, "opencode-plugin", "pane-dash.ts"), outdir: join(buildRoot, "opencode"), filename: "index.js", target: "bun" })
    const opencodeTui = await buildBundle({ entrypoint: join(root, "opencode-plugin", "tui.ts"), outdir: join(buildRoot, "opencode-tui"), filename: "tui.js", target: "bun" })

    const cliText = decoder.decode(cli), runtimeText = decoder.decode(runtime)
    assertNoBuildResidue(cliText, buildRoot, "CLI")
    assertNoBuildResidue(runtimeText, buildRoot, "runtime")
    assertNoBuildResidue(decoder.decode(opencode), buildRoot, "OpenCode")
    assertNoBuildResidue(decoder.decode(opencodeTui), buildRoot, "OpenCode TUI")
    assertPackedNodeBundle(cliText)
    assertPackedNodeBundle(runtimeText)
    assertManifestIdentities(cliText, release.manifest)

    await publishAtomically([
      { target: join(packageRoot, "generated", "release-manifest.json"), bytes: release.bytes, mode: 0o644 },
      { target: join(packageRoot, "payload", payload.asset), bytes: payloadBytes, mode: 0o644 },
      { target: join(packageRoot, "dist", "cli.js"), bytes: cli, mode: 0o755 },
      { target: join(packageRoot, "dist", "runtime.js"), bytes: runtime, mode: 0o644 },
      { target: join(root, "opencode-plugin", "dist", "index.js"), bytes: opencode, mode: 0o644 },
      { target: join(root, "opencode-plugin", "dist", "tui.js"), bytes: opencodeTui, mode: 0o644 },
    ], input.requireChange === true)
  } finally {
    await rm(buildRoot, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  await buildPackages({ root: process.cwd(), ...parsePackageBuildArgs(process.argv.slice(2)) })
  console.log("packages=2 manifest=exact bundles=staged PASS")
}
