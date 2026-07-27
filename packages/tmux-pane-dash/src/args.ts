import type { Command, SetupCommand } from "./contracts"
import { CliError } from "./errors"

const usage = () => { throw new CliError("E_USAGE", "usage: tmux-pane-dash setup [--no-tmux] [--no-opencode] [--migrate] [--allow-downgrade] | update | doctor [--json] | uninstall") }

export function parseArgs(argv: readonly string[]): Command {
  const [name, ...options] = argv
  if (name === "setup") {
    const command: SetupCommand = { name, tmux: true, opencode: true, migrate: false, allowDowngrade: false }
    const seen = new Set<string>()
    for (const option of options) {
      if (seen.has(option)) usage()
      seen.add(option)
      if (option === "--no-tmux") command.tmux = false
      else if (option === "--no-opencode") command.opencode = false
      else if (option === "--migrate") command.migrate = true
      else if (option === "--allow-downgrade") command.allowDowngrade = true
      else usage()
    }
    if (!command.tmux && !command.opencode) usage()
    return command
  }
  if (name === "update" && options.length === 0) return { name }
  if (name === "doctor" && (options.length === 0 || options.length === 1 && options[0] === "--json")) return { name, json: options.length === 1 }
  if (name === "uninstall" && options.length === 0) return { name }
  return usage()
}
