import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { basename, isAbsolute, join, resolve } from "node:path"
import { DEBIAN_PLATFORM_MANIFESTS, RUST_ALPINE_BUILDERS, TMUX_RUNTIME } from "./contracts"
import { startLocalRegistry, type LocalPackage } from "./local-registry"

export type MuslTarget = "aarch64-unknown-linux-musl" | "x86_64-unknown-linux-musl"

type CommandResult = { readonly code: number; readonly stdout: string; readonly stderr: string }
export type CommandRunner = (argv: readonly string[], options: { readonly timeoutMs: number; readonly signal?: AbortSignal }) => Promise<CommandResult>

type MuslProvenance = {
  readonly target: MuslTarget
  readonly platform: "linux/amd64" | "linux/arm64"
  readonly builderDigest: string
  readonly builderImage: string
  readonly runtimeImageId: string
  readonly runtimeBaseDigest: string
  readonly runtimeManifest: string
  readonly tmuxVersion: string
  readonly runtimeUname: string
}

export type MuslSpikeResult = {
  readonly imageDigest: string
  readonly fileOutput: string
  readonly executionOutput: string
  readonly tmuxOutput: string
  readonly provenance: MuslProvenance
}

type MuslSpikeInput = {
  readonly target: MuslTarget
  readonly sourceRoot: string
  /** Test seam; callers must not supply images, platforms, or mount paths. */
  readonly runner?: CommandRunner
  readonly signal?: AbortSignal
}

const DOCKER_TIMEOUT_MS = 15 * 60_000
const SMOKE_TIMEOUT_MS = 45_000
const OPENCODE_VERSION_TIMEOUT_MS = 5_000
const OPENCODE_STARTUP_TIMEOUT_MS = 30_000
const OPENCODE_PLUGIN_SPEC = "@xiopt/pane-dash-opencode@0.1.0"

const targetInfo = (target: MuslTarget) => target === "x86_64-unknown-linux-musl"
  ? { architecture: "x86-64", builderArch: "amd64" as const, platform: "linux/amd64" as const, uname: "x86_64" }
  : { architecture: "ARM aarch64", builderArch: "arm64" as const, platform: "linux/arm64" as const, uname: "aarch64" }

const builderImage = (arch: "amd64" | "arm64") => `rust:1.96.1-alpine@sha256:${RUST_ALPINE_BUILDERS[arch]}`
const runtimeManifest = (arch: "amd64" | "arm64") => `docker.io/library/debian@sha256:${DEBIAN_PLATFORM_MANIFESTS[arch]}`

export function requiredSpikeChecks(): readonly string[] {
  return [
    "aarch64-unknown-linux-musl:elf-static-execution-tmux",
    "x86_64-unknown-linux-musl:elf-static-execution-tmux",
    "opencode-1.17.20:scoped-exact-install-load-status-cleanup",
  ]
}

export function normalizeOpenCodeVersion(output: string): string {
  const match = /^(?:v)?(\d+\.\d+\.\d+)\n$/.exec(output)
  if (!match) throw new Error("OpenCode version must be exact v?semver followed by one LF")
  return match[1]!
}

export function parseOpenCodePluginSpec(value: string): { readonly name: "@xiopt/pane-dash-opencode"; readonly rawSpec: "0.1.0" } {
  const match = /^(@xiopt\/pane-dash-opencode)@(0\.1\.0)$/.exec(value)
  if (!match) throw new Error("OpenCode plugin must use the exact scoped package and version")
  return { name: "@xiopt/pane-dash-opencode", rawSpec: "0.1.0" }
}

export function assertOpenCodeRegistryRequests(requests: readonly string[], _origin: string): void {
  const expected = new Set([
    "/@opencode-ai%2fplugin",
    "/@xiopt%2fpane-dash-opencode",
    "/%40opencode-ai%2Fplugin/-/plugin-1.17.20.tgz",
    "/%40xiopt%2Fpane-dash-opencode/-/pane-dash-opencode-0.1.0.tgz",
  ])
  for (const request of requests) {
    if (!expected.has(request)) throw new Error(`unexpected local registry request: ${request}`)
  }
  if (new Set(requests).size !== expected.size || requests.length !== expected.size) {
    throw new Error(`local registry must fetch each exact package tarball once: ${JSON.stringify(requests)}`)
  }
}

