import { readFile, readdir } from "node:fs/promises"
import { join, relative } from "node:path"

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
  if (pkg === undefined) return
  if (pkg.version !== version) mismatches.push(`${display}: version ${String(pkg.version)} !== VERSION ${version}`)
}

async function cargoLockVersion(path: string): Promise<string | undefined> {
  const lock = await readText(path)
  if (lock === undefined) return undefined
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

async function tagPaths(root: string): Promise<string[]> {
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
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) paths.push(path)
    }
  }
  await visit(join(root, ".git", "refs", "tags"))
  return paths.sort()
}

export async function inspectVersions(root: string): Promise<VersionInspection> {
  const versionText = await readText(join(root, "VERSION"))
  const version = versionText?.endsWith("\n") ? versionText.slice(0, -1) : versionText ?? ""
  const tag = `v${version}`
  const mismatches: string[] = []

  await packageVersion(join(root, "package.json"), "package.json", version, mismatches)
  const cargoToml = await readText(join(root, "pane-dash", "Cargo.toml"))
  const cargoVersion = /^version = "([^"]+)"$/m.exec(cargoToml ?? "")?.[1]
  if (cargoToml !== undefined && cargoVersion !== version) mismatches.push(`pane-dash/Cargo.toml: version ${String(cargoVersion)} !== VERSION ${version}`)
  const lockVersion = await cargoLockVersion(join(root, "pane-dash", "Cargo.lock"))
  if (lockVersion !== undefined && lockVersion !== version) mismatches.push(`pane-dash/Cargo.lock: pane-dash version ${lockVersion} !== VERSION ${version}`)

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

  for (const path of await tagPaths(root)) {
    const actualTag = relative(join(root, ".git", "refs", "tags"), path)
    if (actualTag !== tag) mismatches.push(`.git/refs/tags/${actualTag}: tag ${actualTag} !== ${tag}`)
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
