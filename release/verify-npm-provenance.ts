import { verify } from "sigstore"
import { readFile } from "node:fs/promises"
import { TAG } from "../scripts/release/contracts"

const REF = `refs/tags/${TAG}` as const

export interface VerifiedHandoff {
  schemaVersion: 1
  tagCommit: string
  npm: {
    "@xiopt/pane-dash-opencode": { filename: string; integrity: string }
    "@xiopt/tmux-pane-dash": { filename: string; integrity: string }
  }
  verifier: { filename: "verify-npm-provenance.mjs"; sha256: string; size: number }
  trustedPublishers: {
    "@xiopt/pane-dash-opencode": {
      repository: "xiopt/tmux-pane-dash"
      workflow: "release.yml"
      environment: "npm-production"
      allowedAction: "npm publish"
    }
    "@xiopt/tmux-pane-dash": {
      repository: "xiopt/tmux-pane-dash"
      workflow: "release.yml"
      environment: "npm-production"
      allowedAction: "npm publish"
    }
  }
  releaseAssets: Readonly<Record<string, string>>
}

export interface ExpectedNpmProvenance {
  packageName: string
  version: string
  integrity: string
  repository: "xiopt/tmux-pane-dash"
  workflow: ".github/workflows/release.yml"
  ref: typeof REF
  commit: string
}

export type ProtectedEnvironment = "github-draft" | "npm-production" | "release-promotion"

export interface PendingApprovalEvidence {
  schemaVersion: 1
  runId: number
  expectedSha: string
  environment: { id: number; name: ProtectedEnvironment }
  approver: string
  currentUserCanApprove: true
  request: { environment_ids: readonly [number]; state: "approved"; comment: string }
}

export interface ApprovalEvidence {
  schemaVersion: 1
  runId: number
  expectedSha: string
  environment: { id: number; name: ProtectedEnvironment }
  approver: string
  currentUserCanApprove: true
  requestSha256: string
  response: {
    httpStatus: 200
    runId: number
    environmentId: number
    deploymentId: number
    environment: ProtectedEnvironment
    sha: string
    ref: typeof REF
    approved: true
  }
}

export interface EnvironmentProofInput {
  handoff: VerifiedHandoff
  taggedWorkflow: string
  approvalEvidence: ApprovalEvidence
  deployments: unknown
  deploymentStatuses: unknown
  jobs: unknown
  expectedCommit: string
  expectedEnvironment: ProtectedEnvironment
  expectedJob: "draft-release" | "npm-production" | "promote-release"
}

export interface EnvironmentProof {
  commit: string
  environment: ProtectedEnvironment
  workflow: ".github/workflows/release.yml"
  trustedPublisherPackages: readonly [] | readonly ["@xiopt/pane-dash-opencode", "@xiopt/tmux-pane-dash"]
  approver: string
  requestSha256: string
  deploymentId: number
  deploymentStatusId: number
  jobId: number
  jobName: "draft-release" | "npm-production" | "promote-release"
  conclusion: "success"
}

export interface ProvenanceDependencies {
  fetchJson(url: string): Promise<unknown>
  /** Test-only trust configuration; production callers leave this undefined. */
  sigstoreOptions?: {
    tufMirrorURL?: string
    tufRootPath?: string
    tufCachePath?: string
    tufForceCache?: boolean
    ctLogThreshold?: number
    tlogThreshold?: number
  }
}

type JsonRecord = Record<string, unknown>
type Bundle = JsonRecord