export function assertOpenCodeCleanupDelayState(status: string, heartbeat: string, nowSeconds = Math.floor(Date.now() / 1000)): void {
  if (!status) throw new Error("OpenCode status is absent during cleanup delay")
  if (!/^\d{10}$/.test(heartbeat) || Math.abs(nowSeconds - Number(heartbeat)) > 5) {
    throw new Error(`OpenCode heartbeat is not fresh: ${heartbeat}`)
  }
}

export function assertNoOwnedTmuxProcess(result: Pick<CommandResult, "code" | "stdout" | "stderr">): void {
  if (result.code === 0) throw new Error(`owned tmux process remained: ${result.stdout.trim() || result.stderr.trim()}`)
}

export function validateTmuxBinaryPath(value: string | undefined): string {
  if (!value) throw new Error("TMUX_BIN required")
  if (!isAbsolute(value)) throw new Error("TMUX_BIN must be absolute")
  return value
}

export function tmuxWrapperScript(tmux: string, socket: string, calls: string, permit: string): string {
  return `#!/bin/sh
if [ "$#" -eq 5 ] && [ "$1" = set-option ] && [ "$2" = -pu ]; then
  printf '%s\\n' "$*" >> ${shellQuote(calls)}
  for _ in $(seq 1 300); do [ -f ${shellQuote(permit)} ] && break; sleep 0.1; done
  [ -f ${shellQuote(permit)} ] || exit 1
fi
exec ${shellQuote(tmux)} -L ${shellQuote(socket)} "$@"
`
}

export async function runOpenCodeVersion(binary: string, run: CommandRunner = dockerRunner): Promise<string> {
  if (!isAbsolute(binary)) throw new Error("OpenCode binary must be absolute")
  const result = await execute(run, [binary, "--version"], undefined, OPENCODE_VERSION_TIMEOUT_MS)
  return normalizeOpenCodeVersion(result.stdout)
}

type OpenCodeSpikeResult = {
  readonly version: string
  readonly sha256: string
  readonly name: string
  readonly rawSpec: string
  readonly requests: readonly string[]
}

