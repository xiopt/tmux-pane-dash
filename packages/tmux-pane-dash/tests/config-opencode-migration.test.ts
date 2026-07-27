import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { planOpenCodeMigration } from "../src/config-opencode"

test("plans only a known global legacy OpenCode symlink migration", async () => {
  const root = await mkdtemp(join(tmpdir(), "pane-dash-open-migrate-")), config = join(root, "opencode"), install = join(root, "install")
  try {
    await mkdir(join(config, "plugin"), { recursive: true }); await mkdir(join(install, "opencode-plugin"), { recursive: true }); await writeFile(join(install, "opencode-plugin", "pane-dash.ts"), "export {}")
    const legacy = join(config, "plugin", "pane-dash.ts"); await symlink(join(install, "opencode-plugin", "pane-dash.ts"), legacy)
    await expect(planOpenCodeMigration({ configDirectory: config, installRoot: install, migrate: true })).resolves.toEqual([{ logicalPath: legacy, resolvedPath: join(install, "opencode-plugin", "pane-dash.ts"), action: "unlink" }])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("legacy OpenCode migration rejects every unsafe or ambiguous candidate", async () => {
  for (const row of ["regular", "dangling", "unknown", "ambiguous"] as const) {
    const root = await mkdtemp(join(tmpdir(), "pane-dash-open-migrate-")), config = join(root, "opencode"), install = join(root, "install")
    try {
      await mkdir(join(config, "plugin"), { recursive: true }); await mkdir(join(config, "plugins"), { recursive: true }); await mkdir(join(install, "opencode-plugin"), { recursive: true }); await writeFile(join(install, "opencode-plugin", "pane-dash.ts"), "export {}")
      const legacy = join(config, "plugin", "pane-dash.ts")
      if (row === "regular") await writeFile(legacy, "export {}")
      else if (row === "dangling") await symlink("missing.ts", legacy)
      else if (row === "unknown") { await writeFile(join(root, "other.ts"), "export {}"); await symlink(join(root, "other.ts"), legacy) }
      else { await symlink(join(install, "opencode-plugin", "pane-dash.ts"), legacy); await symlink(join(install, "opencode-plugin", "pane-dash.ts"), join(config, "plugins", "pane-dash.ts")) }
      await expect(planOpenCodeMigration({ configDirectory: config, installRoot: install, migrate: true })).rejects.toThrow()
    } finally { await rm(root, { recursive: true, force: true }) }
  }
})
