import { createHash, randomBytes } from "node:crypto"
import { lstat, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { acquireRelease } from "../acquire"
import { planOpenCodeEdit, planOpenCodeMigration, selectOpenCodeConfig } from "../config-opencode"
import { managedTmuxBlock, planTmuxEdit } from "../config-tmux"
import type { Command } from "../contracts"
import { CliError } from "../errors"
import { resolveConfigPath, type ResolvedConfigPath } from "../fs"
import { parseReleaseManifest, selectRelease } from "../manifest"
import { ensureManagedRoot, managedRoot, readOwnership, validateManagedRoot, type OwnershipRecord } from "../ownership"
import { assertDowngradeAllowed, type Dependencies } from "../runtime"
import { executeTransaction, type PlannedConfigMutation } from "../transaction"

export type ConflictInventory = { tmux: PlannedConfigMutation | null; opencode: PlannedConfigMutation | null; migrations: readonly { logicalPath: string; resolvedPath: string; action: "unlink" }[] }
const encoder = new TextEncoder(), digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex")
const missing = (error: unknown) => typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT"
async function readOr(path: string, fallback: string) { try { return new Uint8Array(await readFile(path)) } catch (error) { if (missing(error)) return encoder.encode(fallback); throw error } }
async function exists(path: string) { try { await lstat(path); return true } catch (error) { if (missing(error)) return false; throw error } }
function planned(mutation: PlannedConfigMutation, resolved: ResolvedConfigPath, bytes: Uint8Array): PlannedConfigMutation {
  return { ...mutation, expectedPreimage: { state: resolved.preimageHash ? { type: "file", sha256: resolved.preimageHash, mode: resolved.mode ?? 0o600 } : { type: "absent", sha256: null, mode: null }, ...(resolved.preimageHash ? { bytes } : {}), symlinkChain: resolved.symlinkChain } }
}

/** Pure conflict inventory: no root creation, fetch, unlink, or config write. */
export async function inventoryConflicts(input: { tmux: boolean; opencode: boolean; migrate: boolean; packageEntry?: string; ownedOpenCodeEntries?: readonly string[] }, deps: Dependencies): Promise<ConflictInventory> {
  const root = await managedRoot(deps.env)
  let tmux: PlannedConfigMutation | null = null, opencode: PlannedConfigMutation | null = null, migrations: ConflictInventory["migrations"] = []
  if (input.tmux) {
    if (!deps.env?.HOME) throw new CliError("E_ROOT")
    const resolved = await resolveConfigPath(join(deps.env.HOME, ".tmux.conf"), deps)
    const bytes = await readOr(resolved.resolvedPath, "")
    tmux = planned(planTmuxEdit({ ...resolved, bytes, mode: resolved.mode ?? 0o600, installRoot: root, migrate: input.migrate }), resolved, bytes)
  }
  if (input.opencode) {
    const logicalPath = await selectOpenCodeConfig(deps.env, deps), resolved = await resolveConfigPath(logicalPath, deps)
    const bytes = await readOr(resolved.resolvedPath, "{}\n")
    opencode = planned(planOpenCodeEdit({ ...resolved, bytes, mode: resolved.mode ?? 0o600, migrate: input.migrate, packageEntry: input.packageEntry, ownedEntries: input.ownedOpenCodeEntries }), resolved, bytes)
    migrations = await planOpenCodeMigration({ configDirectory: dirname(logicalPath), installRoot: root, migrate: input.migrate })
  }
  return { tmux, opencode, migrations }
}

function owned(path: PlannedConfigMutation, marker: string, packageEntries: readonly string[] = []) { return { logicalPath: path.logicalPath, resolvedPath: path.resolvedPath, marker, packageEntries, baselineBackup: { logicalPath: path.logicalPath, sha256: digest(path.bytes) } } }
async function files(directory: string) {
  const raw = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as { files: { path: string; sha256: string; mode: string }[] }
  return raw.files.map(file => ({ logicalPath: join(directory, file.path), resolvedPath: join(directory, file.path), sha256: file.sha256, mode: Number.parseInt(file.mode, 8), type: "file" as const }))
}

export async function setup(command: Extract<Command, { name: "setup" }>, deps: Dependencies): Promise<void> {
  const root = await managedRoot(deps.env)
  if (await exists(root)) await validateManagedRoot(root, deps)
  const prior = await readOwnership(root, deps)
  if (prior) assertDowngradeAllowed({ command, executingVersion: deps.executingVersion, ownedVersion: prior.releaseVersion })
  const record = selectRelease(parseReleaseManifest(deps.manifest), deps.platform, deps.arch)
  const packageEntry = `@xiopt/pane-dash-opencode@${deps.executingVersion}`, inventory = await inventoryConflicts({ ...command, packageEntry, ownedOpenCodeEntries: prior?.components.opencode?.packageEntries }, deps)
  // All candidate migration routes are recognized before any acquisition or unlink.
  await ensureManagedRoot(root)
  const staging = join(root, "transactions", `payload-${Buffer.from(deps.randomBytes?.(8) ?? randomBytes(8)).toString("hex")}`)
  const acquired = await acquireRelease({ versionDirectory: join(root, "versions", deps.executingVersion), stagingRoot: staging, record, deps })
  const payload = await files(acquired.versionDirectory), currentTarget = `versions/${deps.executingVersion}`
  const ownership: OwnershipRecord = { schemaVersion: 1, packageVersion: deps.executingVersion, releaseVersion: deps.executingVersion, archive: { target: record.target, sha256: record.sha256 }, files: payload, currentTarget, components: {
    tmux: inventory.tmux ? owned(inventory.tmux, managedTmuxBlock(root)) : prior?.components.tmux ?? null,
    opencode: inventory.opencode ? owned(inventory.opencode, packageEntry, [packageEntry]) : prior?.components.opencode ?? null,
  }, migrations: inventory.migrations.map(item => ({ from: item.logicalPath, to: item.resolvedPath, sha256: "" })) }
  await executeTransaction({ command: "setup", components: { tmux: command.tmux, opencode: command.opencode }, desiredVersion: deps.executingVersion, previousCurrent: prior?.currentTarget ?? null, configMutations: [inventory.tmux, inventory.opencode].filter((item): item is PlannedConfigMutation => item !== null), migrationUnlinks: inventory.migrations, ownership, ...(acquired.kind === "staged" ? { versionActivation: { stagingPath: acquired.versionDirectory } } : {}) }, deps)
}
