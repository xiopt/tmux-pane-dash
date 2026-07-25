import { afterEach, beforeEach, expect, test } from "bun:test"
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type CommandRunner,
  CommandAbortedError,
  CommandTimeoutError,
  normalizeOpenCodeVersion,
  assertOpenCodeRegistryRequests,
  assertOpenCodeCleanupDelayState,
  assertNoOwnedTmuxProcess,
  assertIsolationObservations,
  assertExactPackageFixture,
  formatOpenCodePassSummary,
  observeOpenCodePluginSpec,
  requiredSpikeChecks,
  runCli,
  runOpenCodeVersion,
  runMuslSpike,
  seatbeltIsolationPlatform,
  tmuxWrapperScript,
  validateTmuxBinaryPath,
  localCommand,
} from "../spikes"

type Invocation = {
  readonly argv: readonly string[]
  readonly options: { readonly timeoutMs: number; readonly signal?: AbortSignal }
}

const digest = "sha256:f5c84c3751de59f0f318acfbed8b2d04693a12d9171f15835d9c11c9ddcf52db"
let root = ""

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pane-dash-spikes-test-"))
  await mkdir(join(root, "pane-dash"), { recursive: true })
  await mkdir(join(root, "scripts", "release"), { recursive: true })
  await writeFile(join(root, "pane-dash", "Cargo.toml"), "[package]\nname = 'pane-dash'\n")
  await writeFile(join(root, "scripts", "release", "tmux-runtime.Dockerfile"), "FROM scratch\n")
  await writeFile(join(root, "scripts", "release", "tmux-runtime-bootstrap.Dockerfile"), "FROM scratch\n")
})

afterEach(async () => {
  await Bun.$`rm -rf ${root}`.quiet()
})

function runner(overrides: Readonly<Record<string, string>> = {}): { runner: CommandRunner; invocations: Invocation[] } {
  const invocations: Invocation[] = []
  return {
    invocations,
    runner: async (argv, options) => {
      invocations.push({ argv, options })
      const command = argv.join(" ")
      if (command.includes("docker container inspect")) return { code: 1, stdout: "", stderr: "No such container" }
      if (argv[0] === "docker" && argv[1] === "image" && argv[2] === "inspect" && !argv.includes("--format")) return { code: 1, stdout: "", stderr: "No such image" }
      const stdout = Object.entries(overrides).find(([needle]) => command.includes(needle))?.[1] ?? defaultStdout(argv)
      return { code: 0, stdout, stderr: "" }
    },
  }
}

function defaultStdout(argv: readonly string[]): string {
  const command = argv.join(" ")
  if (command.includes("manifest inspect") && command.includes("docker.io/library/debian")) {
    return `${JSON.stringify({ config: { data: Buffer.from('{"architecture":"amd64"}').toString("base64") } })}\n`
  }
  if (command.includes("image inspect") && command.includes("{{.Os}}/{{.Architecture}}")) return "linux/amd64\n"
  if (command.includes("image inspect") && command.includes("docker.io/library/debian")) return "docker.io/library/debian@sha256:63a496b5d3b99214b39f5ed70eb71a61e590a77979c79cbee4faf991f8c0783e\n"
  if (command.includes("image inspect")) return `${digest}\n`
  if (command.includes("rustc -vV")) return "host: x86_64-unknown-linux-musl\n"
  if (command.includes("cargo --version")) return "cargo 1.96.1\n"
  if (command.includes("rustup target list --installed")) return "x86_64-unknown-linux-musl\n"
  if (command.includes("uname -m")) return "x86_64\n"
  if (command.includes("file /work/")) return "ELF 64-bit LSB pie executable, x86-64, static-pie linked\n"
  if (command.includes("readelf -l")) return "\n"
  if (command.includes("readelf -d")) return "\n"
  if (command.includes("ldd /work/")) return "\tnot a dynamic executable\n"
  if (command.includes("tmux -V")) return "tmux 3.6\n"
  if (command.includes("timeout 20")) return "pane-dash coldframe_ms=1.000\n"
  return ""
}

test("requires both musl targets before later spike consumers", () => {
  expect(requiredSpikeChecks()).toEqual([
    "aarch64-unknown-linux-musl:elf-static-execution-tmux",
    "x86_64-unknown-linux-musl:elf-static-execution-tmux",
    "opencode-1.17.20:scoped-exact-install-load-status-cleanup",
  ])
})

test("normalizes only an exact OpenCode v?semver line", () => {
  expect(normalizeOpenCodeVersion("1.17.20\n")).toBe("1.17.20")
  expect(normalizeOpenCodeVersion("v1.17.20\n")).toBe("1.17.20")
  for (const invalid of ["1.17.20", "1.17.20\r\n", "1.17.20\nextra\n", "OpenCode 1.17.20\n", "1.17\n"]) {
    expect(() => normalizeOpenCodeVersion(invalid)).toThrow("exact v?semver")
  }
})

test("reads an absolute OpenCode binary through the bounded process seam", async () => {
  const invocations: Invocation[] = []
  const run: CommandRunner = async (argv, options) => {
    invocations.push({ argv, options })
    return { code: 0, stdout: "v1.17.20\n", stderr: "" }
  }

  await expect(runOpenCodeVersion("/opt/opencode", run)).resolves.toBe("1.17.20")
  expect(invocations).toEqual([{ argv: ["/opt/opencode", "--version"], options: { timeoutMs: 5_000, signal: undefined } }])
  await expect(runOpenCodeVersion("opencode", run)).rejects.toThrow("absolute")
})

