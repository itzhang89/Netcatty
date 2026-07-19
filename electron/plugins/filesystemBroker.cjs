"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const { PluginRpcError, RPC_ERRORS } = require("./rpcRouter.cjs");

const MAX_FILESYSTEM_BYTES = 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 1_000;
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

function invalidArgument(message) {
  return new PluginRpcError(RPC_ERRORS.invalidArgument, message);
}

function assertAbsolutePath(value) {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 8_192
    || value.includes("\0")
    || !path.isAbsolute(value)
  ) {
    throw invalidArgument("Plugin filesystem path must be absolute");
  }
  return path.normalize(value);
}

function assertReadParams(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw invalidArgument("Plugin filesystem read parameters are invalid");
  }
  const encoding = params.encoding ?? "utf8";
  if (encoding !== "utf8" && encoding !== "base64") {
    throw invalidArgument("Plugin filesystem read encoding is invalid");
  }
  const maxBytes = params.maxBytes ?? MAX_FILESYSTEM_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_FILESYSTEM_BYTES) {
    throw invalidArgument("Plugin filesystem read limit is invalid");
  }
  return { path: assertAbsolutePath(params.path), encoding, maxBytes };
}

function decodeWriteData(params) {
  const encoding = params.encoding ?? "utf8";
  if (encoding !== "utf8" && encoding !== "base64") {
    throw invalidArgument("Plugin filesystem write encoding is invalid");
  }
  if (typeof params.data !== "string") throw invalidArgument("Plugin filesystem write data is invalid");
  const bytes = Buffer.from(params.data, encoding);
  if (encoding === "base64" && bytes.toString("base64") !== params.data) {
    throw invalidArgument("Plugin filesystem base64 data is not canonical");
  }
  if (bytes.byteLength > MAX_FILESYSTEM_BYTES) {
    throw new PluginRpcError(RPC_ERRORS.resourceExhausted, "Plugin filesystem write is too large");
  }
  return { encoding, bytes };
}

function assertWriteParams(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw invalidArgument("Plugin filesystem write parameters are invalid");
  }
  const { encoding, bytes } = decodeWriteData(params);
  if (params.overwrite !== undefined && typeof params.overwrite !== "boolean") {
    throw invalidArgument("Plugin filesystem overwrite flag is invalid");
  }
  return {
    path: assertAbsolutePath(params.path),
    encoding,
    bytes,
    overwrite: params.overwrite === true,
  };
}

function assertPathParams(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw invalidArgument("Plugin filesystem parameters are invalid");
  }
  return { path: assertAbsolutePath(params.path) };
}

async function resolveExistingPath(requestedPath) {
  const canonical = await fsp.realpath(requestedPath);
  const stats = await fsp.lstat(canonical);
  if (stats.isSymbolicLink()) throw invalidArgument("Plugin filesystem path cannot resolve to a symbolic link");
  return { canonical, stats };
}

async function resolveWritePath(requestedPath) {
  try {
    const existing = await resolveExistingPath(requestedPath);
    if (!existing.stats.isFile()) throw invalidArgument("Plugin filesystem write target is not a file");
    return existing.canonical;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const parent = await fsp.realpath(path.dirname(requestedPath));
  const parentStats = await fsp.lstat(parent);
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
    throw invalidArgument("Plugin filesystem write parent is not a real directory");
  }
  return path.join(parent, path.basename(requestedPath));
}

function entryKind(entry) {
  if (entry.isFile()) return "file";
  if (entry.isDirectory()) return "directory";
  return "other";
}

async function readBoundedFileHandle(handle, maxBytes) {
  const chunks = [];
  let total = 0;
  while (total <= maxBytes) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, (maxBytes + 1) - total));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    total += bytesRead;
  }
  if (total > maxBytes) {
    throw new PluginRpcError(RPC_ERRORS.resourceExhausted, "Plugin filesystem file changed or is too large");
  }
  return Buffer.concat(chunks, total);
}

function assertAuthorizedPath(context, permission, canonical) {
  const authorization = context?.authorization;
  if (
    authorization?.permission !== permission
    || !Array.isArray(authorization.resources)
    || authorization.resources.length !== 1
    || authorization.resources[0] !== canonical
  ) {
    throw new PluginRpcError(
      RPC_ERRORS.permissionDenied,
      "Plugin filesystem path changed after authorization",
    );
  }
  return canonical;
}

function assertSameOpenedFile(openedStats, pathStats) {
  if (
    !openedStats.isFile()
    || !pathStats.isFile()
    || openedStats.dev !== pathStats.dev
    || openedStats.ino !== pathStats.ino
  ) {
    throw new PluginRpcError(
      RPC_ERRORS.permissionDenied,
      "Plugin filesystem target changed after it was opened",
    );
  }
}

class PluginFilesystemBroker {
  constructor(options = {}) {
    this.quotaManager = options.quotaManager ?? null;
  }

