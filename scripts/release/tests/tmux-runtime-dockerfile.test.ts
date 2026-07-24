import { expect, test } from "bun:test"

const dockerfile = await Bun.file(new URL("../tmux-runtime.Dockerfile", import.meta.url)).text()

test("pins the runtime base and verifies the tmux 3.6 source", () => {
  expect(dockerfile).toContain("debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818")
  expect(dockerfile).toContain("tmux-3.6.tar.gz")
  expect(dockerfile).toContain("136db80cfbfba617a103401f52874e7c64927986b65b1b700350b6058ad69607")
})

test("selects only pinned official Rust Alpine builders and has no final-stage network", () => {
  expect(dockerfile).toContain("rust:1.96.1-alpine")
  expect(dockerfile).toContain("f5c84c3751de59f0f318acfbed8b2d04693a12d9171f15835d9c11c9ddcf52db")
  expect(dockerfile).toContain("ccba3c5d98fc76a5ac6eade9bcbbb946635657457c3d269982396633a66da08d")
  expect(dockerfile).toContain("FROM rust-${TARGETARCH} AS build")
  expect(dockerfile).not.toContain("cross-rs")
  const runtime = dockerfile.slice(dockerfile.lastIndexOf("FROM debian:"))
  expect(runtime).not.toMatch(/apt-get|curl|wget/)
})

test("copies readelf, file, ldd, and PTY tooling into the runtime", () => {
  expect(dockerfile).toContain("file binutils")
  expect(dockerfile).toContain("util-linux")
  expect(dockerfile).toContain("COPY --from=runtime-files /usr /usr")
  expect(dockerfile).toContain("COPY --from=runtime-files /lib /lib")
})
