/**
 * Strip `\x1b[2J` (ED — erase display) inside DEC Mode 2026 synchronized-output
 * blocks before data reaches xterm.js.
 *
 * Coding CLIs such as Codex and Claude Code wrap full-screen redraws in
 * `\x1b[?2026h` … `\x1b[?2026l`. Native terminals treat the enclosed clear as
 * part of the atomic update, but xterm.js resets viewportY on every `\x1b[2J`,
 * which yanks scroll position and makes earlier output appear "eaten".
 *
 * PTY/IPC chunks can split escape sequences at arbitrary byte boundaries, so a
 * trailing partial marker is held in `pending` until the next chunk completes it.
 *
 * @see https://github.com/xtermjs/xterm.js/issues/5801
 * @see https://github.com/openai/codex/issues/14277
 */

export type SyncBlockFilterState = {
  inSyncBlock: boolean;
  /** Trailing bytes that may complete a marker in the next chunk. */
  pending: string;
};

const SYNC_START = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";
const CLEAR = "\x1b[2J";

const MARKERS = [SYNC_START, SYNC_END, CLEAR] as const;

const maxMarkerPrefixLength = Math.max(...MARKERS.map((marker) => marker.length)) - 1;

const splitPendingMarkerSuffix = (input: string): { emit: string; pending: string } => {
  const maxLength = Math.min(input.length, maxMarkerPrefixLength);
  for (let length = maxLength; length > 0; length -= 1) {
    const suffix = input.slice(-length);
    if (MARKERS.some((marker) => marker.startsWith(suffix) && marker.length > suffix.length)) {
      return {
        emit: input.slice(0, -length),
        pending: suffix,
      };
    }
  }
  return { emit: input, pending: "" };
};

const scanSyncBlockClears = (input: string, state: SyncBlockFilterState): string => {
  let result = "";
  let index = 0;

  while (index < input.length) {
    if (input.startsWith(SYNC_START, index)) {
      state.inSyncBlock = true;
      result += SYNC_START;
      index += SYNC_START.length;
      continue;
    }

    if (input.startsWith(SYNC_END, index)) {
      state.inSyncBlock = false;
      result += SYNC_END;
      index += SYNC_END.length;
      continue;
    }

    if (state.inSyncBlock && input.startsWith(CLEAR, index)) {
      index += CLEAR.length;
      continue;
    }

    result += input[index];
    index += 1;
  }

  return result;
};

export const filterSyncBlockClears = (
  data: string,
  state: SyncBlockFilterState,
): string => {
  const { emit, pending } = splitPendingMarkerSuffix(`${state.pending}${data}`);
  state.pending = pending;
  if (!emit) {
    return "";
  }

  return scanSyncBlockClears(emit, state);
};

export const createSyncBlockFilterState = (): SyncBlockFilterState => ({
  inSyncBlock: false,
  pending: "",
});
