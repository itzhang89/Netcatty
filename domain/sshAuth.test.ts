import test from "node:test";
import assert from "node:assert/strict";

import { hasBridgeSshCredentials, resolveBridgeKeyAuth, resolveBridgeSshAgentAuth, resolveHostAuth, resolveHostAutofillPassword } from "./sshAuth.ts";
import type { Host, Identity, SSHKey } from "./models.ts";

const referenceKey: SSHKey = {
  id: "key-1",
  label: "Reference key",
  type: "ED25519",
  privateKey: "",
  source: "reference",
  category: "key",
  created: 1,
  filePath: "/Users/alice/.ssh/id_ed25519",
};

test("resolveBridgeKeyAuth passes reference keys as identity file paths", () => {
  assert.deepEqual(
    resolveBridgeKeyAuth({
      key: referenceKey,
      fallbackIdentityFilePaths: ["/legacy/key"],
      passphrase: "saved-passphrase",
    }),
    {
      privateKey: undefined,
      identityFilePaths: ["/Users/alice/.ssh/id_ed25519"],
      passphrase: "saved-passphrase",
    },
  );
});

test("resolveBridgeKeyAuth ignores undecryptable passphrase placeholders", () => {
  assert.equal(
    resolveBridgeKeyAuth({
      key: {
        ...referenceKey,
        passphrase: "enc:v1:djEwAAAA",
      },
    }).passphrase,
    undefined,
  );
});

test("resolveBridgeKeyAuth ignores undecryptable private key placeholders", () => {
  assert.equal(
    resolveBridgeKeyAuth({
      key: {
        ...referenceKey,
        source: "imported",
        filePath: undefined,
        privateKey: "enc:v1:djEwAAAA",
      },
    }).privateKey,
    undefined,
  );
});

test("resolveBridgeKeyAuth preserves imported key material", () => {
  const importedKey: SSHKey = {
    ...referenceKey,
    source: "imported",
    privateKey: "PRIVATE KEY",
    filePath: undefined,
  };

  assert.deepEqual(
    resolveBridgeKeyAuth({
      key: importedKey,
      fallbackIdentityFilePaths: ["/legacy/key"],
    }),
    {
      privateKey: "PRIVATE KEY",
      identityFilePaths: ["/legacy/key"],
      passphrase: undefined,
    },
  );
});

test("resolveBridgeSshAgentAuth carries system agent settings without private material", () => {
  assert.deepEqual(
    resolveBridgeSshAgentAuth({
      ...autofillBaseHost,
      useSshAgent: true,
      identityAgent: "$SSH_AUTH_SOCK",
      identitiesOnly: true,
      addKeysToAgent: "yes",
      useKeychain: true,
    }),
    {
      useSshAgent: true,
      identityAgent: "$SSH_AUTH_SOCK",
      identitiesOnly: true,
      addKeysToAgent: "yes",
      useKeychain: true,
    },
  );
});

test("resolveBridgeSshAgentAuth keeps certificate authentication independent", () => {
  assert.deepEqual(
    resolveBridgeSshAgentAuth({
      ...autofillBaseHost,
      useSshAgent: true,
    }, { certificate: "ssh-ed25519-cert-v01@openssh.com AAAATEST" }),
    {},
  );
});

test("resolveBridgeSshAgentAuth forwards a selected vault public key", () => {
  assert.deepEqual(
    resolveBridgeSshAgentAuth({
      ...autofillBaseHost,
      useSshAgent: true,
      identitiesOnly: true,
    }, { publicKey: "ssh-ed25519 AAAATEST" }),
    {
      useSshAgent: true,
      identityAgent: undefined,
      identitiesOnly: true,
      addKeysToAgent: undefined,
      useKeychain: undefined,
      agentPublicKeys: ["ssh-ed25519 AAAATEST"],
    },
  );
});

test("resolveBridgeSshAgentAuth preserves an explicit agent opt-out", () => {
  assert.deepEqual(
    resolveBridgeSshAgentAuth({
      ...autofillBaseHost,
      useSshAgent: false,
      identityAgent: "none",
    }),
    { useSshAgent: false },
  );
});

test("resolveBridgeSshAgentAuth treats an unset agent toggle as disabled", () => {
  assert.deepEqual(
    resolveBridgeSshAgentAuth(autofillBaseHost),
    { useSshAgent: false },
  );
});

test("hasBridgeSshCredentials accepts an agent-only host", () => {
  assert.equal(hasBridgeSshCredentials({ useSshAgent: true }), true);
  assert.equal(hasBridgeSshCredentials({}), false);
});

test("resolveHostAuth respects password auth over stale key selections", () => {
  const host: Host = {
    id: "host-1",
    label: "Host",
    hostname: "example.com",
    username: "root",
    authMethod: "password",
    identityFileId: "key-1",
  };

  const resolved = resolveHostAuth({
    host,
    keys: [referenceKey],
    identities: [],
  });

  assert.equal(resolved.authMethod, "password");
  assert.equal(resolved.key, undefined);
  assert.equal(resolved.keyId, undefined);
});

const autofillBaseHost = {
  id: "h1",
  label: "Host",
  hostname: "h.example.test",
  username: "alice",
} as Host;

test("resolveHostAutofillPassword uses the host's own saved password", () => {
  assert.equal(
    resolveHostAutofillPassword({ host: { ...autofillBaseHost, password: "direct-secret" }, keys: [] }),
    "direct-secret",
  );
});

test("resolveHostAutofillPassword resolves a referenced keychain identity's password", () => {
  // host stores no password of its own; the credential lives in a Keychain
  // identity it references (host.identityId) — the #1284 scenario.
  const identity = {
    id: "id-1",
    label: "alice@prod",
    username: "alice",
    authMethod: "password",
    password: "identity-secret",
    created: 1,
  } as Identity;
  assert.equal(
    resolveHostAutofillPassword({
      host: { ...autofillBaseHost, password: undefined, identityId: "id-1" },
      keys: [],
      identities: [identity],
    }),
    "identity-secret",
  );
});

test("resolveHostAutofillPassword returns undefined when the host opts out of saving", () => {
  assert.equal(
    resolveHostAutofillPassword({ host: { ...autofillBaseHost, password: "x", savePassword: false }, keys: [] }),
    undefined,
  );
});

test("resolveHostAutofillPassword returns undefined when no password is available", () => {
  assert.equal(
    resolveHostAutofillPassword({ host: { ...autofillBaseHost, password: undefined }, keys: [] }),
    undefined,
  );
});

test("resolveHostAutofillPassword ignores undecryptable password placeholders", () => {
  assert.equal(
    resolveHostAutofillPassword({ host: { ...autofillBaseHost, password: "enc:v1:djEwAAAA" }, keys: [] }),
    undefined,
  );
});