/** Runs only within clean-room.sh, which owns all HOME/XDG/cache/tmux state. */
async function runOpenCodeSpike(input: { readonly sourceRoot: string; readonly binary: string; readonly registryHost: "127.0.0.1" | "::1" }): Promise<OpenCodeSpikeResult> {
  if (!isAbsolute(input.binary) || !isAbsolute(input.sourceRoot)) throw new Error("OpenCode spike paths must be absolute")
  if (!(await stat(input.binary)).isFile()) throw new Error("OpenCode binary missing")
  const version = await runOpenCodeVersion(input.binary)
  if (version !== "1.17.20") throw new Error(`OpenCode 1.17.20 required, got ${version}`)
  const sha256 = createHash("sha256").update(await readFile(input.binary)).digest("hex")
  if (sha256 !== "14a4583c9a3685875f011d6dd4dfbd00498893942be0bb1d2c27e30e70144c89") throw new Error(`OpenCode SHA256 mismatch: ${sha256}`)
  if (process.env.TMUX || process.env.TMUX_PANE) throw new Error("default tmux state is not isolated")
  if (!process.env.HOME || !process.env.XDG_CONFIG_HOME || !process.env.TMPDIR || !process.env.PANE_DASH_TMUX_SOCKET) throw new Error("clean-room environment required")

  const root = await mkdtemp(join(process.env.TMPDIR, "pane-dash-opencode-"))
  const packageRoot = join(root, "package")
  const companionRoot = join(root, "companion")
  const socket = process.env.PANE_DASH_TMUX_SOCKET
  const tmux = validateTmuxBinaryPath(process.env.TMUX_BIN)
  if (!(await stat(tmux)).isFile()) throw new Error("TMUX_BIN must be an executable file")
  const tmuxVersion = (await localCommand([tmux, "-V"], 5_000)).stdout.trim()
  if (!/^tmux 3\.(?:[6-9]|[1-9][0-9])(?:\D|$)/.test(tmuxVersion)) throw new Error(`tmux 3.6 required, got ${tmuxVersion}`)
  let registry: Awaited<ReturnType<typeof startLocalRegistry>> | undefined
  try {
    const plugin = await packOpenCodePlugin(input.sourceRoot, packageRoot)
    const companion = await packCompanionPlugin(companionRoot)
    registry = await startLocalRegistry({ host: input.registryHost, packages: new Map([[plugin.name, plugin], [companion.name, companion]]) })
    await mkdir(join(process.env.XDG_CONFIG_HOME, "opencode"), { recursive: true })
    await writeFile(join(process.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), JSON.stringify({ plugin: [OPENCODE_PLUGIN_SPEC] }))
    await writeFile(process.env.npm_config_userconfig, `registry=${registry.origin}\n@xiopt:registry=${registry.origin}\n@opencode-ai:registry=${registry.origin}\naudit=false\nfund=false\n`)

    await startThenStopOpenCode(tmux, socket, input.binary, root, true)
    const observed = await startThenStopOpenCode(tmux, socket, input.binary, root, false)
    if (!observed.status || !observed.heartbeat) throw new Error("OpenCode plugin did not publish a fresh pane heartbeat")
    assertOpenCodeRegistryRequests(registry.requests, registry.origin)
    const parsed = parseOpenCodePluginSpec(OPENCODE_PLUGIN_SPEC)
    return { version, sha256, ...parsed, requests: registry.requests }
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : error}; registry-requests=${JSON.stringify(registry?.requests ?? [])}`)
  } finally {
    await Promise.allSettled([
      localCommand([tmux, "-L", socket, "kill-server"], 5_000),
      registry?.close() ?? Promise.resolve(),
    ])
    await rm(root, { recursive: true, force: true })
  }
}

async function packOpenCodePlugin(sourceRoot: string, packageRoot: string): Promise<LocalPackage> {
  await mkdir(join(packageRoot, "dist"), { recursive: true })
  const build = await Bun.build({ entrypoints: [join(sourceRoot, "opencode-plugin", "pane-dash.ts")], outdir: join(packageRoot, "dist"), naming: "index.js", target: "bun" })
  if (!build.success || build.logs.length > 0) throw new Error(`OpenCode bundle failed: ${build.logs.map(String).join("\n")}`)
  await Promise.all([
    copyFile(join(sourceRoot, "README.md"), join(packageRoot, "README.md")),
    // Task 2 owns the repository's publishable legal text. The spike still verifies
    // npm's required package shape without inventing a project-wide license claim.
    writeFile(join(packageRoot, "LICENSE"), "UNLICENSED\n"),
    writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "@xiopt/pane-dash-opencode", version: "0.1.0", type: "module", exports: { ".": "./dist/index.js", "./server": "./dist/index.js" }, files: ["dist", "README.md", "LICENSE"] }, null, 2) + "\n"),
  ])
  return packPackage(packageRoot, "@xiopt/pane-dash-opencode", "0.1.0")
}

async function packCompanionPlugin(root: string): Promise<LocalPackage> {
  await mkdir(root, { recursive: true })
  await Promise.all([
    writeFile(join(root, "package.json"), JSON.stringify({ name: "@opencode-ai/plugin", version: "1.17.20", type: "module", exports: { ".": "./index.js" }, files: ["index.js"] }) + "\n"),
    writeFile(join(root, "index.js"), "export {}\n"),
  ])
  return packPackage(root, "@opencode-ai/plugin", "1.17.20")
}

async function packPackage(root: string, name: string, version: string): Promise<LocalPackage> {
  const packCache = join(root, ".pack-cache")
  await mkdir(packCache)
  const packed = await localCommand(["npm", "pack", "--ignore-scripts", "--json", "--pack-destination", root], 30_000, root, false, { ...process.env, npm_config_cache: packCache })
  const file = (JSON.parse(packed.stdout) as Array<{ filename: string }>)[0]?.filename
  if (!file) throw new Error(`npm pack did not return ${name}`)
  const tarball = await readFile(join(root, file))
  return { name, version, tarball, integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}` }
}

