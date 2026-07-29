import { parseArgs } from "./args"
import type { Command, LockHandle, MutationCommand, ReleaseAssetRecord, ReleaseManifest } from "./contracts"
import { CliError } from "./errors"
import { parseReleaseManifest, selectRelease } from "./manifest"
import type { FsOps } from "./fs"

export type FetchResponse = { status: number; headers?: Headers | Record<string, string | null | undefined>; body?: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> }
export type TimerOps = { setTimeout(callback: () => void, milliseconds: number): unknown; clearTimeout(timer: unknown): void }
export type SignalOps = { on(signal: "HUP" | "INT" | "TERM", callback: () => void): void; off(signal: "HUP" | "INT" | "TERM", callback: () => void): void }
export type DoctorFs = {
  readFile(path: string): Promise<Uint8Array>
  stat(path: string): Promise<{ kind: "file" | "directory" | "symlink" | "other"; mode: number; size: number; dev?: number; ino?: number }>
  readdir(path: string): Promise<string[]>
  readlink(path: string): Promise<string>
}

export type Dependencies = {
  manifest: unknown
  platform: NodeJS.Platform
  arch: NodeJS.Architecture
  executingVersion: string
  ownedVersion?: string
  lock?: (command: MutationCommand) => Promise<LockHandle>
  fetch?: (url: string, init: { redirect: "manual"; signal: AbortSignal; headers: Record<string, never> }) => Promise<FetchResponse>
  /** The bundled archive for the only platform this basic package supports. */
  embeddedArchive?: (record: ReleaseAssetRecord) => Promise<Uint8Array | undefined>
  fs?: FsOps
  nowMs?: () => number
  timers?: TimerOps
  signals?: SignalOps
  spawn?: (path: string, args: readonly string[], options: { timeoutMs: number; env: Record<string, string>; maxOutputBytes: number }) => Promise<{ code: number; stdout: string; stderr: string }>
  /** Read-only operations used exclusively by `doctor`. */
  doctorFs?: DoctorFs
  doctorOutput?: (text: string) => void
  /** Internal test seams; production supplies process values only. */
  env?: Record<string, string | undefined>
  pid?: () => number
  uid?: () => number
  isPidAlive?: (pid: number) => boolean
  randomBytes?: (size: number) => Uint8Array
  journalEvent?: (event: string) => void
  faultPhase?: { phase: string; boundary: "before" | "after" }
  crashPhase?: string
  crashMutation?: { operation: "current" | "config" | "ownership"; occurrence: number; boundary: "intent" | "published" | "applied" }
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
  if (command.name === "doctor") {
    const { doctor, renderDoctorHuman, renderDoctorJson } = await import("./commands/doctor")
    const report = await doctor(deps)
    deps.doctorOutput?.(command.json ? renderDoctorJson(report) : renderDoctorHuman(report))
    return report.healthy ? 0 : 1
  }
  if (command.name === "setup" || command.name === "update") { const manifest: ReleaseManifest = parseReleaseManifest(deps.manifest); if (manifest.version !== deps.executingVersion) throw new CliError("E_VERSION", "release manifest version does not match executing version"); if (command.name === "setup") selectRelease(manifest, deps.platform, deps.arch) }
  let lock: LockHandle | undefined
  try {
    lock = deps.lock ? await deps.lock(command.name) : undefined
    if (command.name === "setup") await (await import("./commands/setup")).setup(command, deps)
    else if (command.name === "update") await (await import("./commands/update")).update(deps)
    else await (await import("./commands/uninstall")).uninstall(deps)
    return 0
  } finally {
    await lock?.release()
  }
}
