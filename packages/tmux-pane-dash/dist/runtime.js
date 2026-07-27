var __defProp = Object.defineProperty;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};
var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);

// packages/tmux-pane-dash/src/errors.ts
var CliError;
var init_errors = __esm(() => {
  CliError = class CliError extends Error {
    code;
    constructor(code, message = code) {
      super(`${code}: ${message}`);
      this.code = code;
      this.name = "CliError";
    }
  };
});

// packages/tmux-pane-dash/src/args.ts
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
var usage = () => {
  throw new CliError("E_USAGE", "usage: tmux-pane-dash setup [--no-tmux] [--no-opencode] [--migrate] [--allow-downgrade] | update | doctor [--json] | uninstall");
};
var init_args = __esm(() => {
  init_errors();
});

// packages/tmux-pane-dash/src/contracts.ts
var TARGET_KEYS, MAX_ARCHIVE_SIZE;
var init_contracts = __esm(() => {
  TARGET_KEYS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
  MAX_ARCHIVE_SIZE = 64 * 1024 * 1024;
});

// packages/tmux-pane-dash/src/platform.ts
function selectTarget(platform, arch) {
  const target = `${platform}-${arch}`;
  if (target === "darwin-arm64" || target === "darwin-x64" || target === "linux-arm64" || target === "linux-x64")
    return target;
  throw new CliError("E_PLATFORM", "unsupported platform");
}
var init_platform = __esm(() => {
  init_errors();
});

// packages/tmux-pane-dash/src/manifest.ts
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
var targets, keys = (value, expected) => typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
var init_manifest = __esm(() => {
  init_contracts();
  init_errors();
  init_platform();
  targets = {
    "darwin-arm64": ["aarch64-apple-darwin", "tmux-pane-dash-v0.1.0-aarch64-apple-darwin.tar.gz"],
    "darwin-x64": ["x86_64-apple-darwin", "tmux-pane-dash-v0.1.0-x86_64-apple-darwin.tar.gz"],
    "linux-arm64": ["aarch64-unknown-linux-musl", "tmux-pane-dash-v0.1.0-aarch64-unknown-linux-musl.tar.gz"],
    "linux-x64": ["x86_64-unknown-linux-musl", "tmux-pane-dash-v0.1.0-x86_64-unknown-linux-musl.tar.gz"]
  };
});

// packages/tmux-pane-dash/src/fs.ts
import { chmod, lstat, mkdir, open, readdir, readFile, readlink, rename, rm } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
function canonicalPayloadPath(path) {
  if (!path || path.includes("\x00") || path.includes("\\") || path.startsWith("/") || path.endsWith("/") || path.includes("//"))
    throw new Error("invalid payload path");
  if (path.split("/").some((part) => !part || part === "." || part === ".."))
    throw new Error("invalid payload path");
  return path;
}
async function resolveConfigPath(logicalPath, _deps) {
  let path = logicalPath, links = [];
  for (let count = 0;count <= 16; count += 1) {
    let entry;
    try {
      entry = await lstat(path);
    } catch (error) {
      if (missing(error) && count === 0)
        return { logicalPath, resolvedPath: logicalPath, symlinkChain: [] };
      configError();
    }
    if (entry.isSymbolicLink()) {
      if (count === 16)
        configError();
      let target;
      try {
        target = await readlink(path);
      } catch {
        configError();
      }
      links.push({ path, target, dev: entry.dev, ino: entry.ino });
      path = isAbsolute(target) ? target : resolve(dirname(path), target);
      continue;
    }
    if (!entry.isFile())
      configError();
    const content = new Uint8Array(await readFile(path));
    return { logicalPath, resolvedPath: path, symlinkChain: links, mode: entry.mode & 511, preimageHash: digest(content) };
  }
  configError();
}
var missing = (error) => typeof error === "object" && error !== null && ("code" in error) && error.code === "ENOENT", digest = (value) => createHash("sha256").update(value).digest("hex"), configError = () => {
  throw new CliError("E_CONFIG");
};
var init_fs = __esm(() => {
  init_errors();
});

// packages/tmux-pane-dash/src/archive.ts
import { createHash as createHash2 } from "node:crypto";
import { join as join2 } from "node:path";
import { createInflateRaw } from "node:zlib";
function gzipHeaderLength(bytes) {
  if (bytes.length < 10)
    return;
  if (bytes[0] !== 31 || bytes[1] !== 139 || bytes[2] !== 8 || bytes[3] & 224)
    fail("gzip header");
  const flags = bytes[3], has = (flag) => (flags & flag) !== 0;
  let offset = 10;
  if (has(4)) {
    if (bytes.length < offset + 2)
      return;
    const length = bytes[offset] | bytes[offset + 1] << 8;
    offset += 2 + length;
    if (bytes.length < offset)
      return;
  }
  for (const flag of [8, 16])
    if (has(flag)) {
      const end = bytes.indexOf(0, offset);
      if (end < 0)
        return;
      offset = end + 1;
    }
  if (has(2)) {
    if (bytes.length < offset + 2)
      return;
    if (((crc32(4294967295, bytes.subarray(0, offset)) ^ 4294967295) & 65535) !== (bytes[offset] | bytes[offset + 1] << 8))
      fail("gzip header");
    offset += 2;
  }
  return offset;
}
function field(header, offset, length) {
  const value = header.subarray(offset, offset + length), nul = value.indexOf(0);
  if (nul < 0 || value.subarray(nul + 1).some((byte) => byte !== 0))
    fail("header field");
  try {
    return text.decode(value.subarray(0, nul));
  } catch {
    return fail("header encoding");
  }
}
function octal(header, offset, length) {
  const value = field(header, offset, length);
  if (!/^[0-7]+$/.test(value))
    fail("number");
  const result = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(result))
    fail("number");
  return result;
}
function checksum(header) {
  const expected = octal(header, 148, 8);
  let actual = 0;
  for (let index = 0;index < 512; index += 1)
    actual += index >= 148 && index < 156 ? 32 : header[index];
  if (actual !== expected)
    fail("checksum");
}
function headerIsSafe(header) {
  octal(header, 108, 8);
  octal(header, 116, 8);
  octal(header, 136, 12);
  for (const [offset, length] of [[157, 100], [265, 32], [297, 32], [329, 8], [337, 8], [345, 155], [500, 12]])
    if (!allZero(header.subarray(offset, offset + length)))
      fail("metadata");
  if (field(header, 257, 6) !== "ustar" || text.decode(header.subarray(263, 265)) !== "00")
    fail("format");
}

