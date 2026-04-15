import type { LogEntry } from "../types/entries.js";
import { isAssistantEntry } from "../types/entries.js";

/**
 * Aggregate token and duration statistics computed from a session's entries.
 *
 * Token counts come from assistant entries only; duration is derived from the
 * min/max timestamp across all entries regardless of type.
 */
export interface SessionMetrics {
  durationMs: number;
  /** Sum of input, output, cache-read, and cache-creation tokens. */
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  /** Tokens read back from the prompt cache. */
  cacheReadTokens: number;
  /** Tokens written to the prompt cache. */
  cacheCreationTokens: number;
  /** Count of every entry in the session, regardless of type. */
  messageCount: number;
}

const EMPTY: SessionMetrics = {
  durationMs: 0,
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  messageCount: 0,
};

/**
 * Compute aggregate metrics for a parsed session.
 *
 * Iterates all entries to find the timestamp range (duration) but only
 * accumulates token counts from assistant entries. Non-assistant entries
 * such as user turns and system events contribute to duration but not to
 * token totals. Cache tokens (read and creation) are included in
 * `totalTokens`.
 */
export function calculateMetrics(entries: LogEntry[]): SessionMetrics {
  if (entries.length === 0) return { ...EMPTY };

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let minTime = Number.POSITIVE_INFINITY;
  let maxTime = Number.NEGATIVE_INFINITY;

  for (const e of entries) {
    const ts = (e as { timestamp?: string }).timestamp;
    if (ts) {
      const t = Date.parse(ts);
      if (!Number.isNaN(t)) {
        if (t < minTime) minTime = t;
        if (t > maxTime) maxTime = t;
      }
    }
    if (!isAssistantEntry(e)) continue;
    const u = e.message.usage;
    inputTokens += u.input_tokens ?? 0;
    outputTokens += u.output_tokens ?? 0;
    cacheReadTokens += u.cache_read_input_tokens ?? 0;
    cacheCreationTokens += u.cache_creation_input_tokens ?? 0;
  }

  return {
    durationMs: maxTime > minTime ? maxTime - minTime : 0,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens,
    messageCount: entries.length,
  };
}
