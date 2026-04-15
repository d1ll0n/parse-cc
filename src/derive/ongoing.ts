// src/derive/ongoing.ts
import type { LogEntry } from "../types/entries.js";
import { isAssistantEntry, isUserEntry } from "../types/entries.js";
import {
  isThinkingBlock,
  isToolResultBlock,
  isToolUseBlock,
  isTextBlock,
} from "../types/content.js";

/**
 * Activity-index-based detection. Port of claude-devtools
 * `analyzeSessionFileMetadata` isOngoing logic.
 *
 * Returns true if the session has any "open" activity that was not
 * followed by an ending event (assistant text, ExitPlanMode, shutdown
 * SendMessage, or user rejection).
 */
export function checkOngoing(entries: LogEntry[]): boolean {
  let activityIndex = 0;
  let lastEndingIndex = -1;
  let hasAnyOngoing = false;
  let hasActivityAfterLastEnding = false;
  const shutdownToolIds = new Set<string>();

  const bumpOngoing = () => {
    hasAnyOngoing = true;
    if (lastEndingIndex >= 0) hasActivityAfterLastEnding = true;
    activityIndex++;
  };
  const markEnding = () => {
    lastEndingIndex = activityIndex++;
    hasActivityAfterLastEnding = false;
  };

  for (const entry of entries) {
    if (isAssistantEntry(entry)) {
      for (const block of entry.message.content) {
        if (isThinkingBlock(block) && block.thinking) {
          bumpOngoing();
        } else if (isToolUseBlock(block)) {
          if (block.name === "ExitPlanMode") {
            markEnding();
          } else if (
            block.name === "SendMessage" &&
            (block.input as { type?: string; approve?: boolean }).type === "shutdown_response" &&
            (block.input as { approve?: boolean }).approve === true
          ) {
            shutdownToolIds.add(block.id);
            markEnding();
          } else {
            bumpOngoing();
          }
        } else if (isTextBlock(block) && block.text.trim().length > 0) {
          markEnding();
        }
      }
    } else if (isUserEntry(entry) && Array.isArray(entry.message.content)) {
      const isRejection = entry.toolUseResult === "User rejected tool use";
      for (const block of entry.message.content) {
        if (isToolResultBlock(block)) {
          if (shutdownToolIds.has(block.tool_use_id) || isRejection) {
            markEnding();
          } else {
            bumpOngoing();
          }
        } else if (
          isTextBlock(block) &&
          typeof block.text === "string" &&
          block.text.startsWith("[Request interrupted")
        ) {
          markEnding();
        }
      }
    }
  }

  if (lastEndingIndex === -1) return hasAnyOngoing;
  return hasActivityAfterLastEnding;
}
