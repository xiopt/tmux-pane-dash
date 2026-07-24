import { copyFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, isAbsolute, join, resolve } from "node:path"
import { DEBIAN_PLATFORM_MANIFESTS, RUST_ALPINE_BUILDERS, TMUX_RUNTIME } from "./contracts"

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
  const [mode, target, network] = Bun.argv.slice(2)
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
