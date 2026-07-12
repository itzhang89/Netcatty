import { sanitizeCredentialValue } from "./credentials";
import type { Host, Identity, SSHKey } from "./models";
import type { QuickConnectTarget } from "./quickConnect";

export type QuickConnectProtocol = "ssh" | "mosh" | "telnet";
export type QuickConnectAuthMethod = "password" | "key" | "certificate";

export const isQuickConnectIdentityUsable = (
  identity: Identity | undefined,
  keys: SSHKey[],
  protocol: QuickConnectProtocol = "ssh",
): boolean => {
  if (!identity?.username.trim()) return false;
  if (protocol === "telnet" && identity.authMethod !== "password") return false;
  if (identity.authMethod === "password") {
    return Boolean(sanitizeCredentialValue(identity.password));
  }
  return Boolean(identity.keyId && keys.some((key) => key.id === identity.keyId));
};

type BuildQuickConnectHostInput = {
  id: string;
  createdAt: number;
  target: QuickConnectTarget;
  protocol: QuickConnectProtocol;
  port: number;
  username: string;
  authMethod: QuickConnectAuthMethod;
  password?: string;
  selectedKeyId?: string | null;
  selectedIdentityId?: string | null;
};

export const buildQuickConnectHost = ({
  id,
  createdAt,
  target,
  protocol,
  port,
  username,
  authMethod,
  password,
  selectedKeyId,
  selectedIdentityId,
}: BuildQuickConnectHostInput): Host => {
  const usesIdentity = Boolean(selectedIdentityId);
  const isTelnet = protocol === "telnet";

  return {
    id,
    label: target.hostname,
    hostname: target.hostname,
    port,
    username,
    group: "",
    tags: [],
    os: "linux",
    protocol: protocol === "mosh" ? "ssh" : protocol,
    authMethod,
    ...(usesIdentity ? { ephemeral: true } : {}),
    ...(usesIdentity && !isTelnet ? { identityId: selectedIdentityId! } : {}),
    ...(usesIdentity && isTelnet ? { telnetIdentityId: selectedIdentityId! } : {}),
    ...(!usesIdentity && authMethod === "password" ? { password } : {}),
    ...(!usesIdentity && authMethod !== "password" && selectedKeyId
      ? { identityFileId: selectedKeyId }
      : {}),
    moshEnabled: protocol === "mosh",
    telnetEnabled: isTelnet,
    telnetPort: isTelnet ? port : undefined,
    createdAt,
  };
};
