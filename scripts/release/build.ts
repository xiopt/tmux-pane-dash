import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { buildArchive } from "./archive"
import { canonicalJson, sha256, sourceDateEpoch, type GitReader } from "./canonical-json"
import { TARGETS } from "./contracts"
import { releaseManifest, sha256Sums, type RustTarget, type VerifiedAsset } from "./manifest"
import { inspectBinary } from "./inspect-binary"
import { verifyReleaseDirectory } from "./verify-artifacts"

const git: GitReader = { async run(args) { const child = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" }); const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); if (code !== 0) throw new Error(stderr.trim()); return stdout } }
const hostTarget = () => process.platform === "darwin" ? process.arch === "arm64" ? "aarch64-apple-darwin" : process.arch === "x64" ? "x86_64-apple-darwin" : undefined : process.platform === "linux" ? process.arch === "arm64" ? "aarch64-unknown-linux-musl" : process.arch === "x64" ? "x86_64-unknown-linux-musl" : undefined : undefined
const fixture = async (target: string) => target === hostTarget() ? readFile("bin/pane-dash") : target.startsWith("aarch64-apple") ? new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 12, 0, 0, 1]) : target.startsWith("x86_64-apple") ? new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1]) : new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, target.startsWith("aarch64") ? 0xb7 : 0x3e, 0, 0, 0, ...new Array(48).fill(0)])

async function epoch(tagCommit: string): Promise<number> {
  const resolved = (await git.run(["rev-parse", `${tagCommit}^{commit}`])).trim()
  return sourceDateEpoch({ run: async (args) => args[0] === "rev-parse" ? `${resolved}\n` : git.run(args) }, tagCommit, resolved)
}

type TargetKey = keyof typeof TARGETS

function targetKey(value: string): TargetKey {
  if (!Object.hasOwn(TARGETS, value)) throw new Error(`unknown release target: ${value}`)
  return value as TargetKey
}

// Local fixtures use the host binary plus three deterministic synthetic targets;
// production workflows build all four targets and require a changed package build.
async function buildFixtureRelease(output: string, tagCommit: string): Promise<void> {
  const sourceEpoch = await epoch(tagCommit); await mkdir(output, { recursive: true }); const assets: VerifiedAsset[] = []
  for (const [key, target] of Object.entries(TARGETS)) {
    const root = join(output, `.stage-${key}`); await mkdir(join(root, "scripts"), { recursive: true }); await mkdir(join(root, "bin"), { recursive: true })
    try {
      for (const path of ["pane_dash.tmux", "README.md", "LICENSE", "VERSION", "scripts/open.sh", "scripts/tag.sh"]) await cp(path, join(root, path))
      const binary = join(root, "fixture"); await writeFile(binary, await fixture(target.rustTarget)); const archive = join(output, target.asset)
      await buildArchive({ target: target.rustTarget, binary, output: archive, epoch: sourceEpoch, root }); const bytes = await readFile(archive); assets.push({ key, target: target.rustTarget, asset: target.asset, sha256: sha256(bytes), size: (await stat(archive)).size })
    } finally { await rm(root, { recursive: true, force: true }) }
  }
  await writeFile(join(output, "release-manifest.json"), canonicalJson(await releaseManifest(assets))); await writeFile(join(output, "SHA256SUMS"), sha256Sums(assets)); await verifyReleaseDirectory(output, sourceEpoch)
}

/** Build one archive from the binary produced by the matching target runner. */
export async function buildTargetArchive(input: { target: TargetKey; binary: string; output: string; tagCommit: string }): Promise<string> {
  const target = TARGETS[input.target]
  const sourceEpoch = await epoch(input.tagCommit)
  await stat(input.binary)
  await inspectBinary(input.binary, target.rustTarget)
  await mkdir(input.output, { recursive: true })
  const archive = join(input.output, target.asset)
  await buildArchive({ target: target.rustTarget as RustTarget, binary: input.binary, output: archive, epoch: sourceEpoch })
  return archive
}

/** Assemble four already-built target archives without rebuilding any binary. */
export async function assembleRelease(input: { output: string; tagCommit: string }): Promise<void> {
  const sourceEpoch = await epoch(input.tagCommit)
  const entries = await readdir(input.output)
  const assets: VerifiedAsset[] = []
  for (const [key, target] of Object.entries(TARGETS)) {
    const archive = join(input.output, target.asset)
    if (!entries.includes(basename(archive))) throw new Error(`missing target archive: ${target.asset}`)
    const bytes = await readFile(archive)
    assets.push({ key, target: target.rustTarget as RustTarget, asset: target.asset, sha256: sha256(bytes), size: (await stat(archive)).size })
  }
  await writeFile(join(input.output, "release-manifest.json"), canonicalJson(await releaseManifest(assets)))
  await writeFile(join(input.output, "SHA256SUMS"), sha256Sums(assets))
  await verifyReleaseDirectory(input.output, sourceEpoch)
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const optionalValue = (flag: string): string | undefined => {
    const index = args.indexOf(flag)
    if (index < 0) return undefined
    if (!args[index + 1] || args.indexOf(flag, index + 1) >= 0) throw new Error(`missing ${flag}`)
    return args[index + 1]!
  }
  const value = (flag: string): string => optionalValue(flag) ?? (() => { throw new Error(`missing ${flag}`) })()
  const output = optionalValue("--output") ?? "release/dist"
  const tagCommit = optionalValue("--tag-commit") ?? (await git.run(["rev-parse", "HEAD"])).trim()
  const localFixtures = args.length === 0 || args.includes("--local-fixtures")
  if (localFixtures) {
    if (args.some((arg) => ["--target", "--binary", "--assemble"].includes(arg))) throw new Error("fixture mode cannot select a real target")
    await buildFixtureRelease(output, tagCommit)
    console.log("archives=4 assets=6 inventories=exact reproducible=PASS")
  } else if (args.includes("--assemble")) {
    await assembleRelease({ output, tagCommit })
    console.log("archives=4 assets=6 inventories=exact reproducible=PASS")
  } else {
    const selected = targetKey(value("--target"))
    const binary = value("--binary")
    await buildTargetArchive({ target: selected, binary, output, tagCommit })
    console.log(`target=${selected} archive=${TARGETS[selected].asset} PASS`)
  }
}
