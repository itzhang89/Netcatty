"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { PluginCredentialBroker } = require("./credentialBroker.cjs");
const { PluginDatabase } = require("./database.cjs");
const { RPC_ERRORS } = require("./rpcRouter.cjs");
const { SecretLeaseStore } = require("./secretLease.cjs");
const { PluginSecretStore } = require("./secretStore.cjs");

function createDatabase(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-secrets-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return new PluginDatabase(path.join(root, "plugins.sqlite"));
}

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`sealed:${Buffer.from(value).toString("base64")}`),
    decryptString: (value) => {
      const encoded = value.toString().slice("sealed:".length);
      return Buffer.from(encoded, "base64").toString();
    },
  };
}

test("plugin secrets are OS-encrypted, opaque, ownership-bound, and uninstall-independent", (context) => {
  const database = createDatabase(context);
  let random = 0;
  const store = new PluginSecretStore({
    database,
    safeStorage: fakeSafeStorage(),
    randomBytes: () => Buffer.alloc(24, ++random),
  });
  const secret = store.set("com.example.one", "api-key", "plaintext-token");
  const record = database.getSecretByKey("com.example.one", "api-key");
  assert.equal(record.ciphertext.includes(Buffer.from("plaintext-token")), false);
  assert.deepEqual(store.getReference("com.example.one", "api-key"), secret);
  assert.equal(store.resolve("com.example.one", secret), "plaintext-token");
  assert.throws(
    () => store.resolve("com.example.two", secret),
    (error) => error.code === RPC_ERRORS.notFound,
  );
  assert.throws(
    () => store.resolve("com.example.one", { ...secret, key: "different-key" }),
    (error) => error.code === RPC_ERRORS.notFound,
  );
  store.delete("com.example.one", "api-key");
  assert.equal(store.getReference("com.example.one", "api-key"), undefined);
  database.close();
});

test("plugin secrets fail closed when OS encryption is unavailable or ciphertext is corrupt", (context) => {
  const database = createDatabase(context);
  const unavailable = new PluginSecretStore({ database, safeStorage: null });
  assert.throws(
    () => unavailable.set("com.example.one", "api-key", "value"),
    (error) => error.code === RPC_ERRORS.unavailable,
  );
  const insecureBackend = new PluginSecretStore({
    database,
    safeStorage: {
      ...fakeSafeStorage(),
      getSelectedStorageBackend: () => "basic_text",
    },
  });
  assert.throws(
    () => insecureBackend.set("com.example.one", "api-key", "value"),
    (error) => error.code === RPC_ERRORS.unavailable,
  );

  const safeStorage = fakeSafeStorage();
  const store = new PluginSecretStore({ database, safeStorage });
  const secret = store.set("com.example.one", "api-key", "value");
  safeStorage.decryptString = () => { throw new Error("corrupt"); };
  assert.throws(
    () => store.resolve("com.example.one", secret),
    (error) => error.code === RPC_ERRORS.dataLoss,
  );
  database.close();
});

test("credential leases are one-use and bound to plugin, runtime, operation, abort, and expiry", async (context) => {
  const database = createDatabase(context);
  let now = 1_000;
  let random = 0;
  const secretStore = new PluginSecretStore({
    database,
    safeStorage: fakeSafeStorage(),
    randomBytes: () => Buffer.alloc(24, ++random),
  });
  const secret = secretStore.set("com.example.one", "api-key", "credential-value");
  const leaseStore = new SecretLeaseStore({
    secretStore,
    clock: () => now,
    randomBytes: () => Buffer.alloc(24, ++random),
    setTimeout: () => ({ timer: true }),
    clearTimeout: () => {},
  });
  const broker = new PluginCredentialBroker({ secretStore, leaseStore });
  const runtime = {
    pluginId: "com.example.one",
    runtimeId: "runtime-1",
    signal: new AbortController().signal,
    assertActive: async () => {},
  };
  const lease = leaseStore.issue({
    ...runtime,
    secret,
    operationId: "network:login",
    purpose: "Authenticate",
    ttlMs: 500,
  });
  await assert.rejects(
    broker.consumeLease({ ...runtime, runtimeId: "runtime-2" }, lease, "network:login"),
    (error) => error.code === RPC_ERRORS.permissionDenied,
  );
  assert.equal(await broker.consumeLease(runtime, lease, "network:login"), "credential-value");
  await assert.rejects(
    broker.consumeLease(runtime, lease, "network:login"),
    (error) => error.code === RPC_ERRORS.notFound,
  );

  const expired = leaseStore.issue({
    ...runtime,
    secret,
    operationId: "network:expired",
    purpose: "Expire",
    ttlMs: 1,
  });
  now += 2;
  await assert.rejects(
    broker.consumeLease(runtime, expired, "network:expired"),
    (error) => error.code === RPC_ERRORS.notFound,
  );

  const controller = new AbortController();
  const aborted = leaseStore.issue({
    ...runtime,
    signal: controller.signal,
    secret,
    operationId: "network:aborted",
    purpose: "Abort",
  });
  controller.abort();
  await assert.rejects(
    broker.consumeLease(runtime, aborted, "network:aborted"),
    (error) => error.code === RPC_ERRORS.notFound,
  );
  leaseStore.shutdown();
  database.close();
});

