#!/usr/bin/env node

// packages/tmux-pane-dash/src/cli.ts
import process2 from "node:process";
// packages/tmux-pane-dash/generated/release-manifest.json
var release_manifest_default = {
  assets: { "darwin-arm64": { asset: "tmux-pane-dash-v0.1.0-aarch64-apple-darwin.tar.gz", sha256: "dce292f658e6265354a2491d92a2de6fd2f3bfd88f84be980cb20d3506b0c99c", size: 880264, target: "aarch64-apple-darwin", url: "https://github.com/xiopt/tmux-pane-dash/releases/download/v0.1.0/tmux-pane-dash-v0.1.0-aarch64-apple-darwin.tar.gz" }, "darwin-x64": { asset: "tmux-pane-dash-v0.1.0-x86_64-apple-darwin.tar.gz", sha256: "02505027b8ec72851517c1b4c212058e257db4a5291f2a7be335dd1537617c69", size: 9263, target: "x86_64-apple-darwin", url: "https://github.com/xiopt/tmux-pane-dash/releases/download/v0.1.0/tmux-pane-dash-v0.1.0-x86_64-apple-darwin.tar.gz" }, "linux-arm64": { asset: "tmux-pane-dash-v0.1.0-aarch64-unknown-linux-musl.tar.gz", sha256: "35f36307dead44f99b713b043473b498ac6593bd00d718e2b125133faee435e4", size: 9265, target: "aarch64-unknown-linux-musl", url: "https://github.com/xiopt/tmux-pane-dash/releases/download/v0.1.0/tmux-pane-dash-v0.1.0-aarch64-unknown-linux-musl.tar.gz" }, "linux-x64": { asset: "tmux-pane-dash-v0.1.0-x86_64-unknown-linux-musl.tar.gz", sha256: "50a53833c1339cb7d2f6aee609e81b4b0385c129244ae51752de10c37418e1b4", size: 9268, target: "x86_64-unknown-linux-musl", url: "https://github.com/xiopt/tmux-pane-dash/releases/download/v0.1.0/tmux-pane-dash-v0.1.0-x86_64-unknown-linux-musl.tar.gz" } },
  repository: "xiopt/tmux-pane-dash",
  schemaVersion: 1,
  tag: "v0.1.0",
  version: "0.1.0"
};

// packages/tmux-pane-dash/src/dependencies.ts
import { spawn } from "node:child_process";
import process from "node:process";

// packages/tmux-pane-dash/src/fs.ts
import { chmod, lstat, mkdir, open, readdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
function canonicalPayloadPath(path) {
  if (!path || path.includes("\x00") || path.includes("\\") || path.startsWith("/") || path.endsWith("/") || path.includes("//"))
    throw new Error("invalid payload path");
  if (path.split("/").some((part) => !part || part === "." || part === ".."))
    throw new Error("invalid payload path");
  return path;
}
function within(root, relative) {
  const base = resolve(root), path = resolve(base, canonicalPayloadPath(relative));
  if (!path.startsWith(`${base}${sep}`))
    throw new Error("path escapes root");
  return path;
}
function nodeFsOps() {
  return {
    async mkdir(path) {
      await mkdir(path, { recursive: true, mode: 448 });
    },
    async readFile(path) {
      return new Uint8Array(await readFile(path));
    },
    async mkdirPayloadDirectory(root, relative, mode) {
      const path = within(root, relative);
      await mkdir(path, { recursive: false, mode: mode & 511 });
      await chmod(path, mode & 511);
    },
    async writeFileExclusive(root, relative, bytes, mode) {
      const path = within(root, relative);
      await mkdir(dirname(path), { recursive: true, mode: 448 });
      const file = await open(path, "wx", mode & 511);
      try {
        await file.writeFile(bytes);
      } finally {
        await file.close();
      }
    },
    async openExclusive(path, mode) {
      return open(path, "wx", mode & 511);
    },
    async write(file, bytes) {
      await file.writeFile(bytes);
    },
    async close(file) {
      await file.close();
    },
    async stat(path) {
      const entry = await lstat(path);
      return { kind: entry.isFile() ? "file" : entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "other", mode: entry.mode & 4095, size: entry.size };
    },
    async readdir(path) {
      return readdir(path);
    },
    async rm(path) {
      await rm(path, { recursive: true, force: true });
    }
  };
}

// packages/tmux-pane-dash/src/dependencies.ts
function nodeDependencies() {
  const child = (path, args, options) => new Promise((resolve2, reject) => {
    const process2 = spawn(path, args, { env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [], stderr = [];
    let size = 0, overflow = false, timedOut = false;
    const receive = (target) => (chunk) => {
      size += chunk.length;
      if (size > options.maxOutputBytes) {
        overflow = true;
        process2.kill("SIGKILL");
      } else
        target.push(chunk);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      process2.kill("SIGKILL");
    }, options.timeoutMs);
    timeout.unref();
    process2.stdout.on("data", receive(stdout));
    process2.stderr.on("data", receive(stderr));
    process2.once("error", reject);
    process2.once("close", (code) => {
      clearTimeout(timeout);
      if (overflow)
        reject(new Error("E_BINARY_OUTPUT"));
      else if (timedOut)
        reject(new Error("E_BINARY_TIMEOUT"));
      else
        resolve2({ code: code ?? 1, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() });
    });
  });
  return { manifest: release_manifest_default, platform: process.platform, arch: process.arch, executingVersion: release_manifest_default.version, ...{ fs: nodeFsOps(), nowMs: Date.now, fetch: globalThis.fetch.bind(globalThis), spawn: child } };
}

// packages/tmux-pane-dash/src/errors.ts
var statuses = { E_USAGE: 2, E_LOCKED: 73, E_SIGNAL_HUP: 129, E_SIGNAL_INT: 130, E_SIGNAL_TERM: 143 };

class CliError extends Error {
  code;
  constructor(code, message = code) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = "CliError";
  }
}
function exitStatusFor(error) {
  if (error instanceof CliError && error.code in statuses)
    return statuses[error.code];
  return 1;
}
function escapeOutput(value, limit = 240) {
  const escaped = String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) => `\\u${character.codePointAt(0).toString(16).padStart(4, "0")}`);
  return escaped.length <= limit ? escaped : `${escaped.slice(0, Math.max(0, limit - 3))}...`;
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

// packages/tmux-pane-dash/src/cli.ts
runCli(process2.argv.slice(2), nodeDependencies()).then((status) => {
  process2.exitCode = status;
}, (error) => {
  const code = error instanceof Error ? error.message : "E_INTERNAL";
  process2.stderr.write(`${escapeOutput(code)}
`);
  process2.exitCode = exitStatusFor(error);
});
