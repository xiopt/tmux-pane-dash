import { expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gunzipSync, gzipSync } from "node:zlib"
import { canonicalJson, sha256 } from "../canonical-json"
import { TARGETS } from "../contracts"
import { verifyReleaseDirectory } from "../verify-artifacts"

const decoder = new TextDecoder()
const epoch = 1784813242

async function buildRelease(root: string): Promise<void> {
  const child = Bun.spawn([process.execPath, "scripts/release/build.ts", "--local-fixtures", "--tag-commit", "7bc976a", "--output", root], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" })
  if (await child.exited) throw new Error(await new Response(child.stderr).text())
}

function tarEntry(tar: Uint8Array, name: string): { header: number; content: number; size: number } {
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512); if (header.every((byte) => byte === 0)) break
    const end = header.indexOf(0); const entry = decoder.decode(header.subarray(0, end < 0 ? 100 : end))
    const size = Number.parseInt(decoder.decode(header.subarray(124, 136)).replace(/\0.*$/, "").trim(), 8) || 0
    if (entry === name) return { header: offset, content: offset + 512, size }
    offset += 512 + Math.ceil(size / 512) * 512
  }
  throw new Error(`missing ${name}`)
}

async function replaceArchive(root: string, key: keyof typeof TARGETS, change: (tar: Uint8Array) => void): Promise<void> {
  const target = TARGETS[key], archivePath = join(root, target.asset), tar = gunzipSync(await readFile(archivePath)); change(tar)
  const archive = gzipSync(tar, { mtime: 0, filename: "" }); await writeFile(archivePath, archive)
  const release = JSON.parse(decoder.decode(await readFile(join(root, "release-manifest.json")))) as { assets: Record<string, { sha256: string; size: number }> }
  release.assets[key] = { ...release.assets[key]!, sha256: sha256(archive), size: archive.length }
  await writeFile(join(root, "release-manifest.json"), canonicalJson(release))
  await writeFile(join(root, "SHA256SUMS"), Object.entries(TARGETS).sort(([, a], [, b]) => Buffer.from(a.asset).compare(Buffer.from(b.asset))).map(([name, { asset }]) => `${release.assets[name]!.sha256}  ${asset}`).join("\n") + "\n")
}

