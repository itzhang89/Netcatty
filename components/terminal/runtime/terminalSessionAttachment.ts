import type { Terminal as XTerm } from "@xterm/xterm";
import { shouldScrollOnTerminalOutput } from "../../../domain/terminalScroll";
import { logger } from "../../../lib/logger";
import type { Host, TerminalSettings } from "../../../types";
import {
  clearPasteResidualAfterTerminalWrite,
  prepareTerminalDataForUserPasteDisplay,
} from "./terminalUserPaste";
import {
  prepareTerminalDataForPromptLineBreak,
  syncPromptLineBreakState,
} from "./promptLineBreak";
import { createOutputFlowController, type OutputFlowController } from "./outputFlowController";
import type { TerminalSessionStartersContext } from "./createTerminalSessionStarters.types";
import { clearConnectionToken } from "./terminalDistroDetection";
import {
  resetTerminalLineTimestamps,
  writeTerminalDataWithLineTimestamps,
} from "./terminalLineTimestamps";
import { createSudoPasswordAutofill } from "./terminalSudoAutofill";
import {
  filterTerminalSessionData,
  resetTerminalSyncBlockFilter,
} from "./terminalSyncBlockFilter";
import { appendEraseScrollbackAfterFullErases } from "../clearTerminalViewport";
import {
  enqueueCoalescedTerminalWrite,
  flushTerminalWriteCoalescer,
} from "./terminalWriteCoalescer";
import {
  FLOW_HIGH_WATER_MARK,
  FLOW_LOW_WATER_MARK,
} from "./terminalFlowConstants";
import {
  ackTerminalSessionFlow,
} from "./terminalFlowAckBuffer";
import {
  enqueueTerminalWrite,
  setTerminalWriteQueueDropHandler,
} from "./terminalWriteQueue";
import { teardownTerminalOutputPipeline } from "./terminalOutputPipeline";

export { FLOW_HIGH_WATER_MARK, FLOW_LOW_WATER_MARK };

export const buildTermEnv = (host: Host, terminalSettings?: TerminalSettings) => {
  const env: Record<string, string> = {
    TERM: terminalSettings?.terminalEmulationType ?? "xterm-256color",
  };

  if (host.environmentVariables) {
    for (const { name, value } of host.environmentVariables) {
      if (name) env[name] = value;
    }
  }

  return env;
};

const handleTerminalOutputAutoScroll = (
  ctx: TerminalSessionStartersContext,
  term: XTerm,
) => {
  const settings = ctx.terminalSettingsRef?.current ?? ctx.terminalSettings;
  if (!shouldScrollOnTerminalOutput(settings)) {
    return;
  }

  if (ctx.isVisibleRef?.current === false) {
    if (ctx.pendingOutputScrollRef) {
      ctx.pendingOutputScrollRef.current = true;
    }
    return;
  }

  term.scrollToBottom();
};

const terminalFlowControllers = new WeakMap<XTerm, OutputFlowController>();

export const getFlowControllerForTerm = (term: XTerm): OutputFlowController | undefined =>
  terminalFlowControllers.get(term);

export const getFlowController = (
  ctx: TerminalSessionStartersContext,
  term: XTerm,
): OutputFlowController => {
  let controller = terminalFlowControllers.get(term);
  if (!controller) {
    controller = createOutputFlowController({
      highWaterMark: FLOW_HIGH_WATER_MARK,
      lowWaterMark: FLOW_LOW_WATER_MARK,
      onPause: () => {
        const id = ctx.sessionRef.current;
        if (id) ctx.terminalBackend.setSessionFlowPaused?.(id, true);
      },
      onResume: () => {
        const id = ctx.sessionRef.current;
        if (id) ctx.terminalBackend.setSessionFlowPaused?.(id, false);
      },
    });
    terminalFlowControllers.set(term, controller);
    setTerminalWriteQueueDropHandler(term, (bytes) => {
      if (bytes <= 0) return;
      controller?.written(bytes);
      ackTerminalSessionFlow(ctx.terminalBackend, ctx.sessionRef.current, bytes);
    });
  }
  return controller;
};

