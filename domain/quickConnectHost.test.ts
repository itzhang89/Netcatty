import assert from "node:assert/strict";
import test from "node:test";
import {
  buildQuickConnectHost,
  isQuickConnectIdentityUsable,
} from "./quickConnectHost.ts";
import { resolveHostAuth } from "./sshAuth.ts";

test("quick connect keeps a selected credential preset as the host identity", () => {
  const host = buildQuickConnectHost({
    id: "quick-1",
    createdAt: 123,
    target: { hostname: "192.0.2.10" },
    protocol: "ssh",
    port: 22,
    username: "root",
    authMethod: "password",
    password: "must-not-be-copied",
    selectedIdentityId: "identity-root",
  });

  assert.equal(host.identityId, "identity-root");
  assert.equal(host.username, "root");
  assert.equal(host.authMethod, "password");
  assert.equal(host.password, undefined);
  assert.equal(host.identityFileId, undefined);
  assert.equal(host.ephemeral, true);

  const resolved = resolveHostAuth({
    host,
    keys: [],
    identities: [{
      id: "identity-root",
      label: "Root",
      username: "root",
      authMethod: "password",
      password: "resolved-secret",
      created: 1,
    }],
  });
  assert.equal(resolved.password, "resolved-secret");
});

test("quick connect only offers one-click connection for usable credential presets", () => {
  assert.equal(isQuickConnectIdentityUsable({
    id: "password",
    label: "Root",
    username: "root",
    authMethod: "password",
    password: "secret",
    created: 1,
  }, []), true);

  assert.equal(isQuickConnectIdentityUsable({
    id: "missing-key",
    label: "Deploy",
    username: "deploy",
    authMethod: "key",
    keyId: "key-that-is-not-here",
    created: 2,
  }, []), false);

  assert.equal(isQuickConnectIdentityUsable({
    id: "telnet-key",
    label: "Network key",
    username: "admin",
    authMethod: "key",
    keyId: "key-1",
    created: 3,
  }, [{
    id: "key-1",
    label: "Key",
    type: "ED25519",
    privateKey: "private",
    source: "imported",
    category: "key",
    created: 3,
  }], "telnet"), false);
});

test("quick connect preserves manually entered password authentication", () => {
  const host = buildQuickConnectHost({
    id: "quick-2",
    createdAt: 456,
    target: { hostname: "example.test" },
    protocol: "ssh",
    port: 2222,
    username: "operator",
    authMethod: "password",
    password: "manual-secret",
  });

  assert.equal(host.identityId, undefined);
  assert.equal(host.username, "operator");
  assert.equal(host.password, "manual-secret");
  assert.equal(host.port, 2222);
  assert.equal(host.ephemeral, undefined);
});
