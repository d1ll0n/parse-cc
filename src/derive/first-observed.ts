import type { LogEntry } from "../types/entries.js";

/**
 * Session-level scalar metadata collected by scanning entries in order and
 * taking the first non-null value seen for each field.
 *
 * Most fields are read from any entry type that carries them. The exception is
 * `permissionMode`, which is only read from entries with
 * `type: "permission-mode"` to avoid picking up stray fields from other entry
 * types.
 */
export interface FirstObservedMetadata {
  sessionId: string | null;
  /** Claude Code version string (e.g. `"1.2.3"`). */
  version: string | null;
  gitBranch: string | null;
  cwd: string | null;
  /** The active permission mode (e.g. `"default"`, `"bypassPermissions"`).
   * Only sourced from `permission-mode` entries. */
  permissionMode: string | null;
}

/**
 * Collect session-level scalar metadata from a list of log entries.
 *
 * Iterates entries in order and records the first non-null string value seen
 * for each field. Stops early once all five fields have been populated.
 * `permissionMode` is exclusively sourced from entries whose `type` is
 * `"permission-mode"`; all other fields are read from whichever entry first
 * carries them.
 */
export function firstObservedMetadata(entries: LogEntry[]): FirstObservedMetadata {
  let sessionId: string | null = null;
  let version: string | null = null;
  let gitBranch: string | null = null;
  let cwd: string | null = null;
  let permissionMode: string | null = null;

  for (const e of entries) {
    const rec = e as Record<string, unknown>;
    if (!sessionId && typeof rec.sessionId === "string") sessionId = rec.sessionId;
    if (!version && typeof rec.version === "string") version = rec.version;
    if (!gitBranch && typeof rec.gitBranch === "string") gitBranch = rec.gitBranch;
    if (!cwd && typeof rec.cwd === "string") cwd = rec.cwd;
    if (!permissionMode && e.type === "permission-mode" && typeof rec.permissionMode === "string") {
      permissionMode = rec.permissionMode;
    }
    if (sessionId && version && gitBranch && cwd && permissionMode) break;
  }

  return { sessionId, version, gitBranch, cwd, permissionMode };
}
