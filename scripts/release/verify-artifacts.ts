import { readFile, readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { gunzipSync } from "node:zlib"
import { ARCHIVE_PAYLOAD, RELEASE_ASSETS, TARGETS } from "./contracts"
import { canonicalJson, sha256 } from "./canonical-json"
import { inspectArchive } from "./archive"

const decoder = new TextDecoder()
const parseJson = (bytes: Uint8Array) => JSON.parse(decoder.decode(bytes)) as Record<string, unknown>

function tarFiles(bytes: Uint8Array): Map<string, Uint8Array> {
  const tar = gunzipSync(bytes); const files = new Map<string, Uint8Array>()
  for (let offset = 0; offset + 512 <= tar.length;) { const header = tar.subarray(offset, offset + 512); if (header.every((byte) => byte === 0)) break; const zero = header.indexOf(0); const name = decoder.decode(header.subarray(0, zero < 0 ? 100 : zero)); const size = Number.parseInt(decoder.decode(header.subarray(124, 136)).replace(/\0.*$/, "").trim(), 8) || 0; if (header[156] !== 53) files.set(name, tar.slice(offset + 512, offset + 512 + size)); offset += 512 + Math.ceil(size / 512) * 512 }
  return files
}

export async function verifyReleaseDirectory(path: string): Promise<void> {
  const names = (await readdir(path)).sort((a, b) => Buffer.from(a).compare(Buffer.from(b)))
  if (names.length !== 6 || names.some((name) => !RELEASE_ASSETS.includes(name as never))) throw new Error("expected exactly six release assets")
  const releaseBytes = await readFile(join(path, "release-manifest.json")); const sums = await readFile(join(path, "SHA256SUMS")); const release = parseJson(releaseBytes)
  if (!releaseBytes.equals(Buffer.from(canonicalJson(release))) || release.schemaVersion !== 1 || release.repository !== "xiopt/tmux-pane-dash" || release.version !== "0.1.0" || release.tag !== "v0.1.0" || typeof release.assets !== "object" || release.assets === null) throw new Error("invalid release manifest")
  if (Object.keys(release.assets as object).join(",") !== "darwin-arm64,darwin-x64,linux-arm64,linux-x64") throw new Error("release manifest keys are not exact")
  const checksumLines: Array<{ asset: string; line: string }> = []
  for (const [key, target] of Object.entries(TARGETS)) {
    const asset = (release.assets as Record<string, Record<string, unknown>>)[key]; const archive = await readFile(join(path, target.asset)); const info = await stat(join(path, target.asset))
    if (!asset || asset.target !== target.rustTarget || asset.asset !== target.asset || asset.url !== `https://github.com/xiopt/tmux-pane-dash/releases/download/v0.1.0/${target.asset}` || asset.sha256 !== sha256(archive) || asset.size !== info.size) throw new Error(`invalid release asset ${key}`)
    await inspectArchive(join(path, target.asset)); const files = tarFiles(archive); const internalBytes = files.get("manifest.json")
    if (!internalBytes) throw new Error("missing internal manifest")
    const internal = parseJson(internalBytes); if (!internalBytes.every((byte, index) => byte === canonicalJson(internal)[index]) || internal.schemaVersion !== 1 || internal.product !== "tmux-pane-dash" || internal.version !== "0.1.0" || internal.target !== target.rustTarget || internal.asset !== target.asset || !Array.isArray(internal.files) || internal.files.length !== 7) throw new Error("invalid internal manifest")
    const expected = ARCHIVE_PAYLOAD.filter(([name]) => name !== "manifest.json").map(([name]) => name).sort((a, b) => Buffer.from(a).compare(Buffer.from(b)))
    if ((internal.files as Array<Record<string, unknown>>).map((file) => file.path).join(",") !== expected.join(",")) throw new Error("internal manifest inventory is not exact")
    for (const file of internal.files as Array<Record<string, unknown>>) { const content = files.get(file.path as string); if (!content || file.sha256 !== sha256(content) || file.size !== content.length || !["0755", "0644"].includes(file.mode as string)) throw new Error("invalid internal file record") }
    checksumLines.push({ asset: target.asset, line: `${sha256(archive)}  ${target.asset}` })
  }
  if (decoder.decode(sums) !== checksumLines.sort((a, b) => Buffer.from(a.asset).compare(Buffer.from(b.asset))).map(({ line }) => line).join("\n") + "\n") throw new Error("invalid SHA256SUMS")
}

if (import.meta.main) {
  const directory = process.argv[2]; if (!directory) throw new Error("usage: verify-artifacts.ts DIRECTORY")
  await verifyReleaseDirectory(directory); console.log("archives=4 assets=6 inventories=exact reproducible=PASS")
}
