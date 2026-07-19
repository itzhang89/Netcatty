"use strict";

const { PluginRpcError, RPC_ERRORS } = require("./rpcRouter.cjs");
const { assertSecretKey } = require("./secretStore.cjs");

function assertSecretParams(params, options = {}) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new PluginRpcError(RPC_ERRORS.invalidArgument, "Plugin secret parameters are invalid");
  }
  const key = assertSecretKey(params.key);
  if (options.value) {
    if (typeof params.value !== "string") {
      throw new PluginRpcError(RPC_ERRORS.invalidArgument, "Plugin secret value is invalid");
    }
    return { key, value: params.value };
  }
  return { key };
}

function secretAuthorization(params, action) {
  const value = assertSecretParams(params);
  return {
    permission: "secrets",
    resources: [`secret:${value.key}`],
    reason: `${action} plugin secret ${value.key}`,
    operationId: `secret:${action.toLowerCase()}:${value.key}`,
  };
}

function registerSecurePluginCapabilities(registry, options) {
  registry.use(options.quotaManager.createMiddleware());
  registry.use(options.permissionEngine.createMiddleware());

  registry.registerRequest("secrets.get", async ({ key }, context) => {
    const secret = options.secretStore.getReference(context.pluginId, key);
    return secret ? { found: true, secret } : { found: false };
  }, {
    metadata: { capability: "secrets", mutating: false, permission: "secrets" },
    validateParams: (params) => assertSecretParams(params),
    authorization: (params) => secretAuthorization(params, "Read"),
  });
  registry.registerRequest("secrets.set", async ({ key, value }, context) => ({
    secret: options.secretStore.set(context.pluginId, key, value),
  }), {
    metadata: { capability: "secrets", mutating: true, permission: "secrets" },
    validateParams: (params) => assertSecretParams(params, { value: true }),
    authorization: (params) => secretAuthorization(params, "Store"),
  });
  registry.registerRequest("secrets.delete", async ({ key }, context) => {
    options.secretStore.delete(context.pluginId, key);
    return null;
  }, {
    metadata: { capability: "secrets", mutating: true, permission: "secrets" },
    validateParams: (params) => assertSecretParams(params),
    authorization: (params) => secretAuthorization(params, "Delete"),
  });

  registry.registerRequest("credentials.createLease", (params, context) => (
    options.credentialBroker.createLease(params, context)
  ), {
    metadata: { capability: "credentials", mutating: true, permission: "secrets" },
    validateParams: options.assertLeaseParams,
    authorization: (params, context) => options.credentialBroker.describeAuthorization(params, context),
  });

  registry.registerRequest("network.request", (params, context) => (
    options.networkBroker.request(params, context)
  ), {
    metadata: { capability: "network", mutating: true, permission: "network" },
    validateParams: (params) => options.networkBroker.validate(params),
    authorization: (params) => options.networkBroker.describeAuthorization(params),
  });

  registry.registerRequest("filesystem.readFile", (params, context) => (
    options.filesystemBroker.readFile(params, context)
  ), {
    metadata: { capability: "filesystem", mutating: false, permission: "filesystem.read" },
    validateParams: (params) => options.filesystemBroker.validateRead(params),
    authorization: (params) => options.filesystemBroker.describeReadAuthorization(params),
  });
  registry.registerRequest("filesystem.stat", (params, context) => (
    options.filesystemBroker.stat(params, context)
  ), {
    metadata: { capability: "filesystem", mutating: false, permission: "filesystem.read" },
    validateParams: (params) => options.filesystemBroker.validatePath(params),
    authorization: (params) => options.filesystemBroker.describeReadAuthorization(params),
  });
  registry.registerRequest("filesystem.readDirectory", (params, context) => (
    options.filesystemBroker.readDirectory(params, context)
  ), {
    metadata: { capability: "filesystem", mutating: false, permission: "filesystem.read" },
    validateParams: (params) => options.filesystemBroker.validatePath(params),
    authorization: (params) => options.filesystemBroker.describeReadAuthorization(params),
  });
  registry.registerRequest("filesystem.writeFile", (params, context) => (
    options.filesystemBroker.writeFile(params, context)
  ), {
    metadata: { capability: "filesystem", mutating: true, permission: "filesystem.write" },
    validateParams: (params) => options.filesystemBroker.validateWrite(params),
    authorization: (params) => options.filesystemBroker.describeWriteAuthorization(params),
  });

  registry.registerRequest("companion.start", (params, context) => (
    options.companionSupervisor.start(params, context)
  ), {
    metadata: { capability: "companion", mutating: true, permission: "companion.execute" },
    validateParams: (params) => options.companionSupervisor.validateStart(params),
    authorization: (params) => options.companionSupervisor.describeStartAuthorization(params),
  });
  registry.registerRequest("companion.request", (params, context) => (
    options.companionSupervisor.request(params, context)
  ), {
    metadata: { capability: "companion", mutating: true, permission: "companion.execute" },
    validateParams: (params) => options.companionSupervisor.validateRequest(params),
    authorization: (params, context) => options.companionSupervisor.describeHandleAuthorization(params, context),
  });
  registry.registerRequest("companion.stop", (params, context) => (
    options.companionSupervisor.stop(params, context)
  ), {
    metadata: { capability: "companion", mutating: true, permission: "companion.execute" },
    validateParams: (params) => options.companionSupervisor.validateStop(params),
    authorization: (params, context) => options.companionSupervisor.describeHandleAuthorization(params, context),
  });
}

module.exports = { assertSecretParams, registerSecurePluginCapabilities, secretAuthorization };
