export const TARGET_KEYS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"] as const
export type TargetKey = typeof TARGET_KEYS[number]

export type SetupCommand = { name: "setup"; tmux: boolean; opencode: boolean; migrate: boolean; allowDowngrade: boolean }
export type Command = SetupCommand | { name: "update" } | { name: "doctor"; json: boolean } | { name: "uninstall" }
export type MutationCommand = Exclude<Command["name"], "doctor">
export type LockHandle = { token: string; recovered: boolean; release(): Promise<void> }

export type ReleaseAssetRecord = { target: string; asset: string; url: string; sha256: string; size: number }
export type ReleaseManifest = { schemaVersion: 1; repository: "xiopt/tmux-pane-dash"; version: string; tag: `v${string}`; assets: Record<TargetKey, ReleaseAssetRecord> }

export const MAX_ARCHIVE_SIZE = 64 * 1024 * 1024
