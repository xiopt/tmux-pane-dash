import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { internalManifest, releaseManifest, sha256Sums } from "../manifest"
import { TARGETS } from "../contracts"

test("internal manifest has seven sorted payload records and exact schema", async () => {
  const root = await mkdtemp(join(tmpdir(), "pane-dash-manifest-"))
  try {
    await mkdir(join(root, "bin"), { recursive: true }); await mkdir(join(root, "scripts"), { recursive: true })
    for (const path of ["bin/pane-dash", "pane_dash.tmux", "scripts/open.sh", "scripts/tag.sh", "README.md", "LICENSE", "VERSION"]) await writeFile(join(root, path), path)
    expect(await internalManifest({ target: TARGETS["darwin-arm64"].rustTarget, asset: TARGETS["darwin-arm64"].asset, root })).toMatchObject({ schemaVersion: 1, product: "tmux-pane-dash", version: "0.1.0", files: expect.any(Array) })
    expect((await internalManifest({ target: TARGETS["darwin-arm64"].rustTarget, asset: TARGETS["darwin-arm64"].asset, root })).files).toHaveLength(7)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("release manifest has four immutable exact keys and sorted two-space checksums", async () => {
  const assets = Object.entries(TARGETS).map(([key, value], index) => ({ key, target: value.rustTarget, asset: value.asset, sha256: `${index}`.repeat(64), size: index + 1 }))
  const manifest = await releaseManifest(assets)
  expect(Object.keys(manifest.assets)).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"])
  expect(Object.values(manifest.assets).every((asset) => asset.url === `https://github.com/xiopt/tmux-pane-dash/releases/download/v0.1.0/${asset.asset}`)).toBe(true)
  expect(new TextDecoder().decode(sha256Sums(assets))).toEqual([...assets].sort((a, b) => a.asset.localeCompare(b.asset)).map((asset) => `${asset.sha256}  ${asset.asset}`).join("\n") + "\n")
})
