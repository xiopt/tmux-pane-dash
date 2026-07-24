import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type CommandRunner,
  requiredSpikeChecks,
  runMuslSpike,
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

test("builds x86_64 only with target-derived pinned images and offline network", async () => {
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
  const runtimeBuild = fake.invocations.find(({ argv }) => argv[0] === "docker" && argv[1] === "build")
  expect(runtimeBuild?.argv).toEqual(expect.arrayContaining(["--platform", "linux/amd64", "--network", "default", "-t"]))
  expect(runtimeBuild?.argv).not.toContain("buildx")
  expect(runtimeBuild?.argv).not.toContain("--load")
  expect(runtimeBuild?.argv).toEqual(expect.arrayContaining([
    "--build-arg",
    "DEBIAN_BASE=docker.io/library/debian@sha256:63a496b5d3b99214b39f5ed70eb71a61e590a77979c79cbee4faf991f8c0783e",
  ]))
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
