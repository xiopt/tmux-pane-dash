import { sanitize } from "./sanitize"
import type { Derived, NormEvent } from "./state"

export type NotificationKind = "permission" | "question" | "error" | "finished"

export interface Notification {
  eventId: string
  kind: NotificationKind
  message: string
}

export type RawEvent = {
  id?: unknown
  type?: unknown
  properties?: unknown
}

export type NotificationContext = {
  before: Pick<Derived, "status" | "title">
  after: Pick<Derived, "status" | "title">
  normalized: readonly NormEvent[]
  activeSessionID?: string
}

type Properties = Record<string, unknown>

export interface NotificationSyncResult {
  exitCode: number
  stdout: Uint8Array | string
}

export type NotificationSync = (
  command: string[],
  options: { stdout: "pipe"; stderr: "ignore" },
) => NotificationSyncResult

export interface NotificationSpawnResult {
  exited: Promise<number>
}

export type NotificationSpawn = (
  command: string[],
  options: { stdout: "ignore"; stderr: "ignore" },
) => NotificationSpawnResult

const NOTIFY_BINARY_OPTION = "@pane_dash_notify_binary"
const MAX_EVENT_ID_BYTES = 128
const SPAWN_OPTIONS = { stdout: "ignore", stderr: "ignore" } as const

function object(value: unknown): Properties {
  return value !== null && typeof value === "object" ? (value as Properties) : {}
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const result = sanitize(value).trim()
  return result || undefined
}

function properties(raw: RawEvent): Properties {
  return object(raw.properties)
}

function validEventID(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_EVENT_ID_BYTES &&
    /^[\x20-\x7e]+$/.test(value)
}

function eventID(raw: RawEvent): string | undefined {
  return validEventID(raw.id) ? raw.id : undefined
}

function message(prefix: string, value: string): string {
  return sanitize(`${prefix}: ${value}`)
}

function questionDetail(raw: RawEvent): string {
  const questions = properties(raw).questions
  const first = Array.isArray(questions) ? questions[0] : undefined
  const question = object(first)
  return text(question.header) ?? text(question.question) ?? "question"
}

function sessionLabel(raw: RawEvent, context: NotificationContext): string {
  return text(context.after.title) ??
    text(context.activeSessionID) ??
    text(properties(raw).sessionID) ??
    "session"
}

function isIdleTransition(raw: RawEvent, context: NotificationContext): boolean {
  if (context.before.status !== "working" || context.after.status !== "idle") return false
  if (raw.type !== "session.idle" && raw.type !== "session.status") return false
  return context.normalized.some((event) => event.type === "status" && event.status === "idle")
}

/** Purely maps one raw OpenCode event and its existing state transition. */
export function decideNotification(raw: RawEvent, context: NotificationContext): Notification | undefined {
  const id = eventID(raw)
  if (!id) return undefined

  switch (raw.type) {
    case "permission.asked":
      return {
        eventId: id,
        kind: "permission",
        message: message("OpenCode permission", text(properties(raw).permission) ?? "request"),
      }
    case "question.asked":
      return {
        eventId: id,
        kind: "question",
        message: message("OpenCode question", questionDetail(raw)),
      }
    case "session.error":
      if (!context.normalized.some((event) => event.type === "error")) return undefined
      return {
        eventId: id,
        kind: "error",
        message: message("OpenCode error", sessionLabel(raw, context)),
      }
    case "session.idle":
    case "session.status":
      return isIdleTransition(raw, context)
        ? {
            eventId: id,
            kind: "finished",
            message: message("OpenCode finished", sessionLabel(raw, context)),
          }
        : undefined
    default:
      return undefined
  }
}

function binaryOutput(stdout: Uint8Array | string): string | undefined {
  let value: string
  try {
    value = typeof stdout === "string" ? stdout : new TextDecoder("utf-8", { fatal: true }).decode(stdout)
  } catch {
    return undefined
  }

  if (value.endsWith("\r\n")) value = value.slice(0, -2)
  else if (value.endsWith("\n")) value = value.slice(0, -1)
  if (!value.startsWith("/") || value.length > 1024 || /[\x00-\x1f\x7f]/.test(value)) return undefined
  return value
}

const defaultSync: NotificationSync = (command, options) => Bun.spawnSync(command, options)

/** Resolves the tmux-published binary once; failures disable this producer. */
export function resolveNotificationBinary(sync: NotificationSync = defaultSync): string | undefined {
  try {
    const result = sync(["tmux", "show-options", "-gqv", NOTIFY_BINARY_OPTION], {
      stdout: "pipe",
      stderr: "ignore",
    })
    return result.exitCode === 0 ? binaryOutput(result.stdout) : undefined
  } catch {
    return undefined
  }
}

function notificationArgv(binary: string, notification: Notification): string[] {
  return [
    binary,
    "notify",
    "publish",
    "--event-id",
    notification.eventId,
    "--kind",
    notification.kind,
    "--message",
    notification.message,
  ]
}

const defaultSpawn: NotificationSpawn = (command, options) => Bun.spawn(command, options)

/** Publishes best-effort without awaiting or allowing child failure to escape. */
export function createNotificationPublisher(
  binary: string | undefined,
  spawn: NotificationSpawn = defaultSpawn,
): (notification: Notification | undefined) => void {
  return (notification) => {
    if (!binary || !notification) return
    try {
      const child = spawn(notificationArgv(binary, notification), SPAWN_OPTIONS)
      void child.exited.catch(() => {})
    } catch {
      // Notifications are optional; status processing must continue.
    }
  }
}
