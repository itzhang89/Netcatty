const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");

const {
  addBundledMoshRuntimeEnv,
  resolveBareMoshClient,
} = require("./terminalBridge.cjs");
const { createMoshSessionApi } = require("./terminalBridge/moshSession.cjs");

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-mosh-resolve-"));
}

function writeExecutable(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(filePath, 0o755);
}

test("resolveBareMoshClient ignores explicit local mosh-client paths", () => {
  const tmp = makeTmp();
  const p = path.join(tmp, "mosh-client");
  writeExecutable(p);
  assert.equal(resolveBareMoshClient({ moshClientPath: p }, { projectRoot: tmp, resourcesPath: path.join(tmp, "missing") }), null);
});

test("resolveBareMoshClient resolves only the bundled client", () => {
  const tmp = makeTmp();
  const bundled = path.join(tmp, "resources", "mosh", "linux-x64", "mosh-client");
  writeExecutable(bundled);

  assert.equal(
    resolveBareMoshClient({}, {
      platform: "linux",
      arch: "x64",
      projectRoot: tmp,
      resourcesPath: path.join(tmp, "missing"),
    }),
    bundled,
  );
});

test("resolveBareMoshClient rejects relative explicit paths", () => {
  const tmp = makeTmp();
  const got = resolveBareMoshClient({ moshClientPath: "./mosh-client" }, {
    projectRoot: tmp,
    resourcesPath: path.join(tmp, "missing"),
  });
  assert.equal(got, null);
});

test("resolveBareMoshClient ignores a non-executable explicit path", () => {
  const tmp = makeTmp();
  const p = path.join(tmp, "mosh-client");
  fs.writeFileSync(p, "");
  fs.chmodSync(p, 0o644);
  const got = resolveBareMoshClient({ moshClientPath: p }, {
    projectRoot: tmp,
    resourcesPath: path.join(tmp, "missing"),
  });
  assert.equal(got, null);
});

test("resolveBareMoshClient ignores mosh-client on PATH", () => {
  const tmp = makeTmp();
  const p = path.join(tmp, "mosh-client");
  writeExecutable(p);

  assert.equal(resolveBareMoshClient({}, {
    pathOverride: tmp,
    projectRoot: tmp,
    resourcesPath: path.join(tmp, "missing"),
  }), null);
});

test("mosh fallback messages do not point users to the removed Mosh settings field", () => {
  const source = fs.readFileSync(path.join(__dirname, "terminalBridge.cjs"), "utf8");

  assert.equal(source.includes("Settings → Terminal → Mosh"), false);
});

test("mosh runtime does not fall back to system mosh or mosh-client", () => {
  const source = fs.readFileSync(path.join(__dirname, "terminalBridge.cjs"), "utf8");

  assert.equal(source.includes('resolvePosixExecutable("mosh-client"'), false);
  assert.equal(source.includes('findExecutable("mosh-client"'), false);
  assert.equal(source.includes('resolvePosixExecutable("mosh"'), false);
  assert.equal(source.includes('findExecutable("mosh"'), false);
  assert.equal(source.includes("brew install mosh"), false);
});

test("MoshCatty runtime env is a no-op (no DLL bag / terminfo)", () => {
  const env = { Path: "C:\\Windows\\System32", TERM: "xterm-256color" };
  const out = addBundledMoshRuntimeEnv(env, "C:\\app\\mosh-client.exe", { platform: "win32" });
  assert.equal(out, env);
  assert.equal(env.TERMINFO, undefined);
  assert.equal(env.TERMINFO_DIRS, undefined);
  assert.equal(env.Path, "C:\\Windows\\System32");
});

test("mosh UTF-8 decoder preserves fragmented Chinese output", () => {
  const { createMoshUtf8Decoder } = createMoshSessionApi({
    StringDecoder,
    Buffer,
  });
  const decode = createMoshUtf8Decoder();
  const fixture = Buffer.from("mosh: 连接恢复，终端输出正常\n", "utf8");
  const chunks = [
    fixture.subarray(0, 9),
    fixture.subarray(9, 11),
    fixture.subarray(11, 17),
    fixture.subarray(17),
  ];

  const decoded = chunks.map((chunk) => decode(chunk)).join("");

  assert.equal(decoded, "mosh: 连接恢复，终端输出正常\n");
  assert.equal(decoded.includes("\uFFFD"), false);
});

test("Mosh prepares the configured system agent before building native ssh options", async (t) => {
  const calls = [];
  const tempBase = makeTmp();
  t.after(() => fs.rmSync(tempBase, { recursive: true, force: true }));
  const api = createMoshSessionApi({
    os,
    path,
    fs,
    process,
    randomUUID: () => "fixed",
    tempDirBridge: { getTempFilePath: (fileName) => path.join(tempBase, fileName) },
    prepareSystemSshAgentForAuth: async (options) => {
      calls.push(["prepare", options.identityAgent, options.useKeychain]);
    },
    getAvailableAgentSocket: async (identityAgent) => {
      calls.push(["resolve", identityAgent]);
      return "/tmp/custom-agent.sock";
    },
  });

  const prepared = await api.prepareMoshSshAgentOptions({
    hostname: "host.example",
    username: "alice",
    useSshAgent: true,
    identityAgent: "/tmp/custom-agent.sock",
    useKeychain: true,
    addKeysToAgent: "yes",
    identityFilePaths: ["~/.ssh/id_work"],
  });
  const auth = await api.buildMoshSshAuthArgs({
    ...prepared,
    identitiesOnly: true,
    identityFilePaths: ["~/.ssh/id_work"],
  }, "session-1");
  const env = api.applyMoshSshAgentEnvironment({}, prepared);

  assert.deepEqual(calls, [
    ["prepare", "/tmp/custom-agent.sock", true],
    ["resolve", "/tmp/custom-agent.sock"],
  ]);
  assert.deepEqual(auth.sshArgs, [
    "-i", path.join(os.homedir(), ".ssh", "id_work.pub"),
    "-o", "IdentitiesOnly=yes",
    "-o", "IdentityAgent=/tmp/custom-agent.sock",
  ]);
  assert.equal(env.SSH_AUTH_SOCK, "/tmp/custom-agent.sock");

  const selected = await api.buildMoshSshAuthArgs({
    ...prepared,
    identitiesOnly: true,
    keyId: "vault-key",
    agentPublicKeys: ["ssh-ed25519 AAAASELECTED"],
  }, "session-selected");
  const selectedPath = selected.sshArgs[1];
  assert.deepEqual(selected.sshArgs.slice(0, 2), ["-i", selectedPath]);
  assert.equal(fs.readFileSync(selectedPath, "utf8"), "ssh-ed25519 AAAASELECTED\n");
  assert.ok(selected.sshArgs.includes("IdentitiesOnly=yes"));
  api.cleanupMoshAuthTempFiles(selected.tempFiles);
});

