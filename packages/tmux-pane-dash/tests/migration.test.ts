import { expect, test } from "bun:test"
import { inventoryConflicts } from "../src/commands/setup"
import { transactionFixture } from "./helpers/fixture"

test("disabled components have no config inventory side effects", async () => {
  const h = await transactionFixture()
  try { await expect(inventoryConflicts({ tmux: false, opencode: false, migrate: false }, h.deps)).resolves.toEqual({ tmux: null, opencode: null, migrations: [] }); expect(h.calls.fetch).toBe(0) } finally { await h.cleanup() }
})