const REPOSITORY = "xiopt/tmux-pane-dash"
const WORKFLOW = ".github/workflows/release.yml"
const EXPECTED_ISSUER = "https://token.actions.githubusercontent.com"
const EXPECTED_IDENTITY = `^https://github\\.com/xiopt/tmux-pane-dash/\\.github/workflows/release\\.yml@${REF.replaceAll(".", "\\.")}$`
const ENVIRONMENTS = new Set<ProtectedEnvironment>(["github-draft", "npm-production", "release-promotion"])
const JOBS = new Set(["draft-release", "npm-production", "promote-release"] as const)
const DEPLOYMENT_KEYS = new Set([
  "url", "id", "node_id", "sha", "ref", "task", "payload", "original_environment", "environment",
  "description", "creator", "created_at", "updated_at", "statuses_url", "repository_url",
  "transient_environment", "production_environment", "performed_via_github_app",
])
const RELEASE_ASSET_NAMES = [
  "tmux-pane-dash-v0.1.0-aarch64-apple-darwin.tar.gz",
  "tmux-pane-dash-v0.1.0-x86_64-apple-darwin.tar.gz",
  "tmux-pane-dash-v0.1.0-aarch64-unknown-linux-musl.tar.gz",
  "tmux-pane-dash-v0.1.0-x86_64-unknown-linux-musl.tar.gz",
  "release-manifest.json",
  "SHA256SUMS",
] as const

function fail(message: string): never {
  throw new Error(`provenance: ${message}`)
}

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} must be an object`)
  return value as JsonRecord
}

function exactKeys(value: JsonRecord, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(`${label} has unexpected fields`)
}

function stringField(value: JsonRecord, key: string, label: string): string {
  if (typeof value[key] !== "string" || value[key] === "") fail(`${label}.${key} must be a nonempty string`)
  return value[key] as string
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) fail(`${label} must be a positive integer`)
  return value as number
}

function sha512HexFromIntegrity(integrity: string): string {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity)
  if (!match) fail("integrity must be one SHA-512 SRI value")
  let digest: Buffer
  try { digest = Buffer.from(match[1], "base64") } catch { fail("integrity is not base64") }
  if (digest.length !== 64) fail("integrity must contain a 512-bit digest")
  return digest.toString("hex")
}

function packagePurl(packageName: string, version: string): string {
  if (!/^@xiopt\/(?:pane-dash-opencode|tmux-pane-dash)$/.test(packageName) || version !== "0.1.0") fail("package identity is outside the release")
  return `pkg:npm/${packageName.replace(/^@/, "%40")}@${version}`
}

function provenanceUrl(packageName: string): string {
  return `https://registry.npmjs.org/${encodeURIComponent(packageName)}`
}

function extractBundle(document: unknown): { bundle: Bundle; nextUrl?: string } {
  const root = record(document, "registry response")
  if (root.content || root.verificationMaterial || root.dsseEnvelope) return { bundle: root }
  return { bundle: root, nextUrl: typeof root.attestations === "string" ? root.attestations : undefined, }
}

function findProvenanceUrl(document: unknown, version: string): string | undefined {
  const root = record(document, "registry response")
  const versionRecord = record(record(root.versions, "registry versions")[version], "registry version")
  const dist = record(versionRecord.dist, "registry dist")
  const attestations = record(dist.attestations, "registry attestations")
  const provenance = attestations.provenance
  if (typeof provenance === "string") return provenance
  if (typeof provenance === "object" && provenance !== null) {
    const url = (provenance as JsonRecord).url
    if (typeof url === "string") return url
  }
  const url = attestations.url
  return typeof url === "string" ? url : undefined
}

function dsseEnvelope(bundle: Bundle): JsonRecord {
  const direct = bundle.dsseEnvelope
  if (direct !== undefined) return record(direct, "DSSE envelope")
  const content = record(bundle.content, "bundle content")
  if (content.$case !== "dsseEnvelope") fail("bundle content is not a DSSE envelope")
  return record(content.dsseEnvelope, "DSSE envelope")
}

function validateBundleShape(bundle: Bundle): void {
  const keys = Object.keys(bundle).sort()
  const modern = ["content", "mediaType", "verificationMaterial"].sort()
  const legacy = ["dsseEnvelope", "mediaType", "verificationMaterial"].sort()
  const matches = (expected: readonly string[]) => keys.length === expected.length && keys.every((key, index) => key === expected[index])
  if (!matches(modern) && !matches(legacy)) fail("bundle has undocumented fields")
}

