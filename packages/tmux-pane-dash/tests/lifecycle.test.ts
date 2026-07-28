import { expect, test } from "bun:test"
import { join } from "node:path"
import { acquireLock } from "../src/lock"
import { createJournal, persistJournal } from "../src/journal"
import { runCli, type Dependencies } from "../src/runtime"
import { archiveRecord, releaseArchive, releaseManifest, transactionFixture } from "./helpers/fixture"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(value => { resolve = value })
  return { promise, resolve }
}

async function* body(bytes: Uint8Array) { yield bytes }

test("a live transaction lock blocks a second run before command recovery and releases after failure", async () => {
  const h = await transactionFixture({ alive: true }), acquired = deferred(), proceed = deferred()
  const env = { ...h.deps.env, HOME: h.outside }
  const firstDeps: Dependencies = { ...h.deps, env }
  firstDeps.lock = async command => {
    const handle = await acquireLock(command, firstDeps)
    acquired.resolve()
    await proceed.promise
    return handle
  }
  const secondDeps: Dependencies = { ...h.deps, env }
  let secondFetches = 0
  secondDeps.fetch = async () => { secondFetches += 1; throw new Error("second command invoked") }
  secondDeps.lock = command => acquireLock(command, secondDeps)
  const journalPath = join(h.root, "transactions", "abababababababababababababababab", "journal.json")
  await persistJournal(createJournal({ id: "abababababababababababababababab", command: "setup", packageVersion: "0.1.0", previousCurrent: null, components: { tmux: false, opencode: true } }), firstDeps)
  let first: Promise<number> | undefined
  try {
    first = runCli(["setup"], firstDeps)
    await acquired.promise
    const second = runCli(["setup"], secondDeps)
    await expect(second).rejects.toMatchObject({ code: "E_LOCKED", exitStatus: 73 })
    expect(secondFetches).toBe(0)
    expect(await Bun.file(journalPath).exists()).toBeTrue()
    proceed.resolve()
    await expect(first).rejects.toThrow()
    expect(await Bun.file(join(h.root, "transactions", "lock")).exists()).toBeFalse()
    const nextDeps: Dependencies = { ...h.deps, env }
    nextDeps.lock = command => acquireLock(command, nextDeps)
    await expect(runCli(["uninstall"], nextDeps)).resolves.toBe(0)
    expect(await Bun.file(join(h.root, "transactions", "lock")).exists()).toBeFalse()
  } finally {
    proceed.resolve()
    await first?.catch(() => undefined)
    await h.cleanup()
  }
})

test("a lock release cannot remove a newer owner after a recovery handoff", async () => {
  const h = await transactionFixture({ alive: false })
  try {
    const first = await acquireLock("setup", h.deps)
    const ownerPath = join(h.root, "transactions", "lock", "owner.json")
    await first.release()
    const secondDeps = { ...h.deps, randomBytes: (size: number) => new Uint8Array(size).fill(0xcd) }
    const second = await acquireLock("update", secondDeps)
    await first.release()
    expect(await Bun.file(ownerPath).exists()).toBeTrue()
    await second.release()
  } finally { await h.cleanup() }
})

test.each([
  ["injected fault", { faultPhase: { phase: "prepared", boundary: "before" } }, "fault:prepared:before"],
  ["signal rollback", { signal: "TERM" }, "E_SIGNAL_TERM"],
] as const)("releases the production lock after %s", async (_name, failure, expected) => {
  const h = await transactionFixture(), archive = releaseArchive(), deps: Dependencies = {
    ...h.deps,
    env: { ...h.deps.env, HOME: h.outside },
    manifest: releaseManifest(archiveRecord(archive)),
    fetch: async () => ({ status: 200, body: body(archive) }),
    ...failure,
  }
  let releases = 0
  deps.lock = async command => {
    const handle = await acquireLock(command, deps)
    return { ...handle, release: async () => { await handle.release(); releases += 1 } }
  }
  try {
    await expect(runCli(["setup", "--no-tmux"], deps)).rejects.toThrow(expected)
    expect(releases).toBe(1)
    expect(await Bun.file(join(h.root, "transactions", "lock")).exists()).toBeFalse()
  } finally { await h.cleanup() }
})
