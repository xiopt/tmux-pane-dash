import { describe, expect, test } from "bun:test"
import { normalize } from "../src/normalize"
import {
  createNotificationPublisher,
  decideNotification,
  resolveNotificationBinary,
  type Notification,
  type NotificationContext,
  type NotificationSpawn,
} from "../src/notifications"
import { apply, createStore, derive } from "../src/state"
import { TmuxWriter, type Spawn } from "../src/writer"

function context(overrides: Partial<NotificationContext> = {}): NotificationContext {
  return {
    before: { status: "unknown" },
    after: { status: "unknown" },
    normalized: [],
    ...overrides,
  }
}

function event(raw: Record<string, unknown>) {
  return raw as Parameters<typeof normalize>[0] & { id?: unknown }
}

function processEvent(store: ReturnType<typeof createStore>, raw: ReturnType<typeof event>): Notification | undefined {
  const before = derive(store)
  const normalized = normalize(raw)
  for (const normalizedEvent of normalized) apply(store, normalizedEvent)
  return decideNotification(raw, {
    before,
    after: derive(store),
    normalized,
    activeSessionID: store.activeSessionID,
  })
}

describe("OpenCode notification mappings", () => {
  test("maps fixture-shaped events to the public CLI payload", () => {
    const permission = decideNotification(event({
      id: "evt-permission-1",
      type: "permission.asked",
      properties: { sessionID: "ses-root", id: "per-1", permission: "external_directory" },
    }), context())
    const question = decideNotification(event({
      id: "evt-question-1",
      type: "question.asked",
      properties: {
        sessionID: "ses-root",
        id: "que-1",
        questions: [{ question: "What should I do next?", header: "Next step", options: [] }],
      },
    }), context())
    const error = decideNotification(event({
      id: "evt-error-1",
      type: "session.error",
      properties: { sessionID: "ses-root" },
    }), context({
      normalized: [{ type: "error", sessionID: "ses-root" }],
      after: { status: "error", title: "Fix auth" },
      activeSessionID: "ses-root",
    }))
    const finished = decideNotification(event({
      id: "evt-finished-1",
      type: "session.idle",
      properties: { sessionID: "ses-root" },
    }), context({
      before: { status: "working", title: "Fix auth" },
      after: { status: "idle", title: "Fix auth" },
      normalized: [{ type: "status", sessionID: "ses-root", status: "idle" }],
      activeSessionID: "ses-root",
    }))

    expect([permission, question, error, finished]).toEqual([
      { eventId: "evt-permission-1", kind: "permission", message: "OpenCode permission: external_directory" },
      { eventId: "evt-question-1", kind: "question", message: "OpenCode question: Next step" },
      { eventId: "evt-error-1", kind: "error", message: "OpenCode error: Fix auth" },
      { eventId: "evt-finished-1", kind: "finished", message: "OpenCode finished: Fix auth" },
    ])

    const calls: string[][] = []
    const publish = createNotificationPublisher("/opt/pane dash", (command) => {
      calls.push(command)
      return { exited: Promise.resolve(0) }
    })
    for (const notification of [permission, question, error, finished]) publish(notification)

    expect(calls).toEqual([
      ["/opt/pane dash", "notify", "publish", "--event-id", "evt-permission-1", "--kind", "permission", "--message", "OpenCode permission: external_directory"],
      ["/opt/pane dash", "notify", "publish", "--event-id", "evt-question-1", "--kind", "question", "--message", "OpenCode question: Next step"],
      ["/opt/pane dash", "notify", "publish", "--event-id", "evt-error-1", "--kind", "error", "--message", "OpenCode error: Fix auth"],
      ["/opt/pane dash", "notify", "publish", "--event-id", "evt-finished-1", "--kind", "finished", "--message", "OpenCode finished: Fix auth"],
    ])
  })

  test("uses question text and concise fallback, then session fallback", () => {
    expect(decideNotification(event({
      id: "evt-question-text",
      type: "question.asked",
      properties: { questions: [{ header: "  ", question: "  Choose a path?  " }] },
    }), context())).toMatchObject({ message: "OpenCode question: Choose a path?" })
    expect(decideNotification(event({
      id: "evt-question-fallback",
      type: "question.asked",
      properties: { questions: [{ header: "\n", question: "" }] },
    }), context())).toMatchObject({ message: "OpenCode question: question" })

    const raw = event({ id: "evt-error-session", type: "session.error", properties: { sessionID: "ses-child" } })
    expect(decideNotification(raw, context({ normalized: [{ type: "error", sessionID: "ses-child" }], activeSessionID: "ses-root" }))).toMatchObject({
      message: "OpenCode error: ses-root",
    })
    expect(decideNotification(raw, context({ normalized: [{ type: "error", sessionID: "ses-child" }] }))).toMatchObject({
      message: "OpenCode error: ses-child",
    })
  })
})

