// src/handlers/types.ts

/** A text content block in a condensed user message (no tool results) */
export interface CondensedText {
  type: "text";
  text: string;
}

/** A thinking block condensed down to a truncated summary. */
export interface CondensedThinking {
  type: "thinking";
  summary: string;
}

/** A tool_use block condensed to just name + possibly-truncated input. */
export interface CondensedToolUse {
  type: "tool_use";
  name: string;
  input: Record<string, unknown>;
}

export type CondensedContentBlock = CondensedText | CondensedThinking | CondensedToolUse;

/** Reference to a tool-result whose content was spilled to an external file. */
export interface CondensedPersistedOutput {
  filePath: string;
  sizeLabel: string;
}

/** A condensed tool_result block (with optional metadata + persisted-output ref). */
export interface CondensedToolResult {
  toolUseId: string;
  content: string;
  isError?: boolean;
  metadata?: Record<string, unknown>;
  persistedOutput?: CondensedPersistedOutput;
}

/** A condensed message: either user or assistant. */
export interface CondensedMessage {
  role: "user" | "assistant";
  timestamp: string;
  text?: string;
  content?: CondensedContentBlock[];
  toolResults?: CondensedToolResult[];
}
