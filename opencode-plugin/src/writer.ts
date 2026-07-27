import { sanitize } from "./sanitize"

export interface SpawnResult {
  exited: Promise<number>
}

export type Spawn = (
  command: string[],
  options: { stdout: "ignore"; stderr: "ignore" },
) => SpawnResult

const SPAWN_OPTIONS = { stdout: "ignore", stderr: "ignore" } as const

const defaultSpawn: Spawn = (command, options) => Bun.spawn(command, options)

export class TmuxWriter {
  private pending = Promise.resolve()
  private draining = false
  private generation = 0
  private completedGeneration = 0
  private readonly desired = new Map<string, string | undefined>()
  private readonly confirmed = new Map<string, string | undefined>()

  constructor(
    private readonly pane: string,
    private readonly spawn: Spawn = defaultSpawn,
  ) {}

  publish(options: Readonly<Record<string, string>>): void {
    for (const [name, value] of Object.entries(options)) this.setOption(name, value)
  }

  clearSync(): void {
    for (const name of this.desired.keys()) {
      try {
        Bun.spawnSync(["tmux", "set-option", "-pu", "-t", this.pane, name])
      } catch {
        // The pane may already be gone.
      }
    }
  }

  get(name: string): string | undefined {
    return this.desired.get(name)
  }

  setOption(name: string, value: string, force = false): void {
    const sanitized = sanitize(value)
    this.desired.set(name, sanitized)
    if (force) this.confirmed.delete(name)
    this.kick()
  }

  unsetOption(name: string, force = false): void {
    this.desired.set(name, undefined)
    if (force) this.confirmed.delete(name)
    this.kick()
  }

  flush(): Promise<void> {
    return this.pending
  }

  private kick(): void {
    this.generation += 1
    if (this.draining) return

    this.draining = true
    this.pending = Promise.resolve().then(() => this.drain())
  }

  private async drain(): Promise<void> {
    while (this.completedGeneration < this.generation) {
      const generation = this.generation
      const changes = [...this.desired].filter(([name, value]) => !this.matches(name, value))
      if (changes.length > 0) await this.write(changes)
      this.completedGeneration = generation
    }
    this.draining = false
  }

  private matches(name: string, value: string | undefined): boolean {
    return this.confirmed.has(name) && this.confirmed.get(name) === value
  }

  private async write(changes: [string, string | undefined][]): Promise<void> {
    const command = ["tmux"]
    for (const [index, [name, value]] of changes.entries()) {
      if (index > 0) command.push(";")
      if (value === undefined) command.push("set-option", "-pu", "-t", this.pane, name)
      else command.push("set-option", "-pt", this.pane, name, value)
    }
    try {
      if ((await this.spawn(command, SPAWN_OPTIONS).exited) === 0) {
        for (const [name, value] of changes) this.confirmed.set(name, value)
      }
    } catch {
      // Keep the desired value so the next kick retries it.
    }
  }
}
