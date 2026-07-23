const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  buildCursorCliArgs,
  listCursorCliModels,
  mergeWorkspaceMcpJson,
  resolveCursorCliModel,
  runCursorCliTurn,
  stripCursorApiKeyFromEnv,
  translateCursorCliEvent,
} = require("./cursorCliDriver.cjs");

function makeEmitter() {
  const calls = [];
  return {
    calls,
    text: (value) => calls.push(["text", value]),
    reasoning: (value) => calls.push(["reasoning", value]),
    reasoningEnd: () => calls.push(["reasoningEnd"]),
    toolCall: (name, args, id) => calls.push(["toolCall", name, args, id]),
    toolResult: (id, result, name) => calls.push(["toolResult", id, result, name]),
    sessionId: (id) => calls.push(["sessionId", id]),
    emitDone: () => calls.push(["done"]),
    emitError: (message) => calls.push(["error", message]),
  };
}

test("resolveCursorCliModel defaults to auto", () => {
  assert.equal(resolveCursorCliModel(undefined), "auto");
  assert.equal(resolveCursorCliModel(""), "auto");
  assert.equal(resolveCursorCliModel("composer-2.5"), "composer-2.5");
});

test("stripCursorApiKeyFromEnv removes CURSOR_API_KEY", () => {
  assert.deepEqual(
    stripCursorApiKeyFromEnv({ CURSOR_API_KEY: "secret", PATH: "/bin" }),
    { PATH: "/bin" },
  );
});

test("buildCursorCliArgs maps permission modes and resume", () => {
  assert.deepEqual(
    buildCursorCliArgs({
      model: "",
      permissionMode: "observer",
      resumeSessionId: "sess-1",
      cwd: "/repo",
      prompt: "hi",
    }),
    [
      "--print",
      "--trust",
      "--approve-mcps",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      "--model",
      "auto",
      "--workspace",
      "/repo",
      "--resume",
      "sess-1",
      "--mode",
      "ask",
      "hi",
    ],
  );

  const autoArgs = buildCursorCliArgs({
    model: "auto",
    permissionMode: "auto",
    cwd: "/repo",
    prompt: "go",
  });
  assert.ok(autoArgs.includes("--force"));
  assert.ok(!autoArgs.includes("--mode"));
});

test("translateCursorCliEvent streams thinking, text, and tools", () => {
  const emitter = makeEmitter();
  const state = {};
  translateCursorCliEvent({ type: "system", subtype: "init", session_id: "s1" }, emitter, state);
  translateCursorCliEvent({ type: "thinking", subtype: "delta", text: "plan" }, emitter, state);
  translateCursorCliEvent({ type: "thinking", subtype: "completed" }, emitter, state);
  translateCursorCliEvent({
    type: "assistant",
    timestamp_ms: 1,
    message: { content: [{ type: "text", text: "Hi" }] },
  }, emitter, state);
  translateCursorCliEvent({
    type: "assistant",
    message: { content: [{ type: "text", text: "Hi" }] },
  }, emitter, state);
  translateCursorCliEvent({
    type: "tool_call",
    subtype: "started",
    call_id: "c1",
    tool_call: { getMcpToolsToolCall: { args: { a: 1 } } },
  }, emitter, state);
  translateCursorCliEvent({
    type: "tool_call",
    subtype: "completed",
    call_id: "c1",
    tool_call: { getMcpToolsToolCall: { args: { a: 1 }, result: { success: { content: "ok" } } } },
  }, emitter, state);

  assert.deepEqual(emitter.calls, [
    ["sessionId", "s1"],
    ["reasoning", "plan"],
    ["reasoningEnd"],
    ["text", "Hi"],
    ["toolCall", "getMcpTools", { a: 1 }, "c1"],
    ["toolResult", "c1", "ok", "getMcpTools"],
  ]);
  assert.equal(state.sessionId, "s1");
});