function statementAfterVerification(bundle: Bundle): JsonRecord {
  const envelope = dsseEnvelope(bundle)
  const payload = envelope.payload
  if (typeof payload !== "string" || payload.length === 0) fail("verified DSSE envelope has no payload")
  let bytes: Buffer
  try { bytes = Buffer.from(payload, "base64") } catch { fail("verified DSSE payload is not base64") }
  if (bytes.length === 0) fail("verified DSSE payload is empty")
  let statement: unknown
  try { statement = JSON.parse(bytes.toString("utf8")) } catch { fail("verified DSSE payload is not JSON") }
  return record(statement, "in-toto statement")
}

function statementPredicate(statement: JsonRecord, expected: ExpectedNpmProvenance): void {
  exactKeys(statement, ["_type", "subject", "predicateType", "predicate"], "in-toto statement")
  if (statement._type !== "https://in-toto.io/Statement/v1" && statement._type !== "https://in-toto.io/Statement/v0.1") fail("statement type is not supported")
  if (statement.predicateType !== "https://slsa.dev/provenance/v1" && statement.predicateType !== "https://slsa.dev/provenance/v0.2") fail("predicate type is not supported")
  if (!Array.isArray(statement.subject) || statement.subject.length !== 1) fail("statement must contain exactly one subject")
  const subject = record(statement.subject[0], "subject")
  exactKeys(subject, ["name", "digest"], "subject")
  if (subject.name !== packagePurl(expected.packageName, expected.version)) fail("provenance subject package does not match")
  const digest = record(subject.digest, "subject digest")
  exactKeys(digest, ["sha512"], "subject digest")
  if (digest.sha512 !== sha512HexFromIntegrity(expected.integrity)) fail("provenance subject digest does not match")

  const predicate = record(statement.predicate, "predicate")
  const containsEnvironmentClaim = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(containsEnvironmentClaim)
    if (typeof value !== "object" || value === null) return false
    return Object.entries(value).some(([key, child]) => key === "environment" || containsEnvironmentClaim(child))
  }
  if (containsEnvironmentClaim(predicate)) fail("provenance predicate cannot claim a protected environment")
  const buildDefinition = predicate.buildDefinition
  if (buildDefinition !== undefined) {
    for (const key of Object.keys(predicate)) if (!["buildDefinition", "runDetails"].includes(key)) fail(`predicate has undocumented field ${key}`)
    const definition = record(buildDefinition, "build definition")
    const external = record(definition.externalParameters, "external parameters")
    const workflow = record(external.workflow, "workflow")
    if (workflow.repository !== `https://github.com/${expected.repository}` || workflow.path !== expected.workflow || workflow.ref !== expected.ref) fail("provenance workflow identity does not match")
    const dependencies = definition.resolvedDependencies
    if (!Array.isArray(dependencies) || dependencies.length !== 1) fail("provenance must contain one resolved dependency")
    const dependency = record(dependencies[0], "resolved dependency")
    if (dependency.uri !== `git+https://github.com/${expected.repository}@${expected.ref}`) fail("provenance repository/ref does not match")
    const dependencyDigest = record(dependency.digest, "resolved dependency digest")
    if (dependencyDigest.gitCommit !== expected.commit) fail("provenance commit does not match")
    return
  }

  for (const key of Object.keys(predicate)) if (!["buildType", "builder", "invocation", "metadata", "materials"].includes(key)) fail(`predicate has undocumented field ${key}`)
  const invocation = record(predicate.invocation, "invocation")
  const configSource = record(invocation.configSource, "config source")
  if (configSource.uri !== `git+https://github.com/${expected.repository}` && configSource.uri !== `git+https://github.com/${expected.repository}@${expected.ref}`) fail("provenance repository does not match")
  if (configSource.entryPoint !== expected.workflow) fail("provenance workflow does not match")
  const sourceDigest = record(configSource.digest, "config source digest")
  if (sourceDigest.sha1 !== expected.commit) fail("provenance commit does not match")
}

