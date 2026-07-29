import { createHash } from "node:crypto"
import { isAbsolute } from "node:path"

const PINNED_VERSION = "1.17.20"
const PINNED_SHA256 = "14a4583c9a3685875f011d6dd4dfbd00498893942be0bb1d2c27e30e70144c89"

export type CompatibilityRow = {
  readonly name: string
  readonly binary: string
  readonly version: string
  readonly sha256: string
}

type VersionProbe = (binary: string) => Promise<string>
type BinaryReader = (binary: string) => Promise<Uint8Array>

function absoluteBinary(name: string, binary: string | undefined): string {
  if (!binary || !isAbsolute(binary)) throw new Error(`${name} must be an absolute executable path`)
  return binary
}

function supportedStableVersion(output: string): string {
  const match = /^(?:v)?(\d+)\.(\d+)\.(\d+)\n$/.exec(output)
  if (!match) throw new Error("OpenCode version must be exact v?x.y.z followed by one LF")
  const [major, minor, patch] = match.slice(1).map(BigInt)
  const [minimumMajor, minimumMinor, minimumPatch] = PINNED_VERSION.split(".").map(BigInt)
  if (major! < minimumMajor! || (major === minimumMajor && (minor! < minimumMinor! || (minor === minimumMinor && patch! < minimumPatch!)))) {
    throw new Error(`OpenCode version must be at least ${PINNED_VERSION}`)
  }
  return match.slice(1).join(".")
}

export async function resolveLatestCompatibility(binary: string, versionProbe: VersionProbe, readBinary: BinaryReader): Promise<CompatibilityRow> {
  const latestBinary = absoluteBinary("OPENCODE_LATEST_BIN", binary)
  const version = supportedStableVersion(await versionProbe(latestBinary))
  const sha256 = createHash("sha256").update(await readBinary(latestBinary)).digest("hex")
  return { name: `latest-stable-${version}`, binary: latestBinary, version, sha256 }
}

export async function resolveCompatibilityRows(
  pinnedBinary: string | undefined,
  latestBinary: string | undefined,
  versionProbe: VersionProbe,
  readBinary: BinaryReader,
): Promise<readonly [CompatibilityRow, CompatibilityRow]> {
  const pinned = absoluteBinary("OPENCODE_1_17_20_BIN", pinnedBinary)
  const pinnedVersion = supportedStableVersion(await versionProbe(pinned))
  if (pinnedVersion !== PINNED_VERSION) throw new Error(`OPENCODE_1_17_20_BIN must report ${PINNED_VERSION}`)
  const pinnedSha256 = createHash("sha256").update(await readBinary(pinned)).digest("hex")
  if (pinnedSha256 !== PINNED_SHA256) throw new Error("OPENCODE_1_17_20_BIN hash does not match the pinned OpenCode binary")

  return [
    { name: "pinned-1.17.20", binary: pinned, version: pinnedVersion, sha256: pinnedSha256 },
    await resolveLatestCompatibility(absoluteBinary("OPENCODE_LATEST_BIN", latestBinary), versionProbe, readBinary),
  ]
}
