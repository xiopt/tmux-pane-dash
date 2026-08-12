import { expect, test } from "bun:test"
import { deriveTuiState, type TuiSessionSnapshot } from "../src/tui-state"

const session = (id: string, patch: Partial<TuiSessionSnapshot> = {}): TuiSessionSnapshot => ({ id, pending: false, error: false, ...patch })

test("TUI state resolves root and aggregates descendants in required priority", () => {
  const root = session("root", { title: "Root", model: "model", runtime: "idle" })
  const child = session("child", { parentID: "root", runtime: "busy" })
  const grandchild = session("grandchild", { parentID: "child", error: true })
  const unrelated = session("other", { pending: true })
  expect(deriveTuiState("child", [root, child, grandchild, unrelated])).toEqual({ rootID: "root", status: "error", title: "Root", model: "model" })
  expect(deriveTuiState("child", [root, child, { ...grandchild, error: false, pending: true }]).status).toBe("needs_input")
  expect(deriveTuiState("child", [root, child, { ...grandchild, error: false }]).status).toBe("working")
  expect(deriveTuiState("root", [root]).status).toBe("idle")
  expect(deriveTuiState("root", [session("root")]).status).toBe("idle")
  expect(deriveTuiState("missing", []).status).toBe("unknown")
})
