import { expect, test } from "bun:test"
import { selectTarget } from "../src/platform"
import { CliError } from "../src/errors"

test("selects only the four supported Node platform pairs", () => {
  expect(selectTarget("darwin", "arm64")).toBe("darwin-arm64")
  expect(selectTarget("darwin", "x64")).toBe("darwin-x64")
  expect(selectTarget("linux", "arm64")).toBe("linux-arm64")
  expect(selectTarget("linux", "x64")).toBe("linux-x64")
})

test("rejects every unsupported pair before download", () => {
  for (const pair of [["win32", "x64"], ["darwin", "ia32"], ["linux", "ppc64"]] as const) {
    expect(() => selectTarget(...pair)).toThrow(CliError)
  }
})
