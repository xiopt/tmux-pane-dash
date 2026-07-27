import { expect, test } from "bun:test"
import { parseReleaseManifest, selectRelease } from "../src/manifest"
import { CliError } from "../src/errors"

const names = {
  "darwin-arm64": ["aarch64-apple-darwin", "tmux-pane-dash-v0.1.0-aarch64-apple-darwin.tar.gz"],
  "darwin-x64": ["x86_64-apple-darwin", "tmux-pane-dash-v0.1.0-x86_64-apple-darwin.tar.gz"],
  "linux-arm64": ["aarch64-unknown-linux-musl", "tmux-pane-dash-v0.1.0-aarch64-unknown-linux-musl.tar.gz"],
  "linux-x64": ["x86_64-unknown-linux-musl", "tmux-pane-dash-v0.1.0-x86_64-unknown-linux-musl.tar.gz"],
} as const

function manifest() {
  return {
    schemaVersion: 1, repository: "xiopt/tmux-pane-dash", version: "0.1.0", tag: "v0.1.0",
    assets: Object.fromEntries(Object.entries(names).map(([key, [target, asset]], index) => [key, { target, asset, url: `https://github.com/xiopt/tmux-pane-dash/releases/download/v0.1.0/${asset}`, sha256: `${index}`.repeat(64), size: index + 1 }])),
  }
}

test("accepts the exact immutable four-target release manifest", () => {
  const parsed = parseReleaseManifest(manifest())
  expect(selectRelease(parsed, "linux", "x64").asset).toBe(names["linux-x64"][1])
})

test("rejects schema, keys, targets, names, URLs, hashes, unsafe sizes, and oversized assets", () => {
  for (const mutate of [
    (value: any) => { value.extra = true },
    (value: any) => { delete value.assets["linux-x64"] },
    (value: any) => { value.assets["linux-x64"].target = "wrong" },
    (value: any) => { value.assets["linux-x64"].asset = "wrong.tar.gz" },
    (value: any) => { value.assets["linux-x64"].url = "https://example.test/archive" },
    (value: any) => { value.assets["linux-x64"].sha256 = "UPPER" },
    (value: any) => { value.assets["linux-x64"].size = Number.MAX_SAFE_INTEGER + 1 },
    (value: any) => { value.assets["linux-x64"].size = 64 * 1024 * 1024 + 1 },
  ]) {
    const value = manifest(); mutate(value)
    expect(() => parseReleaseManifest(value)).toThrow(CliError)
  }
})