/** Verify one npm provenance bundle and then inspect only its verified payload. */
export async function verifyNpmProvenance(expected: ExpectedNpmProvenance, deps: ProvenanceDependencies): Promise<void> {
  if (expected.repository !== REPOSITORY || expected.workflow !== WORKFLOW || expected.ref !== REF || !/^[0-9a-f]{40}$/.test(expected.commit)) fail("expected provenance identity is invalid")
  const metadata = await deps.fetchJson(provenanceUrl(expected.packageName))
  let bundle: Bundle
  const found = extractBundle(metadata)
  if (found.nextUrl) bundle = record(await deps.fetchJson(found.nextUrl), "provenance bundle")
  else if (found.bundle.content || found.bundle.dsseEnvelope) bundle = found.bundle
  else {
    const url = findProvenanceUrl(metadata, expected.version)
    if (!url) fail("registry response has no provenance URL")
    bundle = record(await deps.fetchJson(url), "provenance bundle")
  }
  validateBundleShape(bundle)
  await verify(bundle as never, {
    certificateIssuer: EXPECTED_ISSUER,
    certificateIdentityURI: EXPECTED_IDENTITY,
    certificateOIDs: {
      ["1.3.6.1.4.1.57264.1.3"]: expected.commit,
      ["1.3.6.1.4.1.57264.1.5"]: expected.repository,
      ["1.3.6.1.4.1.57264.1.6"]: expected.ref,
    },
    ...(deps.sigstoreOptions?.tufMirrorURL ? { tufMirrorURL: deps.sigstoreOptions.tufMirrorURL } : {}),
    ...(deps.sigstoreOptions?.tufRootPath ? { tufRootPath: deps.sigstoreOptions.tufRootPath } : {}),
    ...(deps.sigstoreOptions?.tufCachePath ? { tufCachePath: deps.sigstoreOptions.tufCachePath } : {}),
    ...(deps.sigstoreOptions?.tufForceCache !== undefined ? { tufForceCache: deps.sigstoreOptions.tufForceCache } : {}),
    ...(deps.sigstoreOptions?.ctLogThreshold !== undefined ? { ctLogThreshold: deps.sigstoreOptions.ctLogThreshold } : {}),
    ...(deps.sigstoreOptions?.tlogThreshold !== undefined ? { tlogThreshold: deps.sigstoreOptions.tlogThreshold } : {}),
  } as never)
  const statement = statementAfterVerification(bundle)
  statementPredicate(statement, expected)
}

function stripComment(line: string): string {
  let quote: "'" | '"' | null = null
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (quote === "'" && character === "'") quote = null
    else if (quote === '"' && character === '"' && line[index - 1] !== "\\") quote = null
    else if (!quote && (character === "'" || character === '"')) quote = character
    else if (!quote && character === "#" && (index === 0 || /\s/.test(line[index - 1]))) return line.slice(0, index).trimEnd()
  }
  if (quote) fail("unterminated YAML quote")
  return line.trimEnd()
}

