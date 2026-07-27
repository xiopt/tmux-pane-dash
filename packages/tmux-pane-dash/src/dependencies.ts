import releaseManifest from "../generated/release-manifest.json"
import { spawn } from "node:child_process"
import process from "node:process"
import type { Dependencies } from "./runtime"
import { nodeFsOps } from "./fs"

export function nodeDependencies(): Dependencies {
  const child = (path: string, args: readonly string[], options: { timeoutMs: number; env: Record<string, string>; maxOutputBytes: number }) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const process = spawn(path, args, { env: options.env, stdio: ["ignore", "pipe", "pipe"] }); const stdout: Buffer[] = [], stderr: Buffer[] = []; let size = 0
    const receive = (target: Buffer[]) => (chunk: Buffer) => { size += chunk.length; if (size > options.maxOutputBytes) process.kill("SIGKILL"); else target.push(chunk) }
    process.stdout.on("data", receive(stdout)); process.stderr.on("data", receive(stderr)); process.once("error", reject); process.once("close", (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() })); setTimeout(() => process.kill("SIGKILL"), options.timeoutMs).unref()
  })
  return { manifest: releaseManifest, platform: process.platform, arch: process.arch, executingVersion: releaseManifest.version, ...( { fs: nodeFsOps(), nowMs: Date.now, fetch: globalThis.fetch.bind(globalThis), spawn: child } as any) }
}
