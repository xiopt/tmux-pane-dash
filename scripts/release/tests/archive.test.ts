import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildArchive, inspectArchive } from "../archive"
import { TARGETS } from "../contracts"

test("archive inventory and metadata are exact and reproducible", async () => {
  const root = await mkdtemp(join(tmpdir(), "pane-dash-archive-"))
  try {
    await mkdir(join(root, "scripts"), { recursive: true })
    for (const path of ["pane_dash.tmux", "README.md", "LICENSE", "VERSION", "scripts/open.sh", "scripts/tag.sh"]) await writeFile(join(root, path), `${path}\n`)
    const binary = join(root, "pane-dash")
    await writeFile(binary, new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 12, 0, 0, 1]))
    const a = join(root, "a.tar.gz"), b = join(root, "b.tar.gz")
    await buildArchive({ target: TARGETS["darwin-arm64"].rustTarget, binary, output: a, epoch: 1721740800, root })
    await buildArchive({ target: TARGETS["darwin-arm64"].rustTarget, binary, output: b, epoch: 1721740800, root })
    expect(await inspectArchive(a)).toEqual([
      ["bin/pane-dash", "file", "0755"], ["pane_dash.tmux", "file", "0755"],
      ["scripts/open.sh", "file", "0755"], ["scripts/tag.sh", "file", "0755"],
      ["README.md", "file", "0644"], ["LICENSE", "file", "0644"],
      ["VERSION", "file", "0644"], ["manifest.json", "file", "0644"],
    ])
    expect(await readFile(a)).toEqual(await readFile(b))
  } finally { await rm(root, { recursive: true, force: true }) }
})
