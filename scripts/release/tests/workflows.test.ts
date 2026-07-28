import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

const root = process.cwd()
const workflow = (name: string) => readFile(join(root, ".github", "workflows", name), "utf8")
const job = (text: string, name: string): string => {
  const match = new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [A-Za-z0-9_-]+:|(?![\\s\\S]))`, "m").exec(text)
  if (!match) throw new Error(`missing workflow job ${name}`)
  return match[1]
}
const runnerForTarget = (body: string, target: string): string => {
  const match = new RegExp(`^[ \\t]+- target: ${target}\\n[ \\t]+runner: ([^\\n]+)$`, "m").exec(body)
  if (!match) throw new Error(`missing runner mapping for ${target}`)
  return match[1]
}

const setupNode = (body: string, version: string) => {
  expect(body).toContain("uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0")
  expect(body).toContain(`node-version: \"${version}\"`)
  expect(body).not.toMatch(/^\s+cache(?:-dependency-path)?:/m)
}

const permissions = (body: string): Record<string, string> => {
  const block = /^    permissions:\n((?:      [A-Za-z-]+: [^\n]+\n?)*)/m.exec(body)?.[1] ?? ""
  return Object.fromEntries([...block.matchAll(/^      ([A-Za-z-]+): ([^\n]+)$/gm)].map((match) => [match[1], match[2]]))
}

type ParsedStep = {
  name?: string
  uses?: string
  run?: string
  with: Record<string, string>
  env: Record<string, string>
}

type ParsedJob = {
  name: string
  needs: string[]
  env: Record<string, string>
  permissions: Record<string, string>
  steps: ParsedStep[]
}

type ParsedWorkflow = { jobs: Record<string, ParsedJob> }

const indentOf = (line: string): number => line.length - line.trimStart().length
const scalar = (value: string): string => value.trim().replace(/\s+#.*$/, "")

function nestedMap(lines: string[], start: number, end: number, headerIndent: number, header: string): Record<string, string> {
  const result: Record<string, string> = {}
  const headerIndex = lines.findIndex((line, index) => index >= start && index < end && indentOf(line) === headerIndent && line.trimStart().startsWith(`${header}:`))
  if (headerIndex < 0) return result
  for (let index = headerIndex + 1; index < end; index += 1) {
    const line = lines[index]!
    const indent = indentOf(line)
    if (line.trim() && indent <= headerIndent) break
    if (indent !== headerIndent + 2) continue
    const match = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line.trim())
    if (match) result[match[1]!] = scalar(match[2]!)
  }
  return result
}

function parseStep(lines: string[], start: number, end: number): ParsedStep {
  const step: ParsedStep = { with: {}, env: {} }
  const header = lines[start]!.trim().slice(1).trim()
  const headerMatch = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(header)
  if (headerMatch) {
    const key = headerMatch[1]!, value = scalar(headerMatch[2]!)
    if (key === "name") step.name = value
    else if (key === "uses") step.uses = value
    else if (key === "run") step.run = value === "|" || value === ">" ? lines.slice(start + 1, end).map((line) => line.trimStart()).join("\n") : value
  }
  for (let index = start + 1; index < end; index += 1) {
    const line = lines[index]!
    if (!line.trim() || indentOf(line) !== 8) continue
    const match = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line.trim())
    if (!match) continue
    const key = match[1]!, value = scalar(match[2]!)
    if (key === "name") step.name = value
    else if (key === "uses") step.uses = value
    else if (key === "run") {
      if (value === "|" || value === ">") {
        const block: string[] = []
        for (let body = index + 1; body < end; body += 1) {
          const bodyLine = lines[body]!
          if (bodyLine.trim() && indentOf(bodyLine) <= 8) break
          block.push(bodyLine.trimStart())
        }
        step.run = block.join("\n")
      } else step.run = value
    } else if (key === "with" || key === "env") {
      const target = key === "with" ? step.with : step.env
      for (let nested = index + 1; nested < end; nested += 1) {
        const nestedLine = lines[nested]!
        const nestedIndent = indentOf(nestedLine)
        if (nestedLine.trim() && nestedIndent <= 8) break
        if (nestedIndent !== 10) continue
        const nestedMatch = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(nestedLine.trim())
        if (nestedMatch) target[nestedMatch[1]!] = scalar(nestedMatch[2]!)
      }
    }
  }
  return step
}

