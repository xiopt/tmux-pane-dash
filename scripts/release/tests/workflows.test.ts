import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

const root = process.cwd()
const workflow = (name: string) => readFile(join(root, ".github", "workflows", name), "utf8")
const trustedPublisherExpected = '{"packages":{"@xiopt/pane-dash-opencode":{"allowedAction":"npm publish","environment":"npm-production","repository":"xiopt/tmux-pane-dash","workflow":"release.yml"},"@xiopt/tmux-pane-dash":{"allowedAction":"npm publish","environment":"npm-production","repository":"xiopt/tmux-pane-dash","workflow":"release.yml"}},"schemaVersion":1}'
const trustedPublisherExpectedEnvLine = `  NPM_TRUSTED_PUBLISHER_EXPECTED: '${trustedPublisherExpected}'`
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

function assertPackageAssemblyOrder(body: string): void {
  const markers = [
    "bun scripts/release/build.ts --assemble",
    "bun scripts/release/package-build.ts --release-manifest \"$release_dir/release-manifest.json\" --require-change",
    "tests/release/with-node20.sh -- bun scripts/release/verify-artifacts.ts --packages --release-manifest \"$release_dir/release-manifest.json\"",
    "npm pack --workspace packages/tmux-pane-dash --workspace opencode-plugin --pack-destination \"$npm_dir\"",
  ]
  let previous = body.indexOf("bun install --frozen-lockfile")
  if (previous < 0) throw new Error("assemble-verified must install locked dependencies")
  for (const marker of markers) {
    const position = body.indexOf(marker)
    if (position < 0 || position <= previous) throw new Error(`assemble-verified package step is missing or out of order: ${marker}`)
    previous = position
  }
  const upload = body.indexOf("name: npm-packages", previous)
  if (upload < 0 || upload <= previous) throw new Error("npm package upload is missing or out of order")
  if (body.includes("with-npa.sh")) throw new Error("package verification does not require the NPA wrapper")
  if (/git (?:status|diff|clean)|source[_-](?:package|manifest)|buildSourceArchive/.test(body.slice(previous))) throw new Error("package handoff must not depend on later tree or source-archive checks")
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

function trustedPublisherBindingMatches(actual: string | undefined, expected: string | undefined): boolean {
  return typeof actual === "string" && typeof expected === "string" && actual.length > 0 && actual === expected
}

function assertTrustedPublisherContract(text: string): void {
  const parsed = parseWorkflow(text)
  const expectedKeys = Object.keys(JSON.parse(trustedPublisherExpected) as Record<string, unknown>)
  if (JSON.stringify(expectedKeys) !== JSON.stringify(["packages", "schemaVersion"])) throw new Error("trusted publisher expected JSON is not canonically ordered")
  const expectedPackages = (JSON.parse(trustedPublisherExpected) as { packages: Record<string, Record<string, string>> }).packages
  if (JSON.stringify(Object.keys(expectedPackages)) !== JSON.stringify(["@xiopt/pane-dash-opencode", "@xiopt/tmux-pane-dash"])) throw new Error("trusted publisher packages are not canonically ordered")
  for (const packageName of Object.keys(expectedPackages)) {
    if (JSON.stringify(Object.keys(expectedPackages[packageName]!)) !== JSON.stringify(["allowedAction", "environment", "repository", "workflow"])) throw new Error("trusted publisher coordinates are not canonically ordered")
  }

  if ((text.match(/^  NPM_TRUSTED_PUBLISHER_EXPECTED:.*$/gm) ?? []).length !== 1 || text.split("\n").filter((line) => line === trustedPublisherExpectedEnvLine).length !== 1) {
    throw new Error("trusted publisher expected binding must be defined once on one workflow-level env line")
  }
  if (!text.includes(`env:\n${trustedPublisherExpectedEnvLine}\n`) || text.indexOf("env:\n") > text.indexOf("jobs:\n")) throw new Error("trusted publisher expected binding must be workflow-level env")

  const requiredLine = 'test -n "${NPM_TRUSTED_PUBLISHER_BINDING:?NPM_TRUSTED_PUBLISHER_BINDING is required}"'
  const compareLine = 'test "$NPM_TRUSTED_PUBLISHER_BINDING" = "$NPM_TRUSTED_PUBLISHER_EXPECTED"'
  const bareComparison = 'test "$NPM_TRUSTED_PUBLISHER_BINDING" = "npm publish"'
  for (const name of ["assemble-verified", "npm-production"]) {
    const parsedJob = parsed.jobs[name]
    if (!parsedJob || parsedJob.env.NPM_TRUSTED_PUBLISHER_BINDING !== "${{ vars.NPM_TRUSTED_PUBLISHER_BINDING }}") throw new Error(`${name} must source the trusted publisher binding variable`)
    const checks = parsedJob.steps.filter((step) => (step.run ?? "").includes(compareLine))
    if (checks.length !== 1) throw new Error(`${name} must compare the trusted publisher binding exactly once`)
    const run = checks[0]!.run ?? ""
    if (!run.includes(requiredLine)) throw new Error(`${name} must fail closed when the trusted publisher binding is missing`)
    if (run.includes("NPM_TRUSTED_PUBLISHER_BINDING:-") || run.includes(bareComparison)) throw new Error(`${name} must not use a trusted publisher fallback or bare action comparison`)
  }
}

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

const wrappedBatsCommand = "tests/release/with-rust.sh -- scripts/release/clean-room.sh -- bats tests"
const releaseRustToolchainInstall = "rustup toolchain install 1.96.1 --profile minimal --component rustfmt --no-self-update"

const isBatsProvision = (step: ParsedStep): boolean => {
  const run = step.run ?? ""
  const update = run.indexOf("sudo apt-get update")
  const install = run.indexOf("sudo apt-get install -y bats")
  return update >= 0 && install > update &&
    run.includes('test "$(command -v bats)" = "/usr/bin/bats"') &&
    run.includes("bats_version=$(/usr/bin/bats --version)") &&
    run.includes('test -n "$bats_version"') &&
    run.includes('[[ "$bats_version" =~ ^Bats[[:space:]]+([1-9][0-9]*)\\. ]]')
}

function assertBatsProvisioning(workflow: ParsedWorkflow, jobName = "rust", requiredRustInstall?: string): void {
  const rust = workflow.jobs[jobName]
  if (!rust) throw new Error(`${jobName} job is missing`)
  const provision = rust.steps.findIndex(isBatsProvision)
  const bats = rust.steps.findIndex((step) => stepCommands(step).some((line) => line.trim() === wrappedBatsCommand))
  if (bats < 0) throw new Error(`${jobName} job must run Bats through with-rust and clean-room`)
  if (provision < 0) throw new Error(`${jobName} job must provision distro Bats at /usr/bin`)
  if (provision >= bats) throw new Error(`${jobName} job must provision Bats before the wrapped Bats command`)
  if (!hasToolProvision(rust, bats)) throw new Error(`${jobName} Bats must retain the prior TMUX_BIN and BUN_BOOTSTRAP provisioning`)
  if (requiredRustInstall && (rust.steps.findIndex((step) => stepCommands(step).some((line) => line.trim() === requiredRustInstall)) < 0 || rust.steps.findIndex((step) => stepCommands(step).some((line) => line.trim() === requiredRustInstall)) >= bats)) {
    throw new Error(`${jobName} Bats must follow its pinned Rust prerequisite`)
  }
}

const rustToolchainInstall = "rustup toolchain install 1.96.1 --profile minimal --component clippy --component rustfmt --no-self-update"
const rustLiveCommand = "tests/release/with-rust.sh -- scripts/release/clean-room.sh -- tests/rust_live_integration.sh"
const cargoTestPrefix = "cargo test --workspace --locked --manifest-path pane-dash/Cargo.toml"
const rustGateCommands = [
  "cargo fmt --all --manifest-path pane-dash/Cargo.toml -- --check",
  "cargo clippy --workspace --all-targets --all-features --manifest-path pane-dash/Cargo.toml -- -D warnings",
  `${cargoTestPrefix} -- --test-threads=1`,
  `${cargoTestPrefix} -- --ignored --test-threads=1`,
] as const
const rustBuildCommands = [
  "make build",
  "test -x bin/pane-dash",
  'test "$(bin/pane-dash --version)" = "pane-dash 0.1.2"',
] as const

function assertRustLiveBinaryBuild(workflow: ParsedWorkflow): void {
  const rust = workflow.jobs["rust"]
  if (!rust) throw new Error("rust job is missing")
  const gateIndex = rust.steps.findIndex((step) => {
    const commands = stepCommands(step).map((line) => line.trim())
    return commands.includes(rustToolchainInstall) &&
      commands.includes("export RUSTUP_TOOLCHAIN=1.96.1") &&
      rustGateCommands.every((command) => commands.includes(command))
  })
  if (gateIndex < 0) throw new Error("rust job must run its pinned Rust gates in one step")

  const liveIndex = rust.steps.findIndex((step) => stepCommands(step).some((line) => line.trim() === rustLiveCommand))
  if (liveIndex < 0) throw new Error("rust job must run rust_live_integration through with-rust and clean-room")

  const gateCommands = stepCommands(rust.steps[gateIndex]!).map((line) => line.trim())
  if (rust.steps.some((step) => stepCommands(step).some((line) => /^cargo build(?:\s|$)/.test(line.trim())))) {
    throw new Error("rust job must use make build instead of bare cargo build")
  }
  const gateEnd = Math.max(...rustGateCommands.map((command) => gateCommands.indexOf(command)))
  const buildPositions = rustBuildCommands.map((command) => gateCommands.indexOf(command))
  if (buildPositions.some((position) => position < 0)) throw new Error("rust job must run make build and assert the built pane-dash binary")
  if (buildPositions[0]! <= gateEnd) throw new Error("rust job must run make build after the Rust gates")
  if (!(buildPositions[0]! < buildPositions[1]! && buildPositions[1]! < buildPositions[2]!)) {
    throw new Error("rust job must assert pane-dash after make build")
  }
  const buildLocations = rust.steps.flatMap((step, index) =>
    stepCommands(step).filter((line) => line.trim() === rustBuildCommands[0]).map(() => index),
  )
  if (buildLocations.length !== 1) throw new Error("rust job must run exactly one make build")
  const buildIndex = buildLocations[0]!
  if (buildIndex !== gateIndex) throw new Error("rust job must run make build in the pinned Rust gate step")
  if (liveIndex <= buildIndex) throw new Error("rust job must build pane-dash before rust_live_integration")
}

function assertArchiveDryRunDependencies(workflow: ParsedWorkflow): void {
  const job = workflow.jobs["archive-dry-run"]
  if (!job) throw new Error("archive-dry-run is missing")
  const install = job.steps.findIndex((step) => step.run === "bun install --frozen-lockfile")
  const dryRun = job.steps.findIndex((step) => (step.run ?? "").includes("scripts/release/clean-room.sh -- bun scripts/release/dry-run.ts"))
  if (install < 0) throw new Error("archive-dry-run must install locked dependencies")
  if (dryRun < 0) throw new Error("archive-dry-run dry-run command is missing")
  if (install + 1 !== dryRun) throw new Error("archive-dry-run must install locked dependencies immediately before dry-run")
}

function assertPackedE2EGraph(workflow: ParsedWorkflow): void {
  for (const job of Object.values(workflow.jobs)) for (const step of job.steps) {
    const run = step.run ?? ""
    if (!run.includes("packages/tmux-pane-dash/tests/packed-e2e.test.ts")) continue
    for (const wrapper of ["tests/release/with-node20.sh --", "tests/release/with-rust.sh --", "scripts/release/clean-room.sh --"]) if (!run.includes(wrapper)) throw new Error(`${job.name} has a bare packed E2E invocation`)
    if (!run.includes("TARGET_KEY=linux-x64")) throw new Error(`${job.name} packed E2E must select linux-x64`)
  }
}

function assertPackedE2EToolchain(workflow: ParsedWorkflow, jobName = "packed-e2e"): void {
  const job = workflow.jobs[jobName]
  if (!job) throw new Error(`${jobName} is missing`)
  const target = "x86_64-unknown-linux-musl"
  const provisionIndex = job.steps.findIndex((step) => {
    const run = step.run ?? ""
    return run.includes("sudo apt-get update") &&
      run.includes("sudo apt-get install -y musl-tools") &&
      run.includes('export RUSTUP_BOOTSTRAP="$(command -v rustup)"') &&
      run.includes(`tests/release/with-rust.sh -- "$RUSTUP_BOOTSTRAP" target add ${target} --toolchain 1.96.1`) &&
      run.includes("tests/release/with-rust.sh -- bash -ceu") &&
      run.includes('test "$RUSTUP_HOME" = "$PANE_DASH_ISOLATED_RUST_ROOT/rustup"') &&
      run.includes('test "$CARGO_HOME" = "$PANE_DASH_ISOLATED_RUST_ROOT/cargo"') &&
      run.includes('[[ "$CARGO" == "$PANE_DASH_ISOLATED_RUST_ROOT"/rustup/toolchains/1.96.1-*/bin/cargo ]]')
  })
  if (provisionIndex < 0) throw new Error(`${jobName} must provision musl-tools and its isolated Rust target`)
  const provisionRun = job.steps[provisionIndex]!.run ?? ""
  const provisionMarkers = [
    "sudo apt-get update",
    "sudo apt-get install -y musl-tools",
    'export RUSTUP_BOOTSTRAP="$(command -v rustup)"',
    `"$RUSTUP_BOOTSTRAP" target add ${target} --toolchain 1.96.1`,
    "tests/release/with-rust.sh -- bash -ceu",
    'test "$RUSTUP_HOME" = "$PANE_DASH_ISOLATED_RUST_ROOT/rustup"',
    'test "$CARGO_HOME" = "$PANE_DASH_ISOLATED_RUST_ROOT/cargo"',
    '[[ "$CARGO" == "$PANE_DASH_ISOLATED_RUST_ROOT"/rustup/toolchains/1.96.1-*/bin/cargo ]]',
  ]
  let previous = -1
  for (const marker of provisionMarkers) {
    const position = provisionRun.indexOf(marker, previous + 1)
    if (position <= previous) throw new Error("packed-e2e musl provisioning must identify and use the isolated Rust toolchain in order")
    previous = position
  }
  const packedIndex = job.steps.findIndex((step) => (step.run ?? "").includes("packages/tmux-pane-dash/tests/packed-e2e.test.ts"))
  if (packedIndex < 0) throw new Error(`${jobName} fixture command is missing`)
  if (provisionIndex >= packedIndex) throw new Error(`${jobName} must provision its isolated musl target before the fixture`)
}

function assertPackedE2ETmuxBinding(workflow: ParsedWorkflow, jobName = "packed-e2e"): void {
  const packed = workflow.jobs[jobName]
  if (!packed) throw new Error(`${jobName} is missing`)
  const binding = (step: ParsedStep): boolean => {
    const run = step.run ?? ""
    return run.includes('test -x "${TMUX_BIN:?TMUX_BIN is required}"') &&
      run.includes('test "$("$TMUX_BIN" -V)" = "tmux 3.6a"') &&
      run.includes('tmux_real="$(realpath -- "$TMUX_BIN")"') &&
      run.includes('test "$("$tmux_real" -V)" = "tmux 3.6a"') &&
      run.includes('sudo ln -sfn -- "$TMUX_BIN" /usr/local/bin/tmux') &&
      run.includes("test -L /usr/local/bin/tmux") &&
      run.includes('test "$(realpath -- /usr/local/bin/tmux)" = "$tmux_real"') &&
      run.includes('test "$(/usr/local/bin/tmux -V)" = "tmux 3.6a"')
  }
  const bindingIndex = packed.steps.findIndex(binding)
  if (bindingIndex < 0) throw new Error(`${jobName} must bind its verified tmux binary into /usr/local/bin`)
  if (workflow.jobs && Object.values(workflow.jobs).some(job => job.name !== jobName && job.steps.some(binding))) {
    throw new Error(`the fixed tmux binding must be limited to ${jobName}`)
  }
  const packedIndex = packed.steps.findIndex((step) => (step.run ?? "").includes("packages/tmux-pane-dash/tests/packed-e2e.test.ts"))
  if (packedIndex < 0) throw new Error(`${jobName} fixture command is missing`)
  if (bindingIndex >= packedIndex) throw new Error(`${jobName} must bind tmux before the fixture`)
}

function assertPackedE2EPrerequisiteOrder(workflow: ParsedWorkflow, jobName = "packed-e2e"): void {
  const packed = workflow.jobs[jobName]
  if (!packed) throw new Error(`${jobName} is missing`)
  const bindingIndex = packed.steps.findIndex((step) => (step.run ?? "").includes('sudo ln -sfn -- "$TMUX_BIN" /usr/local/bin/tmux'))
  const muslIndex = packed.steps.findIndex((step) => (step.run ?? "").includes('tests/release/with-rust.sh -- "$RUSTUP_BOOTSTRAP" target add x86_64-unknown-linux-musl --toolchain 1.96.1'))
  const packedIndex = packed.steps.findIndex((step) => (step.run ?? "").includes("packages/tmux-pane-dash/tests/packed-e2e.test.ts"))
  if (bindingIndex < 0 || muslIndex < 0 || packedIndex < 0) throw new Error(`${jobName} packed E2E prerequisites are incomplete`)
  if (!(bindingIndex < muslIndex && muslIndex < packedIndex)) throw new Error(`${jobName} must order tmux binding, musl provisioning, and packed E2E in sequence`)
}

function assertOpenCodeProvisioning(workflow: ParsedWorkflow): void {
  const job = workflow.jobs["opencode-compatibility"]
  if (!job) throw new Error("opencode-compatibility is missing")
  const step = job.steps.find((candidate) => {
    const run = candidate.run ?? ""
    return run.includes("opencode-ai@1.17.20") && run.includes("opencode-ai@$OPENCODE_LATEST_VERSION")
  })
  if (!step) throw new Error("opencode compatibility installs are missing")
  const run = step.run ?? ""
  const markers = [
    '"$NPM_20_CLI" install --prefix "$RUNNER_TEMP/opencode-min" --ignore-scripts',
    'run_opencode_postinstall "$RUNNER_TEMP/opencode-min"',
    '"$NPM_20_CLI" install --prefix "$RUNNER_TEMP/opencode-latest" --ignore-scripts',
    'run_opencode_postinstall "$RUNNER_TEMP/opencode-latest"',
    '"$NPM_20_CLI" view opencode-ai@1.17.20 version dist.integrity --json',
    '"$NPM_20_CLI" view "opencode-ai@$OPENCODE_LATEST_VERSION" version dist.integrity --json',
    '"$OPENCODE_1_17_20_BIN" --version',
    '"$OPENCODE_LATEST_BIN" --version',
  ]
  let previous = -1
  for (const marker of markers) {
    const position = run.indexOf(marker, previous + 1)
    if (position <= previous) throw new Error("OpenCode installs, targeted postinstalls, integrity checks, and version checks are out of order")
    previous = position
  }
  if (!run.includes('local postinstall="$prefix/node_modules/opencode-ai/postinstall.mjs"')) throw new Error("OpenCode postinstall must target opencode-ai only")
  if (!run.includes('tests/release/with-node20.sh -- scripts/release/clean-room.sh -- "$NODE_20_BIN" "$postinstall"')) throw new Error("OpenCode postinstall must run through exact Node20 and clean-room")
  if (run.includes("npm rebuild") || run.includes("npm run") || run.includes("npm exec")) throw new Error("OpenCode compatibility must not run broad npm scripts")
}

function assertOpenCodeMacOsSandbox(workflowText: string, harnessText: string): void {
  const body = job(workflowText, "opencode-compatibility")
  if (!/^    runs-on: macos-14$/m.test(body)) throw new Error("opencode-compatibility must run on macos-14 for the Seatbelt harness")
  const markers = [
    "/usr/bin/sandbox-exec -p",
    "(version 1) (allow default) (deny network*)",
    '(allow network-outbound (remote ip "localhost:*"))',
    "(allow network-outbound (remote unix-socket))",
  ]
  let previous = -1
  for (const marker of markers) {
    const position = harnessText.indexOf(marker, previous + 1)
    if (position <= previous) throw new Error("real OpenCode harness must retain the sandbox-exec network denial with loopback-only access")
    previous = position
  }
}

function assertCiCliNpaIsolation(workflow: ParsedWorkflow): void {
  const ciCli = workflow.jobs["ci-cli"]
  if (!ciCli) throw new Error("ci-cli is missing")
  const checkout = ciCli.steps.find((step) => step.uses?.startsWith("actions/checkout@"))
  if (checkout?.with["fetch-depth"] !== "0") throw new Error("ci-cli must fetch full history for the release fixture anchor")
  const command = "bun test scripts/release/tests release/tests"
  const steps = ciCli.steps.filter((step) => (step.run ?? "").includes(command))
  if (steps.length !== 1) throw new Error("ci-cli must run the release test suites exactly once")
  const run = steps[0]!.run ?? ""
  let previous = -1
  for (const marker of [
    "tests/release/with-npa.sh --",
    'NODE_20_BIN="$NODE_20_BIN"',
    'NPM_20_CLI="$NPM_20_CLI"',
    "tests/release/with-node20.sh --",
    "scripts/release/clean-room.sh --",
    command,
  ]) {
    const position = run.indexOf(marker, previous + 1)
    if (position <= previous) throw new Error("ci-cli release tests must use with-npa before Node20 and clean-room")
    previous = position
  }
}

const ciCliMuslTarget = "x86_64-unknown-linux-musl"
const ciCliMuslToolchainInstall = "rustup toolchain install 1.96.1 --profile minimal --no-self-update"
const ciCliMuslCargoBuild = `cargo build --release --locked --manifest-path pane-dash/Cargo.toml --target ${ciCliMuslTarget}`
const ciCliMuslBuildCommands = [
  "set -euo pipefail",
  ciCliMuslToolchainInstall,
  "export RUSTUP_TOOLCHAIN=1.96.1",
  `rustup target add ${ciCliMuslTarget}`,
  "sudo apt-get update",
  "sudo apt-get install -y musl-tools",
  ciCliMuslCargoBuild,
  "mkdir -p bin",
  `install -m0755 pane-dash/target/${ciCliMuslTarget}/release/pane-dash bin/pane-dash`,
  "test -x bin/pane-dash",
  'test "$(bin/pane-dash --version)" = "pane-dash 0.1.2"',
] as const

function assertCiCliMuslFixture(workflow: ParsedWorkflow): void {
  const ciCli = workflow.jobs["ci-cli"]
  if (!ciCli) throw new Error("ci-cli is missing")
  const provisionIndex = ciCli.steps.findIndex((step) => {
    const run = step.run ?? ""
    return run.includes("scripts/release/ci-tmux.sh") && run.includes("export TMUX_BIN") && run.includes("BUN_BOOTSTRAP=") && run.includes("GITHUB_ENV")
  })
  if (provisionIndex < 0) throw new Error("ci-cli must provision tmux and Bun before the musl fixture")
  const fixtureIndex = ciCli.steps.findIndex((step) => stepCommands(step).some((line) => line.trim() === ciCliMuslToolchainInstall))
  if (fixtureIndex < 0) throw new Error("ci-cli musl fixture build is missing")
  if (fixtureIndex <= provisionIndex) throw new Error("ci-cli musl fixture must follow tmux and Bun provisioning")

  const nodeWrapperIndex = ciCli.steps.findIndex((step) => (step.run ?? "").includes("tests/release/with-node20.sh --"))
  if (nodeWrapperIndex < 0 || fixtureIndex >= nodeWrapperIndex) throw new Error("ci-cli musl fixture must run before Node20 wrapper tests")
  const releaseTestsIndex = ciCli.steps.findIndex((step) => (step.run ?? "").includes("scripts/release/tests"))
  if (releaseTestsIndex < 0 || fixtureIndex >= releaseTestsIndex) throw new Error("ci-cli musl fixture must run before scripts/release tests")

  const commands = stepCommands(ciCli.steps[fixtureIndex]!).map((line) => line.trim())
  if (commands.some((command) => /^make(?:\s|$)/.test(command))) throw new Error("ci-cli musl fixture must not use plain make")
  if (commands.some((command) => /^cargo build(?:\s|$)/.test(command) && command !== ciCliMuslCargoBuild)) {
    throw new Error("ci-cli musl fixture must not use the default GNU cargo target")
  }
  const positions = ciCliMuslBuildCommands.map((command) => commands.indexOf(command))
  if (positions.some((position) => position < 0)) throw new Error("ci-cli must run the exact pinned musl fixture commands")
  if (!positions.every((position, index) => index === 0 || position > positions[index - 1]!)) {
    throw new Error("ci-cli musl fixture commands are out of order")
  }
  const aptUpdatePosition = positions[4]!
  const aptInstallPosition = positions[5]!
  if (aptInstallPosition !== aptUpdatePosition + 1) throw new Error("ci-cli must update apt immediately before installing musl-tools")
}

function assertSerialCargoTestCommands(body: string, expected: string[], label: string): void {
  const commands = body.split("\n").map((line) => line.trim()).filter((line) => line.startsWith(cargoTestPrefix))
  if (JSON.stringify(commands) !== JSON.stringify(expected)) throw new Error(`${label} must use exact serial commands`)
}

function assertRustTestSerialization(body: string): void {
  const expected = [
    `${cargoTestPrefix} -- --test-threads=1`,
    `${cargoTestPrefix} -- --ignored --test-threads=1`,
  ]
  assertSerialCargoTestCommands(body, expected, "rust process-spawning tests")
}

function assertFourTargetTestSerialization(body: string): void {
  const target = `${cargoTestPrefix} --target "\${{ matrix.rust_target }}"`
  assertSerialCargoTestCommands(body, [`${target} -- --test-threads=1`], "four-target process-spawning tests")
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
  const canonicalGuard = 'test "$GITHUB_REF" = "refs/tags/$GITHUB_REF_NAME"'
  const canonicalGuardIndex = proofRun.indexOf(canonicalGuard)
  const deploymentQueryIndex = proofRun.indexOf("deployments?sha=$GITHUB_SHA")
  if (canonicalGuardIndex < 0 || canonicalGuardIndex > deploymentQueryIndex) throw new Error("promotion proof must retain the canonical tag guard before its deployment query")
  if (!proofRun.includes("ref=$GITHUB_REF_NAME")) throw new Error("promotion deployment query must use the short tag ref")
  if (proofRun.includes("ref=$GITHUB_REF&")) throw new Error("promotion deployment query must not use the canonical Git ref")
  if (!proofRun.includes("deployment.ref !== process.env.GITHUB_REF_NAME")) throw new Error("promotion proof must compare the live deployment to the short tag ref")
  if (proofRun.includes("deployment.ref !== process.env.GITHUB_REF ||") || proofRun.includes("/^refs\\/tags\\//.test(deployment.ref)")) throw new Error("promotion proof must not normalize or regex-match deployment refs")
  if (proofRun.includes("conclusion !== \"success\"") || proofRun.includes("approval-response")) throw new Error("promotion uses synthetic completed-job or approval artifact proof")
}

function assertWorkflowGraph(text: string, workflowName: string): void {
  const workflow = parseWorkflow(text)
  assertGhAuthentication(workflow, text)
  assertArtifactGraph(workflow)
  assertTmuxProvisioning(workflow, workflowName)
  assertPackedE2EGraph(workflow)
  if (workflowName === "ci.yml") {
    assertCiCliNpaIsolation(workflow)
    assertCiCliMuslFixture(workflow)
    assertPackedE2EToolchain(workflow)
    assertPackedE2ETmuxBinding(workflow)
    assertPackedE2EPrerequisiteOrder(workflow)
    assertOpenCodeProvisioning(workflow)
    assertBatsProvisioning(workflow)
    assertRustLiveBinaryBuild(workflow)
  }
  if (workflowName === "release.yml") {
    assertTrustedPublisherContract(text)
    assertBatsProvisioning(workflow, "build-test", releaseRustToolchainInstall)
    assertPackedE2EToolchain(workflow, "validate-draft")
    assertPackedE2ETmuxBinding(workflow, "validate-draft")
    assertPackedE2EPrerequisiteOrder(workflow, "validate-draft")
    assertPromotionGraph(workflow)
  }
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
  expect(text).toContain('cargo build --release --locked --manifest-path pane-dash/Cargo.toml --target "${{ matrix.rust_target }}"')
  expect(text).toContain('cargo test --workspace --locked --manifest-path pane-dash/Cargo.toml --target "${{ matrix.rust_target }}" -- --test-threads=1')
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

test("Rust and four-target process-spawning tests reject missing or parallel commands", async () => {
  const text = await workflow("ci.yml")
  const rust = job(text, "rust")
  const fourTargets = job(text, "four-targets")
  const active = `${cargoTestPrefix} -- --test-threads=1`
  const ignored = `${cargoTestPrefix} -- --ignored --test-threads=1`
  const target = `${cargoTestPrefix} --target "\${{ matrix.rust_target }}" -- --test-threads=1`

  expect(() => assertRustTestSerialization(rust)).not.toThrow()
  expect(() => assertRustTestSerialization(rust.replace(ignored, ""))).toThrow(/exact serial commands/)
  expect(() => assertRustTestSerialization(rust.replace(active, active.replace(" -- --test-threads=1", "")))).toThrow(/exact serial commands/)
  const reversed = rust.replace(active, "__active__").replace(ignored, active).replace("__active__", ignored)
  expect(() => assertRustTestSerialization(reversed)).toThrow(/exact serial commands/)

  expect(() => assertFourTargetTestSerialization(fourTargets)).not.toThrow()
  expect(() => assertFourTargetTestSerialization(fourTargets.replace(target, ""))).toThrow(/exact serial commands/)
  expect(() => assertFourTargetTestSerialization(fourTargets.replace(target, target.replace(" -- --test-threads=1", "")))).toThrow(/exact serial commands/)
})

test("release active and target Rust tests reject missing or parallel commands", async () => {
  const text = await workflow("release.yml")
  const activeBody = job(text, "build-test")
  const targetBody = job(text, "build-four-targets")
  const active = `${cargoTestPrefix} -- --test-threads=1`
  const target = `${cargoTestPrefix} --target "\${RUST_TARGET}" -- --test-threads=1`

  expect(() => assertSerialCargoTestCommands(activeBody, [active], "release active process-spawning tests")).not.toThrow()
  expect(() => assertSerialCargoTestCommands(activeBody.replace(active, cargoTestPrefix), [active], "release active process-spawning tests")).toThrow(/exact serial commands/)
  expect(() => assertSerialCargoTestCommands(targetBody, [target], "release target process-spawning tests")).not.toThrow()
  expect(() => assertSerialCargoTestCommands(targetBody.replace(target, target.replace(" -- --test-threads=1", "")), [target], "release target process-spawning tests")).toThrow(/exact serial commands/)
})

test("Rust builds the live-test binary after its gates and rejects missing, reordered, or bare cargo builds", async () => {
  const text = await workflow("ci.yml")
  const parsed = parseWorkflow(text)
  const rust = parsed.jobs["rust"]
  if (!rust) throw new Error("rust job is missing")
  const gateIndex = rust.steps.findIndex((step) => stepCommands(step).some((line) => line.trim() === rustBuildCommands[0]))
  if (gateIndex < 0) throw new Error("fixture workflow is missing the Rust build step")
  const gateRun = rust.steps[gateIndex]!.run ?? ""
  const buildBlock = rustBuildCommands.join("\n")
  const withGateRun = (run: string): ParsedWorkflow => ({
    ...parsed,
    jobs: {
      ...parsed.jobs,
      rust: {
        ...rust,
        steps: rust.steps.map((step, index) => index === gateIndex ? { ...step, run } : step),
      },
    },
  })

  expect(() => assertRustLiveBinaryBuild(parsed)).not.toThrow()
  expect(() => assertRustLiveBinaryBuild(withGateRun(gateRun.replace(buildBlock, "")))).toThrow(/make build/)
  expect(() => assertRustLiveBinaryBuild(withGateRun(gateRun.replace(buildBlock, "").replace("cargo fmt --all --manifest-path pane-dash/Cargo.toml -- --check", `${buildBlock}\ncargo fmt --all --manifest-path pane-dash/Cargo.toml -- --check`)))).toThrow(/after the Rust gates/)
  expect(() => assertRustLiveBinaryBuild(withGateRun(gateRun.replace("make build", "cargo build --release --locked --manifest-path pane-dash/Cargo.toml")))).toThrow(/make build|bare cargo build/)
})

test("ci-cli builds the pinned musl fixture before Node20 release tests and rejects host builds", async () => {
  const text = await workflow("ci.yml")
  const parsed = parseWorkflow(text)
  const ciCli = parsed.jobs["ci-cli"]
  if (!ciCli) throw new Error("ci-cli is missing")
  const fixtureIndex = ciCli.steps.findIndex((step) => stepCommands(step).some((line) => line.trim() === ciCliMuslToolchainInstall))
  if (fixtureIndex < 0) throw new Error("fixture workflow is missing the ci-cli musl build step")
  const fixtureRun = ciCli.steps[fixtureIndex]!.run ?? ""
  const buildCommand = ciCliMuslCargoBuild
  const withFixtureRun = (run: string): ParsedWorkflow => ({
    ...parsed,
    jobs: {
      ...parsed.jobs,
      "ci-cli": {
        ...ciCli,
        steps: ciCli.steps.map((step, index) => index === fixtureIndex ? { ...step, run } : step),
      },
    },
  })
  const withCiCliSteps = (steps: ParsedStep[]): ParsedWorkflow => ({
    ...parsed,
    jobs: { ...parsed.jobs, "ci-cli": { ...ciCli, steps } },
  })

  expect(() => assertCiCliMuslFixture(parsed)).not.toThrow()
  expect(fixtureRun).toContain("mkdir -p bin")
  expect(() => assertCiCliMuslFixture(withFixtureRun(fixtureRun.replace("mkdir -p bin", "mkdir bin")))).toThrow(/exact pinned musl/)
  expect(() => assertCiCliMuslFixture(withFixtureRun(fixtureRun.replace("sudo apt-get update\n", "")))).toThrow(/exact pinned musl/)
  expect(() => assertCiCliMuslFixture(withFixtureRun(fixtureRun.replace(buildCommand, "make build")))).toThrow(/plain make/)
  expect(() => assertCiCliMuslFixture(withFixtureRun(fixtureRun.replace(buildCommand, "cargo build --release --locked --manifest-path pane-dash/Cargo.toml")))).toThrow(/default GNU/)

  const nodeWrapperIndex = ciCli.steps.findIndex((step) => (step.run ?? "").includes("tests/release/with-node20.sh --"))
  const reorderedSteps = [...ciCli.steps]
  const fixtureStep = reorderedSteps.splice(fixtureIndex, 1)[0]!
  reorderedSteps.splice(nodeWrapperIndex, 0, fixtureStep)
  expect(() => assertCiCliMuslFixture(withCiCliSteps(reorderedSteps))).toThrow(/before Node20 wrapper tests/)
})

test("packed E2E provisions musl in the isolated Rust toolchain before its fixture", async () => {
  const text = await workflow("ci.yml")
  const parsed = parseWorkflow(text)
  expect(() => assertPackedE2EToolchain(parsed)).not.toThrow()

  const packed = parsed.jobs["packed-e2e"]!
  const provisionIndex = packed.steps.findIndex((step) => (step.run ?? "").includes('"$RUSTUP_BOOTSTRAP" target add x86_64-unknown-linux-musl --toolchain 1.96.1'))
  const broken = packed.steps.map((step, index) => index === provisionIndex ? { ...step, run: (step.run ?? "").replace('test "$RUSTUP_HOME" = "$PANE_DASH_ISOLATED_RUST_ROOT/rustup"', "") } : step)
  expect(() => assertPackedE2EToolchain({ ...parsed, jobs: { ...parsed.jobs, "packed-e2e": { ...packed, steps: broken } } })).toThrow(/isolated Rust target/)
})

test("packed E2E binds the verified tmux into the doctor PATH before its fixture", async () => {
  const text = await workflow("ci.yml")
  const parsed = parseWorkflow(text)
  expect(() => assertPackedE2ETmuxBinding(parsed)).not.toThrow()

  const packed = parsed.jobs["packed-e2e"]!
  const bindingIndex = packed.steps.findIndex((step) => (step.run ?? "").includes("sudo ln -sfn -- \"$TMUX_BIN\" /usr/local/bin/tmux"))
  const fixtureIndex = packed.steps.findIndex((step) => (step.run ?? "").includes("packages/tmux-pane-dash/tests/packed-e2e.test.ts"))
  const withoutBinding = packed.steps.filter((_, index) => index !== bindingIndex)
  expect(() => assertPackedE2ETmuxBinding({ ...parsed, jobs: { ...parsed.jobs, "packed-e2e": { ...packed, steps: withoutBinding } } })).toThrow(/bind its verified tmux/)

  const reordered = [...packed.steps]
  const bindingStep = reordered.splice(bindingIndex, 1)[0]!
  reordered.splice(fixtureIndex, 0, bindingStep)
  expect(() => assertPackedE2ETmuxBinding({ ...parsed, jobs: { ...parsed.jobs, "packed-e2e": { ...packed, steps: reordered } } })).toThrow(/before the fixture/)
})

test("release validate-draft uses the exact tmux and isolated musl prerequisites before packed E2E", async () => {
  const text = await workflow("release.yml")
  const parsed = parseWorkflow(text)
  const validation = parsed.jobs["validate-draft"]
  if (!validation) throw new Error("validate-draft job is missing")
  expect(() => assertPackedE2ETmuxBinding(parsed, "validate-draft")).not.toThrow()
  expect(() => assertPackedE2EToolchain(parsed, "validate-draft")).not.toThrow()
  expect(() => assertPackedE2EPrerequisiteOrder(parsed, "validate-draft")).not.toThrow()

  const bindingIndex = validation.steps.findIndex((step) => (step.run ?? "").includes("sudo ln -sfn -- \"$TMUX_BIN\" /usr/local/bin/tmux"))
  const muslIndex = validation.steps.findIndex((step) => (step.run ?? "").includes('tests/release/with-rust.sh -- "$RUSTUP_BOOTSTRAP" target add x86_64-unknown-linux-musl --toolchain 1.96.1'))
  const packedIndex = validation.steps.findIndex((step) => (step.run ?? "").includes("packages/tmux-pane-dash/tests/packed-e2e.test.ts"))
  expect(bindingIndex).toBeLessThan(muslIndex)
  expect(muslIndex).toBeLessThan(packedIndex)

  const withoutBinding = validation.steps.filter((_, index) => index !== bindingIndex)
  expect(() => assertPackedE2ETmuxBinding({ ...parsed, jobs: { ...parsed.jobs, "validate-draft": { ...validation, steps: withoutBinding } } }, "validate-draft")).toThrow(/bind its verified tmux/)

  const muslRun = validation.steps[muslIndex]!.run ?? ""
  const withoutMuslTools = validation.steps.map((step, index) => index === muslIndex ? { ...step, run: muslRun.replace("sudo apt-get install -y musl-tools\n", "") } : step)
  expect(() => assertPackedE2EToolchain({ ...parsed, jobs: { ...parsed.jobs, "validate-draft": { ...validation, steps: withoutMuslTools } } }, "validate-draft")).toThrow(/musl-tools/)

  const reordered = [...validation.steps]
  const bindingStep = reordered.splice(bindingIndex, 1)[0]!
  reordered.splice(muslIndex, 0, bindingStep)
  expect(() => assertPackedE2EPrerequisiteOrder({ ...parsed, jobs: { ...parsed.jobs, "validate-draft": { ...validation, steps: reordered } } }, "validate-draft")).toThrow(/sequence/)
})

test("OpenCode compatibility runs only its targeted postinstalls before integrity and version checks", async () => {
  const text = await workflow("ci.yml")
  const parsed = parseWorkflow(text)
  expect(() => assertOpenCodeProvisioning(parsed)).not.toThrow()

  const job = parsed.jobs["opencode-compatibility"]!
  const stepIndex = job.steps.findIndex((step) => (step.run ?? "").includes("run_opencode_postinstall"))
  const broken = job.steps.map((step, index) => index === stepIndex ? { ...step, run: (step.run ?? "").replace('run_opencode_postinstall "$RUNNER_TEMP/opencode-latest"', "") } : step)
  expect(() => assertOpenCodeProvisioning({ ...parsed, jobs: { ...parsed.jobs, "opencode-compatibility": { ...job, steps: broken } } })).toThrow(/out of order/)
})

test("OpenCode compatibility stays on macOS for the Seatbelt loopback sandbox", async () => {
  const text = await workflow("ci.yml")
  const harness = await readFile(join(root, "opencode-plugin", "tests", "real-opencode.test.ts"), "utf8")
  expect(() => assertOpenCodeMacOsSandbox(text, harness)).not.toThrow()

  const ubuntuMutation = text.replace("    runs-on: macos-14", "    runs-on: ubuntu-24.04")
  expect(() => assertOpenCodeMacOsSandbox(ubuntuMutation, harness)).toThrow(/macos-14/)
})

test("archive-dry-run is the terminal CI status and reaches the required CI graph", async () => {
  const text = await workflow("ci.yml")
  const parsed = parseWorkflow(text)
  const terminal = parsed.jobs["archive-dry-run"]
  expect(terminal).toBeDefined()
  expect(terminal?.needs).toEqual(["packed-e2e"])
  expect(terminal?.steps.some((step) => (step.run ?? "").includes("scripts/release/dry-run.ts"))).toBe(true)

  for (const producer of ["packed-e2e", "installer-faults", "cli-tests", "four-targets", "rust", "version-check"]) {
    expect(dependsOn(parsed, "archive-dry-run", producer), `archive-dry-run depends on ${producer}`).toBe(true)
  }
  expect(Object.values(parsed.jobs).every((job) => !job.needs.includes("archive-dry-run"))).toBe(true)
})

test("archive-dry-run installs locked dependencies immediately before its clean-room dry-run", async () => {
  const text = await workflow("ci.yml")
  const archive = job(text, "archive-dry-run")
  const installStep = "      - run: bun install --frozen-lockfile\n"
  const dryRunStep = "      - run: PANE_DASH_NODE20_PREPROVIDED=1 tests/release/with-node20.sh -- scripts/release/clean-room.sh -- bun scripts/release/dry-run.ts\n"
  const replaceArchive = (body: string): string => text.replace(archive, body)
  const assertDependencies = (candidate: string) => assertArchiveDryRunDependencies(parseWorkflow(candidate))

  expect(archive).toContain(installStep.trimEnd())
  expect(archive).toContain(dryRunStep.trimEnd())
  expect(() => assertDependencies(text)).not.toThrow()
  expect(() => assertDependencies(replaceArchive(archive.replace(installStep, "")))).toThrow(/locked dependencies/)
  expect(() => assertDependencies(replaceArchive(archive.replace(installStep + dryRunStep, dryRunStep + installStep)))).toThrow(/immediately before/)
  expect(() => assertDependencies(replaceArchive(archive.replace(installStep, "      - run: bun install\n")))).toThrow(/locked dependencies/)
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
  expect(text).toContain('npm publish "$RUNNER_TEMP/npm/xiopt-pane-dash-opencode-0.1.1.tgz" --access public --provenance')
  expect(text).toContain("npm publish")
  expect(text).toContain("vars.NPM_TRUSTED_PUBLISHER_BINDING")
  expect(text).toContain("trustedPublishers")
  expect(text).toContain("release-manifest.json")
  expect(text).toContain("SHA256SUMS")
  console.log("promotion-permissions=contents:write,actions:read,deployments:read npm-permissions=unchanged")
})

test("release trusted publisher checks require one canonical exact binding without fallbacks", async () => {
  const text = await workflow("release.yml")
  const requiredLine = 'test -n "${NPM_TRUSTED_PUBLISHER_BINDING:?NPM_TRUSTED_PUBLISHER_BINDING is required}"'
  const compareLine = 'test "$NPM_TRUSTED_PUBLISHER_BINDING" = "$NPM_TRUSTED_PUBLISHER_EXPECTED"'
  expect(() => assertTrustedPublisherContract(text)).not.toThrow()
  expect(trustedPublisherBindingMatches(trustedPublisherExpected, trustedPublisherExpected)).toBe(true)

  const binding = JSON.parse(trustedPublisherExpected) as { packages: Record<string, Record<string, string>>; schemaVersion: number }
  const candidate = (mutate: (value: typeof binding) => void): string => {
    const copy = structuredClone(binding)
    mutate(copy)
    return JSON.stringify(copy)
  }
  for (const value of [
    "{malformed",
    undefined,
    candidate((value) => { (value as Record<string, unknown>).extra = true }),
    candidate((value) => { value.packages["@xiopt/pane-dash-opencode"]!.allowedAction = "npm publish && npm install" }),
    candidate((value) => { value.packages["@xiopt/pane-dash-opencode"]!.repository = "attacker/repository" }),
    candidate((value) => { value.packages["@xiopt/pane-dash-opencode"]!.workflow = "other.yml" }),
    candidate((value) => { value.packages["@xiopt/pane-dash-opencode"]!.environment = "unprotected" }),
    candidate((value) => { value.packages["@xiopt/pane-dash-opencode"]!.allowedAction = "npm install" }),
  ]) expect(trustedPublisherBindingMatches(value, trustedPublisherExpected)).toBe(false)

  const malformedExpected = text.replace(trustedPublisherExpectedEnvLine, `  NPM_TRUSTED_PUBLISHER_EXPECTED: '{malformed'`)
  expect(() => assertTrustedPublisherContract(malformedExpected)).toThrow(/canonically|defined once/)
  expect(() => assertTrustedPublisherContract(text.replace(`${requiredLine}\n`, ""))).toThrow(/fail closed/)
  expect(() => assertTrustedPublisherContract(text.replace(compareLine, 'test "$NPM_TRUSTED_PUBLISHER_BINDING" = "npm publish"'))).toThrow(/compare|bare action/)
  expect(() => assertTrustedPublisherContract(text.replace(requiredLine, 'test -n "${NPM_TRUSTED_PUBLISHER_BINDING:-npm publish}"'))).toThrow(/fail closed|fallback/)
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

test("promotion proof keeps canonical tag validation separate from short live deployment refs", async () => {
  const text = await workflow("release.yml")
  const parsed = parseWorkflow(text)
  expect(() => assertPromotionGraph(parsed)).not.toThrow()
  const promote = parsed.jobs["promote-release"]!
  const proof = promote.steps.find((step) => (step.run ?? "").includes("deployments?sha=$GITHUB_SHA"))?.run ?? ""
  expect(proof).toContain('test "$GITHUB_REF" = "refs/tags/$GITHUB_REF_NAME"')
  expect(proof).toContain("ref=$GITHUB_REF_NAME")
  expect(proof).toContain("deployment.ref !== process.env.GITHUB_REF_NAME")
  for (const mutation of [
    text.replace('test "$GITHUB_REF" = "refs/tags/$GITHUB_REF_NAME"', 'test "$GITHUB_REF_NAME" = "v0.1.0"'),
    text.replace("ref=$GITHUB_REF_NAME", "ref=$GITHUB_REF"),
    text.replace("deployment.ref !== process.env.GITHUB_REF_NAME", "deployment.ref !== process.env.GITHUB_REF"),
    text.replace("deployment.ref !== process.env.GITHUB_REF_NAME", "!/^refs\\/tags\\//.test(deployment.ref)"),
  ]) expect(() => assertPromotionGraph(parseWorkflow(mutation))).toThrow()
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
  expect(targets).toContain("cargo build --release --locked --manifest-path pane-dash/Cargo.toml")
  expect(targets).toContain("cargo test --workspace --locked --manifest-path pane-dash/Cargo.toml")
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

test("assemble-verified stages the assembled manifest before expected package verification and pack", async () => {
  const body = job(await workflow("release.yml"), "assemble-verified")
  const stage = "bun scripts/release/package-build.ts --release-manifest \"$release_dir/release-manifest.json\" --require-change"
  const verify = "tests/release/with-node20.sh -- bun scripts/release/verify-artifacts.ts --packages --release-manifest \"$release_dir/release-manifest.json\""
  const pack = "npm pack --workspace packages/tmux-pane-dash --workspace opencode-plugin --pack-destination \"$npm_dir\""
  expect(() => assertPackageAssemblyOrder(body)).not.toThrow()
  expect(() => assertPackageAssemblyOrder(body.replace(`${stage}\n`, ""))).toThrow(/missing or out of order/)
  const reordered = body.replace(stage, "__stage__").replace(verify, stage).replace("__stage__", verify)
  expect(() => assertPackageAssemblyOrder(reordered)).toThrow(/missing or out of order/)
  expect(() => assertPackageAssemblyOrder(body.replace(pack, "npm pack"))).toThrow(/missing or out of order/)
})

test("npm production audits signatures without fallback bindings and verifies publication order", async () => {
  const text = await workflow("release.yml")
  const npm = job(text, "npm-production")
  expect(npm).toContain("npm audit signatures")
  expect(npm).toContain('NPM_TRUSTED_PUBLISHER_BINDING:?')
  expect(npm).not.toMatch(/NPM_TRUSTED_PUBLISHER_BINDING:-/)
  const plugin = npm.indexOf("xiopt-pane-dash-opencode-0.1.1.tgz")
  const cli = npm.indexOf("xiopt-tmux-pane-dash-0.1.1.tgz")
  expect(plugin).toBeGreaterThanOrEqual(0)
  expect(cli).toBeGreaterThan(plugin)
  expect(npm.indexOf("--package @xiopt/pane-dash-opencode")).toBeLessThan(npm.indexOf("--package @xiopt/tmux-pane-dash"))
})

test("npm production audits only the exact published versions in an isolated no-auth project", async () => {
  const text = await workflow("release.yml")
  const npm = job(text, "npm-production")
  const install = 'npm_config_userconfig="$audit_dir/.npmrc" npm_config_cache="$RUNNER_TEMP/npm-audit-cache" npm install --prefix "$audit_dir" --ignore-scripts --no-audit --no-fund --package-lock=false @xiopt/pane-dash-opencode@0.1.1 @xiopt/tmux-pane-dash@0.1.1'
  const signatures = 'npm_config_userconfig="$audit_dir/.npmrc" npm_config_cache="$RUNNER_TEMP/npm-audit-cache" npm audit signatures --prefix "$audit_dir"'
  expect(npm).toContain('audit_dir="$RUNNER_TEMP/npm-audit"')
  expect(npm).toContain('registry=https://registry.npmjs.org/')
  expect(npm).toContain(install)
  expect(npm).toContain(signatures)
  expect(npm).not.toContain("--package-lock=true")
  expect(npm).not.toContain('"dependencies"')
  expect(npm).not.toContain("# npm publish <tarball>")
  const pluginPublish = npm.indexOf('npm publish "$RUNNER_TEMP/npm/xiopt-pane-dash-opencode-0.1.1.tgz"')
  const cliPublish = npm.indexOf('npm publish "$RUNNER_TEMP/npm/xiopt-tmux-pane-dash-0.1.1.tgz"')
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
    "tmux-pane-dash-v0.1.1-aarch64-apple-darwin.tar.gz",
    "tmux-pane-dash-v0.1.1-x86_64-apple-darwin.tar.gz",
    "tmux-pane-dash-v0.1.1-aarch64-unknown-linux-musl.tar.gz",
    "tmux-pane-dash-v0.1.1-x86_64-unknown-linux-musl.tar.gz",
    "release-manifest.json",
    "SHA256SUMS",
  ]) expect(validation).toContain(`$RUNNER_TEMP/draft/${asset}`)
  expect(validation).toContain("attestation_assets=(")
  expect(validation).toContain("--repo \"$GITHUB_REPOSITORY\"")
  expect(validation).toContain("--signer-workflow xiopt/tmux-pane-dash/.github/workflows/release.yml")
  expect(validation).toContain("--source-ref refs/tags/v0.1.1")
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

test("Rust Bats requires ordered distro provisioning and the wrapped command", async () => {
  const text = await workflow("ci.yml")
  const parsed = parseWorkflow(text)
  const rust = parsed.jobs["rust"]
  if (!rust) throw new Error("rust job is missing")
  const provisionIndex = rust.steps.findIndex(isBatsProvision)
  const batsIndex = rust.steps.findIndex((step) => stepCommands(step).some((line) => line.trim() === wrappedBatsCommand))
  if (provisionIndex < 0 || batsIndex < 0) throw new Error("fixture workflow is missing the Bats steps")
  expect(() => assertBatsProvisioning(parsed)).not.toThrow()

  const withRustSteps = (steps: ParsedStep[]): ParsedWorkflow => ({
    ...parsed,
    jobs: { ...parsed.jobs, rust: { ...rust, steps } },
  })
  expect(() => assertBatsProvisioning(withRustSteps(rust.steps.filter((_, index) => index !== provisionIndex)))).toThrow(/provision/)

  const reorderedSteps = [...rust.steps]
  const provisionStep = reorderedSteps.splice(provisionIndex, 1)[0]!
  reorderedSteps.splice(batsIndex, 0, provisionStep)
  expect(() => assertBatsProvisioning(withRustSteps(reorderedSteps))).toThrow(/before/)

  for (const command of ["bats tests", "/usr/bin/bats tests"]) {
    const bareInvocation = rust.steps.map((step, index) => index === batsIndex ? { ...step, run: (step.run ?? "").replace(wrappedBatsCommand, command) } : step)
    expect(() => assertBatsProvisioning(withRustSteps(bareInvocation))).toThrow(/with-rust/)
  }
})

test("release Bats keeps tmux, Rust, distro provisioning, and isolation ordered", async () => {
  const text = await workflow("release.yml")
  const parsed = parseWorkflow(text)
  const build = parsed.jobs["build-test"]
  if (!build) throw new Error("build-test job is missing")
  const provisionIndex = build.steps.findIndex(isBatsProvision)
  const batsIndex = build.steps.findIndex((step) => stepCommands(step).some((line) => line.trim() === wrappedBatsCommand))
  if (provisionIndex < 0 || batsIndex < 0) throw new Error("release workflow is missing the Bats steps")
  expect(() => assertBatsProvisioning(parsed, "build-test", releaseRustToolchainInstall)).not.toThrow()

  const withBuildSteps = (steps: ParsedStep[]): ParsedWorkflow => ({
    ...parsed,
    jobs: { ...parsed.jobs, "build-test": { ...build, steps } },
  })
  expect(() => assertBatsProvisioning(withBuildSteps(build.steps.filter((_, index) => index !== provisionIndex)), "build-test", releaseRustToolchainInstall)).toThrow(/provision/)
  expect(() => assertBatsProvisioning(withBuildSteps(build.steps.map((step, index) => index === batsIndex ? { ...step, run: (step.run ?? "").replace(wrappedBatsCommand, "bats tests") } : step)), "build-test", releaseRustToolchainInstall)).toThrow(/with-rust/)

  const withoutTmux = build.steps.filter((step) => !(step.run ?? "").includes("scripts/release/ci-tmux.sh"))
  expect(() => assertBatsProvisioning(withBuildSteps(withoutTmux), "build-test", releaseRustToolchainInstall)).toThrow(/TMUX_BIN/)

  const reorderedSteps = [...build.steps]
  const provisionStep = reorderedSteps.splice(provisionIndex, 1)[0]!
  reorderedSteps.splice(batsIndex, 0, provisionStep)
  expect(() => assertBatsProvisioning(withBuildSteps(reorderedSteps), "build-test", releaseRustToolchainInstall)).toThrow(/before/)
})

test("workflow graph rejects a bare packed E2E command", async () => {
  const text = await workflow("release.yml")
  const broken = text.replace("          tests/release/with-rust.sh -- env \\\n", "          bun test \\\n")
  expect(() => assertWorkflowGraph(broken, "release.yml")).toThrow(/bare packed E2E/)
})

test("ci-cli rejects an unwrapped release test command", async () => {
  const text = await workflow("ci.yml")
  const ciCli = job(text, "ci-cli")
  expect(() => assertCiCliNpaIsolation(parseWorkflow(text))).not.toThrow()
  const unwrapped = text.replace(ciCli, ciCli.replace("tests/release/with-npa.sh -- ", ""))
  expect(() => assertCiCliNpaIsolation(parseWorkflow(unwrapped))).toThrow(/with-npa/)
})
