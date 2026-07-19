import { expect, test } from "bun:test"
import { sanitize } from "../src/sanitize"

test("sanitize strips control characters and caps option values at 120 characters", () => {
  expect(sanitize("title\twith\ncontrols\u001b[31m")).toBe("titlewithcontrols[31m")
  expect(sanitize("a".repeat(121))).toBe("a".repeat(120))
})