export const resetTerminalLineTimestampState = resetTerminalLineTimestamps;

export const writeTerminalLine = (
  ctx: TerminalSessionStartersContext,
  term: XTerm,
  data: string,
) => {
  const lineData = `${data}\r\n`;
  enqueueTerminalWrite(term, lineData.length, (done) => {
    ctx.onTerminalLogData?.(lineData);
    term.write(lineData, done);
  });
};

export const writeSessionData = (
  ctx: TerminalSessionStartersContext,
  term: XTerm,
  data: string,
) => {
  const flow = getFlowController(ctx, term);
  flow.received(data.length);
  enqueueCoalescedTerminalWrite(term, data, (batch) => {
    writeSessionDataImmediate(ctx, term, batch);
  });
};

const writeSessionDataImmediate = (
  ctx: TerminalSessionStartersContext,
  term: XTerm,
  data: string,
) => {
  const flow = getFlowController(ctx, term);
  const ingressBytes = data.length;
  enqueueTerminalWrite(term, ingressBytes, (done) => {
    const settings = ctx.terminalSettingsRef?.current ?? ctx.terminalSettings;
    const filteredData = filterTerminalSessionData(term, data);
    const displayData = appendEraseScrollbackAfterFullErases(filteredData, {
      wipeScrollback: settings?.clearWipesScrollback ?? true,
      normalScreen: term.buffer?.active?.type !== "alternate",
    });
    const forcePromptNewLine = settings?.forcePromptNewLine ?? false;
    if (!forcePromptNewLine && ctx.promptLineBreakStateRef?.current) {
      ctx.promptLineBreakStateRef.current.pendingCommand = false;
      ctx.promptLineBreakStateRef.current.suppressNextPromptCache = false;
    }
    const pasteDisplayData = prepareTerminalDataForUserPasteDisplay(term, displayData);
    const preparedDisplayData = prepareTerminalDataForPromptLineBreak(
      term,
      pasteDisplayData,
      ctx.promptLineBreakStateRef?.current,
      forcePromptNewLine,
    );
    ctx.onTerminalLogData?.(pasteDisplayData);
    const clearPasteResidualAndCapture = () => {
      const cleanupData = clearPasteResidualAfterTerminalWrite(term);
      if (cleanupData) {
        ctx.onTerminalLogData?.(cleanupData);
      }
    };
    const syncPrompt = () => {
      if (forcePromptNewLine) {
        syncPromptLineBreakState(term, ctx.promptLineBreakStateRef?.current);
      }
    };
    const afterWrite = () => {
      clearPasteResidualAndCapture();
      syncPrompt();
      if (shouldScrollOnTerminalOutput(settings)) {
        handleTerminalOutputAutoScroll(ctx, term);
      }
      done();
      flow.written(ingressBytes);
      ackTerminalSessionFlow(ctx.terminalBackend, ctx.sessionRef.current, ingressBytes);
    };

    writeTerminalDataWithLineTimestamps(term, preparedDisplayData, afterWrite);
  }, {
    onDropped: (bytes) => {
      if (bytes <= 0) return;
      flow.written(bytes);
      ackTerminalSessionFlow(ctx.terminalBackend, ctx.sessionRef.current, bytes);
    },
  });
};

export const isTerminalBootActive = (ctx: TerminalSessionStartersContext): boolean =>
  !ctx.isBootActiveRef || ctx.isBootActiveRef.current;

export const closeOrphanBackendSession = (
  ctx: TerminalSessionStartersContext,
  sessionBackendId: string,
) => {
  try {
    ctx.terminalBackend.closeSession(sessionBackendId);
  } catch (err) {
    logger.warn("Failed to close orphan session after terminal unmount", err);
  }
};

export const tryAttachSessionToTerminal = (
  ctx: TerminalSessionStartersContext,
  term: XTerm,
  id: string,
  opts?: {
    onExitMessage?: (evt: { exitCode?: number; signal?: number; error?: string; reason?: string }) => string;
    onConnected?: () => void;
    onExit?: (evt: { exitCode?: number; signal?: number; error?: string; reason?: string }) => void;
    convertLfToCrlf?: boolean;
    sudoAutofillPassword?: string;
  },
): boolean => {
  if (!isTerminalBootActive(ctx)) {
    closeOrphanBackendSession(ctx, id);
    return false;
  }
  attachSessionToTerminal(ctx, term, id, opts);
  return true;
};

