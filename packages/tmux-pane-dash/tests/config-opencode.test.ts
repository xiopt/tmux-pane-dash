import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { planOpenCodeEdit, selectOpenCodeConfig, selectOpenCodeTuiConfig } from "../src/config-opencode"
import { fixtureDependencies } from "./helpers/fixture"

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

test("OpenCode selection is deterministic for missing, one, and same-inode candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "pane-dash-open-")), config = join(root, "opencode"), h = fixtureDependencies()
  try {
    await mkdir(config)
    expect(await selectOpenCodeConfig({ XDG_CONFIG_HOME: root }, h.deps)).toBe(join(config, "opencode.json"))
    expect(selectOpenCodeTuiConfig({ XDG_CONFIG_HOME: root })).toBe(join(config, "tui.json"))
    await writeFile(join(config, "opencode.json"), "{}")
    await symlink("opencode.json", join(config, "opencode.jsonc"))
    expect(await selectOpenCodeConfig({ XDG_CONFIG_HOME: root }, h.deps)).toBe(join(config, "opencode.json"))
    await rm(join(config, "opencode.jsonc")); await writeFile(join(config, "opencode.jsonc"), "{}")
    await expect(selectOpenCodeConfig({ XDG_CONFIG_HOME: root }, h.deps)).rejects.toMatchObject({ code: "E_CONFIG_AMBIGUOUS" })
  } finally { await Bun.$`rm -rf ${root}` }
})

test("JSONC editor inserts a plugin without rewriting existing plugin-array bytes", () => {
  const source = "{\r\n  // keep\r\n  \"x\": 1,\r\n  \"plugin\": [\r\n    /* before */ \"other\\u002fplugin\", // after\r\n  ],\r\n}\r\n"
  const input = { logicalPath: "/x/opencode.json", resolvedPath: "/x/opencode.json", bytes: new TextEncoder().encode(source), migrate: false }
  const planned = planOpenCodeEdit(input)
  expect(decode(planned.bytes)).toBe("{\r\n  // keep\r\n  \"x\": 1,\r\n  \"plugin\": [\r\n    /* before */ \"other\\u002fplugin\",\r\n    \"@xiopt/pane-dash-opencode@0.1.7\", // after\r\n  ],\r\n}\r\n")
  expect(planOpenCodeEdit({ ...input, bytes: planned.bytes }).bytes).toEqual(planned.bytes)
})

test("JSONC editor replaces only one ownership-proven prior plugin string", () => {
  const source = "{\n\t\"plugin\" : [ /* keep */ \"unrelated\\u002fplugin\" ,\n\t\t\"@xiopt/pane-dash-opencode@0.0.9\" /* tail */ ],\n\t\"odd\" : true\n}\n"
  const input = { logicalPath: "/x/opencode.json", resolvedPath: "/x/opencode.json", bytes: new TextEncoder().encode(source), migrate: false, ownedEntries: ["@xiopt/pane-dash-opencode@0.0.9"] }
  const planned = planOpenCodeEdit(input)
  expect(decode(planned.bytes)).toBe("{\n\t\"plugin\" : [ /* keep */ \"unrelated\\u002fplugin\" ,\n\t\t\"@xiopt/pane-dash-opencode@0.1.7\" /* tail */ ],\n\t\"odd\" : true\n}\n")
  expect(planOpenCodeEdit({ ...input, bytes: planned.bytes }).bytes).toEqual(planned.bytes)
  for (const bad of [
    "[]", "{\"plugin\":{}}", "{\"plugin\":[1]}", "{\"plugin\":[],\"plugin\":[]}",
    "{\"plugin\":[\"@xiopt/pane-dash-opencode@0.0.8\"]}",
    "{\"plugin\":[\"@xiopt/pane-dash-opencode@0.0.9\",\"@xiopt/pane-dash-opencode@0.0.8\"]}",
    "{\"plugin\":[\"@xiopt/pane-dash-opencode@0.1.0\",\"@xiopt/pane-dash-opencode@0.0.9\"]}",
  ]) expect(() => planOpenCodeEdit({ ...input, bytes: new TextEncoder().encode(bad), ownedEntries: ["@xiopt/pane-dash-opencode@0.0.9"] })).toThrow()
})
