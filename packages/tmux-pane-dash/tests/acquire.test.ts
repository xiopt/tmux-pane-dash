import { expect, test } from "bun:test"
import { installedFixture } from "./helpers/fixture"
import { acquireRelease } from "../src/acquire"

test("invalid existing versions are staged rather than repaired", async () => {
  const h = await installedFixture("0.1.0")
  await expect(acquireRelease(h.context)).rejects.toThrow("E_DOWNLOAD_STATUS")
  expect(h.calls.fetch).toBe(1)
})
