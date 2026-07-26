import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { ARCHIVE_PAYLOAD, RELEASE_DOWNLOAD_BASE, REPOSITORY, TAG, TARGETS, VERSION } from "./contracts"
import { sha256 } from "./canonical-json"

export type RustTarget = (typeof TARGETS)[keyof typeof TARGETS]["rustTarget"]
export type InternalManifest = { schemaVersion: 1; product: "tmux-pane-dash"; version: typeof VERSION; target: RustTarget; asset: string; files: Array<{ path: string; sha256: string; size: number; mode: "0755" | "0644" }> }
export type VerifiedAsset = { key: string; target: RustTarget; asset: string; sha256: string; size: number }
export type ReleaseManifest = { schemaVersion: 1; repository: typeof REPOSITORY; version: typeof VERSION; tag: typeof TAG; assets: Record<string, { target: RustTarget; asset: string; url: string; sha256: string; size: number }> }

const modes = new Map(ARCHIVE_PAYLOAD.map(([path, mode]) => [path, mode] as const))

export async function internalManifest(input: { target: RustTarget; asset: string; root: string }): Promise<InternalManifest> {
  if (!Object.values(TARGETS).some((target) => target.rustTarget === input.target && target.asset === input.asset)) throw new Error("invalid target or asset")
  const files = await Promise.all(ARCHIVE_PAYLOAD.filter(([path]) => path !== "manifest.json").map(async ([path]) => {
    const bytes = await readFile(join(input.root, path)); const info = await stat(join(input.root, path))
    return { path, sha256: sha256(bytes), size: info.size, mode: modes.get(path)! }
  }))
  files.sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)))
  return { schemaVersion: 1, product: "tmux-pane-dash", version: VERSION, target: input.target, asset: input.asset, files }
}

export async function releaseManifest(assets: readonly VerifiedAsset[]): Promise<ReleaseManifest> {
  const keys = Object.keys(TARGETS)
  if (assets.length !== 4 || assets.some((asset) => !keys.includes(asset.key))) throw new Error("release manifest requires four exact assets")
  const records = Object.fromEntries(keys.map((key) => {
    const asset = assets.find((candidate) => candidate.key === key)
    if (!asset || TARGETS[key as keyof typeof TARGETS].asset !== asset.asset || TARGETS[key as keyof typeof TARGETS].rustTarget !== asset.target) throw new Error("invalid release asset")
    return [key, { target: asset.target, asset: asset.asset, url: `${RELEASE_DOWNLOAD_BASE}/${asset.asset}`, sha256: asset.sha256, size: asset.size }]
  }))
  return { schemaVersion: 1, repository: REPOSITORY, version: VERSION, tag: TAG, assets: records }
}

export function sha256Sums(assets: readonly VerifiedAsset[]): Uint8Array {
  return new TextEncoder().encode([...assets].sort((a, b) => Buffer.from(a.asset).compare(Buffer.from(b.asset))).map((asset) => `${asset.sha256}  ${asset.asset}`).join("\n") + "\n")
}