class TarParser {
  root;
  fs;
  limits;
  wait;
  pending = new Uint8Array;
  entries = 0;
  inflated = 0;
  seen = new Set;
  ended = false;
  zeroBlocks = 0;
  current;
  constructor(root, fs, limits, wait) {
    this.root = root;
    this.fs = fs;
    this.limits = limits;
    this.wait = wait;
  }
  async header(header) {
    if (this.ended) {
      if (!allZero(header))
        fail("trailing data");
      this.zeroBlocks += 1;
      return;
    }
    if (allZero(header)) {
      this.ended = true;
      this.zeroBlocks = 1;
      return;
    }
    checksum(header);
    headerIsSafe(header);
    let path;
    try {
      path = canonicalPayloadPath(field(header, 0, 100));
    } catch {
      fail("path");
    }
    const mode = octal(header, 100, 8), size = octal(header, 124, 12), type = String.fromCharCode(header[156] || 48);
    if (++this.entries > this.limits.maxEntries)
      fail("entries");
    if (this.seen.has(path))
      fail("duplicate");
    this.seen.add(path);
    const fileMode = inventory.get(path), directoryMode = directories.get(path);
    if (type === "0" || type === "\x00") {
      if (fileMode === undefined || mode !== fileMode || size > this.limits.maxFileBytes)
        fail("file");
      this.current = { path, mode: fileMode, size, remaining: size, padding: Math.ceil(size / 512) * 512 - size, body: [] };
      if (size === 0) {
        await this.finishFile();
        this.current = undefined;
      }
    } else if (type === "5") {
      if (directoryMode === undefined || mode !== directoryMode || size !== 0)
        fail("type");
      await this.wait(this.fs.mkdirPayloadDirectory(this.root, path, directoryMode));
    } else
      fail("type");
  }
  async finishFile() {
    const current = this.current;
    await this.wait(this.fs.writeFileExclusive(this.root, current.path, pieces(current.body, current.size), current.mode));
  }
  async push(chunk) {
    if ((this.inflated += chunk.length) > this.limits.maxTotalBytes)
      fail("total size");
    this.pending = this.pending.length ? pieces([this.pending, chunk], this.pending.length + chunk.length) : chunk;
    for (;; ) {
      if (this.current) {
        const current = this.current;
        if (current.remaining) {
          if (!this.pending.length)
            return;
          const take = Math.min(current.remaining, this.pending.length);
          current.body.push(this.pending.slice(0, take));
          this.pending = this.pending.slice(take);
          current.remaining -= take;
          if (current.remaining)
            return;
        }
        if (current.padding) {
          if (this.pending.length < current.padding)
            return;
          if (!allZero(this.pending.subarray(0, current.padding)))
            fail("padding");
          this.pending = this.pending.slice(current.padding);
          current.padding = 0;
        }
        await this.finishFile();
        this.current = undefined;
        continue;
      }
      if (this.pending.length < 512)
        return;
      const header = this.pending.slice(0, 512);
      this.pending = this.pending.slice(512);
      await this.header(header);
    }
  }
  finish() {
    if (this.current || this.pending.length)
      fail(this.current ? "truncated body" : "truncated header");
    if (!this.ended || this.zeroBlocks < 2)
      fail("terminal zeros");
    if ([...inventory.keys(), ...directories.keys()].some((path) => !this.seen.has(path)))
      fail("inventory");
  }
}
async function extractArchive(input) {
  if (!input.clock.nowMs)
    fail("clock");
  const started = input.clock.nowMs(), deadline = started + input.limits.timeoutMs;
  let rejectDeadline;
  const expired = new Promise((_, reject) => {
    rejectDeadline = reject;
  });
  const timer = setTimeout(() => rejectDeadline(new Error("timeout")), input.limits.timeoutMs);
  const wait = async (promise) => {
    try {
      const result = await Promise.race([promise, expired]);
      if (input.clock.nowMs() > deadline)
        fail("timeout");
      return result;
    } catch (error) {
      if (error instanceof Error && error.message === "timeout")
        fail("timeout");
      throw error;
    }
  };
  try {
    const inflate = createInflateRaw(), parser = new TarParser(input.stagingRoot, input.fs, input.limits, wait);
    let compressed = 0, header = new Uint8Array, body = false, finished = false, footer = new Uint8Array, crc = 4294967295, size = 0;
    const output = (async () => {
      for await (const chunk of inflate) {
        crc = crc32(crc, chunk);
        size = size + chunk.length >>> 0;
        await parser.push(chunk);
      }
    })();
    output.catch(() => {
      return;
    });
    const write = async (chunk) => {
      if (finished) {
        footer = pieces([footer, chunk], footer.length + chunk.length);
        if (footer.length > 8)
          fail("gzip member");
        return;
      }
      const before = inflate.bytesWritten;
      await wait(new Promise((resolve2, reject) => inflate.write(chunk, (error) => error ? reject(error) : resolve2())));
      const consumed = inflate.bytesWritten - before;
      if (consumed < chunk.length) {
        footer = chunk.slice(consumed);
        finished = true;
        if (footer.length > 8)
          fail("gzip member");
      }
    };
    const writer = (async () => {
      try {
        for await (const chunk of input.archive) {
          compressed += chunk.length;
          if (compressed > MAX_COMPRESSED_BYTES)
            fail("compressed size");
          if (!body) {
            header = pieces([header, chunk], header.length + chunk.length);
            if (header.length > MAX_GZIP_HEADER_BYTES)
              fail("gzip header");
            const length = gzipHeaderLength(header);
            if (length === undefined)
              continue;
            body = true;
            await write(header.slice(length));
            header = new Uint8Array;
          } else
            await write(chunk);
        }
        if (!body || !finished || footer.length !== 8)
          fail("gzip footer");
        await wait(new Promise((resolve2, reject) => inflate.end((error) => error ? reject(error) : resolve2())));
      } catch (error) {
        inflate.destroy(error instanceof Error ? error : new Error("gzip"));
        throw error;
      }
    })();
    try {
      await wait(writer);
      await output;
      if ((crc ^ 4294967295) >>> 0 !== littleEndian(footer, 0) || size !== littleEndian(footer, 4))
        fail("gzip footer");
      parser.finish();
    } catch (error) {
      await output.catch(() => {
        return;
      });
      if (error instanceof Error && error.message.startsWith("E_ARCHIVE_ENTRY"))
        throw error;
      fail("gzip");
    }
  } catch (error) {
    try {
      await input.fs.rm(input.stagingRoot);
    } catch {}
    if (error instanceof Error && error.message.startsWith("E_ARCHIVE_ENTRY"))
      throw error;
    if (error instanceof Error && error.message === "timeout")
      fail("timeout");
    fail("gzip");
  } finally {
    clearTimeout(timer);
  }
}
function validManifest(value) {
  const paths = [...inventory.keys()].filter((path) => path !== "manifest.json").sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  if (!value || Object.keys(value).join("\x00") !== manifestKeys.join("\x00") || value.schemaVersion !== 1 || value.product !== "tmux-pane-dash" || typeof value.version !== "string" || typeof value.target !== "string" || typeof value.asset !== "string" || !Array.isArray(value.files) || value.files.length !== paths.length)
    fail("manifest");
  for (let index = 0;index < paths.length; index += 1) {
    const item = value.files[index], mode = inventory.get(paths[index]).toString(8).padStart(4, "0");
    if (!item || Object.keys(item).join("\x00") !== "mode\x00path\x00sha256\x00size" || item.path !== paths[index] || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.size) || item.size < 0 || item.mode !== mode)
      fail("manifest");
  }
}
async function inspectPayload(root, manifest, deps) {
  validManifest(manifest);
  if (!deps.fs)
    fail("filesystem");
  const found = [];
  const walk = async (base, relative = "") => {
    for (const name of await deps.fs.readdir(base)) {
      const child = relative ? `${relative}/${name}` : name, info = await deps.fs.stat(join2(base, name));
      found.push([child, info.kind, info.mode]);
      if (info.kind === "directory")
        await walk(join2(base, name), child);
    }
  };
  await walk(root);
  if (found.length !== inventory.size + directories.size || found.some(([path, kind, mode]) => inventory.has(path) ? kind !== "file" || mode !== inventory.get(path) : directories.has(path) ? kind !== "directory" || mode !== directories.get(path) : true))
    fail("filesystem inventory");
  for (const [path, mode] of inventory) {
    const info = await deps.fs.stat(join2(root, path)), content = await deps.fs.readFile(join2(root, path));
    if (info.kind !== "file" || info.mode !== mode || info.size !== content.length)
      fail("filesystem metadata");
    if (path !== "manifest.json") {
      const item = manifest.files.find((candidate) => candidate.path === path);
      if (item.size !== content.length || item.sha256 !== createHash2("sha256").update(content).digest("hex"))
        fail("filesystem hash");
    }
  }
}
async function verifyBinary(path, version, deps) {
  if (!deps.spawn)
    throw new Error("E_BINARY_VERSION: unavailable");
  const result = await deps.spawn(path, ["--version"], { timeoutMs: 5000, env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" }, maxOutputBytes: 4096 });
  if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > 4096 || result.code !== 0 || result.stdout !== `pane-dash ${version}
` || result.stderr !== "")
    throw new Error("E_BINARY_VERSION: self check failed");
}
var inventory, directories, text, MAX_COMPRESSED_BYTES, MAX_GZIP_HEADER_BYTES, fail = (reason) => {
  throw new Error(`E_ARCHIVE_ENTRY: ${reason}`);
}, allZero = (value) => value.every((byte) => byte === 0), crcTable, crc32 = (crc, bytes) => {
  let value = crc;
  for (const byte of bytes)
    value = value >>> 8 ^ crcTable[(value ^ byte) & 255];
  return value >>> 0;
}, littleEndian = (bytes, offset) => (bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16 | bytes[offset + 3] << 24) >>> 0, pieces = (chunks, length) => {
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}, manifestKeys;
var init_archive = __esm(() => {
  init_fs();
  inventory = new Map([["bin/pane-dash", 493], ["pane_dash.tmux", 493], ["scripts/open.sh", 493], ["scripts/tag.sh", 493], ["README.md", 420], ["LICENSE", 420], ["VERSION", 420], ["manifest.json", 420]]);
  directories = new Map([["bin", 493], ["scripts", 493]]);
  text = new TextDecoder("utf-8", { fatal: true });
  MAX_COMPRESSED_BYTES = 64 * 1024 * 1024;
  MAX_GZIP_HEADER_BYTES = 64 * 1024;
  crcTable = (() => {
    const table = new Uint32Array(256);
    for (let value = 0;value < 256; value += 1) {
      let crc = value;
      for (let bit = 0;bit < 8; bit += 1)
        crc = crc & 1 ? crc >>> 1 ^ 3988292384 : crc >>> 1;
      table[value] = crc >>> 0;
    }
    return table;
  })();
  manifestKeys = ["asset", "files", "product", "schemaVersion", "target", "version"];
});

// packages/tmux-pane-dash/src/acquire.ts
import { createHash as createHash3 } from "node:crypto";
import { join as join3 } from "node:path";
function fail2(code) {
  throw new CliError(code);
}
function code(error) {
  return error instanceof CliError ? error.code : error instanceof Error ? error.message.split(":", 1)[0] : "";
}
function isMissing(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
function isValidatedCorruption(error) {
  return isMissing(error) || error instanceof SyntaxError || /^(E_ARCHIVE_ENTRY|E_BINARY_VERSION|E_VERSION)/.test(code(error));
}
function initialUrl(record) {
  let parsed;
  try {
    parsed = new URL(record.url);
  } catch {
    fail2("E_DOWNLOAD_URL");
  }
  const expectedPath = `/xiopt/tmux-pane-dash/releases/download/v0.1.0/${record.asset}`;
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port && parsed.port !== "443" || parsed.hostname !== "github.com" || parsed.pathname !== expectedPath || parsed.search || parsed.hash)
    fail2("E_DOWNLOAD_URL");
  const exact = `https://github.com/xiopt/tmux-pane-dash/releases/download/v0.1.0/${record.asset}`;
  const explicit = `https://github.com:443/xiopt/tmux-pane-dash/releases/download/v0.1.0/${record.asset}`;
  if (record.url !== exact && record.url !== explicit)
    fail2("E_DOWNLOAD_URL");
  return record.url;
}
function location(response) {
  if (response.headers instanceof Headers)
    return response.headers.get("location");
  for (const [name, value] of Object.entries(response.headers ?? {}))
    if (name.toLowerCase() === "location")
      return value ?? null;
  return null;
}
function redirectUrl(value) {
  if (!value)
    fail2("E_REDIRECT");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail2("E_REDIRECT");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port && parsed.port !== "443" || parsed.hostname !== "release-assets.githubusercontent.com" || parsed.hash)
    fail2("E_REDIRECT");
  return value;
}
async function* responseBody(source) {
  if (!source)
    fail2("E_DOWNLOAD_BODY");
  if (Symbol.asyncIterator in Object(source)) {
    yield* source;
    return;
  }
  const reader = source.getReader();
  try {
    for (;; ) {
      const part = await reader.read();
      if (part.done)
        return;
      yield part.value;
    }
  } finally {
    reader.releaseLock();
  }
}
async function downloadAsset(record, destination, deps) {
  if (!Number.isSafeInteger(record.size) || record.size < 0 || record.size > MAX)
    fail2("E_ARCHIVE_SIZE");
  if (!deps.fetch)
    fail2("E_DOWNLOAD_FETCH");
  if (!deps.fs)
    fail2("E_DOWNLOAD_FS");
  const controller = new AbortController, fs = deps.fs;
  let rejectAbort;
  const aborted = new Promise((_, reject) => {
    rejectAbort = () => reject(new CliError("E_DOWNLOAD_ABORT"));
  });
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort();
      rejectAbort();
    }
  };
  const timers = deps.timers ?? { setTimeout, clearTimeout };
  const activeTimers = new Set;
  const arm = (milliseconds) => {
    const handle = timers.setTimeout(abort, milliseconds);
    activeTimers.add(handle);
    return handle;
  };
  const clear = (handle) => {
    if (activeTimers.delete(handle))
      timers.clearTimeout(handle);
  };
  const signalOps = deps.signals ?? { on: (signal, callback) => process.once(signal, callback), off: (signal, callback) => process.removeListener(signal, callback) };
  const race = (operation) => Promise.race([operation, aborted]);
  let created = false;
  const registered = [];
  try {
    arm(120000);
    for (const signal of signals) {
      signalOps.on(signal, abort);
      registered.push(signal);
    }
    const request = async (url) => {
      const responseTimer = arm(30000);
      try {
        return await race(deps.fetch(url, { redirect: "manual", signal: controller.signal, headers: emptyHeaders }));
      } finally {
        clear(responseTimer);
      }
    };
    let response = await request(initialUrl(record));
    for (let redirects = 0;response.status >= 300 && response.status < 400; redirects += 1) {
      if (redirects >= 2)
        fail2("E_REDIRECT");
      response = await request(redirectUrl(location(response)));
    }
    if (response.status < 200 || response.status >= 300)
      fail2("E_DOWNLOAD_STATUS");
    const file = await race(fs.openExclusive(destination, 384));
    created = true;
    const hash = createHash3("sha256");
    let size = 0;
    let progress = arm(30000);
    const iterator = responseBody(response.body)[Symbol.asyncIterator]();
    try {
      for (;; ) {
        const next = await race(iterator.next());
        if (next.done)
          break;
        const chunk = next.value;
        if (chunk.length) {
          clear(progress);
          progress = arm(30000);
        }
        size += chunk.length;
        if (size > record.size || size > MAX)
          fail2("E_ARCHIVE_SIZE");
        hash.update(chunk);
        await race(fs.write(file, chunk));
      }
    } finally {
      clear(progress);
      await race(fs.close(file));
    }
    if (size !== record.size || hash.digest("hex") !== record.sha256)
      fail2("E_ARCHIVE_HASH");
  } catch (error) {
    if (created)
      await fs.rm(destination);
    throw error;
  } finally {
    for (const handle of [...activeTimers])
      clear(handle);
    for (const signal of registered)
      signalOps.off(signal, abort);
  }
}
function validateRecord(context) {
  const selected = selectTarget(context.deps.platform, context.deps.arch);
  const expected = { "darwin-arm64": "aarch64-apple-darwin", "darwin-x64": "x86_64-apple-darwin", "linux-arm64": "aarch64-unknown-linux-musl", "linux-x64": "x86_64-unknown-linux-musl" };
  if (context.record.target !== expected[selected] || context.record.asset !== `tmux-pane-dash-v0.1.0-${context.record.target}.tar.gz`)
    fail2("E_PLATFORM");
}
async function validatePayload(root, record, deps, fs) {
  const manifest = JSON.parse(new TextDecoder().decode(await fs.readFile(join3(root, "manifest.json"))));
  await inspectPayload(root, manifest, { ...deps, fs });
  if (manifest.version !== "0.1.0" || manifest.target !== record.target || manifest.asset !== record.asset)
    fail2("E_VERSION");
  await verifyBinary(join3(root, "bin/pane-dash"), manifest.version, deps);
}
async function acquireRelease(context) {
  const fs = context.fs ?? context.deps.fs;
  if (!fs)
    fail2("E_FILESYSTEM");
  validateRecord(context);
  try {
    await validatePayload(context.versionDirectory, context.record, context.deps, fs);
    return { kind: "reused", versionDirectory: context.versionDirectory };
  } catch (error) {
    if (!isValidatedCorruption(error))
      throw error;
  }
  const archive = `${context.stagingRoot}.download.tar.gz`;
  await fs.rm(context.stagingRoot);
  await fs.mkdir(context.stagingRoot);
  try {
    await downloadAsset(context.record, archive, { ...context.deps, fs });
    const bytes = await fs.readFile(archive);
    async function* stream() {
      yield bytes;
    }
    await extractArchive({ archive: stream(), stagingRoot: context.stagingRoot, fs, clock: { nowMs: context.deps.nowMs ?? Date.now }, limits: context.limits ?? archiveLimits });
    await validatePayload(context.stagingRoot, context.record, context.deps, fs);
    return { kind: "staged", versionDirectory: context.stagingRoot };
  } catch (error) {
    await fs.rm(context.stagingRoot);
    throw error;
  } finally {
    await fs.rm(archive);
  }
}
var MAX, signals, emptyHeaders, archiveLimits;
var init_acquire = __esm(() => {
  init_archive();
  init_errors();
  init_platform();
  MAX = 64 * 1024 * 1024;
  signals = ["HUP", "INT", "TERM"];
  emptyHeaders = {};
  archiveLimits = { maxEntries: 64, maxTotalBytes: 268435456, maxFileBytes: 134217728, timeoutMs: 30000 };
});

