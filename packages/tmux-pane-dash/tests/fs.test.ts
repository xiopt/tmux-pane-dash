import { expect, test } from "bun:test"
import { canonicalPayloadPath, nodeFsOps } from "../src/fs"

test("accepts only canonical payload-relative paths", () => {
  expect(canonicalPayloadPath("bin/pane-dash")).toBe("bin/pane-dash")
  for (const path of ["", "/bin/pane-dash", "./bin/pane-dash", "bin/../pane-dash", "bin\\pane-dash", "bin//pane-dash", "bin/pane-dash\0x"]) expect(() => canonicalPayloadPath(path)).toThrow()
})

test("node filesystem operations create files exclusively", async () => {
  const fs = nodeFsOps()
  const root = `${import.meta.dir}/.tmp-fs-${crypto.randomUUID()}`
  try {
    await fs.mkdir(root)
    await fs.writeFileExclusive(root, "file", new Uint8Array([1]), 0o644)
    await expect(fs.writeFileExclusive(root, "file", new Uint8Array([2]), 0o644)).rejects.toThrow()
  } finally { await fs.rm(root) }
})
