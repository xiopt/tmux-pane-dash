// Throwaway opencode plugin: logs every plugin event as JSONL.
// Install: ln -sf "$PWD/tools/trace-recorder.ts" ~/.config/opencode/plugin/
import { appendFileSync, mkdirSync } from "node:fs"

export const TraceRecorder = async () => {
  const dir = `${process.env.HOME}/pane-dash-traces`
  mkdirSync(dir, { recursive: true })
  const file = `${dir}/trace-${Date.now()}-${process.pid}.jsonl`
  appendFileSync(
    file,
    JSON.stringify({ t: Date.now(), meta: { pane: process.env.TMUX_PANE ?? null, pid: process.pid } }) + "\n",
  )
  return {
    event: async ({ event }: { event: unknown }) => {
      appendFileSync(file, JSON.stringify({ t: Date.now(), event }) + "\n")
    },
  }
}
