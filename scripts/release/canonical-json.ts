import { createHash } from "node:crypto"

export type GitReader = { run(args: string[]): Promise<string> }

export function canonicalJson(value: unknown): Uint8Array {
  const normalize = (input: unknown): unknown => {
    if (input === null || typeof input === "string" || typeof input === "boolean") return input
    if (typeof input === "number") {
      if (!Number.isSafeInteger(input) && !Number.isFinite(input)) throw new Error("canonical JSON requires finite numbers")
      if (!Number.isSafeInteger(input) && Number.isInteger(input)) throw new Error("canonical JSON requires safe integers")
      return input
    }
    if (Array.isArray(input)) return input.map(normalize)
    if (typeof input === "object") {
      const record = input as Record<string, unknown>
      return Object.fromEntries(Object.keys(record).sort().map((key) => {
        if (record[key] === undefined) throw new Error("canonical JSON rejects undefined")
        return [key, normalize(record[key])]
      }))
    }
    throw new Error("canonical JSON accepts JSON values only")
  }
  return new TextEncoder().encode(`${JSON.stringify(normalize(value))}\n`)
}

export function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex") }

export async function sourceDateEpoch(git: GitReader, tag: string, tagCommit: string): Promise<number> {
  const resolved = (await git.run(["rev-parse", `${tag}^{commit}`])).trim()
  if (resolved !== tagCommit) throw new Error(`tag ${tag} does not resolve to supplied tag commit ${tagCommit}`)
  const text = (await git.run(["show", "-s", "--format=%ct", tagCommit])).trim()
  if (!/^[0-9]+$/.test(text)) throw new Error("tag commit has invalid committer timestamp")
  return Number(text)
}
