// Adapter: raw OpenCode plugin events -> state-store events.
// Event shapes are verified against OpenCode 1.17.20 recorded fixtures.
import type { NormEvent } from "./state"

type Properties = Record<string, unknown>
type RawEvent = { type?: unknown; properties?: unknown }

function object(value: unknown): Properties {
  return value !== null && typeof value === "object" ? (value as Properties) : {}
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function sessionID(properties: Properties): string | undefined {
  return str(properties.sessionID)
}

function requestID(properties: Properties, preference: "asked" | "replied"): string | undefined {
  const ids = preference === "asked"
    ? [properties.id, properties.permissionID, properties.questionID, properties.requestID]
    : [properties.requestID, properties.id, properties.permissionID, properties.questionID]
  return ids.map(str).find((id): id is string => id !== undefined)
}

function sessionMeta(properties: Properties): NormEvent[] {
  const info = object(properties.info)
  const id = str(info.id) ?? sessionID(properties)
  return id
    ? [{ type: "session.meta", sessionID: id, parentID: str(info.parentID), title: str(info.title) }]
    : []
}

export function normalize(raw: RawEvent): NormEvent[] {
  const properties = object(raw.properties)

  switch (raw.type) {
    case "session.status": {
      const id = sessionID(properties)
      const status = str(object(properties.status).type) ?? str(properties.status)
      return id && (status === "busy" || status === "retry" || status === "idle")
        ? [{ type: "status", sessionID: id, status }]
        : []
    }
    case "session.idle": {
      const id = sessionID(properties)
      return id ? [{ type: "status", sessionID: id, status: "idle" }] : []
    }
    case "permission.asked":
    case "question.asked": {
      const id = sessionID(properties)
      const request = requestID(properties, "asked")
      return id && request ? [{ type: "request.open", sessionID: id, requestID: request }] : []
    }
    case "permission.replied":
    case "question.replied":
    case "question.rejected": {
      const id = sessionID(properties)
      const request = requestID(properties, "replied")
      return id && request ? [{ type: "request.close", sessionID: id, requestID: request }] : []
    }
    case "session.error":
      return [{ type: "error", sessionID: sessionID(properties) }]
    case "session.created":
    case "session.updated":
      return sessionMeta(properties)
    case "session.deleted": {
      const id = str(object(properties.info).id) ?? sessionID(properties)
      return id ? [{ type: "session.deleted", sessionID: id }] : []
    }
    case "message.updated": {
      const info = object(properties.info)
      const id = sessionID(info)
      if (info.role === "user" && id) return [{ type: "user-message", sessionID: id }]
      if (info.role !== "assistant") return []

      const model = str(info.modelID) ?? str(object(info.model).modelID)
      return model ? [{ type: "model", model }] : []
    }
    default:
      return []
  }
}
