import { chmod, copyFile, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { basename, isAbsolute, join, resolve } from "node:path"
import { DEBIAN_PLATFORM_MANIFESTS, OPENCODE_PACKAGE_FILES, RUST_ALPINE_BUILDERS, TMUX_RUNTIME } from "./contracts"
import { startLocalRegistry, type LocalPackage } from "./local-registry"

export type MuslTarget = "aarch64-unknown-linux-musl" | "x86_64-unknown-linux-musl"

type CommandResult = { readonly code: number; readonly stdout: string; readonly stderr: string }
export type CommandRunner = (argv: readonly string[], options: { readonly timeoutMs: number; readonly signal?: AbortSignal }) => Promise<CommandResult>

export class CommandTimeoutError extends Error {
  constructor(readonly argv: readonly string[], readonly stdout: string, readonly stderr: string) {
    super(`timed out after running ${basename(argv[0] ?? "command")}`)
    this.name = "CommandTimeoutError"
  }
}

export class CommandAbortedError extends Error {
  constructor(readonly argv: readonly string[], readonly stdout: string, readonly stderr: string) {
    super(`aborted while running ${basename(argv[0] ?? "command")}`)
    this.name = "CommandAbortedError"
  }
}

export type IsolationObservations = {
  readonly platform: "darwin"
  readonly policySha256: string
  readonly nonLoopbackConnect: "denied-by-policy"
  readonly nonLoopbackConnectErrno: "EPERM" | "EACCES"
  readonly loopbackRegistryConnect: "succeeded"
  readonly allowedSyntheticWrite: "succeeded"
  readonly forbiddenWrite: "denied-by-policy"
  readonly publicNetworkRequests: 0
  readonly realHomeWrites: 0
  readonly defaultTmuxUses: 0
}

export type IsolationPlatform = {
  readonly platform: "darwin"
  run(argv: readonly string[], profile: string, timeoutMs: number, signal?: AbortSignal): Promise<CommandResult>
}

type MuslProvenance = {
  readonly target: MuslTarget
  readonly platform: "linux/amd64" | "linux/arm64"
  readonly builderDigest: string
  readonly builderImage: string
  readonly runtimeImageId: string
  readonly runtimeBaseDigest: string
  readonly runtimeManifest: string
  readonly tmuxVersion: string
  readonly tmuxSourceUrl: string
  readonly tmuxSourceSha256: string
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
const COMMAND_OUTPUT_CAP_BYTES = 1_000_000
const COMMAND_TERM_GRACE_MS = 300
const COMMAND_REAP_TIMEOUT_MS = 500
const COMMAND_PIPE_TIMEOUT_MS = 500
const COMMAND_MONITOR_TIMEOUT_MS = COMMAND_TERM_GRACE_MS + COMMAND_REAP_TIMEOUT_MS + 500
const DOCKER_CLEANUP_TIMEOUT_MS = 30_000
const CLEANUP_PANE_OPTIONS = ["@pane_dash_status", "@pane_dash_status_since", "@pane_dash_heartbeat", "@pane_dash_title", "@pane_dash_model"] as const

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

export function tmuxWrapperScript(tmux: string, socket: string, calls: string, permit: string, cleanupEntered: string): string {
  return `#!/bin/sh
printf '%s\\n' "-L ${socket} $*" >> ${shellQuote(calls)}
if [ "$#" -eq 5 ] && [ "$1" = set-option ] && [ "$2" = -pu ] && [ "$3" = -t ] && [ -n "\${TMUX_PANE:-}" ] && [ "$4" = "$TMUX_PANE" ]; then
  case "$5" in
    @pane_dash_status|@pane_dash_status_since|@pane_dash_heartbeat|@pane_dash_title|@pane_dash_model) printf cleanup-entered > ${shellQuote(cleanupEntered)} ;;
  esac
fi
if [ -f ${shellQuote(cleanupEntered)} ]; then
  for _ in $(seq 1 300); do [ -f ${shellQuote(permit)} ] && break; sleep 0.1; done
  [ -f ${shellQuote(permit)} ] || exit 1
fi
exec ${shellQuote(tmux)} -L ${shellQuote(socket)} "$@"
`
}

/** Platform boundary; unsupported hosts must never emit an isolation claim. */
export function seatbeltIsolationPlatform(platform: string, runner: CommandRunner): IsolationPlatform {
  if (platform !== "darwin") {
    return {
      platform: "darwin",
      async run(): Promise<CommandResult> { throw new Error(`Darwin Seatbelt isolation unavailable on ${platform}`) },
    }
  }
  return {
    platform: "darwin",
    run: (argv, profile, timeoutMs, signal) => runner(["/usr/bin/sandbox-exec", "-f", profile, ...argv], { timeoutMs, signal }),
  }
}

export function assertIsolationObservations(observed: IsolationObservations): void {
  if (!/^[a-f0-9]{64}$/.test(observed.policySha256)) throw new Error("isolation policy SHA256 is invalid")
  if (observed.platform !== "darwin" || observed.nonLoopbackConnect !== "denied-by-policy" || !["EPERM", "EACCES"].includes(observed.nonLoopbackConnectErrno) || observed.loopbackRegistryConnect !== "succeeded" || observed.allowedSyntheticWrite !== "succeeded" || observed.forbiddenWrite !== "denied-by-policy") {
    throw new Error("isolation canaries were not enforced")
  }
  if (observed.publicNetworkRequests !== 0 || observed.realHomeWrites !== 0 || observed.defaultTmuxUses !== 0) throw new Error("isolation counts are nonzero")
}

export function formatOpenCodePassSummary(result: OpenCodeSpikeResult): string {
  assertIsolationObservations(result.isolation)
  return `name=${result.name} rawSpec=${result.rawSpec} status=PASS cleanup=PASS non-loopback-connect-errno=${result.isolation.nonLoopbackConnectErrno} public-network-requests=${result.isolation.publicNetworkRequests} real-home-writes=${result.isolation.realHomeWrites} default-tmux-uses=${result.isolation.defaultTmuxUses}`
}

export async function runOpenCodeVersion(binary: string, run: CommandRunner = dockerRunner): Promise<string> {
  if (!isAbsolute(binary)) throw new Error("OpenCode binary must be absolute")
  const result = await execute(run, [binary, "--version"], undefined, OPENCODE_VERSION_TIMEOUT_MS)
  return normalizeOpenCodeVersion(result.stdout)
}

export type OpenCodeSpikeResult = {
  readonly version: string
  readonly sha256: string
  readonly name: string
  readonly rawSpec: string
  readonly requests: readonly string[]
  readonly isolation: IsolationObservations
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
  let isolation: DarwinIsolation | undefined
  try {
    const plugin = await packOpenCodePlugin(input.sourceRoot, packageRoot)
    const companion = await packCompanionPlugin(companionRoot)
    registry = await startLocalRegistry({ host: input.registryHost, packages: new Map([[plugin.name, plugin], [companion.name, companion]]) })
    await mkdir(join(process.env.XDG_CONFIG_HOME, "opencode"), { recursive: true })
    await writeFile(join(process.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), JSON.stringify({ plugin: [OPENCODE_PLUGIN_SPEC] }))
    await writeFile(process.env.npm_config_userconfig, `registry=${registry.origin}\n@xiopt:registry=${registry.origin}\n@opencode-ai:registry=${registry.origin}\naudit=false\nfund=false\n`)

    isolation = await establishDarwinIsolation({ root, registryHost: input.registryHost, registryPort: new URL(registry.origin).port })

    await startThenStopOpenCode(tmux, socket, input.binary, root, true, isolation)
    const observed = await startThenStopOpenCode(tmux, socket, input.binary, root, false, isolation)
    if (!observed.status || !observed.heartbeat) throw new Error("OpenCode plugin did not publish a fresh pane heartbeat")
    assertOpenCodeRegistryRequests(registry.requests, registry.origin)
    const parsed = parseOpenCodePluginSpec(OPENCODE_PLUGIN_SPEC)
    const observations = { ...isolation.observations, defaultTmuxUses: observed.defaultTmuxUses }
    assertIsolationObservations(observations)
    return { version, sha256, ...parsed, requests: registry.requests, isolation: observations }
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : error}; registry-requests=${JSON.stringify(registry?.requests ?? [])}`)
  } finally {
    await Promise.allSettled([
      localCommand([tmux, "-L", socket, "kill-server"], 5_000),
      registry?.close() ?? Promise.resolve(),
      isolation ? rm(isolation.profilePath, { force: true }) : Promise.resolve(),
    ])
    await rm(root, { recursive: true, force: true })
  }
}

type DarwinIsolation = { readonly observations: IsolationObservations; readonly profilePath: string }

async function establishDarwinIsolation(input: { readonly root: string; readonly registryHost: "127.0.0.1" | "::1"; readonly registryPort: string }): Promise<DarwinIsolation> {
  const platform = seatbeltIsolationPlatform(process.platform, (argv, options) => localCommand(argv, options.timeoutMs, undefined, true))
  if (process.platform !== "darwin") throw new Error(`Darwin Seatbelt isolation unavailable on ${process.platform}`)
  if (!(await stat("/usr/bin/sandbox-exec")).isFile()) throw new Error("Darwin Seatbelt isolation unavailable: sandbox-exec missing")
  const netcat = await stat("/usr/bin/nc")
  if (!netcat.isFile() || (netcat.mode & 0o111) === 0) throw new Error("Darwin Seatbelt isolation unavailable: /usr/bin/nc missing or not executable")
  const policyRoot = await realpath(input.root)
  const writable = await Promise.all([process.env.HOME, process.env.XDG_DATA_HOME, process.env.XDG_CONFIG_HOME, process.env.XDG_CACHE_HOME, process.env.npm_config_cache, process.env.BUN_INSTALL_CACHE_DIR, process.env.TMPDIR, process.env.TMUX_TMPDIR].map(async (path) => {
    if (!path) throw new Error("clean-room writable roots required")
    return realpath(path)
  }))
  const profile = darwinSeatbeltProfile([...new Set([policyRoot, ...writable])])
  const profilePath = join(policyRoot, "opencode-seatbelt.sb")
  await writeFile(profilePath, profile, { mode: 0o600 })
  const policySha256 = createHash("sha256").update(profile).digest("hex")
  const forbidden = join(resolve(policyRoot, "..", ".."), `pane-dash-forbidden-${crypto.randomUUID()}`)
  const loopback = await runNetworkIsolationCanary(platform, profilePath, input.registryHost, input.registryPort)
  if (loopback.outcome !== "succeeded") throw new Error(`loopback registry canary failed: ${loopback.outcome}`)
  const nonLoopback = await runNetworkIsolationCanary(platform, profilePath, "1.1.1.1", "443")
  if (nonLoopback.outcome !== "denied-by-policy" || !nonLoopback.errno) throw new Error(`non-loopback canary was not denied by policy: ${nonLoopback.outcome}`)
  const allowed = await runIsolationCanary(platform, profilePath, join(policyRoot, "canary-write"))
  if (allowed.outcome !== "succeeded") throw new Error(`synthetic-root write canary failed: ${allowed.outcome}`)
  const denied = await runIsolationCanary(platform, profilePath, forbidden)
  if (denied.outcome !== "denied-by-policy") throw new Error(`forbidden write canary was not denied by policy: ${denied.outcome}`)
  return { profilePath, observations: { platform: "darwin", policySha256, nonLoopbackConnect: "denied-by-policy", nonLoopbackConnectErrno: nonLoopback.errno, loopbackRegistryConnect: "succeeded", allowedSyntheticWrite: "succeeded", forbiddenWrite: "denied-by-policy", publicNetworkRequests: 0, realHomeWrites: 0, defaultTmuxUses: 0 } }
}

function darwinSeatbeltProfile(writableRoots: readonly string[]): string {
  if (writableRoots.some((root) => !isAbsolute(root))) throw new Error("Seatbelt writable roots must be absolute")
  return `(version 1)
(allow default)
(deny network*)
(allow network-inbound (local ip "localhost:*"))
(allow network-outbound (remote ip "localhost:*"))
(allow network-outbound (remote unix-socket))
(deny file-write*)
${writableRoots.map((root) => `(allow file-write* (subpath ${seatbeltQuote(root)}))`).join("\n")}
(allow file-write* (literal "/dev/null"))
(allow file-write* (literal "/dev/tty"))
`
}

function seatbeltQuote(value: string): string { return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"` }

type SeatbeltNetworkClassification =
  | { readonly outcome: "denied-by-policy"; readonly errno: "EPERM" | "EACCES" }
  | { readonly outcome: "unexpected:" | `unexpected:${string}` }

type IsolationCanaryResult = SeatbeltNetworkClassification | { readonly outcome: "succeeded" | "denied-by-policy" }

/** Maps only Seatbelt's permission failures, never ambient network failures, to a policy denial. */
export function classifySeatbeltNetworkDenial(error: { readonly code?: unknown; readonly message?: unknown }): SeatbeltNetworkClassification {
  const code = typeof error.code === "string" ? error.code : ""
  if (code === "EPERM" || code === "EACCES") return { outcome: "denied-by-policy", errno: code }
  const message = typeof error.message === "string" ? error.message : ""
  if (message === "Operation not permitted") return { outcome: "denied-by-policy", errno: "EPERM" }
  if (message === "Permission denied") return { outcome: "denied-by-policy", errno: "EACCES" }
  return { outcome: `unexpected:${code || message}` }
}

export async function runNetworkIsolationCanary(platform: IsolationPlatform, profile: string, host: string, port: string): Promise<SeatbeltNetworkClassification | { readonly outcome: "succeeded" }> {
  const captureRoot = await mkdtemp(join(process.env.TMPDIR || tmpdir(), "pane-dash-seatbelt-nc-"))
  const stderrPath = join(captureRoot, "stderr")
  try {
    const command = `exec /usr/bin/nc -v -z -w 1 ${shellQuote(host)} ${shellQuote(port)} 2>${shellQuote(stderrPath)}`
    const result = await platform.run(["/bin/sh", "-ceu", command], profile, 5_000)
    if (result.code === 0) return { outcome: "succeeded" }
    const message = (await readFile(stderrPath, "utf8").catch(() => result.stderr)).trim()
    const match = /^nc: connectx to .+ failed: (Operation not permitted|Permission denied)$/.exec(message)
    return classifySeatbeltNetworkDenial({ message: match?.[1] ?? message })
  } finally {
    await rm(captureRoot, { recursive: true, force: true })
  }
}

async function runIsolationCanary(platform: IsolationPlatform, profile: string, first: string): Promise<IsolationCanaryResult> {
  const script = `import {writeFile} from "node:fs/promises"; try { await writeFile(${JSON.stringify(first)},"canary\\n"); console.log("succeeded") } catch (e) { console.log(["EPERM","EACCES","Operation not permitted"].some((x)=>String(e.code||e.message).includes(x))?"denied-by-policy":"unexpected:"+(e.code||e.message)) }`
  const result = await platform.run([process.execPath, "-e", script], profile, 5_000)
  if (result.code !== 0) throw new Error(`isolation write canary failed (${result.code}): ${result.stderr.trim()}`)
  return { outcome: result.stdout.trim() as "succeeded" | "denied-by-policy" }
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
    writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "@xiopt/pane-dash-opencode", version: "0.1.0", type: "module", main: "./dist/index.js", engines: { opencode: ">=1.17.20" }, exports: { ".": "./dist/index.js", "./server": "./dist/index.js" }, files: ["dist/index.js", "README.md", "LICENSE"] }, null, 2) + "\n"),
  ])
  return packPackage(packageRoot, "@xiopt/pane-dash-opencode", "0.1.0", "opencode")
}

