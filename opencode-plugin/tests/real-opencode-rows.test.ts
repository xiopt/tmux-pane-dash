import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { resolveLatestCompatibility } from "./helpers/real-opencode"

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
