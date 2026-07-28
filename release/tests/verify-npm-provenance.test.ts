import { expect, test } from "bun:test"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EnvironmentProofInput } from "../verify-npm-provenance"

const { verifyNpmProvenance, extractJobEnvironment, verifyEnvironmentProof } = await import("../verify-npm-provenance")

const packageName = "@xiopt/tmux-pane-dash"
const packageIntegrity = `sha512-${Buffer.alloc(64).toString("base64")}`
const fixturePath = join(process.cwd(), "release/tests/fixtures/sigstore-valid-bundle.json")
const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as {
  bundle: Record<string, unknown>
  trustedRoot: Record<string, unknown>
  tuf: Record<string, unknown>
}
const certificateMutations = JSON.parse(await readFile(join(process.cwd(), "release/tests/fixtures/sigstore-certificate-mutations.json"), "utf8")) as Record<string, string>

const handoff = {
  schemaVersion: 1,
  tagCommit: "0123456789abcdef0123456789abcdef01234567",
  npm: {
    "@xiopt/pane-dash-opencode": { filename: "xiopt-pane-dash-opencode-0.1.0.tgz", integrity: packageIntegrity },
    "@xiopt/tmux-pane-dash": { filename: "xiopt-tmux-pane-dash-0.1.0.tgz", integrity: packageIntegrity },
  },
  verifier: { filename: "verify-npm-provenance.mjs", sha256: "a".repeat(64), size: 10 },
  trustedPublishers: {
    "@xiopt/pane-dash-opencode": { repository: "xiopt/tmux-pane-dash", workflow: "release.yml", environment: "npm-production", allowedAction: "npm publish" },
    "@xiopt/tmux-pane-dash": { repository: "xiopt/tmux-pane-dash", workflow: "release.yml", environment: "npm-production", allowedAction: "npm publish" },
  },
  releaseAssets: Object.fromEntries(["tmux-pane-dash-v0.1.0-aarch64-apple-darwin.tar.gz", "tmux-pane-dash-v0.1.0-x86_64-apple-darwin.tar.gz", "tmux-pane-dash-v0.1.0-aarch64-unknown-linux-musl.tar.gz", "tmux-pane-dash-v0.1.0-x86_64-unknown-linux-musl.tar.gz", "release-manifest.json", "SHA256SUMS"].map((name) => [name, "b".repeat(64)])),
} as const

function validBundleFor(certificateRawBytes?: string): Record<string, unknown> {
  const bundle = structuredClone(fixture.bundle) as Record<string, unknown>
  const verificationMaterial = bundle.verificationMaterial as Record<string, unknown>
  if (certificateRawBytes) verificationMaterial.certificate = { rawBytes: certificateRawBytes }
  return bundle
}

const validBundle = validBundleFor()

async function sigstoreDependencies(bundle: unknown) {
  const cache = join(tmpdir(), `task14-tuf-${process.pid}-${Math.random().toString(16).slice(2)}`)
  const repository = join(cache, encodeURIComponent("fixture.sigstore.test"))
  await mkdir(join(repository, "targets"), { recursive: true })
  const targetBytes = Buffer.from(JSON.stringify(fixture.trustedRoot) + "\n")
  const line = (value: unknown) => `${JSON.stringify(value)}\n`
  await Promise.all([
    writeFile(join(cache, "root.json"), line(fixture.tuf.root)),
    writeFile(join(repository, "root.json"), line(fixture.tuf.root)),
    writeFile(join(repository, "timestamp.json"), line(fixture.tuf.timestamp)),
    writeFile(join(repository, "snapshot.json"), line(fixture.tuf.snapshot)),
    writeFile(join(repository, "targets.json"), line(fixture.tuf.targets)),
    writeFile(join(repository, "targets", "trusted_root.json"), targetBytes),
  ])
  return {
    fetchJson: async () => bundle,
    sigstoreOptions: {
      tufMirrorURL: "https://fixture.sigstore.test",
      tufRootPath: join(cache, "root.json"),
      tufCachePath: cache,
      tufForceCache: true,
      ctLogThreshold: 0,
    },
    cleanup: () => rm(cache, { recursive: true, force: true }),
  }
}

