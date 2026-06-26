"use strict";

// Match VS Code FlowControlConstants (terminal.ts).
const FLOW_HIGH_WATER_MARK = 100_000;
const FLOW_LOW_WATER_MARK = 5_000;

function getFlowTarget(session) {
  return session?.stream || session?.proc || session?.socket || session?.serialPort || null;
}

function ensureFlowState(session) {
  if (!session.flowState) {
    session.flowState = {
      rendererPaused: false,
      unackedBytes: 0,
      appliedPause: false,
    };
  }
  return session.flowState;
}

function applyPause(session, target) {
  try {
    target.pause?.();
  } catch (err) {
    if (err?.code !== "EPIPE" && err?.code !== "ERR_STREAM_DESTROYED") {
      console.warn("Flow control pause failed", err);
    }
  }
}

function applyResume(session, target) {
  try {
    target.resume?.();
  } catch (err) {
    if (err?.code !== "EPIPE" && err?.code !== "ERR_STREAM_DESTROYED") {
      console.warn("Flow control resume failed", err);
    }
  }
}

function reconcileSessionFlow(session) {
  if (!session) return;
  const state = ensureFlowState(session);
  const target = getFlowTarget(session);
  if (!target) return;

  const shouldPause = state.rendererPaused || state.unackedBytes >= FLOW_HIGH_WATER_MARK;
  const shouldResume = !state.rendererPaused && state.unackedBytes <= FLOW_LOW_WATER_MARK;

  if (!state.appliedPause && shouldPause) {
    applyPause(session, target);
    state.appliedPause = true;
    return;
  }

  if (state.appliedPause && shouldResume) {
    applyResume(session, target);
    state.appliedPause = false;
  }
}

function setRendererFlowPaused(session, paused) {
  if (!session) return;
  const state = ensureFlowState(session);
  state.rendererPaused = Boolean(paused);
  reconcileSessionFlow(session);
}

function trackEmitted(session, bytes) {
  if (!session || !Number.isFinite(bytes) || bytes <= 0) return;
  const state = ensureFlowState(session);
  state.unackedBytes += bytes;
  reconcileSessionFlow(session);
}

function trackAck(session, bytes) {
  if (!session || !Number.isFinite(bytes) || bytes <= 0) return;
  const state = ensureFlowState(session);
  state.unackedBytes = Math.max(0, state.unackedBytes - bytes);
  reconcileSessionFlow(session);
}

function clearSessionFlowState(session) {
  if (!session?.flowState) return;
  const target = getFlowTarget(session);
  if (session.flowState.appliedPause && target) {
    applyResume(session, target);
  }
  session.flowState = {
    rendererPaused: false,
    unackedBytes: 0,
    appliedPause: false,
  };
}

module.exports = {
  FLOW_HIGH_WATER_MARK,
  FLOW_LOW_WATER_MARK,
  setRendererFlowPaused,
  trackEmitted,
  trackAck,
  clearSessionFlowState,
  reconcileSessionFlow,
};