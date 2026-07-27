import { expect, test } from "bun:test"
import { CliError, escapeOutput, exitStatusFor } from "../src/errors"

test("defines stable exit statuses", () => {
  expect(exitStatusFor(new CliError("E_USAGE"))).toBe(2)
  expect(exitStatusFor(new CliError("E_LOCKED"))).toBe(73)
  expect(exitStatusFor(new CliError("E_SIGNAL_HUP"))).toBe(129)
  expect(exitStatusFor(new CliError("E_SIGNAL_INT"))).toBe(130)
  expect(exitStatusFor(new CliError("E_SIGNAL_TERM"))).toBe(143)
  expect(exitStatusFor(new CliError("E_DOWNGRADE"))).toBe(1)
  expect(exitStatusFor(undefined)).toBe(1)
})

test("bounds and control-escapes untrusted output", () => {
  const hostile = `bad\u0000\n\r\t\u001b${"x".repeat(500)}`
  const escaped = escapeOutput(hostile, 40)
  expect(escaped).toContain("\\u0000")
  expect(escaped).toContain("\\u000a")
  expect(escaped).toContain("\\u001b")
  expect(escaped).not.toMatch(/[\u0000-\u001f\u007f]/)
  expect(escaped.length).toBeLessThanOrEqual(40)
})
