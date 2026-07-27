import { parseArgs } from "./args"
import type { Command, ReleaseManifest } from "./contracts"
import { CliError } from "./errors"
import { parseReleaseManifest, selectRelease } from "./manifest"
import type { FsOps } from "./fs"

export type FetchResponse = { status: number; headers?: Headers | Record<string, string | null | undefined>; body?: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> }
export type TimerOps = { setTimeout(callback: () => void, milliseconds: number): unknown; clearTimeout(timer: unknown): void }
export type SignalOps = { on(signal: "HUP" | "INT" | "TERM", callback: () => void): void; off(signal: "HUP" | "INT" | "TERM", callback: () => void): void }

export type Dependencies = {
  manifest: unknown
  platform: NodeJS.Platform
  arch: NodeJS.Architecture
  executingVersion: string
  ownedVersion?: string
  lock?: () => void | Promise<void>
  fetch?: (url: string, init: { redirect: "manual"; signal: AbortSignal; headers: Record<string, never> }) => Promise<FetchResponse>
  fs?: FsOps
  nowMs?: () => number
  timers?: TimerOps
  signals?: SignalOps
  spawn?: (path: string, args: readonly string[], options: { timeoutMs: number; env: Record<string, string>; maxOutputBytes: number }) => Promise<{ code: number; stdout: string; stderr: string }>
  /** Internal test seams; production supplies process values only. */
  env?: Record<string, string | undefined>
  pid?: () => number
  uid?: () => number
  isPidAlive?: (pid: number) => boolean
  randomBytes?: (size: number) => Uint8Array
  journalEvent?: (event: string) => void
  faultPhase?: { phase: string; boundary: "before" | "after" }
  crashPhase?: string
  collisionAfterMutation?: boolean
  signal?: "HUP" | "INT" | "TERM"
}

function versionParts(version: string): readonly [number, number, number] {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(version)
  if (!match) throw new CliError("E_VERSION", "invalid version")
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function compareVersions(left: string, right: string): -1 | 0 | 1 {
  const leftParts = versionParts(left), rightParts = versionParts(right)
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] < rightParts[index]) return -1
    if (leftParts[index] > rightParts[index]) return 1
  }
  return 0
}

export function assertDowngradeAllowed(input: { command: Command; executingVersion: string; ownedVersion: string }): void {
  if (compareVersions(input.executingVersion, input.ownedVersion) >= 0) return
  if (input.command.name === "setup" && input.command.allowDowngrade) return
  throw new CliError("E_DOWNGRADE", "refusing to downgrade")
}

export async function runCli(argv: readonly string[], deps: Dependencies): Promise<number> {
  const command = parseArgs(argv)
  if (command.name === "doctor" || command.name === "uninstall") return 0
  const manifest: ReleaseManifest = parseReleaseManifest(deps.manifest)
  selectRelease(manifest, deps.platform, deps.arch)
  if (command.name === "update" && deps.ownedVersion === undefined) throw new CliError("E_USAGE", "no installation; run setup")
  if (deps.ownedVersion !== undefined) assertDowngradeAllowed({ command, executingVersion: deps.executingVersion, ownedVersion: deps.ownedVersion })
  await deps.lock?.()
  return 0
}
