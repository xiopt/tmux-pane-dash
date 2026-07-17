import { sanitize } from "./sanitize"

export interface SpawnResult {
  exited: Promise<number>
}

export type Spawn = (
  command: string[],
  options: { stdout: "ignore"; stderr: "ignore" },
) => SpawnResult

const SPAWN_OPTIONS = { stdout: "ignore", stderr: "ignore" } as const

export class TmuxWriter {
  private pending = Promise.resolve()
  private readonly written = new Map<string, string>()

  constructor(
    private readonly pane: string,
    private readonly spawn: Spawn,
  ) {}

  get(name: string): string | undefined {
    return this.written.get(name)
  }

  setOption(name: string, value: string, force = false): void {
    const sanitized = sanitize(value)
    if (!force && this.written.get(name) === sanitized) return

    this.written.set(name, sanitized)
    this.enqueue(name, sanitized, ["tmux", "set-option", "-pt", this.pane, name, sanitized])
  }

  unsetOption(name: string, force = false): void {
    if (!force && !this.written.has(name)) return

    this.written.delete(name)
    this.enqueue(name, undefined, ["tmux", "set-option", "-pu", "-t", this.pane, name])
  }

  flush(): Promise<void> {
    return this.pending
  }

  private enqueue(name: string, value: string | undefined, command: string[]): void {
    const write = async () => {
      try {
        if ((await this.spawn(command, SPAWN_OPTIONS).exited) !== 0) this.invalidate(name, value)
      } catch {
        this.invalidate(name, value)
      }
    }
    this.pending = this.pending.then(write, write)
  }

  private invalidate(name: string, value: string | undefined): void {
    if (this.written.get(name) === value) this.written.delete(name)
  }
}
