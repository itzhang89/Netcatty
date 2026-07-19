"use strict";

const { randomBytes } = require("node:crypto");

const { PluginRpcError, RPC_ERRORS } = require("./rpcRouter.cjs");

const MAX_SECRET_BYTES = 64 * 1024;

function assertSecretKey(key) {
  if (typeof key !== "string" || key.length < 1 || key.length > 256 || key.includes("\0")) {
    throw new PluginRpcError(RPC_ERRORS.invalidArgument, "Plugin secret key is invalid");
  }
  return key;
}

function assertSecretRef(secret) {
  if (
    !secret
    || typeof secret !== "object"
    || Array.isArray(secret)
    || secret.kind !== "secret"
    || typeof secret.id !== "string"
    || secret.id.length < 16
    || secret.id.length > 256
    || typeof secret.key !== "string"
    || secret.key.length < 1
    || secret.key.length > 256
    || secret.key.includes("\0")
  ) throw new PluginRpcError(RPC_ERRORS.invalidArgument, "Plugin secret reference is invalid");
  return { id: secret.id, key: secret.key };
}

class PluginSecretStore {
  constructor(options) {
    this.database = options.database;
    this.safeStorage = options.safeStorage ?? null;
    this.randomBytes = options.randomBytes ?? randomBytes;
  }

  #assertAvailable() {
    const backend = this.safeStorage?.getSelectedStorageBackend?.();
    if (
      !this.safeStorage?.isEncryptionAvailable?.()
      || backend === "basic_text"
      || typeof this.safeStorage.encryptString !== "function"
      || typeof this.safeStorage.decryptString !== "function"
    ) {
      throw new PluginRpcError(
        RPC_ERRORS.unavailable,
        "Secure OS-backed encryption is unavailable for plugin secrets",
      );
    }
  }

  getReference(pluginId, key) {
    assertSecretKey(key);
    const record = this.database.getSecretByKey(pluginId, key);
    return record ? Object.freeze({ kind: "secret", id: record.secretRef, key: record.key }) : undefined;
  }

  getRecordByReference(pluginId, secret) {
    const reference = assertSecretRef(secret);
    const record = this.database.getSecretByRef(pluginId, reference.id);
    if (!record || record.key !== reference.key) {
      throw new PluginRpcError(RPC_ERRORS.notFound, "Plugin secret reference was not found");
    }
    return record;
  }

  set(pluginId, key, value) {
    this.#assertAvailable();
    assertSecretKey(key);
    if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) {
      throw new PluginRpcError(RPC_ERRORS.invalidArgument, "Plugin secret value is invalid or too large");
    }
    const secretRef = this.randomBytes(24).toString("base64url");
    const ciphertext = this.safeStorage.encryptString(value);
    if (!Buffer.isBuffer(ciphertext) || ciphertext.byteLength < 1) {
      throw new PluginRpcError(RPC_ERRORS.unavailable, "OS-backed plugin secret encryption failed");
    }
    this.database.upsertSecret({ pluginId, key, secretRef, ciphertext });
    return Object.freeze({ kind: "secret", id: secretRef, key });
  }

  delete(pluginId, key) {
    assertSecretKey(key);
    this.database.deleteSecret(pluginId, key);
  }

  resolve(pluginId, secret) {
    this.#assertAvailable();
    const record = this.getRecordByReference(pluginId, secret);
    try {
      return this.safeStorage.decryptString(record.ciphertext);
    } catch {
      throw new PluginRpcError(RPC_ERRORS.dataLoss, "Plugin secret could not be decrypted");
    }
  }
}

module.exports = {
  MAX_SECRET_BYTES,
  PluginSecretStore,
  assertSecretKey,
  assertSecretRef,
};
