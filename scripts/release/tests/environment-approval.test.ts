import { expect, test } from "bun:test"
import { chmod, lstat, mkdtemp, readFile, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { approvePendingDeployment, capturePendingDeployment, type ApprovalDependencies } from "../environment-approval"

const pendingPath = "/repos/xiopt/tmux-pane-dash/actions/runs/42/pending_deployments"
const pending = [{ environment: { id: 99, name: "npm-production" }, wait_timer: 0, reviewers: [], current_user_can_approve: true }]
const deployment = { url: "https://api.github.com/repos/xiopt/tmux-pane-dash/deployments/123", id: 123, node_id: "D_kw", sha: "0123456789abcdef0123456789abcdef01234567", ref: "refs/tags/v0.1.0", task: "deploy", payload: {}, original_environment: "npm-production", environment: "npm-production", description: "release", creator: { login: "github-actions[bot]" }, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", statuses_url: "https://api.github.com/repos/xiopt/tmux-pane-dash/deployments/123/statuses", repository_url: "https://api.github.com/repos/xiopt/tmux-pane-dash", transient_environment: false, production_environment: true, performed_via_github_app: null }

const setup = async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), "pane-dash-approval-test-"))
  const calls: string[][] = []
  let postCount = 0
  const deps: ApprovalDependencies = {
    runGh: async (argv) => {
      calls.push([...argv])
      if (argv.join(" ") === `api ${pendingPath}`) return { code: 0, stdout: JSON.stringify(pending), stderr: "" }
      if (argv.join(" ") === "api user --jq .login") return { code: 0, stdout: "reviewer\n", stderr: "" }
      if (argv.includes("--method") && argv.includes("POST")) { postCount += 1; return { code: 0, stdout: JSON.stringify([deployment]), stderr: "" } }
      return { code: 1, stdout: "", stderr: "unexpected gh call" }
    },
    writePrivateJson: async (path, value) => {
      await Bun.write(path, `${JSON.stringify(value)}\n`)
      await chmod(path, 0o600)
    },
    sha256: (bytes) => Bun.CryptoHasher.hash("sha256", bytes, "hex"),
  }
  return { evidenceDir, calls, deps, get postCount() { return postCount } }
}

const input = (evidenceDir: string) => ({ runId: 42, expectedSha: "0123456789abcdef0123456789abcdef01234567", environment: "npm-production" as const, evidenceDir, comment: "approve v0.1.0" })

test("capture uses exact pending-deployment and current-user calls and sanitizes evidence", async () => {
  const fixture = await setup()
  const result = await capturePendingDeployment(input(fixture.evidenceDir), fixture.deps)
  expect(result).toMatchObject({ schemaVersion: 1, runId: 42, expectedSha: input(fixture.evidenceDir).expectedSha, environment: { id: 99, name: "npm-production" }, approver: "reviewer", currentUserCanApprove: true })
  expect(fixture.calls).toEqual([["api", pendingPath], ["api", "user", "--jq", ".login"]])
  expect(await readdir(fixture.evidenceDir)).toEqual(expect.arrayContaining(["pending-deployments.json", "approver.json", "approval-request.json"]))
  for (const path of ["pending-deployments.json", "approver.json", "approval-request.json"]) expect((await lstat(join(fixture.evidenceDir, path))).mode & 0o777).toBe(path === "approval-request.json" ? 0o600 : 0o600)
  expect(JSON.stringify(result)).not.toMatch(/reviewers|token|header|payload/i)
})

test("approval re-captures, hashes canonical request, makes one exact POST, and removes raw request", async () => {
  const fixture = await setup()
  await capturePendingDeployment(input(fixture.evidenceDir), fixture.deps)
  const result = await approvePendingDeployment(input(fixture.evidenceDir), fixture.deps)
  expect(fixture.postCount).toBe(1)
  expect(result).toMatchObject({ response: { httpStatus: 200, runId: 42, environmentId: 99, deploymentId: 123, environment: "npm-production", sha: input(fixture.evidenceDir).expectedSha, ref: "refs/tags/v0.1.0", approved: true } })
  expect(await readdir(fixture.evidenceDir)).not.toContain("approval-request.json")
  expect(await readdir(fixture.evidenceDir)).toEqual(expect.arrayContaining(["approval-request.sha256", "approval-response.json", "approval-evidence.json"]))
  expect(JSON.stringify(result)).not.toMatch(/creator|payload|statuses_url|repository_url|created_at|updated_at|comment/i)
  console.log("pending-get=PASS user-login=PASS sanitized=PASS request-sha256=PASS post-200-deployment-array=PASS historical-endpoint-calls=0")
})

test("approval rejects all stale or malformed pending/deployment responses before a second POST", async () => {
  for (const mutation of [
    () => pending.map((entry) => ({ ...entry, environment: { id: 100, name: entry.environment.name } })),
    () => [pending[0], pending[0]],
    () => [{ ...pending[0], current_user_can_approve: false }],
    () => [{ ...pending[0], environment: { id: 99, name: "release-promotion" } }],
    () => [],
    () => [Object.fromEntries(Object.entries(deployment).filter(([key]) => key !== "task"))],
  ]) {
    const fixture = await setup()
    await capturePendingDeployment(input(fixture.evidenceDir), fixture.deps)
    const original = fixture.deps.runGh
    fixture.deps.runGh = async (argv) => {
      if (argv.join(" ") === `api ${pendingPath}`) return { code: 0, stdout: JSON.stringify(mutation()), stderr: "" }
      return original(argv)
    }
    await expect(approvePendingDeployment(input(fixture.evidenceDir), fixture.deps)).rejects.toThrow()
    expect(fixture.postCount).toBe(0)
  }
})

test("approval rejects every independent POST deployment mutation", async () => {
  for (const mutate of [
    (value: typeof deployment) => ({ ...value, sha: "e".repeat(40) }),
    (value: typeof deployment) => ({ ...value, environment: "release-promotion" }),
    (value: typeof deployment) => ({ ...value, statuses_url: value.statuses_url.replace("/123/", "/124/") }),
    (value: typeof deployment) => ({ ...value, unexpected: true }),
  ]) {
    const fixture = await setup()
    await capturePendingDeployment(input(fixture.evidenceDir), fixture.deps)
    const original = fixture.deps.runGh
    fixture.deps.runGh = async (argv) => {
      if (argv.includes("--method") && argv.includes("POST")) return { code: 0, stdout: JSON.stringify([mutate(deployment)]), stderr: "" }
      return original(argv)
    }
    await expect(approvePendingDeployment(input(fixture.evidenceDir), fixture.deps)).rejects.toThrow()
    expect(fixture.postCount).toBe(0)
  }
})
