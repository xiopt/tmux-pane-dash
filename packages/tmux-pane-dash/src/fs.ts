import { chmod, lstat, mkdir, open, readdir, readFile, readlink, rename, rm } from "node:fs/promises"
import { createHash, randomBytes } from "node:crypto"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"
import { CliError } from "./errors"
import type { PlannedConfigMutation } from "./transaction"

export type FileInfo = { kind: "file" | "directory" | "symlink" | "other"; mode: number; size: number; dev?: number; ino?: number }
export interface FsOps { mkdir(path: string): Promise<void>; mkdirPayloadDirectory(root: string, relativePath: string, mode: number): Promise<void>; readFile(path: string): Promise<Uint8Array>; writeFileExclusive(root: string, relativePath: string, bytes: Uint8Array, mode: number): Promise<void>; openExclusive(path: string, mode: number): Promise<unknown>; write(file: unknown, bytes: Uint8Array): Promise<void>; close(file: unknown): Promise<void>; stat(path: string): Promise<FileInfo>; readdir(path: string): Promise<string[]>; rm(path: string): Promise<void> }

export function canonicalPayloadPath(path: string): string {
  if (!path || path.includes("\0") || path.includes("\\") || path.startsWith("/") || path.endsWith("/") || path.includes("//")) throw new Error("invalid payload path")
  if (path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("invalid payload path")
  return path
}
function within(root: string, relative: string): string { const base = resolve(root), path = resolve(base, canonicalPayloadPath(relative)); if (!path.startsWith(`${base}${sep}`)) throw new Error("path escapes root"); return path }
export function nodeFsOps(): FsOps { return {
  async mkdir(path) { await mkdir(path, { recursive: true, mode: 0o700 }) }, async readFile(path) { return new Uint8Array(await readFile(path)) },
  async mkdirPayloadDirectory(root, relative, mode) { const path = within(root, relative); await mkdir(path, { recursive: false, mode: mode & 0o777 }); await chmod(path, mode & 0o777) },
  async writeFileExclusive(root, relative, bytes, mode) { const path = within(root, relative); await mkdir(dirname(path), { recursive: true, mode: 0o700 }); const file = await open(path, "wx", mode & 0o777); try { await file.writeFile(bytes) } finally { await file.close() } },
  async openExclusive(path, mode) { return open(path, "wx", mode & 0o777) }, async write(file, bytes) { await (file as any).writeFile(bytes) }, async close(file) { await (file as any).close() },
  async stat(path) { const entry = await lstat(path); return { kind: entry.isFile() ? "file" : entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "other", mode: entry.mode & 0o7777, size: entry.size, dev: entry.dev, ino: entry.ino } },
  async readdir(path) { return readdir(path) }, async rm(path) { await rm(path, { recursive: true, force: true }) },
} }

export type SymlinkRecord = { path: string; target: string; dev: number; ino: number }
export type ResolvedConfigPath = { logicalPath: string; resolvedPath: string; symlinkChain: readonly SymlinkRecord[]; mode?: number; preimageHash?: string }

const missing = (error: unknown) => typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT"
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex")
const configError = () => { throw new CliError("E_CONFIG") }

/** Resolves a user config without ever replacing its symlink chain. */
export async function resolveConfigPath(logicalPath: string, _deps: unknown): Promise<ResolvedConfigPath> {
  let path = logicalPath, links: SymlinkRecord[] = []
  for (let count = 0; count <= 16; count += 1) {
    let entry
    try { entry = await lstat(path) } catch (error) {
      if (missing(error) && count === 0) return { logicalPath, resolvedPath: logicalPath, symlinkChain: [] }
      configError()
    }
    if (entry!.isSymbolicLink()) {
      if (count === 16) configError()
      let target: string
      try { target = await readlink(path) } catch { configError() }
      links.push({ path, target: target!, dev: entry!.dev, ino: entry!.ino })
      path = isAbsolute(target!) ? target! : resolve(dirname(path), target!)
      continue
    }
    if (!entry!.isFile()) configError()
    const content = new Uint8Array(await readFile(path))
    return { logicalPath, resolvedPath: path, symlinkChain: links, mode: entry!.mode & 0o777, preimageHash: digest(content) }
  }
  configError()
}

function sameChain(left: readonly SymlinkRecord[], right: readonly SymlinkRecord[]) {
  return left.length === right.length && left.every((link, index) => link.path === right[index]?.path && link.target === right[index]?.target && link.dev === right[index]?.dev && link.ino === right[index]?.ino)
}

/** Performs the byte-exact, same-directory write used by both config editors. */
export async function atomicConfigWrite(plan: PlannedConfigMutation & Partial<ResolvedConfigPath>, deps: { randomBytes?: (size: number) => Uint8Array; journalEvent?: (event: string) => void; beforeRename?: () => void | Promise<void> }): Promise<void> {
  const resolved = await resolveConfigPath(plan.logicalPath, deps)
  if (resolved.resolvedPath !== plan.resolvedPath || (plan.symlinkChain && !sameChain(plan.symlinkChain, resolved.symlinkChain))) throw new CliError("E_CONCURRENT_EDIT")
  const before = resolved.preimageHash
  if (plan.preimageHash !== undefined && plan.preimageHash !== before) throw new CliError("E_CONCURRENT_EDIT")
  const mode = resolved.mode ?? plan.mode ?? 0o600, directory = dirname(plan.resolvedPath)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const suffix = Buffer.from(deps.randomBytes?.(8) ?? randomBytes(8)).toString("hex"), temp = join(directory, `.${plan.resolvedPath.split("/").at(-1)}.${suffix}`)
  try {
    const file = await open(temp, "wx", mode)
    try { await file.writeFile(plan.bytes); await chmod(temp, mode); await file.sync(); deps.journalEvent?.("fsync.file") } finally { await file.close() }
    const reread = new Uint8Array(await readFile(plan.resolvedPath).catch(error => missing(error) ? new Uint8Array() : Promise.reject(error)))
    if ((before ?? digest(new Uint8Array())) !== digest(reread)) throw new CliError("E_CONCURRENT_EDIT")
    await deps.beforeRename?.()
    const checked = await resolveConfigPath(plan.logicalPath, deps)
    if (checked.resolvedPath !== plan.resolvedPath || checked.mode !== resolved.mode || checked.preimageHash !== before || !sameChain(resolved.symlinkChain, checked.symlinkChain)) throw new CliError("E_CONCURRENT_EDIT")
    await rename(temp, plan.resolvedPath)
    const parent = await open(directory, "r"); try { await parent.sync(); deps.journalEvent?.("fsync.parent") } finally { await parent.close() }
  } catch (error) { await rm(temp, { force: true }); throw error }
}
