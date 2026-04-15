import type { LogEntry } from "../types/entries.js";
import { isAssistantEntry, isUserEntry } from "../types/entries.js";
import type { ContentBlock } from "../types/content.js";
import { isToolUseBlock, isToolResultBlock } from "../types/content.js";

/**
 * A single tool_use block extracted from an assistant message.
 */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** UUID of the assistant entry that contains this tool_use block, for
   * cross-referencing against the original log entries. */
  entryUuid: string;
  /** True when the tool name is `"Agent"` or `"Task"`, indicating a
   * subagent dispatch rather than a regular tool invocation. */
  isTask: boolean;
}

/**
 * A single tool_result block extracted from a user message.
 */
export interface ToolResult {
  toolUseId: string;
  content: string | ContentBlock[];
  /** Whether the tool execution reported an error. Defaults to false when the
   * field is absent from the raw block. */
  isError: boolean;
  /** UUID of the user entry that contains this tool_result block, for
   * cross-referencing against the original log entries. */
  entryUuid: string;
}

const TASK_NAMES = new Set(["Agent", "Task"]);

/**
 * Extract every tool_use block from all assistant entries in a session.
 *
 * Returns a flat array — one `ToolCall` per block, in the order they appear
 * across entries. Only assistant entries are scanned; user and other entry
 * types are skipped.
 */
export function extractToolCalls(entries: LogEntry[]): ToolCall[] {
  const out: ToolCall[] = [];
  for (const e of entries) {
    if (!isAssistantEntry(e)) continue;
    for (const block of e.message.content) {
      if (!isToolUseBlock(block)) continue;
      out.push({
        id: block.id,
        name: block.name,
        input: block.input,
        entryUuid: e.uuid,
        isTask: TASK_NAMES.has(block.name),
      });
    }
  }
  return out;
}

/**
 * Extract every tool_result block from all user entries in a session.
 *
 * Returns a flat array — one `ToolResult` per block, in the order they appear
 * across entries. Only user entries whose content is an array are scanned;
 * string-content entries and all non-user types are skipped.
 */
export function extractToolResults(entries: LogEntry[]): ToolResult[] {
  const out: ToolResult[] = [];
  for (const e of entries) {
    if (!isUserEntry(e)) continue;
    if (!Array.isArray(e.message.content)) continue;
    for (const block of e.message.content) {
      if (!isToolResultBlock(block)) continue;
      out.push({
        toolUseId: block.tool_use_id,
        content: block.content,
        isError: block.is_error ?? false,
        entryUuid: e.uuid,
      });
    }
  }
  return out;
}
