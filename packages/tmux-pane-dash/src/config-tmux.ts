import { CliError } from "./errors"
import type { PlannedConfigMutation } from "./transaction"

const encoder = new TextEncoder(), decoder = new TextDecoder()
const begin = "# >>> tmux-pane-dash (@xiopt/tmux-pane-dash) schema=1 >>>"
const end = "# <<< tmux-pane-dash (@xiopt/tmux-pane-dash) schema=1 <<<"

export type TmuxEditInput = Omit<PlannedConfigMutation, "bytes"> & { bytes: Uint8Array; installRoot: string; migrate: boolean }

export function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }
/** tmux consumes one escape layer before passing the POSIX word to /bin/sh. */
function tmuxConfigEmbed(shellCommand: string): string {
  if (/[\u0000-\u001f\u007f]/.test(shellCommand)) throw new CliError("E_CONFIG")
  const literal = `#{l:${shellCommand.replaceAll("#", "##").replaceAll("}", "#}")}}`
  return `"${literal.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$")}"`
}
export function managedTmuxBlock(installRoot: string): string { return `${begin}\nrun-shell ${tmuxConfigEmbed(shellQuote(`${installRoot}/current/pane_dash.tmux`))}\n${end}` }
const conflict = (detail = "existing tmux-pane-dash configuration") => { throw new CliError("E_CONFIG_CONFLICT", detail) }

function ownedRange(text: string, block: string): { start: number; end: number } | null {
  if (text.includes("tmux-pane-dash (@xiopt/tmux-pane-dash)") && (!text.includes(begin) || !text.includes(end))) conflict("unsupported tmux-pane-dash marker schema")
  const starts: number[] = [], ends: number[] = []
  for (let index = text.indexOf(begin); index >= 0; index = text.indexOf(begin, index + begin.length)) starts.push(index)
  for (let index = text.indexOf(end); index >= 0; index = text.indexOf(end, index + end.length)) ends.push(index)
  if (!starts.length && !ends.length) return null
  if (starts.length !== 1 || ends.length !== 1 || starts[0]! > ends[0]!) conflict("malformed tmux-pane-dash markers")
  const start = starts[0]!, finish = ends[0]! + end.length
  if (text.slice(start, finish) !== block) conflict("altered tmux-pane-dash block")
  return { start, end: finish }
}

function legacyLines(text: string, migrate: boolean): string {
  const lines = text.split(/(?<=\n)/)
  const retained: string[] = []
  for (const line of lines) {
    const active = line.replace(/^\s*(?:#.*)?$/, "")
    if (!active || (!active.includes("pane_dash.tmux") && !active.includes("@pane-dash-engine") && !active.includes("tmux-pane-dash"))) { retained.push(line); continue }
    const exactManual = /^\s*run-shell\s+(['"])[^'"\n]*(?:tmux-pane-dash[^'"\n]*)?\/pane_dash\.tmux\1\s*(?:\r?\n)?$/.test(line)
    const exactEngine = /^\s*set(?:-option)?\s+-g\s+@pane-dash-engine\s+\S+\s*(?:\r?\n)?$/.test(line)
    const exactTpm = /^\s*set\s+-g\s+@plugin\s+['"]xiopt\/tmux-pane-dash['"]\s*(?:\r?\n)?$/.test(line)
    if (!migrate || !(exactManual || exactEngine || exactTpm)) conflict(`existing configuration at tmux line ${retained.length + 1}`)
  }
  return retained.join("")
}

export function planTmuxEdit(input: TmuxEditInput): PlannedConfigMutation {
  let text = decoder.decode(input.bytes), block = managedTmuxBlock(input.installRoot)
  const range = ownedRange(text, block)
  if (range) return { ...input, bytes: input.bytes }
  text = legacyLines(text, input.migrate)
  const separator = text.length && !text.endsWith("\n") ? "\n" : ""
  return { ...input, bytes: encoder.encode(`${text}${separator}${block}`) }
}

/** The inverse accepts only the byte-for-byte block recorded at installation. */
export function planTmuxRemoval(input: Omit<TmuxEditInput, "migrate">): PlannedConfigMutation {
  const text = decoder.decode(input.bytes), block = managedTmuxBlock(input.installRoot), range = ownedRange(text, block)
  if (!range) conflict("managed tmux-pane-dash block is missing")
  const before = text.slice(0, range.start!), after = text.slice(range.end!)
  return { ...input, bytes: encoder.encode(`${before.endsWith("\n") && !after ? before.slice(0, -1) : before}${after}`) }
}
