#!/usr/bin/env bun

import { createHash } from "node:crypto"
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { ApprovalEvidence, PendingApprovalEvidence, ProtectedEnvironment } from "../../release/verify-npm-provenance"

export interface ApprovalDependencies {
  runGh(argv: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }>
  writePrivateJson(path: string, value: unknown): Promise<void>
  sha256(bytes: Uint8Array): string
}

type JsonRecord = Record<string, unknown>

const REPOSITORY = "xiopt/tmux-pane-dash"
const REF = "refs/tags/v0.1.0"
const environments = new Set<ProtectedEnvironment>(["github-draft", "npm-production", "release-promotion"])
const deploymentKeys = [
  "url", "id", "node_id", "sha", "ref", "task", "payload", "original_environment", "environment",
  "description", "creator", "created_at", "updated_at", "statuses_url", "repository_url",
  "transient_environment", "production_environment", "performed_via_github_app",
] as const

function fail(message: string): never {
  throw new Error(`environment-approval: ${message}`)
}

function object(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} must be an object`)
  return value as JsonRecord
}

function exactKeys(value: JsonRecord, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(), expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(`${label} has unexpected fields`)
}

function positive(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) fail(`${label} must be a positive integer`)
  return value as number
}

function validateInput(input: { runId: number; expectedSha: string; environment: ProtectedEnvironment; comment: string }): void {
  positive(input.runId, "run ID")
  if (!/^[0-9a-f]{40}$/.test(input.expectedSha)) fail("expected SHA must be a 40-character lowercase hexadecimal commit")
  if (!environments.has(input.environment)) fail("unknown protected environment")
  if (typeof input.comment !== "string" || input.comment.length === 0 || input.comment.length > 256 || /[\u0000-\u001f\u007f]/.test(input.comment)) fail("comment is invalid")
}

function endpoint(runId: number): string {
  return `/repos/${REPOSITORY}/actions/runs/${runId}/pending_deployments`
}

function canonical(value: unknown): Uint8Array {
  const normalize = (input: unknown): unknown => {
    if (input === null || typeof input === "string" || typeof input === "boolean") return input
    if (typeof input === "number" && Number.isSafeInteger(input)) return input
    if (Array.isArray(input)) return input.map(normalize)
    if (typeof input === "object") {
      const record = input as JsonRecord
      return Object.fromEntries(Object.keys(record).sort().map((key) => [key, normalize(record[key])]))
    }
    fail("canonical JSON value is invalid")
  }
  return new TextEncoder().encode(`${JSON.stringify(normalize(value))}\n`)
}

async function ensureEvidenceDir(path: string): Promise<void> {
  try {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) fail("evidence directory must be a real directory")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    await mkdir(path, { recursive: true, mode: 0o700 })
  }
  await chmod(path, 0o700)
}

async function assertPrivateRegular(path: string): Promise<void> {
  const info = await lstat(path).catch((error) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") fail(`missing evidence ${path}`); throw error })
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600) fail(`evidence ${path} must be a mode-0600 regular file`)
}

async function writeText(deps: ApprovalDependencies, path: string, text: string): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, text, { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, path)
}

async function readJson(path: string): Promise<unknown> {
  await assertPrivateRegular(path)
  try { return JSON.parse(await readFile(path, "utf8")) } catch { fail(`evidence ${path} is not valid JSON`) }
}

function ghJson(result: { code: number; stdout: string; stderr: string }, label: string): unknown {
  if (result.code !== 0) fail(`${label} failed: ${result.stderr.trim() || "gh api failed"}`)
  try { return JSON.parse(result.stdout) } catch { fail(`${label} returned invalid JSON`) }
}

function login(result: { code: number; stdout: string; stderr: string }): string {
  if (result.code !== 0) fail(`user lookup failed: ${result.stderr.trim() || "gh api failed"}`)
  const value = result.stdout.trim()
  if (!/^[A-Za-z0-9-]+$/.test(value)) fail("current GitHub user login is invalid")
  return value
}

function pendingEnvironment(value: unknown, input: { runId: number; expectedSha: string; environment: ProtectedEnvironment }): { id: number; name: ProtectedEnvironment } {
  if (!Array.isArray(value)) fail("pending deployment response must be an array")
  const matches = value.filter((candidate) => {
    if (typeof candidate !== "object" || candidate === null) return false
    const environment = (candidate as JsonRecord).environment
    return typeof environment === "object" && environment !== null && (environment as JsonRecord).name === input.environment
  })
  if (matches.length !== 1) fail("pending deployment must contain exactly one matching environment")
  const entry = object(matches[0], "pending deployment")
  const environment = object(entry.environment, "pending environment")
  const id = positive(environment.id, "pending environment id")
  if (environment.name !== input.environment || entry.current_user_can_approve !== true) fail("pending environment is not approvable by the current user")
  return { id, name: input.environment }
}

async function captureParts(input: { runId: number; expectedSha: string; environment: ProtectedEnvironment; comment: string }, deps: ApprovalDependencies): Promise<{ environment: { id: number; name: ProtectedEnvironment }; approver: string; request: PendingApprovalEvidence["request"] }> {
  const pendingResult = await deps.runGh(["api", endpoint(input.runId)])
  const environment = pendingEnvironment(ghJson(pendingResult, "pending deployment GET"), input)
  const userResult = await deps.runGh(["api", "user", "--jq", ".login"])
  const approver = login(userResult)
  return { environment, approver, request: { comment: input.comment, environment_ids: [environment.id], state: "approved" } }
}

function pendingEvidence(input: { runId: number; expectedSha: string; environment: ProtectedEnvironment }, parts: Awaited<ReturnType<typeof captureParts>>): PendingApprovalEvidence {
  return { schemaVersion: 1, runId: input.runId, expectedSha: input.expectedSha, environment: parts.environment, approver: parts.approver, currentUserCanApprove: true, request: parts.request }
}

/** Capture one fresh, approvable protected-environment request without approving it. */
export async function capturePendingDeployment(input: { runId: number; expectedSha: string; environment: ProtectedEnvironment; evidenceDir: string; comment: string }, deps: ApprovalDependencies): Promise<PendingApprovalEvidence> {
  validateInput(input)
  await ensureEvidenceDir(input.evidenceDir)
  const parts = await captureParts(input, deps)
  const evidence = pendingEvidence(input, parts)
  await deps.writePrivateJson(join(input.evidenceDir, "pending-deployments.json"), {
    schemaVersion: 1, runId: input.runId, expectedSha: input.expectedSha, environment: parts.environment, currentUserCanApprove: true,
  })
  await deps.writePrivateJson(join(input.evidenceDir, "approver.json"), { approver: parts.approver, currentUserCanApprove: true })
  await deps.writePrivateJson(join(input.evidenceDir, "approval-request.json"), parts.request)
  return evidence
}

function exactDeployment(value: unknown, input: { runId: number; expectedSha: string; environment: ProtectedEnvironment }, environmentId: number): ApprovalEvidence["response"] {
  if (!Array.isArray(value) || value.length !== 1) fail("approval POST must return one Deployment array")
  const deployment = object(value[0], "deployment")
  const keys = Object.keys(deployment).sort()
  const expectedKeys = [...deploymentKeys].sort()
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) fail("deployment object has undocumented or missing fields")
  const id = positive(deployment.id, "deployment id")
  if (deployment.sha !== input.expectedSha || deployment.environment !== input.environment || deployment.ref !== REF || deployment.repository_url !== `https://api.github.com/repos/${REPOSITORY}` || deployment.url !== `https://api.github.com/repos/${REPOSITORY}/deployments/${id}` || deployment.statuses_url !== `https://api.github.com/repos/${REPOSITORY}/deployments/${id}/statuses`) fail("deployment does not match the approved request")
  if (typeof deployment.task !== "string" || typeof deployment.payload !== "object" || deployment.payload === null || typeof deployment.creator !== "object" || deployment.creator === null) fail("deployment object has invalid documented fields")
  return { httpStatus: 200, runId: input.runId, environmentId, deploymentId: id, environment: input.environment, sha: input.expectedSha, ref: REF, approved: true }
}

