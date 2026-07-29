export const VERSION = "0.1.1" as const
export const TAG = `v${VERSION}` as const
export const TAG_COMMIT = "d47a37a" as const
export const REPOSITORY = "xiopt/tmux-pane-dash" as const
export const RELEASE_DOWNLOAD_BASE = `https://github.com/${REPOSITORY}/releases/download/${TAG}` as const

export const RUST_ALPINE_BUILDERS = {
  amd64: "f5c84c3751de59f0f318acfbed8b2d04693a12d9171f15835d9c11c9ddcf52db",
  arm64: "ccba3c5d98fc76a5ac6eade9bcbbb946635657457c3d269982396633a66da08d",
} as const

export const TMUX_RUNTIME = {
  debianDigest: "7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818",
  tmuxVersion: "3.6",
  tmuxSourceUrl: "https://github.com/tmux/tmux/releases/download/3.6/tmux-3.6.tar.gz",
  tmuxSha256: "136db80cfbfba617a103401f52874e7c64927986b65b1b700350b6058ad69607",
} as const

/** Platform manifests resolved from TMUX_RUNTIME.debianDigest's multiarch index. */
export const DEBIAN_PLATFORM_MANIFESTS = {
  amd64: "63a496b5d3b99214b39f5ed70eb71a61e590a77979c79cbee4faf991f8c0783e",
  arm64: "9b67294679b30e5d6ab257b40594feeb4a4b81f7fcf4131f4decf0d6a212a9b0",
} as const

type Target = {
  readonly rustTarget: string
  readonly asset: string
}

const asset = (rustTarget: string) => `tmux-pane-dash-${TAG}-${rustTarget}.tar.gz` as const

export const TARGETS = {
  "darwin-arm64": {
    rustTarget: "aarch64-apple-darwin",
    asset: asset("aarch64-apple-darwin"),
  },
  "darwin-x64": {
    rustTarget: "x86_64-apple-darwin",
    asset: asset("x86_64-apple-darwin"),
  },
  "linux-arm64": {
    rustTarget: "aarch64-unknown-linux-musl",
    asset: asset("aarch64-unknown-linux-musl"),
  },
  "linux-x64": {
    rustTarget: "x86_64-unknown-linux-musl",
    asset: asset("x86_64-unknown-linux-musl"),
  },
} as const satisfies Record<string, Target>

export const ARCHIVE_PAYLOAD = [
  ["bin/pane-dash", "0755"],
  ["pane_dash.tmux", "0755"],
  ["scripts/open.sh", "0755"],
  ["scripts/tag.sh", "0755"],
  ["README.md", "0644"],
  ["LICENSE", "0644"],
  ["VERSION", "0644"],
  ["manifest.json", "0644"],
] as const

export const RELEASE_ASSETS = [
  ...Object.values(TARGETS).map(({ asset: archive }) => archive),
  "release-manifest.json",
  "SHA256SUMS",
] as const

export const CLI_PACKAGE_FILES = [
  "package/package.json",
  "package/README.md",
  "package/LICENSE",
  "package/dist/cli.js",
  "package/dist/runtime.js",
  "package/generated/release-manifest.json",
  "package/payload/tmux-pane-dash-v0.1.1-aarch64-apple-darwin.tar.gz",
] as const

export const OPENCODE_PACKAGE_FILES = [
  "package/package.json",
  "package/README.md",
  "package/LICENSE",
  "package/dist/index.js",
] as const
