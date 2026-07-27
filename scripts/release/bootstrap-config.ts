#!/usr/bin/env bun

import { chmod, mkdir, realpath, writeFile } from "node:fs/promises"
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
      { type: "required_status_checks", parameters: { strict_required_status_checks_policy: true, do_not_enforce_on_create: false, required_status_checks: [{ context: "ci", integration_id: 15368 }] } },
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
    prevent_self_review: true,
    deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await chmod(path, 0o600)
}

/** Generate reviewed Stage-B policy request bodies without contacting GitHub. */
export async function writeBootstrapConfig(input: BootstrapInput): Promise<BootstrapResult> {
  validateReviewer(input.reviewerId)
  const output = await safeOutputDir(input.outputDir)
  const entries: Array<[string, unknown]> = [
    ["branch-ruleset.json", branchRuleset(input.reviewerId)],
    ["tag-ruleset.json", tagRuleset()],
    ...environments.map((name) => [`${name}.json`, environmentBody(name, input.reviewerId)] as [string, unknown]),
  ]
  for (const [name, value] of entries) await writeJson(join(output, name), value)
  return { paths: entries.map(([name]) => join(output, name)), summary: `reviewer=${input.reviewerId} branch=master tags=v* environments=${environments.join(",")}` }
}

if (import.meta.main) {
  try {
    const argv = process.argv.slice(2)
    if (argv.length !== 4 || argv[0] !== "--reviewer-id" || argv[2] !== "--output-dir" || !/^[0-9]+$/.test(argv[1])) throw new Error("usage: bootstrap-config.ts --reviewer-id NUMERIC_ID --output-dir OS_TEMP_DIR")
    const result = await writeBootstrapConfig({ reviewerId: Number(argv[1]), outputDir: argv[3] })
    for (const path of result.paths) console.log(path)
    console.log(result.summary)
  } catch (error) {
    console.error(error instanceof Error ? error.message : "bootstrap-config: failed")
    process.exitCode = 1
  }
}
