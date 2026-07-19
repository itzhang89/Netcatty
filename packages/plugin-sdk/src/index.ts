import type {
  CredentialRef,
  FeatureId,
  JsonValue,
  PluginErrorData,
  PluginErrorName,
  PluginId,
  PluginWireErrorCode,
  RpcErrorObject,
  SecretLeaseRef,
  SecretRef,
  SemanticVersion,
} from "@netcatty/plugin-contract";

export type * from "@netcatty/plugin-contract";

export interface Disposable {
  dispose(): void;
}

export type CancellationListener = () => void;

export interface CancellationToken {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: CancellationListener): Disposable;
}

export interface PluginLogger {
  debug(message: string, fields?: Readonly<Record<string, JsonValue>>): void;
  info(message: string, fields?: Readonly<Record<string, JsonValue>>): void;
  warn(message: string, fields?: Readonly<Record<string, JsonValue>>): void;
  error(message: string, fields?: Readonly<Record<string, JsonValue>>): void;
}

export interface PluginKeyValueStore {
  get<T extends JsonValue>(key: string): Promise<T | undefined>;
  set(key: string, value: JsonValue): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<readonly string[]>;
}

export interface PluginSecretStore {
  get(key: string): Promise<SecretRef | undefined>;
  set(key: string, value: string): Promise<SecretRef>;
  delete(key: string): Promise<void>;
}

export interface PluginCredentialLeaseOptions {
  readonly operationId: string;
  readonly purpose: string;
  readonly ttlMs?: number;
}

export interface PluginCredentialBroker {
  createLease(credential: SecretRef | CredentialRef, options: PluginCredentialLeaseOptions): Promise<SecretLeaseRef>;
}

export interface PluginNetworkRequest {
  readonly url: string;
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Readonly<{ encoding: "utf8" | "base64"; data: string }>;
  readonly timeoutMs?: number;
}

export interface PluginNetworkResponse {
  readonly url: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Readonly<{ encoding: "base64"; data: string }>;
}

export interface PluginNetworkClient {
  request(request: PluginNetworkRequest): Promise<PluginNetworkResponse>;
}

export interface PluginFilesystemEntry {
  readonly name: string;
  readonly kind: "file" | "directory" | "other";
}

export interface PluginFilesystemStat {
  readonly kind: "file" | "directory" | "other";
  readonly size: number;
  readonly modifiedAt: number;
}

export interface PluginFilesystemClient {
  readFile(path: string, options?: Readonly<{ encoding?: "utf8" | "base64"; maxBytes?: number }>): Promise<string>;
  writeFile(path: string, data: string, options?: Readonly<{ encoding?: "utf8" | "base64"; overwrite?: boolean }>): Promise<void>;
  stat(path: string): Promise<PluginFilesystemStat>;
  readDirectory(path: string): Promise<readonly PluginFilesystemEntry[]>;
}

export interface PluginCompanionRequestOptions {
  readonly timeoutMs?: number;
}

export interface PluginCompanionHandle extends Disposable {
  readonly id: string;
  request<T extends JsonValue = JsonValue>(
    method: string,
    params?: JsonValue,
    options?: PluginCompanionRequestOptions,
  ): Promise<T>;
  stop(): Promise<void>;
}

export interface PluginCompanionService {
  start(companionId: string): Promise<PluginCompanionHandle>;
}

export interface PluginContext {
  readonly pluginId: PluginId;
  readonly netcattyVersion: SemanticVersion;
  readonly apiVersion: SemanticVersion;
  readonly enabledFeatures: ReadonlySet<FeatureId>;
  readonly subscriptions: DisposableStore;
  readonly storage: PluginKeyValueStore;
  readonly secrets: PluginSecretStore;
  readonly credentials: PluginCredentialBroker;
  readonly network: PluginNetworkClient;
  readonly filesystem: PluginFilesystemClient;
  readonly companions: PluginCompanionService;
  readonly logger: PluginLogger;
}