async function packCompanionPlugin(root: string): Promise<LocalPackage> {
  await mkdir(root, { recursive: true })
  await Promise.all([
    writeFile(join(root, "package.json"), JSON.stringify({ name: "@opencode-ai/plugin", version: "1.17.20", type: "module", exports: { ".": "./index.js" }, files: ["index.js"] }) + "\n"),
    writeFile(join(root, "index.js"), "export {}\n"),
  ])
  return packPackage(root, "@opencode-ai/plugin", "1.17.20", "companion")
}

type PackageFixture = "opencode" | "companion"

export function assertExactPackageFixture(packageJson: unknown, inventory: readonly string[], fixture: PackageFixture): void {
  const expected = fixture === "opencode"
    ? { name: "@xiopt/pane-dash-opencode", version: "0.1.0", type: "module", main: "./dist/index.js", engines: { opencode: ">=1.17.20" }, exports: { ".": "./dist/index.js", "./server": "./dist/index.js" }, files: ["dist/index.js", "README.md", "LICENSE"] }
    : { name: "@opencode-ai/plugin", version: "1.17.20", type: "module", exports: { ".": "./index.js" }, files: ["index.js"] }
  const expectedInventory = fixture === "opencode" ? OPENCODE_PACKAGE_FILES : ["package/package.json", "package/index.js"]
  if (JSON.stringify(packageJson) !== JSON.stringify(expected)) throw new Error(`${fixture} package.json is not the exact required fixture`)
  if (JSON.stringify([...inventory].sort()) !== JSON.stringify([...expectedInventory].sort())) throw new Error(`${fixture} tarball inventory is not exact`)
}

