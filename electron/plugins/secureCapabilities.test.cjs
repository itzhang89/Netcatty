"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { registerSecurePluginCapabilities } = require("./secureCapabilities.cjs");

function createRegistrations(secretStore) {
  const requests = new Map();
  const registry = {
    use() {},
    registerRequest(method, handler) { requests.set(method, handler); },
  };
  const middlewareOwner = { createMiddleware: () => async (_context, next) => next() };
  const broker = new Proxy({}, { get: () => () => ({}) });
  registerSecurePluginCapabilities(registry, {
    quotaManager: middlewareOwner,
    permissionEngine: middlewareOwner,
    secretStore,
    credentialBroker: broker,
    networkBroker: broker,
    filesystemBroker: broker,
    companionSupervisor: broker,
    assertLeaseParams: (params) => params,
  });
  return requests;
}

test("secret mutations recheck runtime activity immediately before commit", async () => {
  const events = [];
  const requests = createRegistrations({
    set(_pluginId, _key, _value) {
      events.push("set");
      return { kind: "secret", id: "secret-reference-0000000000000000", key: "api-key" };
    },
    delete() { events.push("delete"); },
    getReference() { return null; },
  });
  const activeContext = {
    pluginId: "com.example.secure",
    async assertActive() { events.push("active"); },
  };
  await requests.get("secrets.set")({ key: "api-key", value: "value" }, activeContext);
  await requests.get("secrets.delete")({ key: "api-key" }, activeContext);
  assert.deepEqual(events, ["active", "set", "active", "delete"]);

  const stoppedContext = {
    pluginId: "com.example.secure",
    async assertActive() { throw new Error("runtime stopped"); },
  };
  await assert.rejects(
    requests.get("secrets.set")({ key: "api-key", value: "value" }, stoppedContext),
    /runtime stopped/,
  );
  await assert.rejects(
    requests.get("secrets.delete")({ key: "api-key" }, stoppedContext),
    /runtime stopped/,
  );
  assert.deepEqual(events, ["active", "set", "active", "delete"]);
});

test("filesystem RPC authorization fixes resource kind by operation without host I/O", () => {
  const registrations = new Map();
  const registry = {
    use() {},
    registerRequest(method, handler, options) { registrations.set(method, { handler, options }); },
  };
  const middlewareOwner = { createMiddleware: () => async (_context, next) => next() };
  const filesystemCalls = [];
  const filesystemBroker = {
    validateRead: (params) => params,
    validateWrite: (params) => params,
    validatePath: (params) => params,
    describeReadAuthorization(params, resourceKind) {
      filesystemCalls.push([params.path, resourceKind]);
      return { permission: "filesystem.read", resources: [params.path], resourceKinds: [resourceKind] };
    },
    describeWriteAuthorization(params) {
      filesystemCalls.push([params.path, "exact"]);
      return { permission: "filesystem.write", resources: [params.path], resourceKinds: ["exact"] };
    },
    readFile: async () => null,
    stat: async () => null,
    readDirectory: async () => null,
    writeFile: async () => null,
  };
  const broker = new Proxy({}, { get: () => () => ({}) });
  registerSecurePluginCapabilities(registry, {
    quotaManager: middlewareOwner,
    permissionEngine: middlewareOwner,
    secretStore: {},
    credentialBroker: broker,
    networkBroker: broker,
    filesystemBroker,
    companionSupervisor: broker,
    assertLeaseParams: (params) => params,
  });

  const target = "/canonical/target";
  for (const method of ["filesystem.readFile", "filesystem.stat", "filesystem.readDirectory"]) {
    registrations.get(method).options.authorization({ path: target });
  }
  registrations.get("filesystem.writeFile").options.authorization({
    path: target,
    data: "value",
    overwrite: true,
  });
  assert.deepEqual(filesystemCalls, [
    [target, "exact"],
    [target, "exact"],
    [target, "directory"],
    [target, "exact"],
  ]);
});
