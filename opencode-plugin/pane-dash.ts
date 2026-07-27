// OpenCode plugin: publishes agent status to tmux pane options.
// Install: ln -sf <repo>/opencode-plugin/pane-dash.ts ~/.config/opencode/plugin/
import { normalize } from "./src/normalize"
import { apply, createStore, derive } from "./src/state"
import { TmuxWriter } from "./src/writer"

const HEARTBEAT_MS = 20_000
const STARTUP_OPTIONS = [
  "@pane_dash_status",
  "@pane_dash_status_since",
  "@pane_dash_title",
  "@pane_dash_model",
] as const

export const PaneDash = async () => {
  const pane = process.env.TMUX_PANE
  if (!pane) return {}

  const store = createStore()
  const writer = new TmuxWriter(pane)

  const publish = () => {
    const derived = derive(store)
    const previousStatus = writer.get("@pane_dash_status")

    writer.setOption("@pane_dash_status", derived.status)
    if (previousStatus !== derived.status) {
      writer.setOption("@pane_dash_status_since", String(Math.floor(Date.now() / 1000)))
    }

    if (derived.title === undefined) writer.unsetOption("@pane_dash_title")
    else writer.setOption("@pane_dash_title", derived.title)
    if (derived.model === undefined) writer.unsetOption("@pane_dash_model")
    else writer.setOption("@pane_dash_model", derived.model)
  }

  const heartbeat = () => {
    const value = String(Math.floor(Date.now() / 1000))
    writer.setOption("@pane_dash_heartbeat", value, true)
  }

  for (const name of STARTUP_OPTIONS) writer.unsetOption(name, true)
  heartbeat()
  const timer = setInterval(heartbeat, HEARTBEAT_MS)
  timer.unref?.()

  process.on("exit", () => writer.clearSync())

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
