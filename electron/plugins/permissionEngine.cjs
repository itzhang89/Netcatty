"use strict";

const { createHash, randomUUID } = require("node:crypto");

const { PluginRpcError, RPC_ERRORS, raceWithAbort } = require("./rpcRouter.cjs");
const {
  RESOURCE_SCOPED_PERMISSIONS,
  assertPluginPermission,
  canonicalizePermissionResource,
  declarationAllowsResource,
  defaultSecurityPrincipal,
  normalizePermissionDeclarations,
  permissionDeclarationHash,
  permissionResourceCovers,
} = require("./permissionResources.cjs");

const VALID_SCOPES = new Set(["once", "session", "application", "always"]);
const AUDITED_PERMISSION_USES = new Set([
  "runtime.advanced",
  "network",
  "filesystem.read",
  "filesystem.write",
  "secrets",
  "companion.execute",
  "vault.credentials",
  "terminal.input",
  "terminal.intercept.input",
  "terminal.intercept.output",
]);
const PROMPT_TIMEOUT_MS = 30_000;

function normalizePermissionOperationId(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length < 1 || value.includes("\0")) {
    throw permissionDenied("Plugin permission operation ID is invalid");
  }
  if (value.length <= 128) return value;
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function normalizePermissionReason(value, permission) {
  const reason = typeof value === "string" && value.length > 0
    ? value
    : `Allow ${permission}`;
  if (reason.length <= 1_024) return reason;
  const suffix = ` [sha256:${createHash("sha256").update(reason).digest("hex")}]`;
  return `${reason.slice(0, 1_024 - suffix.length)}${suffix}`;
}

function normalizePermissionSessionId(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || value.includes("\0")) {
    throw permissionDenied("Plugin permission session ID is invalid");
  }
  return value;
}

function normalizePermissionResources(permission, values, label = "Plugin permission resources") {
  try {
    return [...new Set(values.map((resource) => (
      canonicalizePermissionResource(permission, resource)
    )))].sort();
  } catch {
    throw permissionDenied(`${label} are invalid`, { permission });
  }
}

function permissionDenied(message, details) {
  return new PluginRpcError(RPC_ERRORS.permissionDenied, message, {
    pluginCode: "permission_denied",
    ...(details === undefined ? {} : { details }),
  });
}

function normalizeDecision(decision, requestId) {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    throw permissionDenied("Plugin permission request was not approved");
  }
  if (decision.requestId !== requestId) {
    throw permissionDenied("Plugin permission decision does not match the pending request");
  }
  if (decision.decision === "deny" || decision.decision === "cancel") {
    if (Object.keys(decision).some((key) => key !== "requestId" && key !== "decision")) {
      throw permissionDenied("Plugin permission decision is invalid");
    }
    return Object.freeze({ requestId, decision: decision.decision });
  }
  if (decision.decision !== "allow" || !VALID_SCOPES.has(decision.scope)) {
    throw permissionDenied("Plugin permission decision is invalid");
  }
  if (Object.keys(decision).some((key) => (
    key !== "requestId" && key !== "decision" && key !== "scope" && key !== "resources"
  ))) throw permissionDenied("Plugin permission decision is invalid");
  if (
    decision.resources !== undefined
    && (!Array.isArray(decision.resources) || decision.resources.length > 128)
  ) throw permissionDenied("Plugin permission decision resources are invalid");
  return Object.freeze({
    requestId,
    decision: "allow",
    scope: decision.scope,
    ...(decision.resources === undefined
      ? {}
      : { resources: Object.freeze([...decision.resources]) }),
  });
}

function immutableRequest(request) {
  return Object.freeze({
    ...request,
    resources: Object.freeze([...request.resources]),
  });
}

class PluginPermissionEngine {
  constructor(options) {
    this.database = options.database;
    this.requestDecision = options.requestDecision ?? null;
    if (this.requestDecision != null && typeof this.requestDecision !== "function") {
      throw new TypeError("Plugin permission decision provider must be a function");
    }
    this.clock = options.clock ?? (() => Date.now());
    this.promptTimeoutMs = options.promptTimeoutMs ?? PROMPT_TIMEOUT_MS;
    this.applicationGrants = new Map();
    this.sessionGrants = new Map();
    this.pending = new Map();
    this.closed = false;
    this.shutdownController = new AbortController();
  }

