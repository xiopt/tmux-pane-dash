import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { normalize } from "../src/normalize"
import { apply, createStore, derive } from "../src/state"

const FIXTURES = join(import.meta.dir, "fixtures")

function replay(file: string) {
  const store = createStore()
  const statuses: string[] = []
  const lines = readFileSync(join(FIXTURES, file), "utf8").trim().split("\n")

  for (const line of lines) {
    const rec = JSON.parse(line)
    if (!rec.event) continue
    for (const event of normalize(rec.event)) apply(store, event)
    statuses.push(derive(store).status)
  }

  return { derived: derive(store), statuses }
}

describe("normalize unit mappings", () => {
  test("normalizes session lifecycle events", () => {
    expect(
      normalize({ type: "session.status", properties: { sessionID: "s1", status: { type: "busy" } } }),
    ).toEqual([{ type: "status", sessionID: "s1", status: "busy" }])
    expect(normalize({ type: "session.idle", properties: { sessionID: "s1" } })).toEqual([
      { type: "status", sessionID: "s1", status: "idle" },
    ])
    expect(normalize({ type: "session.error", properties: { sessionID: "s1" } })).toEqual([
      { type: "error", sessionID: "s1" },
    ])
  })

  test("uses asymmetric request IDs for permission and question replies", () => {
    expect(normalize({ type: "permission.asked", properties: { sessionID: "s1", id: "p1" } })).toEqual([
      { type: "request.open", sessionID: "s1", requestID: "p1" },
    ])
    expect(
      normalize({ type: "permission.replied", properties: { sessionID: "s1", requestID: "p1", reply: "reject" } }),
    ).toEqual([{ type: "request.close", sessionID: "s1", requestID: "p1" }])
    expect(normalize({ type: "question.asked", properties: { sessionID: "s1", id: "q1" } })).toEqual([
      { type: "request.open", sessionID: "s1", requestID: "q1" },
    ])
    expect(normalize({ type: "question.replied", properties: { sessionID: "s1", requestID: "q1" } })).toEqual([
      { type: "request.close", sessionID: "s1", requestID: "q1" },
    ])
  })

  test("normalizes session metadata and defensive deletion shapes", () => {
    expect(
      normalize({
        type: "session.created",
        properties: { info: { id: "child", parentID: "parent", title: "Child task" } },
      }),
    ).toEqual([{ type: "session.meta", sessionID: "child", parentID: "parent", title: "Child task" }])
    expect(
      normalize({ type: "session.updated", properties: { info: { id: "s1", title: "Renamed" } } }),
    ).toEqual([{ type: "session.meta", sessionID: "s1", parentID: undefined, title: "Renamed" }])
    expect(normalize({ type: "session.deleted", properties: { info: { id: "s1" } } })).toEqual([
      { type: "session.deleted", sessionID: "s1" },
    ])
    expect(normalize({ type: "session.deleted", properties: { sessionID: "s2" } })).toEqual([
      { type: "session.deleted", sessionID: "s2" },
    ])
  })

  test("normalizes user activity and assistant model metadata", () => {
    expect(
      normalize({
        type: "message.updated",
        properties: { info: { role: "user", sessionID: "s1", model: { modelID: "user-model" } } },
      }),
    ).toEqual([{ type: "user-message", sessionID: "s1" }])
    expect(
      normalize({
        type: "message.updated",
        properties: { info: { role: "assistant", sessionID: "s1", modelID: "assistant-model" } },
      }),
    ).toEqual([{ type: "model", model: "assistant-model" }])
    expect(
      normalize({
        type: "message.updated",
        properties: { info: { role: "assistant", sessionID: "s1", model: { modelID: "fallback-model" } } },
      }),
    ).toEqual([{ type: "model", model: "fallback-model" }])
  })

  test("ignores unknown and TUI selection events", () => {
    expect(normalize({ type: "storage.write", properties: {} })).toEqual([])
    expect(normalize({ type: "tui.session.select", properties: { sessionID: "s1" } })).toEqual([])
  })
})

describe("fixture replays", () => {
  for (const file of ["basic-idle.jsonl", "rich-permission-question-subagent.jsonl", "session-switch.jsonl"]) {
    test(`replay ${file} ends idle`, () => {
      expect(existsSync(join(FIXTURES, file))).toBe(true)
      expect(replay(file).derived.status).toBe("idle")
    })
  }

  test("rich fixture enters needs_input and working before all requests close", () => {
    const { statuses } = replay("rich-permission-question-subagent.jsonl")
    expect(statuses).toContain("needs_input")
    expect(statuses).toContain("working")
  })
})
