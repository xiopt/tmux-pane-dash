import { expect, test } from "bun:test"
import { managedTmuxBlock } from "../src/config-tmux"

test("literal-current-route=PASS command-substitution=NOT-EXECUTED", () => {
  const block = managedTmuxBlock("/tmp/a'b $(touch sentinel)")
  expect(block).toContain("$(touch sentinel)")
  expect(block).toContain("/current/pane_dash.tmux")
  console.log("literal-current-route=PASS command-substitution=NOT-EXECUTED")
})