  #grantKey(pluginId, permission, declarationHash, resource) {
    return `${pluginId}\0${permission}\0${declarationHash}\0${resource}`;
  }

  #sessionGrantKey(sessionId, grantKey) {
    return `${sessionId}\0${grantKey}`;
  }

  #createMemoryGrant(context, permission, declarationHash, resource, scope, sessionId) {
    return Object.freeze({
      pluginId: context.pluginId,
      permission,
      declarationHash,
      resource,
      scope,
      sessionId: sessionId ?? null,
      grantedAt: this.clock(),
    });
  }

  #memoryGrantCovers(grant, context, permission, declarationHash, resource, sessionId) {
    return grant.pluginId === context.pluginId
      && grant.permission === permission
      && grant.declarationHash === declarationHash
      && (grant.scope !== "session" || grant.sessionId === sessionId)
      && permissionResourceCovers(permission, grant.resource, resource);
  }

  #assertDeclared(context, permission, resources) {
    const declarations = normalizePermissionDeclarations(context.manifest);
    const declaration = declarations.get(permission);
    if (!declaration) {
      throw permissionDenied(`Plugin did not declare permission: ${permission}`, { permission });
    }
    for (const resource of resources) {
      if (!declarationAllowsResource(declaration, resource)) {
        throw permissionDenied(`Plugin did not declare permission resource: ${permission}`, {
          permission,
          resource,
        });
      }
    }
    const securityPrincipal = context.securityPrincipal ?? defaultSecurityPrincipal(context.manifest);
    return {
      declaration,
      declarationHash: permissionDeclarationHash(declaration, securityPrincipal),
      securityPrincipal,
    };
  }

  #hasGrant(context, permission, declarationHash, resource, sessionId) {
    if ([...this.applicationGrants.values()].some((grant) => (
      this.#memoryGrantCovers(grant, context, permission, declarationHash, resource, sessionId)
    ))) return true;
    if (sessionId && [...this.sessionGrants.values()].some((grant) => (
      this.#memoryGrantCovers(grant, context, permission, declarationHash, resource, sessionId)
    ))) return true;
    return this.database.listPermissionGrants(context.pluginId).some((grant) => (
      grant.permission === permission
      && grant.declarationHash === declarationHash
      && permissionResourceCovers(permission, grant.resource, resource)
    ));
  }

  #hasAllGrants(context, permission, declarationHash, resources, sessionId) {
    return resources.every((resource) => this.#hasGrant(
      context,
      permission,
      declarationHash,
      resource,
      sessionId,
    ));
  }

  async authorize(context, descriptor) {
    if (this.closed) throw permissionDenied("Plugin permission engine is unavailable");
    context.signal?.throwIfAborted();
    const permission = descriptor.permission;
    if (
      descriptor.resources !== undefined
      && (!Array.isArray(descriptor.resources) || descriptor.resources.length > 128)
    ) throw permissionDenied("Plugin permission resources are invalid");
    descriptor = Object.freeze({
      ...descriptor,
      reason: normalizePermissionReason(descriptor.reason, permission),
      operationId: normalizePermissionOperationId(descriptor.operationId),
      sessionId: normalizePermissionSessionId(descriptor.sessionId),
    });
    const resources = normalizePermissionResources(
      permission,
      descriptor.resources?.length ? descriptor.resources : ["*"],
    );
    const { declaration, declarationHash } = this.#assertDeclared(context, permission, resources);
    if (this.#hasAllGrants(context, permission, declarationHash, resources, descriptor.sessionId)) {
      if (AUDITED_PERMISSION_USES.has(permission)) {
        this.database.recordSecurityAudit(context.pluginId, "permission.used", {
          permission,
          resources,
          runtimeId: context.runtimeId ?? null,
          operationId: descriptor.operationId ?? null,
        });
      }
      return Object.freeze({ declaration, resources, scope: "existing" });
    }
    if (descriptor.interactive === false || !this.requestDecision) {
      this.database.recordSecurityAudit(context.pluginId, "permission.denied", {
        permission,
        resources,
        reason: "no-interactive-approver",
      });
      throw permissionDenied(`Plugin permission is not granted: ${permission}`, {
        permission,
        resources,
      });
    }
    const pendingKey = JSON.stringify([
      context.pluginId,
      context.runtimeId ?? null,
      permission,
      declarationHash,
      resources,
      descriptor.operationId ?? null,
      descriptor.sessionId ?? null,
    ]);
    let pending = this.pending.get(pendingKey);
    let ownsPrompt = false;
    if (!pending) {
      ownsPrompt = true;
      pending = this.#requestGrant(context, descriptor, resources, declaration, declarationHash)
        .finally(() => this.pending.delete(pendingKey));
      this.pending.set(pendingKey, pending);
    }
    const grant = await pending;
    context.signal?.throwIfAborted();
    if (!ownsPrompt && grant.scope === "once") {
      return this.authorize(context, descriptor);
    }
    return Object.freeze({ declaration, resources, scope: grant.scope });
  }

  async #requestGrant(context, descriptor, resources, declaration, declarationHash) {
    const requestId = randomUUID();
    const request = immutableRequest({
      requestId,
      pluginId: context.pluginId,
      ...(context.pluginVersion === undefined ? {} : { pluginVersion: context.pluginVersion }),
      ...(context.manifest?.name === undefined ? {} : { pluginName: context.manifest.name }),
      ...(context.manifest?.publisher === undefined ? {} : { publisher: context.manifest.publisher }),
      runtimeId: context.runtimeId ?? null,
      runtimeKind: context.runtimeKind ?? null,
      permission: descriptor.permission,
      resources,
      reason: descriptor.reason,
      ...(descriptor.operationId === undefined ? {} : { operationId: descriptor.operationId }),
      ...(descriptor.sessionId === undefined ? {} : { sessionId: descriptor.sessionId }),
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(permissionDenied(
      "Plugin permission request timed out",
    )), this.promptTimeoutMs);
    timer.unref?.();
    const onAbort = () => controller.abort(context.signal.reason);
    const onShutdown = () => controller.abort(this.shutdownController.signal.reason);
    context.signal?.addEventListener("abort", onAbort, { once: true });
    this.shutdownController.signal.addEventListener("abort", onShutdown, { once: true });
    let rawDecision;
    try {
      rawDecision = await raceWithAbort(
        Promise.resolve(this.requestDecision(request, { signal: controller.signal })),
        controller.signal,
      );
    } catch (error) {
      this.database.recordSecurityAudit(context.pluginId, "permission.denied", {
        permission: descriptor.permission,
        resources,
        reason: controller.signal.aborted ? "prompt-aborted" : "decision-provider-failed",
      });
      if (controller.signal.aborted) throw controller.signal.reason;
      throw permissionDenied("Plugin permission decision provider failed", {
        permission: descriptor.permission,
      });
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", onAbort);
      this.shutdownController.signal.removeEventListener("abort", onShutdown);
    }
    if (this.closed) throw permissionDenied("Plugin permission engine is unavailable");
    let decision;
    try {
      decision = normalizeDecision(rawDecision, requestId);
    } catch (error) {
      this.database.recordSecurityAudit(context.pluginId, "permission.denied", {
        permission: descriptor.permission,
        resources,
        reason: "invalid-decision",
      });
      throw error;
    }
    if (decision.decision !== "allow") {
      this.database.recordSecurityAudit(context.pluginId, "permission.denied", {
        permission: descriptor.permission,
        resources,
        decision: decision.decision,
      });
      const outcome = decision.decision === "deny" ? "denied" : "cancelled";
      throw permissionDenied(`Plugin permission was ${outcome}: ${descriptor.permission}`);
    }
    let decisionResources;
    try {
      decisionResources = normalizePermissionResources(
        descriptor.permission,
        decision.resources?.length ? decision.resources : resources,
        "Plugin permission decision resources",
      );
    } catch (error) {
      this.database.recordSecurityAudit(context.pluginId, "permission.denied", {
        permission: descriptor.permission,
        resources,
        reason: "invalid-decision-resources",
      });
      throw error;
    }
    if (!decisionResources.every((resource) => declarationAllowsResource(declaration, resource))) {
      throw permissionDenied("Plugin permission decision exceeds the manifest declaration");
    }
    if (!resources.every((requested) => decisionResources.some((granted) => (
      permissionResourceCovers(descriptor.permission, granted, requested)
    )))) {
      throw permissionDenied("Plugin permission decision does not cover the requested resources");
    }
    if (decision.scope === "session" && !descriptor.sessionId) {
      throw permissionDenied("Session-scoped plugin permission requires a host-owned session");
    }
    for (const resource of decisionResources) {
      const grantKey = this.#grantKey(
        context.pluginId,
        descriptor.permission,
        declarationHash,
        resource,
      );
      if (decision.scope === "application") {
        this.applicationGrants.set(grantKey, this.#createMemoryGrant(
          context,
          descriptor.permission,
          declarationHash,
          resource,
          decision.scope,
        ));
      }
      if (decision.scope === "session") {
        this.sessionGrants.set(
          this.#sessionGrantKey(descriptor.sessionId, grantKey),
          this.#createMemoryGrant(
            context,
            descriptor.permission,
            declarationHash,
            resource,
            decision.scope,
            descriptor.sessionId,
          ),
        );
      }
      if (decision.scope === "always") {
        this.database.upsertPermissionGrant({
          pluginId: context.pluginId,
          permission: descriptor.permission,
          resource,
          declarationHash,
        });
      }
    }
    this.database.recordSecurityAudit(context.pluginId, "permission.granted", {
      permission: descriptor.permission,
      resources: decisionResources,
      scope: decision.scope,
      operationId: descriptor.operationId ?? null,
    });
    return decision;
  }

  async authorizeRequired(plugin, options = {}) {
    const declarations = normalizePermissionDeclarations(plugin.manifest);
    const skipPermissions = new Set(options.skipPermissions ?? []);
    const context = {
      pluginId: plugin.id,
      pluginVersion: plugin.activeVersion,
      runtimeId: options.runtimeId ?? null,
      manifest: plugin.manifest,
      securityPrincipal: options.securityPrincipal,
      signal: options.signal,
    };
    for (const declaration of declarations.values()) {
      if (!declaration.required || skipPermissions.has(declaration.permission)) continue;
      if (RESOURCE_SCOPED_PERMISSIONS.has(declaration.permission) && declaration.resources.length === 0) {
        continue;
      }
      await this.authorize(context, {
        permission: declaration.permission,
        resources: declaration.resources.length ? declaration.resources : ["*"],
        reason: declaration.reason || `Required by ${plugin.id}`,
        operationId: `activation:${plugin.activeVersion}`,
      });
    }
  }

  createMiddleware() {
    return async (context, next) => {
      if (context.metadata.public === true) return next();
      if (!context.authorization) {
        throw permissionDenied(`Plugin host method has no authorization policy: ${context.method}`);
      }
      await this.authorize(context, context.authorization);
      return next();
    };
  }

  listGrants(pluginId) {
    return Object.freeze({
      always: Object.freeze(this.database.listPermissionGrants(pluginId).map((grant) => (
        Object.freeze({ ...grant, scope: "always", sessionId: null })
      ))),
      application: Object.freeze([...this.applicationGrants.values()].filter((grant) => (
        grant.pluginId === pluginId
      ))),
      session: Object.freeze([...this.sessionGrants.values()].filter((grant) => (
        grant.pluginId === pluginId
      ))),
    });
  }

  revokeAlways(pluginId, permission, resource) {
    assertPluginPermission(permission);
    const canonicalResource = canonicalizePermissionResource(permission, resource);
    this.database.deletePermissionGrant(
      pluginId,
      permission,
      canonicalResource,
    );
    this.database.recordSecurityAudit(pluginId, "permission.revoked", {
      scope: "always",
      permission,
      resource: canonicalResource,
    });
  }

  revokeApplication(pluginId, permission, resource) {
    if (permission !== undefined) assertPluginPermission(permission);
    if (resource !== undefined && permission === undefined) {
      throw new TypeError("Revoking a permission resource requires a permission name");
    }
    const canonicalResource = resource === undefined
      ? undefined
      : canonicalizePermissionResource(permission, resource);
    for (const [key, grant] of [...this.applicationGrants]) {
      if (
        grant.pluginId === pluginId
        && (permission === undefined || grant.permission === permission)
        && (canonicalResource === undefined || grant.resource === canonicalResource)
      ) this.applicationGrants.delete(key);
    }
    this.database.recordSecurityAudit(pluginId, "permission.revoked", {
      scope: "application",
      ...(permission === undefined ? {} : { permission }),
      ...(canonicalResource === undefined ? {} : { resource: canonicalResource }),
    });
  }

  revokeSession(sessionId) {
    for (const key of [...this.sessionGrants.keys()]) {
      if (key.startsWith(`${sessionId}\0`)) this.sessionGrants.delete(key);
    }
  }

  revokeAll(pluginId) {
    this.database.deleteAllPermissionGrants(pluginId);
    for (const [key, grant] of [...this.applicationGrants]) {
      if (grant.pluginId === pluginId) this.applicationGrants.delete(key);
    }
    for (const [key, grant] of [...this.sessionGrants]) {
      if (grant.pluginId === pluginId) this.sessionGrants.delete(key);
    }
    this.database.recordSecurityAudit(pluginId, "permission.revoked", { scope: "all" });
  }

  shutdown() {
    if (this.closed) return;
    this.closed = true;
    this.shutdownController.abort(permissionDenied("Plugin permission engine is unavailable"));
    this.applicationGrants.clear();
    this.sessionGrants.clear();
  }
}

module.exports = {
  AUDITED_PERMISSION_USES,
  PROMPT_TIMEOUT_MS,
  PluginPermissionEngine,
  normalizePermissionOperationId,
  normalizePermissionReason,
  normalizePermissionResources,
  normalizePermissionSessionId,
  normalizeDecision,
  permissionDenied,
};
