import { createHash } from "node:crypto"
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { gunzipSync, gzipSync } from "node:zlib"
import { TAG } from "./contracts"

export const SOURCE_ROOTS = [
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
] as const

/** The explicit root manifest is intentionally independent of Git metadata. */
export const SOURCE_MANIFEST = SOURCE_ROOTS

/**
 * Every executable that belongs in the source package. A regular file with an
 * execute bit that is not in this list is a packaging error.
 */
export const SOURCE_EXECUTABLES = [
  "pane_dash.tmux",
  "scripts/open.sh",
  "scripts/release/clean-room.sh",
  "scripts/release/public-smoke.sh",
  "scripts/tag.sh",
  "spike/lib.sh",
  "spike/perf/coldframe.sh",
  "spike/probes/10_popup_attach.sh",
  "spike/probes/30_wire_framing.sh",
  "spike/probes/40_expansion_matrix.sh",
  "spike/probes/50_encoding_roundtrip.sh",
  "spike/probes/60_cwd_hatch.sh",
  "spike/probes/70_lifecycle.sh",
  "spike/results/linux_arm64/tmux_3.2/10_inner.sh",
  "spike/results/linux_arm64/tmux_3.4/10_inner.sh",
  "spike/results/linux_arm64/tmux_3.6/10_inner.sh",
  "spike/results/tmux_3.2/10_inner.sh",
  "spike/results/tmux_3.4/10_inner.sh",
  "spike/results/tmux_3.6/10_inner.sh",
  "spike/results/tmux_3.7b/10_inner.sh",
  "spike/run_all.sh",
  "spike/tests/00_pty_helper_test.sh",
  "spike/tests/10_popup_attach_test.sh",
  "spike/tests/30_wire_framing_test.sh",
  "spike/tests/40_expansion_matrix_test.sh",
  "spike/tests/50_encoding_roundtrip_test.sh",
  "spike/tests/70_lifecycle_test.sh",
  "tests/integration.sh",
  "tests/pane_dash_integration.sh",
  "tests/release/with-node20.sh",
  "tests/release/with-npa.sh",
  "tests/release/with-rust.sh",
  "tests/rust_engine_integration.sh",
  "tests/rust_engine_quoting_integration.sh",
  "tests/rust_live_integration.sh",
  "tests/source_package.sh",
  "tests/stubs/tmux",
] as const

export const SOURCE_ARCHIVE_PREFIX = "tmux-pane-dash-"
const SOURCE_ARCHIVE_SUFFIX = "-source.tar.gz"
const executableSet = new Set<string>(SOURCE_EXECUTABLES)
const rootSet = new Set<string>(SOURCE_ROOTS)
const REQUIRED_WORKFLOWS = ["ci.yml", "opencode-weekly.yml", "release.yml"] as const
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export type SourceMode = "0755" | "0644"
export type SourceManifestEntry = {
  path: string
  kind: "file" | "directory"
  mode: SourceMode
  size: number
  sha256: string | null
}
export type SourceArchiveEntry = Omit<SourceManifestEntry, "sha256"> & { mtime: number }
export type SourceArchiveInput = {
  root: string
  output: string
  tag?: string
  epoch: number
}

const bytes = (value: string) => encoder.encode(value)
const comparePaths = (left: string, right: string) => Buffer.from(left).compare(Buffer.from(right))
const sha256 = (value: Uint8Array) => createHash("sha256").update(value).digest("hex")
const isMissing = (error: unknown) => typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT"

function fail(message: string): never {
  throw new Error(`source-manifest: ${message}`)
}

function validTag(tag: string): boolean {
  return /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(tag)
}

export function sourceArchiveName(tag = TAG): string {
  if (!validTag(tag)) fail(`tag must use the v<major>.<minor>.<patch> form: ${tag}`)
  return `${SOURCE_ARCHIVE_PREFIX}${tag}${SOURCE_ARCHIVE_SUFFIX}`
}

function isSensitiveName(name: string): boolean {
  return /^\.env(?:\..*)?$/i.test(name) || name.toLowerCase() === ".npmrc" || /(?:^|[._-])(?:credentials?|password|secret|token|auth)(?=$|[._-])/i.test(name)
}

function isSensitivePath(path: string): boolean {
  return path.split("/").some(isSensitiveName)
}

function isGeneratedPath(path: string): boolean {
  const parts = path.split("/")
  const name = parts.at(-1) ?? ""
  if (parts.some((part) => [".git", ".cortexkit", "node_modules", ".npm", ".npm-cache", "npm-cache", "bun-cache", ".cache", "target"].includes(part))) return true
  if (parts.includes("dist")) return true
  if (parts[0] === "bin") return true
  if (name === ".DS_Store" || name.startsWith("._")) return true
  if (/\.(?:tar|tar\.gz|tgz|zip|sha256)$/i.test(name)) return true
  if (path === "release-manifest.json" || path === "SHA256SUMS") return true
  return false
}