function parseWorkflow(text: string): ParsedWorkflow {
  const lines = text.replaceAll("\r\n", "\n").split("\n")
  const starts = lines.flatMap((line, index) => {
    const match = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line)
    return match ? [{ index, name: match[1]! }] : []
  })
  const jobs: Record<string, ParsedJob> = {}
  for (const [position, current] of starts.entries()) {
    const end = starts[position + 1]?.index ?? lines.length
    const needsLine = lines.slice(current.index + 1, end).find((line) => indentOf(line) === 4 && line.trimStart().startsWith("needs:"))
    const needsValue = needsLine?.slice(needsLine.indexOf(":") + 1).trim() ?? ""
    const needs = needsValue.startsWith("[")
      ? needsValue.slice(1, -1).split(",").map((value) => scalar(value)).filter(Boolean)
      : needsValue ? [scalar(needsValue)] : []
    const stepStarts = lines.flatMap((line, index) => index > current.index && index < end && indentOf(line) === 6 && /^-\s/.test(line.trimStart()) ? [index] : [])
    const steps = stepStarts.map((index, stepPosition) => parseStep(lines, index, stepStarts[stepPosition + 1] ?? end))
    jobs[current.name] = {
      name: current.name,
      needs,
      env: nestedMap(lines, current.index + 1, end, 4, "env"),
      permissions: nestedMap(lines, current.index + 1, end, 4, "permissions"),
      steps,
    }
  }
  return { jobs }
}

const stepCommands = (step: ParsedStep): string[] => (step.run ?? "").split("\n").filter((line) => !line.trimStart().startsWith("#"))
const hasGhCommand = (step: ParsedStep): boolean => stepCommands(step).some((line) => /\bgh\s+(?:api|release|run|attestation)\b/.test(line))
const jobHasGhAuth = (job: ParsedJob): boolean => job.env.GH_TOKEN === "${{ github.token }}" || job.steps.some((step) => step.env.GH_TOKEN === "${{ github.token }}")

function assertGhAuthentication(workflow: ParsedWorkflow, text: string): void {
  if (/\b(?:NPM_TOKEN|NODE_AUTH_TOKEN|GITHUB_TOKEN)\b/.test(text)) throw new Error("workflow contains a forbidden credential")
  for (const job of Object.values(workflow.jobs)) {
    const gh = job.steps.some(hasGhCommand)
    if (gh !== jobHasGhAuth(job)) throw new Error(`${job.name} GH commands must map to exactly one GH_TOKEN-authenticated job`)
  }
  const expected: Record<string, Record<string, string>> = {
    "draft-release": { contents: "write", "id-token": "write", attestations: "write" },
    "validate-draft": { contents: "read" },
    "promote-release": { contents: "write", actions: "read", deployments: "read" },
  }
  for (const [name, permissions] of Object.entries(expected)) {
    const job = workflow.jobs[name]
    if (job && jobHasGhAuth(job) && JSON.stringify(job.permissions) !== JSON.stringify(permissions)) throw new Error(`${name} has broader or different permissions than its GH commands require`)
  }
}

const normalizedArtifact = (value: string): string => value.replace(/\$\{\{[^}]+\}\}/g, "*")
const globMatches = (value: string, pattern: string): boolean => {
  const escaped = normalizedArtifact(pattern).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")
  return new RegExp(`^${escaped}$`).test(normalizedArtifact(value))
}

function dependsOn(workflow: ParsedWorkflow, consumer: string, producer: string, seen = new Set<string>()): boolean {
  if (consumer === producer) return true
  if (seen.has(consumer)) return false
  seen.add(consumer)
  return (workflow.jobs[consumer]?.needs ?? []).some((need) => need === producer || dependsOn(workflow, need, producer, seen))
}

function assertArtifactGraph(workflow: ParsedWorkflow): void {
  const producers: Array<{ name: string; job: string }> = []
  const consumers: Array<{ name?: string; pattern?: string; job: string }> = []
  for (const job of Object.values(workflow.jobs)) for (const step of job.steps) {
    if (step.uses?.startsWith("actions/upload-artifact@")) {
      if (!step.with.name) throw new Error(`${job.name} artifact producer has no name`)
      producers.push({ name: step.with.name, job: job.name })
    }
    if (step.uses?.startsWith("actions/download-artifact@")) {
      if (!step.with.name && !step.with.pattern) throw new Error(`${job.name} artifact consumer has no name or pattern`)
      consumers.push({ name: step.with.name, pattern: step.with.pattern, job: job.name })
    }
  }
  for (const consumer of consumers) {
    const matches = producers.filter((producer) => consumer.name ? globMatches(producer.name, consumer.name) : globMatches(producer.name, consumer.pattern!))
    if (matches.length === 0) throw new Error(`${consumer.job} consumes an artifact without a producer`)
    if (matches.some((producer) => !dependsOn(workflow, consumer.job, producer.job))) throw new Error(`${consumer.job} consumes an artifact before its producer`)
  }
}

