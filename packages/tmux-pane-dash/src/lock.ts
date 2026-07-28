import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import type { LockHandle, MutationCommand } from "./contracts"
import { CliError } from "./errors"
import { ensureManagedRoot, managedRoot } from "./ownership"
import type { Dependencies } from "./runtime"

export type { LockHandle }
type Owner = { schemaVersion: 1; token: string; pid: number; command: MutationCommand; packageVersion: string; startedAt: number }
const missing = (error: unknown) => typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT"
function owner(value: unknown): value is Owner {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Record<string, unknown>
  return candidate.schemaVersion === 1 && typeof candidate.token === "string" && /^[a-f0-9]{32,}$/.test(candidate.token) && Number.isInteger(candidate.pid) && (candidate.command === "setup" || candidate.command === "update" || candidate.command === "uninstall") && typeof candidate.packageVersion === "string" && typeof candidate.startedAt === "number"
}
export async function acquireLock(command: MutationCommand, deps: Dependencies): Promise<LockHandle> {
  const root = await managedRoot(deps.env), path = join(root, "transactions", "lock"); await ensureManagedRoot(root)
  let recovered = false
  try { await mkdir(path, { mode: 0o700 }) } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "EEXIST")) throw error
    let prior: unknown
    try { prior = JSON.parse(await readFile(join(path, "owner.json"), "utf8")) } catch { throw new CliError("E_LOCK") }
    if (!owner(prior)) throw new CliError("E_LOCK")
    if ((deps.isPidAlive ?? ((pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }))(prior.pid)) throw Object.assign(new CliError("E_LOCKED"), { exitStatus: 73 as const })
    const tombstone = `${path}.recovering-${(deps.randomBytes?.(8) ?? randomBytes(8)).toString()}`
    try { await rename(path, tombstone); await rm(tombstone, { recursive: true, force: true }); await mkdir(path, { mode: 0o700 }); recovered = true } catch { throw new CliError("E_LOCK") }
  }
  const token = Buffer.from(deps.randomBytes?.(16) ?? randomBytes(16)).toString("hex"), value: Owner = { schemaVersion: 1, token, pid: deps.pid?.() ?? process.pid, command, packageVersion: deps.executingVersion, startedAt: deps.nowMs?.() ?? Date.now() }
  await writeFile(join(path, "owner.json"), JSON.stringify(value), { mode: 0o600 })
  return { token, recovered, async release() { try { const current = JSON.parse(await readFile(join(path, "owner.json"), "utf8")); if (owner(current) && current.token === token) await rm(path, { recursive: true, force: true }) } catch (error) { if (!missing(error)) throw error } } }
}
