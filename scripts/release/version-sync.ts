import { readFile, readdir } from "node:fs/promises"
import { join, relative } from "node:path"
import { TAG, VERSION } from "./contracts"

type JsonRecord = Record<string, unknown>

export type VersionInspection = {
  version: string
  tag: string
  mismatches: string[]
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

async function readJson(path: string): Promise<JsonRecord | undefined> {
  const text = await readText(path)
  return text === undefined ? undefined : JSON.parse(text) as JsonRecord
}

async function packageVersion(path: string, display: string, version: string, mismatches: string[]) {
  const pkg = await readJson(path)
  if (pkg === undefined) {
    mismatches.push(`${display}: missing`)
    return
  }
  if (pkg.version !== version) mismatches.push(`${display}: version ${String(pkg.version)} !== VERSION ${version}`)
}

function cargoLockVersion(lock: string): string | undefined {
  const match = /\[\[package\]\]\s+name = "pane-dash"\s+version = "([^"]+)"/.exec(lock)
  return match?.[1]
}

async function filesNamed(root: string, names: ReadonlySet<string>): Promise<string[]> {
  const paths: string[] = []
  async function visit(directory: string) {
    let entries: Awaited<ReturnType<typeof readdir>>
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "target") continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && names.has(entry.name)) paths.push(path)
    }
  }
  await visit(root)
  return paths.sort()
}

type VersionParts = readonly [bigint, bigint, bigint]

function versionParts(value: string): VersionParts | undefined {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(value)
  return match ? [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)] : undefined
}

function compareVersions(left: VersionParts, right: VersionParts): -1 | 0 | 1 {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]! < right[index]!) return -1
    if (left[index]! > right[index]!) return 1
  }
  return 0
}

/** Read both Git ref stores: local checkouts may put the same tag in either. */
async function tagNames(root: string): Promise<string[]> {
  const tags = new Set<string>()
  async function visit(directory: string, prefix: string) {
    let entries: Awaited<ReturnType<typeof readdir>>
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
    for (const entry of entries) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path, name)
      else if (entry.isFile()) tags.add(name)
    }
  }

  await visit(join(root, ".git", "refs", "tags"), "")
  const packed = await readText(join(root, ".git", "packed-refs"))
  for (const line of packed?.split("\n") ?? []) {
    if (!line || line.startsWith("#") || line.startsWith("^")) continue
    const match = /^[0-9a-fA-F]{40}\s+refs\/tags\/(.+)$/.exec(line)
    if (match) tags.add(match[1]!)
  }
  return [...tags].sort()
}

export async function inspectVersions(root: string): Promise<VersionInspection> {
  const versionText = await readText(join(root, "VERSION"))
  const version = versionText?.endsWith("\n") ? versionText.slice(0, -1) : versionText ?? ""
  const tag = `v${version}`
  const mismatches: string[] = []
  if (versionText === undefined) mismatches.push("VERSION: missing")
  if (VERSION !== version) mismatches.push(`scripts/release/contracts.ts: VERSION ${VERSION} !== VERSION ${version}`)
  if (TAG !== tag) mismatches.push(`scripts/release/contracts.ts: TAG ${TAG} !== ${tag}`)

  await packageVersion(join(root, "package.json"), "package.json", version, mismatches)
  const cargoToml = await readText(join(root, "pane-dash", "Cargo.toml"))
  const cargoVersion = /^version = "([^"]+)"$/m.exec(cargoToml ?? "")?.[1]
  if (cargoToml === undefined) mismatches.push("pane-dash/Cargo.toml: missing")
  else if (cargoVersion !== version) mismatches.push(`pane-dash/Cargo.toml: version ${String(cargoVersion)} !== VERSION ${version}`)
  const cargoLock = await readText(join(root, "pane-dash", "Cargo.lock"))
  if (cargoLock === undefined) mismatches.push("pane-dash/Cargo.lock: missing")
  else {
    const lockVersion = cargoLockVersion(cargoLock)
    if (lockVersion !== version) mismatches.push(`pane-dash/Cargo.lock: pane-dash version ${String(lockVersion)} !== VERSION ${version}`)
  }

  for (const path of ["opencode-plugin/package.json", "packages/tmux-pane-dash/package.json"]) {
    const pkg = await readJson(join(root, path))
    if (pkg !== undefined && pkg.version !== version) mismatches.push(`${path}: version ${String(pkg.version)} !== VERSION ${version}`)
  }

  const manifests = await filesNamed(root, new Set(["manifest.json", "release-manifest.json"]))
  for (const path of manifests) {
    const manifest = await readJson(path)
    if (manifest === undefined) continue
    const display = relative(root, path)
    if (manifest.version !== version) mismatches.push(`${display}: version ${String(manifest.version)} !== VERSION ${version}`)
    if (path.endsWith("release-manifest.json") && manifest.tag !== tag) mismatches.push(`${display}: tag ${String(manifest.tag)} !== ${tag}`)
  }

  const currentParts = versionParts(version)
  for (const actualTag of await tagNames(root)) {
    if (!actualTag.startsWith("v")) continue
    const taggedParts = versionParts(actualTag.slice(1))
    if (!taggedParts) {
      mismatches.push(`tag ${actualTag}: malformed v tag; expected v<major>.<minor>.<patch>`)
    } else if (currentParts && compareVersions(taggedParts, currentParts) > 0) {
      mismatches.push(`tag ${actualTag}: future tag is newer than VERSION ${version}`)
    }
  }
  return { version, tag, mismatches }
}

if (import.meta.main) {
  if (process.argv[2] !== "--check" || process.argv.length !== 3) {
    console.error("usage: version-sync.ts --check")
    process.exitCode = 2
  } else {
    const result = await inspectVersions(process.cwd())
    if (result.mismatches.length > 0) {
      for (const mismatch of result.mismatches.slice(0, 20)) console.error(`version-sync: ${mismatch}`)
      process.exitCode = 1
    } else {
      console.log(`version-sync: ${result.version} (${result.tag}) PASS`)
    }
  }
}
