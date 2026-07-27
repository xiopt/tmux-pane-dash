import { expect, test } from "bun:test"
import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { managedRoot, readOwnership, validateManagedRoot } from "../src/ownership"
import { transactionFixture } from "./helpers/fixture"

test("managed root uses nonempty XDG data home and otherwise HOME fallback", async () => {
  await expect(managedRoot({ XDG_DATA_HOME: "/data", HOME: "/home/a" })).resolves.toBe("/data/tmux-pane-dash")
  await expect(managedRoot({ XDG_DATA_HOME: "", HOME: "/home/a" })).resolves.toBe("/home/a/.local/share/tmux-pane-dash")
  await expect(managedRoot({ HOME: "" })).rejects.toThrow("E_ROOT")
  await expect(managedRoot({})).rejects.toThrow("E_ROOT")
})

test("ownership rejects every hostile managed path row", async () => {
  const rows = ["symlink-parent", "file-directory", "group-writable", "escape", "unexpected-content"] as const
  for (const row of rows) {
    const h = await transactionFixture()
    try {
      await mkdir(h.root, { recursive: true, mode: 0o700 })
      if (row === "symlink-parent") { await rm(h.root, { recursive: true, force: true }); await symlink(h.outside, h.root) }
      if (row === "file-directory") { await rm(h.root, { recursive: true, force: true }); await writeFile(h.root, "not a directory") }
      if (row === "group-writable") await chmod(h.root, 0o770)
      if (row === "escape") { await mkdir(join(h.root, "versions")); await symlink(h.outside, join(h.root, "current")) }
      if (row === "unexpected-content") await writeFile(join(h.root, "surprise"), "x")
      await expect(validateManagedRoot(h.root, h.deps)).rejects.toThrow(/E_(ROOT|CONFLICT)/)
    } finally { await h.cleanup() }
  }
})

test("ownership requires current-user directories and relative current", async () => {
  const h = await transactionFixture()
  try {
    await mkdir(join(h.root, "versions", "0.1.0"), { recursive: true, mode: 0o700 })
    await mkdir(join(h.root, "state"), { mode: 0o700 }); await mkdir(join(h.root, "transactions"), { mode: 0o700 })
    await symlink("versions/0.1.0", join(h.root, "current"))
    await expect(validateManagedRoot(h.root, h.deps)).resolves.toBeUndefined()
    await expect(validateManagedRoot(h.root, { ...h.deps, uid: () => (process.getuid?.() ?? 0) + 1 })).rejects.toThrow("E_CONFLICT")
    await rm(join(h.root, "current")); await symlink("/tmp", join(h.root, "current"))
    await expect(validateManagedRoot(h.root, h.deps)).rejects.toThrow("E_CONFLICT")
  } finally { await h.cleanup() }
})

test("ownership is absent only when absent and rejects malformed or unsupported records", async () => {
  const h = await transactionFixture()
  try {
    await expect(readOwnership(h.root, h.deps)).resolves.toBeNull()
    await mkdir(join(h.root, "state"), { recursive: true })
    await writeFile(join(h.root, "state", "ownership.json"), "{")
    await expect(readOwnership(h.root, h.deps)).rejects.toThrow("E_OWNERSHIP")
    await writeFile(join(h.root, "state", "ownership.json"), JSON.stringify({ schemaVersion: 2 }))
    await expect(readOwnership(h.root, h.deps)).rejects.toThrow("E_OWNERSHIP")
  } finally { await h.cleanup() }
})
