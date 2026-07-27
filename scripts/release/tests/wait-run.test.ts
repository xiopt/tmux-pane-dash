import { expect, test } from "bun:test"
import { waitForRun, type WaitDependencies } from "../wait-run"

type Result = { code: number; stdout: string; stderr: string }

const jobs = (...items: unknown[]) => JSON.stringify({ jobs: items })
const dependency = (responses: Result[], nowValues = [0, 0, 1_000, 2_000]): WaitDependencies & { calls: string[][] } => {
  let index = 0
  let nowIndex = 0
  const calls: string[][] = []
  return {
    calls,
    nowMs: () => nowValues[Math.min(nowIndex++, nowValues.length - 1)] ?? 0,
    sleep: async () => {},
    runGh: async (argv) => { calls.push([...argv]); return responses[Math.min(index++, responses.length - 1)] ?? { code: 1, stdout: "", stderr: "missing fixture" } },
  }
}

const run = (deps: WaitDependencies, overrides: Partial<Parameters<typeof waitForRun>[0]> = {}) => waitForRun({ runId: "42", job: "build-test", conclusion: "success", timeoutSeconds: 10, pollSeconds: 1, ...overrides }, deps)

test("waiter validates exact bounded CLI arguments", async () => {
  for (const input of [
    { runId: "", job: "build-test", conclusion: "success", timeoutSeconds: 10, pollSeconds: 1 },
    { runId: "-1", job: "build-test", conclusion: "success", timeoutSeconds: 10, pollSeconds: 1 },
    { runId: "42", job: "", conclusion: "success", timeoutSeconds: 10, pollSeconds: 1 },
    { runId: "42", job: "build-test", conclusion: "failure", timeoutSeconds: 10, pollSeconds: 1 },
    { runId: "42", job: "build-test", conclusion: "success", timeoutSeconds: 0, pollSeconds: 1 },
    { runId: "42", job: "build-test", conclusion: "success", timeoutSeconds: 181, pollSeconds: 1 },
    { runId: "42", job: "build-test", conclusion: "success", timeoutSeconds: 10, pollSeconds: 0 },
    { runId: "42", job: "build-test", conclusion: "success", timeoutSeconds: 10, pollSeconds: 61 },
  ]) await expect(waitForRun(input, dependency([]))).rejects.toThrow(/usage|bound|conclusion|decimal|timeout|poll|gh/i)
})

test("waiter polls latest jobs and succeeds exactly once for a completed matching job", async () => {
  const deps = dependency([{ code: 0, stdout: jobs({ id: 7, name: "build-test", status: "completed", conclusion: "success" }), stderr: "" }])
  await expect(run(deps)).resolves.toBeUndefined()
  expect(deps.calls).toEqual([["api", "--paginate", "repos/xiopt/tmux-pane-dash/actions/runs/42/jobs?filter=latest"]])
})

test("waiter rejects absent, duplicate, queued, wrong-conclusion, API failure, and timeout states", async () => {
  const cases: Array<{ responses: Result[]; message: RegExp; overrides?: Partial<Parameters<typeof waitForRun>[0]> }> = [
    { responses: [{ code: 0, stdout: jobs({ id: 1, name: "other", status: "completed", conclusion: "success" }), stderr: "" }], message: /job.*absent/i },
    { responses: [{ code: 0, stdout: jobs({ id: 1, name: "build-test", status: "queued" }), stderr: "" }], message: /timeout|deadline/i, overrides: { timeoutSeconds: 1 } },
    { responses: [{ code: 0, stdout: jobs({ id: 1, name: "build-test", status: "completed", conclusion: "failure" }), stderr: "" }], message: /conclusion/i },
    { responses: [{ code: 0, stdout: jobs({ id: 1, name: "build-test", status: "completed", conclusion: "success" }, { id: 2, name: "build-test", status: "completed", conclusion: "success" }), stderr: "" }], message: /duplicate/i },
    { responses: [{ code: 1, stdout: "", stderr: "gh failed" }], message: /gh|api/i },
  ]
  for (const item of cases) await expect(run(dependency(item.responses, [0, 2_000]), item.overrides)).rejects.toThrow(item.message)
})

test("waiter caps polling at the requested deadline", async () => {
  const deps = dependency([{ code: 0, stdout: jobs({ id: 1, name: "build-test", status: "in_progress", conclusion: null }), stderr: "" }], [0, 500, 1_001, 2_000])
  await expect(run(deps, { timeoutSeconds: 1, pollSeconds: 1 })).rejects.toThrow(/timeout|deadline/i)
  expect(deps.calls.length).toBeLessThanOrEqual(2)
})