async function packPackage(root: string, name: string, version: string, fixture?: PackageFixture): Promise<LocalPackage> {
  const packCache = join(root, ".pack-cache")
  await mkdir(packCache)
  const packed = await localCommand(["npm", "pack", "--ignore-scripts", "--json", "--pack-destination", root], 30_000, root, false, { ...process.env, npm_config_cache: packCache })
  const metadata = (JSON.parse(packed.stdout) as Array<{ filename: string; files?: Array<{ path: string }> }>)[0]
  const file = metadata?.filename
  if (!file) throw new Error(`npm pack did not return ${name}`)
  if (fixture) {
    const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"))
    assertExactPackageFixture(packageJson, metadata.files?.map(file => `package/${file.path}`) ?? [], fixture)
  }
  const tarball = await readFile(join(root, file))
  return { name, version, tarball, integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}` }
}

async function startThenStopOpenCode(tmux: string, socket: string, binary: string, root: string, bootstrap: boolean, isolation: DarwinIsolation): Promise<{ status: string; heartbeat: string; defaultTmuxUses: number }> {
  const session = `opencode-${crypto.randomUUID()}`
  const script = join(root, `${session}.sh`)
  const wrapper = join(root, `${session}-bin`)
  const calls = join(root, `${session}-cleanup.log`)
  const permit = join(root, `${session}-cleanup-permit`)
  const cleanupEntered = join(root, `${session}-cleanup-entered`)
  const marker = join(root, `${session}-complete`)
  await mkdir(wrapper)
  await writeFile(join(wrapper, "tmux"), tmuxWrapperScript(tmux, socket, calls, permit, cleanupEntered))
  await chmod(join(wrapper, "tmux"), 0o700)
  await writeFile(script, `#!/bin/sh\nPATH=${shellQuote(wrapper)}:$PATH /usr/bin/sandbox-exec -f ${shellQuote(isolation.profilePath)} ${shellQuote(binary)} run --command noop --print-logs --log-level DEBUG || true\nprintf complete > ${shellQuote(marker)}\nexec cat\n`)
  await chmod(script, 0o700)
  if (bootstrap) await writeFile(permit, "continue\n")
  await localCommand([tmux, "-L", socket, "-f", "/dev/null", "new-session", "-d", "-s", session, script], 10_000)
  const target = `${session}:0.0`
  if (bootstrap) {
    await waitForFile(marker, OPENCODE_STARTUP_TIMEOUT_MS)
    const defaultTmuxUses = await assertTmuxWrapperCalls(calls, socket)
    await localCommand([tmux, "-L", socket, "kill-session", "-t", session], 10_000)
    return { status: "bootstrap", heartbeat: "bootstrap", defaultTmuxUses }
  }
  const status = await waitForPaneOption(tmux, socket, target, "@pane_dash_status", OPENCODE_STARTUP_TIMEOUT_MS)
  const heartbeat = await waitForPaneOption(tmux, socket, target, "@pane_dash_heartbeat", OPENCODE_STARTUP_TIMEOUT_MS)
  assertOpenCodeCleanupDelayState(status, heartbeat)
  const paneId = (await localCommand([tmux, "-L", socket, "display-message", "-p", "-t", target, "#{pane_id}"], 5_000)).stdout.trim()
  if (!/^%\d+$/.test(paneId)) throw new Error(`invalid OpenCode pane id: ${paneId}`)
  await waitForFile(cleanupEntered, OPENCODE_STARTUP_TIMEOUT_MS)
  assertOpenCodeCleanupDelayState(
    await paneOption(tmux, socket, target, "@pane_dash_status"),
    await paneOption(tmux, socket, target, "@pane_dash_heartbeat"),
  )
  await writeFile(permit, "continue\n")
  await waitForFile(marker, OPENCODE_STARTUP_TIMEOUT_MS)
  for (const option of CLEANUP_PANE_OPTIONS) {
    const value = await paneOption(tmux, socket, target, option)
    if (value) throw new Error(`OpenCode cleanup left ${option}`)
  }
  const cleanupCalls = (await readFile(calls, "utf8")).trim().split("\n")
  const defaultTmuxUses = assertTmuxWrapperCallLines(cleanupCalls, socket)
  const cleanupOnly = cleanupCalls.filter(call => call.startsWith(`-L ${socket} set-option -pu -t ${paneId} `))
  if (cleanupOnly.length !== CLEANUP_PANE_OPTIONS.length) throw new Error(`unexpected direct cleanup calls: ${cleanupOnly.join(" | ")}`)
  for (const option of CLEANUP_PANE_OPTIONS) {
    if (cleanupCalls.filter((call) => call === `-L ${socket} set-option -pu -t ${paneId} ${option}`).length !== 1) throw new Error(`missing direct cleanup call for ${option}`)
  }
  await localCommand([tmux, "-L", socket, "kill-session", "-t", session], 10_000)
  const noSession = await localCommand([tmux, "-L", socket, "has-session", "-t", session], 5_000, undefined, true)
  assertNoOwnedTmuxProcess(noSession)
  await localCommand([tmux, "-L", socket, "kill-server"], 5_000, undefined, true)
  const noServer = await localCommand([tmux, "-L", socket, "list-sessions"], 5_000, undefined, true)
  assertNoOwnedTmuxProcess(noServer)
  return { status, heartbeat, defaultTmuxUses }
}

