import { lstat, readdir, realpath } from "node:fs/promises"
import { join, resolve } from "node:path"
import { CliError } from "./errors"
import { resolveConfigPath } from "./fs"
import type { Dependencies } from "./runtime"
import type { PlannedConfigMutation } from "./transaction"

const desired = "@xiopt/pane-dash-opencode@0.1.0", encoder = new TextEncoder(), decoder = new TextDecoder()
export type OpenCodeEditInput = Omit<PlannedConfigMutation, "bytes"> & { bytes: Uint8Array; migrate: boolean; ownedEntries?: readonly string[] }
export type PlannedOpenCodeMigration = { logicalPath: string; resolvedPath: string; action: "unlink" }
const fail = (code = "E_CONFIG") => { throw new CliError(code) }
const missing = (error: unknown) => typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT"

export async function selectOpenCodeConfig(env: Dependencies["env"], deps: Dependencies): Promise<string> {
  const root = env?.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, "opencode") : env?.HOME ? join(env.HOME, ".config", "opencode") : fail("E_ROOT")
  const json = join(root, "opencode.json"), jsonc = join(root, "opencode.jsonc")
  const exists = async (path: string) => { try { await lstat(path); return true } catch (error) { if (missing(error)) return false; throw error } }
  const [hasJson, hasJsonc] = await Promise.all([exists(json), exists(jsonc)])
  if (!hasJson && !hasJsonc) return json
  if (hasJson && !hasJsonc) return json
  if (!hasJson && hasJsonc) return jsonc
  const [left, right] = await Promise.all([resolveConfigPath(json, deps), resolveConfigPath(jsonc, deps)])
  const [leftInfo, rightInfo] = await Promise.all([lstat(left.resolvedPath), lstat(right.resolvedPath)])
  if (!leftInfo.isFile() || !rightInfo.isFile() || leftInfo.dev !== rightInfo.dev || leftInfo.ino !== rightInfo.ino) fail("E_CONFIG_AMBIGUOUS")
  return json
}

/** Plans, but never performs, removal of the one historical global plugin link. */
export async function planOpenCodeMigration(input: { configDirectory: string; installRoot: string; migrate: boolean }): Promise<readonly PlannedOpenCodeMigration[]> {
  const names = new Set(["pane-dash.ts", "pane-dash.js", "pane_dash.ts", "pane_dash.js"]), candidates: string[] = []
  for (const directory of [join(input.configDirectory, "plugin"), join(input.configDirectory, "plugins")]) {
    let entries: string[]
    try { entries = await readdir(directory) } catch (error) { if (missing(error)) continue; throw error }
    for (const name of entries) if (names.has(name)) candidates.push(join(directory, name))
  }
  if (!candidates.length) return []
  if (!input.migrate || candidates.length !== 1) fail("E_CONFIG_CONFLICT")
  const logicalPath = candidates[0]!, entry = await lstat(logicalPath)
  if (!entry.isSymbolicLink()) fail("E_CONFIG_CONFLICT")
  let resolvedPath: string, known: string
  try { [resolvedPath, known] = await Promise.all([realpath(logicalPath), realpath(join(input.installRoot, "opencode-plugin", "pane-dash.ts"))]) } catch { fail("E_CONFIG_CONFLICT") }
  if (resolvedPath! !== known!) fail("E_CONFIG_CONFLICT")
  return [{ logicalPath, resolvedPath: resolvedPath!, action: "unlink" }]
}

