import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { parseReleaseManifest, selectRelease } from "../src/manifest"
import { CliError } from "../src/errors"
import { canonicalJson } from "../../../scripts/release/canonical-json"

const targets = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "linux-x64": "x86_64-unknown-linux-musl",
} as const

function manifest(version = "0.1.0") {
  return {
    schemaVersion: 1, repository: "xiopt/tmux-pane-dash", version, tag: `v${version}`,
    assets: Object.fromEntries(Object.entries(targets).map(([key, target], index) => {
      const asset = `tmux-pane-dash-v${version}-${target}.tar.gz`
      return [key, { target, asset, url: `https://github.com/xiopt/tmux-pane-dash/releases/download/v${version}/${asset}`, sha256: `${index}`.repeat(64), size: index + 1 }]
    })),
  }
}

test("accepts exact tag-derived immutable manifests for stable versions", () => {
  for (const version of ["0.1.0", "0.1.1"]) {
    const parsed = parseReleaseManifest(manifest(version))
    expect(selectRelease(parsed, "linux", "x64").asset).toBe(`tmux-pane-dash-v${version}-${targets["linux-x64"]}.tar.gz`)
  }
})

test("rejects schema, keys, targets, names, URLs, hashes, unsafe sizes, and oversized assets", () => {
  for (const mutate of [
    (value: any) => { value.extra = true },
    (value: any) => { delete value.assets["linux-x64"] },
    (value: any) => { value.assets["linux-x64"].target = "wrong" },
    (value: any) => { value.assets["linux-x64"].asset = "wrong.tar.gz" },
    (value: any) => { value.tag = "v0.1.1" },
    (value: any) => { value.assets["linux-x64"].asset = value.assets["linux-x64"].asset.replace("0.1.0", "0.1.1") },
    (value: any) => { value.assets["linux-x64"].url = "https://example.test/archive" },
    (value: any) => { value.assets["linux-x64"].sha256 = "UPPER" },
    (value: any) => { value.assets["linux-x64"].size = Number.MAX_SAFE_INTEGER + 1 },
    (value: any) => { value.assets["linux-x64"].size = 64 * 1024 * 1024 + 1 },
  ]) {
    const value = manifest(); mutate(value)
    expect(() => parseReleaseManifest(value)).toThrow(CliError)
  }
})

test("generated package manifest is a canonical immutable four-target manifest", async () => {
  const bytes = await readFile(resolve(import.meta.dir, "..", "generated", "release-manifest.json"))
  const value = JSON.parse(bytes.toString())
  expect(bytes).toEqual(Buffer.from(canonicalJson(value)))
  expect(bytes.includes("\r")).toBeFalse()
  expect(Object.keys(value)).toEqual(["assets", "repository", "schemaVersion", "tag", "version"])
  expect(value).toMatchObject({ schemaVersion: 1, repository: "xiopt/tmux-pane-dash", version: "0.1.7", tag: "v0.1.7" })
  expect(Object.keys(value.assets)).toEqual(Object.keys(targets))
  for (const [key, target] of Object.entries(targets)) {
    const record = value.assets[key]
    const asset = `tmux-pane-dash-v${value.version}-${target}.tar.gz`
    expect(Object.keys(record)).toEqual(["asset", "sha256", "size", "target", "url"])
    expect(record.target).toBe(target)
    expect(record.asset).toBe(asset)
    expect(record.url).toBe(`https://github.com/xiopt/tmux-pane-dash/releases/download/v${value.version}/${asset}`)
    expect(record.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(record.sha256).not.toMatch(/^(.)\1{63}$/)
    expect(record.size).toBeGreaterThan(0)
    expect(record.size).toBeLessThanOrEqual(64 * 1024 * 1024)
  }
  expect(parseReleaseManifest(value)).toEqual(value)
})