export const detachSessionDataListeners = (
  ctx: TerminalSessionStartersContext,
  term: XTerm,
) => {
  const sessionId = ctx.sessionRef.current;
  const flow = terminalFlowControllers.get(term);
  if (flow) {
    teardownTerminalOutputPipeline(ctx, term, sessionId, flow);
    terminalFlowControllers.delete(term);
  }

  ctx.disposeDataRef.current?.();
  ctx.disposeDataRef.current = null;
  ctx.disposeExitRef.current?.();
  ctx.disposeExitRef.current = null;
};

export const attachSessionToTerminal = (
  ctx: TerminalSessionStartersContext,
  term: XTerm,
  id: string,
  opts?: {
    onExitMessage?: (evt: { exitCode?: number; signal?: number; error?: string; reason?: string }) => string;
    onConnected?: () => void;
    onExit?: (evt: { exitCode?: number; signal?: number; error?: string; reason?: string }) => void;
    convertLfToCrlf?: boolean;
    sudoAutofillPassword?: string;
  },
) => {
  if (!isTerminalBootActive(ctx)) {
    closeOrphanBackendSession(ctx, id);
    return;
  }

  ctx.sessionRef.current = id;
  const flow = getFlowController(ctx, term);
  teardownTerminalOutputPipeline(ctx, term, id, flow);
  flushTerminalWriteCoalescer(term);
  resetTerminalSyncBlockFilter(term);
  resetTerminalLineTimestamps(term);
  ctx.onSessionAttached?.(id);
  const sudoAutofill = createSudoPasswordAutofill({
    password: opts?.sudoAutofillPassword,
    write: (data) => ctx.terminalBackend.writeToSession(id, data, { automated: true }),
    onHint: (active) => ctx.onSudoHint?.(active) ?? false,
  });
  if (ctx.sudoAutofillRef) {
    ctx.sudoAutofillRef.current = sudoAutofill;
  }

  ctx.disposeDataRef.current = ctx.terminalBackend.onSessionData(
    id,
    (chunk) => {
      let data = chunk;
      if (opts?.convertLfToCrlf) {
        data = data.replace(/(?<!\r)\n/g, "\r\n");
      }
      data = sudoAutofill?.handleOutput(data) ?? data;
      writeSessionData(ctx, term, data);
      ctx.onTerminalOutput?.(data);
      if (!ctx.hasConnectedRef.current) {
        ctx.updateStatus("connected");
        opts?.onConnected?.();
        setTimeout(() => {
          if (!ctx.fitAddonRef.current) return;
          try {
            ctx.fitAddonRef.current.fit();
            if (ctx.sessionRef.current) {
              ctx.terminalBackend.resizeSession(ctx.sessionRef.current, term.cols, term.rows);
            }
          } catch (err) {
            logger.warn("Post-connect fit failed", err);
          }
        }, 100);
      }
    },
    { replayBacklog: true },
  );

  ctx.disposeExitRef.current = ctx.terminalBackend.onSessionExit(id, (evt) => {
    ctx.updateStatus("disconnected");
    if (evt.error) {
      ctx.setError(evt.error);
    }
    const exitMessage = opts?.onExitMessage?.(evt) ?? "\r\n[session closed]";
    writeTerminalLine(ctx, term, exitMessage);

    if (ctx.onTerminalDataCapture && ctx.serializeAddonRef.current) {
      try {
        const terminalData = ctx.serializeAddonRef.current.serialize();
        ctx.onTerminalDataCapture(ctx.sessionId, terminalData);
      } catch (err) {
        logger.warn("Failed to serialize terminal data:", err);
      }
    }

    clearConnectionToken(ctx.sessionId);

    opts?.onExit?.(evt);
    if (ctx.sudoAutofillRef) {
      ctx.sudoAutofillRef.current = null;
    }
    ctx.onSessionExit?.(ctx.sessionId, evt);
  });
};