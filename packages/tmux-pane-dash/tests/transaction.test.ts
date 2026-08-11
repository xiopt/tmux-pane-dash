import { expect, test } from "bun:test"
import { lstat, mkdir, readFile, readlink, stat, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { executeTransaction, recoverIncomplete, type TransactionPlan } from "../src/transaction"
import { readJournal, type JournalPhase } from "../src/journal"
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

async function snapshot(path: string) {
  try {
    const entry = await lstat(path)
    if (entry.isSymbolicLink()) return { type: "symlink", target: await readlink(path), mode: entry.mode & 0o777 }
    return { type: "file", bytes: await readFile(path), mode: entry.mode & 0o777 }
  } catch (error: any) {
    if (error.code === "ENOENT") return { type: "absent" }
    throw error
  }
}

test("durable mutation intents recover every current, ordered config, and ownership crash window", async () => {
  const windows = ["intent", "published", "applied"] as const
  const mutations = [
    { operation: "current", occurrence: 1 },
    { operation: "config", occurrence: 1 },
    { operation: "config", occurrence: 2 },
    { operation: "ownership", occurrence: 1 },
  ] as const
  for (const mutation of mutations) for (const boundary of windows) {
    const h = await transactionFixture({ alive: false })
    try {
      await mkdir(join(h.root, "versions", "0.0.9"), { recursive: true })
      await mkdir(join(h.root, "state"), { recursive: true })
      await symlink("versions/0.0.9", join(h.root, "current"))
      await writeFile(join(h.root, "tmux.conf"), "old tmux", { mode: 0o640 })
      await writeFile(join(h.root, "opencode.json"), "old open", { mode: 0o600 })
      await writeFile(join(h.root, "state", "ownership.json"), "old ownership", { mode: 0o640 })
      const before = await Promise.all(["current", "tmux.conf", "opencode.json", "state/ownership.json"].map(path => snapshot(join(h.root, path))))
      await expect(executeTransaction(plan(h.root), { ...h.deps, crashMutation: { ...mutation, boundary } } as any)).rejects.toThrow("E_CRASH")
      const journal = await readJournal(h.root, "abababababababababababababababab", h.deps), recorded = journal!.mutations.filter(item => item.operation === mutation.operation)[mutation.occurrence - 1]
      expect(recorded.applied).toBe(boundary === "applied")
      if (mutation.operation === "current") expect(recorded.pre).toMatchObject(before[0])
      else expect(recorded.pre).toEqual({ type: "file", sha256: expect.any(String), mode: mutation.operation === "ownership" || mutation.occurrence === 1 ? 0o640 : 0o600 })
      if (mutation.operation !== "current") expect(await Bun.file(join(h.root, "transactions", journal!.id, recorded.preimage!)).exists()).toBeTrue()
      await expect(recoverIncomplete(h.root, h.deps)).resolves.toBeUndefined()
      await expect(Promise.all(["current", "tmux.conf", "opencode.json", "state/ownership.json"].map(path => snapshot(join(h.root, path))))).resolves.toEqual(before)
    } finally { await h.cleanup() }
  }
})

test("recovery leaves an unapplied intent untouched and rejects collision without overwriting evidence", async () => {
  const h = await transactionFixture({ alive: false })
  try {
    await expect(executeTransaction(plan(h.root), { ...h.deps, crashMutation: { operation: "config", occurrence: 1, boundary: "intent" } } as any)).rejects.toThrow("E_CRASH")
    expect(await Bun.file(join(h.root, "tmux.conf")).exists()).toBeFalse()
    await recoverIncomplete(h.root, h.deps)
    await expect(executeTransaction(plan(h.root), { ...h.deps, crashMutation: { operation: "config", occurrence: 1, boundary: "published" } } as any)).rejects.toThrow("E_CRASH")
    await writeFile(join(h.root, "tmux.conf"), "collision")
    await expect(recoverIncomplete(h.root, h.deps)).rejects.toThrow("E_RECOVERY")
    expect(await readFile(join(h.root, "tmux.conf"), "utf8")).toBe("collision")
    expect(await Bun.file(join(h.root, "transactions", "abababababababababababababababab", "journal.json")).exists()).toBeTrue()
  } finally { await h.cleanup() }
})

test("ownership rollback restores byte-identical existing state or preserves absence", async () => {
  for (const existing of [true, false]) {
    const h = await transactionFixture()
    try {
      const ownership = join(h.root, "state", "ownership.json")
      if (existing) { await mkdir(join(h.root, "state"), { recursive: true }); await writeFile(ownership, "{\"opaque\":true}\n", { mode: 0o640 }) }
      const before = await snapshot(ownership)
      await expect(executeTransaction(plan(h.root), { ...h.deps, faultPhase: { phase: "ownership_committed", boundary: "after" } })).rejects.toThrow()
      expect(await snapshot(ownership)).toEqual(before)
    } finally { await h.cleanup() }
  }
})

test("config removal commits absence and crash recovery restores exact bytes", async () => {
  for (const crash of [false, true]) {
    const h = await transactionFixture({ alive: false })
    try {
      const path = join(h.root, "created-config.json"), original = new TextEncoder().encode('{\n  "plugin": []\n}\n')
      await mkdir(h.root, { recursive: true })
      await writeFile(path, original, { mode: 0o600 })
      const removal = { ...plan(h.root), configMutations: [{ logicalPath: path, resolvedPath: path, bytes: new Uint8Array(), remove: true as const }] }
      if (!crash) {
        await executeTransaction(removal, h.deps)
        expect(await snapshot(path)).toEqual({ type: "absent" })
      } else {
        await expect(executeTransaction(removal, { ...h.deps, crashMutation: { operation: "config", occurrence: 1, boundary: "published" } } as any)).rejects.toThrow("E_CRASH")
        await recoverIncomplete(h.root, h.deps)
        expect(await snapshot(path)).toEqual({ type: "file", bytes: original, mode: 0o600 })
      }
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