async function startThenStopOpenCode(tmux: string, socket: string, binary: string, root: string, bootstrap: boolean): Promise<{ status: string; heartbeat: string }> {
  const session = `opencode-${crypto.randomUUID()}`
  const script = join(root, `${session}.sh`)
  const wrapper = join(root, `${session}-bin`)
  const calls = join(root, `${session}-cleanup.log`)
  const permit = join(root, `${session}-cleanup-permit`)
  const marker = join(root, `${session}-complete`)
  await mkdir(wrapper)
  await writeFile(join(wrapper, "tmux"), tmuxWrapperScript(tmux, socket, calls, permit))
  await chmod(join(wrapper, "tmux"), 0o700)
  await writeFile(script, `#!/bin/sh\nPATH=${shellQuote(wrapper)}:$PATH ${shellQuote(binary)} run --command noop --print-logs --log-level DEBUG || true\nprintf complete > ${shellQuote(marker)}\nexec cat\n`)
  await chmod(script, 0o700)
  if (bootstrap) await writeFile(permit, "continue\n")
  await localCommand([tmux, "-L", socket, "-f", "/dev/null", "new-session", "-d", "-s", session, script], 10_000)
  const target = `${session}:0.0`
  if (bootstrap) {
    await waitForFile(marker, OPENCODE_STARTUP_TIMEOUT_MS)
    await localCommand([tmux, "-L", socket, "kill-session", "-t", session], 10_000)
    return { status: "bootstrap", heartbeat: "bootstrap" }
  }
  const status = await waitForPaneOption(tmux, socket, target, "@pane_dash_status", OPENCODE_STARTUP_TIMEOUT_MS)
  const heartbeat = await waitForPaneOption(tmux, socket, target, "@pane_dash_heartbeat", OPENCODE_STARTUP_TIMEOUT_MS)
  assertOpenCodeCleanupDelayState(status, heartbeat)
  const paneId = (await localCommand([tmux, "-L", socket, "display-message", "-p", "-t", target, "#{pane_id}"], 5_000)).stdout.trim()
  if (!/^%\d+$/.test(paneId)) throw new Error(`invalid OpenCode pane id: ${paneId}`)
  await waitForFile(calls, OPENCODE_STARTUP_TIMEOUT_MS)
  assertOpenCodeCleanupDelayState(
    await paneOption(tmux, socket, target, "@pane_dash_status"),
    await paneOption(tmux, socket, target, "@pane_dash_heartbeat"),
  )
  await writeFile(permit, "continue\n")
  await waitForFile(marker, OPENCODE_STARTUP_TIMEOUT_MS)
  for (const option of ["@pane_dash_status", "@pane_dash_status_since", "@pane_dash_heartbeat", "@pane_dash_title", "@pane_dash_model"]) {
    const value = await paneOption(tmux, socket, target, option)
    if (value) throw new Error(`OpenCode cleanup left ${option}`)
  }
  const cleanupCalls = (await readFile(calls, "utf8")).trim().split("\n")
  for (const option of ["@pane_dash_status", "@pane_dash_status_since", "@pane_dash_heartbeat", "@pane_dash_title", "@pane_dash_model"]) {
    if (cleanupCalls.filter((call) => call === `set-option -pu -t ${paneId} ${option}`).length !== 1) throw new Error(`missing direct cleanup call for ${option}`)
  }
  await localCommand([tmux, "-L", socket, "kill-session", "-t", session], 10_000)
  const noSession = await localCommand([tmux, "-L", socket, "has-session", "-t", session], 5_000, undefined, true)
  assertNoOwnedTmuxProcess(noSession)
  await localCommand([tmux, "-L", socket, "kill-server"], 5_000, undefined, true)
  const noServer = await localCommand([tmux, "-L", socket, "list-sessions"], 5_000, undefined, true)
  assertNoOwnedTmuxProcess(noServer)
  return { status, heartbeat }
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await stat(path).then(() => true).catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("timed out waiting for OpenCode completion marker")
}

