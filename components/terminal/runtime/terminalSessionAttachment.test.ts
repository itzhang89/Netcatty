import test from "node:test";
import assert from "node:assert/strict";
import type { Terminal as XTerm } from "@xterm/xterm";

import { attachSessionToTerminal, writeSessionData } from "./terminalSessionAttachment.ts";

const createFakeTerm = (activeType = "normal") => {
  const writes: string[] = [];
  const term = {
    buffer: {
      active: { type: activeType },
    },
    write(data: string, callback?: () => void) {
      writes.push(data);
      callback?.();
    },
    scrollToBottom() {},
  } as unknown as XTerm;

  return { term, writes };
};

const createContext = (showLineTimestamps: boolean) => ({
  terminalSettingsRef: {
    current: {
      showLineTimestamps,
      scrollOnOutput: false,
      forcePromptNewLine: false,
    },
  },
  terminalSettings: {
    showLineTimestamps,
    scrollOnOutput: false,
    forcePromptNewLine: false,
  },
  terminalBackend: {},
  sessionRef: { current: "session-1" },
  promptLineBreakStateRef: { current: undefined },
});

test("writeSessionData prefixes terminal output lines when enabled", () => {
  const { term, writes } = createFakeTerm();
  writeSessionData(createContext(true) as never, term, "hello\r\nnext");

  assert.equal(writes.length, 1);
  assert.equal((writes[0].match(/\[\d{2}:\d{2}:\d{2}\]/g) ?? []).length, 2);
  assert.ok(writes[0].includes("\x1b[2;90m["));
  assert.ok(writes[0].includes("] \x1b[22;39mhello\r\n\x1b[2;90m["));
  assert.ok(writes[0].endsWith("] \x1b[22;39mnext"));
});

test("writeSessionData skips timestamps on the alternate screen", () => {
  const { term, writes } = createFakeTerm("alternate");
  writeSessionData(createContext(true) as never, term, "vim screen");

  assert.deepEqual(writes, ["vim screen"]);
});

test("writeSessionData does not timestamp output that enters alternate screen in the same chunk", () => {
  const { term, writes } = createFakeTerm();
  writeSessionData(createContext(true) as never, term, "\x1b[?1049hvim screen");

  assert.deepEqual(writes, ["\x1b[?1049hvim screen"]);
});

test("writeSessionData resumes timestamps after leaving alternate screen in the same chunk", () => {
  const { term, writes } = createFakeTerm("alternate");
  writeSessionData(createContext(true) as never, term, "\x1b[?1049lprompt");

  assert.equal(writes.length, 1);
  assert.ok(writes[0].startsWith("\x1b[?1049l\x1b[2;90m["));
  assert.ok(writes[0].endsWith("] \x1b[22;39mprompt"));
});

test("attachSessionToTerminal resets timestamp state for a reused terminal", () => {
  const { term, writes } = createFakeTerm();
  const ctx = {
    ...createContext(true),
    sessionId: "session-1",
    sessionRef: { current: null },
    hasConnectedRef: { current: true },
    hasRunStartupCommandRef: { current: false },
    disposeDataRef: { current: null },
    disposeExitRef: { current: null },
    fitAddonRef: { current: null },
    serializeAddonRef: { current: null },
    pendingAuthRef: { current: null },
    terminalBackend: {
      onSessionData: () => () => {},
      onSessionExit: () => () => {},
    },
    updateStatus: () => {},
    setError: () => {},
    onSessionExit: () => {},
  };

  writeSessionData(ctx as never, term, "unfinished");
  attachSessionToTerminal(ctx as never, term, "session-2");
  writeSessionData(ctx as never, term, "fresh");

  assert.equal(writes.length, 2);
  assert.equal((writes[1].match(/\[\d{2}:\d{2}:\d{2}\]/g) ?? []).length, 1);
  assert.ok(writes[1].endsWith("] \x1b[22;39mfresh"));
});
