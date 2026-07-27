import { createHash } from "node:crypto"
import { dirname, join, relative, resolve } from "node:path"
import { parseJsonc } from "../config-opencode"
import { managedTmuxBlock } from "../config-tmux"
import { managedRoot, type OwnershipRecord } from "../ownership"
import type { Dependencies, DoctorFs } from "../runtime"

export const DOCTOR_CHECK_IDS = [
  "ownership.schema", "ownership.paths", "transaction.complete", "current.link", "current.target",
  "inventory.entries", "inventory.metadata", "binary.version", "tmux.version", "tmux.config",
  "tmux.server", "opencode.config", "ownership.managed-paths",
] as const

export type DoctorStatus = "ok" | "warning" | "error"
export type DoctorCheck = { id: typeof DOCTOR_CHECK_IDS[number]; status: DoctorStatus; code: string | null; message: string }
export type DoctorReport = { schemaVersion: 1; healthy: boolean; packageVersion: string; installedVersion: string | null; target: string | null; checks: DoctorCheck[] }

const text = new TextDecoder(), control = /[\u0000-\u001f\u007f]/g, maxMessage = 160
const clean = (value: unknown) => String(value instanceof Error ? value.message : value).replace(control, " ").replace(/(?:authorization|cookie|token)\s*[:=]\s*\S+/gi, "$1=<redacted>").replace(/\/[A-Za-z0-9_.~%+@=,:;-]+(?:\/[A-Za-z0-9_.~%+@=,:;-]+)*/g, "<path>").replace(/\s+/g, " ").trim().slice(0, maxMessage) || "operation failed"
const missing = (error: unknown) => typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT"
const exactKeys = (value: unknown, keys: readonly string[]) => !!value && typeof value === "object" && Object.keys(value as object).sort().join("\0") === [...keys].sort().join("\0")
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const childEnv = (tmuxTmpdir: string | undefined) => ({ PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C", ...(tmuxTmpdir?.startsWith("/") ? { TMUX_TMPDIR: tmuxTmpdir } : {}) })

function selectedTarget(deps: Dependencies): string | null {
  const assets = (deps.manifest as any)?.assets
  const key = `${deps.platform}-${deps.arch === "arm64" ? "arm64" : deps.arch === "x64" ? "x64" : deps.arch}`
  return typeof assets?.[key]?.target === "string" ? assets[key].target : null
}
async function root(deps: Dependencies): Promise<string> { return managedRoot(deps.env) }
async function exists(fs: DoctorFs, path: string): Promise<boolean> { try { await fs.stat(path); return true } catch (error) { if (missing(error)) return false; throw error } }
async function selectDoctorOpenCodeConfig(fs: DoctorFs, env: Dependencies["env"]): Promise<string> {
  const directory = env?.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, "opencode") : env?.HOME ? join(env.HOME, ".config", "opencode") : (() => { throw new Error("OpenCode root is unavailable") })()
  const json = join(directory, "opencode.json"), jsonc = join(directory, "opencode.jsonc"), [hasJson, hasJsonc] = await Promise.all([exists(fs, json), exists(fs, jsonc)])
  if (!hasJson && !hasJsonc) return json
  if (hasJson && !hasJsonc) return json
  if (!hasJson && hasJsonc) return jsonc
  const [left, right] = await Promise.all([fs.stat(json), fs.stat(jsonc)])
  if (left.kind !== "file" || right.kind !== "file" || left.dev !== right.dev || left.ino !== right.ino) throw new Error("OpenCode config selection is ambiguous")
  return json
}
async function read(fs: DoctorFs, path: string): Promise<Uint8Array> { return fs.readFile(path) }
function check(id: typeof DOCTOR_CHECK_IDS[number], status: DoctorStatus, code: string | null, message: string): DoctorCheck { return { id, status, code, message: clean(message) } }
function ownershipValid(value: unknown): value is OwnershipRecord {
  if (!exactKeys(value, ["schemaVersion", "packageVersion", "releaseVersion", "archive", "files", "currentTarget", "components", "migrations"])) return false
  const record = value as any
  return record.schemaVersion === 1 && typeof record.packageVersion === "string" && typeof record.releaseVersion === "string" && exactKeys(record.archive, ["target", "sha256"]) && typeof record.archive.target === "string" && /^[a-f0-9]{64}$/.test(record.archive.sha256) && Array.isArray(record.files) && exactKeys(record.components, ["tmux", "opencode"]) && Array.isArray(record.migrations)
}
async function loadOwnership(fs: DoctorFs, installRoot: string): Promise<OwnershipRecord> {
  const value = JSON.parse(text.decode(await read(fs, join(installRoot, "state", "ownership.json"))))
  if (!ownershipValid(value)) throw new Error("ownership schema is invalid")
  return value
}
function inRoot(installRoot: string, path: string): boolean { const rel = relative(resolve(installRoot), resolve(path)); return rel !== "" && !rel.startsWith("..") && !rel.includes("/../") }
function tmuxVersion(value: string): boolean { const match = /^tmux\s+(\d+)\.(\d+)(?:\.|[a-z]|\s|$)/.exec(value.trim()); return !!match && (Number(match[1]) > 3 || Number(match[1]) === 3 && Number(match[2]) >= 6) }
async function run(deps: Dependencies, path: string, args: readonly string[]) { if (!deps.spawn) throw new Error("child execution unavailable"); return deps.spawn(path, args, { timeoutMs: 5_000, env: childEnv(deps.env?.TMUX_TMPDIR), maxOutputBytes: 8 * 1024 }) }
type TmuxBinding = { action: string }
function tmuxBindings(output: string): TmuxBinding[] {
  return output.split("\n").flatMap(line => {
    const match = /^bind(?:-key)?\s+-T\s+prefix\s+\S+\s+(.+)$/.exec(line)
    return match ? [{ action: match[1]! }] : []
  })
}
function hasDistinctBindings(bindings: readonly TmuxBinding[], predicates: readonly ((action: string) => boolean)[]): boolean {
  const matches = predicates.map(predicate => bindings.flatMap((binding, index) => predicate(binding.action) ? [index] : []))
  return matches.every(records => records.length === 1) && new Set(matches.flat()).size === predicates.length
}

export async function doctor(deps: Dependencies): Promise<DoctorReport> {
  const fs = deps.doctorFs
  const fallback = (): DoctorReport => ({ schemaVersion: 1, healthy: false, packageVersion: deps.executingVersion, installedVersion: null, target: selectedTarget(deps), checks: [check("ownership.schema", "error", "E_DOCTOR", "unable to form doctor report")] })
  if (!fs) return fallback()
  try {
    const installRoot = await root(deps), checks: DoctorCheck[] = [], ownershipPath = join(installRoot, "state", "ownership.json")
    let ownership: OwnershipRecord | null = null
    try { ownership = await loadOwnership(fs, installRoot); checks.push(check("ownership.schema", "ok", null, "ownership schema matches")) } catch (error) { checks.push(check("ownership.schema", "error", "E_OWNERSHIP", `ownership unavailable: ${clean(error)}`)) }
    const version = ownership?.releaseVersion ?? null, versionRoot = version ? join(installRoot, "versions", version) : null
    try {
      const components = ownership?.components
      const validComponent = (value: any) => value === null || exactKeys(value, ["logicalPath", "resolvedPath", "marker", "packageEntries", "baselineBackup"]) && typeof value.logicalPath === "string" && typeof value.resolvedPath === "string" && typeof value.marker === "string" && Array.isArray(value.packageEntries) && exactKeys(value.baselineBackup, ["logicalPath", "sha256"]) && typeof value.baselineBackup.logicalPath === "string" && /^[a-f0-9]{64}$/.test(value.baselineBackup.sha256)
      if (!ownership || !versionRoot || ownership.currentTarget !== `versions/${version}` || ownership.files.some(file => !inRoot(installRoot, file.logicalPath) || !inRoot(installRoot, file.resolvedPath)) || !validComponent(components?.tmux) || !validComponent(components?.opencode)) throw new Error("owned paths are invalid")
      checks.push(check("ownership.paths", "ok", null, "ownership paths match"))
    } catch (error) { checks.push(check("ownership.paths", "error", "E_OWNERSHIP_PATH", clean(error))) }
    try {
      const entries = await fs.readdir(join(installRoot, "transactions")); if (entries.some(entry => entry !== "lock")) throw new Error("incomplete transaction exists")
      checks.push(check("transaction.complete", "ok", null, "no incomplete transaction"))
    } catch (error) { checks.push(check("transaction.complete", "error", "E_TRANSACTION", clean(error))) }
    try {
      const current = join(installRoot, "current"), info = await fs.stat(current), target = await fs.readlink(current)
      if (info.kind !== "symlink" || target.startsWith("/") || target !== ownership?.currentTarget) throw new Error("current link is not the owned relative target")
      checks.push(check("current.link", "ok", null, "current link is relative"))
    } catch (error) { checks.push(check("current.link", "error", "E_CURRENT_LINK", clean(error))) }
    try {
      if (!ownership || !versionRoot || ownership.currentTarget !== `versions/${ownership.releaseVersion}` || await fs.readlink(join(installRoot, "current")) !== ownership.currentTarget) throw new Error("current target does not name installed version")
      const info = await fs.stat(versionRoot); if (info.kind !== "directory") throw new Error("installed version directory is missing")
      checks.push(check("current.target", "ok", null, "current target matches installed version"))
    } catch (error) { checks.push(check("current.target", "error", "E_CURRENT_TARGET", clean(error))) }
    try {
      if (!ownership || !versionRoot) throw new Error("no installed inventory")
      const expected = new Set([...ownership.files.map(file => file.logicalPath.slice(versionRoot.length + 1)), "manifest.json"])
      const actual: string[] = []
      const walk = async (directory: string, prefix = ""): Promise<void> => { for (const name of await fs.readdir(directory)) { const path = join(directory, name), item = await fs.stat(path), logical = prefix ? `${prefix}/${name}` : name; if (item.kind === "directory") await walk(path, logical); else actual.push(logical) } }
      await walk(versionRoot); if (actual.length !== expected.size || actual.some(path => !expected.has(path))) throw new Error("installed inventory differs")
      checks.push(check("inventory.entries", "ok", null, "installed inventory matches"))
    } catch (error) { checks.push(check("inventory.entries", "error", "E_INVENTORY", clean(error))) }
    try {
      if (!ownership || !versionRoot) throw new Error("no installed manifest")
      const manifest = JSON.parse(text.decode(await read(fs, join(versionRoot, "manifest.json"))))
      if (!exactKeys(manifest, ["schemaVersion", "product", "version", "target", "asset", "files"]) || manifest.version !== ownership.releaseVersion || manifest.target !== ownership.archive.target || !Array.isArray(manifest.files)) throw new Error("internal manifest is invalid")
      for (const file of ownership.files) { const item = await fs.stat(file.resolvedPath), bytes = await read(fs, file.resolvedPath); if (item.kind !== file.type || item.mode !== file.mode || item.size !== bytes.length || hash(bytes) !== file.sha256) throw new Error("owned payload metadata differs") }
      checks.push(check("inventory.metadata", "ok", null, "payload metadata matches"))
    } catch (error) { checks.push(check("inventory.metadata", "error", "E_PAYLOAD", clean(error))) }
    try {
      if (!versionRoot || !version) throw new Error("binary is unavailable")
      const result = await run(deps, join(versionRoot, "bin", "pane-dash"), ["--version"])
      if (result.code !== 0 || result.stdout !== `pane-dash ${version}\n` || result.stderr !== "") throw new Error("binary version output differs")
      checks.push(check("binary.version", "ok", null, "binary version matches"))
    } catch (error) { checks.push(check("binary.version", "error", "E_BINARY", clean(error))) }
    try { const result = await run(deps, "tmux", ["-V"]); if (result.code !== 0 || result.stderr !== "" || !tmuxVersion(result.stdout)) throw new Error("tmux 3.6 or newer is required"); checks.push(check("tmux.version", "ok", null, "tmux version is supported")) } catch (error) { checks.push(check("tmux.version", "error", "E_TMUX", clean(error))) }
    try {
      const owned = ownership?.components.tmux
      if (!owned || !deps.env?.HOME || owned.logicalPath !== join(deps.env.HOME, ".tmux.conf") || owned.marker !== managedTmuxBlock(installRoot)) throw new Error("owned tmux route is invalid")
      const config = text.decode(await read(fs, owned.resolvedPath)), marker = owned.marker
       if (config.split(marker).length !== 2) throw new Error("owned tmux marker differs")
      checks.push(check("tmux.config", "ok", null, "tmux marker and route match"))
    } catch (error) { checks.push(check("tmux.config", "error", "E_TMUX_CONFIG", clean(error))) }
    try {
      const result = await run(deps, "tmux", ["list-keys", "-T", "prefix"])
      if (result.code !== 0) checks.push(check("tmux.server", "warning", "W_TMUX_SERVER", "tmux server is not running"))
       else {
         const current = join(installRoot, "current"), bindings = tmuxBindings(result.stdout)
          const valid = hasDistinctBindings(bindings, [
            action => action.includes("run-shell") && action.includes(`${current}/scripts/open.sh`),
            action => action.includes("run-shell") && action.includes(`${current}/scripts/tag.sh`) && /\btoggle\b/.test(action),
            action => action.includes("command-prompt") && action.includes(`${current}/scripts/tag.sh`) && /\blabel-from-option\b/.test(action),
          ])
          if (result.stderr || !valid) checks.push(check("tmux.server", "error", "E_TMUX_BINDINGS", "tmux bindings do not match"))
         else checks.push(check("tmux.server", "ok", null, "tmux bindings use current route"))
       }
    } catch { checks.push(check("tmux.server", "warning", "W_TMUX_SERVER", "tmux server is not running")) }
    try {
      const owned = ownership?.components.opencode
      if (!owned) throw new Error("OpenCode ownership is missing")
      const selected = await selectDoctorOpenCodeConfig(fs, deps.env), expected = `@xiopt/pane-dash-opencode@${deps.executingVersion}`
      if (selected !== owned.logicalPath || owned.packageEntries.length !== 1 || owned.packageEntries[0] !== expected) throw new Error("OpenCode selection or ownership differs")
       const config = parseJsonc(text.decode(await read(fs, owned.resolvedPath))) as { plugin?: unknown }, entries = config?.plugin
       if (!Array.isArray(entries) || entries.filter((entry: unknown) => entry === expected).length !== 1) throw new Error("OpenCode plugin entries differ")
      checks.push(check("opencode.config", "ok", null, "OpenCode plugin entry matches"))
    } catch (error) { checks.push(check("opencode.config", "error", "E_OPENCODE", clean(error))) }
    try {
      if (!ownership) throw new Error("ownership is unavailable")
      for (const file of ownership.files) { if (!inRoot(installRoot, file.logicalPath) || !inRoot(installRoot, file.resolvedPath)) throw new Error("managed path escapes root") }
      if (await exists(fs, ownershipPath) === false) throw new Error("ownership file is missing")
      checks.push(check("ownership.managed-paths", "ok", null, "all managed paths are owned"))
    } catch (error) { checks.push(check("ownership.managed-paths", "error", "E_MANAGED_PATH", clean(error))) }
    return { schemaVersion: 1, healthy: !checks.some(item => item.status === "error"), packageVersion: deps.executingVersion, installedVersion: version, target: ownership?.archive.target ?? selectedTarget(deps), checks }
  } catch (error) { return { ...fallback(), checks: [check("ownership.schema", "error", "E_DOCTOR", `unable to form doctor report: ${clean(error)}`)] } }
}

export function renderDoctorJson(report: DoctorReport): string { return `${JSON.stringify(report)}\n` }
export function renderDoctorHuman(report: DoctorReport): string { return `${report.checks.map(item => `${item.id}: ${item.status}${item.code ? ` (${item.code})` : ""} ${item.message}`).join("\n")}\n${report.healthy ? "healthy" : "unhealthy"}\n` }