test("mergeWorkspaceMcpJson upserts netcatty without dropping others", () => {
  const files = new Map();
  files.set("/repo/.cursor/mcp.json", JSON.stringify({
    mcpServers: { other: { command: "echo" } },
  }, null, 2));

  const handle = mergeWorkspaceMcpJson("/repo", [{
    name: "netcatty-remote-hosts",
    command: "node",
    args: ["mcp.cjs"],
    env: [{ name: "TOKEN", value: "x" }],
  }], {
    existsSync: (p) => files.has(p) || p === "/repo/.cursor",
    readFileSync: (p) => files.get(p),
    writeFileSync: (p, data) => { files.set(p, data); },
    mkdirSync: () => {},
  });

  const written = JSON.parse(files.get("/repo/.cursor/mcp.json"));
  assert.equal(written.mcpServers.other.command, "echo");
  assert.equal(written.mcpServers["netcatty-remote-hosts"].command, "node");
  assert.equal(written.mcpServers["netcatty-remote-hosts"].env.TOKEN, "x");

  handle.restore();
  assert.ok(files.get("/repo/.cursor/mcp.json").includes('"other"'));
});

test("runCursorCliTurn strips API key, parses stream, emits done", async () => {
  const emitter = makeEmitter();
  const observed = { env: null, args: null };

  const fakeChild = new EventEmitter();
  fakeChild.stdout = new EventEmitter();
  fakeChild.stderr = new EventEmitter();
  fakeChild.killed = false;
  fakeChild.kill = () => { fakeChild.killed = true; };

  const result = await new Promise((resolve, reject) => {
    runCursorCliTurn({
      prompt: "hi",
      binPath: "/bin/agent",
      cwd: "/repo",
      model: "",
      env: { CURSOR_API_KEY: "secret", PATH: "/bin" },
      permissionMode: "confirm",
      injectedMcpServers: [],
      emitter,
      spawnImpl: (cmd, args, opts) => {
        observed.env = opts.env;
        observed.args = args;
        queueMicrotask(() => {
          fakeChild.stdout.emit("data", `${JSON.stringify({
            type: "system", subtype: "init", session_id: "sess-cli", apiKeySource: "login",
          })}\n`);
          fakeChild.stdout.emit("data", `${JSON.stringify({
            type: "assistant", timestamp_ms: 1, message: { content: [{ type: "text", text: "PONG" }] },
          })}\n`);
          fakeChild.stdout.emit("data", `${JSON.stringify({
            type: "result", subtype: "success", session_id: "sess-cli", result: "PONG",
          })}\n`);
          fakeChild.emit("close", 0);
        });
        return fakeChild;
      },
      mergeMcp: () => ({ restore() {} }),
    }).then(resolve, reject);
  });

  assert.equal(observed.env.CURSOR_API_KEY, undefined);
  assert.equal(observed.env.PATH, "/bin");
  assert.ok(observed.args.includes("auto"));
  assert.equal(result.sessionId, "sess-cli");
  assert.deepEqual(emitter.calls, [
    ["sessionId", "sess-cli"],
    ["text", "PONG"],
    ["sessionId", "sess-cli"],
    ["done"],
  ]);
});

test("listCursorCliModels parses agent models output and prefers auto", async () => {
  const fakeChild = new EventEmitter();
  fakeChild.stdout = new EventEmitter();
  fakeChild.stderr = new EventEmitter();

  const catalog = await listCursorCliModels({
    binPath: "/bin/agent",
    env: { CURSOR_API_KEY: "secret" },
    spawnImpl: (cmd, args, opts) => {
      assert.equal(cmd, "/bin/agent");
      assert.deepEqual(args, ["models"]);
      assert.equal(opts.env.CURSOR_API_KEY, undefined);
      queueMicrotask(() => {
        fakeChild.stdout.emit("data", [
          "Available models",
          "",
          "auto - Auto (current, default)",
          "composer-2.5 - Composer 2.5",
          "gpt-5.2 - GPT-5.2",
          "",
        ].join("\n"));
        fakeChild.emit("close", 0);
      });
      return fakeChild;
    },
  });

  assert.deepEqual(catalog, {
    currentModelId: "auto",
    models: [
      { id: "auto", name: "Auto" },
      { id: "composer-2.5", name: "Composer 2.5" },
      { id: "gpt-5.2", name: "GPT-5.2" },
    ],
  });
});
