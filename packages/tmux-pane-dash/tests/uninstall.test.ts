import { expect, test } from "bun:test"
import { uninstall } from "../src/commands/uninstall"
import { transactionFixture } from "./helpers/fixture"

test("second clean uninstall is idempotent", async () => {
  const h = await transactionFixture()
  try { await expect(uninstall(h.deps)).resolves.toBeUndefined() } finally { await h.cleanup() }
})