function yamlScalar(value: string, label: string): string {
  const trimmed = value.trim()
  if (!trimmed || /\$\{\{|[&*][A-Za-z_]/.test(trimmed) || trimmed.startsWith("<<:")) fail(`${label} must be a scalar`)
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) fail(`${label} cannot be an object or sequence`)
  if (trimmed.startsWith("'") || trimmed.startsWith('"')) {
    const quote = trimmed[0]
    if (trimmed.at(-1) !== quote) fail(`${label} has an invalid quote`)
    if (trimmed.slice(1, -1).includes(quote) && quote === "'") fail(`${label} has an invalid quote`)
    return quote === "'" ? trimmed.slice(1, -1).replaceAll("''", "'") : JSON.parse(trimmed) as string
  }
  if (/\s/.test(trimmed) || /[:{}[\],&*#?]|\s-\s/.test(trimmed)) fail(`${label} has an invalid plain scalar`)
  return trimmed
}

/** Extract a protected-environment scalar without accepting general YAML tricks. */
export function extractJobEnvironment(workflowYaml: string, job: "draft-release" | "npm-production" | "promote-release"): ProtectedEnvironment {
  const source = workflowYaml.replaceAll("\r\n", "\n")
  if (source.includes("\t")) fail("tabs are not valid workflow indentation")
  if (/[&*][A-Za-z_][A-Za-z0-9_-]*|^\s*<<\s*:/m.test(source)) fail("workflow aliases and merges are not accepted")
  const rawLines = source.split("\n")
  const lines = rawLines.map((raw, index) => {
    const content = stripComment(raw)
    if (!content.trim()) return { index, indent: 0, text: "" }
    const indent = content.length - content.trimStart().length
    if (indent % 2 !== 0) fail(`workflow indentation is malformed at line ${index + 1}`)
    return { index, indent, text: content.trim() }
  }).filter((line) => line.text)
  const jobsLine = lines.find((line) => line.indent === 0 && line.text === "jobs:")
  if (!jobsLine || lines.filter((line) => line.indent === 0 && /^jobs\s*:/.test(line.text)).length !== 1) fail("workflow must contain one top-level jobs mapping")
  const topLevelKeys = new Set<string>()
  for (const line of lines.filter((candidate) => candidate.indent === 0)) {
    const key = /^(?:['"]?)([A-Za-z0-9_.-]+)(?:['"]?)\s*:/.exec(line.text)?.[1]
    if (!key) continue
    if (topLevelKeys.has(key)) fail(`duplicate top-level YAML key ${key}`)
    topLevelKeys.add(key)
  }
  const jobLines = lines.filter((line) => line.index > jobsLine.index && line.indent === 2 && /^[A-Za-z0-9_-]+\s*:/.test(line.text))
  if (jobLines.length === 0 || jobLines.some((line) => line.text.slice(0, line.text.indexOf(":")) === "")) fail("jobs mapping is malformed")
  const names = new Set<string>()
  for (const line of jobLines) {
    const name = line.text.slice(0, line.text.indexOf(":"))
    if (names.has(name)) fail(`duplicate job key ${name}`)
    names.add(name)
  }
  const selected = jobLines.find((line) => line.text.startsWith(`${job}:`))
  if (!selected) fail(`job ${job} is missing`)
  const end = jobLines.find((line) => line.index > selected.index)
  const body = lines.filter((line) => line.index > selected.index && (!end || line.index < end.index))
  const environments = body.filter((line) => line.indent === 4 && /^environment\s*:/.test(line.text))
  if (environments.length !== 1) fail(`job ${job} must declare exactly one environment scalar`)
  const environmentLine = environments[0]
  const colon = environmentLine.text.indexOf(":")
  const value = environmentLine.text.slice(colon + 1).trim()
  if (!value) {
    const next = body.find((line) => line.index > environmentLine.index)
    if (next && next.indent > 4) fail("object-form environment is not accepted")
    fail("environment scalar is missing")
  }
  const parsed = yamlScalar(value, "environment") as ProtectedEnvironment
  if (!ENVIRONMENTS.has(parsed)) fail(`unknown protected environment ${parsed}`)
  return parsed
}

function validateHandoff(handoff: VerifiedHandoff): void {
  const value = record(handoff, "handoff")
  exactKeys(value, ["schemaVersion", "tagCommit", "npm", "verifier", "trustedPublishers", "releaseAssets"], "handoff")
  if (value.schemaVersion !== 1 || !/^[0-9a-f]{40}$/.test(String(value.tagCommit))) fail("handoff schema or tag commit is invalid")
  const npm = record(value.npm, "handoff npm")
  exactKeys(npm, ["@xiopt/pane-dash-opencode", "@xiopt/tmux-pane-dash"], "handoff npm")
  for (const name of ["@xiopt/pane-dash-opencode", "@xiopt/tmux-pane-dash"]) {
    const item = record(npm[name], `handoff npm ${name}`)
    exactKeys(item, ["filename", "integrity"], `handoff npm ${name}`)
    const expectedFilename = name === "@xiopt/pane-dash-opencode" ? "xiopt-pane-dash-opencode-0.1.0.tgz" : "xiopt-tmux-pane-dash-0.1.0.tgz"
    if (item.filename !== expectedFilename || typeof item.integrity !== "string") fail("handoff npm inventory is invalid")
    sha512HexFromIntegrity(item.integrity)
  }
  const verifier = record(value.verifier, "handoff verifier")
  exactKeys(verifier, ["filename", "sha256", "size"], "handoff verifier")
  if (verifier.filename !== "verify-npm-provenance.mjs" || !/^[0-9a-f]{64}$/.test(String(verifier.sha256)) || !Number.isSafeInteger(verifier.size) || (verifier.size as number) <= 0) fail("handoff verifier record is invalid")
  const publishers = record(value.trustedPublishers, "trusted publishers")
  exactKeys(publishers, ["@xiopt/pane-dash-opencode", "@xiopt/tmux-pane-dash"], "trusted publishers")
  for (const name of ["@xiopt/pane-dash-opencode", "@xiopt/tmux-pane-dash"]) {
    const publisher = record(publishers[name], `trusted publisher ${name}`)
    exactKeys(publisher, ["repository", "workflow", "environment", "allowedAction"], `trusted publisher ${name}`)
    if (publisher.repository !== REPOSITORY || publisher.workflow !== "release.yml" || publisher.environment !== "npm-production" || publisher.allowedAction !== "npm publish") fail("trusted publisher binding is invalid")
  }
  const assets = record(value.releaseAssets, "release assets")
  exactKeys(assets, RELEASE_ASSET_NAMES, "release assets")
  if (Object.values(assets).some((hash) => typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash))) fail("release asset handoff is invalid")
}

async function readJsonFile(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, "utf8")) } catch { fail(`cannot read JSON evidence: ${path}`) }
}

function cliValue(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag)
  if (index < 0 || index + 1 >= args.length || args[index + 1].startsWith("--") || args.indexOf(flag, index + 1) >= 0) fail(`missing or duplicate ${flag}`)
  return args[index + 1]
}

