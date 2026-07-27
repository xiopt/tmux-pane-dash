import { expect, test } from "bun:test"
import { update } from "../src/commands/update"
import { transactionFixture } from "./helpers/fixture"

test("update without ownership is usage and performs no fetch", async () => {
  const h = await transactionFixture()
  try { await expect(update(h.deps)).rejects.toMatchObject({ code: "E_USAGE" }); expect(h.calls.fetch).toBe(0) } finally { await h.cleanup() }
})