export interface NetcattyPlugin {
  activate(context: PluginContext): void | Disposable | Promise<void | Disposable>;
  deactivate?(): void | Promise<void>;
}

export type PluginErrorCode = PluginErrorName;

export const PLUGIN_ERROR_WIRE_CODES = {
  cancelled: -32001,
  unknown: -32002,
  invalid_argument: -32003,
  deadline_exceeded: -32004,
  not_found: -32005,
  already_exists: -32006,
  permission_denied: -32007,
  resource_exhausted: -32008,
  failed_precondition: -32009,
  aborted: -32010,
  out_of_range: -32011,
  unsupported: -32012,
  internal: -32013,
  unavailable: -32014,
  data_loss: -32015,
  unauthenticated: -32016,
} as const satisfies Readonly<Record<PluginErrorCode, PluginWireErrorCode>>;

export class PluginError extends Error {
  readonly code: PluginErrorCode;
  readonly details?: JsonValue;

  constructor(code: PluginErrorCode, message: string, details?: JsonValue) {
    super(message);
    this.name = "PluginError";
    this.code = code;
    this.details = details;
  }
}

export function pluginErrorToRpcError(error: PluginError): RpcErrorObject {
  const data: PluginErrorData = error.details === undefined
    ? { pluginCode: error.code }
    : { pluginCode: error.code, details: error.details };
  return {
    code: PLUGIN_ERROR_WIRE_CODES[error.code],
    message: error.message,
    data,
  };
}

export class CancellationError extends PluginError {
  constructor(message = "The operation was cancelled") {
    super("cancelled", message);
    this.name = "CancellationError";
  }
}

export class DisposableStore implements Disposable {
  readonly #items = new Set<Disposable>();
  #isDisposed = false;

  get isDisposed(): boolean {
    return this.#isDisposed;
  }

  add<T extends Disposable>(disposable: T): T {
    if (this.#isDisposed) {
      disposable.dispose();
      throw new PluginError("unavailable", "Cannot add to a disposed DisposableStore");
    }
    this.#items.add(disposable);
    return disposable;
  }

  delete(disposable: Disposable): boolean {
    return this.#items.delete(disposable);
  }

  clear(): void {
    const items = [...this.#items];
    this.#items.clear();
    const errors: unknown[] = [];
    for (const item of items) {
      try {
        item.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "One or more plugin disposables failed");
    }
  }

  dispose(): void {
    if (this.#isDisposed) return;
    this.#isDisposed = true;
    this.clear();
  }
}

class MutableCancellationToken implements CancellationToken {
  readonly #listeners = new Set<CancellationListener>();
  #isCancellationRequested = false;

  get isCancellationRequested(): boolean {
    return this.#isCancellationRequested;
  }

  onCancellationRequested(listener: CancellationListener): Disposable {
    if (this.#isCancellationRequested) {
      queueMicrotask(listener);
      return { dispose() {} };
    }
    this.#listeners.add(listener);
    return {
      dispose: () => {
        this.#listeners.delete(listener);
      },
    };
  }

  cancel(): void {
    if (this.#isCancellationRequested) return;
    this.#isCancellationRequested = true;
    const listeners = [...this.#listeners];
    this.#listeners.clear();
    const errors: unknown[] = [];
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "One or more cancellation listeners failed");
    }
  }

  dispose(): void {
    this.#listeners.clear();
  }
}

export class CancellationTokenSource implements Disposable {
  readonly #token = new MutableCancellationToken();
  #isDisposed = false;

  get token(): CancellationToken {
    return this.#token;
  }

  cancel(): void {
    if (!this.#isDisposed) this.#token.cancel();
  }

  dispose(cancel = false): void {
    if (this.#isDisposed) return;
    try {
      if (cancel) this.#token.cancel();
    } finally {
      this.#token.dispose();
      this.#isDisposed = true;
    }
  }
}

export function definePlugin<T extends NetcattyPlugin>(plugin: T): T {
  return plugin;
}

export function throwIfCancellationRequested(token: CancellationToken): void {
  if (token.isCancellationRequested) throw new CancellationError();
}
