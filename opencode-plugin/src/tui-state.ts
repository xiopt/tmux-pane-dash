import type { Status } from "./state"

export type TuiSessionSnapshot = {
  id: string
  parentID?: string
  title?: string
  model?: string
  runtime?: "busy" | "retry" | "idle"
  pending: boolean
  error: boolean
}

export type TuiDerived = {
  rootID: string
  status: Status
  title?: string
  model?: string
}

function rootSessionID(currentID: string, sessions: ReadonlyMap<string, TuiSessionSnapshot>): string {
  let id = currentID
  const visited = new Set<string>()
  while (!visited.has(id)) {
    visited.add(id)
    const parentID = sessions.get(id)?.parentID
    if (!parentID) return id
    id = parentID
  }
  return currentID
}

function belongsToRoot(session: TuiSessionSnapshot, rootID: string, sessions: ReadonlyMap<string, TuiSessionSnapshot>): boolean {
  let id = session.id
  const visited = new Set<string>()
  while (!visited.has(id)) {
    if (id === rootID) return true
    visited.add(id)
    const parentID = sessions.get(id)?.parentID
    if (!parentID) return false
    id = parentID
  }
  return false
}

export function deriveTuiState(currentID: string, input: readonly TuiSessionSnapshot[]): TuiDerived {
  const sessions = new Map(input.map(session => [session.id, session]))
  const rootID = rootSessionID(currentID, sessions)
  const relevant = input.filter(session => belongsToRoot(session, rootID, sessions))
  const root = sessions.get(rootID)

  let status: Status = "unknown"
  if (relevant.some(session => session.pending)) status = "needs_input"
  else if (relevant.some(session => session.error)) status = "error"
  else if (relevant.some(session => session.runtime === "busy" || session.runtime === "retry")) status = "working"
  else if (relevant.some(session => session.runtime === "idle")) status = "idle"
  else if (relevant.length > 0) status = "idle"

  return { rootID, status, title: root?.title, model: root?.model }
}