async function verifyProvenanceCli(args: readonly string[]): Promise<void> {
  const packageName = cliValue(args, "--package")
  const version = cliValue(args, "--version")
  const handoffPath = cliValue(args, "--handoff")
  const repository = cliValue(args, "--repository")
  const workflow = cliValue(args, "--workflow")
  const ref = cliValue(args, "--ref")
  if (args.length !== 12 || repository !== REPOSITORY || workflow !== WORKFLOW || ref !== REF) fail("invalid provenance CLI contract")
  const handoff = await readJsonFile(handoffPath) as VerifiedHandoff
  validateHandoff(handoff)
  const packageRecord = handoff.npm[packageName as keyof VerifiedHandoff["npm"]]
  if (!packageRecord) fail("package is absent from the verified handoff")
  await verifyNpmProvenance({ packageName, version, integrity: packageRecord.integrity, repository, workflow: workflow as ExpectedNpmProvenance["workflow"], ref: ref as ExpectedNpmProvenance["ref"], commit: handoff.tagCommit }, { fetchJson: async (url) => { const response = await fetch(url); if (!response.ok) fail(`provenance fetch returned HTTP ${response.status}`); return response.json() } })
}

async function verifyEnvironmentCli(args: readonly string[]): Promise<void> {
  const handoffPath = cliValue(args, "--handoff")
  const workflowPath = cliValue(args, "--tagged-workflow")
  const approvalPath = cliValue(args, "--approval-evidence")
  const deploymentsPath = cliValue(args, "--deployments")
  const statusesPath = cliValue(args, "--deployment-statuses")
  const jobsPath = cliValue(args, "--jobs")
  const commit = cliValue(args, "--commit")
  const environment = cliValue(args, "--environment") as ProtectedEnvironment
  const job = cliValue(args, "--job") as EnvironmentProofInput["expectedJob"]
  if (args.length !== 18 || !ENVIRONMENTS.has(environment) || !JOBS.has(job)) fail("invalid environment-proof CLI contract")
  const handoff = await readJsonFile(handoffPath) as VerifiedHandoff
  const proof = verifyEnvironmentProof({ handoff, taggedWorkflow: await readFile(workflowPath, "utf8"), approvalEvidence: await readJsonFile(approvalPath) as ApprovalEvidence, deployments: await readJsonFile(deploymentsPath), deploymentStatuses: await readJsonFile(statusesPath), jobs: await readJsonFile(jobsPath), expectedCommit: commit, expectedEnvironment: environment, expectedJob: job })
  process.stdout.write(`${JSON.stringify(proof)}\n`)
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2)
    if (args.includes("--verify-environment")) await verifyEnvironmentCli(args.filter((arg) => arg !== "--verify-environment"))
    else await verifyProvenanceCli(args)
  } catch (error) {
    console.error(error instanceof Error ? error.message : "provenance: verification failed")
    process.exitCode = 1
  }
}

