import { describe, expect, test } from "bun:test"
import { apply, createStore, derive, type NormEvent } from "../src/state"

function run(events: NormEvent[]) {
  const s = createStore()
  for (const e of events) apply(s, e)
  return derive(s)
}

describe("derive precedence", () => {
  test("starts unknown, no fake idle", () => {
    expect(run([]).status).toBe("unknown")
  })

  test("busy -> working, idle -> idle", () => {
    expect(run([{ type: "status", sessionID: "a", status: "busy" }]).status).toBe("working")
    expect(
      run([
        { type: "status", sessionID: "a", status: "busy" },
        { type: "status", sessionID: "a", status: "idle" },
      ]).status,
    ).toBe("idle")
  })

  test("retry counts as working", () => {
    expect(run([{ type: "status", sessionID: "a", status: "retry" }]).status).toBe("working")
  })

  test("pending request beats busy", () => {
    expect(
      run([
        { type: "status", sessionID: "a", status: "busy" },
        { type: "request.open", sessionID: "a", requestID: "r1" },
      ]).status,
    ).toBe("needs_input")
  })

  test("needs_input clears only when ALL requests closed", () => {
    const evs: NormEvent[] = [
      { type: "status", sessionID: "a", status: "busy" },
      { type: "request.open", sessionID: "a", requestID: "r1" },
      { type: "request.open", sessionID: "a", requestID: "r2" },
      { type: "request.close", sessionID: "a", requestID: "r1" },
    ]
    expect(run(evs).status).toBe("needs_input")
    expect(run([...evs, { type: "request.close", sessionID: "a", requestID: "r2" }]).status).toBe("working")
  })

  test("error latches; idle does NOT clear it", () => {
    expect(
      run([
        { type: "error", sessionID: "a" },
        { type: "status", sessionID: "a", status: "idle" },
      ]).status,
    ).toBe("error")
  })

  test("busy clears the error latch", () => {
    expect(
      run([
        { type: "error", sessionID: "a" },
        { type: "status", sessionID: "a", status: "busy" },
      ]).status,
    ).toBe("working")
  })

  test("user message clears latch but does not set working", () => {
    const r = run([
      { type: "status", sessionID: "a", status: "idle" },
      { type: "error", sessionID: "a" },
      { type: "user-message", sessionID: "a" },
    ])
    expect(r.status).toBe("idle")
  })

  test("error without sessionID latches on active session", () => {
    expect(
      run([
        { type: "active", sessionID: "a" },
        { type: "status", sessionID: "a", status: "idle" },
        { type: "error" },
      ]).status,
    ).toBe("error")
  })
})

describe("active-session attribution", () => {
  test("unrelated top-level session does not pollute active status", () => {
    expect(
      run([
        { type: "active", sessionID: "a" },
        { type: "status", sessionID: "a", status: "idle" },
        { type: "status", sessionID: "b", status: "busy" }, // background session
      ]).status,
    ).toBe("idle")
  })

  test("user message sets its top-level session active", () => {
    expect(
      run([
        { type: "status", sessionID: "a", status: "idle" },
        { type: "user-message", sessionID: "a" },
        { type: "status", sessionID: "b", status: "busy" }, // background session
      ]).status,
    ).toBe("idle")
  })

  test("user message in a child session resolves to its top-level parent", () => {
    const store = createStore()
    for (const event of [
      { type: "session.meta", sessionID: "child", parentID: "parent" },
      { type: "user-message", sessionID: "child" },
    ] satisfies NormEvent[]) {
      apply(store, event)
    }
    expect(store.activeSessionID).toBe("parent")
  })

  test("subagent (descendant) pending request blocks the parent", () => {
    expect(
      run([
        { type: "active", sessionID: "a" },
        { type: "status", sessionID: "a", status: "busy" },
        { type: "session.meta", sessionID: "sub", parentID: "a" },
        { type: "request.open", sessionID: "sub", requestID: "r1" },
      ]).status,
    ).toBe("needs_input")
  })

  test("no active session -> aggregate worst-state across sessions", () => {
    expect(
      run([
        { type: "status", sessionID: "a", status: "idle" },
        { type: "request.open", sessionID: "b", requestID: "r1" },
      ]).status,
    ).toBe("needs_input")
  })

  test("active-session switch recomputes immediately", () => {
    expect(
      run([
        { type: "active", sessionID: "a" },
        { type: "status", sessionID: "a", status: "busy" },
        { type: "status", sessionID: "b", status: "idle" },
        { type: "active", sessionID: "b" },
      ]).status,
    ).toBe("idle")
  })

  test("session.deleted drops its state", () => {
    expect(
      run([
        { type: "status", sessionID: "a", status: "busy" },
        { type: "session.deleted", sessionID: "a" },
      ]).status,
    ).toBe("unknown")
  })
})

describe("metadata", () => {
  test("title follows active session, model is instance-wide", () => {
    const r = run([
      { type: "active", sessionID: "a" },
      { type: "session.meta", sessionID: "a", title: "Fix auth" },
      { type: "model", model: "sonnet" },
    ])
    expect(r.title).toBe("Fix auth")
    expect(r.model).toBe("sonnet")
  })
})
