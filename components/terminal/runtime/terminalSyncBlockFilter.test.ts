import assert from "node:assert/strict";
import { mock, test } from "node:test";

import type { Terminal as XTerm } from "@xterm/xterm";

import {
  filterTerminalSessionData,
  resetTerminalSyncBlockFilter,
  SYNC_BLOCK_TIMEOUT_MS,
} from "./terminalSyncBlockFilter.ts";

const SYNC_START = "\x1b[?2026h";
const CLEAR = "\x1b[2J";

const term = {} as XTerm;

test("abandoned sync blocks stop stripping clear-screen after timeout", () => {
  mock.timers.enable({ apis: ["setTimeout"] });

  try {
    resetTerminalSyncBlockFilter(term);
    assert.equal(filterTerminalSessionData(term, SYNC_START), SYNC_START);
    assert.equal(filterTerminalSessionData(term, CLEAR), "");

    mock.timers.tick(SYNC_BLOCK_TIMEOUT_MS);
    assert.equal(filterTerminalSessionData(term, CLEAR), CLEAR);
  } finally {
    resetTerminalSyncBlockFilter(term);
    mock.timers.reset();
  }
});

test("completed sync blocks clear the timeout without waiting", () => {
  mock.timers.enable({ apis: ["setTimeout"] });

  try {
    resetTerminalSyncBlockFilter(term);
    assert.equal(
      filterTerminalSessionData(term, `${SYNC_START}frame\x1b[?2026l`),
      `${SYNC_START}frame\x1b[?2026l`,
    );

    mock.timers.tick(SYNC_BLOCK_TIMEOUT_MS);
    assert.equal(filterTerminalSessionData(term, CLEAR), CLEAR);
  } finally {
    resetTerminalSyncBlockFilter(term);
    mock.timers.reset();
  }
});

test("sync block timeout is armed once even when output keeps streaming", () => {
  mock.timers.enable({ apis: ["setTimeout"] });

  try {
    resetTerminalSyncBlockFilter(term);
    assert.equal(filterTerminalSessionData(term, SYNC_START), SYNC_START);
    assert.equal(filterTerminalSessionData(term, "frame-1"), "frame-1");
    assert.equal(filterTerminalSessionData(term, "frame-2"), "frame-2");

    mock.timers.tick(SYNC_BLOCK_TIMEOUT_MS - 1);
    assert.equal(filterTerminalSessionData(term, CLEAR), "");

    mock.timers.tick(1);
    assert.equal(filterTerminalSessionData(term, CLEAR), CLEAR);
  } finally {
    resetTerminalSyncBlockFilter(term);
    mock.timers.reset();
  }
});

test("sync block timeout preserves pending partial marker bytes", () => {
  mock.timers.enable({ apis: ["setTimeout"] });

  try {
    resetTerminalSyncBlockFilter(term);
    assert.equal(filterTerminalSessionData(term, SYNC_START), SYNC_START);
    assert.equal(filterTerminalSessionData(term, "color\x1b"), "color");

    mock.timers.tick(SYNC_BLOCK_TIMEOUT_MS);
    assert.equal(filterTerminalSessionData(term, "[31mtext"), "\x1b[31mtext");
  } finally {
    resetTerminalSyncBlockFilter(term);
    mock.timers.reset();
  }
});
