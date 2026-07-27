import { expect, test } from "bun:test"
import { readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createJournal, persistJournal, readJournal, transitionJournal, type JournalPhase } from "../src/journal"
import { transactionFixture } from "./helpers/fixture"

const phases: readonly JournalPhase[] = ["prepared", "version_staged", "configs_staged", "current_switched", "configs_committed", "ownership_committed", "complete"]

test("journal persists every named phase before its dependent mutation", async () => {
  for (const phase of phases) {
    const h = await transactionFixture()
    try {
      const journal = createJournal({ id: "a".repeat(32), command: "setup", packageVersion: "0.1.0", previousCurrent: null, components: { tmux: true, opencode: true } })
      journal.phase = phase
      await persistJournal(journal, h.deps)
      expect((await readJournal(h.root, journal.id, h.deps))?.phase).toBe(phase)
      expect(h.operations.map(row => row.name)).toContain("fsync.parent")
    } finally { await h.cleanup() }
  }
})

test("journal rejects malformed or unsupported schemas and typed mutation omissions", async () => {
  const h = await transactionFixture()
  try {
    await writeFile(join(h.root, "transactions", "bad", "journal.json"), JSON.stringify({ schemaVersion: 2 }), { recursive: true } as any).catch(async () => { await Bun.$`mkdir -p ${join(h.root, "transactions", "bad")}`; await writeFile(join(h.root, "transactions", "bad", "journal.json"), JSON.stringify({ schemaVersion: 2 })) })
    await expect(readJournal(h.root, "bad", h.deps)).rejects.toThrow("E_JOURNAL")
    await expect(transitionJournal(createJournal({ id: "b".repeat(32), command: "setup", packageVersion: "0.1.0", previousCurrent: null, components: { tmux: false, opencode: false } }), "complete", h.deps)).rejects.toThrow("E_JOURNAL")
  } finally { await h.cleanup() }
})
