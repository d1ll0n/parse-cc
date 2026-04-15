/**
 * A plain-text content block in a message's `content` array.
 */
export interface TextBlock {
  type: "text";
  text: string;
}

/**
 * An extended-thinking block produced when Claude reasons before responding.
 * Present only when extended thinking is enabled on the model.
 */
export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  /** Cryptographic signature attesting to the thinking content's authenticity. */
  signature?: string;
}

/**
 * A tool invocation block emitted by the assistant when it calls a tool.
 */
export interface ToolUseBlock {
  type: "tool_use";
  /** Unique identifier for this specific tool invocation. */
  id: string;
  /** Name of the tool being called (e.g., `"Bash"`, `"Read"`, `"Write"`). */
  name: string;
  /** Arguments passed to the tool, keyed by parameter name. */
  input: Record<string, unknown>;
}

/**
 * A tool result block carrying the output of a previous `ToolUseBlock`.
 * Appears in user-role messages injected by the harness after tool execution.
 */
export interface ToolResultBlock {
  type: "tool_result";
  /** References the `id` of the `ToolUseBlock` this result corresponds to. */
  tool_use_id: string;
  content: string | ContentBlock[];
  /** `true` when the tool execution returned an error. */
  is_error?: boolean;
}

/**
 * An inline image block, carrying base64-encoded image data.
 */
export interface ImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    /** Base64-encoded image bytes. May be truncated in parsed logs for size. */
    data: string;
  };
}

/**
 * Discriminated union of all block types that can appear in a
 * `message.content` array for both user and assistant entries.
 *
 * User messages typically contain `TextBlock`, `ToolResultBlock`, and
 * occasionally `ImageBlock`. Assistant messages contain `TextBlock`,
 * `ThinkingBlock`, and `ToolUseBlock`.
 */
export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | ImageBlock;

/** Type guard for `TextBlock`. */
export function isTextBlock(b: ContentBlock): b is TextBlock {
  return b.type === "text";
}
/** Type guard for `ThinkingBlock`. */
export function isThinkingBlock(b: ContentBlock): b is ThinkingBlock {
  return b.type === "thinking";
}
/** Type guard for `ToolUseBlock`. */
export function isToolUseBlock(b: ContentBlock): b is ToolUseBlock {
  return b.type === "tool_use";
}
/** Type guard for `ToolResultBlock`. */
export function isToolResultBlock(b: ContentBlock): b is ToolResultBlock {
  return b.type === "tool_result";
}
/** Type guard for `ImageBlock`. */
export function isImageBlock(b: ContentBlock): b is ImageBlock {
  return b.type === "image";
}
