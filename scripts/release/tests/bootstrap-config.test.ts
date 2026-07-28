import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validateBootstrapConfig, writeBootstrapConfig } from "../bootstrap-config"

const environments = ["github-draft", "npm-production", "release-promotion"] as const
const reviewerId = 10100850

function environmentFile(environment: string): string {
  return `${environment}.json`
}

function policyFile(environment: string): string {
  return `${environment}-deployment-branch-policy.json`
}

test("bootstrap writes active branch/tag rulesets, selected environments, and exact tag policies", async () => {
  const output = await mkdtemp(join(tmpdir(), "pane-dash-bootstrap-test-"))
  try {
    const result = await writeBootstrapConfig({ outputDir: output, reviewerId })
    expect(result.paths).toHaveLength(8)
    expect(result.summary).toContain(`reviewer=${reviewerId}`)
    expect(result.summary).toContain("deployment-branch-policies=v*:tag")
    const branch = JSON.parse(await readFile(join(output, "branch-ruleset.json"), "utf8"))
    const tags = JSON.parse(await readFile(join(output, "tag-ruleset.json"), "utf8"))
    expect(branch).toMatchObject({ name: "master", target: "branch", enforcement: "active" })
    expect(branch.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "pull_request", parameters: expect.objectContaining({ required_approving_review_count: 1 }) }),
      expect.objectContaining({ type: "required_status_checks" }),
      expect.objectContaining({ type: "non_fast_forward" }),
      expect.objectContaining({ type: "deletion" }),
    ]))
    expect(branch.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "required_status_checks",
        parameters: expect.objectContaining({
          required_status_checks: [{ context: "archive-dry-run", integration_id: 15368 }],
        }),
      }),
    ]))
    expect(branch.bypass_actors).toEqual([{ actor_id: reviewerId, actor_type: "User", bypass_mode: "always" }])
    expect(tags).toMatchObject({ name: "v*", target: "tag", enforcement: "active" })
    expect(tags.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "creation" }),
      expect.objectContaining({ type: "update" }),
      expect.objectContaining({ type: "deletion" }),
    ]))
    expect(tags).not.toHaveProperty("bypass_actors")
    for (const environment of environments) {
      const body = JSON.parse(await readFile(join(output, environmentFile(environment)), "utf8"))
      const policy = JSON.parse(await readFile(join(output, policyFile(environment)), "utf8"))
      expect(body).toMatchObject({ name: environment, reviewers: [{ type: "User", id: reviewerId }], prevent_self_review: false })
      expect(body.deployment_branch_policy).toEqual({ protected_branches: false, custom_branch_policies: true })
      expect(body).not.toHaveProperty("repository")
      expect(policy).toEqual({ name: "v*", type: "tag" })
      expect(result.paths.some((path) => path.endsWith(`/${policyFile(environment)}`))).toBe(true)
    }
    await expect(validateBootstrapConfig(output)).resolves.toMatchObject({ summary: expect.stringContaining("validated") })
  } finally {
    await rm(output, { recursive: true, force: true })
  }
})

test("bootstrap validation rejects malformed, missing, and extra deployment branch policies", async () => {
  const mutations: Array<{ name: string; apply(output: string): Promise<void> }> = [
    {
      name: "branch type",
      async apply(output) {
        const path = join(output, policyFile(environments[0]))
        const policy = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
        policy.type = "branch"
        await writeFile(path, `${JSON.stringify(policy)}\n`)
      },
    },
    {
      name: "wrong pattern",
      async apply(output) {
        const path = join(output, policyFile(environments[0]))
        const policy = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
        policy.name = "master"
        await writeFile(path, `${JSON.stringify(policy)}\n`)
      },
    },
    {
      name: "missing policy",
      async apply(output) {
        await rm(join(output, policyFile(environments[0])))
      },
    },
    {
      name: "extra policy",
      async apply(output) {
        await writeFile(join(output, "unexpected-deployment-branch-policy.json"), '{"name":"v*","type":"tag"}\n')
      },
    },
  ]

  for (const mutation of mutations) {
    const output = await mkdtemp(join(tmpdir(), "pane-dash-bootstrap-mutation-"))
    try {
      await writeBootstrapConfig({ outputDir: output, reviewerId })
      await mutation.apply(output)
      await expect(validateBootstrapConfig(output)).rejects.toThrow(/bootstrap-config/i)
    } finally {
      await rm(output, { recursive: true, force: true })
    }
  }
})

test("bootstrap validation rejects self-review and reviewer or status-check substitutions", async () => {
  const mutations: Array<{ name: string; apply(output: string): Promise<void> }> = [
    {
      name: "self-review",
      async apply(output) {
        const path = join(output, environmentFile(environments[0]))
        const body = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
        body.prevent_self_review = true
        await writeFile(path, `${JSON.stringify(body)}\n`)
      },
    },
    {
      name: "reviewer substitution",
      async apply(output) {
        const path = join(output, environmentFile(environments[0]))
        const body = JSON.parse(await readFile(path, "utf8")) as Record<string, any>
        body.reviewers[0].id = reviewerId + 1
        await writeFile(path, `${JSON.stringify(body)}\n`)
      },
    },
    {
      name: "ci status context",
      async apply(output) {
        const path = join(output, "branch-ruleset.json")
        const body = JSON.parse(await readFile(path, "utf8")) as Record<string, any>
        const rule = body.rules.find((candidate: Record<string, unknown>) => candidate.type === "required_status_checks")
        rule.parameters.required_status_checks[0].context = "ci"
        await writeFile(path, `${JSON.stringify(body)}\n`)
      },
    },
    {
      name: "unknown status context",
      async apply(output) {
        const path = join(output, "branch-ruleset.json")
        const body = JSON.parse(await readFile(path, "utf8")) as Record<string, any>
        const rule = body.rules.find((candidate: Record<string, unknown>) => candidate.type === "required_status_checks")
        rule.parameters.required_status_checks[0].context = "unknown-terminal-job"
        await writeFile(path, `${JSON.stringify(body)}\n`)
      },
    },
  ]

  for (const mutation of mutations) {
    const output = await mkdtemp(join(tmpdir(), "pane-dash-bootstrap-policy-mutation-"))
    try {
      await writeBootstrapConfig({ outputDir: output, reviewerId })
      await mutation.apply(output)
      await expect(validateBootstrapConfig(output), mutation.name).rejects.toThrow(/bootstrap-config/i)
    } finally {
      await rm(output, { recursive: true, force: true })
    }
  }
})

test("bootstrap rejects invalid reviewer IDs and repository output paths", async () => {
  const output = await mkdtemp(join(tmpdir(), "pane-dash-bootstrap-test-"))
  for (const reviewerId of [0, -1, 1.2, Number.NaN, "123" as never]) {
    await expect(writeBootstrapConfig({ outputDir: output, reviewerId: reviewerId as number })).rejects.toThrow(/reviewer/i)
  }
  await expect(writeBootstrapConfig({ outputDir: process.cwd(), reviewerId })).rejects.toThrow(/temporary|output/i)
})