describe("OpenCode notification transitions and delivery", () => {
  test("emits working-to-idle once and ignores redundant idle events", () => {
    const store = createStore()
    expect(processEvent(store, event({
      id: "evt-busy",
      type: "session.status",
      properties: { sessionID: "ses-root", status: { type: "busy" } },
    }))).toBeUndefined()

    expect(processEvent(store, event({
      id: "evt-idle-1",
      type: "session.idle",
      properties: { sessionID: "ses-root" },
    }))).toEqual({ eventId: "evt-idle-1", kind: "finished", message: "OpenCode finished: ses-root" })
    expect(processEvent(store, event({
      id: "evt-idle-2",
      type: "session.idle",
      properties: { sessionID: "ses-root" },
    }))).toBeUndefined()
    expect(processEvent(store, event({
      id: "evt-idle-3",
      type: "session.status",
      properties: { sessionID: "ses-root", status: { type: "idle" } },
    }))).toBeUndefined()
  })

  test("does not spawn for missing or invalid IDs, missing binary, or irrelevant events", () => {
    const calls: string[][] = []
    const spawn: NotificationSpawn = (command) => {
      calls.push(command)
      return { exited: Promise.resolve(0) }
    }
    const publish = createNotificationPublisher("/bin/pane-dash", spawn)
    const rawEvents = [
      event({ type: "permission.asked", properties: { permission: "file" } }),
      event({ id: "\u0001", type: "permission.asked", properties: { permission: "file" } }),
      event({ id: "evt-irrelevant", type: "message.updated", properties: {} }),
    ]
    for (const raw of rawEvents) publish(decideNotification(raw, context()))
    createNotificationPublisher(undefined, spawn)({ eventId: "evt-no-binary", kind: "error", message: "ignored" })

    expect(calls).toEqual([])
  })

  test("resolves the global binary with one exact tmux argv and rejects unavailable values", () => {
    const calls: Array<{ command: string[]; options: unknown }> = []
    const sync = (command: string[], options: { stdout: "pipe"; stderr: "ignore" }) => {
      calls.push({ command, options })
      return { exitCode: 0, stdout: "/opt/pane-dash\n" }
    }
    expect(resolveNotificationBinary(sync)).toBe("/opt/pane-dash")
    expect(calls).toEqual([{
      command: ["tmux", "show-options", "-gqv", "@pane_dash_notify_binary"],
      options: { stdout: "pipe", stderr: "ignore" },
    }])
    expect(resolveNotificationBinary(() => ({ exitCode: 1, stdout: "" }))).toBeUndefined()
    expect(resolveNotificationBinary(() => ({ exitCode: 0, stdout: "" }))).toBeUndefined()
    expect(resolveNotificationBinary(() => ({ exitCode: 0, stdout: "relative/pane-dash\n" }))).toBeUndefined()
  })

  test("isolates synchronous and asynchronous child failures", async () => {
    const notification: Notification = { eventId: "evt-failure", kind: "error", message: "OpenCode error: session" }
    const synchronousFailure: NotificationSpawn = () => { throw new Error("service unavailable") }
    expect(() => createNotificationPublisher("/bin/pane-dash", synchronousFailure)(notification)).not.toThrow()

    const asynchronousFailure: NotificationSpawn = () => ({ exited: Promise.reject(new Error("child failed")) })
    expect(() => createNotificationPublisher("/bin/pane-dash", asynchronousFailure)(notification)).not.toThrow()
    await Bun.sleep(0)
  })

  test("notification failure does not prevent existing status option writes", async () => {
    const calls: string[][] = []
    const statusSpawn: Spawn = (command) => {
      calls.push(command)
      return { exited: Promise.resolve(0) }
    }
    const writer = new TmuxWriter("%1", statusSpawn)
    const notification: Notification = { eventId: "evt-status", kind: "error", message: "OpenCode error: session" }
    expect(() => createNotificationPublisher("/bin/pane-dash", () => { throw new Error("stopped") })(notification)).not.toThrow()

    writer.setOption("@pane_dash_status", "working")
    await writer.flush()
    expect(calls).toEqual([["tmux", "set-option", "-pt", "%1", "@pane_dash_status", "working"]])
  })

  test("never maps heartbeat or metadata/status changes to a notification", () => {
    for (const raw of [
      event({ id: "evt-heartbeat", type: "heartbeat", properties: {} }),
      event({ id: "evt-title", type: "session.updated", properties: { info: { id: "ses-root", title: "Renamed" } } }),
      event({ id: "evt-retry", type: "session.status", properties: { sessionID: "ses-root", status: { type: "retry" } } }),
    ]) {
      expect(decideNotification(raw, context({ before: { status: "working" }, after: { status: "working" } }))).toBeUndefined()
    }
  })
})
