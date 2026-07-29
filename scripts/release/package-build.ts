import { cp, chmod, mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import type { ReleaseManifest } from "../../packages/tmux-pane-dash/src/contracts"
import { parseReleaseManifest } from "../../packages/tmux-pane-dash/src/manifest"
import { canonicalJson } from "./canonical-json"
import { assertPackedNodeBundle } from "./verify-artifacts"
import { TAG, VERSION } from "./contracts"

const decoder = new TextDecoder()
const encoder = new TextEncoder()

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

type BuiltFile = {
  target: string
  bytes: Uint8Array
}

type FileSnapshot = {
  bytes?: Uint8Array
}

function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT"
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right))
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

async function buildBundle(input: { entrypoint: string; outdir: string; filename: string; target: BuildTarget; format?: "esm" }): Promise<Uint8Array> {
  await mkdir(input.outdir, { recursive: true })
  const result = await Bun.build({
    entrypoints: [input.entrypoint],
    outdir: input.outdir,
    naming: input.filename,
    target: input.target,
    ...(input.format ? { format: input.format } : {}),
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

function normalizeNodeBundle(bytes: Uint8Array, buildRoots: readonly string[]): Uint8Array {
  let text = decoder.decode(bytes)
  for (const root of buildRoots) {
    const relativeRoot = root.startsWith("/") ? root.slice(1) : root
    for (let depth = 256; depth >= 0; depth -= 1) text = text.replaceAll(`${"../".repeat(depth)}${relativeRoot}/cli-source/`, "packages/tmux-pane-dash/")
    text = text.replaceAll(`${root}/cli-source/`, "packages/tmux-pane-dash/")
  }
  return encoder.encode(text)
}

async function snapshot(path: string): Promise<FileSnapshot> {
  try {
    return { bytes: new Uint8Array(await readFile(path)) }
  } catch (error) {
    if (missing(error)) return {}
    throw error
  }
}

async function restore(path: string, previous: FileSnapshot): Promise<void> {
  if (previous.bytes === undefined) {
    await rm(path, { force: true })
    return
  }
  const temporary = join(dirname(path), `.${basename(path)}.package-build-restore-${crypto.randomUUID()}`)
  try {
    await writeFile(temporary, previous.bytes, { mode: 0o644 })
    await chmod(temporary, 0o644)
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function publishAtomically(files: readonly BuiltFile[], requireChange: boolean): Promise<void> {
  const previous = await Promise.all(files.map(file => snapshot(file.target)))
  if (requireChange && files.every((file, index) => previous[index]!.bytes !== undefined && sameBytes(previous[index]!.bytes!, file.bytes))) throw new Error("package build would be a no-op")

  const temporary: Array<string | undefined> = []
  const published: number[] = []
  try {
    for (const file of files) {
      await mkdir(dirname(file.target), { recursive: true })
      const path = join(dirname(file.target), `.${basename(file.target)}.package-build-${crypto.randomUUID()}`)
      temporary.push(path)
      await writeFile(path, file.bytes, { mode: 0o644 })
      await chmod(path, 0o644)
    }
    for (let index = 0; index < files.length; index += 1) {
      const path = temporary[index]
      if (!path) throw new Error("package build temporary output is missing")
      await rename(path, files[index]!.target)
      temporary[index] = undefined
      published.push(index)
    }
    for (const file of files) {
      if (!sameBytes(new Uint8Array(await readFile(file.target)), file.bytes)) throw new Error(`published output differs: ${file.target}`)
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

export async function buildPackages(input: PackageBuildInput): Promise<void> {
  const release = await readReleaseManifest(input.releaseManifestPath)
  const packageRoot = join(input.root, "packages", "tmux-pane-dash")
  const buildRoot = await mkdtemp(join(tmpdir(), "tmux-pane-dash-package-build-"))
  try {
    const canonicalBuildRoot = await realpath(buildRoot)
    const copiedSource = join(buildRoot, "cli-source", "src")
    await cp(join(packageRoot, "src"), copiedSource, { recursive: true })
    await mkdir(join(buildRoot, "cli-source", "generated"), { recursive: true })
    await writeFile(join(buildRoot, "cli-source", "generated", "release-manifest.json"), release.bytes, { mode: 0o644 })

    const nodeBundleDirectory = join(buildRoot, "node")
    const cli = normalizeNodeBundle(await buildBundle({ entrypoint: join(copiedSource, "cli.ts"), outdir: nodeBundleDirectory, filename: "cli.js", target: "node", format: "esm" }), [canonicalBuildRoot, buildRoot])
    const runtime = normalizeNodeBundle(await buildBundle({ entrypoint: join(copiedSource, "runtime.ts"), outdir: nodeBundleDirectory, filename: "runtime.js", target: "node", format: "esm" }), [canonicalBuildRoot, buildRoot])
    const opencode = await buildBundle({ entrypoint: join(input.root, "opencode-plugin", "pane-dash.ts"), outdir: join(buildRoot, "opencode"), filename: "index.js", target: "bun" })

    const cliText = decoder.decode(cli), runtimeText = decoder.decode(runtime)
    assertPackedNodeBundle(cliText)
    assertPackedNodeBundle(runtimeText)
    assertManifestIdentities(cliText, release.manifest)

    await publishAtomically([
      { target: join(packageRoot, "generated", "release-manifest.json"), bytes: release.bytes },
      { target: join(packageRoot, "dist", "cli.js"), bytes: cli },
      { target: join(packageRoot, "dist", "runtime.js"), bytes: runtime },
      { target: join(input.root, "opencode-plugin", "dist", "index.js"), bytes: opencode },
    ], input.requireChange === true)
  } finally {
    await rm(buildRoot, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  await buildPackages({ root: process.cwd(), ...parsePackageBuildArgs(process.argv.slice(2)) })
  console.log("packages=2 manifest=exact bundles=staged PASS")
}
