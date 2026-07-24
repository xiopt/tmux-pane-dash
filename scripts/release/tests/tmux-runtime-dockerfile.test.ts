import { expect, test } from "bun:test"

const dockerfile = await Bun.file(new URL("../tmux-runtime.Dockerfile", import.meta.url)).text()

test("pins the runtime base and verifies the tmux 3.6 source", () => {
  expect(dockerfile).toContain("ARG DEBIAN_BASE")
  expect(dockerfile).toContain("FROM ${DEBIAN_BASE}")
  expect(dockerfile).toContain("tmux-3.6.tar.gz")
  expect(dockerfile).toContain("136db80cfbfba617a103401f52874e7c64927986b65b1b700350b6058ad69607")
})

test("keeps builder selection in the spike contract and has no final-stage network", () => {
  expect(dockerfile).not.toContain("FROM rust-")
  expect(dockerfile).not.toContain("cross-rs")
  expectFinalStageHasNoNetwork(dockerfile)
})

function expectFinalStageHasNoNetwork(contents: string): void {
  const stages = [...contents.matchAll(/^FROM\s+\$\{DEBIAN_BASE\}(?:\s+AS\s+\S+)?\s*$/gim)]
  expect(stages.length).toBeGreaterThanOrEqual(2)
  const runtime = contents.slice(stages.at(-1)!.index)
  expect(runtime).not.toMatch(/apt-get|curl|wget/)
}

test("rejects network tooling added after the actual DEBIAN_BASE final-stage boundary", () => {
  expect(() => expectFinalStageHasNoNetwork(`${dockerfile}\nRUN apt-get update`)).toThrow()
  expect(() => expectFinalStageHasNoNetwork(dockerfile.replace("ENTRYPOINT", "RUN curl https://example.invalid\nENTRYPOINT"))).toThrow()
})

test("has no BuildKit-only TARGETARCH expansion", () => {
  expect(dockerfile).not.toContain("TARGETARCH")
})

test("copies readelf, file, ldd, and PTY tooling into the runtime", () => {
  expect(dockerfile).toContain("file binutils")
  expect(dockerfile).toContain("util-linux")
  expect(dockerfile).toContain("COPY --from=runtime-files /usr /usr")
  expect(dockerfile).toContain("COPY --from=runtime-files /lib /lib")
  expect(dockerfile).not.toContain("COPY --from=runtime-files /lib64 /lib64")
})

test("installs yacc for the pinned tmux 3.6 source build", () => {
  expect(dockerfile).toMatch(/build-essential[^\n]*\bbison\b|\bbison\b[^\n]*build-essential/)
})