async function waitForPaneOption(tmux: string, socket: string, target: string, option: string, timeoutMs: number): Promise<string> {
  return waitForChangedPaneOption(tmux, socket, target, option, "", timeoutMs)
}

async function waitForChangedPaneOption(tmux: string, socket: string, target: string, option: string, previous: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await paneOption(tmux, socket, target, option)
    if (value && value !== previous) return value
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  const pane = await localCommand([tmux, "-L", socket, "capture-pane", "-p", "-t", target], 5_000, undefined, true)
  throw new Error(`timed out waiting for ${option}: ${pane.stdout.slice(-2_000).trim()}`)
}

async function paneOption(tmux: string, socket: string, target: string, option: string): Promise<string> {
  const result = await localCommand([tmux, "-L", socket, "show-options", "-pv", "-t", target, option], 5_000, undefined, true)
  return result.stdout.trim()
}

async function localCommand(argv: readonly string[], timeoutMs: number, cwd?: string, allowFailure = false, env = process.env): Promise<CommandResult> {
  const child = Bun.spawn(argv, { cwd, env, stdout: "pipe", stderr: "pipe" })
  const timeout = setTimeout(() => child.kill(), timeoutMs)
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    if (!allowFailure && code !== 0) throw new Error(`${basename(argv[0] ?? "command")} failed (${code}): ${stderr.trim()}`)
    return { code, stdout, stderr }
  } finally { clearTimeout(timeout) }
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }

export async function runMuslSpike(input: MuslSpikeInput): Promise<MuslSpikeResult> {
  if (!isAbsolute(input.sourceRoot)) throw new Error("sourceRoot must be absolute")
  const sourceRoot = resolve(input.sourceRoot)
  const info = targetInfo(input.target)
  const image = builderImage(info.builderArch)
  const run = input.runner ?? dockerRunner
  const suffix = `${process.pid}-${crypto.randomUUID()}`
  const registryVolume = `pane-dash-musl-registry-${suffix}`
  const targetVolume = `pane-dash-musl-target-${suffix}`
  const runtimeTag = `pane-dash-musl-runtime-${suffix}`
  const buildContext = await mkdtemp(join(tmpdir(), "pane-dash-musl-runtime-"))
  const dockerfile = join(sourceRoot, "scripts/release/tmux-runtime.Dockerfile")
  let runtimeImageId = ""

  const cleanup = async () => {
    await Promise.allSettled([
      execute(run, ["docker", "volume", "rm", "-f", registryVolume], input.signal, 30_000),
      execute(run, ["docker", "volume", "rm", "-f", targetVolume], input.signal, 30_000),
      execute(run, ["docker", "image", "rm", "-f", runtimeTag], input.signal, 30_000),
    ])
    await rm(buildContext, { recursive: true, force: true })
  }

  try {
    await copyFile(dockerfile, join(buildContext, "tmux-runtime.Dockerfile"))
    const builderRepoDigest = await ensureExactImage(run, image, info.platform, input.signal)
    const runtimeImage = runtimeManifest(info.builderArch)
    await ensureExactImage(run, runtimeImage, info.platform, input.signal, true)
    await verifyBuilder(run, image, info.platform, input.target, input.signal)
    await execute(run, ["docker", "volume", "create", registryVolume], input.signal, 30_000)
    await execute(run, ["docker", "volume", "create", targetVolume], input.signal, 30_000)

    // Bootstrap may fetch locked dependencies. The compile itself is separately offline.
    await execute(run, dockerRun(info.platform, image, [
      "--network", "bridge", "-v", `${sourceRoot}:/source:ro`, "-v", `${registryVolume}:/cargo`, "-v", `${targetVolume}:/target`,
      "-e", "CARGO_HOME=/cargo", "-e", "CARGO_TARGET_DIR=/target", "-w", "/source/pane-dash",
      "sh", "-ceu", "cargo fetch --locked",
    ]), input.signal, DOCKER_TIMEOUT_MS)
    await execute(run, dockerRun(info.platform, image, [
      "--network", "none", "-v", `${sourceRoot}:/source:ro`, "-v", `${registryVolume}:/cargo`, "-v", `${targetVolume}:/target`,
      "-e", "CARGO_HOME=/cargo", "-e", "CARGO_TARGET_DIR=/target", "-w", "/source/pane-dash",
      "sh", "-ceu", `cargo build --locked --offline --release --target ${input.target}`,
    ]), input.signal, DOCKER_TIMEOUT_MS)

    await execute(run, ["docker", "build", "--platform", info.platform, "--network", "default", "--build-arg", `DEBIAN_BASE=${runtimeImage}`, "-f", join(buildContext, "tmux-runtime.Dockerfile"), "-t", runtimeTag, buildContext], input.signal, DOCKER_TIMEOUT_MS)
    runtimeImageId = (await execute(run, ["docker", "image", "inspect", "--format", "{{.Id}}", runtimeTag], input.signal, 30_000)).stdout.trim()
    if (!runtimeImageId) throw new Error("runtime image ID missing")

    const binary = `/work/${input.target}/release/pane-dash`
    const runtime = (command: string, timeoutMs = 30_000) => execute(run, dockerRun(info.platform, runtimeTag, [
      "--network", "none", "--entrypoint", "/bin/sh", "-v", `${targetVolume}:/work:ro`, "-ceu", command,
    ]), input.signal, timeoutMs)
    const runtimeUname = (await runtime("uname -m")).stdout.trim()
    if (runtimeUname !== info.uname) throw new Error(`runtime uname expected ${info.uname}, got ${runtimeUname || "empty"}`)
    const fileOutput = (await runtime(`file ${binary}`)).stdout
    if (!fileOutput.includes(info.architecture)) throw new Error(`ELF architecture expected ${info.architecture}, got ${fileOutput.trim()}`)
    const programHeaders = (await runtime(`readelf -l ${binary}`)).stdout
    if (/\bINTERP\b/.test(programHeaders)) throw new Error("ELF PT_INTERP present")
    const dynamicEntries = (await runtime(`readelf -d ${binary}`)).stdout
    if (/\bNEEDED\b/.test(dynamicEntries)) throw new Error("ELF NEEDED entry present")
    const ldd = await runtime(`ldd ${binary} || true`)
    const lddOutput = `${ldd.stdout}${ldd.stderr}`
    if (!/(not a dynamic executable|statically linked)/i.test(lddOutput)) throw new Error(`ldd did not prove static binary: ${lddOutput.trim()}`)
    const tmuxOutput = (await runtime("tmux -V")).stdout
    if (!/^tmux 3\.(6|[7-9]|[1-9][0-9])(?:\D|$)/.test(tmuxOutput.trim())) throw new Error(`tmux 3.6 required, got ${tmuxOutput.trim() || "empty"}`)

    const executionOutput = (await runtime(smokeScript(binary), SMOKE_TIMEOUT_MS)).stdout
    if (!/(coldframe_ms|config_to_frame_ms)=\d+(?:\.\d+)?/.test(executionOutput)) throw new Error(`missing first-frame/coldframe output: ${executionOutput.slice(-2_000)}`)
    return {
      imageDigest: builderRepoDigest,
      fileOutput,
      executionOutput,
      tmuxOutput,
      provenance: { target: input.target, platform: info.platform, builderDigest: `sha256:${RUST_ALPINE_BUILDERS[info.builderArch]}`, builderImage: image, runtimeImageId, runtimeBaseDigest: TMUX_RUNTIME.debianDigest, runtimeManifest: runtimeImage, tmuxVersion: tmuxOutput.trim(), runtimeUname },
    }
  } finally {
    await cleanup()
  }
}

