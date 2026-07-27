const statuses = { E_USAGE: 2, E_LOCKED: 73, E_SIGNAL_HUP: 129, E_SIGNAL_INT: 130, E_SIGNAL_TERM: 143 } as const

export class CliError extends Error {
  constructor(readonly code: string, message = code) {
    super(`${code}: ${message}`)
    this.name = "CliError"
  }
}

export function exitStatusFor(error: unknown): 1 | 2 | 73 | 129 | 130 | 143 {
  if (error instanceof CliError && error.code in statuses) return statuses[error.code as keyof typeof statuses]
  return 1
}

export function escapeOutput(value: unknown, limit = 240): string {
  const escaped = String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`)
  return escaped.length <= limit ? escaped : `${escaped.slice(0, Math.max(0, limit - 3))}...`
}
