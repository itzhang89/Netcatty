"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { MessageChannel } = require("node:worker_threads");

const { PluginRpcRouter } = require("./rpcRouter.cjs");

test("runtime peer exposes secure host capabilities over the canonical RPC transport", async () => {
  const { startPluginRuntime } = await import("./runtime/runtimePeer.mjs");
  const { port1, port2 } = new MessageChannel();
  const values = new Map();
  const calls = [];
  const host = new PluginRpcRouter({
    pluginId: "com.example.peer",
    send(message) { port1.postMessage(message); },
    handlers: {
      "storage.set": async ({ key, value }) => { values.set(key, value); return null; },
      "secrets.set": async ({ key, value }) => {
        calls.push(["secret", key, value]);
        return { secret: { kind: "secret", id: "secret-reference-0000000000000000" } };
      },
      "secrets.get": async () => ({
        found: true,
        secret: { kind: "secret", id: "secret-reference-0000000000000000" },
      }),
      "credentials.createLease": async ({ operationId }) => ({
        kind: "secret-lease",
        id: "l".repeat(32),
        operationId,
        expiresAt: 10_000,
      }),
      "network.request": async ({ url }) => ({
        url,
        status: 200,
        headers: {},
        body: { encoding: "base64", data: "b2s=" },
      }),
      "filesystem.readFile": async ({ path }) => ({ data: `read:${path}` }),
      "filesystem.writeFile": async ({ path, data }) => { calls.push(["write", path, data]); return null; },
      "filesystem.stat": async () => ({ kind: "file", size: 2, modifiedAt: 1 }),
      "filesystem.readDirectory": async () => ({ entries: [{ name: "file", kind: "file" }] }),
      "companion.start": async () => ({ handleId: "companion-handle-000000000000" }),
      "companion.request": async ({ method, params }) => ({ method, params }),
      "companion.stop": async ({ handleId }) => { calls.push(["stop", handleId]); return null; },
      "log.write": async () => null,
    },
  });
  port1.on("message", (message) => host.accept(message));
  const lifecycle = [];
  const peer = await startPluginRuntime({
    port: port2,
    config: {
      pluginId: "com.example.peer",
      pluginVersion: "1.0.0",
      netcattyVersion: "1.0.0",
      apiVersion: "0.1.0-internal",
      enabledFeatures: [],
    },
    async loadPlugin() {
      return {
        default: {
          async activate(context) {
            lifecycle.push("activate");
            await context.storage.set("answer", 42);
            const secret = await context.secrets.set("api-key", "value");
            const lease = await context.credentials.createLease(secret, {
              operationId: "network:login",
              purpose: "Authenticate",
            });
            assert.equal(lease.operationId, "network:login");
            const vaultLease = await context.credentials.createLease({
              kind: "credential",
              id: "vault-credential-1",
            }, {
              operationId: "connection:login",
              purpose: "Authenticate connection",
            });
            assert.equal(vaultLease.operationId, "connection:login");
            assert.equal((await context.network.request({ url: "https://example.com" })).status, 200);
            assert.equal(await context.filesystem.readFile("/tmp/file"), "read:/tmp/file");
            await context.filesystem.writeFile("/tmp/file", "ok");
            assert.equal((await context.filesystem.stat("/tmp/file")).kind, "file");
            assert.equal((await context.filesystem.readDirectory("/tmp")).length, 1);
            const companion = await context.companions.start("com.example.peer.helper");
            assert.deepEqual(await companion.request("echo", { value: 1 }), {
              method: "echo",
              params: { value: 1 },
            });
            await companion.stop();
          },
          async deactivate() { lifecycle.push("deactivate"); },
        },
      };
    },
  });
  const initialized = await host.request("plugin.initialize", {
    netcattyVersion: "1.0.0",
    apiVersion: "0.1.0-internal",
    supportedFeatures: [],
  });
  assert.equal(initialized.pluginId, "com.example.peer");
  const unhandledStream = await host.streams.openOutgoing("unhandled", 1024);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await assert.rejects(unhandledStream.write(new Uint8Array([1])), /closed/);
  await assert.rejects(
    host.request("plugin.unknown", {}),
    (error) => error?.code === -32012 && error?.data?.pluginCode === "unsupported",
  );
  await host.request("plugin.activate", {});
  assert.equal(values.get("answer"), 42);
  assert.deepEqual(calls, [
    ["secret", "api-key", "value"],
    ["write", "/tmp/file", "ok"],
    ["stop", "companion-handle-000000000000"],
  ]);
  await host.request("plugin.deactivate", {});
  await peer.dispose();
  host.close();
  assert.deepEqual(lifecycle, ["activate", "deactivate"]);
});
