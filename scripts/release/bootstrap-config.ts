#!/usr/bin/env bun
import { chmod, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, relative, resolve, join } from "node:path"

export interface BootstrapInput {
  outputDir: string
  reviewerId: number
}

export interface BootstrapResult {
  paths: readonly string[]
  summary: string
}

const environments = ["github-draft", "npm-production", "release-promotion"] as const
const environmentFiles = environments.map((name) => `${name}.json`)
const deploymentBranchPolicyFiles = environments.map((name) => `${name}-deployment-branch-policy.json`)
const expectedFiles = ["branch-ruleset.json", "tag-ruleset.json", ...environmentFiles, ...deploymentBranchPolicyFiles]
const requiredStatusCheck = { context: "archive-dry-run", integration_id: 15368 } as const

function fail(message: string): never {
  throw new Error(`bootstrap-config: ${message}`)
}

function validateReviewer(reviewerId: number): void {
  if (!Number.isSafeInteger(reviewerId) || reviewerId <= 0) fail("reviewer ID must be a positive integer")
}

async function safeOutputDir(path: string): Promise<string> {
  if (!isAbsolute(path)) fail("output must be an absolute OS-temporary directory")
  const root = await realpath(resolve(tmpdir()))
  const candidate = resolve(path)
  const candidateReal = await realpath(candidate).catch((error) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return candidate; throw error })
  const rel = relative(root, candidateReal)
  if (rel.startsWith("..") || isAbsolute(rel) || candidateReal === resolve(process.cwd())) fail("output must be under the OS temporary directory")
  await mkdir(candidate, { recursive: true, mode: 0o700 })
  const real = await realpath(candidate)
  if (relative(root, real).startsWith("..") || real === resolve(process.cwd())) fail("output directory must not resolve into the repository")
  await chmod(real, 0o700)
  return real
}

function branchRuleset(reviewerId: number): Record<string, unknown> {
  return {
    name: "master",
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["refs/heads/master"], exclude: [] } },
    rules: [
      { type: "pull_request", parameters: { dismiss_stale_reviews_on_push: true, require_code_owner_review: false, require_last_push_approval: true, required_approving_review_count: 1, required_review_thread_resolution: true } },
      { type: "required_status_checks", parameters: { strict_required_status_checks_policy: true, do_not_enforce_on_create: false, required_status_checks: [requiredStatusCheck] } },
      { type: "non_fast_forward" },
      { type: "deletion" },
    ],
    bypass_actors: [{ actor_id: reviewerId, actor_type: "User", bypass_mode: "always" }],
  }
}

function tagRuleset(): Record<string, unknown> {
  return {
    name: "v*",
    target: "tag",
    enforcement: "active",
    conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
    rules: [{ type: "creation" }, { type: "update" }, { type: "deletion" }],
  }
}

function environmentBody(name: string, reviewerId: number): Record<string, unknown> {
  return {
    name,
    reviewers: [{ type: "User", id: reviewerId }],
    wait_timer: 0,
    prevent_self_review: false,
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  }
}

