import { expect, test } from "bun:test"
import { lstat, mkdtemp, mkdir, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inventoryConflicts } from "../src/commands/setup"
import { planOpenCodeMigration } from "../src/config-opencode"
import { transactionFixture } from "./helpers/fixture"

async function checkout() {
  const root = await mkdtemp(join(tmpdir(), "pane-dash-open-migrate-")), directory = join(root, "tmux-pane-dash"), target = join(directory, "opencode-plugin", "pane-dash.ts")
  await mkdir(join(directory, "opencode-plugin"), { recursive: true }); await writeFile(target, "export {}")
  return { root, directory, target }
}

test("plans a legacy OpenCode link by its checkout path without touching it", async () => {
  const h = await checkout(), config = join(h.root, "opencode"), legacy = join(config, "plugin", "pane-dash.ts")
  try {
    await mkdir(join(config, "plugin"), { recursive: true }); await symlink(h.target, legacy)
    await expect(planOpenCodeMigration({ configDirectory: config, migrate: true })).resolves.toEqual([{ logicalPath: legacy, resolvedPath: await realpath(h.target), action: "unlink" }])
    expect(await readlink(legacy)).toBe(h.target); expect(await readFile(h.target, "utf8")).toBe("export {}")
  } finally { await rm(h.root, { recursive: true, force: true }) }
})

test("setup inventory recognizes the legacy OpenCode link without a tmux component", async () => {
  const h = await checkout(), fixture = await transactionFixture(), config = join(fixture.outside, ".config", "opencode"), legacy = join(config, "plugin", "pane-dash.ts")
  try {
    await mkdir(join(config, "plugin"), { recursive: true }); await writeFile(join(config, "opencode.json"), "{}\n"); await symlink(h.target, legacy)
    const inventory = await inventoryConflicts({ tmux: false, opencode: true, migrate: true }, { ...fixture.deps, env: { XDG_DATA_HOME: join(fixture.outside, "data"), HOME: fixture.outside } })
    expect(inventory.migrations).toEqual([{ logicalPath: legacy, resolvedPath: await realpath(h.target), action: "unlink" }])
    expect(await readlink(legacy)).toBe(h.target); expect(await readFile(h.target, "utf8")).toBe("export {}")
  } finally { await fixture.cleanup(); await rm(h.root, { recursive: true, force: true }) }
})

test("legacy OpenCode migration rejects unsafe or ambiguous candidates without changing links or targets", async () => {
  for (const row of ["wrong-suffix", "directory", "dangling", "ambiguous", "regular"] as const) {
    const h = await checkout(), config = join(h.root, "opencode"), plugin = join(config, "plugin"), legacy = join(plugin, "pane-dash.ts")
    try {
      await mkdir(plugin, { recursive: true })
      const target = join(h.root, "other", "pane-dash.ts")
      if (row === "wrong-suffix") { await mkdir(join(h.root, "other"), { recursive: true }); await writeFile(target, "other"); await symlink(target, legacy) }
      else if (row === "directory") { await rm(h.target); await mkdir(h.target); await symlink(h.target, legacy) }
      else if (row === "dangling") await symlink("missing.ts", legacy)
      else if (row === "regular") await writeFile(legacy, "regular")
      else { await mkdir(join(config, "plugins"), { recursive: true }); await symlink(h.target, legacy); await symlink(h.target, join(config, "plugins", "pane-dash.ts")) }

      const beforeLink = row === "regular" ? await readFile(legacy, "utf8") : await readlink(legacy)
      const candidateTarget = row === "wrong-suffix" ? target : h.target, beforeTarget = row === "directory" ? (await lstat(candidateTarget)).isDirectory() : await readFile(candidateTarget, "utf8")
      await expect(planOpenCodeMigration({ configDirectory: config, migrate: true })).rejects.toMatchObject({ code: "E_CONFIG_CONFLICT" })
      expect(row === "regular" ? await readFile(legacy, "utf8") : await readlink(legacy)).toBe(beforeLink)
      expect(row === "directory" ? (await lstat(candidateTarget)).isDirectory() : await readFile(candidateTarget, "utf8")).toBe(beforeTarget)
      if (row === "ambiguous") expect(await readlink(join(config, "plugins", "pane-dash.ts"))).toBe(h.target)
    } finally { await rm(h.root, { recursive: true, force: true }) }
  }
})
