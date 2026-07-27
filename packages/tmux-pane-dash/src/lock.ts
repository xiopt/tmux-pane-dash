import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import { CliError } from "./errors"
import { ensureManagedRoot, managedRoot } from "./ownership"
import type { Dependencies } from "./runtime"

type Command = "setup" | "update" | "uninstall"
type Owner = { schemaVersion: 1; token: string; pid: number; command: Command; packageVersion: string; startedAt: number }
export type LockHandle = { token: string; recovered: boolean; release(): Promise<void> }
const missing = (error: unknown) => typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT"
function owner(value: any): value is Owner { return value && value.schemaVersion === 1 && typeof value.token === "string" && /^[a-f0-9]{32,}$/.test(value.token) && Number.isInteger(value.pid) && ["setup", "update", "uninstall"].includes(value.command) && typeof value.packageVersion === "string" && typeof value.startedAt === "number" }
export async function acquireLock(command: Command, deps: Dependencies): Promise<LockHandle> {
  const root = await managedRoot(deps.env), path = join(root, "transactions", "lock"); await ensureManagedRoot(root)
  let recovered = false
  try { await mkdir(path, { mode: 0o700 }) } catch (error) {
    if (!((error as any)?.code === "EEXIST")) throw error
    let prior: unknown
    try { prior = JSON.parse(await readFile(join(path, "owner.json"), "utf8")) } catch { throw new CliError("E_LOCK") }
    if (!owner(prior)) throw new CliError("E_LOCK")
    if ((deps.isPidAlive ?? ((pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }))(prior.pid)) { const locked: any = new CliError("E_LOCKED"); locked.exitStatus = 73; throw locked }
    const tombstone = `${path}.recovering-${(deps.randomBytes?.(8) ?? randomBytes(8)).toString()}`
    try { await rename(path, tombstone); await rm(tombstone, { recursive: true, force: true }); await mkdir(path, { mode: 0o700 }); recovered = true } catch { throw new CliError("E_LOCK") }
  }
  const token = Buffer.from(deps.randomBytes?.(16) ?? randomBytes(16)).toString("hex"), value: Owner = { schemaVersion: 1, token, pid: deps.pid?.() ?? process.pid, command, packageVersion: deps.executingVersion, startedAt: deps.nowMs?.() ?? Date.now() }
  await writeFile(join(path, "owner.json"), JSON.stringify(value), { mode: 0o600 })
  return { token, recovered, async release() { try { const current = JSON.parse(await readFile(join(path, "owner.json"), "utf8")); if (owner(current) && current.token === token) await rm(path, { recursive: true, force: true }) } catch (error) { if (!missing(error)) throw error } } }
}
