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

const setupNode = (body: string, version: string) => {
  expect(body).toContain("uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0")
  expect(body).toContain(`node-version: \"${version}\"`)
  expect(body).not.toMatch(/^\s+cache(?:-dependency-path)?:/m)
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
  const npm = job(text, "npm-production")
  expect(npm).toContain("environment: npm-production")
  expect(npm).toContain("runs-on: ubuntu-24.04")
  expect(npm).toContain("contents: read")
  expect(npm).toContain("id-token: write")
  expect(npm).not.toContain("contents: write")
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
  expect(text).toContain("npm publish <tarball> --access public --provenance")
  expect(text).toContain("npm publish")
  expect(text).toContain("vars.NPM_TRUSTED_PUBLISHER_BINDING")
  expect(text).toContain("trustedPublishers")
  expect(text).toContain("release-manifest.json")
  expect(text).toContain("SHA256SUMS")
  console.log("promotion-permissions=contents:write,actions:read,deployments:read npm-permissions=unchanged")
})

test("both publishable package manifests retain the exact public repository URL", async () => {
  for (const path of ["packages/tmux-pane-dash/package.json", "opencode-plugin/package.json"]) {
    const pkg = JSON.parse(await readFile(join(root, path), "utf8"))
    expect(pkg.repository).toEqual({ type: "git", url: "git+https://github.com/xiopt/tmux-pane-dash.git" })
  }
})