function space(text: string, index: number): number { for (;;) { while (/\s/.test(text[index] ?? "")) index += 1; if (text.startsWith("//", index)) { const end = text.indexOf("\n", index + 2); index = end < 0 ? text.length : end + 1; continue } if (text.startsWith("/*", index)) { const end = text.indexOf("*/", index + 2); if (end < 0) fail(); index = end + 2; continue } return index } }
function stringAt(text: string, index: number): { value: string; end: number } { if (text[index] !== '"') fail(); let end = index + 1, escaped = false; while (end < text.length) { const char = text[end++]!; if (escaped) { escaped = false; continue } if (char === "\\") { escaped = true; continue } if (char === '"') { try { return { value: JSON.parse(text.slice(index, end)), end } } catch { fail() } } } fail() }
function close(text: string, index: number, open: string, endChar: string) { let depth = 0; for (; index < text.length; index += 1) { index = space(text, index); if (text[index] === '"') { index = stringAt(text, index).end - 1; continue } if (text[index] === open) depth += 1; if (text[index] === endChar && --depth === 0) return index } fail() }
type Plugin = { start: number; end: number; values: string[] }
function rootPlugin(text: string): Plugin | null {
  let index = space(text, 0); if (text[index++] !== "{") fail(); let plugin: Plugin | null = null
  for (;;) { index = space(text, index); if (text[index] === "}") { if (space(text, index + 1) !== text.length) fail(); return plugin } const key = stringAt(text, index); index = space(text, key.end); if (text[index++] !== ":") fail(); index = space(text, index)
    if (key.value === "plugin") { if (plugin || text[index] !== "[") fail(); const start = index, end = close(text, index, "[", "]"), values: string[] = []; let item = start + 1
      for (;;) { item = space(text, item); if (text[item] === "]") break; const value = stringAt(text, item); values.push(value.value); item = space(text, value.end); if (text[item] === ",") { item += 1; continue } if (text[item] !== "]") fail() }
      plugin = { start, end: end + 1, values }; index = end + 1
    } else { if (text[index] === "[") index = close(text, index, "[", "]") + 1; else if (text[index] === "{") index = close(text, index, "{", "}") + 1; else if (text[index] === '"') index = stringAt(text, index).end; else { const match = /^(?:true|false|null|-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(index)); if (!match) fail(); index += match[0].length } }
    index = space(text, index); if (text[index] === ",") { index += 1; continue } if (text[index] !== "}") fail()
  }
}
function validPaneDash(value: string) { return /^@xiopt\/pane-dash-opencode(?:@[0-9]+\.[0-9]+\.[0-9]+)?$/.test(value) || /pane-dash/i.test(value) }
function formatArray(old: string[], source: string): string {
  const trailing = /,\s*\]$/.test(source), body = old.map(JSON.stringify).join(", ")
  return `[${body}${body ? ", " : ""}${JSON.stringify(desired)}${trailing ? "," : ""}]`
}

export function planOpenCodeEdit(input: OpenCodeEditInput): PlannedConfigMutation {
  const text = decoder.decode(input.bytes), plugin = rootPlugin(text)
  if (plugin) {
    const matches = plugin.values.filter(value => value === desired)
    if (matches.length === 1 && !plugin.values.some(value => value !== desired && validPaneDash(value))) return { ...input, bytes: input.bytes }
    if (matches.length > 1 || plugin.values.some(value => value !== desired && validPaneDash(value)) && !input.ownedEntries?.some(value => plugin.values.includes(value))) fail("E_CONFIG_CONFLICT")
    return { ...input, bytes: encoder.encode(`${text.slice(0, plugin.start)}${formatArray(plugin.values, text.slice(plugin.start, plugin.end))}${text.slice(plugin.end)}`) }
  }
  const closeIndex = text.lastIndexOf("}"); if (closeIndex < 0) fail()
  const newline = text.includes("\r\n") ? "\r\n" : "\n", prefix = text.slice(0, closeIndex), indent = /(?:^|\n)([ \t]+)"/.exec(prefix)?.[1] ?? "  ", comma = /\{\s*$/.test(prefix) ? "" : ","
  return { ...input, bytes: encoder.encode(`${prefix}${comma}${newline}${indent}"plugin": [${JSON.stringify(desired)}]${newline}${text.slice(closeIndex)}`) }
}