// packages/tmux-pane-dash/src/config-opencode.ts
import { lstat as lstat2, readdir as readdir2, realpath } from "node:fs/promises";
import { join as join4 } from "node:path";
async function selectOpenCodeConfig(env, deps) {
  const root = env?.XDG_CONFIG_HOME ? join4(env.XDG_CONFIG_HOME, "opencode") : env?.HOME ? join4(env.HOME, ".config", "opencode") : fail3("E_ROOT");
  const json = join4(root, "opencode.json"), jsonc = join4(root, "opencode.jsonc");
  const exists = async (path) => {
    try {
      await lstat2(path);
      return true;
    } catch (error) {
      if (missing2(error))
        return false;
      throw error;
    }
  };
  const [hasJson, hasJsonc] = await Promise.all([exists(json), exists(jsonc)]);
  if (!hasJson && !hasJsonc)
    return json;
  if (hasJson && !hasJsonc)
    return json;
  if (!hasJson && hasJsonc)
    return jsonc;
  const [left, right] = await Promise.all([resolveConfigPath(json, deps), resolveConfigPath(jsonc, deps)]);
  const [leftInfo, rightInfo] = await Promise.all([lstat2(left.resolvedPath), lstat2(right.resolvedPath)]);
  if (!leftInfo.isFile() || !rightInfo.isFile() || leftInfo.dev !== rightInfo.dev || leftInfo.ino !== rightInfo.ino)
    fail3("E_CONFIG_AMBIGUOUS");
  return json;
}
async function planOpenCodeMigration(input) {
  const names = new Set(["pane-dash.ts", "pane-dash.js", "pane_dash.ts", "pane_dash.js"]), candidates = [];
  for (const directory of [join4(input.configDirectory, "plugin"), join4(input.configDirectory, "plugins")]) {
    let entries;
    try {
      entries = await readdir2(directory);
    } catch (error) {
      if (missing2(error))
        continue;
      throw error;
    }
    for (const name of entries)
      if (names.has(name))
        candidates.push(join4(directory, name));
  }
  if (!candidates.length)
    return [];
  if (!input.migrate || candidates.length !== 1)
    fail3("E_CONFIG_CONFLICT");
  const logicalPath = candidates[0], entry = await lstat2(logicalPath);
  if (!entry.isSymbolicLink())
    fail3("E_CONFIG_CONFLICT");
  let resolvedPath, known;
  try {
    [resolvedPath, known] = await Promise.all([realpath(logicalPath), realpath(join4(input.installRoot, "opencode-plugin", "pane-dash.ts"))]);
  } catch {
    fail3("E_CONFIG_CONFLICT");
  }
  if (resolvedPath !== known)
    fail3("E_CONFIG_CONFLICT");
  return [{ logicalPath, resolvedPath, action: "unlink" }];
}
function space(text2, index) {
  for (;; ) {
    while (/\s/.test(text2[index] ?? ""))
      index += 1;
    if (text2.startsWith("//", index)) {
      const end = text2.indexOf(`
`, index + 2);
      index = end < 0 ? text2.length : end + 1;
      continue;
    }
    if (text2.startsWith("/*", index)) {
      const end = text2.indexOf("*/", index + 2);
      if (end < 0)
        fail3();
      index = end + 2;
      continue;
    }
    return index;
  }
}
function stringAt(text2, index) {
  if (text2[index] !== '"')
    fail3();
  const start = index;
  let end = index + 1, escaped = false;
  while (end < text2.length) {
    const char = text2[end++];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      try {
        return { value: JSON.parse(text2.slice(index, end)), start, end };
      } catch {
        fail3();
      }
    }
  }
  fail3();
}
function close(text2, index, open2, endChar) {
  let depth = 0;
  for (;index < text2.length; index += 1) {
    index = space(text2, index);
    if (text2[index] === '"') {
      index = stringAt(text2, index).end - 1;
      continue;
    }
    if (text2[index] === open2)
      depth += 1;
    if (text2[index] === endChar && --depth === 0)
      return index;
  }
  fail3();
}
function rootPlugin(text2) {
  let index = space(text2, 0);
  if (text2[index++] !== "{")
    fail3();
  let plugin = null;
  for (;; ) {
    index = space(text2, index);
    if (text2[index] === "}") {
      if (space(text2, index + 1) !== text2.length)
        fail3();
      return plugin;
    }
    const key = stringAt(text2, index);
    index = space(text2, key.end);
    if (text2[index++] !== ":")
      fail3();
    index = space(text2, index);
    if (key.value === "plugin") {
      if (plugin || text2[index] !== "[")
        fail3();
      const start = index, end = close(text2, index, "[", "]"), entries = [];
      let item = start + 1;
      for (;; ) {
        item = space(text2, item);
        if (text2[item] === "]")
          break;
        const value = stringAt(text2, item);
        item = space(text2, value.end);
        const comma = text2[item] === "," ? item : undefined;
        if (comma !== undefined)
          item += 1;
        else if (text2[item] !== "]")
          fail3();
        entries.push({ ...value, comma });
      }
      plugin = { start, end: end + 1, entries };
      index = end + 1;
    } else {
      if (text2[index] === "[")
        index = close(text2, index, "[", "]") + 1;
      else if (text2[index] === "{")
        index = close(text2, index, "{", "}") + 1;
      else if (text2[index] === '"')
        index = stringAt(text2, index).end;
      else {
        const match = /^(?:true|false|null|-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text2.slice(index));
        if (!match)
          fail3();
        index += match[0].length;
      }
    }
    index = space(text2, index);
    if (text2[index] === ",") {
      index += 1;
      continue;
    }
    if (text2[index] !== "}")
      fail3();
  }
}
function validPaneDash(value) {
  return /^@xiopt\/pane-dash-opencode(?:@[0-9]+\.[0-9]+\.[0-9]+)?$/.test(value) || /pane-dash/i.test(value);
}
function insertionTrivia(text2, plugin) {
  const first = plugin.entries[0];
  if (!first)
    return "";
  const second = plugin.entries[1];
  if (second && first.comma !== undefined)
    return text2.slice(first.comma + 1, second.start).match(/^\s*$/)?.[0] ?? "";
  return text2.slice(plugin.start + 1, first.start).match(/^\s*/)?.[0] ?? "";
}
function insertPlugin(text2, plugin, desired) {
  if (!plugin.entries.length)
    return `${text2.slice(0, plugin.end - 1)}${JSON.stringify(desired)}${text2.slice(plugin.end - 1)}`;
  const entry = plugin.entries[plugin.entries.length - 1];
  if (!entry)
    fail3();
  const insertion = `,${insertionTrivia(text2, plugin)}${JSON.stringify(desired)}`;
  return `${text2.slice(0, entry.end)}${insertion}${text2.slice(entry.end)}`;
}
function planOpenCodeEdit(input) {
  const desired = input.packageEntry ?? "@xiopt/pane-dash-opencode@0.1.0", text2 = decoder.decode(input.bytes), plugin = rootPlugin(text2);
  if (plugin) {
    const managed = plugin.entries.filter((entry) => validPaneDash(entry.value));
    const desiredEntries = managed.filter((entry) => entry.value === desired);
    if (desiredEntries.length === 1 && managed.length === 1)
      return { ...input, bytes: input.bytes };
    if (desiredEntries.length || managed.length > 1)
      fail3("E_CONFIG_CONFLICT");
    if (managed.length === 1) {
      const owned = input.ownedEntries;
      const entry = managed[0];
      if (owned?.length !== 1 || !entry || owned[0] !== entry.value)
        fail3("E_CONFIG_CONFLICT");
      return { ...input, bytes: encoder.encode(`${text2.slice(0, entry.start)}${JSON.stringify(desired)}${text2.slice(entry.end)}`) };
    }
    return { ...input, bytes: encoder.encode(insertPlugin(text2, plugin, desired)) };
  }
  const closeIndex = text2.lastIndexOf("}");
  if (closeIndex < 0)
    fail3();
  const newline = text2.includes(`\r
`) ? `\r
` : `
`, prefix = text2.slice(0, closeIndex), indent = /(?:^|\n)([ \t]+)"/.exec(prefix)?.[1] ?? "  ", comma = /\{\s*$/.test(prefix) ? "" : ",";
  return { ...input, bytes: encoder.encode(`${prefix}${comma}${newline}${indent}"plugin": [${JSON.stringify(desired)}]${newline}${text2.slice(closeIndex)}`) };
}
function planOpenCodeRemoval(input) {
  const text2 = decoder.decode(input.bytes), plugin = rootPlugin(text2), owned = input.ownedEntries;
  if (!plugin || owned?.length !== 1)
    fail3("E_CONFIG_CONFLICT");
  const matches = plugin.entries.filter((entry2) => entry2.value === owned[0]);
  if (matches.length !== 1)
    fail3("E_CONFIG_CONFLICT");
  const entry = matches[0], index = plugin.entries.indexOf(entry);
  let { start, end } = entry;
  if (entry.comma !== undefined)
    end = entry.comma + 1;
  else if (index > 0) {
    const previous = plugin.entries[index - 1];
    start = previous.comma;
  }
  return { ...input, bytes: encoder.encode(`${text2.slice(0, start)}${text2.slice(end)}`) };
}
var encoder, decoder, fail3 = (code2 = "E_CONFIG") => {
  throw new CliError(code2);
}, missing2 = (error) => typeof error === "object" && error !== null && ("code" in error) && error.code === "ENOENT";
var init_config_opencode = __esm(() => {
  init_errors();
  init_fs();
  encoder = new TextEncoder;
  decoder = new TextDecoder;
});