test("observes the exact scoped OpenCode plugin spec with npm-package-arg", async () => {
  await expect(observeOpenCodePluginSpec("@xiopt/pane-dash-opencode@0.1.0")).resolves.toEqual({
    name: "@xiopt/pane-dash-opencode",
    rawSpec: "0.1.0",
  })
  for (const invalid of ["pane-dash-opencode@0.1.0", "@xiopt/pane-dash-opencode", "@xiopt/pane-dash-opencode@v0.1.0", "@xiopt/pane-dash-opencode@0.1"]) {
    await expect(observeOpenCodePluginSpec(invalid)).rejects.toThrow("exact scoped package")
  }
})

test("refuses an unvalidated ambient npm-package-arg root", async () => {
  const previous = process.env.PANE_DASH_NPA_ROOT
  process.env.PANE_DASH_NPA_ROOT = "/not-a-validated-npa-root"
  try {
    await expect(observeOpenCodePluginSpec("@xiopt/pane-dash-opencode@0.1.0")).rejects.toThrow("PANE_DASH_NPA_ROOT")
  } finally {
    if (previous === undefined) delete process.env.PANE_DASH_NPA_ROOT
    else process.env.PANE_DASH_NPA_ROOT = previous
  }
})

test("fails closed when the Seatbelt parser returns malformed or noncanonical package observations", async () => {
  const parserRoot = join(root, "parser-root")
  const packageRoot = join(parserRoot, "node_modules", "npm-package-arg")
  await mkdir(packageRoot, { recursive: true })
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "npm-package-arg", version: "13.0.2" }))
  const previous = process.env.PANE_DASH_NPA_ROOT
  process.env.PANE_DASH_NPA_ROOT = parserRoot
  try {
    for (const result of ["not json", JSON.stringify({ version: "13.0.1", module: join(packageRoot, "index.js"), name: "@xiopt/pane-dash-opencode", rawSpec: "0.1.0" }), JSON.stringify({ version: "13.0.2", module: join(packageRoot, "index.js"), name: "wrong", rawSpec: "0.1.0" }), JSON.stringify({ version: "13.0.2", module: join(packageRoot, "index.js"), name: "@xiopt/pane-dash-opencode", rawSpec: "latest" })]) {
      await writeFile(join(packageRoot, "index.js"), `module.exports = () => (${JSON.stringify(result === "not json" ? {} : JSON.parse(result))});`)
      if (result === "not json") await writeFile(join(packageRoot, "index.js"), "module.exports = () => { throw new Error('malformed parser fixture') }")
      await expect(observeOpenCodePluginSpec("@xiopt/pane-dash-opencode@0.1.0")).rejects.toThrow()
    }
  } finally {
    if (previous === undefined) delete process.env.PANE_DASH_NPA_ROOT
    else process.env.PANE_DASH_NPA_ROOT = previous
  }
})

test("accepts only the local companion and scoped-plugin registry inventory", () => {
  const origin = "http://127.0.0.1:54321"
  expect(() => assertOpenCodeRegistryRequests([
    "/@opencode-ai%2fplugin",
    "/@xiopt%2fpane-dash-opencode",
    "/%40opencode-ai%2Fplugin/-/plugin-1.17.20.tgz",
    "/%40xiopt%2Fpane-dash-opencode/-/pane-dash-opencode-0.1.0.tgz",
  ], origin)).not.toThrow()
  expect(() => assertOpenCodeRegistryRequests(["/@xiopt%2fpane-dash-opencode", "/unexpected"], origin)).toThrow("unexpected local registry request")
})

test("observes a nonempty status and fresh numeric heartbeat while cleanup is blocked", () => {
  expect(() => assertOpenCodeCleanupDelayState("idle", "1784896896", 1_784_896_900)).not.toThrow()
  expect(() => assertOpenCodeCleanupDelayState("", "1784896896", 1_784_896_900)).toThrow("status")
  expect(() => assertOpenCodeCleanupDelayState("idle", "nextHeartbeat", 1_784_896_900)).toThrow("fresh")
  expect(() => assertOpenCodeCleanupDelayState("idle", "1784896800", 1_784_896_900)).toThrow("fresh")
})

test("requires the owned tmux server probe to report no process", () => {
  expect(() => assertNoOwnedTmuxProcess({ code: 1, stdout: "", stderr: "no server running" })).not.toThrow()
  expect(() => assertNoOwnedTmuxProcess({ code: 0, stdout: "opencode\n", stderr: "" })).toThrow("owned tmux process")
})

test("requires an absolute tmux binary and embeds it in the cleanup wrapper", () => {
  expect(() => validateTmuxBinaryPath(undefined)).toThrow("TMUX_BIN required")
  expect(() => validateTmuxBinaryPath("tmux")).toThrow("absolute")
  const wrapper = tmuxWrapperScript("/opt/homebrew/bin/tmux", "pd-12345678", "/tmp/calls", "/tmp/done", "/tmp/cleanup-entered")
  expect(wrapper).toContain("exec '/opt/homebrew/bin/tmux' -L 'pd-12345678'")
  expect(wrapper).toContain('"-L pd-12345678 $*" >> \'/tmp/calls\'')
  expect(wrapper).toContain("/tmp/calls")
  expect(wrapper).toContain("[ -f '/tmp/done' ]")
  expect(wrapper).toContain('[ "$#" -eq 5 ] && [ "$1" = set-option ] && [ "$2" = -pu ]')
  expect(wrapper).toContain('[ "$4" = "$TMUX_PANE" ]')
})

