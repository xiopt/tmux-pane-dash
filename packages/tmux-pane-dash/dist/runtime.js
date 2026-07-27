// packages/tmux-pane-dash/src/errors.ts
class CliError extends Error {
  code;
  constructor(code, message = code) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = "CliError";
  }
}

// packages/tmux-pane-dash/src/args.ts
var usage = () => {
  throw new CliError("E_USAGE", "usage: tmux-pane-dash setup [--no-tmux] [--no-opencode] [--migrate] [--allow-downgrade] | update | doctor [--json] | uninstall");
};
function parseArgs(argv) {
  const [name, ...options] = argv;
  if (name === "setup") {
    const command = { name, tmux: true, opencode: true, migrate: false, allowDowngrade: false };
    const seen = new Set;
    for (const option of options) {
      if (seen.has(option))
        usage();
      seen.add(option);
      if (option === "--no-tmux")
        command.tmux = false;
      else if (option === "--no-opencode")
        command.opencode = false;
      else if (option === "--migrate")
        command.migrate = true;
      else if (option === "--allow-downgrade")
        command.allowDowngrade = true;
      else
        usage();
    }
    if (!command.tmux && !command.opencode)
      usage();
    return command;
  }
  if (name === "update" && options.length === 0)
    return { name };
  if (name === "doctor" && (options.length === 0 || options.length === 1 && options[0] === "--json"))
    return { name, json: options.length === 1 };
  if (name === "uninstall" && options.length === 0)
    return { name };
  return usage();
}

// packages/tmux-pane-dash/src/contracts.ts
var TARGET_KEYS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
var MAX_ARCHIVE_SIZE = 64 * 1024 * 1024;

// packages/tmux-pane-dash/src/platform.ts
function selectTarget(platform, arch) {
  const target = `${platform}-${arch}`;
  if (target === "darwin-arm64" || target === "darwin-x64" || target === "linux-arm64" || target === "linux-x64")
    return target;
  throw new CliError("E_PLATFORM", "unsupported platform");
}

// packages/tmux-pane-dash/src/manifest.ts
var targets = {
  "darwin-arm64": ["aarch64-apple-darwin", "tmux-pane-dash-v0.1.0-aarch64-apple-darwin.tar.gz"],
  "darwin-x64": ["x86_64-apple-darwin", "tmux-pane-dash-v0.1.0-x86_64-apple-darwin.tar.gz"],
  "linux-arm64": ["aarch64-unknown-linux-musl", "tmux-pane-dash-v0.1.0-aarch64-unknown-linux-musl.tar.gz"],
  "linux-x64": ["x86_64-unknown-linux-musl", "tmux-pane-dash-v0.1.0-x86_64-unknown-linux-musl.tar.gz"]
};
var keys = (value, expected) => typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
function parseReleaseManifest(value) {
  if (!keys(value, ["schemaVersion", "repository", "version", "tag", "assets"]) || value.schemaVersion !== 1 || value.repository !== "xiopt/tmux-pane-dash" || value.version !== "0.1.0" || value.tag !== "v0.1.0" || !keys(value.assets, TARGET_KEYS))
    throw new CliError("E_MANIFEST", "invalid release manifest");
  for (const key of TARGET_KEYS) {
    const asset = value.assets[key];
    const [target, name] = targets[key];
    if (!keys(asset, ["target", "asset", "url", "sha256", "size"]) || asset.target !== target || asset.asset !== name || asset.url !== `https://github.com/xiopt/tmux-pane-dash/releases/download/v0.1.0/${name}` || typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.size) || asset.size < 0 || asset.size > MAX_ARCHIVE_SIZE)
      throw new CliError("E_MANIFEST", "invalid release manifest");
  }
  return value;
}
function selectRelease(manifest, platform, arch) {
  return manifest.assets[selectTarget(platform, arch)];
}

// packages/tmux-pane-dash/src/runtime.ts
function versionParts(version) {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(version);
  if (!match)
    throw new CliError("E_VERSION", "invalid version");
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
function compareVersions(left, right) {
  const leftParts = versionParts(left), rightParts = versionParts(right);
  for (let index = 0;index < leftParts.length; index += 1) {
    if (leftParts[index] < rightParts[index])
      return -1;
    if (leftParts[index] > rightParts[index])
      return 1;
  }
  return 0;
}
function assertDowngradeAllowed(input) {
  if (compareVersions(input.executingVersion, input.ownedVersion) >= 0)
    return;
  if (input.command.name === "setup" && input.command.allowDowngrade)
    return;
  throw new CliError("E_DOWNGRADE", "refusing to downgrade");
}
async function runCli(argv, deps) {
  const command = parseArgs(argv);
  if (command.name === "doctor" || command.name === "uninstall")
    return 0;
  const manifest = parseReleaseManifest(deps.manifest);
  selectRelease(manifest, deps.platform, deps.arch);
  if (command.name === "update" && deps.ownedVersion === undefined)
    throw new CliError("E_USAGE", "no installation; run setup");
  if (deps.ownedVersion !== undefined)
    assertDowngradeAllowed({ command, executingVersion: deps.executingVersion, ownedVersion: deps.ownedVersion });
  await deps.lock?.();
  return 0;
}
export {
  runCli,
  compareVersions,
  assertDowngradeAllowed
};
