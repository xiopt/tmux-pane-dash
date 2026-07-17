import { expect, test } from "bun:test"
import { TmuxWriter, type Spawn } from "../src/writer"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test("serializes startup unsets before a following status write", async () => {
  const options = new Map([["@pane_dash_status", "stale"]])
  const calls: string[][] = []
  const exits: Array<ReturnType<typeof deferred<number>>> = []
  const secondStarted = deferred<void>()
  const spawn: Spawn = (command) => {
    calls.push(command)
    if (calls.length === 2) secondStarted.resolve()
    const exit = deferred<number>()
    exits.push(exit)
    exit.promise.then((code) => {
      if (code !== 0) return
      const name = command.at(command.includes("-pu") ? -1 : -2)!
      if (command.includes("-pu")) options.delete(name)
      else options.set(name, command.at(-1)!)
    })
    return { exited: exit.promise }
  }
  const writer = new TmuxWriter("%1", spawn)

  writer.unsetOption("@pane_dash_status", true)
  writer.setOption("@pane_dash_status", "idle")

  await Promise.resolve()
  expect(calls).toEqual([["tmux", "set-option", "-pu", "-t", "%1", "@pane_dash_status"]])

  exits[0]!.resolve(0)
  await secondStarted.promise
  expect(calls[1]).toEqual(["tmux", "set-option", "-pt", "%1", "@pane_dash_status", "idle"])

  exits[1]!.resolve(0)
  await writer.flush()
  expect(options.get("@pane_dash_status")).toBe("idle")
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
