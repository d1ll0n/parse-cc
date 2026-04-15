import type { LogEntry } from "../types/entries.js";
import { isAttachmentEntry } from "../types/entries.js";

/**
 * Compute the final set of deferred tool names for a session by replaying all
 * `deferred_tools_delta` attachment entries in order.
 *
 * Each delta carries an `addedNames` list and a `removedNames` list; the
 * function applies them sequentially to a running set and returns the result
 * as an array. The ordering of the output array reflects insertion order.
 *
 * Returns an empty array for sessions predating Claude Code v2.1.90, which
 * did not emit this attachment type.
 */
export function extractDeferredTools(entries: LogEntry[]): string[] {
  const set = new Set<string>();
  for (const e of entries) {
    if (!isAttachmentEntry(e)) continue;
    if (e.attachment.type !== "deferred_tools_delta") continue;
    for (const name of e.attachment.addedNames) set.add(name);
    for (const name of e.attachment.removedNames) set.delete(name);
  }
  return Array.from(set);
}