function hasToolProvision(job: ParsedJob, before: number): boolean {
  return job.steps.slice(0, before).some((step) => {
    const run = step.run ?? ""
    return run.includes("scripts/release/ci-tmux.sh") && run.includes("export TMUX_BIN") && run.includes("BUN_BOOTSTRAP=") && run.includes("GITHUB_ENV")
  })
}

function assertTmuxProvisioning(workflow: ParsedWorkflow, workflowName: string): void {
  const explicitlyRequired = workflowName === "release.yml" ? ["build-test", "build-four-targets", "validate-draft"] : workflowName === "ci.yml" ? ["four-targets"] : []
  for (const job of Object.values(workflow.jobs)) {
    const dependentStep = job.steps.findIndex((step) => {
      const run = step.run ?? ""
      return run.includes("scripts/release/clean-room.sh") || run.includes("packed-e2e.test.ts") || run.includes("tests/source_package.sh") || /\bbats\s+tests\b/.test(run)
    })
    const required = dependentStep >= 0 ? dependentStep : explicitlyRequired.includes(job.name) ? job.steps.length : -1
    if (required >= 0 && !hasToolProvision(job, required)) throw new Error(`${workflowName}:${job.name} needs TMUX_BIN and BUN_BOOTSTRAP before clean-room or tmux work`)
  }
}

function assertPackedE2EGraph(workflow: ParsedWorkflow): void {
  for (const job of Object.values(workflow.jobs)) for (const step of job.steps) {
    const run = step.run ?? ""
    if (!run.includes("packages/tmux-pane-dash/tests/packed-e2e.test.ts")) continue
    for (const wrapper of ["tests/release/with-node20.sh --", "tests/release/with-rust.sh --", "scripts/release/clean-room.sh --"]) if (!run.includes(wrapper)) throw new Error(`${job.name} has a bare packed E2E invocation`)
    if (!run.includes("TARGET_KEY=linux-x64")) throw new Error(`${job.name} packed E2E must select linux-x64`)
  }
}

function assertPromotionGraph(workflow: ParsedWorkflow): void {
  const job = workflow.jobs["promote-release"]
  if (!job) throw new Error("promote-release is missing")
  if (job.steps.some((step) => (step.run ?? "").includes("approval-evidence") || step.with.name === "approval-evidence")) throw new Error("promotion has an impossible approval-evidence artifact dependency")
  const proof = job.steps.findIndex((step) => {
    const run = step.run ?? ""
    return run.includes("/environments/release-promotion") && run.includes("deployments?sha=$GITHUB_SHA") && run.includes("/statuses?") && run.includes("actions/runs/$GITHUB_RUN_ID/jobs") && run.includes("required_reviewers") && run.includes('state !== "in_progress"')
  })
  const mutation = job.steps.findIndex((step) => (step.run ?? "").includes("gh release edit"))
  if (proof < 0 || mutation < 0 || proof >= mutation) throw new Error("promotion mutation is not preceded by direct live deployment proof")
  const proofRun = job.steps[proof]!.run ?? ""
  if (proofRun.includes("conclusion !== \"success\"") || proofRun.includes("approval-response")) throw new Error("promotion uses synthetic completed-job or approval artifact proof")
}

function assertWorkflowGraph(text: string, workflowName: string): void {
  const workflow = parseWorkflow(text)
  assertGhAuthentication(workflow, text)
  assertArtifactGraph(workflow)
  assertTmuxProvisioning(workflow, workflowName)
  assertPackedE2EGraph(workflow)
  if (workflowName === "release.yml") assertPromotionGraph(workflow)
}