test("Netcatty credentials resolve only when a one-use provider lease is consumed", async (context) => {
  const database = createDatabase(context);
  const secretStore = new PluginSecretStore({ database, safeStorage: fakeSafeStorage() });
  const leaseStore = new SecretLeaseStore({ secretStore });
  let resolved = 0;
  let referenceChecks = 0;
  const broker = new PluginCredentialBroker({
    secretStore,
    leaseStore,
    credentialResolver: {
      assertReference: async (reference, leaseContext) => {
        referenceChecks += 1;
        assert.equal(reference.id, "vault-credential-1");
        assert.equal(leaseContext.operationId, "connection:open-1");
      },
      resolve: async (reference, consumeContext) => {
        resolved += 1;
        assert.equal(reference.id, "vault-credential-1");
        assert.equal(consumeContext.pluginId, "com.example.provider");
        assert.equal(consumeContext.purpose, "Authenticate connection");
        return "host-owned-plaintext";
      },
    },
  });
  const runtime = {
    pluginId: "com.example.provider",
    runtimeId: "runtime-provider",
    signal: new AbortController().signal,
    assertActive: async () => {},
  };
  const params = {
    secret: { kind: "credential", id: "vault-credential-1" },
    operationId: "connection:open-1",
    purpose: "Authenticate connection",
  };
  assert.deepEqual(broker.describeAuthorization(params).resources, ["credential:vault-credential-1"]);
  assert.equal(referenceChecks, 0);
  const lease = await broker.createLease(params, runtime);
  assert.equal(referenceChecks, 1);
  assert.equal(resolved, 0);
  assert.equal(await broker.consumeLease(runtime, lease, "connection:open-1"), "host-owned-plaintext");
  assert.equal(resolved, 1);
  await assert.rejects(
    broker.consumeLease(runtime, lease, "connection:open-1"),
    (error) => error.code === RPC_ERRORS.notFound,
  );
  leaseStore.shutdown();
  database.close();
});

test("credential authorization descriptors do not probe opaque references before permission", async () => {
  let credentialChecks = 0;
  let secretChecks = 0;
  const broker = new PluginCredentialBroker({
    secretStore: {
      getRecordByReference() {
        secretChecks += 1;
        throw new Error("unknown plugin secret");
      },
    },
    leaseStore: { issue: () => { throw new Error("lease must not be issued"); } },
    credentialResolver: {
      async assertReference() {
        credentialChecks += 1;
        throw new Error("unknown Netcatty credential");
      },
      async resolve() { throw new Error("credential must not resolve"); },
    },
  });
  const base = {
    operationId: "connection:open-1",
    purpose: "Authenticate connection",
  };
  assert.deepEqual(broker.describeAuthorization({
    ...base,
    secret: { kind: "credential", id: "unknown-credential" },
  }).resources, ["credential:unknown-credential"]);
  assert.deepEqual(broker.describeAuthorization({
    ...base,
    secret: { kind: "secret", id: "unknown-secret-reference", key: "api-key" },
  }).resources, ["secret:api-key"]);
  assert.equal(credentialChecks, 0);
  assert.equal(secretChecks, 0);

  const runtime = {
    pluginId: "com.example.provider",
    runtimeId: "runtime-provider",
    signal: new AbortController().signal,
    assertActive: async () => {},
  };
  await assert.rejects(broker.createLease({
    ...base,
    secret: { kind: "credential", id: "unknown-credential" },
  }, runtime), /unknown Netcatty credential/);
  assert.equal(credentialChecks, 1);
  await assert.rejects(broker.createLease({
    ...base,
    secret: { kind: "secret", id: "unknown-secret-reference", key: "api-key" },
  }, runtime), /unknown plugin secret/);
  assert.equal(secretChecks, 1);
});

test("credential lease resolution cannot return plaintext after operation cancellation", async (context) => {
  const database = createDatabase(context);
  const secretStore = new PluginSecretStore({ database, safeStorage: fakeSafeStorage() });
  const leaseStore = new SecretLeaseStore({ secretStore });
  const controller = new AbortController();
  let releaseResolution;
  let resolutionSignal;
  const broker = new PluginCredentialBroker({
    secretStore,
    leaseStore,
    credentialResolver: {
      assertReference: async () => {},
      resolve: async (_reference, consumeContext) => {
        resolutionSignal = consumeContext.signal;
        await new Promise((resolve) => { releaseResolution = resolve; });
        return "must-not-escape-after-cancel";
      },
    },
  });
  const runtime = {
    pluginId: "com.example.provider",
    runtimeId: "runtime-provider",
    signal: controller.signal,
    assertActive: async () => controller.signal.throwIfAborted(),
  };
  const params = {
    secret: { kind: "credential", id: "vault-credential-1" },
    operationId: "connection:open-1",
    purpose: "Authenticate connection",
  };
  const lease = await broker.createLease(params, runtime);
  const consuming = broker.consumeLease(runtime, lease, "connection:open-1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolutionSignal, controller.signal);
  controller.abort();
  releaseResolution();
  await assert.rejects(
    consuming,
    (error) => error.code === RPC_ERRORS.cancelled,
  );
  leaseStore.shutdown();
  database.close();
});
