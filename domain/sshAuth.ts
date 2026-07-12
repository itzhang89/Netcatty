import type { Host, Identity, SSHKey } from "./models";
import { sanitizeCredentialValue } from "./credentials";

type HostAuthMethod = "password" | "key" | "certificate";

type HostAuthOverride = {
  authMethod?: HostAuthMethod;
  username?: string;
  password?: string;
  keyId?: string;
  passphrase?: string;
};

type ResolvedHostAuth = {
  identity?: Identity;
  authMethod: HostAuthMethod;
  username: string;
  password?: string;
  keyId?: string;
  key?: SSHKey;
  passphrase?: string;
  identityFilePath?: string;
};

const inferAuthMethod = (opts: {
  explicit?: HostAuthMethod;
  keyId?: string;
  password?: string;
  hostAuthMethod?: HostAuthMethod;
  key?: SSHKey;
}): HostAuthMethod => {
  if (opts.explicit) return opts.explicit;
  if (opts.keyId) {
    if (opts.hostAuthMethod === "key" || opts.hostAuthMethod === "certificate") {
      return opts.hostAuthMethod;
    }
    return opts.key?.certificate ? "certificate" : "key";
  }
  if (opts.hostAuthMethod) return opts.hostAuthMethod;
  if (opts.password) return "password";
  return "password";
};

export const resolveHostAuth = (args: {
  host: Host;
  keys: SSHKey[];
  identities?: Identity[];
  override?: HostAuthOverride | null;
}): ResolvedHostAuth => {
  const { host, keys, identities = [], override } = args;

  const identity = host.identityId
    ? identities.find((i) => i.id === host.identityId)
    : undefined;

  const username =
    override?.username?.trim() ||
    identity?.username?.trim() ||
    host.username?.trim() ||
    "";

  const selectedAuthMethod = (
    override?.authMethod ||
    identity?.authMethod ||
    host.authMethod
  ) as HostAuthMethod | undefined;

  // Don't load key when password auth is selected.
  // This ensures the user's auth method selection is strictly respected.
  const keyId = selectedAuthMethod === "password"
    ? undefined
    : (override?.keyId || identity?.keyId || host.identityFileId || undefined);


  const key = keyId ? keys.find((k) => k.id === keyId) : undefined;

  const password = override?.password ?? identity?.password ?? host.password;

  const authMethod = inferAuthMethod({
    explicit: override?.authMethod,
    hostAuthMethod: (identity?.authMethod || host.authMethod) as HostAuthMethod | undefined,
    keyId,
    password,
    key,
  });

  const passphrase = override?.passphrase || key?.passphrase || undefined;

  const identityFilePath = key?.source === 'reference' && key.filePath
    ? key.filePath
    : undefined;

  return {
    identity,
    authMethod,
    username,
    password,
    keyId,
    key,
    passphrase,
    identityFilePath,
  };
};

/**
 * Resolve the password to use for sudo autofill the same way SSH login does
 * (through resolveHostAuth), so a password stored in a referenced Keychain
 * identity (host.identityId) is found — not just host.password (issue #1284).
 * Returns undefined when the host opts out of saving its password, or none is
 * available (pure key auth, or an undecryptable placeholder).
 */
export const resolveHostAutofillPassword = (args: {
  host: Host;
  keys: SSHKey[];
  identities?: Identity[];
}): string | undefined => {
  if (args.host.savePassword === false) return undefined;
  return sanitizeCredentialValue(resolveHostAuth(args).password) || undefined;
};

export const resolveBridgeKeyAuth = (args: {
  key?: SSHKey | null;
  fallbackIdentityFilePaths?: string[];
  passphrase?: string;
}): {
  privateKey?: string;
  identityFilePaths?: string[];
  passphrase?: string;
} => {
  const { key, fallbackIdentityFilePaths, passphrase } = args;
  const identityFilePaths = key?.source === "reference" && key.filePath
    ? [key.filePath]
    : fallbackIdentityFilePaths;

  return {
    privateKey: key?.source === "reference" ? undefined : sanitizeCredentialValue(key?.privateKey),
    identityFilePaths,
    passphrase: sanitizeCredentialValue(passphrase ?? key?.passphrase),
  };
};

export const resolveBridgeSshAgentAuth = (
  host: Pick<Host, "useSshAgent" | "identityAgent" | "identitiesOnly" | "addKeysToAgent" | "useKeychain">,
  key?: Pick<SSHKey, "certificate" | "publicKey">,
): {
  useSshAgent?: boolean;
  identityAgent?: string;
  identitiesOnly?: boolean;
  addKeysToAgent?: string;
  useKeychain?: boolean;
  agentPublicKeys?: string[];
} => {
  if (key?.certificate?.trim()) return {};
  if (host.useSshAgent !== true) return { useSshAgent: false };
  return {
    useSshAgent: true,
    identityAgent: host.identityAgent,
    identitiesOnly: host.identitiesOnly,
    addKeysToAgent: host.addKeysToAgent,
    useKeychain: host.useKeychain,
    ...(key?.publicKey?.trim() ? { agentPublicKeys: [key.publicKey] } : {}),
  };
};

export const hasMacKeychainAgentDirectives = (
  host: Pick<Host, "addKeysToAgent" | "useKeychain">,
): boolean => host.useKeychain === true
  && host.addKeysToAgent?.toLowerCase() === "yes";

export const hasBridgeSshCredentials = (auth: {
  password?: string;
  privateKey?: string;
  identityFilePaths?: string[];
  useSshAgent?: boolean;
}): boolean => Boolean(
  auth.password ||
  auth.privateKey ||
  auth.identityFilePaths?.length ||
  auth.useSshAgent,
);
