import { lstat, readdir, realpath, stat } from "node:fs/promises"
import { join, resolve } from "node:path"
import { CliError } from "./errors"
import { resolveConfigPath } from "./fs"
import type { Dependencies } from "./runtime"
import type { PlannedConfigMutation } from "./transaction"

const encoder = new TextEncoder(), decoder = new TextDecoder()
export type OpenCodeEditInput = Omit<PlannedConfigMutation, "bytes"> & { bytes: Uint8Array; migrate: boolean; packageEntry?: string; ownedEntries?: readonly string[] }
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

export function selectOpenCodeTuiConfig(env: Dependencies["env"]): string {
  const root = env?.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, "opencode") : env?.HOME ? join(env.HOME, ".config", "opencode") : fail("E_ROOT")
  return join(root, "tui.json")
}

/** Plans, but never performs, removal of the one historical global plugin link. */
export async function planOpenCodeMigration(input: { configDirectory: string; migrate: boolean }): Promise<readonly PlannedOpenCodeMigration[]> {
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
  let resolvedPath: string
  try {
    resolvedPath = await realpath(logicalPath)
    if (!resolvedPath.endsWith("/tmux-pane-dash/opencode-plugin/pane-dash.ts") || !(await stat(resolvedPath)).isFile()) fail("E_CONFIG_CONFLICT")
  } catch { fail("E_CONFIG_CONFLICT") }
  return [{ logicalPath, resolvedPath: resolvedPath!, action: "unlink" }]
}

