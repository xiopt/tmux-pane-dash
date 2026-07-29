import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { resolveCompatibilityRows, resolveLatestCompatibility } from "./helpers/real-opencode"

test("pinned compatibility keeps rejecting a binary with an untrusted hash", async () => {
  const probed: string[] = []
  await expect(resolveCompatibilityRows(
    "/tmp/opencode-pinned",
    "/tmp/opencode-latest",
    async binary => {
      probed.push(binary)
      return binary.endsWith("pinned") ? "1.17.20\n" : "1.18.21\n"
    },
    async () => new TextEncoder().encode("not the pinned executable"),
  )).rejects.toThrow("hash does not match the pinned OpenCode binary")
  expect(probed).toEqual(["/tmp/opencode-pinned"])
})

test("latest compatibility resolves its own newer version and executable hash", async () => {
  const bytes = new TextEncoder().encode("synthetic latest OpenCode executable")
  const row = await resolveLatestCompatibility(
    "/tmp/opencode-latest",
    async binary => {
      expect(binary).toBe("/tmp/opencode-latest")
      return "v1.18.21\n"
    },
    async binary => {
      expect(binary).toBe("/tmp/opencode-latest")
      return bytes
    },
  )

  expect(row).toEqual({
    name: "latest-stable-1.18.21",
    binary: "/tmp/opencode-latest",
    version: "1.18.21",
    sha256: createHash("sha256").update(bytes).digest("hex"),
  })
})

test.each(["v1.18.21-beta.1\n", "1.18\n", "v1.17.19\n"])("latest compatibility rejects invalid version %j", async output => {
  await expect(resolveLatestCompatibility("/tmp/opencode-latest", async () => output, async () => new Uint8Array())).rejects.toThrow()
})