/** Re-capture stale evidence, POST once, and persist only sanitized identifiers. */
export async function approvePendingDeployment(input: { runId: number; expectedSha: string; environment: ProtectedEnvironment; evidenceDir: string; comment: string }, deps: ApprovalDependencies): Promise<ApprovalEvidence> {
  validateInput(input)
  await ensureEvidenceDir(input.evidenceDir)
  const parts = await captureParts(input, deps)
  const pendingPath = join(input.evidenceDir, "pending-deployments.json")
  const approverPath = join(input.evidenceDir, "approver.json")
  const requestPath = join(input.evidenceDir, "approval-request.json")
  const storedPending = object(await readJson(pendingPath), "stored pending evidence")
  const storedApprover = object(await readJson(approverPath), "stored approver evidence")
  exactKeys(storedPending, ["schemaVersion", "runId", "expectedSha", "environment", "currentUserCanApprove"], "stored pending evidence")
  exactKeys(storedApprover, ["approver", "currentUserCanApprove"], "stored approver evidence")
  const requestBytes = canonical(parts.request)
  await assertPrivateRegular(requestPath)
  const storedRequestBytes = await readFile(requestPath)
  if (Buffer.compare(Buffer.from(canonical({ schemaVersion: 1, runId: input.runId, expectedSha: input.expectedSha, environment: parts.environment, currentUserCanApprove: true })), Buffer.from(canonical(storedPending))) !== 0 || storedApprover.approver !== parts.approver || storedApprover.currentUserCanApprove !== true || Buffer.compare(Buffer.from(requestBytes), storedRequestBytes) !== 0) fail("capture evidence is stale or was modified")
  const requestSha256 = deps.sha256(requestBytes)
  await writeText(deps, join(input.evidenceDir, "approval-request.sha256"), requestSha256 + "\n")
  const post = await deps.runGh(["api", "--method", "POST", endpoint(input.runId), "--input", requestPath])
  const httpStatus = (post as { httpStatus?: unknown }).httpStatus
  if (httpStatus !== undefined && httpStatus !== 200) fail("approval POST returned HTTP " + String(httpStatus))
  const response = exactDeployment(ghJson(post, "approval POST"), input, parts.environment.id)
  const evidence: ApprovalEvidence = {
    schemaVersion: 1,
    runId: input.runId,
    expectedSha: input.expectedSha,
    environment: parts.environment,
    approver: parts.approver,
    currentUserCanApprove: true,
    requestSha256,
    response,
  }
  await deps.writePrivateJson(join(input.evidenceDir, "approval-response.json"), response)
  await deps.writePrivateJson(join(input.evidenceDir, "approval-evidence.json"), evidence)
  await rm(requestPath, { force: true })
  return evidence
}

