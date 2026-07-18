import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  lstat,
  open,
  readFile,
} from "node:fs/promises";
import path from "node:path";

import type {
  IconReference,
  PermissionDeclaration,
  PluginManifest,
  PluginPermission,
} from "@netcatty/plugin-contract";
import Ajv2020, { type ErrorObject } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { valid, validRange } from "semver";

import { PACKAGE_LIMITS } from "./constants.js";
import { assertSafePackagePath } from "./packagePath.js";

const require = createRequire(import.meta.url);
const schemaPath = require.resolve(
  "@netcatty/plugin-contract/schema/plugin-contract.schema.json",
);
interface PluginContractSchema extends Record<string, unknown> {
  readonly $defs: {
    readonly JsonValueLimits: {
      readonly const: {
        readonly maxDepth: number;
        readonly maxNodes: number;
      };
    };
  };
}

const contractSchema = JSON.parse(
  await readFile(schemaPath, "utf8"),
) as PluginContractSchema;
const manifestJsonLimits = contractSchema.$defs.JsonValueLimits.const;
if (!Number.isSafeInteger(manifestJsonLimits.maxDepth) || manifestJsonLimits.maxDepth < 1
  || !Number.isSafeInteger(manifestJsonLimits.maxNodes) || manifestJsonLimits.maxNodes < 1) {
  throw new Error("Plugin contract JSON value limits are invalid");
}
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateSchema = ajv.compile<PluginManifest>(contractSchema);
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export interface ManifestValidationResult {
  readonly valid: boolean;
  readonly manifest?: PluginManifest;
  readonly errors: readonly string[];
}

export interface ValidatedManifestSource {
  readonly manifest: PluginManifest;
  readonly size: number;
  readonly sha256: string;
}

function formatAjvError(error: ErrorObject): string {
  const location = error.instancePath || "/";
  return `${location} ${error.message ?? "is invalid"}`;
}

function assertManifestJsonStructure(root: unknown): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    if (current.depth > manifestJsonLimits.maxDepth) {
      throw new RangeError(
        `JSON values must not exceed ${manifestJsonLimits.maxDepth} levels of nesting`,
      );
    }
    nodes += 1;
    if (nodes > manifestJsonLimits.maxNodes) {
      throw new RangeError(
        `JSON values must not contain more than ${manifestJsonLimits.maxNodes} nodes`,
      );
    }
    const { value } = current;
    if (value === null || typeof value === "string" || typeof value === "boolean") continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new TypeError("JSON numbers must be finite");
      continue;
    }
    if (typeof value !== "object") {
      throw new TypeError(`Unsupported JSON value type: ${typeof value}`);
    }
    if (seen.has(value)) throw new TypeError("JSON values must not contain shared references");
    seen.add(value);
    const nextDepth = current.depth + 1;
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      const ownKeys = Reflect.ownKeys(value);
      if (keys.length !== value.length || ownKeys.length !== value.length + 1) {
        throw new TypeError("JSON arrays must be dense and contain no named properties");
      }
      for (let index = value.length - 1; index >= 0; index -= 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw new TypeError("JSON arrays must contain enumerable data properties only");
        }
        stack.push({ value: descriptor.value, depth: nextDepth });
      }
      continue;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("JSON objects must be plain records");
    }
    const stringKeys = Object.keys(value);
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== stringKeys.length) {
      throw new TypeError("JSON objects must not contain symbols or non-enumerable properties");
    }
    for (let index = stringKeys.length - 1; index >= 0; index -= 1) {
      const key = stringKeys[index];
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        throw new TypeError("JSON objects must not contain accessor properties");
      }
      stack.push({ value: descriptor.value, depth: nextDepth });
    }
  }
}

function permissionName(declaration: PermissionDeclaration): PluginPermission {
  return typeof declaration === "string" ? declaration : declaration.permission;
}

function findDuplicateIds(manifest: PluginManifest): string[] {
  const errors: string[] = [];
  const groups = [
    ["settings", manifest.contributes?.settings],
    ["commands", manifest.contributes?.commands],
    ["views", manifest.contributes?.views],
    ["providers", manifest.contributes?.providers],
    ["companionExecutables", manifest.companionExecutables],
  ] as const;
  const ids = new Map<string, string>();
  for (const [groupName, contributions] of groups) {
    for (const contribution of contributions ?? []) {
      const previousGroup = ids.get(contribution.id);
      if (previousGroup) {
        errors.push(
          `Duplicate contribution id across ${previousGroup} and ${groupName}: ${contribution.id}`,
        );
      } else {
        ids.set(contribution.id, groupName);
      }
    }
  }
  return errors;
}

