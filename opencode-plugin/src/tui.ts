import { deriveTuiState, type TuiSessionSnapshot } from "./tui-state"
import { TmuxWriter } from "./writer"

const HEARTBEAT_MS = 20_000
const ROUTE_POLL_MS = 250
const OPTIONS = [
  "@pane_dash_status",
  "@pane_dash_status_since",
  "@pane_dash_heartbeat",
  "@pane_dash_title",
  "@pane_dash_model",
  "@pane_dash_opencode_session",
] as const

type Session = { id: string; parentID?: string; title?: string; model?: { id?: string } }
type Message = { role?: string; modelID?: string; error?: unknown }
type Api = {
  route: { readonly current: { name: string; params?: Record<string, unknown> } }
  state: {
    readonly ready: boolean
    session: {
      get(id: string): Session | undefined
      status(id: string): { type?: string } | undefined
      permission(id: string): readonly unknown[]
      question(id: string): readonly unknown[]
      messages(id: string): readonly Message[]
    }
  }
  client: { session: { children(input: { sessionID: string }): Promise<{ data?: Session[] }> } }
  event: { on(type: string, handler: (event: any) => void): () => void }
  lifecycle: { onDispose(handler: () => void | Promise<void>): () => void }
}
type Writer = Pick<TmuxWriter, "get" | "setOption" | "unsetOption" | "flush" | "clearSync">
type Runtime = {
  writer: Writer
  now(): number
  setInterval(handler: () => void, milliseconds: number): unknown
  clearInterval(timer: unknown): void
}

function currentSessionID(api: Api): string | undefined {
  const route = api.route.current
  const id = route.name === "session" ? route.params?.sessionID : undefined
  return typeof id === "string" && id.length > 0 ? id : undefined
}

function lastMessage(sessionID: string, api: Api): Message | undefined {
  return api.state.session.messages(sessionID).at(-1)
}

function snapshot(sessionID: string, api: Api, errored: ReadonlySet<string>): TuiSessionSnapshot {
  const session = api.state.session.get(sessionID)
  const status = api.state.session.status(sessionID)?.type
  const message = lastMessage(sessionID, api)
  return {
    id: sessionID,
    parentID: session?.parentID,
    title: session?.title,
    model: session?.model?.id ?? (message?.role === "assistant" ? message.modelID : undefined),
    runtime: status === "busy" || status === "retry" || status === "idle" ? status : undefined,
    pending: api.state.session.permission(sessionID).length > 0 || api.state.session.question(sessionID).length > 0,
    error: errored.has(sessionID) || (message?.role === "assistant" && message.error !== undefined),
  }
}

function rootID(sessionID: string, api: Api): string {
  let id = sessionID
  const visited = new Set<string>()
  while (!visited.has(id)) {
    visited.add(id)
    const parentID = api.state.session.get(id)?.parentID
    if (!parentID) return id
    id = parentID
  }
  return sessionID
}

export function startTuiProducer(api: Api, runtime: Runtime): void {
  const known = new Set<string>()
  const errored = new Set<string>()
  let routeID: string | undefined
  let treeGeneration = 0

  const heartbeat = () => runtime.writer.setOption("@pane_dash_heartbeat", String(Math.floor(runtime.now() / 1000)), true)
  const publish = () => {
    const current = currentSessionID(api)
    if (!current || !api.state.ready || !api.state.session.get(current)) {
      runtime.writer.setOption("@pane_dash_status", "unknown")
      runtime.writer.unsetOption("@pane_dash_title")
      runtime.writer.unsetOption("@pane_dash_model")
      runtime.writer.unsetOption("@pane_dash_opencode_session")
      return
    }
    known.add(current)
    for (let id: string | undefined = current; id;) {
      known.add(id)
      id = api.state.session.get(id)?.parentID
    }
    const derived = deriveTuiState(current, [...known].map(id => snapshot(id, api, errored)))
    const previous = runtime.writer.get("@pane_dash_status")
    runtime.writer.setOption("@pane_dash_status", derived.status)
    if (previous !== derived.status) runtime.writer.setOption("@pane_dash_status_since", String(Math.floor(runtime.now() / 1000)))
    if (derived.title === undefined) runtime.writer.unsetOption("@pane_dash_title")
    else runtime.writer.setOption("@pane_dash_title", derived.title)
    if (derived.model === undefined) runtime.writer.unsetOption("@pane_dash_model")
    else runtime.writer.setOption("@pane_dash_model", derived.model)
    runtime.writer.setOption("@pane_dash_opencode_session", derived.rootID)
  }

  const refreshTree = async (current: string) => {
    const generation = ++treeGeneration
    const root = rootID(current, api), found = new Set([root]), queue = [root]
    while (queue.length) {
      const parent = queue.shift()!
      let children: Session[]
      try { children = (await api.client.session.children({ sessionID: parent })).data ?? [] } catch { return }
      for (const child of children) if (!found.has(child.id)) { found.add(child.id); queue.push(child.id) }
    }
    if (generation !== treeGeneration || currentSessionID(api) !== current) return
    known.clear()
    for (const id of found) known.add(id)
    known.add(current)
    publish()
  }

  const checkRoute = () => {
    const current = currentSessionID(api)
    if (current !== routeID) {
      routeID = current
      known.clear()
      treeGeneration += 1
      publish()
      if (current) void refreshTree(current)
    } else publish()
  }

  for (const option of OPTIONS) runtime.writer.unsetOption(option, true)
  heartbeat()
  checkRoute()
  const heartbeatTimer = runtime.setInterval(heartbeat, HEARTBEAT_MS)
  const routeTimer = runtime.setInterval(checkRoute, ROUTE_POLL_MS)
  const relevant = ["session.status", "session.idle", "permission.asked", "permission.replied", "question.asked", "question.replied", "question.rejected", "session.error", "session.created", "session.updated", "session.deleted", "message.updated"]
  for (const type of relevant) api.event.on(type, event => {
    const id = event?.properties?.sessionID ?? event?.properties?.info?.id
    if (typeof id === "string" && routeID && rootID(id, api) === rootID(routeID, api)) known.add(id)
    if (type === "session.error" && typeof id === "string") errored.add(id)
    if (type === "session.status" && typeof id === "string" && (event.properties.status?.type === "busy" || event.properties.status?.type === "retry")) errored.delete(id)
    queueMicrotask(publish)
    if ((type === "session.created" || type === "session.deleted") && routeID) void refreshTree(routeID)
  })
  api.lifecycle.onDispose(async () => {
    treeGeneration += 1
    runtime.clearInterval(heartbeatTimer)
    runtime.clearInterval(routeTimer)
    for (const option of OPTIONS) runtime.writer.unsetOption(option, true)
    await runtime.writer.flush()
    runtime.writer.clearSync()
  })
}

const plugin = {
  id: "pane-dash",
  tui: async (api: Api) => {
    const pane = process.env.TMUX_PANE
    if (!pane) return
    startTuiProducer(api, {
      writer: new TmuxWriter(pane),
      now: Date.now,
      setInterval: (handler, milliseconds) => setInterval(handler, milliseconds),
      clearInterval: timer => clearInterval(timer as ReturnType<typeof setInterval>),
    })
  },
}

export default plugin