function isIgnorableTopLevel(name: string): boolean {
  return name === ".git" || name === ".cortexkit" || name === "node_modules" || name === ".npm" || name === ".npm-cache" || name === "npm-cache" || name === "bun-cache" || name === "target" || name === "dist" || name === "bin" || name === ".DS_Store" || name.startsWith("._") || /\.(?:tar|tar\.gz|tgz|zip|sha256)$/i.test(name)
}

async function canonicalRoot(input: string): Promise<string> {
  if (!input) fail("root must be a path")
  const original = await lstat(input).catch((error) => { if (isMissing(error)) fail(`root does not exist: ${input}`); throw error })
  if (!original.isDirectory() || original.isSymbolicLink()) fail("root must be a real directory")
  const root = await realpath(input).catch((error) => { if (isMissing(error)) fail(`root does not exist: ${input}`); throw error })
  const info = await lstat(root)
  if (!info.isDirectory() || info.isSymbolicLink()) fail("root must be a real directory")
  return root
}

async function validateTopLevel(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    if (isSensitivePath(entry.name)) fail(`sensitive source path: ${entry.name}`)
    if (rootSet.has(entry.name) || isIgnorableTopLevel(entry.name)) continue
    fail(`unlisted source root: ${entry.name}`)
  }
}

async function validateRoots(root: string): Promise<void> {
  for (const path of SOURCE_MANIFEST) {
    const absolute = join(root, path)
    let info: Awaited<ReturnType<typeof lstat>>
    try { info = await lstat(absolute) } catch (error) { if (isMissing(error)) fail(`missing approved source root: ${path}`); throw error }
    if (info.isSymbolicLink()) fail(`source root is a symlink: ${path}`)
    const expectedDirectory = ![".gitignore", "LICENSE", "Makefile", "README.md", "VERSION", "bun.lock", "package.json", "pane_dash.tmux"].includes(path)
    if (expectedDirectory !== info.isDirectory()) fail(`source root has the wrong kind: ${path}`)
  }
  const workflows = (await readdir(join(root, ".github", "workflows"))).sort(comparePaths)
  if (workflows.length !== REQUIRED_WORKFLOWS.length || workflows.some((path, index) => path !== REQUIRED_WORKFLOWS[index])) fail(".github/workflows must contain exactly ci.yml, opencode-weekly.yml, and release.yml")
}

function modeFor(path: string, mode: number): SourceMode {
  const executable = (mode & 0o111) !== 0
  if (executable && !executableSet.has(path)) fail(`unlisted executable: ${path}`)
  if (executable && (mode & 0o777) !== 0o755) fail(`${path} must have mode 0755`)
  if (!executable && executableSet.has(path)) fail(`${path} must have mode 0755`)
  return executable ? "0755" : "0644"
}

async function collect(root: string, relativePath: string, output: SourceManifestEntry[]): Promise<void> {
  if (relativePath && isSensitivePath(relativePath)) fail(`sensitive source path: ${relativePath}`)
  if (relativePath && isGeneratedPath(relativePath)) return
  const absolute = relativePath ? join(root, relativePath) : root
  const info = await lstat(absolute)
  if (info.isSymbolicLink()) fail(`symlink is not allowed: ${relativePath}`)
  if (info.isDirectory()) {
    if (relativePath) output.push({ path: relativePath, kind: "directory", mode: "0755", size: 0, sha256: null })
    const children = (await readdir(absolute)).sort(comparePaths)
    for (const child of children) await collect(root, relativePath ? `${relativePath}/${child}` : child, output)
    return
  }
  if (!info.isFile()) fail(`unsupported source entry: ${relativePath}`)
  const content = new Uint8Array(await readFile(absolute))
  output.push({ path: relativePath, kind: "file", mode: modeFor(relativePath, info.mode), size: content.byteLength, sha256: sha256(content) })
}

/** Collects a canonical, Git-independent inventory of the approved source tree. */
export async function collectSourceManifest(inputRoot: string): Promise<readonly SourceManifestEntry[]> {
  const root = await canonicalRoot(inputRoot)
  await validateTopLevel(root)
  await validateRoots(root)
  const entries: SourceManifestEntry[] = []
  for (const path of SOURCE_MANIFEST) await collect(root, path, entries)
  entries.sort((left, right) => comparePaths(left.path, right.path))
  return entries
}

export async function sourceManifestDigest(inputRoot: string): Promise<string> {
  const entries = await collectSourceManifest(inputRoot)
  const manifest = entries.map((entry) => `${entry.path}\0${entry.kind}\0${entry.mode}\0${entry.size}\0${entry.sha256 ?? ""}\0`).join("")
  return sha256(bytes(manifest))
}

