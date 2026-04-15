import { readFile } from "node:fs/promises";
import type { ContentBlock } from "./types/content.js";

/**
 * Describes a parsed `<persisted-output>` wrapper — the envelope Claude Code
 * emits when a tool result is too large to inline in the session log.
 *
 * Obtain instances via `parsePersistedOutput`; load the full content via
 * `loadPersistedOutput`.
 */
export interface PersistedOutputRef {
  /** Absolute path to the off-log file that holds the full output. */
  filePath: string;
  /** Human-readable size label extracted from the wrapper header (e.g. `"2.3 MB"`). */
  sizeLabel: string;
  /** Truncated preview text included inside the wrapper. */
  preview: string;
}

/**
 * Parses the `<persisted-output>` wrapper emitted when a tool_result is
 * too large to inline. Returns null for any input that doesn't match.
 * Real-world wrappers do not have a closing tag — the block just runs
 * to the end of the string.
 */
const HEADER_RE =
  /^<persisted-output>\nOutput too large \(([^)]+)\)\. Full output saved to: ([^\n]+)\n\nPreview \(first [^)]+\):\n([\s\S]*)$/;

/**
 * Synchronously parse a `<persisted-output>` envelope from a raw tool-result
 * content value.
 *
 * Returns `null` for any non-string input, or for strings that do not match
 * the expected wrapper pattern. No I/O is performed.
 */
export function parsePersistedOutput(content: unknown): PersistedOutputRef | null {
  if (typeof content !== "string") return null;
  const m = HEADER_RE.exec(content);
  if (!m) return null;
  return {
    sizeLabel: m[1],
    filePath: m[2],
    preview: m[3].replace(/\n?<\/persisted-output>\s*$/, "").trimEnd(),
  };
}

/**
 * Load the full content referenced by a `PersistedOutputRef`.
 *
 * Returns a parsed `ContentBlock[]` when the file extension is `.json`,
 * or the raw UTF-8 string for `.txt` (and any other extension).
 */
export async function loadPersistedOutput(
  ref: PersistedOutputRef
): Promise<string | ContentBlock[]> {
  const text = await readFile(ref.filePath, "utf8");
  if (ref.filePath.endsWith(".json")) {
    return JSON.parse(text) as ContentBlock[];
  }
  return text;
}
