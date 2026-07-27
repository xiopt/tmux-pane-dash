import { expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { acquireLock } from "../src/lock"
import { transactionFixture } from "./helpers/fixture"

test("lock owner has exact durable schema and identity-safe release", async () => {
  const h = await transactionFixture()
  try {
    const lock = await acquireLock("setup", h.deps)
    const owner = JSON.parse(await readFile(join(h.root, "transactions", "lock", "owner.json"), "utf8"))
    expect(owner).toMatchObject({ schemaVersion: 1, pid: h.deps.pid!(), command: "setup", packageVersion: "0.1.0", startedAt: 0 })
    expect(owner.token).toMatch(/^[a-f0-9]{32,}$/)
    await expect(lock.release()).resolves.toBeUndefined()
  } finally { await h.cleanup() }
})

test("live owner remains locked regardless of age", async () => {
  const h = await transactionFixture({ alive: true })
  try {
    await mkdir(join(h.root, "transactions", "lock"), { recursive: true })
    await writeFile(join(h.root, "transactions", "lock", "owner.json"), JSON.stringify({ schemaVersion: 1, token: "a".repeat(32), pid: 42, command: "setup", packageVersion: "0.1.0", startedAt: 1 }))
    await expect(acquireLock("setup", h.deps)).rejects.toMatchObject({ code: "E_LOCKED", exitStatus: 73 })
  } finally { await h.cleanup() }
})

test("lock exhaustive concurrency and dead-owner rows fail closed", async () => {
  for (const row of ["concurrent", "dead-owner", "invalid-owner", "unknown-schema"] as const) {
    const h = await transactionFixture({ alive: false })
    try {
      if (row === "concurrent") { const live = { ...h.deps, isPidAlive: () => true }; const first = await acquireLock("setup", live); await expect(acquireLock("update", live)).rejects.toMatchObject({ code: "E_LOCKED" }); await first.release() }
      else {
        await mkdir(join(h.root, "transactions", "lock"), { recursive: true })
        await writeFile(join(h.root, "transactions", "lock", "owner.json"), row === "dead-owner" ? JSON.stringify({ schemaVersion: 1, token: "a".repeat(32), pid: 42, command: "setup", packageVersion: "0.1.0", startedAt: 1 }) : "{}")
        if (row === "dead-owner") await expect(acquireLock("update", h.deps)).resolves.toMatchObject({ recovered: true })
        else await expect(acquireLock("update", h.deps)).rejects.toThrow("E_LOCK")
      }
    } finally { await h.cleanup() }
  }
})