function space(text: string, index: number): number { for (;;) { while (/\s/.test(text[index] ?? "")) index += 1; if (text.startsWith("//", index)) { const end = text.indexOf("\n", index + 2); index = end < 0 ? text.length : end + 1; continue } if (text.startsWith("/*", index)) { const end = text.indexOf("*/", index + 2); if (end < 0) fail(); index = end + 2; continue } return index } }
function stringAt(text: string, index: number): { value: string; start: number; end: number } { if (text[index] !== '"') fail(); const start = index; let end = index + 1, escaped = false; while (end < text.length) { const char = text[end++]!; if (escaped) { escaped = false; continue } if (char === "\\") { escaped = true; continue } if (char === '"') { try { return { value: JSON.parse(text.slice(index, end)), start, end } } catch { fail() } } } fail() }
function close(text: string, index: number, open: string, endChar: string) { let depth = 0; for (; index < text.length; index += 1) { index = space(text, index); if (text[index] === '"') { index = stringAt(text, index).end - 1; continue } if (text[index] === open) depth += 1; if (text[index] === endChar && --depth === 0) return index } fail() }
type JsoncValue = { value: unknown; end: number }
function jsoncValue(text: string, at: number): JsoncValue {
  let index = space(text, at), char = text[index]
  if (char === '"') { const string = stringAt(text, index); return { value: string.value, end: string.end } }
  if (char === "{") {
    const object: Record<string, unknown> = {}; index = space(text, index + 1)
    while (text[index] !== "}") {
      const key = stringAt(text, index); index = space(text, key.end); if (text[index++] !== ":") fail()
      const entry = jsoncValue(text, index); object[key.value] = entry.value; index = space(text, entry.end)
      if (text[index] !== ",") { if (text[index] !== "}") fail(); break }
      index = space(text, index + 1)
    }
    return { value: object, end: index + 1 }
  }
  if (char === "[") {
    const array: unknown[] = []; index = space(text, index + 1)
    while (text[index] !== "]") {
      const entry = jsoncValue(text, index); array.push(entry.value); index = space(text, entry.end)
      if (text[index] !== ",") { if (text[index] !== "]") fail(); break }
      index = space(text, index + 1)
    }
    return { value: array, end: index + 1 }
  }
  const literal = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(index))
  if (!literal) fail()
  return { value: JSON.parse(literal[0]), end: index + literal[0].length }
}
/** Parses JSONC with comments and trailing commas using the editor's token scanner. */
export function parseJsonc(text: string): unknown {
  const parsed = jsoncValue(text, 0)
  if (space(text, parsed.end) !== text.length) fail()
  return parsed.value
}
type PluginEntry = { value: string; start: number; end: number; comma?: number }
type Plugin = { start: number; end: number; entries: PluginEntry[] }
function rootPlugin(text: string): Plugin | null {
  let index = space(text, 0); if (text[index++] !== "{") fail(); let plugin: Plugin | null = null
  for (;;) { index = space(text, index); if (text[index] === "}") { if (space(text, index + 1) !== text.length) fail(); return plugin } const key = stringAt(text, index); index = space(text, key.end); if (text[index++] !== ":") fail(); index = space(text, index)
    if (key.value === "plugin") {
      if (plugin || text[index] !== "[") fail()
      const start = index, end = close(text, index, "[", "]"), entries: PluginEntry[] = []
      let item = start + 1
      for (;;) {
        item = space(text, item)
        if (text[item] === "]") break
        const value = stringAt(text, item)
        item = space(text, value.end)
        const comma = text[item] === "," ? item : undefined
        if (comma !== undefined) item += 1
        else if (text[item] !== "]") fail()
        entries.push({ ...value, comma })
      }
      plugin = { start, end: end + 1, entries }; index = end + 1
    } else { if (text[index] === "[") index = close(text, index, "[", "]") + 1; else if (text[index] === "{") index = close(text, index, "{", "}") + 1; else if (text[index] === '"') index = stringAt(text, index).end; else { const match = /^(?:true|false|null|-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(index)); if (!match) fail(); index += match[0].length } }
    index = space(text, index); if (text[index] === ",") { index += 1; continue } if (text[index] !== "}") fail()
  }
}
function validPaneDash(value: string) { return /^@xiopt\/pane-dash-opencode(?:@[0-9]+\.[0-9]+\.[0-9]+)?$/.test(value) || /pane-dash/i.test(value) }
function insertionTrivia(text: string, plugin: Plugin): string {
  const first = plugin.entries[0]
  if (!first) return ""
  const second = plugin.entries[1]
  if (second && first.comma !== undefined) return text.slice(first.comma + 1, second.start).match(/^\s*$/)?.[0] ?? ""
  return text.slice(plugin.start + 1, first.start).match(/^\s*/)?.[0] ?? ""
}
function insertPlugin(text: string, plugin: Plugin, desired: string): string {
  if (!plugin.entries.length) return `${text.slice(0, plugin.end - 1)}${JSON.stringify(desired)}${text.slice(plugin.end - 1)}`
  const entry = plugin.entries[plugin.entries.length - 1]
  if (!entry) fail()
  const insertion = `,${insertionTrivia(text, plugin)}${JSON.stringify(desired)}`
  return `${text.slice(0, entry.end)}${insertion}${text.slice(entry.end)}`
}
export function planOpenCodeEdit(input: OpenCodeEditInput): PlannedConfigMutation {
  const desired = input.packageEntry ?? "@xiopt/pane-dash-opencode@0.1.7", text = decoder.decode(input.bytes), plugin = rootPlugin(text)
  if (plugin) {
    const managed = plugin.entries.filter(entry => validPaneDash(entry.value))
    const desiredEntries = managed.filter(entry => entry.value === desired)
    if (desiredEntries.length === 1 && managed.length === 1) return { ...input, bytes: input.bytes }
    if (desiredEntries.length || managed.length > 1) fail("E_CONFIG_CONFLICT")
    if (managed.length === 1) {
      const owned = input.ownedEntries
      const entry = managed[0]
      if (owned?.length !== 1 || !entry || owned[0] !== entry.value) fail("E_CONFIG_CONFLICT")
      return { ...input, bytes: encoder.encode(`${text.slice(0, entry.start)}${JSON.stringify(desired)}${text.slice(entry.end)}`) }
    }
    return { ...input, bytes: encoder.encode(insertPlugin(text, plugin, desired)) }
  }
  const closeIndex = text.lastIndexOf("}"); if (closeIndex < 0) fail()
  const newline = text.includes("\r\n") ? "\r\n" : "\n", prefix = text.slice(0, closeIndex), indent = /(?:^|\n)([ \t]+)"/.exec(prefix)?.[1] ?? "  ", comma = /\{\s*$/.test(prefix) ? "" : ","
  return { ...input, bytes: encoder.encode(`${prefix}${comma}${newline}${indent}"plugin": [${JSON.stringify(desired)}]${newline}${text.slice(closeIndex)}`) }
}

/** Removes exactly one ownership-recorded package element, preserving every other token. */
export function planOpenCodeRemoval(input: Omit<OpenCodeEditInput, "migrate">): PlannedConfigMutation {
  const text = decoder.decode(input.bytes), plugin = rootPlugin(text), owned = input.ownedEntries
  if (!plugin || owned?.length !== 1) fail("E_CONFIG_CONFLICT")
  const matches = plugin.entries.filter(entry => entry.value === owned[0])
  if (matches.length !== 1) fail("E_CONFIG_CONFLICT")
  const entry = matches[0]!, index = plugin.entries.indexOf(entry)
  let start = entry.start, end = entry.end
  if (entry.comma !== undefined) end = entry.comma + 1
  else if (index > 0) { const previous = plugin.entries[index - 1]!; start = previous.comma! }
  return { ...input, bytes: encoder.encode(`${text.slice(0, start)}${text.slice(end)}`) }
}
