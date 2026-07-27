import { mkdir, open, readFile, rename } from "node:fs/promises"
import { dirname, join } from "node:path"
import { randomBytes } from "node:crypto"
import { CliError } from "./errors"
import { managedRoot } from "./ownership"
import type { Dependencies } from "./runtime"

export const journalPhases = ["prepared", "version_staged", "configs_staged", "current_switched", "configs_committed", "ownership_committed", "complete"] as const
export type JournalPhase = typeof journalPhases[number]
export type FileState = { type: "absent" | "file" | "directory" | "symlink"; sha256: string | null; mode: number | null; target?: string }
export type JournalMutation = { operation: "version" | "config" | "current" | "ownership" | "tombstone"; logicalPath: string; resolvedPath: string; pre: FileState; post: FileState; preimage: string | null }
export type Journal = { schemaVersion: 1; id: string; command: "setup" | "update" | "uninstall"; packageVersion: string; phase: JournalPhase; previousCurrent: string | null; components: { tmux: boolean; opencode: boolean }; mutations: JournalMutation[] }
const missing = (error: unknown) => typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT"
const fail = () => { throw new CliError("E_JOURNAL") }
function validState(value: any): value is FileState { return value && ["absent", "file", "directory", "symlink"].includes(value.type) && (value.sha256 === null || typeof value.sha256 === "string") && (value.mode === null || Number.isInteger(value.mode)) }
function valid(value: any): value is Journal { return value && value.schemaVersion === 1 && typeof value.id === "string" && /^[a-f0-9-]{16,}$/.test(value.id) && ["setup", "update", "uninstall"].includes(value.command) && typeof value.packageVersion === "string" && journalPhases.includes(value.phase) && (value.previousCurrent === null || typeof value.previousCurrent === "string") && value.components && typeof value.components.tmux === "boolean" && typeof value.components.opencode === "boolean" && Array.isArray(value.mutations) && value.mutations.every((m: any) => m && ["version", "config", "current", "ownership", "tombstone"].includes(m.operation) && typeof m.logicalPath === "string" && typeof m.resolvedPath === "string" && validState(m.pre) && validState(m.post) && (m.preimage === null || typeof m.preimage === "string")) }
export function createJournal(input: Omit<Journal, "schemaVersion" | "phase" | "mutations">): Journal { return { ...input, schemaVersion: 1, phase: "prepared", mutations: [] } }
async function durableWrite(path: string, bytes: Uint8Array, deps: Dependencies) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 }); const temp = join(dirname(path), `.${path.split("/").pop()}.${Buffer.from(deps.randomBytes?.(8) ?? randomBytes(8)).toString("hex")}`)
  const file = await open(temp, "wx", 0o600); try { await file.writeFile(bytes); await file.sync(); deps.journalEvent?.("fsync.file") } finally { await file.close() }
  await rename(temp, path); const parent = await open(dirname(path), "r"); try { await parent.sync(); deps.journalEvent?.("fsync.parent") } finally { await parent.close() }
}
export async function persistJournal(journal: Journal, deps: Dependencies): Promise<void> { if (!valid(journal)) fail(); const root = await managedRoot(deps.env); await durableWrite(join(root, "transactions", journal.id, "journal.json"), new TextEncoder().encode(JSON.stringify(journal)), deps) }
export async function readJournal(root: string, id: string, _deps: Dependencies): Promise<Journal | null> { let text: string; try { text = await readFile(join(root, "transactions", id, "journal.json"), "utf8") } catch (error) { if (missing(error)) return null; fail() }; let value: unknown; try { value = JSON.parse(text) } catch { fail() }; if (!valid(value)) fail(); return value }
export async function transitionJournal(journal: Journal, phase: JournalPhase, deps: Dependencies): Promise<void> { const from = journalPhases.indexOf(journal.phase), to = journalPhases.indexOf(phase); if (to !== from + 1) fail(); journal.phase = phase; await persistJournal(journal, deps) }