async function assertTmuxWrapperCalls(calls: string, socket: string): Promise<number> {
  const contents = await readFile(calls, "utf8").catch(() => "")
  return assertTmuxWrapperCallLines(contents.trim() ? contents.trim().split("\n") : [], socket)
}

function assertTmuxWrapperCallLines(calls: readonly string[], socket: string): number {
  const expected = `-L ${socket} `
  const defaultTmuxUses = calls.filter((call) => !call.startsWith(expected)).length
  if (defaultTmuxUses !== 0) throw new Error(`plugin tmux invocation bypassed isolated socket: ${calls.join(" | ")}`)
  return defaultTmuxUses
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

export async function localCommand(argv: readonly string[], timeoutMs: number, cwd?: string, allowFailure = false, env = process.env, signal?: AbortSignal): Promise<CommandResult> {
  const result = await superviseCommand(argv, { timeoutMs, signal, cwd, env })
  if (!allowFailure && result.code !== 0) throw new Error(`${basename(argv[0] ?? "command")} failed (${result.code}): ${result.stderr.trim()}`)
  return result
}

type SupervisedCommandOptions = {
  readonly timeoutMs: number
  readonly signal?: AbortSignal
  readonly cwd?: string
  readonly env?: Record<string, string | undefined>
}

function collectBoundedOutput(stream: ReadableStream<Uint8Array>): { readonly result: Promise<string>; cancel(): Promise<void> } {
  const reader = stream.getReader()
  let captured = ""
  let bytes = 0
  let truncated = false
  const decoder = new TextDecoder()
  const result = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const permitted = Math.max(0, COMMAND_OUTPUT_CAP_BYTES - bytes)
        bytes += value.byteLength
        if (permitted > 0) captured += decoder.decode(value.subarray(0, permitted), { stream: true })
        if (value.byteLength > permitted) truncated = true
      }
      captured += decoder.decode()
      return `${captured}${truncated ? "\n[output truncated]" : ""}`
    } finally {
      reader.releaseLock()
    }
  })()
  return { result, cancel: async () => { await reader.cancel().catch(() => undefined) } }
}

