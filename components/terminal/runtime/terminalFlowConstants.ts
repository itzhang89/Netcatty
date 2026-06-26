/**
 * Terminal output flow-control thresholds.
 *
 * Aligned with VS Code `FlowControlConstants` in
 * `src/vs/platform/terminal/common/terminal.ts`.
 */
export const FLOW_HIGH_WATER_MARK = 100_000;
export const FLOW_LOW_WATER_MARK = 5_000;
/** Batched IPC ACK size (VS Code `CharCountAckSize`). Must be <= LOW watermark. */
export const FLOW_CHAR_COUNT_ACK_SIZE = 5_000;