  validateRead(params) { return assertReadParams(params); }
  validateWrite(params) {
    const value = assertWriteParams(params);
    return {
      path: value.path,
      encoding: value.encoding,
      data: value.bytes.toString(value.encoding),
      overwrite: value.overwrite,
    };
  }
  validatePath(params) { return assertPathParams(params); }

  async describeReadAuthorization(params) {
    const value = assertReadParams(params);
    const { canonical } = await resolveExistingPath(value.path);
    return {
      permission: "filesystem.read",
      resources: [canonical],
      reason: `Read ${canonical}`,
      operationId: `filesystem.read:${canonical}`,
    };
  }

  async describeWriteAuthorization(params) {
    const value = assertWriteParams(params);
    const canonical = await resolveWritePath(value.path);
    return {
      permission: "filesystem.write",
      resources: [canonical],
      reason: `Write ${canonical}`,
      operationId: `filesystem.write:${canonical}`,
    };
  }

  async readFile(params, context) {
    const value = assertReadParams(params);
    const { canonical, stats } = await resolveExistingPath(value.path);
    assertAuthorizedPath(context, "filesystem.read", canonical);
    if (!stats.isFile()) throw invalidArgument("Plugin filesystem read target is not a file");
    if (stats.size > value.maxBytes) {
      throw new PluginRpcError(RPC_ERRORS.resourceExhausted, "Plugin filesystem file is too large");
    }
    const handle = await fsp.open(canonical, fs.constants.O_RDONLY | NOFOLLOW);
    try {
      const openedStats = await handle.stat();
      if (!openedStats.isFile() || openedStats.size > value.maxBytes) {
        throw new PluginRpcError(RPC_ERRORS.resourceExhausted, "Plugin filesystem file changed or is too large");
      }
      assertAuthorizedPath(context, "filesystem.read", await fsp.realpath(canonical));
      const bytes = await readBoundedFileHandle(handle, value.maxBytes);
      this.quotaManager?.chargeBytes(context.runtimeId, "filesystem", bytes.byteLength);
      await context.assertActive();
      return { data: bytes.toString(value.encoding) };
    } finally {
      await handle.close();
    }
  }

  async writeFile(params, context) {
    const value = assertWriteParams(params);
    const canonical = await resolveWritePath(value.path);
    assertAuthorizedPath(context, "filesystem.write", canonical);
    this.quotaManager?.chargeBytes(context.runtimeId, "filesystem", value.bytes.byteLength);
    await context.assertActive();
    const flags = fs.constants.O_WRONLY
      | fs.constants.O_CREAT
      | NOFOLLOW
      | (value.overwrite ? 0 : fs.constants.O_EXCL);
    const handle = await fsp.open(canonical, flags, 0o600);
    try {
      assertAuthorizedPath(context, "filesystem.write", await fsp.realpath(canonical));
      const [openedStats, pathStats] = await Promise.all([handle.stat(), fsp.stat(canonical)]);
      assertSameOpenedFile(openedStats, pathStats);
      if (value.overwrite) await handle.truncate(0);
      await handle.writeFile(value.bytes);
      await handle.sync();
      await context.assertActive();
    } finally {
      await handle.close();
    }
    return null;
  }

  async stat(params, context) {
    const value = assertPathParams(params);
    const { canonical, stats } = await resolveExistingPath(value.path);
    assertAuthorizedPath(context, "filesystem.read", canonical);
    await context.assertActive();
    return {
      kind: stats.isFile() ? "file" : stats.isDirectory() ? "directory" : "other",
      size: Math.min(Number.MAX_SAFE_INTEGER, Number(stats.size)),
      modifiedAt: Math.max(0, Math.trunc(stats.mtimeMs)),
    };
  }

  async readDirectory(params, context) {
    const value = assertPathParams(params);
    const { canonical, stats } = await resolveExistingPath(value.path);
    assertAuthorizedPath(context, "filesystem.read", canonical);
    if (!stats.isDirectory()) throw invalidArgument("Plugin filesystem directory target is not a directory");
    const entries = await fsp.readdir(canonical, { withFileTypes: true });
    if (entries.length > MAX_DIRECTORY_ENTRIES) {
      throw new PluginRpcError(RPC_ERRORS.resourceExhausted, "Plugin filesystem directory has too many entries");
    }
    await context.assertActive();
    return {
      entries: entries
        .map((entry) => ({ name: entry.name, kind: entryKind(entry) }))
        .sort((left, right) => left.name.localeCompare(right.name, "en")),
    };
  }
}

module.exports = {
  MAX_DIRECTORY_ENTRIES,
  MAX_FILESYSTEM_BYTES,
  PluginFilesystemBroker,
  assertAbsolutePath,
  assertAuthorizedPath,
  assertSameOpenedFile,
  assertPathParams,
  assertReadParams,
  assertWriteParams,
  resolveExistingPath,
  resolveWritePath,
  readBoundedFileHandle,
};