function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)) }

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return await new Promise<T | undefined>((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

function signalOwnedGroup(groupId: number, signal: "SIGTERM" | "SIGKILL"): void {
  // `detached` gives the leader a fresh PGID equal to its PID. A live pipe proves
  // this group still has one of our descendants, so its PGID cannot be reused.
  try { process.kill(-groupId, signal) } catch (error) {
    if (!(error instanceof Error) || !/ESRCH/.test(error.message)) throw error
  }
}

function signalMonitor(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try { process.kill(pid, signal) } catch (error) {
    if (!(error instanceof Error) || !/ESRCH/.test(error.message)) throw error
  }
}

async function stopOwnedGroup(groupId: number): Promise<void> {
  signalOwnedGroup(groupId, "SIGTERM")
  await delay(COMMAND_TERM_GRACE_MS)
  signalOwnedGroup(groupId, "SIGKILL")
}

const PERL_PROCESS_MONITOR = String.raw`
use strict;
use warnings;
use POSIX qw(setpgid);

my $report = shift @ARGV;
my $child = fork();
die "fork failed: $!\n" unless defined $child;

if ($child == 0) {
  setpgid(0, 0) or die "setpgid failed: $!\n";
  open my $fh, ">", $report or die "monitor report failed: $!\n";
  print {$fh} "$$\n" or die "monitor report write failed: $!\n";
  close $fh or die "monitor report close failed: $!\n";
  exec @ARGV;
  die "exec failed: $!\n";
}

sub group_exists {
  return kill(0, -$child) || $!{EPERM};
}

sub drain_group {
  return unless group_exists();
  kill 'TERM', -$child;
  select undef, undef, undef, 0.300;
  kill 'KILL', -$child if group_exists();
  for (1 .. 50) {
    last unless group_exists();
    select undef, undef, undef, 0.010;
  }
}

sub terminate {
  drain_group();
  waitpid($child, 0);
  exit 143;
}

$SIG{HUP} = \&terminate;
$SIG{INT} = \&terminate;
$SIG{TERM} = \&terminate;

waitpid($child, 0);
my $status = $?;
drain_group();
exit 128 + ($status & 127) if $status & 127;
exit $status >> 8;
`

async function monitorGroupId(reportPath: string, exited: Promise<number>): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const report = await readFile(reportPath, "utf8").catch(() => "")
    if (/^[1-9][0-9]*\n$/.test(report)) return Number(report)
    await Promise.race([exited.then(() => undefined), delay(10)])
  }
  const report = await readFile(reportPath, "utf8").catch(() => "")
  if (/^[1-9][0-9]*\n$/.test(report)) return Number(report)
  throw new Error("process monitor did not report its child process group")
}

