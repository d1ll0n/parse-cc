import type { LogEntry } from "../types/entries.js";

/**
 * Remove duplicate assistant message entries that share a `requestId`,
 * keeping only the last occurrence of each.
 *
 * Ported from claude-devtools. Claude Code streams partial assistant messages
 * as multiple JSONL lines that share the same `requestId` but carry
 * progressively larger `output_tokens` counts — only the final line has the
 * correct totals. This function discards all but the last entry per
 * `requestId`. Entries with no `requestId` are passed through unchanged.
 */
export function deduplicateByRequestId(entries: LogEntry[]): LogEntry[] {
  const lastIdxByReq = new Map<string, number>();
  entries.forEach((e, i) => {
    const rid = (e as { requestId?: string }).requestId;
    if (rid) lastIdxByReq.set(rid, i);
  });
  if (lastIdxByReq.size === 0) return entries;
  return entries.filter((e, i) => {
    const rid = (e as { requestId?: string }).requestId;
    if (!rid) return true;
    return lastIdxByReq.get(rid) === i;
  });
}
