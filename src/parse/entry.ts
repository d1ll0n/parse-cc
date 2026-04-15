import type { LogEntry } from "../types/entries.js";

/**
 * Convert a raw JSON value into a typed `LogEntry`.
 *
 * This is a minimal passthrough that casts the value rather than validating
 * it — every object with a `type` string field is accepted as-is. Returns
 * null only for values that cannot plausibly be a log entry: non-objects,
 * arrays, and objects without a `type` string field.
 */
export function parseEntry(raw: unknown): LogEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.type !== "string") return null;
  return obj as unknown as LogEntry;
}
