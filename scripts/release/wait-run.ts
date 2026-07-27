#!/usr/bin/env bun

export interface WaitDependencies {
  nowMs(): number
  sleep(ms: number): Promise<void>
  runGh(argv: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }>
}

export interface WaitInput {
  runId: string
  job: string
  conclusion: "success"
  timeoutSeconds: number
  pollSeconds: number
}

type Job = {
  id?: unknown
  name?: unknown
  status?: unknown
  conclusion?: unknown
}

function fail(message: string): never {
  throw new Error(`wait-run: ${message}`)
}

function validate(input: WaitInput): void {
  if (!/^[1-9][0-9]*$/.test(input.runId)) fail("run ID must be a positive decimal integer")
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.job)) fail("job name is invalid (usage)")
  if (input.conclusion !== "success") fail("only --conclusion success is supported")
  if (!Number.isInteger(input.timeoutSeconds) || input.timeoutSeconds < 1 || input.timeoutSeconds > 1800) fail("timeout must be between 1 and 1800 seconds")
  if (!Number.isInteger(input.pollSeconds) || input.pollSeconds < 1 || input.pollSeconds > 60) fail("poll must be between 1 and 60 seconds")
  if (input.pollSeconds > input.timeoutSeconds) fail("poll must not exceed timeout")
}

function parseJobs(stdout: string): Job[] {
  let parsed: unknown
  try { parsed = JSON.parse(stdout) } catch { fail("gh api returned invalid JSON") }
  if (Array.isArray(parsed)) return parsed as Job[]
  if (typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { jobs?: unknown }).jobs)) return (parsed as { jobs: Job[] }).jobs
  fail("gh api response has no jobs array")
}

/** Wait for one named job, never for the paused overall workflow. */
export async function waitForRun(input: WaitInput, deps: WaitDependencies): Promise<void> {
  validate(input)
  const start = deps.nowMs()
  const deadline = start + input.timeoutSeconds * 1000
  const endpoint = `repos/xiopt/tmux-pane-dash/actions/runs/${input.runId}/jobs?filter=latest`
  for (;;) {
    if (deps.nowMs() > deadline) fail(`deadline exceeded while waiting for ${input.job}`)
    const result = await deps.runGh(["api", "--paginate", endpoint])
    if (result.code !== 0) fail(`gh api failed: ${result.stderr.trim() || "unknown error"}`)
    const matches = parseJobs(result.stdout).filter((candidate) => candidate.name === input.job)
    if (matches.length > 1) fail(`duplicate job name ${input.job}`)
    if (matches.length === 0) fail(`job ${input.job} is absent from the run`)
    const job = matches[0]
    if (job.status === "completed") {
      if (job.conclusion !== input.conclusion) fail(`job ${input.job} completed with conclusion ${String(job.conclusion)}`)
      return
    }
    if (job.status !== "queued" && job.status !== "in_progress") fail(`job ${input.job} has unsupported status ${String(job.status)}`)
    const remaining = deadline - deps.nowMs()
    if (remaining <= 0) fail(`deadline exceeded while waiting for ${input.job}`)
    await deps.sleep(Math.min(input.pollSeconds * 1000, remaining))
  }
}

function parseCli(argv: readonly string[]): WaitInput {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith("--") || value === undefined || values.has(key)) fail("usage: --run-id RUN_ID --job JOB_NAME --conclusion success --timeout TIMEOUT_SECONDS --poll POLL_SECONDS")
    values.set(key, value)
  }
  const required = ["--run-id", "--job", "--conclusion", "--timeout", "--poll"]
  if (values.size !== required.length || required.some((key) => !values.has(key))) fail("usage: --run-id RUN_ID --job JOB_NAME --conclusion success --timeout TIMEOUT_SECONDS --poll POLL_SECONDS")
  const timeout = values.get("--timeout")!
  const poll = values.get("--poll")!
  if (!/^[0-9]+$/.test(timeout) || !/^[0-9]+$/.test(poll)) fail("timeout and poll must be decimal integers")
  return { runId: values.get("--run-id")!, job: values.get("--job")!, conclusion: values.get("--conclusion") as "success", timeoutSeconds: Number(timeout), pollSeconds: Number(poll) }
}

async function runGh(argv: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["gh", ...argv], { stdout: "pipe", stderr: "pipe" })
  const completed = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]).then(([stdout, stderr, code]) => ({ code, stdout, stderr }))
  let timer: ReturnType<typeof setTimeout> | undefined
  const bounded = new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    timer = setTimeout(() => { child.kill(); resolve({ code: 124, stdout: "", stderr: "gh api command timed out" }) }, 30_000)
  })
  try { return await Promise.race([completed, bounded]) } finally { if (timer) clearTimeout(timer) }
}

if (import.meta.main) {
  try {
    await waitForRun(parseCli(process.argv.slice(2)), { nowMs: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), runGh })
    console.log("wait-run: PASS")
  } catch (error) {
    console.error(error instanceof Error ? error.message : "wait-run: failed")
    process.exitCode = 1
  }
}
