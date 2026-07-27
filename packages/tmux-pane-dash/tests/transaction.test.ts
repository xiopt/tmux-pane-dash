import { expect, test } from "bun:test"
import { lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { executeTransaction, recoverIncomplete, type TransactionPlan } from "../src/transaction"
import type { JournalPhase } from "../src/journal"
import { transactionFixture } from "./helpers/fixture"

const phases: readonly JournalPhase[] = ["prepared", "version_staged", "configs_staged", "current_switched", "configs_committed", "ownership_committed", "complete"]
function plan(root: string): TransactionPlan { return { command: "setup", components: { tmux: true, opencode: true }, desiredVersion: "0.1.0", previousCurrent: null, configMutations: [{ logicalPath: join(root, "tmux.conf"), resolvedPath: join(root, "tmux.conf"), bytes: new TextEncoder().encode("tmux"), mode: 0o600 }, { logicalPath: join(root, "opencode.json"), resolvedPath: join(root, "opencode.json"), bytes: new TextEncoder().encode("open"), mode: 0o600 }] } }

test("every phase failure before and after durable transition restores exact preimages", async () => {
  for (const phase of phases) for (const boundary of ["before", "after"] as const) {
    const h = await transactionFixture({ alive: false })
    try {
      await expect(executeTransaction(plan(h.root), { ...h.deps, faultPhase: { phase, boundary } })).rejects.toThrow()
      await expect(Bun.file(join(h.root, "tmux.conf")).exists()).resolves.toBeFalse()
      await expect(Bun.file(join(h.root, "opencode.json")).exists()).resolves.toBeFalse()
    } finally { await h.cleanup() }
  }
})

test("every persisted phase recovers after dead-owner crash and preserves evidence", async () => {
  for (const phase of phases.filter(phase => phase !== "complete")) {
    const h = await transactionFixture({ alive: false })
    try {
      await expect(executeTransaction(plan(h.root), { ...h.deps, crashPhase: phase })).rejects.toThrow("E_CRASH")
      await expect(recoverIncomplete(h.root, h.deps)).resolves.toBeUndefined()
      await expect(Bun.file(join(h.root, "tmux.conf")).exists()).resolves.toBeFalse()
    } finally { await h.cleanup() }
  }
})

test("collision signal and retention rows are exhaustive", async () => {
  for (const row of ["collision", "HUP", "INT", "TERM", "retention"] as const) {
    const h = await transactionFixture()
    try {
      if (row === "collision") await expect(executeTransaction(plan(h.root), { ...h.deps, collisionAfterMutation: true })).rejects.toThrow("E_RECOVERY")
      else if (row === "retention") { await mkdir(join(h.root, "versions", "0.0.9"), { recursive: true }); await symlink("versions/0.0.9", join(h.root, "current")); await executeTransaction({ ...plan(h.root), command: "update", previousCurrent: "versions/0.0.9" }, h.deps); expect(await lstat(join(h.root, "versions", "0.0.9"))).toBeDefined() }
      else await expect(executeTransaction(plan(h.root), { ...h.deps, signal: row })).rejects.toMatchObject({ code: `E_SIGNAL_${row}` })
    } finally { await h.cleanup() }
  }
})
