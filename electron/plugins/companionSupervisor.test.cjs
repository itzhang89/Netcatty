"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const { CompanionRpcPeer, PluginCompanionSupervisor } = require("./companionSupervisor.cjs");
const { RPC_ERRORS } = require("./rpcRouter.cjs");

function createRoot(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-companion-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function runtimeContext(packageRoot, digest, overrides = {}) {
  return {
    pluginId: "com.example.companion",
    pluginVersion: "1.0.0",
    runtimeId: "runtime-1",
    packageRoot,
    manifest: {
      companionExecutables: [{
        id: "com.example.companion.helper",
        variants: [{ path: "bin/helper", platforms: [`${process.platform}-${process.arch}`], sha256: digest }],
      }],
    },
    assertActive: async () => {},
    ...overrides,
  };
}

class FakeChild extends EventEmitter {
  constructor(contract, responseId = (id) => id) {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.signalCode = null;
    const decoder = new contract.ContentLengthFrameDecoder();
    this.stdin.on("data", (chunk) => {
      for (const message of decoder.push(chunk)) {
        if (!Object.hasOwn(message, "id")) continue;
        queueMicrotask(() => this.stdout.write(contract.encodeContentLengthFrame({
          jsonrpc: "2.0",
          id: responseId(message.id),
          result: { echoed: message.params ?? null },
        })));
      }
    });
    queueMicrotask(() => this.emit("spawn"));
  }

  kill(signal = "SIGTERM") {
    this.signalCode = signal;
    queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  }
}

test("companion RPC correlation keeps numeric and string IDs distinct", async () => {
  const contract = await import("@netcatty/plugin-contract");
  const child = new FakeChild(contract, (id) => String(id));
  const errors = [];
  const peer = new CompanionRpcPeer({
    child,
    contract,
    onProtocolError: (error) => errors.push(error.message),
  });
  await assert.rejects(peer.request("echo", null, 1_000), /unknown response ID/);
  assert.deepEqual(errors, ["Plugin companion returned an unknown response ID"]);
});

test("companion launch verifies digest immediately and never spawns a mismatch", async (context) => {
  const root = createRoot(context);
  const packageRoot = path.join(root, "package");
  const executable = path.join(packageRoot, "bin/helper");
  await fsp.mkdir(path.dirname(executable), { recursive: true });
  await fsp.writeFile(executable, "binary");
  let spawnCalls = 0;
  const supervisor = new PluginCompanionSupervisor({
    paths: { data: path.join(root, "data") },
    spawn: () => { spawnCalls += 1; throw new Error("must not spawn"); },
  });
  await assert.rejects(
    supervisor.start(
      { companionId: "com.example.companion.helper" },
      runtimeContext(packageRoot, "0".repeat(64)),
    ),
    (error) => error.code === RPC_ERRORS.dataLoss,
  );
  assert.equal(spawnCalls, 0);
  await supervisor.shutdown();
});

test("companion runs shell-free with sanitized environment and bounded host-only RPC", async (context) => {
  const root = createRoot(context);
  const packageRoot = path.join(root, "package");
  const executable = path.join(packageRoot, "bin/helper");
  await fsp.mkdir(path.dirname(executable), { recursive: true });
  const contents = Buffer.from("binary");
  await fsp.writeFile(executable, contents);
  const digest = createHash("sha256").update(contents).digest("hex");
  const contract = await import("@netcatty/plugin-contract");
  const spawns = [];
  const supervisor = new PluginCompanionSupervisor({
    paths: { data: path.join(root, "data") },
    spawn: (command, args, options) => {
      const child = new FakeChild(contract);
      spawns.push({ command, args, options, child });
      return child;
    },
  });
  const runtime = runtimeContext(packageRoot, digest);
  const handle = await supervisor.start({ companionId: "com.example.companion.helper" }, runtime);
  assert.equal(spawns[0].command, await fsp.realpath(executable));
  assert.deepEqual(spawns[0].args, []);
  assert.equal(spawns[0].options.shell, false);
  assert.deepEqual(Object.keys(spawns[0].options.env).sort(), ["LANG", "LC_ALL"]);

  assert.deepEqual(await supervisor.request({
    handleId: handle.handleId,
    method: "echo",
    params: { value: 1 },
  }, runtime), { echoed: { value: 1 } });
  await assert.rejects(
    supervisor.request({ handleId: handle.handleId, method: "echo" }, {
      ...runtime,
      runtimeId: "runtime-2",
    }),
    (error) => error.code === RPC_ERRORS.notFound,
  );
  await supervisor.stop({ handleId: handle.handleId }, runtime);
  assert.equal(spawns[0].child.signalCode, "SIGTERM");
  await supervisor.shutdown();
});

test("concurrent companion starts reserve the per-runtime process quota", async (context) => {
  const root = createRoot(context);
  const packageRoot = path.join(root, "package");
  const executable = path.join(packageRoot, "bin/helper");
  await fsp.mkdir(path.dirname(executable), { recursive: true });
  const contents = Buffer.from("binary");
  await fsp.writeFile(executable, contents);
  const digest = createHash("sha256").update(contents).digest("hex");
  const contract = await import("@netcatty/plugin-contract");
  let spawns = 0;
  const supervisor = new PluginCompanionSupervisor({
    paths: { data: path.join(root, "data") },
    spawn: () => {
      spawns += 1;
      return new FakeChild(contract);
    },
  });
  const runtime = runtimeContext(packageRoot, digest);
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => (
    supervisor.start({ companionId: "com.example.companion.helper" }, runtime)
  )));
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 4);
  assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
  assert.equal(results.find(({ status }) => status === "rejected").reason.code, RPC_ERRORS.resourceExhausted);
  assert.equal(spawns, 4);
  await supervisor.shutdown();
});
