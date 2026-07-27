import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export async function installedFixture(version = "0.1.0") {
  const root = await mkdtemp(join(tmpdir(), "pane-dash-acquire-"))
  const versionDirectory = join(root, version)
  await mkdir(versionDirectory, { recursive: true })
  await writeFile(join(versionDirectory, "VERSION"), `${version}\n`)
  const calls = { fetch: 0, child: 0, fs: 0 }
  const asset = "tmux-pane-dash-v0.1.0-x86_64-unknown-linux-musl.tar.gz"
  return { root, versionDirectory, calls, context: { versionDirectory, stagingRoot: join(root, "stage"), record: { target: "x86_64-unknown-linux-musl", asset, url: `https://github.com/xiopt/tmux-pane-dash/releases/download/v0.1.0/${asset}`, sha256: "0".repeat(64), size: 0 }, deps: { manifest: {}, platform: "linux", arch: "x64", executingVersion: version, fetch: async () => { calls.fetch += 1; return { status: 500 } } } } }
}