function dockerRun(platform: string, image: string, args: readonly string[]): string[] {
  const options: string[] = []
  let cursor = 0
  while (cursor < args.length) {
    const option = args[cursor]
    if (!option || !["--network", "--entrypoint", "-v", "-e", "-w"].includes(option)) break
    const value = args[cursor + 1]
    if (!value) throw new Error(`docker option ${option} missing value`)
    options.push(option, value)
    cursor += 2
  }
  return ["docker", "run", "--rm", "--platform", platform, ...options, image, ...args.slice(cursor)]
}

async function ensureExactImage(run: CommandRunner, image: string, platform: string, signal?: AbortSignal, allowIndexAlias = false): Promise<string> {
  if (allowIndexAlias) {
    const manifest = (await execute(run, ["docker", "manifest", "inspect", image], signal, 30_000)).stdout
    const parsed = JSON.parse(manifest) as { architecture?: string; config?: { data?: string } }
    const architecture = parsed.architecture ?? (parsed.config?.data ? JSON.parse(atob(parsed.config.data)).architecture : undefined)
    if (architecture !== platform.split("/")[1]) throw new Error(`runtime manifest architecture expected ${platform}, got ${architecture || "empty"}`)
  }
  let inspected: CommandResult | undefined
  try { inspected = await run(["docker", "image", "inspect", "--format", "{{index .RepoDigests 0}}", image], { timeoutMs: 30_000, signal }) } catch { /* pull only when inspection is absent */ }
  const localPlatform = inspected?.code === 0
    ? (await execute(run, ["docker", "image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", image], signal, 30_000)).stdout.trim()
    : ""
  if (!inspected || inspected.code !== 0 || localPlatform !== platform) {
    await execute(run, ["docker", "pull", "--platform", platform, image], signal, DOCKER_TIMEOUT_MS)
  }
  const resolvedPlatform = (await execute(run, ["docker", "image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", image], signal, 30_000)).stdout.trim()
  if (resolvedPlatform !== platform) throw new Error(`image platform expected ${platform}, got ${resolvedPlatform || "empty"}`)
  const digest = (await execute(run, ["docker", "image", "inspect", "--format", "{{index .RepoDigests 0}}", image], signal, 30_000)).stdout.trim()
  const expectedDigest = image.slice(image.indexOf("@") + 1)
  if (!digest.endsWith(expectedDigest) && !(allowIndexAlias && digest.endsWith(`sha256:${TMUX_RUNTIME.debianDigest}`))) {
    throw new Error(`builder RepoDigest does not match pinned image: ${digest || "empty"}`)
  }
  return digest
}

async function verifyBuilder(run: CommandRunner, image: string, platform: string, target: MuslTarget, signal?: AbortSignal): Promise<void> {
  const host = (await execute(run, dockerRun(platform, image, ["--network", "none", "rustc", "-vV"]), signal, 30_000)).stdout
  if (!host.includes(`host: ${target}`)) throw new Error(`Rust host expected ${target}, got ${host.trim()}`)
  const cargo = await run(dockerRun(platform, image, ["--network", "none", "cargo", "--version"]), { timeoutMs: 30_000, signal })
  if (cargo.code !== 0 || !/^cargo \d+\.\d+\.\d+/m.test(cargo.stdout)) throw new Error("cargo unavailable in pinned builder")
  const installed = (await execute(run, dockerRun(platform, image, ["--network", "none", "rustup", "target", "list", "--installed"]), signal, 30_000)).stdout
  if (!installed.split(/\r?\n/).includes(target)) throw new Error(`Rust target ${target} is not installed`)
}

async function execute(run: CommandRunner, argv: readonly string[], signal: AbortSignal | undefined, timeoutMs: number): Promise<CommandResult> {
  const result = await run(argv, { timeoutMs, signal })
  if (result.code !== 0) throw new Error(`${basename(argv[0] ?? "command")} failed (${result.code}): ${result.stderr.trim()}`)
  return result
}

