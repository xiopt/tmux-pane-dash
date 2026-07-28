import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

test("local closure records every gate and leaves production pending", async () => {
  const evidence = await readFile("spike/results/v0.1-release-gate.md", "utf8")
  for (const task of Array.from({ length: 15 }, (_, index) => `Task ${index + 1}`)) expect(evidence).toContain(task)
  expect(evidence).toContain("Overall implementation base SHA: `7bc976a3b71df8ee65de2ef254adba5d51ee3a12`")
  expect(evidence).toContain("Task 15 base SHA: `e8669cf5b38cd4ce849e97abb9a90a60da9832ed`")
  expect(evidence).toContain("WAIVED BY USER / unavailable — not executed and not claimed PASS")
  expect(evidence).toContain("Independent final verifier: **APPROVED**")
  expect(evidence).toContain("Separate adversarial security/release review: **APPROVED**")
  expect(evidence).toContain("Security-review pre-refresh SHA: `66b995c`")
  expect(evidence).toContain("remote-mutations=0")
  expect(evidence).toContain("public-network-requests=0")
  expect(evidence).toContain("Stage B: PENDING EXPLICIT APPROVALS")
})
