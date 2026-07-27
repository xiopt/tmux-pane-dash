import { lstat, mkdir, readFile, readlink, readdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { CliError } from "./errors"
import type { Dependencies } from "./runtime"

export type ArchiveFileRecord = { logicalPath: string; resolvedPath: string; sha256: string; mode: number; type: "file" | "directory" | "symlink"; symlinkChain?: readonly string[] }
export type OwnedConfig = { logicalPath: string; resolvedPath: string; marker: string; packageEntries: readonly string[]; baselineBackup: { logicalPath: string; sha256: string } }
export type MigrationAction = { from: string; to: string; sha256: string }
export interface OwnershipRecord { schemaVersion: 1; packageVersion: string; releaseVersion: string; archive: { target: string; sha256: string }; files: ArchiveFileRecord[]; currentTarget: string; components: { tmux: OwnedConfig | null; opencode: OwnedConfig | null }; migrations: readonly MigrationAction[] }

const missing = (error: unknown) => typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT"
const fail = (code: "E_ROOT" | "E_CONFLICT" | "E_OWNERSHIP") => { throw new CliError(code) }
export async function managedRoot(env: Dependencies["env"]): Promise<string> {
  const xdg = env?.XDG_DATA_HOME
  if (xdg) return join(xdg, "tmux-pane-dash")
  if (!env?.HOME) fail("E_ROOT")
  return join(env.HOME, ".local", "share", "tmux-pane-dash")
}
function inside(root: string, path: string) { return path === root || path.startsWith(`${root}/`) }
async function safeDirectory(path: string, uid: number) {
  const entry = await lstat(path)
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== uid || (entry.mode & 0o022) !== 0) fail("E_CONFLICT")
}
/** Rejects existing unsafe state; it deliberately never cleans it up. */
export async function validateManagedRoot(root: string, deps: Dependencies): Promise<void> {
  const canonical = resolve(root), uid = deps.uid?.() ?? process.getuid?.() ?? 0
  await safeDirectory(canonical, uid)
  const allowed = new Set(["versions", "state", "transactions", "current"])
  for (const name of await readdir(canonical)) if (!allowed.has(name)) fail("E_CONFLICT")
  for (const name of ["versions", "state", "transactions"] as const) { try { await safeDirectory(join(canonical, name), uid) } catch (error) { if (!missing(error)) throw error } }
  try {
    const current = join(canonical, "current"), target = await readlink(current)
    if (target.startsWith("/") || !target.startsWith("versions/") || target.split("/").some(part => !part || part === "." || part === "..") || !inside(canonical, resolve(canonical, target))) fail("E_CONFLICT")
  } catch (error) { if (!missing(error)) throw error }
  try { for (const version of await readdir(join(canonical, "versions"))) await safeDirectory(join(canonical, "versions", version), uid) } catch (error) { if (!missing(error)) throw error }
}
function validOwnership(value: any): value is OwnershipRecord {
  return value && typeof value === "object" && value.schemaVersion === 1 && typeof value.packageVersion === "string" && typeof value.releaseVersion === "string" && value.archive && typeof value.archive.target === "string" && typeof value.archive.sha256 === "string" && Array.isArray(value.files) && typeof value.currentTarget === "string" && value.components && Array.isArray(value.migrations)
}
export async function readOwnership(root: string, _deps: Dependencies): Promise<OwnershipRecord | null> {
  let bytes: Uint8Array
  try { bytes = await readFile(join(root, "state", "ownership.json")) } catch (error) { if (missing(error)) return null; fail("E_OWNERSHIP") }
  let value: unknown
  try { value = JSON.parse(new TextDecoder().decode(bytes)) } catch { fail("E_OWNERSHIP") }
  if (!validOwnership(value)) fail("E_OWNERSHIP")
  return value
}
export async function ensureManagedRoot(root: string): Promise<void> { await mkdir(root, { recursive: true, mode: 0o700 }); await mkdir(join(root, "versions"), { recursive: true, mode: 0o700 }); await mkdir(join(root, "state"), { recursive: true, mode: 0o700 }); await mkdir(join(root, "transactions"), { recursive: true, mode: 0o700 }) }