function octal(value: number, width: number): string {
  if (!Number.isSafeInteger(value) || value < 0) fail("tar metadata is outside the safe integer range")
  const encoded = value.toString(8).padStart(width - 1, "0")
  if (encoded.length + 1 > width) fail("tar metadata does not fit its field")
  return `${encoded}\0`
}

function writeField(target: Uint8Array, offset: number, length: number, value: string): void {
  const valueBytes = bytes(value)
  if (valueBytes.byteLength > length) fail(`tar field is too long: ${value}`)
  target.set(valueBytes, offset)
}

function tarPath(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" }
  const slashPositions: number[] = []
  for (let index = 0; index < path.length; index += 1) if (path[index] === "/") slashPositions.push(index)
  for (const slash of [...slashPositions].reverse()) {
    const prefix = path.slice(0, slash), name = path.slice(slash + 1)
    if (Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155) return { name, prefix }
  }
  fail(`path is too long for deterministic ustar: ${path}`)
}

function tarHeader(path: string, size: number, mode: SourceMode, epoch: number, kind: "file" | "directory"): Uint8Array {
  const header = new Uint8Array(512)
  const split = tarPath(path)
  writeField(header, 0, 100, split.name)
  writeField(header, 100, 8, octal(Number.parseInt(mode, 8), 8))
  writeField(header, 108, 8, octal(0, 8))
  writeField(header, 116, 8, octal(0, 8))
  writeField(header, 124, 12, octal(kind === "directory" ? 0 : size, 12))
  writeField(header, 136, 12, octal(epoch, 12))
  header.fill(32, 148, 156)
  writeField(header, 156, 1, kind === "directory" ? "5" : "0")
  writeField(header, 257, 6, "ustar\0")
  writeField(header, 263, 2, "00")
  writeField(header, 345, 155, split.prefix)
  const checksum = header.reduce((total, byte) => total + byte, 0)
  writeField(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `)
  return header
}

function tarEntry(path: string, entry: SourceManifestEntry, content: Uint8Array, epoch: number): Uint8Array {
  const header = tarHeader(path, content.byteLength, entry.mode, epoch, entry.kind)
  if (entry.kind === "directory") return header
  const paddedSize = Math.ceil(content.byteLength / 512) * 512
  const result = new Uint8Array(512 + paddedSize)
  result.set(header)
  result.set(content, 512)
  return result
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) { result.set(part, offset); offset += part.byteLength }
  return result
}

function archivePath(rootName: string, path: string): string {
  return path ? `${rootName}/${path}` : rootName
}

function validateEpoch(epoch: number): void {
  if (!Number.isSafeInteger(epoch) || epoch < 0) fail("epoch must be a nonnegative safe integer")
}

/** Builds a deterministic source archive with no dependency on the input root path. */
export async function buildSourceArchive(input: SourceArchiveInput): Promise<string> {
  const tag = input.tag ?? TAG
  sourceArchiveName(tag)
  validateEpoch(input.epoch)
  const root = await canonicalRoot(input.root)
  const entries = await collectSourceManifest(root)
  const rootName = `${SOURCE_ARCHIVE_PREFIX}${tag}`
  const archiveEntries: Uint8Array[] = []
  const rootEntry: SourceManifestEntry = { path: "", kind: "directory", mode: "0755", size: 0, sha256: null }
  const all = [rootEntry, ...entries.map((entry) => ({ ...entry, path: archivePath(rootName, entry.path) }))]
  all.sort((left, right) => comparePaths(left.path, right.path))
  for (const entry of all) {
    const sourcePath = entry.path === rootName ? null : entry.path.slice(rootName.length + 1)
    const content = sourcePath && entry.kind === "file" ? new Uint8Array(await readFile(join(root, sourcePath))) : new Uint8Array()
    archiveEntries.push(tarEntry(entry.path || rootName, entry, content, input.epoch))
  }
  archiveEntries.push(new Uint8Array(1024))
  await mkdir(dirname(resolve(input.output)), { recursive: true })
  await writeFile(input.output, gzipSync(concat(archiveEntries), { filename: "", mtime: 0, level: 9 }))
  return input.output
}

function field(header: Uint8Array, offset: number, length: number): string {
  return decoder.decode(header.subarray(offset, offset + length)).replace(/\0.*$/, "").trim()
}

function checksumValid(header: Uint8Array): boolean {
  const expected = Number.parseInt(field(header, 148, 8), 8)
  if (!Number.isSafeInteger(expected)) return false
  const copy = new Uint8Array(header)
  copy.fill(32, 148, 156)
  return copy.reduce((total, byte) => total + byte, 0) === expected
}

function pathIsSafe(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.split("/").some((part) => part === "" || part === "." || part === "..")
}

/** Inspects and validates the canonical inventory and metadata of a source archive. */
export async function inspectSourceArchive(path: string, expected: { tag?: string; epoch: number }): Promise<readonly SourceArchiveEntry[]> {
  const tag = expected.tag ?? TAG
  sourceArchiveName(tag)
  validateEpoch(expected.epoch)
  const rootName = `${SOURCE_ARCHIVE_PREFIX}${tag}`
  const tar = gunzipSync(await readFile(path))
  const entries: SourceArchiveEntry[] = []
  let footerOffset: number | null = null
  for (let offset = 0; offset + 512 <= tar.byteLength;) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) { footerOffset = offset; break }
    if (!checksumValid(header)) fail("archive checksum is invalid")
    const name = field(header, 0, 100), prefix = field(header, 345, 155), entryPath = prefix ? `${prefix}/${name}` : name
    const type = header[156] ?? 0
    const size = Number.parseInt(field(header, 124, 12), 8), mtime = Number.parseInt(field(header, 136, 12), 8), modeValue = Number.parseInt(field(header, 100, 8), 8)
    const uid = Number.parseInt(field(header, 108, 8), 8), gid = Number.parseInt(field(header, 116, 8), 8)
    if (!pathIsSafe(entryPath) || !entryPath.startsWith(`${rootName}`) || (entryPath !== rootName && !entryPath.startsWith(`${rootName}/`))) fail(`archive path is outside canonical root: ${entryPath}`)
    if (type !== 48 && type !== 53) fail(`archive entry type is not allowed: ${entryPath}`)
    if (field(header, 257, 6) !== "ustar" || field(header, 263, 2) !== "00" || field(header, 157, 100) || ![0o644, 0o755].includes(modeValue) || !Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(mtime) || mtime !== expected.epoch || uid !== 0 || gid !== 0 || field(header, 265, 32) || field(header, 297, 32) || field(header, 329, 8) || field(header, 337, 8)) fail(`archive metadata is not canonical: ${entryPath}`)
    const kind = type === 53 ? "directory" : "file"
    if (kind === "directory" && size !== 0) fail(`directory has content: ${entryPath}`)
    const relativePath = entryPath === rootName ? "" : entryPath.slice(rootName.length + 1)
    const expectedMode = kind === "directory" || executableSet.has(relativePath) ? 0o755 : 0o644
    if (modeValue !== expectedMode) fail(`archive mode is not canonical: ${entryPath}`)
    entries.push({ path: entryPath, kind, mode: modeValue === 0o755 ? "0755" : "0644", size, mtime })
    const bodySize = kind === "directory" ? 0 : size
    const next = offset + 512 + Math.ceil(bodySize / 512) * 512
    if (next > tar.byteLength) fail(`archive entry is truncated: ${entryPath}`)
    offset = next
  }
  if (footerOffset === null || footerOffset + 1024 !== tar.byteLength || !tar.subarray(footerOffset).every((byte) => byte === 0)) fail("archive footer is not canonical")
  const first = entries[0]
  if (!first || first.path !== rootName || first.kind !== "directory") fail("archive root is not canonical")
  if (entries.some((entry, index) => index > 0 && comparePaths(entries[index - 1]!.path, entry.path) >= 0)) fail("archive paths are not in bytewise order")
  const names = new Set(entries.map((entry) => entry.path))
  if (names.size !== entries.length) fail("archive contains duplicate paths")
  return entries
}

function parseCli(argv: readonly string[]): SourceArchiveInput {
  let root = process.cwd(), output = "", tag = TAG, epochText = process.env.SOURCE_DATE_EPOCH
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    const value = argv[index + 1]
    if (option === "--root" && value) { root = value; index += 1 }
    else if (option === "--output" && value) { output = value; index += 1 }
    else if (option === "--tag" && value) { tag = value; index += 1 }
    else if (option === "--epoch" && value) { epochText = value; index += 1 }
    else fail("usage: source-manifest.ts --output FILE [--root DIR] [--tag vX.Y.Z] [--epoch SECONDS]")
  }
  if (!output || !epochText || !/^[0-9]+$/.test(epochText)) fail("usage: source-manifest.ts --output FILE [--root DIR] [--tag vX.Y.Z] [--epoch SECONDS]")
  return { root, output, tag, epoch: Number(epochText) }
}

if (import.meta.main) {
  try {
    const input = parseCli(process.argv.slice(2))
    await buildSourceArchive(input)
    console.log(`source-package archive=${input.output} manifest_sha256=${await sourceManifestDigest(input.root)} tag=${input.tag} epoch=${input.epoch} PASS`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
