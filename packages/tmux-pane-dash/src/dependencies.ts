import releaseManifest from "../generated/release-manifest.json"
import process from "node:process"
import type { Dependencies } from "./runtime"

export function nodeDependencies(): Dependencies {
  return { manifest: releaseManifest, platform: process.platform, arch: process.arch, executingVersion: releaseManifest.version }
}
