import { expect, test } from "bun:test"
import { managedTmuxBlock, planTmuxEdit, shellQuote } from "../src/config-tmux"

test("POSIX quote and managed block are exact for hostile install roots", () => {
  const root = "/tmp/a'b $(touch nope)"
  expect(shellQuote(root)).toBe("'/tmp/a'\\''b $(touch nope)'")
  expect(managedTmuxBlock("/tmp/a'b")).toBe("# >>> tmux-pane-dash (@xiopt/tmux-pane-dash) schema=1 >>>\nrun-shell '/tmp/a'\\''b/current/pane_dash.tmux'\n# <<< tmux-pane-dash (@xiopt/tmux-pane-dash) schema=1 <<<")
  for (const value of ["/tmp/a b", "/tmp/☃/$x;`whoami`", "$(touch sentinel)"]) expect(shellQuote(value)).toMatch(/^'.*'$/s)
})

test("tmux planner inserts minimally, is idempotent, and refuses malformed ownership", () => {
  const input = { logicalPath: "/home/me/.tmux.conf", resolvedPath: "/home/me/.tmux.conf", installRoot: "/root", bytes: new TextEncoder().encode("set -g status on"), migrate: false }
  const planned = planTmuxEdit(input)
  expect(new TextDecoder().decode(planned.bytes)).toBe(`set -g status on\n${managedTmuxBlock("/root")}`)
  expect(planTmuxEdit({ ...input, bytes: planned.bytes }).bytes).toEqual(planned.bytes)
  for (const source of ["# >>> tmux-pane-dash (@xiopt/tmux-pane-dash) schema=2 >>>", "# >>> tmux-pane-dash (@xiopt/tmux-pane-dash) schema=1 >>>\nrun-shell 'changed'\n# <<< tmux-pane-dash (@xiopt/tmux-pane-dash) schema=1 <<<", "run-shell '~/x/pane_dash.tmux'"]) expect(() => planTmuxEdit({ ...input, bytes: new TextEncoder().encode(source) })).toThrow()
})