test("provenance tests exercise the locked Sigstore verifier rather than a module mock", async () => {
  const source = await readFile(join(process.cwd(), "release/tests/verify-npm-provenance.test.ts"), "utf8")
  expect(source).not.toContain("mock.module(\"sigstore\"")
  expect(source).toContain("await verifyNpmProvenance")
  expect(source).toContain("certificateOIDs")
})

test("valid signed DSSE fixture verifies package integrity and exact statement identity", async () => {
  const dependencies = await sigstoreDependencies(validBundle)
  try {
    await expect(verifyNpmProvenance({ packageName, version: "0.1.0", integrity: packageIntegrity, repository: "xiopt/tmux-pane-dash", workflow: ".github/workflows/release.yml", ref: "refs/tags/v0.1.0", commit: handoff.tagCommit }, dependencies)).resolves.toBeUndefined()
  } finally { await dependencies.cleanup() }
})

test("every independent certificate, signature, and verified statement mutation fails", async () => {
  const mutations: Array<{ bundle: Record<string, unknown> }> = [
    { bundle: { ...validBundle, dsseEnvelope: { ...(validBundle.dsseEnvelope as Record<string, unknown>), signatures: [{ sig: "A".repeat(88), keyid: "fixture" }] } } },
    { bundle: validBundleFor(certificateMutations.issuer) },
    { bundle: validBundleFor(certificateMutations.uri) },
    { bundle: validBundleFor(certificateMutations.oid13) },
    { bundle: validBundleFor(certificateMutations.oid15) },
    { bundle: validBundleFor(certificateMutations.oid16) },
  ]
  for (const mutation of mutations) {
    const bundle = mutation.bundle
    const dependencies = await sigstoreDependencies(bundle)
    try {
      await expect(verifyNpmProvenance({ packageName, version: "0.1.0", integrity: packageIntegrity, repository: "xiopt/tmux-pane-dash", workflow: ".github/workflows/release.yml", ref: "refs/tags/v0.1.0", commit: handoff.tagCommit }, dependencies)).rejects.toThrow()
    } finally { await dependencies.cleanup() }
  }
  for (const mutation of ["subject", "subject-sha512", "repository", "workflow", "ref", "commit"] as const) {
    const dependencies = await sigstoreDependencies(validBundle)
    const expected = mutation === "subject" ? { packageName: "@xiopt/pane-dash-opencode" } : mutation === "subject-sha512" ? { integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}` } : mutation === "repository" ? { repository: "other/repository" } : mutation === "workflow" ? { workflow: "other.yml" } : mutation === "ref" ? { ref: "refs/heads/main" } : { commit: "e".repeat(40) }
    try {
      await expect(verifyNpmProvenance({ packageName, version: "0.1.0", integrity: packageIntegrity, repository: "xiopt/tmux-pane-dash", workflow: ".github/workflows/release.yml", ref: "refs/tags/v0.1.0", commit: handoff.tagCommit, ...expected } as never, dependencies)).rejects.toThrow()
    } finally { await dependencies.cleanup() }
  }
})

test("provenance does not accept or require an environment claim", async () => {
  const mutated = { ...validBundle, environment: "npm-production" }
  const dependencies = await sigstoreDependencies(mutated)
  try {
    await expect(verifyNpmProvenance({ packageName, version: "0.1.0", integrity: packageIntegrity, repository: "xiopt/tmux-pane-dash", workflow: ".github/workflows/release.yml", ref: "refs/tags/v0.1.0", commit: handoff.tagCommit }, dependencies)).rejects.toThrow()
  } finally { await dependencies.cleanup() }
})

const workflow = `name: Release\njobs:\n  draft-release:\n    environment: github-draft\n  npm-production:\n    environment: npm-production\n  promote-release:\n    environment: release-promotion\n`

test("environment parser accepts only strict scalar job environments", () => {
  expect(extractJobEnvironment(workflow, "draft-release")).toBe("github-draft")
  expect(extractJobEnvironment(workflow, "npm-production")).toBe("npm-production")
  expect(extractJobEnvironment(workflow, "promote-release")).toBe("release-promotion")
  for (const malformed of [
    workflow.replace("environment: github-draft", "environment: ${{ secrets.ENV }}"),
    workflow.replace("environment: github-draft", "environment:\n      name: github-draft"),
    workflow.replace("environment: github-draft", "environment: github-draft\n    environment: npm-production"),
    workflow.replace("jobs:", "&jobs:\njobs:").replace("environment:", "<<: *jobs\n    environment:"),
    "jobs:\n    draft-release:\n      environment: github-draft",
  ]) expect(() => extractJobEnvironment(malformed, "draft-release")).toThrow()
})

const approval = { schemaVersion: 1, runId: 42, expectedSha: handoff.tagCommit, environment: { id: 99, name: "npm-production" }, approver: "reviewer", currentUserCanApprove: true, requestSha256: "c".repeat(64), response: { httpStatus: 200, runId: 42, environmentId: 99, deploymentId: 123, environment: "npm-production", sha: handoff.tagCommit, ref: "refs/tags/v0.1.0", approved: true } } as const
const deployments = [{
  url: "https://api.github.com/repos/xiopt/tmux-pane-dash/deployments/123", id: 123, node_id: "MDExOkRlcGxveW1lbnQxMjM=", sha: handoff.tagCommit, ref: "refs/tags/v0.1.0", task: "deploy", payload: {}, original_environment: "npm-production", environment: "npm-production", description: "", creator: {}, created_at: "2026-07-27T00:00:00Z", updated_at: "2026-07-27T00:00:00Z", statuses_url: "https://api.github.com/repos/xiopt/tmux-pane-dash/deployments/123/statuses", repository_url: "https://api.github.com/repos/xiopt/tmux-pane-dash", transient_environment: false, production_environment: true, performed_via_github_app: null,
}]
const statuses = [{ id: 456, state: "success", deployment_id: 123, environment_url: "https://github.com/xiopt/tmux-pane-dash/deployments/123" }]
const jobs = { jobs: [{ id: 789, name: "npm-production", status: "completed", conclusion: "success", head_sha: handoff.tagCommit }] }
const proofInput = (overrides: Partial<EnvironmentProofInput> = {}): EnvironmentProofInput => ({ handoff, taggedWorkflow: workflow, approvalEvidence: approval, deployments, deploymentStatuses: statuses, jobs, expectedCommit: handoff.tagCommit, expectedEnvironment: "npm-production", expectedJob: "npm-production", ...overrides })

test("environment proof correlates all workflow bindings, sanitized approval, deployment, status, and job", () => {
  expect(verifyEnvironmentProof(proofInput())).toMatchObject({ commit: handoff.tagCommit, environment: "npm-production", deploymentId: 123, deploymentStatusId: 456, jobId: 789, jobName: "npm-production", conclusion: "success" })
  for (const mutation of [
    { approvalEvidence: { ...approval, approver: "bad login!" } },
    { approvalEvidence: { ...approval, requestSha256: "not-a-sha256" } },
    { approvalEvidence: { ...approval, environment: { id: 100, name: "npm-production" } } },
    { approvalEvidence: { ...approval, response: { ...approval.response, deploymentId: 124 } } },
    { deployments: [{ ...deployments[0], sha: "e".repeat(40) }] },
    { deployments: [deployments[0], deployments[0]] },
    { deployments: [{ ...deployments[0], environment: "release-promotion" }] },
    { deploymentStatuses: [{ ...statuses[0], state: "failure" }] },
    { jobs: { jobs: [{ ...jobs.jobs[0], head_sha: "e".repeat(40) }] } },
    { jobs: { jobs: [{ ...jobs.jobs[0], name: "draft-release" }] } },
    { jobs: { jobs: [{ ...jobs.jobs[0], conclusion: "failure" }] } },
    { expectedEnvironment: "release-promotion", expectedJob: "npm-production" },
    { expectedEnvironment: "npm-production", expectedJob: "promote-release" },
  ]) expect(() => verifyEnvironmentProof(proofInput(mutation))).toThrow()
})
