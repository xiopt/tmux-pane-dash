import releaseManifest from "../generated/release-manifest.json"
import { spawn } from "node:child_process"
import process from "node:process"
import type { Dependencies } from "./runtime"
import { nodeFsOps } from "./fs"

export function nodeDependencies(): Dependencies {
  const child = (path: string, args: readonly string[], options: { timeoutMs: number; env: Record<string, string>; maxOutputBytes: number }) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const process = spawn(path, args, { env: options.env, stdio: ["ignore", "pipe", "pipe"] }); const stdout: Buffer[] = [], stderr: Buffer[] = []; let size = 0, overflow = false, timedOut = false
    const receive = (target: Buffer[]) => (chunk: Buffer) => { size += chunk.length; if (size > options.maxOutputBytes) { overflow = true; process.kill("SIGKILL") } else target.push(chunk) }
    const timeout = setTimeout(() => { timedOut = true; process.kill("SIGKILL") }, options.timeoutMs); timeout.unref()
    process.stdout.on("data", receive(stdout)); process.stderr.on("data", receive(stderr)); process.once("error", reject); process.once("close", (code) => { clearTimeout(timeout); if (overflow) reject(new Error("E_BINARY_OUTPUT")); else if (timedOut) reject(new Error("E_BINARY_TIMEOUT")); else resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }) })
  })
  return { manifest: releaseManifest, platform: process.platform, arch: process.arch, executingVersion: releaseManifest.version, ...( { fs: nodeFsOps(), nowMs: Date.now, fetch: globalThis.fetch.bind(globalThis), spawn: child } as any) }
}