async function dockerRunner(argv: readonly string[], options: { readonly timeoutMs: number; readonly signal?: AbortSignal }): Promise<CommandResult> {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" })
  const timeout = setTimeout(() => child.kill(), options.timeoutMs)
  const abort = () => child.kill()
  options.signal?.addEventListener("abort", abort, { once: true })
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    return { code, stdout, stderr }
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener("abort", abort)
  }
}

function smokeScript(binary: string): string {
  return `
set -eu
socket="pane-dash-musl-$$"
cleanup() { /usr/local/bin/tmux -L "$socket" kill-server >/dev/null 2>&1 || true; kill "\${client:-}" >/dev/null 2>&1 || true; rm -f "\${bench:-}"; rm -rf "\${wrapper:-}"; }
trap cleanup EXIT INT TERM
tmux -L "$socket" -f /dev/null new-session -d -s smoke 'sleep 30'
tmux -L "$socket" list-sessions
tmux -L "$socket" show-options -g
tmux -L "$socket" list-panes -a
TERM=xterm script -q -c "tmux -L $socket attach-session -t smoke" /dev/null >/dev/null 2>&1 & client=$!
for i in $(seq 1 100); do client_tty="$(tmux -L "$socket" list-clients -F '#{client_tty}' | head -n 1 || true)"; [ -n "$client_tty" ] && break; sleep 0.05; done
session_id="$(tmux -L "$socket" list-clients -F '#{session_id}' | head -n 1)"
pane_id="$(tmux -L "$socket" list-clients -F '#{pane_id}' | head -n 1)"
[ -n "$client_tty" ] && [ -n "$session_id" ] && [ -n "$pane_id" ]
tmux -L "$socket" capture-pane -p -t smoke:0.0 >/dev/null
wrapper="$(mktemp -d)"
printf '#!/bin/sh\nexec /usr/local/bin/tmux -L %s "$@"\n' "$socket" > "$wrapper/tmux"
chmod 700 "$wrapper/tmux"
PATH="$wrapper:$PATH"
bench="$(mktemp)"
TERM=xterm timeout 20 script -q -c "${binary} --bench-first-frame $client_tty $session_id $pane_id 2>&1" "$bench" >/dev/null 2>&1
cat "$bench"
`
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2)
  if (args[0] === "--normalize-opencode-version") {
    if (args.length !== 2 || !args[1]) {
      throw new Error("usage: bun scripts/release/spikes.ts --normalize-opencode-version <absolute-opencode-binary>")
    }
    console.log(await runOpenCodeVersion(args[1]))
    return
  }
  if (args[0] === "--opencode-1.17.20") {
    const binary = args[1]
    const registryHost = args[2]?.match(/^--registry-host=(127\.0\.0\.1|::1)$/)?.[1]
    if (args.length !== 3 || !binary || (registryHost !== "127.0.0.1" && registryHost !== "::1")) {
      throw new Error("usage: bun scripts/release/spikes.ts --opencode-1.17.20 <absolute-opencode-binary> --registry-host=<127.0.0.1|::1>")
    }
    const result = await runOpenCodeSpike({ sourceRoot: resolve(import.meta.dir, "../.."), binary, registryHost })
    console.log("name=@xiopt/pane-dash-opencode rawSpec=0.1.0 status=PASS cleanup=PASS public-network-requests=0 real-home-writes=0 default-tmux-uses=0")
    console.log(JSON.stringify(result))
    return
  }
  const [mode, target, network] = args
  if (mode !== "--musl" || !target || network !== "--network=none" || !isMuslTarget(target)) {
    throw new Error("usage: bun scripts/release/spikes.ts --musl <aarch64-unknown-linux-musl|x86_64-unknown-linux-musl> --network=none")
  }
  const result = await runMuslSpike({ target, sourceRoot: resolve(import.meta.dir, "../..") })
  console.log(`${target} elf-static=PASS execution=PASS tmux=PASS`)
  console.log(JSON.stringify(result.provenance))
}

function isMuslTarget(value: string): value is MuslTarget {
  return value === "aarch64-unknown-linux-musl" || value === "x86_64-unknown-linux-musl"
}

if (import.meta.main) main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
