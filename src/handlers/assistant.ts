// src/handlers/assistant.ts
import type { AssistantEntry } from "../types/entries.js";
import { isTextBlock, isThinkingBlock, isToolUseBlock } from "../types/content.js";
import { truncateString } from "../truncate.js";
import type { CondensedContentBlock, CondensedMessage } from "./types.js";

export interface AssistantOptions {
  thinkingMaxLen?: number;
  toolInputMaxLen?: number;
}

const DEFAULT_THINKING_MAX = 500;
const DEFAULT_TOOL_INPUT_MAX = 500;

/** Keys in tool_use input that tend to contain large file content */
const LARGE_INPUT_KEYS = new Set([
  "content", // Write
  "old_string", // Edit
  "new_string", // Edit
  "prompt", // Agent
  "command", // Bash
]);

export function handleAssistant(
  entry: AssistantEntry,
  opts: AssistantOptions = {}
): CondensedMessage {
  const thinkingMax = opts.thinkingMaxLen ?? DEFAULT_THINKING_MAX;
  const toolInputMax = opts.toolInputMaxLen ?? DEFAULT_TOOL_INPUT_MAX;

  const blocks: CondensedContentBlock[] = [];
  for (const block of entry.message.content) {
    if (isTextBlock(block)) {
      blocks.push({ type: "text", text: block.text });
    } else if (isThinkingBlock(block)) {
      const thinking = block.thinking ?? "";
      if (thinking.length > 0) {
        blocks.push({ type: "thinking", summary: truncateString(thinking, thinkingMax) });
      }
    } else if (isToolUseBlock(block)) {
      blocks.push({
        type: "tool_use",
        name: block.name,
        input: truncateToolInput(block.input ?? {}, toolInputMax),
      });
    }
  }

  return {
    role: "assistant",
    timestamp: entry.timestamp,
    content: blocks,
  };
}

function truncateToolInput(
  input: Record<string, unknown>,
  maxLen: number
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (LARGE_INPUT_KEYS.has(key) && typeof value === "string") {
      result[key] = truncateString(value, maxLen);
    } else {
      result[key] = value;
    }
  }
  return result;
}
