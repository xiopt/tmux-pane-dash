import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative } from "node:path"
import { pathToFileURL } from "node:url"
import { gunzipSync } from "node:zlib"
import { ARCHIVE_PAYLOAD, CLI_PACKAGE_FILES, RELEASE_ASSETS, TAG, TAG_COMMIT, TARGETS } from "./contracts"
import { canonicalJson, sha256 } from "./canonical-json"
import { inspectArchive } from "./archive"
import { inspectBinary } from "./inspect-binary"

const decoder = new TextDecoder()
const parseJson = (bytes: Uint8Array) => JSON.parse(decoder.decode(bytes)) as Record<string, unknown>
const hasExactKeys = (value: unknown, keys: readonly string[]) => typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))

function tarFiles(bytes: Uint8Array): Map<string, Uint8Array> {
  const tar = gunzipSync(bytes); const files = new Map<string, Uint8Array>()
  for (let offset = 0; offset + 512 <= tar.length;) { const header = tar.subarray(offset, offset + 512); if (header.every((byte) => byte === 0)) break; const zero = header.indexOf(0); const name = decoder.decode(header.subarray(0, zero < 0 ? 100 : zero)); const size = Number.parseInt(decoder.decode(header.subarray(124, 136)).replace(/\0.*$/, "").trim(), 8) || 0; if (header[156] !== 53) files.set(name, tar.slice(offset + 512, offset + 512 + size)); offset += 512 + Math.ceil(size / 512) * 512 }
  return files
}

const hostTarget = () => process.platform === "darwin" ? process.arch === "arm64" ? "aarch64-apple-darwin" : process.arch === "x64" ? "x86_64-apple-darwin" : undefined : process.platform === "linux" ? process.arch === "arm64" ? "aarch64-unknown-linux-musl" : process.arch === "x64" ? "x86_64-unknown-linux-musl" : undefined : undefined

async function command(argv: string[], env?: Record<string, string>, cwd?: string): Promise<{ stdout: string; stderr: string; code: number }> {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", env: env ?? process.env, cwd })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { stdout, stderr, code }
}