test("CI is read-only, ordered, and runs all four target commands plus isolated contracts", async () => {
  const text = await workflow("ci.yml")
  expect(text).toContain("pull_request:")
  expect(text).toMatch(/push:\n\s+branches:\s*\n\s+- master/)
  expect(text).toMatch(/permissions:\n\s+contents:\s*read/)
  expect(text).not.toMatch(/contents:\s*write|id-token:|attestations:|secrets\./)
  for (const action of [
    "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2",
    "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0",
    "oven-sh/setup-bun@735343b667d3e6f658f44d0eca948eb6282f2b76 # v2.1.2",
    "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2",
    "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4.3.0",
  ]) expect(text).toContain(action)
  for (const target of [
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "aarch64-unknown-linux-musl",
    "x86_64-unknown-linux-musl",
  ]) expect(text).toContain(target)
  for (const command of [
    "cargo fmt --all --manifest-path pane-dash/Cargo.toml -- --check",
    "cargo clippy --workspace --all-targets --all-features --manifest-path pane-dash/Cargo.toml -- -D warnings",
    "bats tests",
    "bun test",
    "npm pack",
    "scripts/release/dry-run.ts",
    "PANE_DASH_NODE20_PREPROVIDED=1 tests/release/with-node20.sh --",
    "scripts/release/clean-room.sh --",
  ]) expect(text).toContain(command)
  for (const name of ["ci-cli", "opencode-compatibility", "installer-faults", "packed-e2e"]) {
    setupNode(job(text, name), "20.0.0")
  }
  expect(text.indexOf("needs: version-check")).toBeLessThan(text.indexOf("needs: rust"))
  expect(text.indexOf("needs: rust")).toBeLessThan(text.indexOf("needs: cli-tests"))
})

test("weekly compatibility is read-only, pinned at the minimum, and resolves latest once", async () => {
  const text = await workflow("opencode-weekly.yml")
  expect(text).toContain("schedule:")
  expect(text).toContain("workflow_dispatch:")
  expect(text).toMatch(/permissions:\n\s+contents:\s*read/)
  expect(text).not.toMatch(/contents:\s*write|npm publish|gh release create|git push|NODE_AUTH_TOKEN/)
  expect(text).toContain("opencode-ai@1.17.20")
  expect(text).toContain("npm view opencode-ai dist-tags.latest")
  expect(text).toContain("OPENCODE_LATEST_VERSION")
  expect(text).toContain("scripts/release/clean-room.sh --")
  setupNode(job(text, "compatibility"), "20.0.0")
})