test("Mosh explicitly disables native agent login after an opt-out", async () => {
  const api = createMoshSessionApi({
    os,
    path,
    fs,
    process,
    randomUUID: () => "fixed",
  });
  const auth = await api.buildMoshSshAuthArgs({ useSshAgent: false }, "session-disabled");
  const env = api.applyMoshSshAgentEnvironment(
    { SSH_AUTH_SOCK: "/tmp/inherited-agent.sock" },
    { useSshAgent: false },
  );

  assert.deepEqual(auth.sshArgs, ["-o", "IdentityAgent=none"]);
  assert.equal(env.SSH_AUTH_SOCK, undefined);

  const forwardingAuth = await api.buildMoshSshAuthArgs({
    useSshAgent: false,
    agentForwarding: true,
  }, "session-forwarding");
  const forwardingEnv = api.applyMoshSshAgentEnvironment(
    { SSH_AUTH_SOCK: "/tmp/forwarded-agent.sock" },
    { useSshAgent: false, agentForwarding: true },
  );
  assert.deepEqual(forwardingAuth.sshArgs, [
    "-o", "IdentityAgent=none",
    "-o", "ForwardAgent=${SSH_AUTH_SOCK}",
  ]);
  assert.equal(forwardingEnv.SSH_AUTH_SOCK, "/tmp/forwarded-agent.sock");
});

test("Mosh automatic mode discovers custom local keys in preferred order", async (t) => {
  const tempBase = makeTmp();
  const fakeHome = path.join(tempBase, "home");
  const sshDir = path.join(fakeHome, ".ssh");
  fs.mkdirSync(sshDir, { recursive: true });
  fs.writeFileSync(path.join(sshDir, "id_work"), "PRIVATE KEY");
  fs.writeFileSync(path.join(sshDir, "id_ed25519"), "PRIVATE KEY");
  fs.writeFileSync(path.join(sshDir, "id_rsa.pub"), "PUBLIC KEY");
  t.after(() => fs.rmSync(tempBase, { recursive: true, force: true }));

  const api = createMoshSessionApi({
    os: { ...os, homedir: () => fakeHome },
    path,
    fs,
    process,
    randomUUID: () => "fixed",
  });
  const auth = await api.buildMoshSshAuthArgs({ authMethod: "auto" }, "session-auto");

  assert.deepEqual(auth.sshArgs, [
    "-i", path.join(sshDir, "id_ed25519"),
    "-i", path.join(sshDir, "id_work"),
  ]);
  assert.deepEqual(auth.identityFilePaths, [
    path.join(sshDir, "id_ed25519"),
    path.join(sshDir, "id_work"),
  ]);

  const agentFallback = await api.buildMoshSshAuthArgs({
    authMethod: "auto",
    useSshAgent: true,
    identitiesOnly: false,
  }, "session-auto-agent");
  assert.deepEqual(agentFallback.sshArgs, [
    "-i", path.join(sshDir, "id_ed25519"),
    "-i", path.join(sshDir, "id_work"),
  ]);
  assert.deepEqual(agentFallback.identityFilePaths, [
    path.join(sshDir, "id_ed25519"),
    path.join(sshDir, "id_work"),
  ]);
});

test("removed Mosh client detection APIs are not exposed to the renderer", () => {
  const bridgeSource = fs.readFileSync(path.join(__dirname, "terminalBridge.cjs"), "utf8");
  const preloadSource = fs.readFileSync(path.join(__dirname, "..", "preload.cjs"), "utf8");
  const globalTypes = fs.readFileSync(path.join(__dirname, "..", "..", "global.d.ts"), "utf8");

  for (const source of [bridgeSource, preloadSource, globalTypes]) {
    assert.equal(source.includes("detectMoshClient"), false);
    assert.equal(source.includes("pickMoshClient"), false);
    assert.equal(source.includes("netcatty:mosh:detectClient"), false);
    assert.equal(source.includes("netcatty:mosh:pickClient"), false);
  }
});

test("Cygwin / terminfo helpers are gone from the mosh session module", () => {
  const source = fs.readFileSync(path.join(__dirname, "terminalBridge", "moshSession.cjs"), "utf8");
  assert.equal(source.includes("toCygwinPath"), false);
  assert.equal(source.includes("findBundledMoshDllDir"), false);
  assert.equal(source.includes("findBundledMoshTerminfoDir"), false);
  assert.equal(source.includes("cygwin1"), false);
});
