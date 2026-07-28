import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

test("local closure records every gate and leaves production pending", async () => {
  const evidence = await readFile("spike/results/v0.1-release-gate.md", "utf8")
  for (const task of Array.from({ length: 15 }, (_, index) => `Task ${index + 1}`)) expect(evidence).toContain(task)
  expect(evidence).toContain("remote-mutations=0")
  expect(evidence).toContain("public-network-requests=0")
  expect(evidence).toContain("Stage B: PENDING EXPLICIT APPROVALS")
})
