"use strict";

/**
 * Password-only auth must not probe default ~/.ssh keys (issues #266 / #2079).
 * Jump hosts and SFTP share buildAuthHandler; a wrong host password used to
 * look fine on direct terminal (startSession still fell back to id_rsa) while
 * ProxyJump / SFTP failed after password rejection alone.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildAuthHandler } = require("./sshAuthHelper.cjs");

const DEFAULT_KEYS = [
  {
    keyName: "id_ed25519",
    keyPath: "/tmp/id_ed25519",
    privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\ned\n-----END OPENSSH PRIVATE KEY-----\n",
  },
  {
    keyName: "id_rsa",
    keyPath: "/tmp/id_rsa",
    privateKey: "-----BEGIN RSA PRIVATE KEY-----\nrsa\n-----END RSA PRIVATE KEY-----\n",
  },
];

/**
 * Walk the ssh2-style authHandler and collect method labels.
 * Object methods expose type (and sometimes username/key); string methods
 * come from the simple ordered-list path (e.g. password-only).
 */
function collectAuthMethods(authHandler, maxSteps = 16) {
  const labels = [];
  let methodsLeft = null;
  for (let i = 0; i < maxSteps; i += 1) {
    let offered = null;
    authHandler(methodsLeft, false, (method) => {
      offered = method;
    });
    if (offered == null || offered === false) break;
    if (typeof offered === "string") {
      labels.push(offered);
    } else if (offered && typeof offered === "object") {
      labels.push(offered.type || "unknown");
    } else {
      break;
    }
    // Keep all common methods available so the handler can walk its full list.
    methodsLeft = ["publickey", "password", "keyboard-interactive", "agent"];
  }
  return labels;
}

test("buildAuthHandler password-only does not offer default SSH keys (#2079)", () => {
  const auth = buildAuthHandler({
    password: "wrong-or-stale-secret",
    username: "root",
    defaultKeys: DEFAULT_KEYS,
    allowAgentFallback: false,
  });

  const labels = collectAuthMethods(auth.authHandler);
  assert.ok(labels.includes("password"), `expected password; got ${labels.join(",")}`);
  assert.ok(labels.includes("keyboard-interactive"), `expected KI; got ${labels.join(",")}`);
  assert.equal(
    labels.includes("publickey"),
    false,
    `password-only must not probe default keys; offered=${labels.join(",")}`,
  );
  assert.equal(labels.includes("agent"), false);
});

test("buildAuthHandler password-only still fires onAuthAttempt for jump/SFTP progress", () => {
  const attempts = [];
  const auth = buildAuthHandler({
    password: "secret",
    username: "root",
    // Default keys on disk used to force the dynamic path for progress only;
    // after #2079 the simple ordered path must still report attempts.
    defaultKeys: DEFAULT_KEYS,
    allowAgentFallback: false,
    onAuthAttempt: (label) => attempts.push(label),
  });

  collectAuthMethods(auth.authHandler);
  assert.ok(
    attempts.some((label) => label === "password" || label.includes("password")),
    `expected password attempt callback; got ${attempts.join(" | ")}`,
  );
  assert.ok(
    attempts.some((label) => label.includes("keyboard-interactive") || label.includes("exhausted")),
    `expected KI or exhaustion callback; got ${attempts.join(" | ")}`,
  );
  assert.equal(
    attempts.some((label) => /id_rsa|id_ed25519|default/.test(label)),
    false,
    `must not report default-key probes; got ${attempts.join(" | ")}`,
  );
});

test("buildAuthHandler with no credentials still offers default keys", () => {
  const auth = buildAuthHandler({
    username: "root",
    defaultKeys: DEFAULT_KEYS,
    allowAgentFallback: false,
  });

  const labels = collectAuthMethods(auth.authHandler);
  assert.ok(
    labels.includes("publickey"),
    `expected default-key fallback when no explicit auth; offered=${labels.join(",")}`,
  );
});

test("buildAuthHandler key+password still allows default key fallback after user key", () => {
  const auth = buildAuthHandler({
    privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nuser\n-----END OPENSSH PRIVATE KEY-----\n",
    password: "also-have-password",
    username: "root",
    defaultKeys: DEFAULT_KEYS,
    allowAgentFallback: false,
  });

  const labels = collectAuthMethods(auth.authHandler);
  assert.ok(labels.includes("publickey"), `expected publickey; offered=${labels.join(",")}`);
  assert.ok(labels.includes("password"), `expected password; offered=${labels.join(",")}`);
  // user key + at least one default key => multiple publickey offers
  const publickeyCount = labels.filter((l) => l === "publickey").length;
  assert.ok(
    publickeyCount >= 2,
    `key auth may still fall back to default keys; offered=${labels.join(",")}`,
  );
});

test("buildAuthHandler password-only may still attach unlocked encrypted keys for jump retry", () => {
  const auth = buildAuthHandler({
    password: "host-password",
    username: "root",
    defaultKeys: DEFAULT_KEYS,
    allowAgentFallback: false,
    unlockedEncryptedKeys: [{
      keyName: "id_encrypted",
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nenc\n-----END OPENSSH PRIVATE KEY-----\n",
      passphrase: "key-pass",
    }],
  });

  const labels = collectAuthMethods(auth.authHandler);
  assert.ok(labels.includes("password"), `offered=${labels.join(",")}`);
  assert.ok(
    labels.includes("publickey"),
    `jump-chain retry may still offer unlocked keys; offered=${labels.join(",")}`,
  );
});