function defaultWritePrivateJson(path: string, value: unknown): Promise<void> {
  return (async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, path)
  })()
}

function defaultSha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex") }

async function runGh(argv: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["gh", ...argv], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { code, stdout, stderr }
}

function parseCli(argv: readonly string[]): { mode: "capture" | "approve"; input: Parameters<typeof capturePendingDeployment>[0] } {
  const mode = argv[0] as "capture" | "approve"
  if (mode !== "capture" && mode !== "approve") fail("usage: capture|approve --run-id RUN_ID --sha TAG_SHA --environment ENVIRONMENT --evidence-dir DIR --comment COMMENT")
  const values = new Map<string, string>()
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1]
    if (!key?.startsWith("--") || value === undefined || values.has(key)) fail("invalid approval arguments")
    values.set(key, value)
  }
  if (values.size !== 5 || ["--run-id", "--sha", "--environment", "--evidence-dir", "--comment"].some((key) => !values.has(key))) fail("invalid approval arguments")
  if (!/^[0-9]+$/.test(values.get("--run-id")!)) fail("run ID must be decimal")
  return { mode, input: { runId: Number(values.get("--run-id")), expectedSha: values.get("--sha")!, environment: values.get("--environment") as ProtectedEnvironment, evidenceDir: values.get("--evidence-dir")!, comment: values.get("--comment")! } }
}

if (import.meta.main) {
  try {
    const { mode, input } = parseCli(process.argv.slice(2))
    const deps: ApprovalDependencies = { runGh, writePrivateJson: defaultWritePrivateJson, sha256: defaultSha256 }
    const result = mode === "capture" ? await capturePendingDeployment(input, deps) : await approvePendingDeployment(input, deps)
    console.log(JSON.stringify(result))
  } catch (error) {
    console.error(error instanceof Error ? error.message : "environment-approval: failed")
    process.exitCode = 1
  }
}
