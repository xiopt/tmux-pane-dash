import type { TargetKey } from "./contracts"
import { CliError } from "./errors"

export function selectTarget(platform: NodeJS.Platform, arch: NodeJS.Architecture): TargetKey {
  const target = `${platform}-${arch}`
  if (target === "darwin-arm64" || target === "darwin-x64" || target === "linux-arm64" || target === "linux-x64") return target
  throw new CliError("E_PLATFORM", "unsupported platform")
}
