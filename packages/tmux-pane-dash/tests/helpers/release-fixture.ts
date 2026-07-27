import { createServer } from "node:http"
import { constants } from "node:fs"
import { access, cp, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { Dependencies } from "../../src/runtime"
import { buildArchive, inspectArchive } from "../../../../scripts/release/archive"
import { sha256 } from "../../../../scripts/release/canonical-json"
import { TARGETS } from "../../../../scripts/release/contracts"
import { inspectBinary } from "../../../../scripts/release/inspect-binary"

export type ReleaseAssetRecord = { target: string; asset: string; url: string; sha256: string; size: number; bytes: Uint8Array }

type RunResult = { stdout: string; stderr: string; code: number }
type Runner = { run(argv: readonly string[], input: { cwd: string; env: Record<string, string>; timeoutMs: number }): Promise<RunResult> }

const run = async (argv: readonly string[], input: { cwd: string; env: Record<string, string>; timeoutMs: number }): Promise<RunResult> => {
  const child = Bun.spawn([...argv], { cwd: input.cwd, env: input.env, stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => child.kill("SIGKILL"), input.timeoutMs)
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    if (code !== 0) throw new Error(`child failed (${code}): ${stderr.slice(0, 2_000)}`)
    return { stdout, stderr, code }
  } finally { clearTimeout(timer) }
}

const staticLinuxBinary = async (binary: string, cwd: string, env: Record<string, string>) => {
  const ldd = await (async () => {
    for (const candidate of ["/usr/bin/ldd", "/bin/ldd"]) {
      try { await access(candidate, constants.X_OK); return candidate } catch { /* try the next absolute ldd path */ }
    }
    throw new Error("Linux fixture requires an absolute ldd")
  })()
  const child = Bun.spawn([ldd, binary], { cwd, env, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  const output = `${stdout}${stderr}`
  const staticResult = (code !== 0 && /not a dynamic executable/i.test(output)) || /statically linked/i.test(output)
  if (!staticResult || /=>|\b(?:interpreter|shared (?:library|object)|linux-vdso|ld-linux|ld-musl|[^/\s]+\.so(?:\.\d+)*)\b/i.test(output)) throw new Error(`ldd did not prove static binary: ${output.trim()}`)
}

/** Builds an archive from an isolated copy of the real Rust crate and verifies its Task 4 shape. */
export async function buildFixtureRelease(input: { version: "0.1.0" | "0.1.1"; target: string; binary: string; root: string }): Promise<ReleaseAssetRecord> {
  const target = Object.values(TARGETS).find(candidate => candidate.rustTarget === input.target)
  if (!target) throw new Error("unsupported fixture target")
  const stage = await mkdtemp(join(tmpdir(), "pane-dash-release-fixture-"))
  const asset = target.asset.replace("v0.1.0", `v${input.version}`), archive = join(stage, asset)
  try {
    const cargo = process.env.CARGO, rustc = process.env.RUSTC
    if (!cargo?.startsWith("/") || !rustc?.startsWith("/")) throw new Error("fixture Rust build requires isolated absolute CARGO and RUSTC")
    for (const path of ["pane-dash", "pane_dash.tmux", "README.md", "LICENSE", "scripts"]) await cp(join(input.root, path), join(stage, path), { recursive: true })
    const cargoToml = join(stage, "pane-dash", "Cargo.toml")
    await writeFile(cargoToml, (await readFile(cargoToml, "utf8")).replace(/^version\s*=\s*"[^"]+"/m, `version = "${input.version}"`))
    await writeFile(join(stage, "VERSION"), `${input.version}\n`)
    const targetDirectory = join(stage, "target")
    await run([cargo, "build", "--offline", "--release", "--manifest-path", cargoToml, "--target", input.target, "--target-dir", targetDirectory], { cwd: stage, env: { ...process.env, CARGO: cargo, RUSTC: rustc, CARGO_NET_OFFLINE: "true" }, timeoutMs: 180_000 })
    const binary = join(targetDirectory, input.target, "release", "pane-dash")
    if (input.target.includes("-unknown-linux-")) await staticLinuxBinary(binary, stage, { ...process.env, CARGO: cargo, RUSTC: rustc, CARGO_NET_OFFLINE: "true" })
    await buildArchive({ target: input.target as never, binary, output: archive, epoch: 0, root: stage, version: input.version })
    await inspectArchive(archive, 0)
    await inspectBinary(binary, input.target as never)
    const bytes = await readFile(archive), info = await stat(archive)
    return { target: input.target, asset, url: `https://github.com/xiopt/tmux-pane-dash/releases/download/v${input.version}/${asset}`, sha256: sha256(bytes), size: info.size, bytes }
  } finally { await rm(stage, { recursive: true, force: true }) }
}

/** Imports only the packed runtime by an absolute file URL. */
export async function importPackedRuntime(unpackedPackage: string): Promise<{ assertDowngradeAllowed(input: unknown): void; compareVersions(left: string, right: string): -1 | 0 | 1; runCli(argv: readonly string[], deps: Dependencies): Promise<number> }> {
  const runtime = await import(pathToFileURL(resolve(unpackedPackage, "dist/runtime.js")).href) as Record<string, unknown>
  const exports = Object.keys(runtime).sort()
  if (JSON.stringify(exports) !== JSON.stringify(["assertDowngradeAllowed", "compareVersions", "runCli"])) throw new Error(`unexpected packed runtime exports: ${exports.join(",")}`)
  if (typeof runtime.assertDowngradeAllowed !== "function" || runtime.assertDowngradeAllowed.length !== 1 || typeof runtime.compareVersions !== "function" || runtime.compareVersions.length !== 2 || typeof runtime.runCli !== "function" || runtime.runCli.length !== 2) throw new Error("packed runtime has an invalid public interface")
  return runtime as { assertDowngradeAllowed(input: unknown): void; compareVersions(left: string, right: string): -1 | 0 | 1; runCli(argv: readonly string[], deps: Dependencies): Promise<number> }
}

/** Creates a local-tarball-only npm project whose loopback registry rejects every request. */
export async function packedInstallHarness(input: { nodeBin: string; npmCli: string; tarball: string }): Promise<{ project: string; env: Record<string, string>; runner: Runner; sentinel: { requests: readonly string[] }; cleanup(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "pane-dash-packed-install-")), project = join(root, "project"), requests: string[] = []
  const server = createServer((request, response) => { requests.push(`${request.method} ${request.url}`); response.writeHead(503); response.end("registry disabled") })
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()) })
  const port = (server.address() as { port: number }).port
  await mkdir(project, { recursive: true })
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(root, "home"), XDG_DATA_HOME: join(root, "data"), XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"), TMPDIR: join(root, "tmp"), TMUX_TMPDIR: join(root, "tmux"), BUN_INSTALL_CACHE_DIR: join(root, "bun-cache"), npm_config_cache: join(root, "npm-cache"), npm_config_userconfig: join(project, ".npmrc"), NPM_SENTINEL_PORT: String(port) }
  await Promise.all([env.HOME, env.XDG_DATA_HOME, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.TMPDIR, env.TMUX_TMPDIR, env.BUN_INSTALL_CACHE_DIR, env.npm_config_cache].map(value => mkdir(value, { recursive: true })))
  await writeFile(join(project, "package.json"), '{"private":true}\n')
  await writeFile(join(project, ".npmrc"), `cache=${env.npm_config_cache}\nregistry=http://127.0.0.1:${port}/\naudit=false\nfund=false\n`)
  return { project, env, runner: { run }, sentinel: { requests }, cleanup: async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }) } }
}
