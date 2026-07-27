import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, readdir, readlink, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { atomicConfigWrite, resolveConfigPath } from "../src/fs"
import { fixtureDependencies } from "./helpers/fixture"

const bytes = (value: string) => new TextEncoder().encode(value)

test("config resolver and atomic writer preserve paths, modes, bytes, and symlink targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "pane-dash-config-")), logical = join(root, "logical"), target = join(root, "target")
  try {
    await writeFile(target, "before", { mode: 0o640 }); await symlink("target", logical)
    const h = fixtureDependencies(), resolved = await resolveConfigPath(logical, h.deps)
    expect(resolved).toMatchObject({ logicalPath: logical, resolvedPath: target })
    expect(resolved.symlinkChain).toHaveLength(1)
    await atomicConfigWrite({ ...resolved, bytes: bytes("after") }, h.deps)
    expect(await readFile(target, "utf8")).toBe("after")
    expect(await readlink(logical)).toBe("target")
  } finally { await Bun.$`rm -rf ${root}` }
})

test("config resolution accepts missing files and rejects unsafe symlink outcomes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pane-dash-config-")), h = fixtureDependencies()
  try {
    await expect(resolveConfigPath(join(root, "missing"), h.deps)).resolves.toMatchObject({ logicalPath: join(root, "missing"), resolvedPath: join(root, "missing") })
    for (const row of ["loop", "dangling", "directory"] as const) {
      const path = join(root, row)
      if (row === "loop") await symlink("loop", path)
      if (row === "dangling") await symlink("gone", path)
      if (row === "directory") { await mkdir(join(root, "dir")); await symlink("dir", path) }
      await expect(resolveConfigPath(path, h.deps)).rejects.toThrow()
    }
  } finally { await Bun.$`rm -rf ${root}` }
})

test("atomic writer rejects a same-size edit after its reread and removes its temporary file", async () => {
  const root = await mkdtemp(join(tmpdir(), "pane-dash-config-")), path = join(root, "opencode.json"), h = fixtureDependencies(), events: string[] = []
  try {
    await writeFile(path, "before")
    const resolved = await resolveConfigPath(path, h.deps)
    await expect(atomicConfigWrite({ ...resolved, bytes: bytes("after!") }, {
      ...h.deps,
      randomBytes: size => new Uint8Array(size),
      journalEvent: event => events.push(event),
      beforeRename: async () => { await writeFile(path, "other!") },
    })).rejects.toMatchObject({ code: "E_CONCURRENT_EDIT" })
    expect(await readFile(path, "utf8")).toBe("other!")
    expect(await readdir(root)).toEqual(["opencode.json"])
    expect(events).toEqual(["fsync.file"])
  } finally { await Bun.$`rm -rf ${root}` }
})
