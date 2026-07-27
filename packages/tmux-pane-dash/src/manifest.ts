import { MAX_ARCHIVE_SIZE, TARGET_KEYS, type ReleaseAssetRecord, type ReleaseManifest, type TargetKey } from "./contracts"
import { CliError } from "./errors"
import { selectTarget } from "./platform"

const targets: Record<TargetKey, readonly [string, string]> = {
  "darwin-arm64": ["aarch64-apple-darwin", "tmux-pane-dash-v0.1.0-aarch64-apple-darwin.tar.gz"],
  "darwin-x64": ["x86_64-apple-darwin", "tmux-pane-dash-v0.1.0-x86_64-apple-darwin.tar.gz"],
  "linux-arm64": ["aarch64-unknown-linux-musl", "tmux-pane-dash-v0.1.0-aarch64-unknown-linux-musl.tar.gz"],
  "linux-x64": ["x86_64-unknown-linux-musl", "tmux-pane-dash-v0.1.0-x86_64-unknown-linux-musl.tar.gz"],
}
const keys = (value: unknown, expected: readonly string[]) => typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key))

export function parseReleaseManifest(value: unknown): ReleaseManifest {
  if (!keys(value, ["schemaVersion", "repository", "version", "tag", "assets"]) || value.schemaVersion !== 1 || value.repository !== "xiopt/tmux-pane-dash" || value.version !== "0.1.0" || value.tag !== "v0.1.0" || !keys(value.assets, TARGET_KEYS)) throw new CliError("E_MANIFEST", "invalid release manifest")
  for (const key of TARGET_KEYS) {
    const asset = value.assets[key]
    const [target, name] = targets[key]
    if (!keys(asset, ["target", "asset", "url", "sha256", "size"]) || asset.target !== target || asset.asset !== name || asset.url !== `https://github.com/xiopt/tmux-pane-dash/releases/download/v0.1.0/${name}` || typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.size) || asset.size < 0 || asset.size > MAX_ARCHIVE_SIZE) throw new CliError("E_MANIFEST", "invalid release manifest")
  }
  return value as ReleaseManifest
}

export function selectRelease(manifest: ReleaseManifest, platform: NodeJS.Platform, arch: NodeJS.Architecture): ReleaseAssetRecord {
  return manifest.assets[selectTarget(platform, arch)]
}