function deploymentBranchPolicy(): Record<string, unknown> {
  return { name: "v*", type: "tag" }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await chmod(path, 0o600)
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} must be an object`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(), keys = [...expected].sort()
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) fail(`${label} has unexpected or missing fields`)
}

async function readPrivateJson(path: string, label: string): Promise<unknown> {
  const info = await lstat(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") fail(`${label} is missing`)
    throw error
  })
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600) fail(`${label} must be a mode-0600 regular file`)
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch {
    fail(`${label} is not valid JSON`)
  }
}

function validateBranchRuleset(value: unknown): number {
  const body = object(value, "branch ruleset")
  const rules = body.rules
  if (!Array.isArray(rules)) fail("branch ruleset rules are invalid")
  const statusRules = rules.filter((rule) => typeof rule === "object" && rule !== null && !Array.isArray(rule) && (rule as Record<string, unknown>).type === "required_status_checks")
  if (statusRules.length !== 1) fail("branch ruleset must have one required status-check rule")
  const statusRule = object(statusRules[0], "branch required status-check rule")
  const parameters = object(statusRule.parameters, "branch required status-check parameters")
  if (parameters.strict_required_status_checks_policy !== true || parameters.do_not_enforce_on_create !== false) fail("branch required status-check policy is invalid")
  if (!Array.isArray(parameters.required_status_checks) || parameters.required_status_checks.length !== 1) fail("branch ruleset must require one status context")
  const statusCheck = object(parameters.required_status_checks[0], "branch required status context")
  exactKeys(statusCheck, ["context", "integration_id"], "branch required status context")
  if (statusCheck.context !== requiredStatusCheck.context || statusCheck.integration_id !== requiredStatusCheck.integration_id) fail("branch ruleset must require the terminal archive-dry-run status")

  if (!Array.isArray(body.bypass_actors) || body.bypass_actors.length !== 1) fail("branch ruleset must have one bypass actor")
  const bypassActor = object(body.bypass_actors[0], "branch ruleset bypass actor")
  exactKeys(bypassActor, ["actor_id", "actor_type", "bypass_mode"], "branch ruleset bypass actor")
  if (bypassActor.actor_type !== "User" || bypassActor.bypass_mode !== "always" || !Number.isSafeInteger(bypassActor.actor_id) || (bypassActor.actor_id as number) <= 0) fail("branch ruleset bypass actor is invalid")
  return bypassActor.actor_id as number
}

function validateEnvironmentBody(value: unknown, environment: string, reviewerId: number): void {
  const body = object(value, `${environment} environment`)
  exactKeys(body, ["name", "reviewers", "wait_timer", "prevent_self_review", "deployment_branch_policy"], `${environment} environment`)
  if (body.name !== environment || body.wait_timer !== 0 || body.prevent_self_review !== false) fail(`${environment} environment identity or protection is invalid`)
  if (!Array.isArray(body.reviewers) || body.reviewers.length !== 1) fail(`${environment} environment must have one reviewer`)
  const reviewer = object(body.reviewers[0], `${environment} reviewer`)
  exactKeys(reviewer, ["type", "id"], `${environment} reviewer`)
  if (reviewer.type !== "User" || reviewer.id !== reviewerId || !Number.isSafeInteger(reviewer.id) || (reviewer.id as number) <= 0) fail(`${environment} reviewer is invalid or substituted`)
  const branchPolicy = object(body.deployment_branch_policy, `${environment} deployment branch policy`)
  exactKeys(branchPolicy, ["protected_branches", "custom_branch_policies"], `${environment} deployment branch policy`)
  if (branchPolicy.protected_branches !== false || branchPolicy.custom_branch_policies !== true) fail(`${environment} must select custom deployment branch policies`)
}

function validateDeploymentBranchPolicy(value: unknown, environment: string): void {
  const policy = object(value, `${environment} deployment branch policy body`)
  exactKeys(policy, ["name", "type"], `${environment} deployment branch policy body`)
  if (policy.name !== "v*" || policy.type !== "tag") fail(`${environment} deployment branch policy must be the v* tag policy`)
}

async function validateOutput(output: string): Promise<readonly string[]> {
  const actual = (await readdir(output)).sort()
  const expected = [...expectedFiles].sort()
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) fail("output must contain exactly the bootstrap request bodies and one policy per environment")

  const reviewerId = validateBranchRuleset(await readPrivateJson(join(output, "branch-ruleset.json"), "branch ruleset"))
  await readPrivateJson(join(output, "tag-ruleset.json"), "tag ruleset")
  for (const environment of environments) {
    validateEnvironmentBody(await readPrivateJson(join(output, `${environment}.json`), `${environment} environment`), environment, reviewerId)
    validateDeploymentBranchPolicy(await readPrivateJson(join(output, `${environment}-deployment-branch-policy.json`), `${environment} deployment branch policy`), environment)
  }
  return expectedFiles.map((name) => join(output, name))
}

function generatedSummary(reviewerId: number): string {
  return `reviewer=${reviewerId} branch=master tags=v* environments=${environments.join(",")} deployment-branch-policies=v*:tag`
}

/** Validate reviewed Stage-B policy request bodies without contacting GitHub. */
export async function validateBootstrapConfig(outputDir: string): Promise<BootstrapResult> {
  const output = await safeOutputDir(outputDir)
  const paths = await validateOutput(output)
  return { paths, summary: `validated ${paths.length} bootstrap bodies deployment-branch-policies=v*:tag` }
}

/** Generate reviewed Stage-B policy request bodies without contacting GitHub. */
export async function writeBootstrapConfig(input: BootstrapInput): Promise<BootstrapResult> {
  validateReviewer(input.reviewerId)
  const output = await safeOutputDir(input.outputDir)
  const entries: Array<[string, unknown]> = [
    ["branch-ruleset.json", branchRuleset(input.reviewerId)],
    ["tag-ruleset.json", tagRuleset()],
    ...environments.map((name) => [`${name}.json`, environmentBody(name, input.reviewerId)] as [string, unknown]),
    ...environments.map((name) => [`${name}-deployment-branch-policy.json`, deploymentBranchPolicy()] as [string, unknown]),
  ]
  for (const [name, value] of entries) await writeJson(join(output, name), value)
  const paths = await validateOutput(output)
  return { paths, summary: generatedSummary(input.reviewerId) }
}

if (import.meta.main) {
  try {
    const argv = process.argv.slice(2)
    if (argv.length === 2 && argv[0] === "--validate") {
      const result = await validateBootstrapConfig(argv[1]!)
      for (const path of result.paths) console.log(path)
      console.log(result.summary)
    } else {
      if (argv.length !== 4 || argv[0] !== "--reviewer-id" || argv[2] !== "--output-dir" || !/^[0-9]+$/.test(argv[1])) throw new Error("usage: bootstrap-config.ts --reviewer-id NUMERIC_ID --output-dir OS_TEMP_DIR | --validate OS_TEMP_DIR")
      const result = await writeBootstrapConfig({ reviewerId: Number(argv[1]), outputDir: argv[3] })
      for (const path of result.paths) console.log(path)
      console.log(result.summary)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "bootstrap-config: failed")
    process.exitCode = 1
  }
}