test("release graph has exact least-privilege jobs, environments, handoff, and toolchains", async () => {
  const text = await workflow("release.yml")
  expect(text).toMatch(/on:\n\s+push:\n\s+tags:\n\s+- ['\"]?v\*['\"]?/)
  expect(text).not.toContain("pull_request:")
  expect(text).toMatch(/permissions:\n\s+contents:\s*read/)
  expect(text).not.toMatch(/NODE_AUTH_TOKEN|NPM_TOKEN|npm publish.*packages\//)
  for (const name of ["validate-tag", "build-test", "build-four-targets", "assemble-verified", "draft-release", "validate-draft", "npm-production", "promote-release"]) job(text, name)
  const draft = job(text, "draft-release")
  expect(draft).toContain("environment: github-draft")
  expect(draft).toContain("contents: write")
  expect(draft).toContain("id-token: write")
  expect(draft).toContain("attestations: write")
  expect(permissions(draft)).toEqual({ contents: "write", "id-token": "write", attestations: "write" })
  const npm = job(text, "npm-production")
  expect(npm).toContain("environment: npm-production")
  expect(npm).toContain("runs-on: ubuntu-24.04")
  expect(npm).toContain("contents: read")
  expect(npm).toContain("id-token: write")
  expect(npm).not.toContain("contents: write")
  expect(permissions(npm)).toEqual({ contents: "read", "id-token": "write" })
  setupNode(npm, "24.12.0")
  expect(npm).toContain('test "$(npm --version)" = "11.6.2"')
  expect(npm).not.toMatch(/npm install --global|npm install.*sigstore|bun build/)
  expect(npm).toContain('export NODE_24_BIN="$(command -v node)"')
  expect(npm).toContain('"$NODE_24_BIN" -e \'if (process.version !== "v24.12.0") process.exit(1)\'')
  const promote = job(text, "promote-release")
  expect(promote).toContain("environment: release-promotion")
  expect(promote).toContain("contents: write")
  expect(promote).toContain("actions: read")
  expect(promote).toContain("deployments: read")
  expect(permissions(promote)).toEqual({ contents: "write", actions: "read", deployments: "read" })
  expect(promote).toContain("needs: npm-production")
  setupNode(promote, "24.12.0")
  for (const name of ["npm-production", "promote-release"]) {
    const body = job(text, name)
    expect(body).toContain("download-artifact")
    expect(body).toContain("verified-handoff")
    expect(body).toContain("j.verifier.size!==x.length")
    expect(body).toContain('j.verifier.sha256!==c.createHash("sha256")')
    expect(body).not.toMatch(/npm install.*sigstore|bun build/)
  }
  expect(text).toContain('npm publish "$RUNNER_TEMP/npm/xiopt-pane-dash-opencode-0.1.0.tgz" --access public --provenance')
  expect(text).toContain("npm publish")
  expect(text).toContain("vars.NPM_TRUSTED_PUBLISHER_BINDING")
  expect(text).toContain("trustedPublishers")
  expect(text).toContain("release-manifest.json")
  expect(text).toContain("SHA256SUMS")
  console.log("promotion-permissions=contents:write,actions:read,deployments:read npm-permissions=unchanged")
})

test("release validation derives identity from the checked-in version and protected tag graph", async () => {
  const text = await workflow("release.yml")
  const validation = job(text, "validate-tag")
  expect(validation).toContain('version="$(tr -d')
  expect(validation).toContain('expected_tag="v$version"')
  expect(validation).toContain('git rev-parse "$GITHUB_SHA^{commit}"')
  expect(validation).toContain('git rev-parse "refs/tags/$GITHUB_REF_NAME^{commit}"')
  expect(validation).toContain('refs/remotes/origin/master')
  expect(validation).toContain('git merge-base --is-ancestor "$github_commit"')
  expect(validation).not.toContain("ci(release): add gated v0.1 delivery pipeline")
  expect(validation).not.toMatch(/git show -s --format=%s/)
  expect(validation).not.toMatch(/test "\$GITHUB_REF_NAME" = "v0\.1\.0"/)
})

test("tag validation compares resolved tag and GitHub commits without requiring the current master tip", async () => {
  const text = await workflow("release.yml")
  const validation = job(text, "validate-tag")
  expect(validation).toContain('github_commit="$(git rev-parse "$GITHUB_SHA^{commit}")"')
  expect(validation).toContain('tag_commit="$(git rev-parse "refs/tags/$GITHUB_REF_NAME^{commit}")"')
  expect(validation).toContain('test "$tag_commit" = "$github_commit"')
  expect(validation).toContain('git merge-base --is-ancestor "$github_commit" refs/remotes/origin/master')
  expect(validation).not.toContain("master_sha")
  expect(validation).not.toContain('test "$sha" = "$GITHUB_SHA"')
  expect(validation).not.toMatch(/test .*refs\/remotes\/origin\/master\^\{commit\}.*=/)
  expect(validation).toContain('origin_url="$(git remote get-url origin)"')
  expect(validation).toContain('https://github.com/xiopt/tmux-pane-dash')
})

test("release target executions use matching hosted runners and never local fixtures", async () => {
  const text = await workflow("release.yml")
  const targets = job(text, "build-four-targets")
  expect(runnerForTarget(targets, "darwin-arm64")).toBe("macos-14")
  expect(runnerForTarget(targets, "darwin-x64")).toBe("macos-15-intel")
  expect(targets).toContain("runner: ubuntu-24.04-arm")
  expect(targets).toContain("runner: ubuntu-24.04")
  expect(targets).toContain("runs-on: ${{ matrix.runner }}")
  expect(targets).toContain("cargo build --release --locked")
  expect(targets).toContain("cargo test --workspace --locked")
  expect(targets).toContain("--target \"${RUST_TARGET}\"")
  expect(targets).toContain("--target \"${TARGET_KEY}\"")
  expect(targets).toContain("actions/upload-artifact")
  expect(targets).toContain("${{ matrix.asset }}")
  expect(targets).not.toContain("--local-fixtures")
  expect(targets).not.toMatch(/build-four-targets:\n[\s\S]*?runs-on: ubuntu-24\.04\n/)
})

test("downstream jobs verify the immutable handoff before use or mutation", async () => {
  const text = await workflow("release.yml")
  const mutationMarkers = ["gh release create", "gh release upload", "attest-build-provenance", "npm publish", "gh release edit"]
  for (const name of ["draft-release", "validate-draft", "npm-production", "promote-release"]) {
    const body = job(text, name)
    const check = body.indexOf("j.verifier.size!==x.length")
    expect(check, `${name} handoff check`).toBeGreaterThanOrEqual(0)
    expect(body).toContain('j.verifier.sha256!==c.createHash("sha256")')
    for (const marker of mutationMarkers) {
      const index = body.indexOf(marker)
      if (index >= 0) expect(check, `${name} before ${marker}`).toBeLessThan(index)
    }
  }
})

test("draft mutation is non-clobbering and draft validation binds all six assets", async () => {
  const text = await workflow("release.yml")
  const draft = job(text, "draft-release")
  const validation = job(text, "validate-draft")
  expect(draft).not.toContain("--clobber")
  expect(draft).toContain("gh release view")
  expect(validation).toContain("releaseAssets")
  expect(validation).toContain("attestation-subjects=6")
  expect(validation).toContain("verify-artifacts.ts")
  expect(validation).toContain("architecture")
  expect(validation).toContain("version")
})

test("npm production audits signatures without fallback bindings and verifies publication order", async () => {
  const text = await workflow("release.yml")
  const npm = job(text, "npm-production")
  expect(npm).toContain("npm audit signatures")
  expect(npm).toContain('NPM_TRUSTED_PUBLISHER_BINDING:?')
  expect(npm).not.toMatch(/NPM_TRUSTED_PUBLISHER_BINDING:-/)
  const plugin = npm.indexOf("xiopt-pane-dash-opencode-0.1.0.tgz")
  const cli = npm.indexOf("xiopt-tmux-pane-dash-0.1.0.tgz")
  expect(plugin).toBeGreaterThanOrEqual(0)
  expect(cli).toBeGreaterThan(plugin)
  expect(npm.indexOf("--package @xiopt/pane-dash-opencode")).toBeLessThan(npm.indexOf("--package @xiopt/tmux-pane-dash"))
})

test("npm production audits only the exact published versions in an isolated no-auth project", async () => {
  const text = await workflow("release.yml")
  const npm = job(text, "npm-production")
  const install = 'npm_config_userconfig="$audit_dir/.npmrc" npm_config_cache="$RUNNER_TEMP/npm-audit-cache" npm install --prefix "$audit_dir" --ignore-scripts --no-audit --no-fund --package-lock=false @xiopt/pane-dash-opencode@0.1.0 @xiopt/tmux-pane-dash@0.1.0'
  const signatures = 'npm_config_userconfig="$audit_dir/.npmrc" npm_config_cache="$RUNNER_TEMP/npm-audit-cache" npm audit signatures --prefix "$audit_dir"'
  expect(npm).toContain('audit_dir="$RUNNER_TEMP/npm-audit"')
  expect(npm).toContain('registry=https://registry.npmjs.org/')
  expect(npm).toContain(install)
  expect(npm).toContain(signatures)
  expect(npm).not.toContain("--package-lock=true")
  expect(npm).not.toContain('"dependencies"')
  expect(npm).not.toContain("# npm publish <tarball>")
  const pluginPublish = npm.indexOf('npm publish "$RUNNER_TEMP/npm/xiopt-pane-dash-opencode-0.1.0.tgz"')
  const cliPublish = npm.indexOf('npm publish "$RUNNER_TEMP/npm/xiopt-tmux-pane-dash-0.1.0.tgz"')
  const installIndex = npm.indexOf(install)
  const auditIndex = npm.indexOf(signatures)
  const provenanceIndex = npm.indexOf('"$NODE_24_BIN" "$VERIFIER_BUNDLE" --package @xiopt/pane-dash-opencode')
  expect(pluginPublish).toBeGreaterThanOrEqual(0)
  expect(cliPublish).toBeGreaterThan(pluginPublish)
  expect(installIndex).toBeGreaterThan(cliPublish)
  expect(auditIndex).toBeGreaterThan(installIndex)
  expect(provenanceIndex).toBeGreaterThan(auditIndex)
  expect(npm).not.toContain("npm install --global")
})

test("draft validation verifies each exact release asset with the tagged workflow identity", async () => {
  const text = await workflow("release.yml")
  const validation = job(text, "validate-draft")
  for (const asset of [
    "tmux-pane-dash-v0.1.0-aarch64-apple-darwin.tar.gz",
    "tmux-pane-dash-v0.1.0-x86_64-apple-darwin.tar.gz",
    "tmux-pane-dash-v0.1.0-aarch64-unknown-linux-musl.tar.gz",
    "tmux-pane-dash-v0.1.0-x86_64-unknown-linux-musl.tar.gz",
    "release-manifest.json",
    "SHA256SUMS",
  ]) expect(validation).toContain(`$RUNNER_TEMP/draft/${asset}`)
  expect(validation).toContain("attestation_assets=(")
  expect(validation).toContain("--repo \"$GITHUB_REPOSITORY\"")
  expect(validation).toContain("--signer-workflow xiopt/tmux-pane-dash/.github/workflows/release.yml")
  expect(validation).toContain("--source-ref refs/tags/v0.1.0")
  expect(validation).toContain("--source-digest \"$GITHUB_SHA\"")
  expect(validation).toContain("--signer-digest \"$GITHUB_SHA\"")
  expect(validation).not.toContain('"$RUNNER_TEMP/draft"/*.tar.gz')
  expect(validation).not.toContain('gh attestation verify "$asset" --repo "$GITHUB_REPOSITORY"; done')
})

test("promotion consumes live protected-environment proof before draft=false", async () => {
  const text = await workflow("release.yml")
  const promote = job(text, "promote-release")
  for (const value of ["/environments/release-promotion", "deployments?sha=$GITHUB_SHA", "/statuses?per_page=100", "actions/runs/$GITHUB_RUN_ID/jobs", "required_reviewers", 'state !== "in_progress"']) expect(promote).toContain(value)
  const proof = promote.indexOf("Prove the active approved release-promotion deployment")
  const edit = promote.indexOf("gh release edit")
  expect(proof).toBeGreaterThanOrEqual(0)
  expect(edit).toBeGreaterThan(proof)
  expect(promote).not.toContain("approval-evidence")
  expect(promote).not.toContain("--verify-environment")
  expect(promote).not.toContain("conclusion !== \"success\"")
})

test("both publishable package manifests retain the exact public repository URL", async () => {
  for (const path of ["packages/tmux-pane-dash/package.json", "opencode-plugin/package.json"]) {
    const pkg = JSON.parse(await readFile(join(root, path), "utf8"))
    expect(pkg.repository).toEqual({ type: "git", url: "git+https://github.com/xiopt/tmux-pane-dash.git" })
  }
})

test("workflow graph proves authentication, artifact producers, isolated tmux, and packed E2E edges", async () => {
  for (const name of ["ci.yml", "opencode-weekly.yml", "release.yml"]) assertWorkflowGraph(await workflow(name), name)
})

test("workflow graph rejects a GH command without authenticated job scope", async () => {
  const text = await workflow("release.yml")
  const broken = text.replace("      GH_TOKEN: ${{ github.token }}\n", "")
  expect(() => assertWorkflowGraph(broken, "release.yml")).toThrow(/GH_TOKEN-authenticated/)
})

test("workflow graph rejects an artifact consumer without a reachable producer", async () => {
  const text = await workflow("release.yml")
  const broken = text.replace(/      - uses: actions\/upload-artifact@[^\n]+\n        with:\n          name: verified-handoff\n[\s\S]*?          if-no-files-found: error\n/, "")
  expect(broken).not.toContain("name: verified-handoff\n          path: ${{ runner.temp }}/verified-handoff/*")
  expect(() => assertWorkflowGraph(broken, "release.yml")).toThrow(/without a producer|producer/)
})

test("workflow graph rejects clean-room work without a prior tmux and Bun export", async () => {
  const text = await workflow("ci.yml")
  const provisionStart = text.indexOf("      - name: Provision CI tmux and Bun paths\n")
  const nextStep = text.indexOf("      - run:", provisionStart)
  const broken = text.slice(0, provisionStart) + text.slice(nextStep)
  expect(() => assertWorkflowGraph(broken, "ci.yml")).toThrow(/TMUX_BIN and BUN_BOOTSTRAP/)
})

test("workflow graph rejects a bare packed E2E command", async () => {
  const text = await workflow("release.yml")
  const broken = text.replace("          tests/release/with-rust.sh -- env \\\n", "          bun test \\\n")
  expect(() => assertWorkflowGraph(broken, "release.yml")).toThrow(/bare packed E2E/)
})
