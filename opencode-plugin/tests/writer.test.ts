import { expect, test } from "bun:test"
import { TmuxWriter, type Spawn } from "../src/writer"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test("converges directly to the final startup status", async () => {
  const options = new Map([["@pane_dash_status", "stale"]])
  const calls: string[][] = []
  const spawn: Spawn = (command) => {
    calls.push(command)
    const name = command.at(command.includes("-pu") ? -1 : -2)!
    if (command.includes("-pu")) options.delete(name)
    else options.set(name, command.at(-1)!)
    return { exited: Promise.resolve(0) }
  }
  const writer = new TmuxWriter("%1", spawn)

  writer.unsetOption("@pane_dash_status", true)
  writer.setOption("@pane_dash_status", "idle")
  await writer.flush()

  expect(calls).toEqual([["tmux", "set-option", "-pt", "%1", "@pane_dash_status", "idle"]])
  expect(options.get("@pane_dash_status")).toBe("idle")
})

test("batches multiple pending options into one tmux invocation", async () => {
  const calls: string[][] = []
  const spawn: Spawn = (command) => {
    calls.push(command)
    return { exited: Promise.resolve(0) }
  }
  const writer = new TmuxWriter("%1", spawn)

  writer.setOption("@pane_dash_status", "idle")
  writer.setOption("@pane_dash_title", "Fix auth")
  writer.unsetOption("@pane_dash_model")
  await writer.flush()

  expect(calls).toEqual([[
    "tmux", "set-option", "-pt", "%1", "@pane_dash_status", "idle",
    ";", "set-option", "-pt", "%1", "@pane_dash_title", "Fix auth",
    ";", "set-option", "-pu", "-t", "%1", "@pane_dash_model",
  ]])
})

test("retries every key from a failed batch on the next kick", async () => {
  const calls: string[][] = []
  const exits = [1, 0]
  const spawn: Spawn = (command) => {
    calls.push(command)
    return { exited: Promise.resolve(exits.shift()!) }
  }
  const writer = new TmuxWriter("%1", spawn)

  writer.setOption("@pane_dash_status", "idle")
  writer.setOption("@pane_dash_title", "Fix auth")
  await writer.flush()
  writer.setOption("@pane_dash_status", "idle")
  await writer.flush()

  expect(calls).toHaveLength(2)
  expect(calls[1]).toEqual(calls[0])
})

test("retries a value after its tmux write fails", async () => {
  const calls: string[][] = []
  const exits = [1, 0]
  const spawn: Spawn = (command) => {
    calls.push(command)
    return { exited: Promise.resolve(exits.shift()!) }
  }
  const writer = new TmuxWriter("%1", spawn)

  writer.setOption("@pane_dash_status", "idle")
  await writer.flush()
  writer.setOption("@pane_dash_status", "idle")
  await writer.flush()

  expect(calls).toHaveLength(2)
})

test("retries an unset after its tmux write fails", async () => {
  const calls: string[][] = []
  const exits = [1, 0]
  const spawn: Spawn = (command) => {
    calls.push(command)
    return { exited: Promise.resolve(exits.shift()!) }
  }
  const writer = new TmuxWriter("%1", spawn)

  writer.unsetOption("@pane_dash_title", true)
  await writer.flush()
  writer.unsetOption("@pane_dash_title")
  await writer.flush()

  expect(calls).toHaveLength(2)
})

test("retains a duplicate unset requested while the first unset is in flight", async () => {
  const calls: string[][] = []
  const firstStarted = deferred<void>()
  const firstExit = deferred<number>()
  const spawn: Spawn = (command) => {
    calls.push(command)
    if (calls.length === 1) {
      firstStarted.resolve()
      return { exited: firstExit.promise }
    }
    return { exited: Promise.resolve(0) }
  }
  const writer = new TmuxWriter("%1", spawn)

  writer.unsetOption("@pane_dash_status", true)
  await firstStarted.promise
  writer.unsetOption("@pane_dash_status")
  firstExit.resolve(1)
  await writer.flush()

  expect(calls).toHaveLength(2)
})

test("converges to the latest value when a newer set arrives in flight", async () => {
  const options = new Map<string, string>()
  const calls: string[][] = []
  const firstStarted = deferred<void>()
  const firstExit = deferred<number>()
  const spawn: Spawn = (command) => {
    calls.push(command)
    const exited = calls.length === 1 ? firstExit.promise : Promise.resolve(0)
    if (calls.length === 1) firstStarted.resolve()
    exited.then((code) => {
      if (code === 0) options.set(command.at(-2)!, command.at(-1)!)
    })
    return { exited }
  }
  const writer = new TmuxWriter("%1", spawn)

  writer.setOption("@pane_dash_status", "working")
  await firstStarted.promise
  writer.setOption("@pane_dash_status", "idle")
  firstExit.resolve(0)
  await writer.flush()

  expect(calls).toHaveLength(2)
  expect(options.get("@pane_dash_status")).toBe("idle")
})
