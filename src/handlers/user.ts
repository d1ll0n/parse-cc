// src/handlers/user.ts
import type { UserEntry } from "../types/entries.js";
import { isTextBlock, isToolResultBlock } from "../types/content.js";
import { condenseTool, type ToolResultOptions } from "./tool-results.js";
import type { CondensedMessage, CondensedToolResult } from "./types.js";

export interface UserOptions extends ToolResultOptions {}

export function handleUser(entry: UserEntry, opts: UserOptions = {}): CondensedMessage {
  const result: CondensedMessage = {
    role: "user",
    timestamp: entry.timestamp,
  };

  const content = entry.message.content;

  if (typeof content === "string") {
    result.text = content;
    return result;
  }

  const textParts: string[] = [];
  const toolResults: CondensedToolResult[] = [];

  for (const block of content) {
    if (isTextBlock(block)) {
      // Skip system-reminder injections
      if (block.text.startsWith("<system-reminder>")) continue;
      textParts.push(block.text);
    } else if (isToolResultBlock(block)) {
      toolResults.push(
        condenseTool(
          block.tool_use_id,
          block,
          entry.toolUseResult && typeof entry.toolUseResult === "object"
            ? (entry.toolUseResult as Record<string, unknown>)
            : undefined,
          opts
        )
      );
    }
  }

  if (textParts.length > 0) result.text = textParts.join("\n");
  if (toolResults.length > 0) result.toolResults = toolResults;
  return result;
}
