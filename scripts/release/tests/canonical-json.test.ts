import { expect, test } from "bun:test"
import { canonicalJson, sha256, sourceDateEpoch } from "../canonical-json"

test("canonical JSON is UTF-8, key sorted, and LF terminated", () => {
  expect(new TextDecoder().decode(canonicalJson({ z: "é", a: [true, 1] }))).toBe('{"a":[true,1],"z":"é"}\n')
  expect(sha256(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
})

test("canonical JSON rejects non-JSON values and unsafe integers", () => {
  expect(() => canonicalJson({ value: undefined })).toThrow()
  expect(() => canonicalJson({ value: Number.MAX_SAFE_INTEGER + 1 })).toThrow()
})

test("epoch is the supplied tag commit committer timestamp", async () => {
  const calls: string[][] = []
  const git = {
    async run(args: string[]) {
      calls.push(args)
      if (args.join(" ") === "rev-parse refs/tags/v0.1.0^{commit}") return "7bc976a\n"
      if (args.join(" ") === "show -s --format=%ct 7bc976a") return "1721740800\n"
      throw new Error(`unexpected git command: ${args.join(" ")}`)
    },
  }
  await expect(sourceDateEpoch(git, "refs/tags/v0.1.0", "7bc976a")).resolves.toBe(1721740800)
  expect(calls).toEqual([
    ["rev-parse", "refs/tags/v0.1.0^{commit}"],
    ["show", "-s", "--format=%ct", "7bc976a"],
  ])
})

test("epoch rejects a lightweight tag that peels elsewhere", async () => {
  const git = { async run(args: string[]) { return args[0] === "rev-parse" ? "other\n" : "1\n" } }
  await expect(sourceDateEpoch(git, "refs/tags/v0.1.0", "7bc976a")).rejects.toThrow("does not resolve to supplied tag commit")
})
