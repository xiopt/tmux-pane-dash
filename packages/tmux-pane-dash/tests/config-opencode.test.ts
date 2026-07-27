import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { planOpenCodeEdit, selectOpenCodeConfig } from "../src/config-opencode"
import { fixtureDependencies } from "./helpers/fixture"

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

test("OpenCode selection is deterministic for missing, one, and same-inode candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "pane-dash-open-")), config = join(root, "opencode"), h = fixtureDependencies()
  try {
    await mkdir(config)
    expect(await selectOpenCodeConfig({ XDG_CONFIG_HOME: root }, h.deps)).toBe(join(config, "opencode.json"))
    await writeFile(join(config, "opencode.json"), "{}")
    await symlink("opencode.json", join(config, "opencode.jsonc"))
    expect(await selectOpenCodeConfig({ XDG_CONFIG_HOME: root }, h.deps)).toBe(join(config, "opencode.json"))
    await rm(join(config, "opencode.jsonc")); await writeFile(join(config, "opencode.jsonc"), "{}")
    await expect(selectOpenCodeConfig({ XDG_CONFIG_HOME: root }, h.deps)).rejects.toMatchObject({ code: "E_CONFIG_AMBIGUOUS" })
  } finally { await Bun.$`rm -rf ${root}` }
})

test("JSONC editor changes only plugin array and detects plugin conflicts", () => {
  const source = "{\r\n  // keep\r\n  \"x\": 1,\r\n  \"plugin\": [\"other\",],\r\n}\r\n"
  const input = { logicalPath: "/x/opencode.json", resolvedPath: "/x/opencode.json", bytes: new TextEncoder().encode(source), migrate: false }
  const planned = planOpenCodeEdit(input)
  expect(decode(planned.bytes)).toBe("{\r\n  // keep\r\n  \"x\": 1,\r\n  \"plugin\": [\"other\", \"@xiopt/pane-dash-opencode@0.1.0\",],\r\n}\r\n")
  expect(planOpenCodeEdit({ ...input, bytes: planned.bytes }).bytes).toEqual(planned.bytes)
  for (const bad of ["[]", "{\"plugin\":{}}", "{\"plugin\":[1]}", "{\"plugin\":[],\"plugin\":[]}", "{\"plugin\":[\"@xiopt/pane-dash-opencode@0.0.9\"]}"]) expect(() => planOpenCodeEdit({ ...input, bytes: new TextEncoder().encode(bad) })).toThrow()
})