// packages/tmux-pane-dash/src/config-tmux.ts
function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
function tmuxConfigEmbed(shellCommand) {
  if (/[\u0000-\u001f\u007f]/.test(shellCommand))
    throw new CliError("E_CONFIG");
  const literal = `#{l:${shellCommand.replaceAll("#", "##").replaceAll("}", "#}")}}`;
  return `"${literal.replaceAll("\\", "\\\\").replaceAll('"', "\\\"").replaceAll("$", "\\$")}"`;
}
function managedTmuxBlock(installRoot) {
  return `${begin}
run-shell ${tmuxConfigEmbed(shellQuote(`${installRoot}/current/pane_dash.tmux`))}
${end}`;
}
function ownedRange(text2, block) {
  if (text2.includes("tmux-pane-dash (@xiopt/tmux-pane-dash)") && (!text2.includes(begin) || !text2.includes(end)))
    conflict("unsupported tmux-pane-dash marker schema");
  const starts = [], ends = [];
  for (let index = text2.indexOf(begin);index >= 0; index = text2.indexOf(begin, index + begin.length))
    starts.push(index);
  for (let index = text2.indexOf(end);index >= 0; index = text2.indexOf(end, index + end.length))
    ends.push(index);
  if (!starts.length && !ends.length)
    return null;
  if (starts.length !== 1 || ends.length !== 1 || starts[0] > ends[0])
    conflict("malformed tmux-pane-dash markers");
  const start = starts[0], finish = ends[0] + end.length;
  if (text2.slice(start, finish) !== block)
    conflict("altered tmux-pane-dash block");
  return { start, end: finish };
}
function legacyLines(text2, migrate) {
  const lines = text2.split(/(?<=\n)/);
  const retained = [];
  for (const line of lines) {
    const active = line.replace(/^\s*(?:#.*)?$/, "");
    if (!active || !active.includes("pane_dash.tmux") && !active.includes("@pane-dash-engine") && !active.includes("tmux-pane-dash")) {
      retained.push(line);
      continue;
    }
    const exactManual = /^\s*run-shell\s+(['"])[^'"\n]*(?:tmux-pane-dash[^'"\n]*)?\/pane_dash\.tmux\1\s*(?:\r?\n)?$/.test(line);
    const exactEngine = /^\s*set(?:-option)?\s+-g\s+@pane-dash-engine\s+\S+\s*(?:\r?\n)?$/.test(line);
    const exactTpm = /^\s*set\s+-g\s+@plugin\s+['"]xiopt\/tmux-pane-dash['"]\s*(?:\r?\n)?$/.test(line);
    if (!migrate || !(exactManual || exactEngine || exactTpm))
      conflict(`existing configuration at tmux line ${retained.length + 1}`);
  }
  return retained.join("");
}
function planTmuxEdit(input) {
  let text2 = decoder2.decode(input.bytes), block = managedTmuxBlock(input.installRoot);
  const range = ownedRange(text2, block);
  if (range)
    return { ...input, bytes: input.bytes };
  text2 = legacyLines(text2, input.migrate);
  const separator = text2.length && !text2.endsWith(`
`) ? `
` : "";
  return { ...input, bytes: encoder2.encode(`${text2}${separator}${block}`) };
}
function planTmuxRemoval(input) {
  const text2 = decoder2.decode(input.bytes), block = managedTmuxBlock(input.installRoot), range = ownedRange(text2, block);
  if (!range)
    conflict("managed tmux-pane-dash block is missing");
  const before = text2.slice(0, range.start), after = text2.slice(range.end);
  return { ...input, bytes: encoder2.encode(`${before.endsWith(`
`) && !after ? before.slice(0, -1) : before}${after}`) };
}
var encoder2, decoder2, begin = "# >>> tmux-pane-dash (@xiopt/tmux-pane-dash) schema=1 >>>", end = "# <<< tmux-pane-dash (@xiopt/tmux-pane-dash) schema=1 <<<", conflict = (detail = "existing tmux-pane-dash configuration") => {
  throw new CliError("E_CONFIG_CONFLICT", detail);
};
var init_config_tmux = __esm(() => {
  init_errors();
  encoder2 = new TextEncoder;
  decoder2 = new TextDecoder;
});

// packages/tmux-pane-dash/src/ownership.ts
import { lstat as lstat3, mkdir as mkdir2, readFile as readFile2, readlink as readlink2, readdir as readdir3 } from "node:fs/promises";
import { join as join5, resolve as resolve3 } from "node:path";
async function managedRoot(env) {
  const xdg = env?.XDG_DATA_HOME;
  if (xdg)
    return join5(xdg, "tmux-pane-dash");
  if (!env?.HOME)
    fail4("E_ROOT");
  return join5(env.HOME, ".local", "share", "tmux-pane-dash");
}
function inside(root, path) {
  return path === root || path.startsWith(`${root}/`);
}
async function safeDirectory(path, uid) {
  const entry = await lstat3(path);
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== uid || (entry.mode & 18) !== 0)
    fail4("E_CONFLICT");
}
async function validateManagedRoot(root, deps) {
  const canonical = resolve3(root), uid = deps.uid?.() ?? process.getuid?.() ?? 0;
  await safeDirectory(canonical, uid);
  const allowed = new Set(["versions", "state", "transactions", "current"]);
  for (const name of await readdir3(canonical))
    if (!allowed.has(name))
      fail4("E_CONFLICT");
  for (const name of ["versions", "state", "transactions"]) {
    try {
      await safeDirectory(join5(canonical, name), uid);
    } catch (error) {
      if (!missing3(error))
        throw error;
    }
  }
  try {
    const current = join5(canonical, "current"), target = await readlink2(current);
    if (target.startsWith("/") || !target.startsWith("versions/") || target.split("/").some((part) => !part || part === "." || part === "..") || !inside(canonical, resolve3(canonical, target)))
      fail4("E_CONFLICT");
  } catch (error) {
    if (!missing3(error))
      throw error;
  }
  try {
    for (const version of await readdir3(join5(canonical, "versions")))
      await safeDirectory(join5(canonical, "versions", version), uid);
  } catch (error) {
    if (!missing3(error))
      throw error;
  }
}
function validOwnership(value) {
  return value && typeof value === "object" && value.schemaVersion === 1 && typeof value.packageVersion === "string" && typeof value.releaseVersion === "string" && value.archive && typeof value.archive.target === "string" && typeof value.archive.sha256 === "string" && Array.isArray(value.files) && typeof value.currentTarget === "string" && value.components && Array.isArray(value.migrations);
}
async function readOwnership(root, _deps) {
  let bytes;
  try {
    bytes = await readFile2(join5(root, "state", "ownership.json"));
  } catch (error) {
    if (missing3(error))
      return null;
    fail4("E_OWNERSHIP");
  }
  let value;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    fail4("E_OWNERSHIP");
  }
  if (!validOwnership(value))
    fail4("E_OWNERSHIP");
  return value;
}
async function ensureManagedRoot(root) {
  await mkdir2(root, { recursive: true, mode: 448 });
  await mkdir2(join5(root, "versions"), { recursive: true, mode: 448 });
  await mkdir2(join5(root, "state"), { recursive: true, mode: 448 });
  await mkdir2(join5(root, "transactions"), { recursive: true, mode: 448 });
}
var missing3 = (error) => typeof error === "object" && error !== null && ("code" in error) && error.code === "ENOENT", fail4 = (code2) => {
  throw new CliError(code2);
};
var init_ownership = __esm(() => {
  init_errors();
});

// packages/tmux-pane-dash/src/journal.ts
import { mkdir as mkdir3, open as open2, readFile as readFile3, rename as rename2 } from "node:fs/promises";
import { dirname as dirname2, join as join6 } from "node:path";
import { randomBytes as randomBytes2 } from "node:crypto";
function validState(value) {
  return value && ["absent", "file", "directory", "symlink"].includes(value.type) && (value.sha256 === null || typeof value.sha256 === "string") && (value.mode === null || Number.isInteger(value.mode));
}
function valid(value) {
  return value && value.schemaVersion === 1 && typeof value.id === "string" && /^[a-f0-9-]{16,}$/.test(value.id) && ["setup", "update", "uninstall"].includes(value.command) && typeof value.packageVersion === "string" && journalPhases.includes(value.phase) && (value.previousCurrent === null || typeof value.previousCurrent === "string") && value.components && typeof value.components.tmux === "boolean" && typeof value.components.opencode === "boolean" && Array.isArray(value.mutations) && value.mutations.every((m) => m && ["version", "config", "current", "ownership", "tombstone"].includes(m.operation) && typeof m.logicalPath === "string" && typeof m.resolvedPath === "string" && validState(m.pre) && validState(m.post) && (m.preimage === null || typeof m.preimage === "string") && (m.backupPath === undefined || typeof m.backupPath === "string") && (m.symlinkChain === undefined || Array.isArray(m.symlinkChain) && m.symlinkChain.every((link) => link && typeof link.path === "string" && typeof link.target === "string" && Number.isInteger(link.dev) && Number.isInteger(link.ino))) && typeof m.applied === "boolean");
}
function createJournal(input) {
  return { ...input, schemaVersion: 1, phase: "prepared", mutations: [] };
}
async function durableWrite(path, bytes, deps) {
  await mkdir3(dirname2(path), { recursive: true, mode: 448 });
  const temp = join6(dirname2(path), `.${path.split("/").pop()}.${Buffer.from(deps.randomBytes?.(8) ?? randomBytes2(8)).toString("hex")}`);
  const file = await open2(temp, "wx", 384);
  try {
    await file.writeFile(bytes);
    await file.sync();
    deps.journalEvent?.("fsync.file");
  } finally {
    await file.close();
  }
  await rename2(temp, path);
  const parent = await open2(dirname2(path), "r");
  try {
    await parent.sync();
    deps.journalEvent?.("fsync.parent");
  } finally {
    await parent.close();
  }
}
async function persistJournal(journal, deps) {
  if (!valid(journal))
    fail5();
  const root = await managedRoot(deps.env);
  await durableWrite(join6(root, "transactions", journal.id, "journal.json"), new TextEncoder().encode(JSON.stringify(journal)), deps);
}
async function persistPreimage(root, id, path, bytes, deps) {
  await durableWrite(join6(root, "transactions", id, path), bytes, deps);
}
async function readJournal(root, id, _deps) {
  let text2;
  try {
    text2 = await readFile3(join6(root, "transactions", id, "journal.json"), "utf8");
  } catch (error) {
    if (missing4(error))
      return null;
    fail5();
  }
  let value;
  try {
    value = JSON.parse(text2);
  } catch {
    fail5();
  }
  if (!valid(value))
    fail5();
  return value;
}
async function transitionJournal(journal, phase, deps) {
  const from = journalPhases.indexOf(journal.phase), to = journalPhases.indexOf(phase);
  if (to !== from + 1)
    fail5();
  journal.phase = phase;
  await persistJournal(journal, deps);
}
var journalPhases, missing4 = (error) => typeof error === "object" && error !== null && ("code" in error) && error.code === "ENOENT", fail5 = () => {
  throw new CliError("E_JOURNAL");
};
var init_journal = __esm(() => {
  init_errors();
  init_ownership();
  journalPhases = ["prepared", "version_staged", "configs_staged", "current_switched", "configs_committed", "ownership_committed", "complete"];
});

// packages/tmux-pane-dash/src/transaction.ts
import { createHash as createHash4, randomBytes as randomBytes3 } from "node:crypto";
import { chmod as chmod2, lstat as lstat4, mkdir as mkdir4, open as open3, readFile as readFile4, readlink as readlink3, readdir as readdir4, rename as rename3, rm as rm2, symlink } from "node:fs/promises";
import { dirname as dirname3, join as join7 } from "node:path";
async function state(path) {
  try {
    const entry = await lstat4(path);
    if (entry.isSymbolicLink()) {
      const target = await readlink3(path);
      return { type: "symlink", sha256: hash(new TextEncoder().encode(target)), mode: entry.mode & 511, target };
    }
    if (entry.isDirectory())
      return { type: "directory", sha256: null, mode: entry.mode & 511 };
    if (!entry.isFile())
      throw new CliError("E_RECOVERY");
    return { type: "file", sha256: hash(await readFile4(path)), mode: entry.mode & 511 };
  } catch (error) {
    if (missing5(error))
      return absent;
    throw error;
  }
}
function same(left, right) {
  return left.type === right.type && left.sha256 === right.sha256 && left.mode === right.mode && left.target === right.target;
}
function temporary(path, deps, attempt) {
  return join7(dirname3(path), `.${path.split("/").pop()}.${Buffer.from(deps.randomBytes?.(8) ?? randomBytes3(8)).toString("hex")}.${attempt}`);
}
async function syncParent(path) {
  const parent = await open3(dirname3(path), "r");
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}
async function stageBytes(path, bytes, mode, deps) {
  await mkdir4(dirname3(path), { recursive: true, mode: 448 });
  for (let attempt = 0;; attempt += 1) {
    const temp = temporary(path, deps, attempt);
    try {
      const file = await open3(temp, "wx", mode);
      try {
        await file.writeFile(bytes);
        await chmod2(temp, mode);
        await file.sync();
      } finally {
        await file.close();
      }
      return { temp, post: await state(temp) };
    } catch (error) {
      if (error.code !== "EEXIST")
        throw error;
    }
  }
}
async function stageSymlink(path, target, deps) {
  await mkdir4(dirname3(path), { recursive: true, mode: 448 });
  for (let attempt = 0;; attempt += 1) {
    const temp = temporary(path, deps, attempt);
    try {
      await symlink(target, temp);
      return { temp, post: await state(temp) };
    } catch (error) {
      if (error.code !== "EEXIST")
        throw error;
    }
  }
}
async function publish(path, temp, expected) {
  if (!same(await state(path), expected))
    throw new CliError("E_RECOVERY");
  await rename3(temp, path);
  await syncParent(path);
}
function fault(deps, phase, boundary) {
  if (deps.faultPhase?.phase === phase && deps.faultPhase.boundary === boundary)
    throw new Error(`fault:${phase}:${boundary}`);
}
function signal(deps) {
  if (deps.signal)
    throw new CliError(`E_SIGNAL_${deps.signal}`);
}
function crashMutation(deps, operation, occurrence, boundary) {
  if (deps.crashMutation?.operation === operation && deps.crashMutation.occurrence === occurrence && deps.crashMutation.boundary === boundary)
    throw new Error("E_CRASH");
}
async function phase(journal, next, deps) {
  fault(deps, next, "before");
  await transitionJournal(journal, next, deps);
  if (deps.crashPhase === next)
    throw new Error("E_CRASH");
  fault(deps, next, "after");
}
function sameChain(left, right) {
  return left.length === right.length && left.every((link, index) => link.path === right[index]?.path && link.target === right[index]?.target && link.dev === right[index]?.dev && link.ino === right[index]?.ino);
}
async function verifyPlanned(mutation, deps) {
  const expected = mutation.expectedPreimage;
  if (!expected)
    return;
  let resolved;
  try {
    resolved = await resolveConfigPath(mutation.logicalPath, deps);
  } catch {
    throw new CliError("E_RECOVERY");
  }
  if (resolved.resolvedPath !== mutation.resolvedPath || !sameChain(expected.symlinkChain, resolved.symlinkChain) || !same(await state(resolved.resolvedPath), expected.state))
    throw new CliError("E_RECOVERY");
}
async function capture(mutation, root, id, deps) {
  await verifyPlanned(mutation, deps);
  const pre = mutation.expectedPreimage?.state ?? await state(mutation.resolvedPath);
  if (pre.type !== "file")
    return { pre, preimage: null };
  const bytes = mutation.expectedPreimage?.bytes ?? await readFile4(mutation.resolvedPath), preimage = join7("preimages", `${hash(new TextEncoder().encode(mutation.resolvedPath))}.bin`);
  await persistPreimage(root, id, preimage, bytes, deps);
  return { pre, preimage };
}
async function record(journal, mutation, deps) {
  const recorded = { ...mutation, applied: false };
  journal.mutations.push(recorded);
  await persistJournal(journal, deps);
  return recorded;
}
async function markApplied(journal, mutation, deps) {
  mutation.applied = true;
  await persistJournal(journal, deps);
}
async function reverse(mutation, root, journalId, deps) {
  const current = await state(mutation.resolvedPath);
  if (same(current, mutation.pre))
    return;
  if (!same(current, mutation.post))
    throw new CliError("E_RECOVERY");
  if (mutation.pre.type === "absent") {
    await rm2(mutation.resolvedPath, { recursive: true, force: true });
    await syncParent(mutation.resolvedPath);
    return;
  }
  if (mutation.pre.type === "directory" && mutation.backupPath) {
    if (!same(await state(mutation.backupPath), mutation.pre))
      throw new CliError("E_RECOVERY");
    await rename3(mutation.backupPath, mutation.resolvedPath);
    await syncParent(mutation.resolvedPath);
    return;
  }
  if (mutation.pre.type === "symlink") {
    await rm2(mutation.resolvedPath, { force: true });
    await symlink(mutation.pre.target, mutation.resolvedPath);
    await syncParent(mutation.resolvedPath);
    return;
  }
  if (mutation.pre.type === "file" && mutation.preimage) {
    const staged = await stageBytes(mutation.resolvedPath, await readFile4(join7(root, "transactions", journalId, mutation.preimage)), mutation.pre.mode, deps);
    await publish(mutation.resolvedPath, staged.temp, mutation.post);
    return;
  }
  throw new CliError("E_RECOVERY");
}
async function rollback(journal, deps) {
  const root = await managedRoot(deps.env);
  for (const mutation of [...journal.mutations].reverse())
    await reverse(mutation, root, journal.id, deps);
}
async function recoverIncomplete(root, deps) {
  let ids;
  try {
    ids = await readdir4(join7(root, "transactions"));
  } catch (error) {
    if (missing5(error))
      return;
    throw error;
  }
  for (const id of ids) {
    if (id === "lock")
      continue;
    const journal = await readJournal(root, id, deps);
    if (journal && journal.phase !== "complete") {
      await rollback(journal, deps);
      await rm2(join7(root, "transactions", id), { recursive: true, force: true });
    }
  }
}
async function mutate(journal, mutation, temp, occurrence, deps, expectedConfig) {
  const recorded = await record(journal, mutation, deps);
  crashMutation(deps, mutation.operation, occurrence, "intent");
  if (expectedConfig)
    await verifyPlanned(expectedConfig, deps);
  await publish(mutation.resolvedPath, temp, mutation.pre);
  crashMutation(deps, mutation.operation, occurrence, "published");
  await markApplied(journal, recorded, deps);
  crashMutation(deps, mutation.operation, occurrence, "applied");
}
async function removeMutation(journal, mutation, occurrence, deps) {
  const recorded = await record(journal, mutation, deps);
  crashMutation(deps, mutation.operation, occurrence, "intent");
  if (!same(await state(mutation.resolvedPath), mutation.pre))
    throw new CliError("E_RECOVERY");
  await rm2(mutation.resolvedPath, { recursive: false, force: true });
  await syncParent(mutation.resolvedPath);
  crashMutation(deps, mutation.operation, occurrence, "published");
  await markApplied(journal, recorded, deps);
  crashMutation(deps, mutation.operation, occurrence, "applied");
}
async function moveMutation(journal, mutation, from, occurrence, deps) {
  const recorded = await record(journal, mutation, deps);
  crashMutation(deps, mutation.operation, occurrence, "intent");
  if (!same(await state(mutation.resolvedPath), mutation.pre))
    throw new CliError("E_RECOVERY");
  await rename3(from, mutation.resolvedPath);
  await syncParent(mutation.resolvedPath);
  crashMutation(deps, mutation.operation, occurrence, "published");
  await markApplied(journal, recorded, deps);
  crashMutation(deps, mutation.operation, occurrence, "applied");
}
async function tombstoneMutation(journal, mutation, occurrence, deps) {
  const recorded = await record(journal, mutation, deps);
  crashMutation(deps, "current", occurrence, "intent");
  if (!same(await state(mutation.resolvedPath), mutation.pre) || !mutation.backupPath)
    throw new CliError("E_RECOVERY");
  await rename3(mutation.resolvedPath, mutation.backupPath);
  await syncParent(mutation.resolvedPath);
  crashMutation(deps, "current", occurrence, "published");
  await markApplied(journal, recorded, deps);
  crashMutation(deps, "current", occurrence, "applied");
}
async function executeTransaction(plan, deps) {
  const root = await managedRoot(deps.env);
  await ensureManagedRoot(root);
  await recoverIncomplete(root, deps);
  signal(deps);
  const id = Buffer.from(deps.randomBytes?.(16) ?? randomBytes3(16)).toString("hex"), journal = createJournal({ id, command: plan.command, packageVersion: deps.executingVersion, previousCurrent: plan.previousCurrent, components: plan.components });
  await persistJournal(journal, deps);
  try {
    fault(deps, "prepared", "before");
    if (deps.crashPhase === "prepared")
      throw new Error("E_CRASH");
    fault(deps, "prepared", "after");
    const staged = await Promise.all(plan.configMutations.map(async (mutation) => ({ mutation, ...await capture(mutation, root, id, deps) })));
    const version = join7(root, "versions", plan.desiredVersion);
    if (plan.uninstall?.tombstoneVersions) {
      const tombstone = join7(root, "transactions", id, "tombstone", "versions"), source = join7(root, "versions"), pre = await state(source);
      if (pre.type !== "directory")
        throw new CliError("E_OWNERSHIP");
      await mkdir4(dirname3(tombstone), { recursive: true, mode: 448 });
      await tombstoneMutation(journal, { operation: "tombstone", logicalPath: source, resolvedPath: source, pre, post: absent, preimage: null, backupPath: tombstone }, 1, deps);
    } else if (plan.versionActivation) {
      const pre = await state(version);
      if (pre.type !== "absent")
        throw new CliError("E_RECOVERY");
      await moveMutation(journal, { operation: "version", logicalPath: version, resolvedPath: version, pre, post: await state(plan.versionActivation.stagingPath), preimage: null }, plan.versionActivation.stagingPath, 1, deps);
    } else if (plan.command !== "uninstall")
      await mkdir4(version, { recursive: true, mode: 448 });
    await phase(journal, "version_staged", deps);
    signal(deps);
    await phase(journal, "configs_staged", deps);
    const current = join7(root, "current"), currentPre = await state(current), target = `versions/${plan.desiredVersion}`;
    if (plan.uninstall?.removeCurrent)
      await removeMutation(journal, { operation: "current", logicalPath: current, resolvedPath: current, pre: currentPre, post: absent, preimage: null }, 1, deps);
    else {
      const stagedCurrent = await stageSymlink(current, target, deps);
      await mutate(journal, { operation: "current", logicalPath: current, resolvedPath: current, pre: currentPre, post: stagedCurrent.post, preimage: null }, stagedCurrent.temp, 1, deps);
    }
    await phase(journal, "current_switched", deps);
    for (const [index, item] of staged.entries()) {
      const stagedFile = await stageBytes(item.mutation.resolvedPath, item.mutation.bytes, item.mutation.mode ?? (item.pre.mode ?? 384), deps);
      await mutate(journal, { operation: "config", logicalPath: item.mutation.logicalPath, resolvedPath: item.mutation.resolvedPath, pre: item.pre, post: stagedFile.post, preimage: item.preimage, symlinkChain: item.mutation.expectedPreimage?.symlinkChain }, stagedFile.temp, index + 1, deps, item.mutation);
    }
    for (const [index, item] of (plan.migrationUnlinks ?? []).entries()) {
      const pre = await state(item.logicalPath);
      if (pre.type !== "symlink")
        throw new CliError("E_CONFIG_CONFLICT");
      await removeMutation(journal, { operation: "config", logicalPath: item.logicalPath, resolvedPath: item.logicalPath, pre, post: absent, preimage: null }, staged.length + index + 1, deps);
    }
    if (deps.collisionAfterMutation && journal.mutations.length) {
      await rm2(journal.mutations.at(-1).resolvedPath, { force: true });
      throw new CliError("E_RECOVERY");
    }
    await phase(journal, "configs_committed", deps);
    signal(deps);
    const ownershipPath = join7(root, "state", "ownership.json"), ownershipCapture = await capture({ logicalPath: ownershipPath, resolvedPath: ownershipPath, bytes: new Uint8Array }, root, id, deps);
    if (plan.uninstall?.removeOwnership)
      await removeMutation(journal, { operation: "ownership", logicalPath: ownershipPath, resolvedPath: ownershipPath, pre: ownershipCapture.pre, post: absent, preimage: ownershipCapture.preimage }, 1, deps);
    else {
      const ownership = plan.ownership ?? { schemaVersion: 1, packageVersion: deps.executingVersion, releaseVersion: plan.desiredVersion, archive: { target: "", sha256: "" }, files: [], currentTarget: target, components: { tmux: null, opencode: null }, migrations: [] }, stagedOwnership = await stageBytes(ownershipPath, new TextEncoder().encode(JSON.stringify(ownership)), 384, deps);
      await mutate(journal, { operation: "ownership", logicalPath: ownershipPath, resolvedPath: ownershipPath, pre: ownershipCapture.pre, post: stagedOwnership.post, preimage: ownershipCapture.preimage }, stagedOwnership.temp, 1, deps);
    }
    await phase(journal, "ownership_committed", deps);
    await phase(journal, "complete", deps);
    await rm2(join7(root, "transactions", id), { recursive: true, force: true });
  } catch (error) {
    if (error instanceof Error && error.message === "E_CRASH")
      throw error;
    try {
      await rollback(journal, deps);
      await rm2(join7(root, "transactions", id), { recursive: true, force: true });
    } catch (rollbackError) {
      throw rollbackError;
    }
    throw error;
  }
}
var missing5 = (error) => typeof error === "object" && error !== null && ("code" in error) && error.code === "ENOENT", hash = (bytes) => createHash4("sha256").update(bytes).digest("hex"), absent;
var init_transaction = __esm(() => {
  init_errors();
  init_fs();
  init_journal();
  init_ownership();
  absent = { type: "absent", sha256: null, mode: null };
});

// packages/tmux-pane-dash/src/commands/setup.ts
var exports_setup = {};
__export(exports_setup, {
  setup: () => setup,
  inventoryConflicts: () => inventoryConflicts
});
import { createHash as createHash5, randomBytes as randomBytes4 } from "node:crypto";
import { lstat as lstat5, readFile as readFile5 } from "node:fs/promises";
import { dirname as dirname4, join as join8 } from "node:path";
async function readOr(path, fallback) {
  try {
    return new Uint8Array(await readFile5(path));
  } catch (error) {
    if (missing6(error))
      return encoder3.encode(fallback);
    throw error;
  }
}
async function exists(path) {
  try {
    await lstat5(path);
    return true;
  } catch (error) {
    if (missing6(error))
      return false;
    throw error;
  }
}
function planned(mutation, resolved, bytes) {
  return { ...mutation, expectedPreimage: { state: resolved.preimageHash ? { type: "file", sha256: resolved.preimageHash, mode: resolved.mode ?? 384 } : { type: "absent", sha256: null, mode: null }, ...resolved.preimageHash ? { bytes } : {}, symlinkChain: resolved.symlinkChain } };
}
async function inventoryConflicts(input, deps) {
  const root = await managedRoot(deps.env);
  let tmux = null, opencode = null, migrations = [];
  if (input.tmux) {
    if (!deps.env?.HOME)
      throw new CliError("E_ROOT");
    const resolved = await resolveConfigPath(join8(deps.env.HOME, ".tmux.conf"), deps);
    const bytes = await readOr(resolved.resolvedPath, "");
    tmux = planned(planTmuxEdit({ ...resolved, bytes, mode: resolved.mode ?? 384, installRoot: root, migrate: input.migrate }), resolved, bytes);
  }
  if (input.opencode) {
    const logicalPath = await selectOpenCodeConfig(deps.env, deps), resolved = await resolveConfigPath(logicalPath, deps);
    const bytes = await readOr(resolved.resolvedPath, `{}
`);
    opencode = planned(planOpenCodeEdit({ ...resolved, bytes, mode: resolved.mode ?? 384, migrate: input.migrate, packageEntry: input.packageEntry, ownedEntries: input.ownedOpenCodeEntries }), resolved, bytes);
    migrations = await planOpenCodeMigration({ configDirectory: dirname4(logicalPath), installRoot: root, migrate: input.migrate });
  }
  return { tmux, opencode, migrations };
}
function owned(path, marker, packageEntries = []) {
  return { logicalPath: path.logicalPath, resolvedPath: path.resolvedPath, marker, packageEntries, baselineBackup: { logicalPath: path.logicalPath, sha256: digest2(path.bytes) } };
}
async function files(directory) {
  const raw = JSON.parse(await readFile5(join8(directory, "manifest.json"), "utf8"));
  return raw.files.map((file) => ({ logicalPath: join8(directory, file.path), resolvedPath: join8(directory, file.path), sha256: file.sha256, mode: Number.parseInt(file.mode, 8), type: "file" }));
}
async function setup(command, deps) {
  const root = await managedRoot(deps.env);
  if (await exists(root))
    await validateManagedRoot(root, deps);
  const prior = await readOwnership(root, deps);
  if (prior)
    assertDowngradeAllowed({ command, executingVersion: deps.executingVersion, ownedVersion: prior.releaseVersion });
  const record2 = selectRelease(parseReleaseManifest(deps.manifest), deps.platform, deps.arch);
  const packageEntry = `@xiopt/pane-dash-opencode@${deps.executingVersion}`, inventory2 = await inventoryConflicts({ ...command, packageEntry, ownedOpenCodeEntries: prior?.components.opencode?.packageEntries }, deps);
  await ensureManagedRoot(root);
  const staging = join8(root, "transactions", `payload-${Buffer.from(deps.randomBytes?.(8) ?? randomBytes4(8)).toString("hex")}`);
  const acquired = await acquireRelease({ versionDirectory: join8(root, "versions", deps.executingVersion), stagingRoot: staging, record: record2, deps });
  const payload = await files(acquired.versionDirectory), currentTarget = `versions/${deps.executingVersion}`;
  const ownership = { schemaVersion: 1, packageVersion: deps.executingVersion, releaseVersion: deps.executingVersion, archive: { target: record2.target, sha256: record2.sha256 }, files: payload, currentTarget, components: {
    tmux: inventory2.tmux ? owned(inventory2.tmux, managedTmuxBlock(root)) : prior?.components.tmux ?? null,
    opencode: inventory2.opencode ? owned(inventory2.opencode, packageEntry, [packageEntry]) : prior?.components.opencode ?? null
  }, migrations: inventory2.migrations.map((item) => ({ from: item.logicalPath, to: item.resolvedPath, sha256: "" })) };
  await executeTransaction({ command: "setup", components: { tmux: command.tmux, opencode: command.opencode }, desiredVersion: deps.executingVersion, previousCurrent: prior?.currentTarget ?? null, configMutations: [inventory2.tmux, inventory2.opencode].filter((item) => item !== null), migrationUnlinks: inventory2.migrations, ownership, ...acquired.kind === "staged" ? { versionActivation: { stagingPath: acquired.versionDirectory } } : {} }, deps);
}
var encoder3, digest2 = (value) => createHash5("sha256").update(value).digest("hex"), missing6 = (error) => typeof error === "object" && error !== null && ("code" in error) && error.code === "ENOENT";
var init_setup = __esm(() => {
  init_acquire();
  init_config_opencode();
  init_config_tmux();
  init_errors();
  init_fs();
  init_manifest();
  init_ownership();
  init_runtime();
  init_transaction();
  encoder3 = new TextEncoder;
});

// packages/tmux-pane-dash/src/commands/update.ts
var exports_update = {};
__export(exports_update, {
  update: () => update
});
import { readlink as readlink4 } from "node:fs/promises";
import { join as join9 } from "node:path";
async function update(deps) {
  const root = await managedRoot(deps.env);
  try {
    await validateManagedRoot(root, deps);
  } catch (error) {
    if (error.code === "ENOENT")
      throw new CliError("E_USAGE", "no installation; run setup");
    throw error;
  }
  const ownership = await readOwnership(root, deps);
  if (!ownership)
    throw new CliError("E_USAGE", "no installation; run setup");
  try {
    if (await readlink4(join9(root, "current")) !== ownership.currentTarget)
      throw new CliError("E_OWNERSHIP", "owned current target changed");
  } catch (error) {
    if (error instanceof CliError)
      throw error;
    throw new CliError("E_OWNERSHIP", "owned current target changed");
  }
  assertDowngradeAllowed({ command: { name: "update" }, executingVersion: deps.executingVersion, ownedVersion: ownership.releaseVersion });
  await setup({ name: "setup", tmux: ownership.components.tmux !== null, opencode: ownership.components.opencode !== null, migrate: false, allowDowngrade: false }, deps);
}
var init_update = __esm(() => {
  init_errors();
  init_ownership();
  init_runtime();
  init_setup();
});

// packages/tmux-pane-dash/src/commands/uninstall.ts
var exports_uninstall = {};
__export(exports_uninstall, {
  uninstall: () => uninstall
});
import { createHash as createHash6 } from "node:crypto";
import { readFile as readFile6, readlink as readlink5 } from "node:fs/promises";
import { join as join10 } from "node:path";
async function bytes(path) {
  return new Uint8Array(await readFile6(path));
}
function planned2(mutation, resolved, content) {
  return { ...mutation, expectedPreimage: { state: { type: "file", sha256: digest3(content), mode: resolved.mode ?? 384 }, bytes: content, symlinkChain: resolved.symlinkChain } };
}
async function uninstall(deps) {
  const root = await managedRoot(deps.env);
  try {
    await validateManagedRoot(root, deps);
  } catch (error) {
    if (missing7(error))
      return;
    throw error;
  }
  const ownership = await readOwnership(root, deps);
  if (!ownership) {
    if (deps.env?.HOME)
      try {
        if ((await readFile6(join10(deps.env.HOME, ".tmux.conf"), "utf8")).includes("# >>> tmux-pane-dash (@xiopt/tmux-pane-dash) schema=1 >>>"))
          throw new CliError("E_OWNERSHIP", "managed marker requires manual review");
      } catch (error) {
        if (!missing7(error))
          throw error;
      }
    return;
  }
  try {
    if (await readlink5(join10(root, "current")) !== ownership.currentTarget)
      throw new CliError("E_OWNERSHIP", "owned current target changed");
  } catch (error) {
    if (error instanceof CliError)
      throw error;
    throw new CliError("E_OWNERSHIP", "owned current target changed");
  }
  for (const file of ownership.files) {
    const content = await bytes(file.resolvedPath);
    if (digest3(content) !== file.sha256)
      throw new CliError("E_OWNERSHIP", "owned payload changed");
  }
  const edits = [];
  if (ownership.components.tmux) {
    const item = ownership.components.tmux, resolved = await resolveConfigPath(item.logicalPath, deps), content = await bytes(resolved.resolvedPath);
    edits.push(planned2(planTmuxRemoval({ ...resolved, bytes: content, installRoot: root, mode: resolved.mode ?? 384 }), resolved, content));
  }
  if (ownership.components.opencode) {
    const item = ownership.components.opencode, resolved = await resolveConfigPath(item.logicalPath, deps), content = await bytes(resolved.resolvedPath);
    edits.push(planned2(planOpenCodeRemoval({ ...resolved, bytes: content, ownedEntries: item.packageEntries, mode: resolved.mode ?? 384 }), resolved, content));
  }
  await executeTransaction({ command: "uninstall", components: { tmux: ownership.components.tmux !== null, opencode: ownership.components.opencode !== null }, desiredVersion: ownership.releaseVersion, previousCurrent: ownership.currentTarget, configMutations: edits, uninstall: { tombstoneVersions: true, removeCurrent: true, removeOwnership: true } }, deps);
}
var missing7 = (error) => typeof error === "object" && error !== null && ("code" in error) && error.code === "ENOENT", digest3 = (value) => createHash6("sha256").update(value).digest("hex");
var init_uninstall = __esm(() => {
  init_config_opencode();
  init_config_tmux();
  init_errors();
  init_fs();
  init_ownership();
  init_transaction();
});

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
  if (command.name === "doctor")
    return 0;
  if (command.name === "setup") {
    const manifest = parseReleaseManifest(deps.manifest);
    selectRelease(manifest, deps.platform, deps.arch);
  }
  await deps.lock?.();
  if (command.name === "setup")
    await (await Promise.resolve().then(() => (init_setup(), exports_setup))).setup(command, deps);
  else if (command.name === "update")
    await (await Promise.resolve().then(() => (init_update(), exports_update))).update(deps);
  else
    await (await Promise.resolve().then(() => (init_uninstall(), exports_uninstall))).uninstall(deps);
  return 0;
}
var init_runtime = __esm(() => {
  init_args();
  init_errors();
  init_manifest();
});
init_runtime();

export {
  runCli,
  compareVersions,
  assertDowngradeAllowed
};
