import { expect, test } from "bun:test"
import { startTuiProducer } from "../src/tui"

test("TUI producer follows route, publishes root state, heartbeat, and clears owned options", async () => {
  const values = new Map<string, string>(), cleared: string[] = [], intervals: Array<() => void> = [], events = new Map<string, (event: any) => void>()
  const sessions: Record<string, any> = {
    root: { id: "root", title: "Root", model: { id: "m1" } },
    child: { id: "child", parentID: "root", title: "Child" },
    next: { id: "next", title: "Next", model: { id: "m2" } },
  }
  const statuses: Record<string, any> = { root: { type: "idle" }, child: { type: "busy" }, next: { type: "idle" } }
  const permissions: Record<string, unknown[]> = {}
  const route: { current: any } = { current: { name: "session", params: { sessionID: "child" } } }
  let dispose = async () => {}
  const api: any = {
    route,
    state: { ready: true, session: { get: (id: string) => sessions[id], status: (id: string) => statuses[id], permission: (id: string) => permissions[id] ?? [], question: () => [], messages: () => [] } },
    client: { session: { children: async ({ sessionID }: any) => ({ data: sessionID === "root" ? [sessions.child] : [] }) } },
    event: { on: (type: string, handler: any) => { events.set(type, handler); return () => {} } },
    lifecycle: { onDispose: (handler: any) => { dispose = handler; return () => {} } },
  }
  startTuiProducer(api, {
    writer: { get: name => values.get(name), setOption: (name, value) => { values.set(name, value) }, unsetOption: name => { values.delete(name) }, flush: async () => {}, clearSync: () => { cleared.push("@pane_dash_status", "@pane_dash_status_since", "@pane_dash_heartbeat", "@pane_dash_title", "@pane_dash_model", "@pane_dash_opencode_session"); values.clear() } },
    now: () => 1_700_000_000_000,
    setInterval: handler => { intervals.push(handler); return handler },
    clearInterval: () => {},
  })
  await Bun.sleep(0)
  expect(values.get("@pane_dash_status")).toBe("working")
  expect(values.get("@pane_dash_opencode_session")).toBe("root")
  expect(values.get("@pane_dash_title")).toBe("Root")
  expect(values.get("@pane_dash_model")).toBe("m1")
  expect(values.get("@pane_dash_heartbeat")).toBe("1700000000")

  route.current = { name: "session", params: { sessionID: "next" } }
  intervals[1]!()
  await Bun.sleep(0)
  expect(values.get("@pane_dash_opencode_session")).toBe("next")
  expect(values.get("@pane_dash_status")).toBe("idle")
  expect(values.get("@pane_dash_status_since")).toBe("1700000000")

  permissions.next = [{}]
  events.get("permission.asked")!({ properties: { sessionID: "next" } })
  await Bun.sleep(0)
  expect(values.get("@pane_dash_status")).toBe("needs_input")
  await dispose()
  expect(cleared.sort()).toEqual(["@pane_dash_heartbeat", "@pane_dash_model", "@pane_dash_opencode_session", "@pane_dash_status", "@pane_dash_status_since", "@pane_dash_title"])
})