function validateApproval(approval: ApprovalEvidence, expectedCommit: string, environment: ProtectedEnvironment): void {
  const value = record(approval, "approval evidence")
  exactKeys(value, ["schemaVersion", "runId", "expectedSha", "environment", "approver", "currentUserCanApprove", "requestSha256", "response"], "approval evidence")
  if (value.schemaVersion !== 1 || value.expectedSha !== expectedCommit || value.currentUserCanApprove !== true || typeof value.approver !== "string" || !/^[A-Za-z0-9-]+$/.test(value.approver)) fail("approval capture is invalid")
  const runId = positiveInteger(value.runId, "approval run ID")
  const capturedEnvironment = record(value.environment, "approval environment")
  exactKeys(capturedEnvironment, ["id", "name"], "approval environment")
  const id = positiveInteger(capturedEnvironment.id, "approval environment id")
  if (capturedEnvironment.name !== environment) fail("approval environment name does not match")
  const hash = value.requestSha256
  if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) fail("approval request hash is invalid")
  const response = record(value.response, "approval response")
  exactKeys(response, ["httpStatus", "runId", "environmentId", "deploymentId", "environment", "sha", "ref", "approved"], "approval response")
  if (response.httpStatus !== 200 || response.runId !== runId || response.environmentId !== id || response.environment !== environment || response.sha !== expectedCommit || response.ref !== REF || response.approved !== true) fail("approval response does not match capture")
  positiveInteger(response.deploymentId, "deployment id")
}

function deploymentRecord(value: unknown, expected: EnvironmentProofInput): JsonRecord {
  const deployments = Array.isArray(value) ? value : fail("deployments must be an array")
  if (deployments.length !== 1) fail("deployments must contain exactly one POST response")
  const approval = expected.approvalEvidence.response
  const deployment = record(deployments[0], "deployment")
  for (const key of Object.keys(deployment)) if (!DEPLOYMENT_KEYS.has(key)) fail(`deployment has undocumented field ${key}`)
  for (const key of DEPLOYMENT_KEYS) if (!(key in deployment)) fail(`deployment is missing ${key}`)
  const id = positiveInteger(deployment.id, "deployment id")
  const stringKeys = ["node_id", "sha", "ref", "task", "original_environment", "environment", "created_at", "updated_at", "statuses_url", "repository_url"] as const
  if (stringKeys.some((key) => typeof deployment[key] !== "string" || deployment[key] === "") || (typeof deployment.description !== "string" && deployment.description !== null)) fail("deployment shape is invalid")
  if (typeof deployment.payload !== "object" || deployment.payload === null || Array.isArray(deployment.payload) || typeof deployment.creator !== "object" || deployment.creator === null || Array.isArray(deployment.creator)) fail("deployment shape is invalid")
  if (typeof deployment.transient_environment !== "boolean" || typeof deployment.production_environment !== "boolean" || (deployment.performed_via_github_app !== null && (typeof deployment.performed_via_github_app !== "object" || Array.isArray(deployment.performed_via_github_app)))) fail("deployment shape is invalid")
  if (id !== approval.deploymentId || deployment.sha !== expected.expectedCommit || deployment.ref !== TAG || deployment.original_environment !== expected.expectedEnvironment || deployment.environment !== expected.expectedEnvironment || deployment.task !== "deploy" || deployment.repository_url !== "https://api.github.com/repos/xiopt/tmux-pane-dash" || deployment.statuses_url !== `https://api.github.com/repos/xiopt/tmux-pane-dash/deployments/${id}/statuses` || deployment.url !== `https://api.github.com/repos/xiopt/tmux-pane-dash/deployments/${id}` || Number.isNaN(Date.parse(deployment.created_at as string)) || Number.isNaN(Date.parse(deployment.updated_at as string)) || deployment.transient_environment !== false || deployment.production_environment !== (expected.expectedEnvironment === "npm-production")) fail("deployment does not match approval")
  return deployment
}

