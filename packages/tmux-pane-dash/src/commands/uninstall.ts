import { createHash } from "node:crypto"
import { readFile, readlink } from "node:fs/promises"
import { join } from "node:path"
import { planOpenCodeRemoval } from "../config-opencode"
import { planTmuxRemoval } from "../config-tmux"
import { CliError } from "../errors"
import { resolveConfigPath, type ResolvedConfigPath } from "../fs"
import { managedRoot, readOwnership, validateManagedRoot } from "../ownership"
import type { Dependencies } from "../runtime"
import { executeTransaction, type PlannedConfigMutation } from "../transaction"

const missing = (error: unknown) => typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT"
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex")
async function bytes(path: string) { return new Uint8Array(await readFile(path)) }
function planned(mutation: PlannedConfigMutation, resolved: ResolvedConfigPath, content: Uint8Array): PlannedConfigMutation { return { ...mutation, expectedPreimage: { state: { type: "file", sha256: digest(content), mode: resolved.mode ?? 0o600 }, bytes: content, symlinkChain: resolved.symlinkChain } } }
export async function uninstall(deps: Dependencies): Promise<void> {
  const root = await managedRoot(deps.env)
  try { await validateManagedRoot(root, deps) } catch (error) { if (missing(error)) return; throw error }
  const ownership = await readOwnership(root, deps)
  if (!ownership) {
    if (deps.env?.HOME) try { if ((await readFile(join(deps.env.HOME, ".tmux.conf"), "utf8")).includes("# >>> tmux-pane-dash (@xiopt/tmux-pane-dash) schema=1 >>>")) throw new CliError("E_OWNERSHIP", "managed marker requires manual review") } catch (error) { if (!missing(error)) throw error }
    return
  }
  try { if (await readlink(join(root, "current")) !== ownership.currentTarget) throw new CliError("E_OWNERSHIP", "owned current target changed") } catch (error) { if (error instanceof CliError) throw error; throw new CliError("E_OWNERSHIP", "owned current target changed") }
  for (const file of ownership.files) { const content = await bytes(file.resolvedPath); if (digest(content) !== file.sha256) throw new CliError("E_OWNERSHIP", "owned payload changed") }
  const edits: PlannedConfigMutation[] = []
  if (ownership.components.tmux) { const item = ownership.components.tmux, resolved = await resolveConfigPath(item.logicalPath, deps), content = await bytes(resolved.resolvedPath); edits.push(planned(planTmuxRemoval({ ...resolved, bytes: content, installRoot: root, mode: resolved.mode ?? 0o600 }), resolved, content)) }
  if (ownership.components.opencode) { const item = ownership.components.opencode, resolved = await resolveConfigPath(item.logicalPath, deps), content = await bytes(resolved.resolvedPath); edits.push(planned(planOpenCodeRemoval({ ...resolved, bytes: content, ownedEntries: item.packageEntries, mode: resolved.mode ?? 0o600 }), resolved, content)) }
  await executeTransaction({ command: "uninstall", components: { tmux: ownership.components.tmux !== null, opencode: ownership.components.opencode !== null }, desiredVersion: ownership.releaseVersion, previousCurrent: ownership.currentTarget, configMutations: edits, uninstall: { tombstoneVersions: true, removeCurrent: true, removeOwnership: true } }, deps)
}
