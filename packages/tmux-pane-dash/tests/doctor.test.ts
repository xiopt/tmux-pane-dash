import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { DOCTOR_CHECK_IDS, doctor, renderDoctorHuman, renderDoctorJson } from "../src/commands/doctor"
import { managedTmuxBlock } from "../src/config-tmux"
import type { Dependencies, DoctorFs } from "../src/runtime"

const root = "/data/tmux-pane-dash", version = "0.1.0", versionRoot = `${root}/versions/${version}`, config = "/home/.config/opencode/opencode.json"
const digest = (value: string) => createHash("sha256").update(value).digest("hex")
const payload = [["bin/pane-dash", "binary", 0o755], ["pane_dash.tmux", "tmux", 0o755], ["scripts/open.sh", "open", 0o755], ["scripts/tag.sh", "tag", 0o755], ["README.md", "readme", 0o644], ["LICENSE", "license", 0o644], ["VERSION", "0.1.0\n", 0o644]] as const

function fixture(fault?: string) {
  const marker = managedTmuxBlock(root)
  const files = payload.map(([path, content, mode]) => ({ logicalPath: `${versionRoot}/${path}`, resolvedPath: `${versionRoot}/${path}`, sha256: digest(content), mode, type: "file" as const }))
  if (fault === "ownership.paths" || fault === "ownership.managed-paths") files[0] = { ...files[0]!, logicalPath: "/outside/pane-dash", resolvedPath: "/outside/pane-dash" }
  const tmuxConfig = fault === "tmux.config" ? "set -g @pane-dash-engine old\n" : marker, openCodeConfig = fault === "opencode.config" ? "not json" : '{"plugin":["@xiopt/pane-dash-opencode@0.1.0"]}'
  const ownership = { schemaVersion: 1, packageVersion: version, releaseVersion: version, archive: { target: "x86_64-unknown-linux-musl", sha256: "0".repeat(64) }, files, currentTarget: `versions/${version}`, components: { tmux: { logicalPath: "/home/.tmux.conf", resolvedPath: "/home/.tmux.conf", marker, packageEntries: [], baselineBackup: { logicalPath: "/home/.tmux.conf", sha256: digest(tmuxConfig) } }, opencode: { logicalPath: config, resolvedPath: config, marker: "@xiopt/pane-dash-opencode@0.1.0", packageEntries: ["@xiopt/pane-dash-opencode@0.1.0"], baselineBackup: { logicalPath: config, sha256: digest(openCodeConfig) } } }, migrations: [] }
  const manifest = { schemaVersion: 1, product: "tmux-pane-dash", version, target: ownership.archive.target, asset: "asset", files: payload.map(([path, content, mode]) => ({ path, sha256: digest(content), size: content.length, mode: mode.toString(8).padStart(4, "0") })) }
  const bytes = new Map<string, string>([[`${root}/state/ownership.json`, JSON.stringify(fault === "ownership.schema" ? { nope: true } : ownership)], [`${versionRoot}/manifest.json`, JSON.stringify(fault === "inventory.metadata" ? { ...manifest, version: "bad" } : manifest)], ["/home/.tmux.conf", tmuxConfig], [config, openCodeConfig]])
  for (const [path, content] of payload) bytes.set(`${versionRoot}/${path}`, fault === "inventory.metadata" && path === "README.md" ? "changed" : content)
  const info = (path: string) => {
    if (fault === "current.link" && path === `${root}/current`) return { kind: "file" as const, mode: 0o644, size: 0 }
    if (path === root || path === `${root}/versions` || path === versionRoot || path === `${versionRoot}/bin` || path === `${versionRoot}/scripts`) return { kind: "directory" as const, mode: 0o700, size: 0, dev: 1, ino: 1 }
    if (path === `${root}/current`) return { kind: "symlink" as const, mode: 0o777, size: 14 }
    if (bytes.has(path)) return { kind: "file" as const, mode: payload.find(([name]) => `${versionRoot}/${name}` === path)?.[2] ?? 0o600, size: Buffer.byteLength(bytes.get(path)!), dev: 1, ino: path === config ? 2 : 3 }
    throw Object.assign(new Error(`missing ${path}`), { code: "ENOENT" })
  }
  let bindings = [
    `bind-key -T prefix D run-shell '${root}/current/scripts/open.sh' '${root}/current/bin/pane-dash' '#{client_tty}' '#{session_id}' '#{pane_id}'`,
    `bind-key -T prefix T run-shell \"${root}/current/scripts/tag.sh\" toggle '#{pane_id}'`,
    `bind-key -T prefix M command-prompt -p 'pane-dash label:' \"set-option -p @pane_dash_label_input \\\"%%%\\\" ; run-shell '\"${root}/current/scripts/tag.sh\" label-from-option \\\"#{pane_id}\\\"'\"`,
  ].join("\n")
  const calls = { fetch: 0, lock: 0, mutations: 0, child: 0 }
  const fs: DoctorFs = { stat: async path => info(path), readFile: async path => { const value = bytes.get(path); if (value === undefined) throw Object.assign(new Error(`missing ${path}`), { code: "ENOENT" }); return new TextEncoder().encode(value) }, readlink: async path => { if (path !== `${root}/current`) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return fault === "current.target" ? "versions/bad" : `versions/${version}` }, readdir: async path => {
    if (path === `${root}/transactions`) return fault === "transaction.complete" ? ["pending"] : []
    if (path === versionRoot) return fault === "inventory.entries" ? ["bin", "scripts", "README.md"] : ["bin", "scripts", "pane_dash.tmux", "README.md", "LICENSE", "VERSION", "manifest.json"]
    if (path === `${versionRoot}/bin`) return ["pane-dash"]
    if (path === `${versionRoot}/scripts`) return ["open.sh", "tag.sh"]
    throw Object.assign(new Error(`missing ${path}`), { code: "ENOENT" })
  } }
  const deps: Dependencies = { manifest: {}, platform: "linux", arch: "x64", executingVersion: version, env: { XDG_DATA_HOME: "/data", HOME: "/home" }, doctorFs: fs, fetch: async () => { calls.fetch += 1; throw new Error("fetch") }, lock: () => { calls.lock += 1 }, spawn: async (path, args, options) => {
    calls.child += 1; expect(options.timeoutMs).toBe(5_000); expect(options.maxOutputBytes).toBe(8 * 1024); expect(options.env).toEqual({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" })
    if (fault === "binary.version" && path.includes("pane-dash")) return { code: 1, stdout: "bad\n", stderr: "" }
    if (fault === "tmux.version" && args[0] === "-V") return { code: 0, stdout: "tmux 3.5\n", stderr: "" }
    if (args[0] === "-V") return { code: 0, stdout: "tmux 3.6\n", stderr: "" }
    if (fault === "tmux.server") return { code: 1, stdout: "", stderr: "no server" }
    return { code: 0, stdout: path === "tmux" ? bindings : "pane-dash 0.1.0\n", stderr: "" }
  } }
  return {
    deps,
    calls,
    tree: () => JSON.stringify([...bytes].sort(([left], [right]) => left.localeCompare(right))),
    mutate: (path: string, value: string) => bytes.set(path, value),
    setBindings: (value: string) => { bindings = value },
  }
}

test("doctor is offline read-only and stable", async () => {
  const h = fixture(), before = h.tree(), report = await doctor(h.deps)
  expect(report.healthy).toBeTrue()
  expect(report.checks.map(check => check.id)).toEqual(DOCTOR_CHECK_IDS)
  expect(h.calls.fetch + h.calls.lock + h.calls.mutations).toBe(0)
  expect(h.tree()).toBe(before)
})

test.each(["ownership.schema", "ownership.paths", "transaction.complete", "current.link", "current.target", "inventory.entries", "inventory.metadata", "binary.version", "tmux.version", "tmux.config", "opencode.config", "ownership.managed-paths"])("doctor records %s failures without mutation", async id => {
  const h = fixture(id), before = h.tree(), report = await doctor(h.deps)
  expect(report.healthy).toBeFalse()
  expect(report.checks.find(check => check.id === id)?.status).toBe("error")
  expect(h.calls.fetch + h.calls.lock + h.calls.mutations).toBe(0)
  expect(h.tree()).toBe(before)
})

test("server absence is the only warning and output is canonical", async () => {
  const report = await doctor(fixture("tmux.server").deps)
  expect(report.checks.find(check => check.id === "tmux.server")).toMatchObject({ status: "warning" })
  expect(renderDoctorJson(report)).toBe(`${JSON.stringify(report)}\n`)
  expect(renderDoctorHuman(report).split("\n")).toHaveLength(DOCTOR_CHECK_IDS.length + 2)
})

test("doctor accepts valid lossless JSONC and unrelated owned-config changes", async () => {
  const h = fixture()
  h.mutate("/home/.tmux.conf", `${managedTmuxBlock(root)}\nset -g status-style bg=blue\n`)
  h.mutate(config, `{
    // unrelated comment
    "plugin": [
      "@xiopt/pane-dash-opencode@0.1.0", // owned package
      "other-plugin", // unrelated plugin
    ],
    "nested": { "items": ["https://example.test//literal", "/* literal */",], },
  }`)
  expect((await doctor(h.deps)).healthy).toBeTrue()
})

test("doctor detects changes to its exact managed markers and package entry", async () => {
  const tmux = fixture()
  tmux.mutate("/home/.tmux.conf", managedTmuxBlock(root).replace("run-shell", "# run-shell"))
  expect((await doctor(tmux.deps)).checks.find(check => check.id === "tmux.config")?.status).toBe("error")

  const opencode = fixture()
  opencode.mutate(config, '{"plugin":["@xiopt/pane-dash-opencode@0.1.1"]}')
  expect((await doctor(opencode.deps)).checks.find(check => check.id === "opencode.config")?.status).toBe("error")
})

test("doctor validates distinct owned tmux binding records", async () => {
  const valid = fixture()
  expect((await doctor(valid.deps)).checks.find(check => check.id === "tmux.server")?.status).toBe("ok")

  for (const [description, bindings] of [
    ["missing label key", `bind-key -T prefix D run-shell '${root}/current/scripts/open.sh'\nbind-key -T prefix T run-shell \"${root}/current/scripts/tag.sh\" toggle`],
    ["wrong label key", `bind-key -T prefix D run-shell '${root}/current/scripts/open.sh'\nbind-key -T prefix T run-shell \"${root}/current/scripts/tag.sh\" toggle\nbind-key -T prefix T command-prompt label-from-option '${root}/current/scripts/tag.sh'`],
    ["stale dashboard route", `bind-key -T prefix D run-shell '${root}/old/current/scripts/open.sh'\nbind-key -T prefix T run-shell \"${root}/current/scripts/tag.sh\" toggle\nbind-key -T prefix M command-prompt label-from-option '${root}/current/scripts/tag.sh'`],
    ["wrong tag action", `bind-key -T prefix D run-shell '${root}/current/scripts/open.sh'\nbind-key -T prefix T run-shell \"${root}/current/scripts/tag.sh\"\nbind-key -T prefix M command-prompt label-from-option '${root}/current/scripts/tag.sh'`],
    ["duplicate dashboard key", `bind-key -T prefix D run-shell '${root}/current/scripts/open.sh'\nbind-key -T prefix D run-shell '${root}/current/scripts/open.sh'\nbind-key -T prefix T run-shell \"${root}/current/scripts/tag.sh\" toggle\nbind-key -T prefix M command-prompt label-from-option '${root}/current/scripts/tag.sh'`],
  ]) {
    const h = fixture()
    h.setBindings(bindings)
    expect((await doctor(h.deps)).checks.find(check => check.id === "tmux.server")?.status, description).toBe("error")
  }
})

test("fatal report and messages remain bounded and safe", async () => {
  const report = await doctor({ manifest: {}, platform: "linux", arch: "x64", executingVersion: version })
  expect(report).toMatchObject({ schemaVersion: 1, healthy: false, checks: [{ status: "error" }] })
  expect(report.checks).toHaveLength(1)
})
