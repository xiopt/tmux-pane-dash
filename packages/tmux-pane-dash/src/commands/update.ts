import { CliError } from "../errors"
import { readlink } from "node:fs/promises"
import { join } from "node:path"
import { managedRoot, readOwnership, validateManagedRoot } from "../ownership"
import { assertDowngradeAllowed, type Dependencies } from "../runtime"
import { setup } from "./setup"

export async function update(deps: Dependencies): Promise<void> {
  const root = await managedRoot(deps.env)
  try { await validateManagedRoot(root, deps) } catch (error) { if ((error as { code?: string }).code === "ENOENT") throw new CliError("E_USAGE", "no installation; run setup"); throw error }
  const ownership = await readOwnership(root, deps)
  if (!ownership) throw new CliError("E_USAGE", "no installation; run setup")
  try { if (await readlink(join(root, "current")) !== ownership.currentTarget) throw new CliError("E_OWNERSHIP", "owned current target changed") } catch (error) { if (error instanceof CliError) throw error; throw new CliError("E_OWNERSHIP", "owned current target changed") }
  assertDowngradeAllowed({ command: { name: "update" }, executingVersion: deps.executingVersion, ownedVersion: ownership.releaseVersion })
  await setup({ name: "setup", tmux: ownership.components.tmux !== null, opencode: ownership.components.opencode !== null, migrate: false, allowDowngrade: false }, deps)
}
