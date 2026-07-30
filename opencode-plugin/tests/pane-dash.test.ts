import { expect, test } from "bun:test"
import { isServeInvocation } from "../src/mode"
import { sanitize } from "../src/sanitize"

test("sanitize strips control characters and caps option values at 120 characters", () => {
  expect(sanitize("title\twith\ncontrols\u001b[31m")).toBe("titlewithcontrols[31m")
  expect(sanitize("a".repeat(121))).toBe("a".repeat(120))
})

test("recognizes only the exact OpenCode serve subcommand", () => {
  expect(isServeInvocation(["/opt/homebrew/bin/opencode", "serve"])).toBe(true)
  expect(isServeInvocation(["/opt/homebrew/bin/opencode"])).toBe(false)
  expect(isServeInvocation(["/opt/homebrew/bin/opencode", "serve-now"])).toBe(false)
  expect(isServeInvocation(["/opt/homebrew/bin/opencode", "/tmp/serve"])).toBe(false)
})
