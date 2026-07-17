// Pure per-instance state store + derived pane status. No I/O.
// Spec: docs/superpowers/specs/2026-07-17-tmux-pane-dash-design.md
//   sections "State model", "Active-session attribution",
//   "Displayed state precedence".

export type Status = "working" | "needs_input" | "idle" | "error" | "unknown"
export type Runtime = "unknown" | "busy" | "retry" | "idle"

export type NormEvent =
  | { type: "status"; sessionID: string; status: "busy" | "retry" | "idle" }
  | { type: "request.open"; sessionID: string; requestID: string }
  | { type: "request.close"; sessionID: string; requestID: string }
  | { type: "error"; sessionID?: string }
  | { type: "user-message"; sessionID: string }
  | { type: "session.meta"; sessionID: string; parentID?: string; title?: string }
  | { type: "session.deleted"; sessionID: string }
  | { type: "active"; sessionID: string }
  | { type: "model"; model: string }

interface SessionState {
  runtime: Runtime
  pending: Set<string>
  errorLatched: boolean
  parentID?: string
  title?: string
}

export interface Store {
  sessions: Map<string, SessionState>
  activeSessionID?: string
  model?: string
}

export interface Derived {
  status: Status
  title?: string
  model?: string
}

export function createStore(): Store {
  return { sessions: new Map() }
}

function session(store: Store, id: string): SessionState {
  let s = store.sessions.get(id)
  if (!s) {
    s = { runtime: "unknown", pending: new Set(), errorLatched: false }
    store.sessions.set(id, s)
  }
  return s
}

function topLevelSessionID(store: Store, sessionID: string): string {
  let id = sessionID
  while (true) {
    const parentID = store.sessions.get(id)?.parentID
    if (!parentID) return id
    id = parentID
  }
}

export function apply(store: Store, ev: NormEvent): void {
  switch (ev.type) {
    case "status": {
      const s = session(store, ev.sessionID)
      s.runtime = ev.status
      if (ev.status === "busy" || ev.status === "retry") s.errorLatched = false
      break
    }
    case "request.open":
      session(store, ev.sessionID).pending.add(ev.requestID)
      break
    case "request.close":
      session(store, ev.sessionID).pending.delete(ev.requestID)
      break
    case "error": {
      const id = ev.sessionID ?? store.activeSessionID
      if (id) session(store, id).errorLatched = true
      break
    }
    case "user-message":
      session(store, ev.sessionID).errorLatched = false
      store.activeSessionID = topLevelSessionID(store, ev.sessionID)
      break
    case "session.meta": {
      const s = session(store, ev.sessionID)
      if (ev.parentID !== undefined) s.parentID = ev.parentID
      if (ev.title !== undefined) s.title = ev.title
      break
    }
    case "session.deleted":
      store.sessions.delete(ev.sessionID)
      if (store.activeSessionID === ev.sessionID) store.activeSessionID = undefined
      break
    case "active":
      store.activeSessionID = ev.sessionID
      break
    case "model":
      store.model = ev.model
      break
  }
}

/** Session IDs relevant for display: active session + all descendants,
 * or every session when no active session is known (aggregate fallback). */
function relevant(store: Store): SessionState[] {
  const all = [...store.sessions.entries()]
  const active = store.activeSessionID
  if (!active || !store.sessions.has(active)) return all.map(([, s]) => s)
  const included = new Set([active])
  let grew = true
  while (grew) {
    grew = false
    for (const [id, s] of all) {
      if (!included.has(id) && s.parentID && included.has(s.parentID)) {
        included.add(id)
        grew = true
      }
    }
  }
  return all.filter(([id]) => included.has(id)).map(([, s]) => s)
}

export function derive(store: Store): Derived {
  const sessions = relevant(store)
  const title = store.activeSessionID ? store.sessions.get(store.activeSessionID)?.title : undefined

  let status: Status = "unknown"
  if (sessions.some((s) => s.pending.size > 0)) status = "needs_input"
  else if (sessions.some((s) => s.errorLatched)) status = "error"
  else if (sessions.some((s) => s.runtime === "busy" || s.runtime === "retry")) status = "working"
  else if (sessions.some((s) => s.runtime === "idle")) status = "idle"

  return { status, title, model: store.model }
}