test("requires the exact normative OpenCode fixture metadata and tarball inventory", () => {
  const packageJson = {
    name: "@xiopt/pane-dash-opencode",
    version: "0.1.0",
    type: "module",
    main: "./dist/index.js",
    engines: { opencode: ">=1.17.20" },
    exports: { ".": "./dist/index.js", "./server": "./dist/index.js" },
    files: ["dist/index.js", "README.md", "LICENSE"],
  }
  const inventory = ["package/package.json", "package/README.md", "package/LICENSE", "package/dist/index.js"]
  expect(() => assertExactPackageFixture(packageJson, inventory, "opencode")).not.toThrow()
  for (const [field, value] of Object.entries({
    main: "./index.js",
    engines: { node: ">=20" },
    exports: { ".": "./dist/index.js" },
    type: "commonjs",
    files: ["dist"],
    dependencies: { "left-pad": "1.3.0" },
    scripts: { test: "true" },
  })) {
    expect(() => assertExactPackageFixture({ ...packageJson, [field]: value }, inventory, "opencode")).toThrow()
  }
  for (const inventoryMutation of [
    inventory.filter(path => path !== "package/LICENSE"),
    [...inventory, "package/src/pane-dash.ts"],
    [...inventory, "package/dist/index.js.map"],
  ]) expect(() => assertExactPackageFixture(packageJson, inventoryMutation, "opencode")).toThrow()
})

test("only an exact cleanup call for the observed pane enters the wrapper cleanup gate", async () => {
  const calls = join(root, "calls")
  const permit = join(root, "permit")
  const entered = join(root, "entered")
  const fakeTmux = join(root, "tmux")
  const wrapper = join(root, "wrapper")
  await writeFile(fakeTmux, "#!/bin/sh\nexit 0\n")
  await chmod(fakeTmux, 0o700)
  await writeFile(wrapper, tmuxWrapperScript(fakeTmux, "pd-12345678", calls, permit, entered))
  await chmod(wrapper, 0o700)

  const environment = { ...process.env, TMUX_PANE: "%42" }
  const generic = Bun.spawn([wrapper, "set-option", "-pt", "%42", "@pane_dash_status", "idle"], { stdout: "pipe", stderr: "pipe", env: environment })
  expect(await generic.exited).toBe(0)
  expect(await Bun.file(entered).exists()).toBe(false)

  const cleanup = Bun.spawn([wrapper, "set-option", "-pu", "-t", "%42", "@pane_dash_heartbeat"], { stdout: "pipe", stderr: "pipe", env: environment })
  for (let attempt = 0; attempt < 20 && !(await Bun.file(entered).exists()); attempt++) await Bun.sleep(10)
  expect(await Bun.file(entered).exists()).toBe(true)
  await expect(Promise.race([cleanup.exited, Bun.sleep(25).then(() => "waiting")])).resolves.toBe("waiting")
  await writeFile(permit, "continue\n")
  expect(await cleanup.exited).toBe(0)
})

test("uses a Darwin isolation platform through its runner seam and fails closed elsewhere", async () => {
  const invocations: Invocation[] = []
  const platform = seatbeltIsolationPlatform("darwin", async (argv, options) => {
    invocations.push({ argv, options })
    return { code: 0, stdout: "", stderr: "" }
  })
  const result = await platform.run(["/bin/true"], "/tmp/profile", 500)

  expect(result.code).toBe(0)
  expect(invocations).toEqual([{ argv: ["/usr/bin/sandbox-exec", "-f", "/tmp/profile", "/bin/true"], options: { timeoutMs: 500, signal: undefined } }])
  await expect(seatbeltIsolationPlatform("linux", async () => ({ code: 0, stdout: "", stderr: "" })).run(["/bin/true"], "/tmp/profile", 500)).rejects.toThrow("unavailable")
})

test("refuses to summarize unasserted or mutated isolation observations", () => {
  const isolation = {
    platform: "darwin" as const,
    policySha256: "a".repeat(64),
    nonLoopbackConnect: "denied-by-policy" as const,
    nonLoopbackConnectErrno: "EPERM" as const,
    loopbackRegistryConnect: "succeeded" as const,
    allowedSyntheticWrite: "succeeded" as const,
    forbiddenWrite: "denied-by-policy" as const,
    publicNetworkRequests: 0 as const,
    realHomeWrites: 0 as const,
    defaultTmuxUses: 0 as const,
  }
  expect(() => assertIsolationObservations(isolation)).not.toThrow()
  const summary = formatOpenCodePassSummary({ version: "1.17.20", sha256: "b".repeat(64), name: "@xiopt/pane-dash-opencode", rawSpec: "0.1.0", requests: [], isolation })
  expect(summary).toContain("public-network-requests=0")
  expect(summary).toContain("non-loopback-connect-errno=EPERM")
  for (const key of ["platform", "policySha256", "nonLoopbackConnect", "nonLoopbackConnectErrno", "loopbackRegistryConnect", "allowedSyntheticWrite", "forbiddenWrite", "publicNetworkRequests", "realHomeWrites", "defaultTmuxUses"] as const) {
    const mutated = {
      ...isolation,
      [key]: key === "platform" ? "linux" : key === "policySha256" ? "invalid" : key === "nonLoopbackConnectErrno" ? "ECONNREFUSED" : key.endsWith("Requests") || key.endsWith("Writes") || key === "defaultTmuxUses" ? 1 : "failed",
    }
    expect(() => formatOpenCodePassSummary({ version: "1.17.20", sha256: "b".repeat(64), name: "@xiopt/pane-dash-opencode", rawSpec: "0.1.0", requests: [], isolation: mutated as typeof isolation })).toThrow()
  }
})

