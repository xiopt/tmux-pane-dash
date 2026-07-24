import { expect, test } from "bun:test"

const dockerfile = await Bun.file(new URL("../tmux-runtime.Dockerfile", import.meta.url)).text()
const bootstrap = await Bun.file(new URL("../tmux-runtime-bootstrap.Dockerfile", import.meta.url)).text()

test("pins the offline runtime base and compiles the verified tmux 3.6 source", () => {
  expect(dockerfile).toContain("ARG DEBIAN_BASE")
  expect(dockerfile).toContain("FROM ${DEBIAN_BASE}")
  expect(dockerfile).toContain("ARG BOOTSTRAP_IMAGE")
  expect(dockerfile).toContain("FROM ${BOOTSTRAP_IMAGE} AS runtime-files")
  expect(dockerfile).toContain("tmux-3.6.tar.gz")
  expect(dockerfile).toMatch(/tar -xzf tmux-3\.6\.tar\.gz/)
  expect(dockerfile).toMatch(/\.\/configure[\s\S]*make[\s\S]*make install/)
})

test("keeps every runtime Dockerfile stage free of package or network acquisition", () => {
  expect(dockerfile).not.toContain("FROM rust-")
  expect(dockerfile).not.toContain("cross-rs")
  expectCompileDockerfileOffline(dockerfile)
})

test("limits network-enabled package acquisition tooling to the bootstrap Dockerfile", () => {
  expect(bootstrap).toContain("ARG DEBIAN_BASE")
  expect(bootstrap).toContain("FROM ${DEBIAN_BASE}")
  expect(bootstrap).toMatch(/apt-get update[\s\S]*apt-get install/)
  expect(bootstrap).toContain("curl")
  expect(bootstrap).toContain("build-essential")
  expect(bootstrap).toContain("libevent-dev")
  expect(bootstrap).toContain("libncurses-dev")
})

test("rejects any compile-stage network acquisition mutation", () => {
  for (const mutation of ["RUN apt-get update", "RUN curl https://example.invalid", "RUN wget https://example.invalid"]) {
    expect(() => expectCompileDockerfileOffline(`${dockerfile}\n${mutation}`)).toThrow()
  }
})

function expectCompileDockerfileOffline(contents: string): void {
  expect(contents).not.toMatch(/apt-get|curl|wget/)
}

test("has no BuildKit-only TARGETARCH expansion", () => {
  expect(dockerfile).not.toContain("TARGETARCH")
})

test("copies readelf, file, ldd, and PTY tooling into the runtime", () => {
  expect(bootstrap).toContain("file binutils")
  expect(bootstrap).toContain("util-linux")
  expect(dockerfile).toContain("COPY --from=runtime-files /usr /usr")
  expect(dockerfile).toContain("COPY --from=runtime-files /lib /lib")
  expect(dockerfile).not.toContain("COPY --from=runtime-files /lib64 /lib64")
})

test("installs yacc for the pinned tmux 3.6 source build", () => {
  expect(bootstrap).toMatch(/build-essential[^\n]*\bbison\b|\bbison\b[^\n]*build-essential/)
})
