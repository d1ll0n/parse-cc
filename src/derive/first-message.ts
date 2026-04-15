import type { LogEntry } from "../types/entries.js";
import { isUserEntry } from "../types/entries.js";
import type { ContentBlock } from "../types/content.js";

/**
 * The first meaningful user prompt in a session, truncated to 500 characters.
 *
 * "Meaningful" excludes noise injected by the Claude Code harness (system
 * reminders, local command output, interrupted-request markers) and slash
 * commands. When only slash commands are present, the command name is used as
 * a fallback.
 */
export interface FirstUserMessage {
  /** The user's prompt text, truncated to 500 characters. When the only user
   * entries are slash commands, this is the command name (e.g. `"/model"`). */
  text: string;
  timestamp: string;
}

const MAX_LEN = 500;
const NOISE_PREFIXES = ["<local-command-stdout>", "<local-command-caveat>", "<system-reminder>"];

function extractText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join(" ");
}

function isNoise(text: string): boolean {
  return NOISE_PREFIXES.some((p) => text.startsWith(p)) || text.startsWith("[Request interrupted");
}

function parseCommandName(text: string): string | null {
  const m = /<command-name>\/([^<]+)<\/command-name>/.exec(text);
  return m ? `/${m[1]}` : null;
}

/**
 * Find the first non-noise user prompt in a session.
 *
 * Scans user entries in order and skips entries whose text starts with a
 * noise prefix (`<local-command-stdout>`, `<local-command-caveat>`,
 * `<system-reminder>`) or with `[Request interrupted`. Entries that look like
 * slash commands (contain `<command-name>/…</command-name>`) are recorded as
 * a fallback but the scan continues looking for plain-text input.
 *
 * Returns the first plain-text entry truncated to 500 characters, or the
 * first slash-command name if no plain-text entry was found. Returns null when
 * the session contains no qualifying user entries at all.
 */
export function extractFirstUserMessage(entries: LogEntry[]): FirstUserMessage | null {
  let commandFallback: FirstUserMessage | null = null;
  for (const e of entries) {
    if (!isUserEntry(e)) continue;
    const text = extractText(e.message.content).trim();
    if (!text) continue;
    if (isNoise(text)) continue;
    const cmd = parseCommandName(text);
    if (cmd) {
      if (!commandFallback) commandFallback = { text: cmd, timestamp: e.timestamp };
      continue;
    }
    return { text: text.slice(0, MAX_LEN), timestamp: e.timestamp };
  }
  return commandFallback;
}