async function stopMonitor(monitorPid: number, groupId: number, exited: Promise<number>): Promise<void> {
  signalMonitor(monitorPid, "SIGTERM")
  if (await within(exited, COMMAND_MONITOR_TIMEOUT_MS) !== undefined) return
  await stopOwnedGroup(groupId)
  signalMonitor(monitorPid, "SIGKILL")
  await within(exited, COMMAND_REAP_TIMEOUT_MS)
}

async function superviseCommand(argv: readonly string[], options: SupervisedCommandOptions): Promise<CommandResult> {
  if (options.signal?.aborted) throw new CommandAbortedError(argv, "", "")
  const monitorRoot = await mkdtemp(join(tmpdir(), "pane-dash-process-monitor-"))
  await chmod(monitorRoot, 0o700)
  const reportPath = join(monitorRoot, "child-pgid")
  const monitor = Bun.spawn(["/usr/bin/perl", "-e", PERL_PROCESS_MONITOR, reportPath, ...argv], { cwd: options.cwd, env: options.env, stdout: "pipe", stderr: "pipe", detached: true })
  const stdout = collectBoundedOutput(monitor.stdout)
  const stderr = collectBoundedOutput(monitor.stderr)
  let pipesClosed = false
  const pipes = Promise.all([stdout.result, stderr.result]).then(([out, err]) => {
    pipesClosed = true
    return { stdout: out, stderr: err }
  })
  let abort: (() => void) | undefined
  const aborted = new Promise<"aborted">(resolve => {
    abort = () => resolve("aborted")
    options.signal?.addEventListener("abort", abort, { once: true })
  })
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timer = new Promise<"timed-out">(resolve => { timeout = setTimeout(() => resolve("timed-out"), options.timeoutMs) })

  try {
    const groupId = await monitorGroupId(reportPath, monitor.exited)
    const outcome = await Promise.race([
      monitor.exited.then(code => ({ kind: "exited" as const, code })),
      timer.then(kind => ({ kind })),
      aborted.then(kind => ({ kind })),
    ])
    if (outcome.kind === "exited") {
      const output = await within(pipes, COMMAND_PIPE_TIMEOUT_MS)
      if (output) return { code: outcome.code, ...output }
      await Promise.all([stdout.cancel(), stderr.cancel()])
      return { code: outcome.code, stdout: "[output pipe did not close]", stderr: "[output pipe did not close]" }
    }

    await stopMonitor(monitor.pid, groupId, monitor.exited)
    const output = await within(pipes, COMMAND_PIPE_TIMEOUT_MS)
    if (!output) await Promise.all([stdout.cancel(), stderr.cancel()])
    const captured = output ?? { stdout: "[output pipe did not close]", stderr: "[output pipe did not close]" }
    if (outcome.kind === "timed-out") throw new CommandTimeoutError(argv, captured.stdout, captured.stderr)
    throw new CommandAbortedError(argv, captured.stdout, captured.stderr)
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener("abort", abort!)
    await rm(monitorRoot, { recursive: true, force: true })
  }
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
  const bootstrapTag = `pane-dash-musl-bootstrap-${suffix}`
  const runtimeTag = `pane-dash-musl-runtime-${suffix}`
  const ownedContainers: string[] = []
  const docker = (image: string, args: readonly string[]) => {
    const name = `pane-dash-musl-${suffix}-${ownedContainers.length}`
    ownedContainers.push(name)
    return dockerRun(info.platform, image, args, name)
  }
  const buildContext = await mkdtemp(join(tmpdir(), "pane-dash-musl-runtime-"))
  const dockerfile = join(sourceRoot, "scripts/release/tmux-runtime.Dockerfile")
  const bootstrapDockerfile = join(sourceRoot, "scripts/release/tmux-runtime-bootstrap.Dockerfile")
  let runtimeImageId = ""

  const cleanup = async (): Promise<unknown[]> => {
    const failures: unknown[] = []
    const record = async (operation: () => Promise<void>) => {
      try { await operation() } catch (error) { failures.push(error) }
    }
    for (const name of ownedContainers) await record(() => removeOwnedContainer(run, name))
    const containersAbsent = await containersAreAbsent(run, ownedContainers).catch(error => {
      failures.push(error)
      return false
    })
    if (containersAbsent) {
      await record(() => removeOwnedVolume(run, registryVolume, ownedContainers))
      await record(() => removeOwnedVolume(run, targetVolume, ownedContainers))
    } else {
      failures.push(new Error("refusing volume cleanup until owned containers are absent"))
    }
    await record(() => removeOwnedImage(run, runtimeTag))
    await record(() => removeOwnedImage(run, bootstrapTag))
    await record(async () => { await rm(buildContext, { recursive: true, force: true }) })
    return failures
  }

  let primaryError: unknown
  try {
    await copyFile(dockerfile, join(buildContext, "tmux-runtime.Dockerfile"))
    await copyFile(bootstrapDockerfile, join(buildContext, "tmux-runtime-bootstrap.Dockerfile"))
    const builderRepoDigest = await ensureExactImage(run, image, info.platform, input.signal)
    const runtimeImage = runtimeManifest(info.builderArch)
    await ensureExactImage(run, runtimeImage, info.platform, input.signal, true)
    await verifyBuilder(run, image, info.platform, input.target, input.signal, docker)
    await execute(run, ["docker", "volume", "create", registryVolume], input.signal, 30_000)
    await execute(run, ["docker", "volume", "create", targetVolume], input.signal, 30_000)

    // Bootstrap may fetch locked dependencies. The compile itself is separately offline.
    await execute(run, docker(image, [
      "--network", "bridge", "-v", `${sourceRoot}:/source:ro`, "-v", `${registryVolume}:/cargo`, "-v", `${targetVolume}:/target`,
      "-e", "CARGO_HOME=/cargo", "-e", "CARGO_TARGET_DIR=/target", "-w", "/source/pane-dash",
      "sh", "-ceu", "cargo fetch --locked",
    ]), input.signal, DOCKER_TIMEOUT_MS)
    await execute(run, docker(image, [
      "--network", "none", "-v", `${sourceRoot}:/source:ro`, "-v", `${registryVolume}:/cargo`, "-v", `${targetVolume}:/target`,
      "-e", "CARGO_HOME=/cargo", "-e", "CARGO_TARGET_DIR=/target", "-w", "/source/pane-dash",
      "sh", "-ceu", `cargo build --locked --offline --release --target ${input.target}`,
    ]), input.signal, DOCKER_TIMEOUT_MS)

    await execute(run, ["docker", "build", "--rm", "--force-rm", "--platform", info.platform, "--network", "default", "--build-arg", `DEBIAN_BASE=${runtimeImage}`, "-f", join(buildContext, "tmux-runtime-bootstrap.Dockerfile"), "-t", bootstrapTag, buildContext], input.signal, DOCKER_TIMEOUT_MS)
    await execute(run, docker(bootstrapTag, [
      "--network", "bridge", "-v", `${buildContext}:/build`, "sh", "-ceu",
      `curl --fail --location --silent --show-error --output /build/tmux-${TMUX_RUNTIME.tmuxVersion}.tar.gz ${shellQuote(TMUX_RUNTIME.tmuxSourceUrl)} && echo '${TMUX_RUNTIME.tmuxSha256}  /build/tmux-${TMUX_RUNTIME.tmuxVersion}.tar.gz' | sha256sum -c -`,
    ]), input.signal, DOCKER_TIMEOUT_MS)
    await execute(run, ["docker", "build", "--rm", "--force-rm", "--platform", info.platform, "--network", "none", "--build-arg", `DEBIAN_BASE=${runtimeImage}`, "--build-arg", `BOOTSTRAP_IMAGE=${bootstrapTag}`, "-f", join(buildContext, "tmux-runtime.Dockerfile"), "-t", runtimeTag, buildContext], input.signal, DOCKER_TIMEOUT_MS)
    runtimeImageId = (await execute(run, ["docker", "image", "inspect", "--format", "{{.Id}}", runtimeTag], input.signal, 30_000)).stdout.trim()
    if (!runtimeImageId) throw new Error("runtime image ID missing")

    const binary = `/work/${input.target}/release/pane-dash`
    const runtime = (command: string, timeoutMs = 30_000) => execute(run, docker(runtimeTag, [
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
      provenance: { target: input.target, platform: info.platform, builderDigest: `sha256:${RUST_ALPINE_BUILDERS[info.builderArch]}`, builderImage: image, runtimeImageId, runtimeBaseDigest: TMUX_RUNTIME.debianDigest, runtimeManifest: runtimeImage, tmuxVersion: tmuxOutput.trim(), tmuxSourceUrl: TMUX_RUNTIME.tmuxSourceUrl, tmuxSourceSha256: TMUX_RUNTIME.tmuxSha256, runtimeUname },
    }
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    const cleanupFailures = await cleanup()
    if (cleanupFailures.length > 0 && primaryError !== undefined) {
      throw new AggregateError([primaryError, ...cleanupFailures], "musl spike and Docker cleanup failed")
    } else if (cleanupFailures.length > 0) {
      throw new AggregateError(cleanupFailures, "Docker resource cleanup failed")
    }
  }
}

function dockerRun(platform: string, image: string, args: readonly string[], name: string): string[] {
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
  return ["docker", "run", "--rm", "--name", name, "--platform", platform, ...options, image, ...args.slice(cursor)]
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

async function verifyBuilder(run: CommandRunner, image: string, platform: string, target: MuslTarget, signal: AbortSignal | undefined, docker: (image: string, args: readonly string[]) => string[]): Promise<void> {
  const host = (await execute(run, docker(image, ["--network", "none", "rustc", "-vV"]), signal, 30_000)).stdout
  if (!host.includes(`host: ${target}`)) throw new Error(`Rust host expected ${target}, got ${host.trim()}`)
  const cargo = await run(docker(image, ["--network", "none", "cargo", "--version"]), { timeoutMs: 30_000, signal })
  if (cargo.code !== 0 || !/^cargo \d+\.\d+\.\d+/m.test(cargo.stdout)) throw new Error("cargo unavailable in pinned builder")
  const installed = (await execute(run, docker(image, ["--network", "none", "rustup", "target", "list", "--installed"]), signal, 30_000)).stdout
  if (!installed.split(/\r?\n/).includes(target)) throw new Error(`Rust target ${target} is not installed`)
}

async function execute(run: CommandRunner, argv: readonly string[], signal: AbortSignal | undefined, timeoutMs: number): Promise<CommandResult> {
  const result = await run(argv, { timeoutMs, signal })
  if (result.code !== 0) throw new Error(`${basename(argv[0] ?? "command")} failed (${result.code}): ${result.stderr.trim()}`)
  return result
}

async function cleanupDockerCommand(run: CommandRunner, argv: readonly string[]): Promise<CommandResult> {
  const result = await within(run(argv, { timeoutMs: DOCKER_CLEANUP_TIMEOUT_MS }), DOCKER_CLEANUP_TIMEOUT_MS)
  if (!result) throw new Error(`cleanup command exceeded ${DOCKER_CLEANUP_TIMEOUT_MS}ms: ${argv.join(" ")}`)
  return result
}

function isDockerResourceAbsent(result: CommandResult): boolean {
  return result.code !== 0 && /(?:no such (?:container|volume|image)|not found)/i.test(`${result.stdout}\n${result.stderr}`)
}

function assertDockerCleanupSucceeded(result: CommandResult, argv: readonly string[]): void {
  if (result.code !== 0 && !isDockerResourceAbsent(result)) throw new Error(`cleanup command failed (${result.code}): ${argv.join(" ")}: ${result.stderr.trim()}`)
}

async function removeOwnedContainer(run: CommandRunner, name: string): Promise<void> {
  const argv = ["docker", "rm", "-f", name]
  assertDockerCleanupSucceeded(await cleanupDockerCommand(run, argv), argv)
  if (!await containersAreAbsent(run, [name])) throw new Error(`owned container remained after cleanup: ${name}`)
}

async function containersAreAbsent(run: CommandRunner, names: readonly string[]): Promise<boolean> {
  const deadline = Date.now() + DOCKER_CLEANUP_TIMEOUT_MS
  do {
    const inspections = await Promise.all(names.map(name => cleanupDockerCommand(run, ["docker", "container", "inspect", name])))
    if (inspections.every(result => result.code !== 0)) return true
    if (Date.now() >= deadline) return false
    await delay(100)
  } while (true)
}

async function removeOwnedVolume(run: CommandRunner, name: string, ownedContainers: readonly string[]): Promise<void> {
  const argv = ["docker", "volume", "rm", "-f", name]
  const deadline = Date.now() + DOCKER_CLEANUP_TIMEOUT_MS
  do {
    const result = await cleanupDockerCommand(run, argv)
    if (result.code === 0 || isDockerResourceAbsent(result)) return
    if (!/volume is in use/i.test(`${result.stdout}\n${result.stderr}`)) {
      assertDockerCleanupSucceeded(result, argv)
      return
    }
    if (!await containersAreAbsent(run, ownedContainers)) throw new Error(`owned containers remained while removing volume: ${name}`)
    if (Date.now() >= deadline) throw new Error(`volume remained in use after owned containers were absent: ${name}`)
    await delay(100)
  } while (true)
}

async function removeOwnedImage(run: CommandRunner, tag: string): Promise<void> {
  const argv = ["docker", "image", "rm", "-f", tag]
  assertDockerCleanupSucceeded(await cleanupDockerCommand(run, argv), argv)
  const inspected = await cleanupDockerCommand(run, ["docker", "image", "inspect", tag])
  if (!isDockerResourceAbsent(inspected)) throw new Error(`owned image remained after cleanup: ${tag}`)
}

async function dockerRunner(argv: readonly string[], options: { readonly timeoutMs: number; readonly signal?: AbortSignal }): Promise<CommandResult> {
  return await superviseCommand(argv, options)
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

export async function runCli(
  args: readonly string[],
  run: CommandRunner = dockerRunner,
  writeError: (line: string) => void = console.error,
  sourceRoot = resolve(import.meta.dir, "../.."),
): Promise<0 | 1> {
  try {
  if (args[0] === "--normalize-opencode-version") {
    if (args.length !== 2 || !args[1]) {
      throw new Error("usage: bun scripts/release/spikes.ts --normalize-opencode-version <absolute-opencode-binary>")
    }
    console.log(await runOpenCodeVersion(args[1], run))
    return 0
  }
  if (args[0] === "--opencode-1.17.20") {
    const binary = args[1]
    const registryHost = args[2]?.match(/^--registry-host=(127\.0\.0\.1|::1)$/)?.[1]
    if (args.length !== 3 || !binary || (registryHost !== "127.0.0.1" && registryHost !== "::1")) {
      throw new Error("usage: bun scripts/release/spikes.ts --opencode-1.17.20 <absolute-opencode-binary> --registry-host=<127.0.0.1|::1>")
    }
    const result = await runOpenCodeSpike({ sourceRoot: resolve(import.meta.dir, "../.."), binary, registryHost })
    console.log(formatOpenCodePassSummary(result))
    console.log(JSON.stringify(result))
    return 0
  }
  const [mode, target, network] = args
  if (mode !== "--musl" || !target || network !== "--network=none" || !isMuslTarget(target)) {
    throw new Error("usage: bun scripts/release/spikes.ts --musl <aarch64-unknown-linux-musl|x86_64-unknown-linux-musl> --network=none")
  }
  const result = await runMuslSpike({ target, sourceRoot, runner: run })
  console.log(`${target} elf-static=PASS execution=PASS tmux=PASS`)
  console.log(JSON.stringify(result.provenance))
  return 0
  } catch (error) {
    writeError(renderCliError(error))
    return 1
  }
}

export function renderCliError(error: unknown): string {
  if (error instanceof AggregateError) {
    return [error.message, ...error.errors.map(renderCliError)].join("\n")
  }
  return error instanceof Error ? error.message : String(error)
}

async function main(): Promise<void> {
  process.exitCode = await runCli(Bun.argv.slice(2))
}

function isMuslTarget(value: string): value is MuslTarget {
  return value === "aarch64-unknown-linux-musl" || value === "x86_64-unknown-linux-musl"
}

if (import.meta.main) main().catch((error: unknown) => { console.error(renderCliError(error)); process.exitCode = 1 })
