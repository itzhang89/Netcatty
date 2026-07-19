"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { PluginFilesystemBroker, MAX_FILESYSTEM_BYTES } = require("./filesystemBroker.cjs");
const { RPC_ERRORS } = require("./rpcRouter.cjs");

function createRoot(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-filesystem-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function runtimeContext(authorization) {
  return {
    runtimeId: "runtime-1",
    authorization,
    assertActive: async () => {},
  };
}

test("filesystem broker uses canonical authorization for bounded read, write, stat, and list", async (context) => {
  const root = createRoot(context);
  const source = path.join(root, "source.txt");
  const target = path.join(root, "target.txt");
  await fsp.writeFile(source, "hello");
  const charges = [];
  const broker = new PluginFilesystemBroker({
    quotaManager: { chargeBytes: (...args) => charges.push(args) },
  });

  const readAuthorization = await broker.describeReadAuthorization({ path: source });
  assert.deepEqual(
    await broker.readFile({ path: source }, runtimeContext(readAuthorization)),
    { data: "hello" },
  );
  assert.equal((await broker.stat({ path: source }, runtimeContext(readAuthorization))).kind, "file");

  const writeAuthorization = await broker.describeWriteAuthorization({ path: target, data: "world" });
  await broker.writeFile({ path: target, data: "world" }, runtimeContext(writeAuthorization));
  assert.equal(await fsp.readFile(target, "utf8"), "world");
  const overwriteAuthorization = await broker.describeWriteAuthorization({
    path: target,
    data: "short",
    overwrite: true,
  });
  await broker.writeFile(
    { path: target, data: "short", overwrite: true },
    runtimeContext(overwriteAuthorization),
  );
  assert.equal(await fsp.readFile(target, "utf8"), "short");

  const listAuthorization = await broker.describeReadAuthorization({ path: root });
  const list = await broker.readDirectory({ path: root }, runtimeContext(listAuthorization));
  assert.deepEqual(list.entries.map(({ name }) => name), ["source.txt", "target.txt"]);
  assert.deepEqual(charges, [
    ["runtime-1", "filesystem", 5],
    ["runtime-1", "filesystem", 5],
    ["runtime-1", "filesystem", 5],
  ]);
});

test("filesystem write quota is enforced before creating the target", async (context) => {
  const root = createRoot(context);
  const target = path.join(root, "target.txt");
  const broker = new PluginFilesystemBroker({
    quotaManager: { chargeBytes: () => { throw new Error("quota denied"); } },
  });
  const authorization = await broker.describeWriteAuthorization({ path: target, data: "blocked" });
  await assert.rejects(
    broker.writeFile({ path: target, data: "blocked" }, runtimeContext(authorization)),
    /quota denied/,
  );
  await assert.rejects(fsp.stat(target), (error) => error.code === "ENOENT");
});

test("filesystem path swaps after authorization fail closed", async (context) => {
  const root = createRoot(context);
  const first = path.join(root, "first.txt");
  const second = path.join(root, "second.txt");
  const link = path.join(root, "selected.txt");
  await Promise.all([fsp.writeFile(first, "first"), fsp.writeFile(second, "second")]);
  await fsp.symlink(first, link);
  const broker = new PluginFilesystemBroker();
  const authorization = await broker.describeReadAuthorization({ path: link });
  await fsp.unlink(link);
  await fsp.symlink(second, link);
  await assert.rejects(
    broker.readFile({ path: link }, runtimeContext(authorization)),
    (error) => error.code === RPC_ERRORS.permissionDenied,
  );
});

test("filesystem broker rejects oversized and non-canonical payloads", async (context) => {
  const root = createRoot(context);
  const target = path.join(root, "target.bin");
  const broker = new PluginFilesystemBroker();
  assert.throws(() => broker.validateWrite({
    path: target,
    data: "YQ",
    encoding: "base64",
  }), /not canonical/);
  assert.throws(() => broker.validateWrite({
    path: target,
    data: "a".repeat(MAX_FILESYSTEM_BYTES + 1),
  }), (error) => error.code === RPC_ERRORS.resourceExhausted);
  assert.throws(() => broker.validateRead({ path: `${target}\0suffix` }), /absolute/);

  await fsp.writeFile(target, "12345");
  const authorization = await broker.describeReadAuthorization({ path: target, maxBytes: 4 });
  await assert.rejects(
    broker.readFile({ path: target, maxBytes: 4 }, runtimeContext(authorization)),
    (error) => error.code === RPC_ERRORS.resourceExhausted,
  );
});