function successfulStatus(value: unknown, deploymentId: number): { id: number } {
  const statuses = Array.isArray(value) ? value : fail("deployment statuses must be an array")
  const matches = statuses.filter((item) => {
    if (typeof item !== "object" || item === null) return false
    const record = item as JsonRecord
    return record.deployment_id === deploymentId || record.environment_url === `https://github.com/xiopt/tmux-pane-dash/deployments/${deploymentId}` || record.deployment_url === `https://api.github.com/repos/xiopt/tmux-pane-dash/deployments/${deploymentId}`
  })
  if (matches.length !== 1) fail("deployment status is not unique")
  const status = record(matches[0], "deployment status")
  if (status.state !== "success") fail("deployment status is not successful")
  if (status.deployment_id !== undefined && status.deployment_id !== deploymentId) fail("deployment status deployment ID does not match")
  if (status.environment_url !== undefined && status.environment_url !== `https://github.com/xiopt/tmux-pane-dash/deployments/${deploymentId}`) fail("deployment status environment URL does not match")
  if (status.deployment_url !== undefined && status.deployment_url !== `https://api.github.com/repos/xiopt/tmux-pane-dash/deployments/${deploymentId}`) fail("deployment status URL does not match")
  return { id: positiveInteger(status.id, "deployment status id") }
}

function successfulJob(value: unknown, expected: EnvironmentProofInput): { id: number } {
  const root = record(value, "jobs")
  if (!Array.isArray(root.jobs)) fail("jobs response has no jobs array")
  const matches = root.jobs.filter((item) => typeof item === "object" && item !== null && (item as JsonRecord).name === expected.expectedJob)
  if (matches.length !== 1) fail("job name is not unique")
  const job = record(matches[0], "job")
  if (job.status !== "completed" || job.conclusion !== "success" || job.head_sha !== expected.expectedCommit) fail("job did not complete successfully for the expected commit")
  return { id: positiveInteger(job.id, "job id") }
}

/** Correlates release workflow source with protected-environment and deployment evidence. */
export function verifyEnvironmentProof(input: EnvironmentProofInput): EnvironmentProof {
  validateHandoff(input.handoff)
  if (!/^[0-9a-f]{40}$/.test(input.expectedCommit) || !ENVIRONMENTS.has(input.expectedEnvironment) || !JOBS.has(input.expectedJob)) fail("environment proof input is invalid")
  const expectedEnvironments: Record<EnvironmentProofInput["expectedJob"], ProtectedEnvironment> = {
    "draft-release": "github-draft",
    "npm-production": "npm-production",
    "promote-release": "release-promotion",
  }
  for (const [job, environment] of Object.entries(expectedEnvironments) as [EnvironmentProofInput["expectedJob"], ProtectedEnvironment][]) {
    if (extractJobEnvironment(input.taggedWorkflow, job) !== environment) fail("workflow environment binding does not match")
  }
  if (expectedEnvironments[input.expectedJob] !== input.expectedEnvironment) fail("selected job environment does not match")
  validateApproval(input.approvalEvidence, input.expectedCommit, input.expectedEnvironment)
  const deployment = deploymentRecord(input.deployments, input)
  const deploymentStatus = successfulStatus(input.deploymentStatuses, deployment.id as number)
  const job = successfulJob(input.jobs, input)
  if (input.expectedEnvironment === "npm-production") {
    const publishers = input.handoff.trustedPublishers
    if (!publishers["@xiopt/pane-dash-opencode"] || !publishers["@xiopt/tmux-pane-dash"]) fail("npm trusted publisher proof is missing")
  }
  return {
    commit: input.expectedCommit,
    environment: input.expectedEnvironment,
    workflow: WORKFLOW,
    trustedPublisherPackages: input.expectedEnvironment === "npm-production" ? ["@xiopt/pane-dash-opencode", "@xiopt/tmux-pane-dash"] : [],
    approver: input.approvalEvidence.approver,
    requestSha256: input.approvalEvidence.requestSha256,
    deploymentId: deployment.id as number,
    deploymentStatusId: deploymentStatus.id,
    jobId: job.id,
    jobName: input.expectedJob,
    conclusion: "success",
  }
}