function validateOwnedContributionIds(manifest: PluginManifest): string[] {
  const errors: string[] = [];
  const expectedPrefix = `${manifest.id}.`;
  const groups = [
    ["setting", manifest.contributes?.settings],
    ["command", manifest.contributes?.commands],
    ["view", manifest.contributes?.views],
    ["provider", manifest.contributes?.providers],
    ["companion executable", manifest.companionExecutables],
  ] as const;
  for (const [kind, contributions] of groups) {
    for (const contribution of contributions ?? []) {
      if (!contribution.id.startsWith(expectedPrefix)) {
        errors.push(
          `${kind} id must start with the owning plugin id '${expectedPrefix}': ${contribution.id}`,
        );
      }
    }
  }
  return errors;
}

function validateSemantics(manifest: PluginManifest): string[] {
  const errors = [
    ...findDuplicateIds(manifest),
    ...validateOwnedContributionIds(manifest),
  ];
  for (const [engine, range] of Object.entries(manifest.engines)) {
    if (validRange(range) === null) {
      errors.push(`Invalid ${engine} engine semver range: ${range}`);
    }
  }
  if (valid(manifest.version) === null) {
    errors.push(`Invalid plugin semantic version: ${manifest.version}`);
  }

  const requiredFeatures = new Set(manifest.features?.required ?? []);
  for (const feature of manifest.features?.optional ?? []) {
    if (requiredFeatures.has(feature)) {
      errors.push(`Feature cannot be both required and optional: ${feature}`);
    }
  }

  const companionPaths = new Set<string>();
  for (const companion of manifest.companionExecutables ?? []) {
    const companionPlatforms = new Set<string>();
    for (const variant of companion.variants) {
      if (companionPaths.has(variant.path)) {
        errors.push(`Duplicate companion executable path: ${variant.path}`);
      }
      companionPaths.add(variant.path);
      for (const platform of variant.platforms) {
        if (companionPlatforms.has(platform)) {
          errors.push(`Duplicate companion platform for ${companion.id}: ${platform}`);
        }
        companionPlatforms.add(platform);
      }
    }
  }
  const requiredPermissions = new Set(
    (manifest.permissions?.required ?? []).map(permissionName),
  );
  if (requiredPermissions.size !== (manifest.permissions?.required ?? []).length) {
    errors.push("Required permissions must not contain duplicate permission names");
  }
  const optionalPermissions = new Set(
    (manifest.permissions?.optional ?? []).map(permissionName),
  );
  if (optionalPermissions.size !== (manifest.permissions?.optional ?? []).length) {
    errors.push("Optional permissions must not contain duplicate permission names");
  }
  const declaredPermissions = new Set([
    ...requiredPermissions,
    ...optionalPermissions,
  ]);
  for (const declaration of manifest.permissions?.optional ?? []) {
    const permission = permissionName(declaration);
    if (requiredPermissions.has(permission)) {
      errors.push(`Permission cannot be both required and optional: ${permission}`);
    }
  }

  const requirePermission = (condition: boolean, permission: PluginPermission, reason: string) => {
    if (condition && !declaredPermissions.has(permission)) {
      errors.push(`${reason} requires declared permission: ${permission}`);
    }
  };
  requirePermission(
    Boolean(manifest.contributes?.settings?.length),
    "settings.read",
    "Setting contributions",
  );
  requirePermission(
    Boolean(manifest.contributes?.commands?.length),
    "commands",
    "Command contributions",
  );
  requirePermission(Boolean(manifest.contributes?.menus?.length), "menus", "Menu contributions");
  requirePermission(Boolean(manifest.contributes?.views?.length), "views", "View contributions");
  requirePermission(
    Boolean(manifest.companionExecutables?.length),
    "companion.execute",
    "Companion executables",
  );
  const providerPermissions = new Map<string, readonly PluginPermission[]>([
    ["terminal.completion", ["provider.terminal", "terminal.complete"]],
    ["terminal.decoration", ["provider.terminal", "terminal.output", "terminal.decorate"]],
    ["terminal.link", ["provider.terminal", "terminal.output", "terminal.decorate"]],
    ["terminal.hover", ["provider.terminal", "terminal.output", "terminal.decorate"]],
    ["terminal.matcher", ["provider.terminal", "terminal.output", "terminal.decorate"]],
    ["terminal.semantic", ["provider.terminal", "terminal.output", "terminal.decorate"]],
    ["terminal.prompt", ["provider.terminal", "terminal.output", "terminal.decorate"]],
    ["terminal.background", ["provider.terminal", "terminal.decorate"]],
    ["terminal.interceptor.input", ["provider.terminal", "terminal.intercept.input"]],
    ["terminal.interceptor.output", ["provider.terminal", "terminal.intercept.output"]],
    ["connection", ["provider.connection"]],
    ["authentication", ["provider.authentication"]],
    ["sync", ["provider.sync"]],
    ["importer", ["provider.importer"]],
  ]);
  for (const provider of manifest.contributes?.providers ?? []) {
    for (const permission of providerPermissions.get(provider.kind) ?? ["provider.terminal"]) {
      requirePermission(true, permission, `Provider ${provider.id}`);
    }
  }
  for (const companion of manifest.companionExecutables ?? []) {
    for (const permission of companion.permissions ?? []) {
      requirePermission(
        true,
        permission,
        `Companion executable ${companion.id}`,
      );
    }
  }

  const commandIds = new Set((manifest.contributes?.commands ?? []).map(({ id }) => id));
  const viewIds = new Set((manifest.contributes?.views ?? []).map(({ id }) => id));
  const providerIds = new Set((manifest.contributes?.providers ?? []).map(({ id }) => id));
  for (const menu of manifest.contributes?.menus ?? []) {
    if (!commandIds.has(menu.command)) {
      errors.push(`Menu references an undeclared command: ${menu.command}`);
    }
    if (menu.alt && !commandIds.has(menu.alt)) {
      errors.push(`Menu references an undeclared alternate command: ${menu.alt}`);
    }
  }
  for (const keybinding of manifest.contributes?.keybindings ?? []) {
    if (!commandIds.has(keybinding.command)) {
      errors.push(`Keybinding references an undeclared command: ${keybinding.command}`);
    }
  }
  for (const activationEvent of manifest.activationEvents ?? []) {
    const targets = [
      ["onCommand:", "command", commandIds],
      ["onView:", "view", viewIds],
      ["onProvider:", "provider", providerIds],
    ] as const;
    for (const [prefix, kind, ids] of targets) {
      if (activationEvent.startsWith(prefix)) {
        const id = activationEvent.slice(prefix.length);
        if (!ids.has(id)) errors.push(`Activation event references an undeclared ${kind}: ${id}`);
      }
    }
  }

  for (const setting of manifest.contributes?.settings ?? []) {
    if (setting.secret && setting.default !== undefined) {
      errors.push(`Secret setting must not declare a default value: ${setting.id}`);
    }
    if (["radio", "select", "multiselect"].includes(setting.control)
      && !setting.options?.length) {
      errors.push(`${setting.control} setting requires options: ${setting.id}`);
    }
    const optionValues = new Set<string>();
    for (const option of setting.options ?? []) {
      if (optionValues.has(option.value)) {
        errors.push(`${setting.control} setting has duplicate option value '${option.value}': ${setting.id}`);
      }
      optionValues.add(option.value);
    }
    if (!["radio", "select", "multiselect"].includes(setting.control)
      && setting.options !== undefined) {
      errors.push(`${setting.control} setting must not declare options: ${setting.id}`);
    }
    if (["number", "slider"].includes(setting.control) && setting.minimum !== undefined
      && setting.maximum !== undefined && setting.minimum > setting.maximum) {
      errors.push(`${setting.control} setting minimum exceeds maximum: ${setting.id}`);
    }
    if (setting.control === "slider"
      && (setting.minimum === undefined || setting.maximum === undefined)) {
      errors.push(`slider setting requires minimum and maximum: ${setting.id}`);
    }
    if (!["number", "slider"].includes(setting.control)
      && (setting.minimum !== undefined
        || setting.maximum !== undefined
        || setting.step !== undefined)) {
      errors.push(`${setting.control} setting must not declare numeric bounds: ${setting.id}`);
    }
    if (setting.pattern !== undefined
      && !["text", "textarea", "password"].includes(setting.control)) {
      errors.push(`${setting.control} setting must not declare a text pattern: ${setting.id}`);
    }
    if (setting.pattern !== undefined) {
      try {
        new RegExp(setting.pattern);
      } catch {
        errors.push(`${setting.control} setting has an invalid pattern: ${setting.id}`);
      }
    }
    if (setting.control === "password" && !setting.secret) {
      errors.push(`password setting must be marked secret: ${setting.id}`);
    }
    if (setting.secret && setting.control !== "password") {
      errors.push(`Secret setting must use the password control: ${setting.id}`);
    }
    if (setting.secret && setting.sync) {
      errors.push(`Secret setting must not be cloud-synced: ${setting.id}`);
    }
    if (setting.sync && ["device", "session"].includes(setting.scope)) {
      errors.push(`${setting.scope}-scoped setting must not be cloud-synced: ${setting.id}`);
    }
    if (setting.sync && ["file", "directory"].includes(setting.control)) {
      errors.push(`${setting.control} setting paths must not be cloud-synced: ${setting.id}`);
    }
    if (["list", "table"].includes(setting.control) && setting.valueSchema === undefined) {
      errors.push(`${setting.control} setting requires valueSchema: ${setting.id}`);
    }
    if (!["list", "table"].includes(setting.control) && setting.valueSchema !== undefined) {
      errors.push(`${setting.control} setting must not declare valueSchema: ${setting.id}`);
    }
    if (!["list", "table"].includes(setting.control) && setting.sortable) {
      errors.push(`${setting.control} setting must not be sortable: ${setting.id}`);
    }
    if (setting.default !== undefined) {
      const stringControls = [
        "radio",
        "select",
        "text",
        "textarea",
        "password",
        "color",
        "font",
        "file",
        "directory",
        "keybinding",
      ];
      if (setting.control === "switch" && typeof setting.default !== "boolean") {
        errors.push(`switch setting default must be boolean: ${setting.id}`);
      }
      if (stringControls.includes(setting.control) && typeof setting.default !== "string") {
        errors.push(`${setting.control} setting default must be a string: ${setting.id}`);
      }
      if (["number", "slider"].includes(setting.control)
        && (typeof setting.default !== "number" || !Number.isFinite(setting.default))) {
        errors.push(`${setting.control} setting default must be a finite number: ${setting.id}`);
      }
      if (["list", "table"].includes(setting.control) && !Array.isArray(setting.default)) {
        errors.push(`${setting.control} setting default must be an array: ${setting.id}`);
      }
      if (setting.control === "multiselect") {
        if (!Array.isArray(setting.default)
          || setting.default.some((value) => typeof value !== "string")) {
          errors.push(`multiselect setting default must be a string array: ${setting.id}`);
        } else {
          const selected = new Set<string>();
          for (const value of setting.default as string[]) {
            if (!optionValues.has(value)) {
              errors.push(`multiselect setting default uses an undeclared option '${value}': ${setting.id}`);
            }
            if (selected.has(value)) {
              errors.push(`multiselect setting default repeats option '${value}': ${setting.id}`);
            }
            selected.add(value);
          }
        }
      }
      if (["radio", "select"].includes(setting.control)
        && typeof setting.default === "string"
        && !optionValues.has(setting.default)) {
        errors.push(`${setting.control} setting default uses an undeclared option '${setting.default}': ${setting.id}`);
      }
      if (typeof setting.default === "number" && Number.isFinite(setting.default)) {
        if (setting.minimum !== undefined && setting.default < setting.minimum) {
          errors.push(`${setting.control} setting default is below minimum: ${setting.id}`);
        }
        if (setting.maximum !== undefined && setting.default > setting.maximum) {
          errors.push(`${setting.control} setting default is above maximum: ${setting.id}`);
        }
        if (setting.step !== undefined) {
          const offset = setting.default - (setting.minimum ?? 0);
          const steps = offset / setting.step;
          if (Math.abs(steps - Math.round(steps)) > 1e-9) {
            errors.push(`${setting.control} setting default does not align to step: ${setting.id}`);
          }
        }
      }
    }
  }

  for (const entryPath of [
    manifest.main.browser,
    manifest.main.node,
    ...(manifest.contributes?.views ?? []).map(({ entry }) => entry),
    ...(manifest.contributes?.commands ?? []).flatMap(({ icon }) => packageIconPaths(icon)),
    ...(manifest.contributes?.menus ?? []).flatMap(({ icon }) => packageIconPaths(icon)),
    ...(manifest.contributes?.views ?? []).flatMap(({ icon }) => packageIconPaths(icon)),
    ...(manifest.companionExecutables ?? []).flatMap(({ variants }) => (
      variants.map(({ path: companionPath }) => companionPath)
    )),
  ]) {
    if (entryPath) {
      try {
        assertSafePackagePath(entryPath);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
  return errors;
}

function packageIconPaths(icon: IconReference | undefined): string[] {
  if (icon?.kind !== "package") return [];
  return icon.dark
    ? [icon.light, icon.dark]
    : [icon.light];
}

export function validateManifestValue(value: unknown): ManifestValidationResult {
  try {
    assertManifestJsonStructure(value);
  } catch (error) {
    return {
      valid: false,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
  if (!validateSchema(value)) {
    return {
      valid: false,
      errors: (validateSchema.errors ?? []).map(formatAjvError),
    };
  }
  const semanticErrors = validateSemantics(value);
  return semanticErrors.length === 0
    ? { valid: true, manifest: value, errors: [] }
    : { valid: false, errors: semanticErrors };
}

export function parseAndValidateManifestContents(contents: Uint8Array): PluginManifest {
  if (contents.byteLength > PACKAGE_LIMITS.manifestBytes) {
    throw new Error(`Plugin manifest exceeds ${PACKAGE_LIMITS.manifestBytes} bytes`);
  }
  let value: unknown;
  try {
    value = JSON.parse(utf8Decoder.decode(contents));
  } catch (error) {
    throw new Error(
      `Plugin manifest is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = validateManifestValue(value);
  if (!result.valid || !result.manifest) {
    throw new Error(`Plugin manifest is invalid:\n- ${result.errors.join("\n- ")}`);
  }
  return result.manifest;
}

export async function readValidatedManifestSource(
  pluginDirectory: string,
): Promise<ValidatedManifestSource> {
  const manifestPath = path.join(pluginDirectory, "netcatty.plugin.json");
  const initialStats = await lstat(manifestPath);
  if (!initialStats.isFile()) {
    throw new Error("Plugin manifest must be a regular file");
  }
  if (initialStats.size > PACKAGE_LIMITS.manifestBytes) {
    throw new Error(`Plugin manifest exceeds ${PACKAGE_LIMITS.manifestBytes} bytes`);
  }
  const handle = await open(manifestPath, "r");
  let contents: Uint8Array;
  try {
    const [openedStats, currentStats] = await Promise.all([
      handle.stat(),
      lstat(manifestPath),
    ]);
    if (!openedStats.isFile() || !currentStats.isFile()) {
      throw new Error("Plugin manifest must be a regular file");
    }
    if (openedStats.dev !== currentStats.dev || openedStats.ino !== currentStats.ino) {
      throw new Error("Plugin manifest changed while being opened");
    }
    if (openedStats.size > PACKAGE_LIMITS.manifestBytes) {
      throw new Error(`Plugin manifest exceeds ${PACKAGE_LIMITS.manifestBytes} bytes`);
    }
    const buffer = new Uint8Array(PACKAGE_LIMITS.manifestBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.byteLength) {
      const result = await handle.read(
        buffer,
        bytesRead,
        buffer.byteLength - bytesRead,
        null,
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > PACKAGE_LIMITS.manifestBytes) {
      throw new Error(`Plugin manifest exceeds ${PACKAGE_LIMITS.manifestBytes} bytes`);
    }
    contents = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  return {
    manifest: parseAndValidateManifestContents(contents),
    size: contents.byteLength,
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

export async function readAndValidateManifest(
  pluginDirectory: string,
): Promise<PluginManifest> {
  return (await readValidatedManifestSource(pluginDirectory)).manifest;
}
