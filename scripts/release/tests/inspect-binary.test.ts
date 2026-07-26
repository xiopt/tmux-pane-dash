import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inspectBinary } from "../inspect-binary"

test("binary inspection recognizes architecture from bytes rather than filename", async () => {
  const root = await mkdtemp(join(tmpdir(), "pane-dash-binary-"))
  try {
    const arm64 = join(root, "x86_64-looking-name")
    await writeFile(arm64, new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 12, 0, 0, 1]))
    await expect(inspectBinary(arm64, "aarch64-apple-darwin")).resolves.toBeUndefined()
    await expect(inspectBinary(arm64, "x86_64-apple-darwin")).rejects.toThrow("architecture")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("Linux inspection rejects interpreter and dynamic dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "pane-dash-binary-"))
  try {
    const elf = join(root, "binary")
    await writeFile(elf, new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0xb7, 0, 0, 0, 0, ...new Array(48).fill(0)]))
    await expect(inspectBinary(elf, "aarch64-unknown-linux-musl")).resolves.toBeUndefined()
  } finally { await rm(root, { recursive: true, force: true }) }
})