test("classifies only Seatbelt permission errors as non-loopback policy denials", async () => {
  const module = await import("../spikes") as Record<string, unknown>
  const classify = module.classifySeatbeltNetworkDenial
  if (typeof classify !== "function") {
    expect(typeof classify).toBe("function")
    return
  }
  for (const error of [
    { code: "EPERM" },
    { code: "EACCES" },
    { message: "Operation not permitted" },
    { message: "Permission denied" },
  ]) {
    expect(classify(error)).toEqual({ outcome: "denied-by-policy", errno: error.code === "EACCES" || error.message === "Permission denied" ? "EACCES" : "EPERM" })
  }
  for (const code of ["ECONNREFUSED", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH"]) {
    expect(classify({ code })).toEqual({ outcome: `unexpected:${code}` })
  }
})

test("uses the kernel nc boundary for loopback and exact Seatbelt network denials", async () => {
  const module = await import("../spikes") as Record<string, unknown>
  const runCanary = module.runNetworkIsolationCanary
  if (typeof runCanary !== "function") {
    expect(typeof runCanary).toBe("function")
    return
  }
  const invocations: Invocation[] = []
  const platform = {
    platform: "darwin" as const,
    run: async (argv: readonly string[], _profile: string, timeoutMs: number) => {
      invocations.push({ argv, options: { timeoutMs } })
      return argv[2]?.includes("exec /usr/bin/nc -v -z -w 1 '127.0.0.1' '54321'")
        ? { code: 0, stdout: "", stderr: "" }
        : { code: 1, stdout: "", stderr: "nc: connectx to 1.1.1.1 port 443 (tcp) failed: Operation not permitted\n" }
    },
  }

  await expect(runCanary(platform, "/tmp/profile", "127.0.0.1", "54321")).resolves.toEqual({ outcome: "succeeded" })
  await expect(runCanary(platform, "/tmp/profile", "1.1.1.1", "443")).resolves.toEqual({ outcome: "denied-by-policy", errno: "EPERM" })
  expect(invocations).toEqual([
    { argv: ["/bin/sh", "-ceu", expect.stringMatching(/^exec \/usr\/bin\/nc -v -z -w 1 '127\.0\.0\.1' '54321' 2>'/)], options: { timeoutMs: 5_000 } },
    { argv: ["/bin/sh", "-ceu", expect.stringMatching(/^exec \/usr\/bin\/nc -v -z -w 1 '1\.1\.1\.1' '443' 2>'/)], options: { timeoutMs: 5_000 } },
  ])
  const unexpectedPlatform = { ...platform, run: async () => ({ code: 1, stdout: "", stderr: "nc: connectx to 1.1.1.1 port 443 (tcp) failed: Connection refused\n" }) }
  await expect(runCanary(unexpectedPlatform, "/tmp/profile", "1.1.1.1", "443")).resolves.toEqual({ outcome: "unexpected:nc: connectx to 1.1.1.1 port 443 (tcp) failed: Connection refused" })
})

test("redacts the pinned OpenCode binary location from partial Task 1 evidence", async () => {
  const evidence = await Bun.file(new URL("../../../spike/results/v0.1-task1-opencode.md", import.meta.url)).text()
  expect(evidence).toContain("path=<pinned-opencode-1.17.20>")
  expect(evidence).not.toMatch(/\/Users\/|\.opencode\/bin/)
})

test("normalizes an OpenCode binary version through the CLI", async () => {
  const binary = join(root, "opencode")
  await writeFile(binary, "#!/bin/sh\nprintf 'v1.17.20\\n'\n")
  await chmod(binary, 0o700)
  const child = Bun.spawn([process.execPath, join(process.cwd(), "scripts/release/spikes.ts"), "--normalize-opencode-version", binary], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  expect(code).toBe(0)
  expect(stdout).toBe("1.17.20\n")
  expect(stderr).toBe("")
})

test("bounds a TERM-ignoring local process group whose descendant holds both pipes open", async () => {
  const pids = join(root, "pids")
  const script = [
    "trap '' TERM",
    "echo \"$$\" > \"$1\"",
    "( trap '' TERM; while :; do printf x >&1; printf y >&2; done ) &",
    "echo \"$!\" >> \"$1\"",
    "while :; do sleep 1; done",
  ].join("\n")
  const started = performance.now()

  try {
    const error = await localCommand(["/bin/sh", "-ceu", script, "sh", pids], 100).catch(error => error)
    expect(error).toBeInstanceOf(CommandTimeoutError)
    expect((error as CommandTimeoutError).stdout.length).toBeLessThanOrEqual(1_000_100)
    expect((error as CommandTimeoutError).stderr.length).toBeLessThanOrEqual(1_000_100)
    expect(performance.now() - started).toBeLessThan(1_500)
    const [leader, descendant] = (await readFile(pids, "utf8")).trim().split("\n")
    await expect(localCommand(["/bin/kill", "-0", leader!], 500, undefined, true)).resolves.toMatchObject({ code: 1 })
    await expect(localCommand(["/bin/kill", "-0", descendant!], 500, undefined, true)).resolves.toMatchObject({ code: 1 })
  } finally {
    const pidsText = await readFile(pids, "utf8").catch(() => "")
    for (const pid of pidsText.trim().split("\n")) if (pid) Bun.spawnSync(["/bin/kill", "-KILL", pid])
  }
})

test("aborts a TERM-ignoring local process group and reaps its pipe holder", async () => {
  const pids = join(root, "abort-pids")
  const controller = new AbortController()
  const script = "trap '' TERM\necho \"$$\" > \"$1\"\n( trap '' TERM; while :; do printf x; printf y >&2; sleep 0.01; done ) &\necho \"$!\" >> \"$1\"\nwhile :; do sleep 1; done"
  const command = localCommand(["/bin/sh", "-ceu", script, "sh", pids], 5_000, undefined, false, process.env, controller.signal)
  try {
    for (let attempt = 0; attempt < 20 && !(await Bun.file(pids).exists()); attempt++) await Bun.sleep(10)
    controller.abort()
    await expect(command).rejects.toBeInstanceOf(CommandAbortedError)
    const [leader, descendant] = (await readFile(pids, "utf8")).trim().split("\n")
    await expect(localCommand(["/bin/kill", "-0", leader!], 500, undefined, true)).resolves.toMatchObject({ code: 1 })
    await expect(localCommand(["/bin/kill", "-0", descendant!], 500, undefined, true)).resolves.toMatchObject({ code: 1 })
  } finally {
    controller.abort()
    const pidsText = await readFile(pids, "utf8").catch(() => "")
    for (const pid of pidsText.trim().split("\n")) if (pid) Bun.spawnSync(["/bin/kill", "-KILL", pid])
    await command.catch(() => undefined)
  }
})

test("cleans a descendant pipe holder after its leader exits successfully", async () => {
  const pids = join(root, "fast-pids")
  const script = "echo \"$$\" > \"$1\"\n( trap '' TERM; while :; do printf x; printf y >&2; sleep 0.01; done ) &\necho \"$!\" >> \"$1\"\nexit 0"
  const started = performance.now()
  try {
    await expect(localCommand(["/bin/sh", "-ceu", script, "sh", pids], 5_000)).resolves.toMatchObject({ code: 0 })
    expect(performance.now() - started).toBeLessThan(1_500)
    const [, descendant] = (await readFile(pids, "utf8")).trim().split("\n")
    await expect(localCommand(["/bin/kill", "-0", descendant!], 500, undefined, true)).resolves.toMatchObject({ code: 1 })
  } finally {
    const pidsText = await readFile(pids, "utf8").catch(() => "")
    for (const pid of pidsText.trim().split("\n")) if (pid) Bun.spawnSync(["/bin/kill", "-KILL", pid])
  }
})

test("waits for a closed-pipe TERM-ignoring descendant before reporting its leader's successful exit", async () => {
  const pids = join(root, "closed-pipe-pids")
  const barrier = join(root, "leader-exited")
  const script = [
    "echo \"$$\" > \"$1\"",
    "( trap '' TERM; exec >/dev/null 2>&1; while :; do sleep 1; done ) &",
    "echo \"$!\" >> \"$1\"",
    "touch \"$2\"",
    "exit 0",
  ].join("\n")
  const started = performance.now()
  let unrelated: ReturnType<typeof Bun.spawn> | undefined
  try {
    const command = localCommand(["/bin/sh", "-ceu", script, "sh", pids, barrier], 5_000)
    for (let attempt = 0; attempt < 50 && !(await Bun.file(barrier).exists()); attempt++) await Bun.sleep(10)
    expect(await Bun.file(barrier).exists()).toBe(true)
    unrelated = Bun.spawn(["/bin/sh", "-ceu", "sleep 2"], { stdout: "ignore", stderr: "ignore" })
    await expect(command).resolves.toMatchObject({ code: 0, stdout: "", stderr: "" })
    expect(performance.now() - started).toBeLessThan(1_500)
    const [, descendant] = (await readFile(pids, "utf8")).trim().split("\n")
    await expect(localCommand(["/bin/kill", "-0", descendant!], 500, undefined, true)).resolves.toMatchObject({ code: 1 })
    expect(await Promise.race([unrelated.exited, Bun.sleep(25).then(() => "running")])).toBe("running")
    unrelated.kill("SIGKILL")
    await unrelated.exited
    unrelated = undefined
  } finally {
    if (unrelated) {
      unrelated.kill("SIGKILL")
      await unrelated.exited
    }
    const pidsText = await readFile(pids, "utf8").catch(() => "")
    for (const pid of pidsText.trim().split("\n")) if (pid) Bun.spawnSync(["/bin/kill", "-KILL", pid])
  }
})

test("preserves normal no-descendant command status and output", async () => {
  await expect(localCommand(["/bin/sh", "-ceu", "printf out; printf err >&2; exit 7"], 5_000, undefined, true)).resolves.toEqual({
    code: 7,
    stdout: "out",
    stderr: "err",
  })
})

test("does not let allowFailure convert a local timeout into success", async () => {
  await expect(localCommand(["/bin/sh", "-ceu", "trap '' TERM; while :; do sleep 1; done"], 50, undefined, true)).rejects.toBeInstanceOf(CommandTimeoutError)
})

test("force-removes every named Docker container after compile, build, or runtime timeout", async () => {
  for (const needle of ["cargo build --locked --offline", "docker build", "timeout 20"] as const) {
    const fake = runner()
    const timeout: CommandRunner = async (argv, options) => {
      if (argv.join(" ").includes(needle)) throw new Error(`timed out ${needle}`)
      return fake.runner(argv, options)
    }
    await expect(runMuslSpike({ target: "x86_64-unknown-linux-musl", sourceRoot: root, runner: timeout })).rejects.toThrow("timed out")
    const names = fake.invocations
      .filter(({ argv }) => argv[0] === "docker" && argv[1] === "run")
      .map(({ argv }) => argv[argv.indexOf("--name") + 1])
    const removed = fake.invocations
      .filter(({ argv }) => argv[0] === "docker" && argv[1] === "rm" && argv[2] === "-f")
      .map(({ argv }) => argv[3])
    expect(removed).toEqual(expect.arrayContaining(names))
    expect(fake.invocations.some(({ argv }) => argv[0] === "docker" && argv[1] === "image" && argv[2] === "rm" && argv[3] === "-f")).toBe(true)
  }
})

test("removes owned Docker resources in dependency order when volumes reject live containers", async () => {
  const invocations: Invocation[] = []
  const liveContainers = new Set<string>()
  const volumeAttempts = new Map<string, number>()
  const stateful: CommandRunner = async (argv, options) => {
    invocations.push({ argv, options })
    const command = argv.join(" ")
    if (argv[0] === "docker" && argv[1] === "image" && argv[2] === "inspect" && !argv.includes("--format")) return { code: 1, stdout: "", stderr: "No such image" }
    if (argv[0] === "docker" && argv[1] === "run") liveContainers.add(argv[argv.indexOf("--name") + 1]!)
    if (argv[0] === "docker" && argv[1] === "rm") {
      await Bun.sleep(10)
      liveContainers.delete(argv[3]!)
      return { code: 0, stdout: "", stderr: "" }
    }
    if (argv[0] === "docker" && argv[1] === "container" && argv[2] === "inspect") {
      return { code: liveContainers.has(argv[3]!) ? 0 : 1, stdout: "", stderr: "No such container" }
    }
    if (argv[0] === "docker" && argv[1] === "volume" && argv[2] === "rm") {
      const attempts = (volumeAttempts.get(argv[4]!) ?? 0) + 1
      volumeAttempts.set(argv[4]!, attempts)
      if (liveContainers.size > 0 || attempts === 1) return { code: 1, stdout: "", stderr: "volume is in use" }
      return { code: 0, stdout: "", stderr: "" }
    }
    return { code: 0, stdout: defaultStdout(argv), stderr: "" }
  }

  await expect(runMuslSpike({ target: "x86_64-unknown-linux-musl", sourceRoot: root, runner: stateful })).resolves.toMatchObject({
    provenance: { platform: "linux/amd64" },
  })
  const firstVolumeRemoval = invocations.findIndex(({ argv }) => argv[0] === "docker" && argv[1] === "volume" && argv[2] === "rm")
  const lastContainerRemoval = invocations.reduce((latest, { argv }, index) => argv[0] === "docker" && argv[1] === "rm" ? index : latest, -1)
  expect(lastContainerRemoval).toBeGreaterThan(-1)
  expect(firstVolumeRemoval).toBeGreaterThan(lastContainerRemoval)
  expect(invocations.slice(lastContainerRemoval + 1, firstVolumeRemoval).some(({ argv }) => argv[0] === "docker" && argv[1] === "container" && argv[2] === "inspect")).toBe(true)
  expect(invocations.filter(({ argv }) => argv[0] === "docker" && argv[1] === "image" && argv[2] === "rm").pop()?.argv[3]).toBe("-f")
})

test("builds x86_64 only with target-derived pinned images and offline compilation", async () => {
  const fake = runner()

  const result = await runMuslSpike({
    target: "x86_64-unknown-linux-musl",
    sourceRoot: root,
    runner: fake.runner,
  })

  expect(result.provenance.platform).toBe("linux/amd64")
  expect(result.provenance.builderDigest).toBe(digest)
  expect(result.fileOutput).toContain("x86-64")
  expect(result.executionOutput).toContain("coldframe_ms")
  expect(result.tmuxOutput).toContain("tmux 3.6")
  expect(fake.invocations.some(({ argv }) => argv.includes("--network") && argv.includes("none") && argv.includes("linux/amd64"))).toBe(true)
  expect(fake.invocations.some(({ argv }) => argv.join(" ").includes("cargo build --locked --offline --release --target x86_64-unknown-linux-musl"))).toBe(true)
  expect(fake.invocations.some(({ argv }) => argv.includes(`${root}:/source:ro`))).toBe(true)
  const dockerBuilds = fake.invocations.filter(({ argv }) => argv[0] === "docker" && argv[1] === "build")
  const bootstrapBuild = dockerBuilds.find(({ argv }) => argv.some(part => part.endsWith("tmux-runtime-bootstrap.Dockerfile")))
  const runtimeBuild = dockerBuilds.find(({ argv }) => argv.some(part => part.endsWith("tmux-runtime.Dockerfile")))
  expect(bootstrapBuild?.argv).toEqual(expect.arrayContaining(["--platform", "linux/amd64", "--network", "default", "--rm", "--force-rm", "-t"]))
  expect(runtimeBuild?.argv).toEqual(expect.arrayContaining(["--platform", "linux/amd64", "--network", "none", "--rm", "--force-rm", "-t"]))
  expect(runtimeBuild?.argv).not.toContain("buildx")
  expect(runtimeBuild?.argv).not.toContain("--load")
  expect(runtimeBuild?.argv).toEqual(expect.arrayContaining([
    "--build-arg",
    "DEBIAN_BASE=docker.io/library/debian@sha256:63a496b5d3b99214b39f5ed70eb71a61e590a77979c79cbee4faf991f8c0783e",
  ]))
  expect(runtimeBuild?.argv.some(part => part.startsWith("BOOTSTRAP_IMAGE=pane-dash-musl-bootstrap-"))).toBe(true)
  const fetch = fake.invocations.find(({ argv }) => argv[0] === "docker" && argv[1] === "run" && argv.join(" ").includes("tmux-3.6.tar.gz"))
  expect(fetch?.argv).toEqual(expect.arrayContaining(["--network", "bridge"]))
  expect(fetch?.argv?.join(" ")).toContain("136db80cfbfba617a103401f52874e7c64927986b65b1b700350b6058ad69607")
  expect(dockerBuilds.filter(({ argv }) => !argv.some(part => part.endsWith("tmux-runtime-bootstrap.Dockerfile"))).every(({ argv }) => argv.includes("--network") && argv.includes("none"))).toBe(true)
  expect(result.provenance.runtimeBaseDigest).toBe("7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818")
  expect(fake.invocations.some(({ argv }) => argv.join(" ").includes("docker manifest inspect docker.io/library/debian@sha256:63a496b5d3b99214b39f5ed70eb71a61e590a77979c79cbee4faf991f8c0783e"))).toBe(true)
  expect(fake.invocations.some(({ argv }) => argv.join(" ").includes("image inspect --format {{.Os}}/{{.Architecture}}"))).toBe(true)
  const runtimeUname = fake.invocations.find(({ argv }) => argv.includes("uname -m"))
  expect(runtimeUname?.argv).toEqual(expect.arrayContaining(["--entrypoint", "/bin/sh"]))
  expect(runtimeUname?.argv).not.toContain("sh")
  const smoke = fake.invocations.find(({ argv }) => argv.some((part) => part.includes("timeout 20")))?.argv.join(" ")
  expect(smoke).toContain("TERM=xterm script")
  expect(smoke).toContain("TERM=xterm timeout 20 script")
  expect(smoke).toContain('bench="$(mktemp)"')
  expect(smoke).toContain('cat "$bench"')
  expect(smoke).toContain('$pane_id 2>&1"')
  expect(smoke).toContain('exec /usr/local/bin/tmux -L %s "$@"')
  expect(fake.invocations.some(({ argv }) => argv.some((part) => part.includes("/Users/") && part.includes(".cargo")))).toBe(false)
  expect(fake.invocations.some(({ argv }) => argv.join(" ").includes("volume rm"))).toBe(true)
  expect(fake.invocations.some(({ argv }) => argv.join(" ").includes("image rm"))).toBe(true)
  const dockerRuns = fake.invocations.filter(({ argv }) => argv[0] === "docker" && argv[1] === "run")
  expect(dockerRuns.length).toBeGreaterThan(0)
  expect(dockerRuns.every(({ argv }) => argv.includes("--name") && argv[argv.indexOf("--name") + 1]?.startsWith("pane-dash-musl-"))).toBe(true)
  expect(fake.invocations.filter(({ argv }) => argv[0] === "docker" && argv[1] === "rm" && argv.includes("-f")).length).toBe(dockerRuns.length)
})

test("renders primary and ordered Docker cleanup failures through the CLI seam", async () => {
  const fake = runner()
  const failing: CommandRunner = async (argv, options) => {
    const command = argv.join(" ")
    if (command.includes("cargo build --locked --offline")) return { code: 17, stdout: "", stderr: "primary compile failure" }
    if (argv[0] === "docker" && argv[1] === "rm") return { code: 18, stdout: "", stderr: "cleanup container failure" }
    if (argv[0] === "docker" && argv[1] === "volume" && argv[2] === "rm") return { code: 19, stdout: "", stderr: "cleanup volume failure" }
    if (argv[0] === "docker" && argv[1] === "image" && argv[2] === "rm") {
      return { code: 20, stdout: "", stderr: command.includes("bootstrap") ? "cleanup bootstrap image failure" : "cleanup runtime image failure" }
    }
    return fake.runner(argv, options)
  }
  const stderr: string[] = []

  const status = await runCli(["--musl", "x86_64-unknown-linux-musl", "--network=none"], failing, line => stderr.push(line), root)

  expect(status).toBe(1)
  const output = stderr.join("\n")
  for (const detail of ["primary compile failure", "cleanup container failure", "cleanup volume failure", "cleanup runtime image failure", "cleanup bootstrap image failure"]) expect(output).toContain(detail)
  expect(output.indexOf("primary compile failure")).toBeLessThan(output.indexOf("cleanup container failure"))
  expect(output.indexOf("cleanup container failure")).toBeLessThan(output.indexOf("cleanup volume failure"))
  expect(output.indexOf("cleanup volume failure")).toBeLessThan(output.indexOf("cleanup runtime image failure"))
  expect(output.indexOf("cleanup runtime image failure")).toBeLessThan(output.indexOf("cleanup bootstrap image failure"))
})

test("rejects a builder RepoDigest that differs from the target pin and still cleans owned resources", async () => {
  const fake = runner({ "docker image inspect --format {{index .RepoDigests 0}} rust:1.96.1-alpine@sha256:f5c84c3751de59f0f318acfbed8b2d04693a12d9171f15835d9c11c9ddcf52db": "sha256:wrong\n" })

  await expect(runMuslSpike({ target: "x86_64-unknown-linux-musl", sourceRoot: root, runner: fake.runner }))
    .rejects.toThrow("builder RepoDigest")
  expect(fake.invocations.some(({ argv }) => argv.join(" ").includes("volume rm"))).toBe(true)
})

test("uses distinct Debian platform manifests when the index digest aliases a cached other architecture", async () => {
  const normal = runner()
  const collision: CommandRunner = async (argv, options) => {
    if (argv.join(" ").includes("docker.io/library/debian") && argv.join(" ").includes("{{.Os}}/{{.Architecture}}")) {
      return { code: 0, stdout: "linux/arm64\n", stderr: "" }
    }
    return normal.runner(argv, options)
  }
  await expect(runMuslSpike({ target: "x86_64-unknown-linux-musl", sourceRoot: root, runner: collision })).rejects.toThrow("image platform")
  expect(normal.invocations.some(({ argv }) => argv.join(" ").includes("docker pull --platform linux/amd64 docker.io/library/debian@sha256:63a496b5d3b99214b39f5ed70eb71a61e590a77979c79cbee4faf991f8c0783e"))).toBe(true)
})

test("rejects a wrong Rust host triple or an absent musl target", async () => {
  const host = runner({ "rustc -vV": "host: x86_64-unknown-linux-gnu\n" })
  await expect(runMuslSpike({ target: "x86_64-unknown-linux-musl", sourceRoot: root, runner: host.runner })).rejects.toThrow("Rust host")

  const cargo = runner({ "rustup target list --installed": "" })
  await expect(runMuslSpike({ target: "x86_64-unknown-linux-musl", sourceRoot: root, runner: cargo.runner })).rejects.toThrow("Rust target")
})

test("rejects a builder without cargo before bootstrap", async () => {
  const missingCargo: CommandRunner = async (argv, options) => {
    if (argv.join(" ").includes("cargo --version")) return { code: 127, stdout: "", stderr: "cargo: not found" }
    return runner().runner(argv, options)
  }
  await expect(runMuslSpike({ target: "x86_64-unknown-linux-musl", sourceRoot: root, runner: missingCargo })).rejects.toThrow("cargo unavailable")
})

test("rejects dynamic, wrong-architecture, or non-musl runtime outputs", async () => {
  for (const [needle, output, error] of [
    ["readelf -l", "  INTERP         0x000000\n", "PT_INTERP"],
    ["readelf -d", " 0x0000000000000001 (NEEDED) Shared library: [libc.so.6]\n", "NEEDED"],
    ["file /work/", "ELF 64-bit LSB executable, ARM aarch64\n", "ELF architecture"],
    ["ldd /work/", "\tlibc.so.6 => /lib/libc.so.6\n", "ldd"],
  ] as const) {
    const fake = runner({ [needle]: output })
    await expect(runMuslSpike({ target: "x86_64-unknown-linux-musl", sourceRoot: root, runner: fake.runner })).rejects.toThrow(error)
  }
})

test("accepts ldd's static diagnostic when it is written to stderr", async () => {
  const staticLdd: CommandRunner = async (argv, options) => {
    if (argv.join(" ").includes("ldd /work/")) return { code: 0, stdout: "", stderr: "\tnot a dynamic executable\n" }
    return runner().runner(argv, options)
  }
  await expect(runMuslSpike({ target: "x86_64-unknown-linux-musl", sourceRoot: root, runner: staticLdd })).resolves.toMatchObject({
    fileOutput: expect.stringContaining("x86-64"),
  })
})

test("rejects a runtime platform, tmux version, or bounded smoke timeout", async () => {
  const arch = runner({ "uname -m": "aarch64\n" })
  await expect(runMuslSpike({ target: "x86_64-unknown-linux-musl", sourceRoot: root, runner: arch.runner })).rejects.toThrow("runtime uname")

  const tmux = runner({ "tmux -V": "tmux 3.5\n" })
  await expect(runMuslSpike({ target: "x86_64-unknown-linux-musl", sourceRoot: root, runner: tmux.runner })).rejects.toThrow("tmux 3.6")

  const timeout: CommandRunner = async (argv, options) => {
    if (argv.join(" ").includes("timeout 20")) throw new Error(`timed out after ${options.timeoutMs}ms`)
    return runner().runner(argv, options)
  }
  await expect(runMuslSpike({ target: "x86_64-unknown-linux-musl", sourceRoot: root, runner: timeout })).rejects.toThrow("timed out")
})
