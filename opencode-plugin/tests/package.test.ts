import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const packageRoot = join(import.meta.dir, "..")
const expectedEntries = [
  "package/LICENSE",
  "package/README.md",
  "package/dist/index.js",
  "package/package.json",
]

async function command(argv: string[], cwd = packageRoot): Promise<string> {
  const child = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error(`${argv.join(" ")} failed: ${stderr}`)
  return stdout
}

test("the packed plugin has the exact self-contained importable inventory", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "pane-dash-plugin-pack-"))
  try {
    const packed = JSON.parse(await command(["npm", "pack", "--ignore-scripts", "--json", "--pack-destination", scratch])) as Array<{ filename: string }>
    const tarball = join(scratch, packed[0]!.filename)
    expect((await command(["tar", "-tzf", tarball], scratch)).trim().split("\n").sort()).toEqual(expectedEntries)

    await command(["tar", "-xzf", tarball], scratch)
    const manifest = JSON.parse(await readFile(join(scratch, "package", "package.json"), "utf8"))
    expect(manifest.main).toBe("./dist/index.js")
    expect(manifest.exports).toEqual({ ".": "./dist/index.js", "./server": "./dist/index.js" })
    expect(manifest.files).toEqual(["dist/index.js", "README.md", "LICENSE"])
    expect(manifest.dependencies).toBeUndefined()

    const bundle = await readFile(join(scratch, "package", "dist", "index.js"), "utf8")
    expect(bundle).not.toMatch(/sourceMappingURL|from\s+["'](?!node:|bun:)/)

    const consumer = join(scratch, "consumer")
    await mkdir(join(consumer, "node_modules", "@xiopt"), { recursive: true })
    await symlink(join(scratch, "package"), join(consumer, "node_modules", "@xiopt", "pane-dash-opencode"))
    const importer = join(consumer, "imports.mjs")
    await writeFile(importer, `import * as root from "@xiopt/pane-dash-opencode"; import * as server from "@xiopt/pane-dash-opencode/server"; if (typeof root.PaneDash !== "function" || typeof server.PaneDash !== "function") process.exit(1)\n`)
    await command([process.execPath, importer], consumer)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})
