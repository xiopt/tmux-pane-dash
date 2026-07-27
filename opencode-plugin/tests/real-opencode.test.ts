import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { access, readFile } from "node:fs/promises"
import { constants } from "node:fs"
import { join, resolve } from "node:path"

const PINNED = "1.17.20"
const SHA256 = "14a4583c9a3685875f011d6dd4dfbd00498893942be0bb1d2c27e30e70144c89"
const repositoryRoot = resolve(import.meta.dir, "../..")
const rows = [
  { name: "pinned-1.17.20", binary: process.env.OPENCODE_1_17_20_BIN, version: PINNED },
  { name: "latest-stable-1.17.20", binary: process.env.OPENCODE_LATEST_BIN, version: PINNED },
] as const

async function run(argv: string[]): Promise<string> {
  const child = Bun.spawn(argv, { cwd: repositoryRoot, stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (code !== 0) throw new Error(`${argv.join(" ")} failed: ${stderr}`)
  return stdout
}

test("real OpenCode loads the packed plugin in both permanent compatibility rows", { timeout: 120_000 }, async () => {
  await expect(access(join(import.meta.dir, "..", "dist", "index.js"), constants.R_OK)).resolves.toBeNull()

  for (const row of rows) {
    expect(row.binary).toMatch(/^\//)
    await expect(access(row.binary!, constants.X_OK)).resolves.toBeNull()
    const version = (await run([row.binary!, "--version"])).trim().replace(/^v/, "")
    const hash = createHash("sha256").update(await readFile(row.binary!)).digest("hex")
    expect(version).toBe(row.version)
    expect(hash).toBe(SHA256)

    const output = await run([
      "tests/release/with-npa.sh", "--", "scripts/release/clean-room.sh", "--", "bun", "scripts/release/spikes.ts",
      "--opencode-1.17.20", row.binary!, "--registry-host=127.0.0.1",
    ])
    expect(output).toContain("name=@xiopt/pane-dash-opencode rawSpec=0.1.0 status=PASS cleanup=PASS")
    expect(output).toContain("public-network-requests=0")
    console.log(`${row.name} version=${version} sha256=${hash} status=PASS cleanup=PASS public-network-requests=0`)
  }
})