test("verifier requires exactly four archives plus release manifest and checksums", async () => {
  const root = await mkdtemp(join(tmpdir(), "pane-dash-release-"))
  try {
    await expect(verifyReleaseDirectory(root, epoch)).rejects.toThrow("exactly six release assets")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("verifier rejects a binary whose regenerated metadata names the wrong architecture", async () => {
  const root = await mkdtemp(join(tmpdir(), "pane-dash-release-"))
  try {
    await buildRelease(root)
    await replaceArchive(root, "darwin-arm64", (tar) => {
      const binary = tarEntry(tar, "bin/pane-dash"), manifest = tarEntry(tar, "manifest.json")
      tar[binary.content + 4] = 7
      const record = JSON.parse(decoder.decode(tar.subarray(manifest.content, manifest.content + manifest.size))) as { files: Array<{ path: string; sha256: string }> }
      record.files.find((file) => file.path === "bin/pane-dash")!.sha256 = sha256(tar.subarray(binary.content, binary.content + binary.size))
      tar.set(canonicalJson(record), manifest.content)
    })
    await expect(verifyReleaseDirectory(root, epoch)).rejects.toThrow("architecture")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("verifier rejects a host-matching binary that cannot report its exact version in tmux", async () => {
  const root = await mkdtemp(join(tmpdir(), "pane-dash-release-"))
  try {
    await buildRelease(root)
    const key = process.platform === "darwin" ? process.arch === "arm64" ? "darwin-arm64" : "darwin-x64" : process.arch === "arm64" ? "linux-arm64" : "linux-x64"
    await replaceArchive(root, key, (tar) => {
      const binary = tarEntry(tar, "bin/pane-dash"), manifest = tarEntry(tar, "manifest.json")
      tar.fill(0, binary.content, binary.content + binary.size)
      if (process.platform === "darwin") tar.set(process.arch === "arm64" ? [0xcf, 0xfa, 0xed, 0xfe, 12, 0, 0, 1] : [0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1], binary.content)
      else tar.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, process.arch === "arm64" ? 0xb7 : 0x3e, 0], binary.content)
      const record = JSON.parse(decoder.decode(tar.subarray(manifest.content, manifest.content + manifest.size))) as { files: Array<{ path: string; sha256: string }> }
      record.files.find((file) => file.path === "bin/pane-dash")!.sha256 = sha256(tar.subarray(binary.content, binary.content + binary.size))
      tar.set(canonicalJson(record), manifest.content)
    })
    await expect(verifyReleaseDirectory(root, epoch)).rejects.toThrow("version")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("verifier requires a complete canonical internal manifest and path-specific modes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pane-dash-release-"))
  try {
    await buildRelease(root)
    await replaceArchive(root, "darwin-arm64", (tar) => {
      const manifest = tarEntry(tar, "manifest.json")
      const record = JSON.parse(decoder.decode(tar.subarray(manifest.content, manifest.content + manifest.size))) as { files: Array<{ path: string; mode: string }> }
      record.files.find((file) => file.path === "bin/pane-dash")!.mode = "0644"
      const bytes = canonicalJson(record).subarray(0, -1)
      tar.set(bytes, manifest.content); tar.set(new TextEncoder().encode(`${bytes.length.toString(8).padStart(11, "0")}\0`), manifest.header + 124)
    })
    await expect(verifyReleaseDirectory(root, epoch)).rejects.toThrow("invalid internal manifest")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("verifier rejects a release tag that no longer resolves to the expected commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "pane-dash-release-")), bin = await mkdtemp(join(tmpdir(), "pane-dash-git-"))
  const git = join(bin, "git")
  const previousPath = process.env.PATH
  try {
    await buildRelease(root)
    await writeFile(git, `#!/bin/sh
case "$*" in
  'rev-parse 7bc976a^{commit}') printf '%s\\n' expected-release-commit ;;
  'rev-parse v0.1.0^{commit}') printf '%s\\n' moved-release-tag ;;
  'show -s --format=%ct moved-release-tag') printf '%s\\n' ${epoch} ;;
  *) exit 1 ;;
esac
`)
    await chmod(git, 0o755)
    process.env.PATH = `${bin}:${previousPath}`
    await expect(verifyReleaseDirectory(root)).rejects.toThrow("tag v0.1.0 does not resolve to supplied tag commit")
  } finally {
    process.env.PATH = previousPath
    await rm(root, { recursive: true, force: true })
    await rm(bin, { recursive: true, force: true })
  }
})

test("verifier rejects extra keys at every manifest object level", async () => {
  const cases: Array<{ name: string; change: (root: string) => Promise<void> }> = [
    {
      name: "release manifest",
      change: async (root) => {
        const manifest = JSON.parse(decoder.decode(await readFile(join(root, "release-manifest.json"))))
        manifest.extra = true
        await writeFile(join(root, "release-manifest.json"), canonicalJson(manifest))
      },
    },
    {
      name: "release asset",
      change: async (root) => {
        const manifest = JSON.parse(decoder.decode(await readFile(join(root, "release-manifest.json"))))
        manifest.assets["darwin-arm64"].extra = true
        await writeFile(join(root, "release-manifest.json"), canonicalJson(manifest))
      },
    },
    {
      name: "internal manifest",
      change: async (root) => replaceArchive(root, "darwin-arm64", (tar) => {
        const manifest = tarEntry(tar, "manifest.json")
        const record = JSON.parse(decoder.decode(tar.subarray(manifest.content, manifest.content + manifest.size)))
        record.extra = true
        const bytes = canonicalJson(record)
        tar.set(bytes, manifest.content)
        tar.set(new TextEncoder().encode(`${bytes.length.toString(8).padStart(11, "0")}\0`), manifest.header + 124)
      }),
    },
    {
      name: "internal file record",
      change: async (root) => replaceArchive(root, "darwin-arm64", (tar) => {
        const manifest = tarEntry(tar, "manifest.json")
        const record = JSON.parse(decoder.decode(tar.subarray(manifest.content, manifest.content + manifest.size)))
        record.files[0].extra = true
        const bytes = canonicalJson(record)
        tar.set(bytes, manifest.content)
        tar.set(new TextEncoder().encode(`${bytes.length.toString(8).padStart(11, "0")}\0`), manifest.header + 124)
      }),
    },
  ]
  for (const { name, change } of cases) {
    const root = await mkdtemp(join(tmpdir(), "pane-dash-release-"))
    try {
      await buildRelease(root)
      await change(root)
      await expect(verifyReleaseDirectory(root, epoch), name).rejects.toThrow(/invalid (release|internal)/)
    } finally { await rm(root, { recursive: true, force: true }) }
  }
})
