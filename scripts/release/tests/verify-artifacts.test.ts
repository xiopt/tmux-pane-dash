import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { verifyReleaseDirectory } from "../verify-artifacts"

test("verifier requires exactly four archives plus release manifest and checksums", async () => {
  const root = await mkdtemp(join(tmpdir(), "pane-dash-release-"))
  try {
    await expect(verifyReleaseDirectory(root)).rejects.toThrow("exactly six release assets")
  } finally { await rm(root, { recursive: true, force: true }) }
})
