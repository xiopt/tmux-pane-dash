// OpenCode plugin: publishes agent status to tmux pane options.
// Install: ln -sf <repo>/opencode-plugin/pane-dash.ts ~/.config/opencode/plugin/
import { normalize } from "./src/normalize"
import { isServeInvocation } from "./src/mode"
import { createNotificationPublisher, decideNotification, resolveNotificationBinary } from "./src/notifications"
import { apply, createStore, derive } from "./src/state"
import { TmuxWriter } from "./src/writer"

const HEARTBEAT_MS = 20_000
const HIDDEN_STATUS = "hidden"
const STARTUP_OPTIONS = [
  "@pane_dash_status",
  "@pane_dash_status_since",
  "@pane_dash_title",
  "@pane_dash_model",
] as const

export const PaneDash = async () => {
  const pane = process.env.TMUX_PANE
  if (!pane) return {}

  const writer = new TmuxWriter(pane)

  if (isServeInvocation(process.argv)) {
    for (const name of STARTUP_OPTIONS) writer.unsetOption(name, true)
    writer.unsetOption("@pane_dash_heartbeat", true)
    writer.setOption("@pane_dash_status", HIDDEN_STATUS, true)
    process.on("exit", () => writer.clearSync())
    return {}
  }

  const store = createStore()
  const notify = createNotificationPublisher(resolveNotificationBinary())

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
      const raw = event as { id?: unknown; type?: unknown; properties?: unknown }
      const before = derive(store)
      const normalized = normalize(raw)
      for (const normalizedEvent of normalized) {
        apply(store, normalizedEvent)
      }
      const after = derive(store)
      notify(decideNotification(raw, {
        before,
        after,
        normalized,
        activeSessionID: store.activeSessionID,
      }))
      publish()
    },
  }
}
