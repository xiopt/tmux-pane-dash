import { expect, test } from "bun:test"
import { parseArgs } from "../src/args"
import { CliError } from "../src/errors"

test("parses the exact setup grammar", () => {
  expect(parseArgs(["setup"])).toEqual({ name: "setup", tmux: true, opencode: true, migrate: false, allowDowngrade: false })
  expect(parseArgs(["setup", "--allow-downgrade", "--no-opencode"])).toEqual({ name: "setup", tmux: true, opencode: false, migrate: false, allowDowngrade: true })
  expect(parseArgs(["setup", "--no-tmux", "--migrate"])).toEqual({ name: "setup", tmux: false, opencode: true, migrate: true, allowDowngrade: false })
})

test("rejects missing, unknown, misplaced, duplicate, and conflicting options", () => {
  for (const argv of [[], ["wat"], ["update", "--allow-downgrade"], ["doctor", "--migrate"], ["uninstall", "--json"], ["setup", "--migrate", "--migrate"], ["setup", "--no-tmux", "--no-opencode"]]) {
    expect(() => parseArgs(argv)).toThrow(CliError)
    expect(() => parseArgs(argv)).toThrow(/E_USAGE/)
  }
})

test("allows doctor JSON only for doctor", () => {
  expect(parseArgs(["doctor"])).toEqual({ name: "doctor", json: false })
  expect(parseArgs(["doctor", "--json"])).toEqual({ name: "doctor", json: true })
})