async function runtimeSmoke(binary: string): Promise<void> {
  const version = await command([binary, "--version"]).catch(() => undefined)
  if (!version || version.code !== 0 || version.stdout !== "pane-dash 0.1.0\n" || version.stderr !== "") throw new Error("binary does not report the exact version")
  const root = await mkdtemp(join(tmpdir(), "pane-dash-artifact-tmux-")), socket = `pd-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`
  const tmux = process.env.TMUX_BIN ?? "tmux"
  try {
    const environment = { ...process.env, TMUX_TMPDIR: root }
    const launched = await command([tmux, "-L", socket, "-f", "/dev/null", "new-session", "-d", "-s", "smoke", "sleep", "30"], environment)
    if (launched.code !== 0) throw new Error("binary real tmux smoke did not start")
    const retained = await command([tmux, "-L", socket, "set-option", "-t", "smoke:0", "remain-on-exit", "on"], environment)
    if (retained.code !== 0) throw new Error("binary real tmux smoke did not configure")
    const invoked = await command([tmux, "-L", socket, "respawn-pane", "-k", "-t", "smoke:0", binary, "--version"], environment)
    if (invoked.code !== 0) throw new Error("binary real tmux smoke did not invoke")
    await new Promise((resolve) => setTimeout(resolve, 100))
    const pane = await command([tmux, "-L", socket, "list-panes", "-t", "smoke", "-F", "#{pane_dead} #{pane_dead_status}"], environment)
    if (pane.code !== 0 || pane.stdout.trim() !== "1 0") throw new Error("binary real tmux smoke did not complete")
  } finally {
    await command([tmux, "-L", socket, "kill-server"], { ...process.env, TMUX_TMPDIR: root }).catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
}

async function tagEpoch(): Promise<number> {
  const git = { run: async (args: string[]) => {
    const result = await command(["git", ...args])
    if (result.code !== 0) throw new Error(result.stderr.trim())
    return result.stdout
  } }
  const expected = await git.run(["rev-parse", `${TAG_COMMIT}^{commit}`])
  const expectedCommit = expected.trim()
  const timestamp = await git.run(["show", "-s", "--format=%ct", expectedCommit])
  if (!/^[0-9]+\n$/.test(timestamp)) throw new Error("tag commit has invalid committer timestamp")
  const tag = await command(["git", "rev-parse", "--verify", "--quiet", `refs/tags/${TAG}`])
  if (tag.code === 0) {
    const observed = (await git.run(["rev-parse", `${TAG}^{commit}`])).trim()
    if (observed !== expectedCommit) throw new Error(`tag ${TAG} does not resolve to supplied tag commit ${expectedCommit}`)
  }
  return Number(timestamp)
}

export async function verifyReleaseDirectory(path: string, expectedEpoch?: number): Promise<void> {
  const names = (await readdir(path)).sort((a, b) => Buffer.from(a).compare(Buffer.from(b)))
  if (names.length !== 6 || names.some((name) => !RELEASE_ASSETS.includes(name as never))) throw new Error("expected exactly six release assets")
  const releaseBytes = await readFile(join(path, "release-manifest.json")); const sums = await readFile(join(path, "SHA256SUMS")); const release = parseJson(releaseBytes)
  if (!hasExactKeys(release, ["schemaVersion", "repository", "version", "tag", "assets"]) || !releaseBytes.equals(Buffer.from(canonicalJson(release))) || release.schemaVersion !== 1 || release.repository !== "xiopt/tmux-pane-dash" || release.version !== "0.1.0" || release.tag !== "v0.1.0" || !hasExactKeys(release.assets, ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"])) throw new Error("invalid release manifest")
  if (Object.keys(release.assets as object).join(",") !== "darwin-arm64,darwin-x64,linux-arm64,linux-x64") throw new Error("release manifest keys are not exact")
  const epoch = expectedEpoch ?? await tagEpoch()
  const checksumLines: Array<{ asset: string; line: string }> = []
  for (const [key, target] of Object.entries(TARGETS)) {
    const asset = (release.assets as Record<string, Record<string, unknown>>)[key]; const archive = await readFile(join(path, target.asset)); const info = await stat(join(path, target.asset))
    if (!hasExactKeys(asset, ["target", "asset", "url", "sha256", "size"]) || asset.target !== target.rustTarget || asset.asset !== target.asset || asset.url !== `https://github.com/xiopt/tmux-pane-dash/releases/download/v0.1.0/${target.asset}` || asset.sha256 !== sha256(archive) || asset.size !== info.size) throw new Error(`invalid release asset ${key}`)
    await inspectArchive(join(path, target.asset), epoch); const files = tarFiles(archive); const internalBytes = files.get("manifest.json"), binary = files.get("bin/pane-dash")
    if (!internalBytes) throw new Error("missing internal manifest")
    const internal = parseJson(internalBytes); if (!hasExactKeys(internal, ["schemaVersion", "product", "version", "target", "asset", "files"]) || !Buffer.from(internalBytes).equals(Buffer.from(canonicalJson(internal))) || internal.schemaVersion !== 1 || internal.product !== "tmux-pane-dash" || internal.version !== "0.1.0" || internal.target !== target.rustTarget || internal.asset !== target.asset || !Array.isArray(internal.files) || internal.files.length !== 7) throw new Error("invalid internal manifest")
    const expected = ARCHIVE_PAYLOAD.filter(([name]) => name !== "manifest.json").map(([name]) => name).sort((a, b) => Buffer.from(a).compare(Buffer.from(b)))
    if ((internal.files as Array<Record<string, unknown>>).map((file) => file.path).join(",") !== expected.join(",")) throw new Error("internal manifest inventory is not exact")
    for (const file of internal.files as Array<Record<string, unknown>>) { const content = files.get(file.path as string); if (!hasExactKeys(file, ["path", "sha256", "size", "mode"]) || !content || file.sha256 !== sha256(content) || file.size !== content.length || file.mode !== ARCHIVE_PAYLOAD.find(([name]) => name === file.path)?.[1]) throw new Error("invalid internal file record") }
    if (!binary) throw new Error("missing pane-dash binary")
    const binaryPath = join(path, `.${target.asset}.pane-dash`); await writeFile(binaryPath, binary); await chmod(binaryPath, 0o755)
    try { await inspectBinary(binaryPath, target.rustTarget); if (target.rustTarget === hostTarget()) await runtimeSmoke(binaryPath) } finally { await rm(binaryPath, { force: true }) }
    checksumLines.push({ asset: target.asset, line: `${sha256(archive)}  ${target.asset}` })
  }
  if (decoder.decode(sums) !== checksumLines.sort((a, b) => Buffer.from(a.asset).compare(Buffer.from(b.asset))).map(({ line }) => line).join("\n") + "\n") throw new Error("invalid SHA256SUMS")
}

export async function verifyPackages(root: string): Promise<void> {
  const packageRoot = join(root, "packages", "tmux-pane-dash")
  const pkg = parseJson(await readFile(join(packageRoot, "package.json")))
  const files = ["dist/cli.js", "dist/runtime.js", "generated/release-manifest.json", "README.md", "LICENSE"]
  const packageKeys = ["name", "version", "description", "type", "engines", "bin", "files", "repository", "homepage", "bugs", "license", "publishConfig"]
  if (!hasExactKeys(pkg, packageKeys) || pkg.name !== "@xiopt/tmux-pane-dash" || pkg.version !== "0.1.0" || pkg.description !== "Immutable installer for tmux-pane-dash" || pkg.type !== "module" || JSON.stringify(pkg.engines) !== JSON.stringify({ node: ">=20" }) || JSON.stringify(pkg.bin) !== JSON.stringify({ "tmux-pane-dash": "dist/cli.js" }) || JSON.stringify(pkg.files) !== JSON.stringify(files) || JSON.stringify(pkg.repository) !== JSON.stringify({ type: "git", url: "git+https://github.com/xiopt/tmux-pane-dash.git" }) || pkg.homepage !== "https://github.com/xiopt/tmux-pane-dash#readme" || JSON.stringify(pkg.bugs) !== JSON.stringify({ url: "https://github.com/xiopt/tmux-pane-dash/issues" }) || pkg.license !== "MIT" || JSON.stringify(pkg.publishConfig) !== JSON.stringify({ access: "public" }) || Object.hasOwn(pkg, "exports") || ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "bundledDependencies", "gypfile", "os", "cpu", "binary", "preinstall", "install", "postinstall", "prepare", "prepublish", "prepublishOnly", "prepack", "postpack"].some((key) => Object.hasOwn(pkg, key))) throw new Error("invalid CLI package metadata")
  const node = process.env.NODE_20_BIN, npm = process.env.NPM_20_CLI
  if (!node || !npm) throw new Error("CLI package check requires with-node20")
  const output = await mkdtemp(join(tmpdir(), "pane-dash-cli-pack-"))
  try {
    const packed = await command([node, npm, "pack", "--json", "--workspace", "packages/tmux-pane-dash", "--pack-destination", output], undefined, root)
    if (packed.code !== 0) throw new Error(`CLI package pack failed: ${packed.stderr.trim()}`)
    const result = JSON.parse(packed.stdout) as Array<{ filename?: string; files?: Array<{ path?: string }> }>
    const inventory = result[0]?.files?.map((file) => `package/${file.path}`).sort()
    if (!inventory || JSON.stringify(inventory) !== JSON.stringify([...CLI_PACKAGE_FILES].sort())) throw new Error("CLI package inventory is not exact")
    const filename = result[0]?.filename
    if (!filename || basename(filename) !== filename) throw new Error("CLI package tarball name is invalid")
    const extracted = join(output, "extracted")
    for (const [name, content] of tarFiles(await readFile(join(output, filename)))) {
      if (!name.startsWith("package/") || isAbsolute(name) || relative("package", name).startsWith("..")) throw new Error("CLI package tarball path is invalid")
      const destination = join(extracted, name)
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, content)
    }
    const packedRoot = join(extracted, "package")
    const packedMetadata = parseJson(await readFile(join(packedRoot, "package.json")))
    if (JSON.stringify(packedMetadata) !== JSON.stringify(pkg)) throw new Error("packed package metadata differs")
    const [cli, runtime] = await Promise.all([readFile(join(packedRoot, "dist", "cli.js"), "utf8"), readFile(join(packedRoot, "dist", "runtime.js"), "utf8")])
    for (const bundle of [cli, runtime]) {
      if (/\bBun\b|\bbun:|sourceMappingURL|\.map\b|process\d*\.env|\b(?:latest|endpoint|checksum|installRoot|rootDir)\b/i.test(bundle)) throw new Error("packed Node artifact contains forbidden override or Bun data")
    }
    if ((cli.match(/\.argv/g) ?? []).length !== 1 || !/\.argv\.slice\(2\)/.test(cli) || /\.argv/.test(runtime)) throw new Error("packed Node artifact has an invalid argv override")
    const noCommand = await command([node, join(packedRoot, "dist", "cli.js")], { ...process.env, PATH: "/usr/bin:/bin" })
    if (noCommand.code !== 2 || noCommand.stdout !== "" || !noCommand.stderr.startsWith("E_USAGE:") || noCommand.stderr.length > 241) throw new Error("packed CLI does not return bounded E_USAGE")
    const imported = await command([node, "--input-type=module", "--eval", `import(${JSON.stringify(pathToFileURL(join(packedRoot, "dist", "runtime.js")).href)}).then((module) => process.exit(typeof module.runCli === "function" ? 0 : 1))`], { ...process.env, PATH: "/usr/bin:/bin" })
    if (imported.code !== 0) throw new Error("packed runtime does not export runCli")
  } finally { await rm(output, { recursive: true, force: true }) }
}

if (import.meta.main) {
  const [argument, extra] = process.argv.slice(2)
  if (!argument || extra) throw new Error("usage: verify-artifacts.ts DIRECTORY | --packages")
  if (argument === "--packages") {
    await verifyPackages(process.cwd()); console.log("packages=1 inventory=exact PASS")
  } else {
    await verifyReleaseDirectory(argument); console.log("archives=4 assets=6 inventories=exact reproducible=PASS")
  }
}
