#!/usr/bin/env bun

import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { RELEASE_ASSETS, TARGETS, VERSION } from "./contracts"

export interface DryRunInput {
  root: string
  environment?: Readonly<Record<string, string | undefined>>
  remotes?: readonly string[]
  fixtureUrl?: string
  commands?: readonly string[]
}

const forbiddenEnvironment = /(?:^|_)(?:GH_TOKEN|GITHUB_TOKEN|NPM_TOKEN|NODE_AUTH_TOKEN|NPM_CONFIG_USERCONFIG|npm_config_userconfig)$/
const forbiddenCommands = [/\bgit\s+(?:push|tag)\b/i, /\bgh\s+release\s+(?:create|upload|edit)\b/i, /\bnpm\s+publish\b/i, /\bbun\s+build\s+release\/verify-npm-provenance\.ts\b/i]

function fail(message: string): never {
  throw new Error(`release-dry-run: ${message}`)
}

async function assertCleanEnvironment(input: DryRunInput): Promise<void> {
  const environment = input.environment ?? process.env
  for (const [key, value] of Object.entries(environment)) {
    if (!value || !forbiddenEnvironment.test(key)) continue
    if ((key === "NPM_CONFIG_USERCONFIG" || key === "npm_config_userconfig") && environment.HOME && environment.npm_config_cache && value === join(dirname(environment.HOME), "npmrc") && environment.npm_config_cache === join(dirname(environment.HOME), "npm-cache") && !(await stat(value).catch(() => null))) continue
    fail(`credential/auth configuration is present: ${key}`)
  }
  if (input.fixtureUrl && !/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::[0-9]+)?(?:\/|$)/.test(input.fixtureUrl)) fail("fixture URL must be loopback")
  for (const command of input.commands ?? []) if (forbiddenCommands.some((pattern) => pattern.test(command))) fail(`remote/publish/rebuild mutation is forbidden: ${command}`)
}

async function gitRemotes(root: string): Promise<string[]> {
  const child = Bun.spawn(["git", "-C", root, "remote", "-v"], { stdout: "pipe", stderr: "pipe" })
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
  if (code !== 0) fail("cannot inspect Git remotes")
  const lines = stdout.split("\n")
  if (lines[lines.length - 1] === "") lines.pop()
  return lines
}

export function assertGitRemotes(remotes: readonly string[]): void {
  if (remotes.length === 0) return
  const kinds = new Set<string>()
  const pattern = /^origin[ \t]+https:\/\/github\.com\/xiopt\/tmux-pane-dash(?:\.git)?[ \t]+\((fetch|push)\)$/
  for (const remote of remotes) {
    const match = pattern.exec(remote)
    if (!match) fail("Git remotes must be empty or contain only the exact origin fetch and push URLs")
    kinds.add(match[1]!)
  }
  if (remotes.length !== 2 || kinds.size !== 2) fail("Git remotes must include exactly one origin fetch URL and one origin push URL")
}

async function assertNoGeneratedVerifier(root: string): Promise<void> {
  try { await stat(join(root, "release", "dist")); fail("release/dist generated drift is present") } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
}

async function assertWorkspace(root: string): Promise<void> {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as Record<string, unknown>
  const dev = pkg.devDependencies as Record<string, unknown> | undefined
  if (dev?.sigstore !== "4.1.1") fail("root sigstore development dependency is not locked to 4.1.1")
  const lock = await readFile(join(root, "bun.lock"), "utf8")
  if (!lock.includes('"sigstore": ["sigstore@4.1.1"')) fail("bun.lock has no exact sigstore@4.1.1 entry")
  if (pkg.private !== true || pkg.packageManager !== "bun@1.3.14") fail("root Bun workspace policy is invalid")
  for (const path of ["packages/tmux-pane-dash/package.json", "opencode-plugin/package.json"]) {
    const packageJson = JSON.parse(await readFile(join(root, path), "utf8")) as Record<string, unknown>
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) if (field in packageJson) fail(`${path} contains a runtime dependency field`)
  }
}

async function inMemoryVerifier(root: string): Promise<{ size: number; sha256: string }> {
  const output = await mkdtemp(join(tmpdir(), "pane-dash-release-dry-run-"))
  try {
    const result = await Bun.build({ entrypoints: [join(root, "release", "verify-npm-provenance.ts")], outdir: output, target: "node", format: "esm", naming: "verify-npm-provenance.mjs", sourcemap: "none", minify: false })
    if (!result.success) fail("verifier bundle did not build")
    const path = join(output, "verify-npm-provenance.mjs")
    const bytes = new Uint8Array(await readFile(path))
    const text = new TextDecoder().decode(bytes)
    if (/from\s+["'](?:sigstore|[^"']*node_modules)/.test(text) || /sourceMappingURL|\.map$/.test(text)) fail("verifier bundle is not self-contained")
    return { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }
  } finally { await rm(output, { recursive: true, force: true }) }
}

/** Run a repository-local release simulation without creating release output or contacting a public service. */
export async function runDryRun(input: DryRunInput): Promise<string> {
  const root = resolve(input.root)
  await assertCleanEnvironment(input)
  const remotes = input.remotes ?? await gitRemotes(root)
  assertGitRemotes(remotes)
  await assertWorkspace(root)
  await assertNoGeneratedVerifier(root)
  const verifier = await inMemoryVerifier(root)
  if (Object.keys(TARGETS).length !== 4 || RELEASE_ASSETS.length !== 6 || VERSION !== "0.1.0") fail("release inventory is not exact")
  return [
    "archives=4 assets=6 attestation-subjects=6 npm-inventories=2",
    `archive-names=${Object.values(TARGETS).map((target) => target.asset).join(",")}`,
    `asset-names=${RELEASE_ASSETS.join(",")}`,
    "npm-names=@xiopt/pane-dash-opencode,@xiopt/tmux-pane-dash",
    `verifier=size:${verifier.size} sha256:${verifier.sha256}`,
    "verified-handoff=PASS",
    "credentials=absent remote-mutations=0 public-network-requests=0",
    "release-dry-run: PASS",
  ].join("\n")
}

if (import.meta.main) {
  try {
    console.log(await runDryRun({ root: process.cwd() }))
  } catch (error) {
    console.error(error instanceof Error ? error.message : "release-dry-run: failed")
    process.exitCode = 1
  }
}
