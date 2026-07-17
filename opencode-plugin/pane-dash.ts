// OpenCode plugin: publishes agent status to tmux pane options.
// Install: ln -sf <repo>/opencode-plugin/pane-dash.ts ~/.config/opencode/plugin/
import { normalize } from "./src/normalize"
import { apply, createStore, derive } from "./src/state"

const HEARTBEAT_MS = 20_000
const OPTIONS = [
  "@pane_dash_status",
  "@pane_dash_status_since",
  "@pane_dash_heartbeat",
  "@pane_dash_title",
  "@pane_dash_model",
] as const

export function sanitize(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 120)
}

export const PaneDash = async () => {
  const pane = process.env.TMUX_PANE
  if (!pane) return {}

  const store = createStore()
  const written = new Map<string, string>()

  const setOption = (name: string, value: string) => {
    const sanitized = sanitize(value)
    if (written.get(name) === sanitized) return

    written.set(name, sanitized)
    Bun.spawn(["tmux", "set-option", "-pt", pane, name, sanitized], {
      stdout: "ignore",
      stderr: "ignore",
    })
  }

  const unsetOption = (name: string) => {
    if (!written.has(name)) return

    written.delete(name)
    Bun.spawn(["tmux", "set-option", "-pu", "-t", pane, name], {
      stdout: "ignore",
      stderr: "ignore",
    })
  }

  const publish = () => {
    const derived = derive(store)
    const previousStatus = written.get("@pane_dash_status")

    setOption("@pane_dash_status", derived.status)
    if (previousStatus !== derived.status) {
      setOption("@pane_dash_status_since", String(Math.floor(Date.now() / 1000)))
    }

    if (derived.title === undefined) unsetOption("@pane_dash_title")
    else setOption("@pane_dash_title", derived.title)
    if (derived.model === undefined) unsetOption("@pane_dash_model")
    else setOption("@pane_dash_model", derived.model)
  }

  const heartbeat = () => {
    const value = String(Math.floor(Date.now() / 1000))
    written.set("@pane_dash_heartbeat", value)
    Bun.spawn(["tmux", "set-option", "-pt", pane, "@pane_dash_heartbeat", value], {
      stdout: "ignore",
      stderr: "ignore",
    })
  }

  heartbeat()
  const timer = setInterval(heartbeat, HEARTBEAT_MS)
  timer.unref?.()

  const cleanup = () => {
    for (const name of OPTIONS) {
      try {
        Bun.spawnSync(["tmux", "set-option", "-pu", "-t", pane, name])
      } catch {
        // The pane may already be gone.
      }
    }
  }
  process.on("exit", cleanup)

  publish()

  return {
    event: async ({ event }: { event: unknown }) => {
      for (const normalized of normalize(event as { type?: unknown; properties?: unknown })) {
        apply(store, normalized)
      }
      publish()
    },
  }
}
