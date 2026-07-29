import { expect, test } from "bun:test"
import {
  ARCHIVE_PAYLOAD,
  CLI_PACKAGE_FILES,
  DEBIAN_PLATFORM_MANIFESTS,
  OPENCODE_PACKAGE_FILES,
  REPOSITORY,
  RELEASE_ASSETS,
  RUST_ALPINE_BUILDERS,
  TAG,
  TARGETS,
  TMUX_RUNTIME,
  VERSION,
} from "../contracts"

test("defines the exact v0.1.1 release identities and four target assets", () => {
  expect({ VERSION, TAG, REPOSITORY }).toEqual({
    VERSION: "0.1.1",
    TAG: "v0.1.1",
    REPOSITORY: "xiopt/tmux-pane-dash",
  })
  expect(TARGETS).toEqual({
    "darwin-arm64": {
      rustTarget: "aarch64-apple-darwin",
      asset: "tmux-pane-dash-v0.1.1-aarch64-apple-darwin.tar.gz",
    },
    "darwin-x64": {
      rustTarget: "x86_64-apple-darwin",
      asset: "tmux-pane-dash-v0.1.1-x86_64-apple-darwin.tar.gz",
    },
    "linux-arm64": {
      rustTarget: "aarch64-unknown-linux-musl",
      asset: "tmux-pane-dash-v0.1.1-aarch64-unknown-linux-musl.tar.gz",
    },
    "linux-x64": {
      rustTarget: "x86_64-unknown-linux-musl",
      asset: "tmux-pane-dash-v0.1.1-x86_64-unknown-linux-musl.tar.gz",
    },
  })
})

test("defines exact archive and package inventories before consumers", () => {
  expect(ARCHIVE_PAYLOAD).toEqual([
    ["bin/pane-dash", "0755"],
    ["pane_dash.tmux", "0755"],
    ["scripts/open.sh", "0755"],
    ["scripts/tag.sh", "0755"],
    ["README.md", "0644"],
    ["LICENSE", "0644"],
    ["VERSION", "0644"],
    ["manifest.json", "0644"],
  ])
  expect(CLI_PACKAGE_FILES).toEqual([
    "package/package.json",
    "package/README.md",
    "package/LICENSE",
    "package/dist/cli.js",
    "package/dist/runtime.js",
    "package/generated/release-manifest.json",
  ])
  expect(OPENCODE_PACKAGE_FILES).toEqual([
    "package/package.json",
    "package/README.md",
    "package/LICENSE",
    "package/dist/index.js",
  ])
  expect(RELEASE_ASSETS).toEqual([
    "tmux-pane-dash-v0.1.1-aarch64-apple-darwin.tar.gz",
    "tmux-pane-dash-v0.1.1-x86_64-apple-darwin.tar.gz",
    "tmux-pane-dash-v0.1.1-aarch64-unknown-linux-musl.tar.gz",
    "tmux-pane-dash-v0.1.1-x86_64-unknown-linux-musl.tar.gz",
    "release-manifest.json",
    "SHA256SUMS",
  ])
})

test("pins only official Rust Alpine builders and the Debian tmux runtime", () => {
  expect(RUST_ALPINE_BUILDERS).toEqual({
    amd64: "f5c84c3751de59f0f318acfbed8b2d04693a12d9171f15835d9c11c9ddcf52db",
    arm64: "ccba3c5d98fc76a5ac6eade9bcbbb946635657457c3d269982396633a66da08d",
  })
  expect(TMUX_RUNTIME).toEqual({
    debianDigest: "7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818",
    tmuxVersion: "3.6",
    tmuxSourceUrl: "https://github.com/tmux/tmux/releases/download/3.6/tmux-3.6.tar.gz",
    tmuxSha256: "136db80cfbfba617a103401f52874e7c64927986b65b1b700350b6058ad69607",
  })
  expect(DEBIAN_PLATFORM_MANIFESTS).toEqual({
    amd64: "63a496b5d3b99214b39f5ed70eb71a61e590a77979c79cbee4faf991f8c0783e",
    arm64: "9b67294679b30e5d6ab257b40594feeb4a4b81f7fcf4131f4decf0d6a212a9b0",
  })
})
