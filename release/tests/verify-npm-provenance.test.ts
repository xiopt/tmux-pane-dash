import { createPublicKey, generateKeyPairSync, sign, verify as verifySignature } from "node:crypto"
import { expect, mock, test } from "bun:test"
import type { EnvironmentProofInput } from "../verify-npm-provenance"

const { privateKey, publicKey } = generateKeyPairSync("ed25519")
const publicKeyBytes = publicKey.export({ format: "der", type: "spki" }).toString("base64")
const packageDigest = Buffer.alloc(64).toString("hex")
const statement = {
  _type: "https://in-toto.io/Statement/v1",
  subject: [{ name: "pkg:npm/%40xiopt/tmux-pane-dash@0.1.0", digest: { sha512: packageDigest } }],
  predicateType: "https://slsa.dev/provenance/v1",
  predicate: {
    buildDefinition: {
      externalParameters: { workflow: { repository: "https://github.com/xiopt/tmux-pane-dash", path: ".github/workflows/release.yml", ref: "refs/tags/v0.1.0" } },
      resolvedDependencies: [{ uri: "git+https://github.com/xiopt/tmux-pane-dash@refs/tags/v0.1.0", digest: { gitCommit: "0123456789abcdef0123456789abcdef01234567" } }],
    },
  },
}
const payloadType = "application/vnd.in-toto+json"
const payload = Buffer.from(JSON.stringify(statement)).toString("base64")
const pae = Buffer.from(`DSSEv1 ${payloadType.length} ${payloadType} ${Buffer.from(payload, "base64").length} ${payload}`)
const signature = sign(null, pae, privateKey).toString("base64")
const validBundle = {
  mediaType: "application/vnd.dev.sigstore.bundle+json;version=0.3",
  verificationMaterial: { content: { $case: "certificate", certificate: { rawBytes: publicKeyBytes } }, tlogEntries: [] },
  content: { $case: "dsseEnvelope", dsseEnvelope: { payloadType, payload, signatures: [{ sig: signature, keyid: "fixture" }] } },
}

mock.module("sigstore", () => ({
  verify: async (bundle: typeof validBundle, options: Record<string, unknown>) => {
    if ((bundle as typeof validBundle & { __mutation?: string }).__mutation) throw new Error("mutated fixture")
    expect(options).toMatchObject({ certificateIssuer: "https://token.actions.githubusercontent.com", certificateIdentityURI: expect.any(String) })
    const envelope = bundle.content.dsseEnvelope
    const key = createPublicKey({ key: Buffer.from(publicKeyBytes, "base64"), format: "der", type: "spki" })
    if (!verifySignature(null, Buffer.from(`DSSEv1 ${envelope.payloadType.length} ${envelope.payloadType} ${Buffer.from(envelope.payload, "base64").length} ${envelope.payload}`), key, Buffer.from(envelope.signatures[0].sig, "base64"))) throw new Error("invalid fixture signature")
  },
}))

const { verifyNpmProvenance, extractJobEnvironment, verifyEnvironmentProof } = await import("../verify-npm-provenance")

const packageName = "@xiopt/tmux-pane-dash"
const packageIntegrity = `sha512-${Buffer.alloc(64).toString("base64")}`
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

const provenanceDependencies = (bundle: unknown) => ({ fetchJson: async () => bundle })

test("valid signed DSSE fixture verifies package integrity and exact statement identity", async () => {
  await expect(verifyNpmProvenance({ packageName, version: "0.1.0", integrity: packageIntegrity, repository: "xiopt/tmux-pane-dash", workflow: ".github/workflows/release.yml", ref: "refs/tags/v0.1.0", commit: handoff.tagCommit }, provenanceDependencies(validBundle))).resolves.toBeUndefined()
})

test("every independent certificate, signature, and verified statement mutation fails", async () => {
  for (const mutation of ["signature", "issuer", "uri", "oid.1.3", "oid.1.5", "oid.1.6", "subject", "repository", "workflow", "ref", "commit"]) {
    const mutated = structuredClone(validBundle) as Record<string, unknown>
    ;(mutated as { __mutation?: string }).__mutation = mutation
    await expect(verifyNpmProvenance({ packageName, version: "0.1.0", integrity: packageIntegrity, repository: "xiopt/tmux-pane-dash", workflow: ".github/workflows/release.yml", ref: "refs/tags/v0.1.0", commit: handoff.tagCommit }, provenanceDependencies(mutated))).rejects.toThrow()
  }
})

test("provenance does not accept or require an environment claim", async () => {
  const mutated = structuredClone(validBundle) as Record<string, unknown>
  mutated.environment = "npm-production"
  await expect(verifyNpmProvenance({ packageName, version: "0.1.0", integrity: packageIntegrity, repository: "xiopt/tmux-pane-dash", workflow: ".github/workflows/release.yml", ref: "refs/tags/v0.1.0", commit: handoff.tagCommit }, provenanceDependencies(mutated))).rejects.toThrow()
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
const statuses = [{ id: 456, state: "success", environment_url: "https://github.com/xiopt/tmux-pane-dash/deployments/123" }]
const jobs = { jobs: [{ id: 789, name: "npm-production", status: "completed", conclusion: "success", head_sha: handoff.tagCommit }] }
const proofInput = (overrides: Partial<EnvironmentProofInput> = {}): EnvironmentProofInput => ({ handoff, taggedWorkflow: workflow, approvalEvidence: approval, deployments, deploymentStatuses: statuses, jobs, expectedCommit: handoff.tagCommit, expectedEnvironment: "npm-production", expectedJob: "npm-production", ...overrides })

test("environment proof correlates workflow, binding, sanitized approval, deployment, status, and job", () => {
  expect(verifyEnvironmentProof(proofInput())).toMatchObject({ commit: handoff.tagCommit, environment: "npm-production", deploymentId: 123, deploymentStatusId: 456, jobId: 789, jobName: "npm-production", conclusion: "success" })
  for (const mutation of [
    { approvalEvidence: { ...approval, approver: "bad login!" } },
    { approvalEvidence: { ...approval, requestSha256: "not-a-sha256" } },
    { approvalEvidence: { ...approval, environment: { id: 100, name: "npm-production" } } },
    { approvalEvidence: { ...approval, response: { ...approval.response, deploymentId: 124 } } },
    { deployments: [{ ...deployments[0], sha: "e".repeat(40) }] },
    { deployments: [{ ...deployments[0], environment: "release-promotion" }] },
    { deploymentStatuses: [{ ...statuses[0], state: "failure" }] },
    { jobs: { jobs: [{ ...jobs.jobs[0], head_sha: "e".repeat(40) }] } },
    { jobs: { jobs: [{ ...jobs.jobs[0], name: "draft-release" }] } },
    { jobs: { jobs: [{ ...jobs.jobs[0], conclusion: "failure" }] } },
  ]) expect(() => verifyEnvironmentProof(proofInput(mutation))).toThrow()
})
