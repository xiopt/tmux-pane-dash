import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { constants } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { startLocalRegistry, type LocalPackage } from "../../scripts/release/local-registry"
import { resolveCompatibilityRows } from "./helpers/real-opencode"

const INITIALIZATION_COMMAND = ["run", "--command", "noop", "--print-logs", "--log-level", "DEBUG"] as const
const OPTIONS = ["@pane_dash_status", "@pane_dash_status_since", "@pane_dash_heartbeat", "@pane_dash_title", "@pane_dash_model"] as const
const root = resolve(import.meta.dir, "../..")
const pluginPackage = JSON.parse(await readFile(join(root, "opencode-plugin", "package.json"), "utf8")) as { version: string }
const PLUGIN_VERSION = pluginPackage.version
const SPEC = `@xiopt/pane-dash-opencode@${PLUGIN_VERSION}`

async function command(argv: string[], cwd = root, env = process.env, allowFailure = false): Promise<{ stdout: string; stderr: string; code: number }> {
  const child = Bun.spawn(argv, { cwd, env, stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (code !== 0 && !allowFailure) throw new Error(`${argv.join(" ")} failed (${code}): ${stderr}`)
  return { code, stdout, stderr }
}

const rows = await resolveCompatibilityRows(
  process.env.OPENCODE_1_17_20_BIN,
  process.env.OPENCODE_LATEST_BIN,
  async binary => (await command([binary, "--version"])).stdout,
  readFile,
)

async function pack(directory: string, destination: string): Promise<LocalPackage> {
  const node = process.env.NODE_20_BIN!, npm = process.env.NPM_20_CLI!
  const result = await command([node, npm, "pack", "--ignore-scripts", "--json", "--pack-destination", destination], directory)
  const metadata = JSON.parse(result.stdout)[0] as { filename: string; files: Array<{ path: string }> }
  const tarball = await readFile(join(destination, metadata.filename))
  const packageJson = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as { name: string; version: string }
  return {
    name: packageJson.name,
    version: packageJson.version,
    tarball,
    integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
  }
}

async function assertPackedPlugin(scratch: string): Promise<LocalPackage> {
  const packageRoot = join(root, "opencode-plugin")
  const plugin = await pack(packageRoot, scratch)
  const entries = (await command(["tar", "-tzf", join(scratch, `xiopt-pane-dash-opencode-${PLUGIN_VERSION}.tgz`)], root)).stdout.trim().split("\n").sort()
  expect(entries).toEqual(["package/LICENSE", "package/README.md", "package/dist/index.js", "package/dist/tui.js", "package/package.json"])
  return plugin
}

async function companion(scratch: string, version: string): Promise<LocalPackage> {
  const directory = join(scratch, `companion-${version}`)
  await mkdir(directory)
  await Promise.all([
    writeFile(join(directory, "package.json"), JSON.stringify({ name: "@opencode-ai/plugin", version, type: "module", exports: { ".": "./index.js" }, files: ["index.js"] })),
    writeFile(join(directory, "index.js"), "export {}\n"),
  ])
  const packed = await pack(directory, scratch)
  return packed
}

function parserProof(): void {
  const parserRoot = process.env.PANE_DASH_NPA_ROOT!
  expect(parserRoot).toMatch(/^\//)
  expect(relative(parserRoot, resolve(parserRoot))).toBe("")
  const require = createRequire(join(parserRoot, "package.json"))
  const npa = require("npm-package-arg") as (value: string) => { name: string; rawSpec: string }
  const parsed = npa(SPEC)
  expect(parsed.name).toBe("@xiopt/pane-dash-opencode")
  expect(parsed.rawSpec).toBe(PLUGIN_VERSION)
}

async function option(tmux: string, socket: string, target: string, name: string): Promise<string> {
  return (await command([tmux, "-L", socket, "show-options", "-pv", "-t", target, name], root, process.env, true)).stdout.trim()
}

async function waitFor(get: () => Promise<string>, timeout = 30_000): Promise<string> {
  const end = Date.now() + timeout
  while (Date.now() < end) { const value = await get(); if (value) return value; await Bun.sleep(100) }
  throw new Error("timed out waiting for tmux plugin state")
}

async function runVariant(row: typeof rows[number], extension: "json" | "jsonc", plugin: LocalPackage, companionPackage: LocalPackage): Promise<void> {
  const tmux = process.env.TMUX_BIN!, socket = `${process.env.PANE_DASH_TMUX_SOCKET}-${crypto.randomUUID().slice(0, 6)}`
  const scratch = await mkdtemp(join(process.env.TMPDIR || tmpdir(), "pane-dash-real-opencode-"))
  const registry = await startLocalRegistry({ host: "127.0.0.1", packages: new Map([[plugin.name, plugin], [companionPackage.name, companionPackage]]) })
  try {
    const config = join(scratch, "config", "opencode")
    const wrapper = join(scratch, "bin")
    await mkdir(config, { recursive: true }); await mkdir(wrapper)
    await writeFile(join(config, `opencode.${extension}`), extension === "json" ? JSON.stringify({ plugin: [SPEC] }) : `// real JSONC compatibility\n{ "plugin": [${JSON.stringify(SPEC)},], }\n`)
    await writeFile(join(scratch, "npmrc"), `registry=${registry.origin}\n@xiopt:registry=${registry.origin}\n@opencode-ai:registry=${registry.origin}\naudit=false\nfund=false\n`)
    const calls = join(scratch, "tmux-calls"), permit = join(scratch, "permit"), entered = join(scratch, "entered"), complete = join(scratch, "complete"), output = join(scratch, "opencode-output")
    await writeFile(join(wrapper, "tmux"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\nif [ "$#" -eq 5 ] && [ "$1" = set-option ] && [ "$2" = -pu ] && [ "$3" = -t ] && [ "$4" = "$TMUX_PANE" ]; then\n  case "$5" in\n    @pane_dash_status|@pane_dash_status_since|@pane_dash_heartbeat|@pane_dash_title|@pane_dash_model) : > ${JSON.stringify(entered)}; for _ in $(seq 1 300); do [ -f ${JSON.stringify(permit)} ] && break; sleep .1; done; [ -f ${JSON.stringify(permit)} ] || exit 1 ;;\n  esac\nfi\nexec ${JSON.stringify(tmux)} -L ${JSON.stringify(socket)} "$@"\n`)
    await chmod(join(wrapper, "tmux"), 0o700)
    const script = join(scratch, "run.sh")
    await writeFile(script, `#!/bin/sh\nenv HOME=${JSON.stringify(join(scratch, "home"))} XDG_DATA_HOME=${JSON.stringify(join(scratch, "data"))} XDG_CONFIG_HOME=${JSON.stringify(join(scratch, "config"))} XDG_CACHE_HOME=${JSON.stringify(join(scratch, "cache"))} npm_config_cache=${JSON.stringify(join(scratch, "npm-cache"))} npm_config_userconfig=${JSON.stringify(join(scratch, "npmrc"))} BUN_INSTALL_CACHE_DIR=${JSON.stringify(join(scratch, "bun-cache"))} PATH=${JSON.stringify(`${wrapper}:/usr/bin:/bin`)} /usr/bin/sandbox-exec -p '(version 1) (allow default) (deny network*) (allow network-outbound (remote ip "localhost:*")) (allow network-outbound (remote unix-socket))' ${JSON.stringify(row.binary)} ${INITIALIZATION_COMMAND.map(JSON.stringify).join(" ")} > ${JSON.stringify(output)} 2>&1 || true\n: > ${JSON.stringify(complete)}\nexec cat\n`)
    await chmod(script, 0o700)
    await writeFile(permit, "bootstrap\n")
    await command([tmux, "-L", socket, "-f", "/dev/null", "new-session", "-d", "-s", "bootstrap", script])
    await waitFor(async () => (await command(["test", "-f", complete], scratch, process.env, true)).code === 0 ? "complete" : "")
    expect(registry.requests.some(path => path.startsWith("/@xiopt"))).toBe(true)
    expect(registry.requests.some(path => path.startsWith("/@opencode-ai"))).toBe(true)
    const bootstrapRequests = [...registry.requests]
    await command([tmux, "-L", socket, "kill-session", "-t", "bootstrap"], root, process.env, true)
    await rm(permit, { force: true }); await rm(complete, { force: true }); await rm(entered, { force: true }); await writeFile(calls, "")
    await command([tmux, "-L", socket, "-f", "/dev/null", "new-session", "-d", "-s", "plugin", script])
    const target = "plugin:0.0"
    const status = await waitFor(() => option(tmux, socket, target, "@pane_dash_status")).catch(async error => { throw new Error(`${error.message}: ${await readFile(output, "utf8").catch(() => "")}`) })
    const heartbeat = await waitFor(() => option(tmux, socket, target, "@pane_dash_heartbeat"))
    expect(status).toBe("unknown"); expect(heartbeat).toMatch(/^\d{10}$/)
    await waitFor(async () => (await command(["test", "-f", entered], scratch, process.env, true)).code === 0 ? "entered" : "")
    await writeFile(permit, "ok\n")
    await waitFor(async () => (await command(["test", "-f", complete], scratch, process.env, true)).code === 0 ? "complete" : "")
    for (const name of OPTIONS) expect(await option(tmux, socket, target, name)).toBe("")
    expect((await readFile(calls, "utf8")).split("\n").filter(line => line.startsWith("set-option -pu -t "))).toHaveLength(OPTIONS.length)
    expect(registry.requests).toEqual(bootstrapRequests)
  } finally {
    await command([tmux, "-L", socket, "kill-server"], root, process.env, true)
    await registry.close(); await rm(scratch, { recursive: true, force: true })
  }
}

test("actual packed plugin loads through the loopback registry in JSON and JSONC", { timeout: 120_000 }, async () => {
  expect(process.env.NODE_20_BIN).toMatch(/^\//); expect(process.env.NPM_20_CLI).toMatch(/^\//)
  parserProof()
  const scratch = await mkdtemp(join(process.env.TMPDIR || tmpdir(), "pane-dash-plugin-pack-"))
  try {
    const plugin = await assertPackedPlugin(scratch)
    const companions = new Map<string, LocalPackage>()
    for (const row of rows) {
      let companionPackage = companions.get(row.version)
      if (!companionPackage) {
        companionPackage = await companion(scratch, row.version)
        companions.set(row.version, companionPackage)
      }
      await runVariant(row, "json", plugin, companionPackage); await runVariant(row, "jsonc", plugin, companionPackage)
      console.log(`${row.name} version=${row.version} sha256=${row.sha256} status=PASS cleanup=PASS public-network-requests=0`)
    }
  } finally { await rm(scratch, { recursive: true, force: true }) }
})
