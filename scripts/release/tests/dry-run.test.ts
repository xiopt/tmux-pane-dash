import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { assertGitRemotes, runDryRun } from "../dry-run"

const root = process.cwd()

test("dry-run simulates immutable archives, six release assets, attestations, packages, and handoff hashes without a remote", async () => {
  const output = await runDryRun({ root, environment: {}, remotes: [] })
  expect(output).toContain("archives=4")
  expect(output).toContain("assets=6")
  expect(output).toContain("attestation-subjects=6")
  expect(output).toContain("npm-inventories=2")
  expect(output).toContain("verified-handoff=PASS")
  expect(output).toContain("credentials=absent")
  expect(output).toContain("remote-mutations=0")
  expect(output).toContain("public-network-requests=0")
  expect(output).toContain("release-dry-run: PASS")
})

test("remote guard accepts only the exact reviewed origin fetch/push pairs", () => {
  for (const [fetchUrl, pushUrl] of [
    ["https://github.com/xiopt/tmux-pane-dash", "https://github.com/xiopt/tmux-pane-dash"],
    ["https://github.com/xiopt/tmux-pane-dash.git", "https://github.com/xiopt/tmux-pane-dash.git"],
    ["https://github.com/xiopt/tmux-pane-dash", "https://github.com/xiopt/tmux-pane-dash.git"],
  ]) {
    expect(() => assertGitRemotes([`origin\t${fetchUrl} (fetch)`, `origin\t${pushUrl} (push)`])).not.toThrow()
  }
})

test("dry-run refuses every credential and auth configuration input", async () => {
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "NPM_TOKEN", "NODE_AUTH_TOKEN", "NPM_CONFIG_USERCONFIG", "npm_config_userconfig"]) {
    await expect(runDryRun({ root, environment: { [name]: "/tmp/credential" } })).rejects.toThrow(/credential|auth/i)
  }
})

test("dry-run rejects unreviewed, incomplete, and malformed remotes, non-loopback fixtures, and mutation commands", async () => {
  const exact = "https://github.com/xiopt/tmux-pane-dash.git"
  const hostileRemotes = [
    ["origin\tgit@github.com:xiopt/tmux-pane-dash.git (fetch)", "origin\tgit@github.com:xiopt/tmux-pane-dash.git (push)"],
    ["origin\thttps://user:password@github.com/xiopt/tmux-pane-dash.git (fetch)", "origin\thttps://user:password@github.com/xiopt/tmux-pane-dash.git (push)"],
    ["origin\thttps://github.example.com/xiopt/tmux-pane-dash.git (fetch)", "origin\thttps://github.example.com/xiopt/tmux-pane-dash.git (push)"],
    ["origin\thttps://github.com/xiopt/other-repository.git (fetch)", "origin\thttps://github.com/xiopt/other-repository.git (push)"],
    ["origin\thttps://github.com/xiopt/tmux-pane-dash.evil (fetch)", "origin\thttps://github.com/xiopt/tmux-pane-dash.evil (push)"],
    [`origin\t${exact} (fetch)`, `origin\t${exact} (push)`, `upstream\t${exact} (fetch)`, `upstream\t${exact} (push)`],
    [`origin\t${exact} (fetch)`],
    [`origin\t${exact} fetch`, `origin\t${exact} push`],
    ["origin\thttps://github.com/xiopt/tmux-pane-dash?substitution=1 (fetch)", "origin\thttps://github.com/xiopt/tmux-pane-dash?substitution=1 (push)"],
    ["", `origin\t${exact} (fetch)`, `origin\t${exact} (push)`],
    ["https://github.com/xiopt/tmux-pane-dash.git"],
  ]
  for (const remotes of hostileRemotes) expect(() => assertGitRemotes(remotes)).toThrow("remote")
  await expect(runDryRun({ root, environment: {}, fixtureUrl: "https://registry.npmjs.org" })).rejects.toThrow("loopback")
  for (const command of ["git push", "git tag", "gh release create", "npm publish", "bun build release/verify-npm-provenance.ts"]) {
    await expect(runDryRun({ root, environment: {}, commands: [command] })).rejects.toThrow(/mutation|publish|rebuild/i)
  }
})

test("root dependency and lock are exact and publishable packages have no dependencies", async () => {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"))
  expect(pkg.devDependencies).toMatchObject({ sigstore: "4.1.1" })
  const lock = await readFile(join(root, "bun.lock"), "utf8")
  expect(lock).toContain('sigstore@4.1.1')
  for (const path of ["packages/tmux-pane-dash/package.json", "opencode-plugin/package.json"]) {
    const packageJson = JSON.parse(await readFile(join(root, path), "utf8"))
    expect(packageJson.dependencies ?? {}).toEqual({})
    expect(packageJson.devDependencies ?? {}).toEqual({})
  }
})
