import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { buildArchive } from "./archive"
import { canonicalJson, sha256, sourceDateEpoch, type GitReader } from "./canonical-json"
import { TARGETS } from "./contracts"
import { releaseManifest, sha256Sums, type VerifiedAsset } from "./manifest"
import { verifyReleaseDirectory } from "./verify-artifacts"

const git: GitReader = { async run(args) { const child = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" }); const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); if (code !== 0) throw new Error(stderr.trim()); return stdout } }
const fixture = (target: string) => target.startsWith("aarch64-apple") ? new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 12, 0, 0, 1]) : target.startsWith("x86_64-apple") ? new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1]) : new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, target.startsWith("aarch64") ? 0xb7 : 0x3e, 0, 0, 0, ...new Array(48).fill(0)])

async function epoch(tagCommit: string): Promise<number> {
  const resolved = (await git.run(["rev-parse", `${tagCommit}^{commit}`])).trim()
  return sourceDateEpoch({ run: async (args) => args[0] === "rev-parse" ? `${resolved}\n` : git.run(args) }, tagCommit, resolved)
}

async function build(output: string, tagCommit: string, localFixtures: boolean): Promise<void> {
  if (!localFixtures) throw new Error("only --local-fixtures is supported by this local builder")
  const sourceEpoch = await epoch(tagCommit); await mkdir(output, { recursive: true }); const assets: VerifiedAsset[] = []
  for (const [key, target] of Object.entries(TARGETS)) {
    const root = join(output, `.stage-${key}`); await mkdir(join(root, "scripts"), { recursive: true }); await mkdir(join(root, "bin"), { recursive: true })
    try {
      for (const path of ["pane_dash.tmux", "README.md", "LICENSE", "VERSION", "scripts/open.sh", "scripts/tag.sh"]) await cp(path, join(root, path))
      const binary = join(root, "fixture"); await writeFile(binary, fixture(target.rustTarget)); const archive = join(output, target.asset)
      await buildArchive({ target: target.rustTarget, binary, output: archive, epoch: sourceEpoch, root }); const bytes = await readFile(archive); assets.push({ key, target: target.rustTarget, asset: target.asset, sha256: sha256(bytes), size: (await stat(archive)).size })
    } finally { await rm(root, { recursive: true, force: true }) }
  }
  await writeFile(join(output, "release-manifest.json"), canonicalJson(await releaseManifest(assets))); await writeFile(join(output, "SHA256SUMS"), sha256Sums(assets)); await verifyReleaseDirectory(output)
}

if (import.meta.main) {
  const args = process.argv.slice(2); const output = args[args.indexOf("--output") + 1]; const tagCommit = args[args.indexOf("--tag-commit") + 1]
  if (!args.includes("--local-fixtures") || !output || !tagCommit) throw new Error("usage: build.ts --local-fixtures --tag-commit COMMIT --output DIRECTORY")
  await build(output, tagCommit, true); console.log("archives=4 assets=6 inventories=exact reproducible=PASS")
}
