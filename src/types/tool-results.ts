import type { ContentBlock } from "./content.js";

/**
 * Structured metadata for a completed `Bash` tool invocation.
 * Stdout/stderr also appear in the `tool_result` content block, so this
 * data is duplicative but convenient for programmatic access.
 */
export interface BashToolResultData {
  stdout?: string;
  stderr?: string;
  /** `true` if the user interrupted the running command mid-execution. */
  interrupted?: boolean;
  /** `true` when the result content is an image rather than text. */
  isImage?: boolean;
  /** Human-readable interpretation of the process exit code. */
  returnCodeInterpretation?: string;
  /** `true` if the command ran inside a sandbox environment. */
  sandbox?: boolean;
  exitCode?: number;
}

/**
 * Structured metadata for a completed file-editing tool invocation
 * (`Read`, `Write`, `Edit`, `Glob`, `Grep`, etc.).
 */
export interface FileToolResultData {
  /** Distinguishes between file creation, update/edit, and plain text read. */
  type?: "create" | "update" | "text";
  filePath?: string;
  content?: string | ContentBlock[];
  /** Unified-diff patch chunks for edit operations. */
  structuredPatch?: unknown[];
  /** Original file content before an edit was applied. */
  originalFile?: string;
  oldString?: string;
  newString?: string;
  numLines?: number;
  startLine?: number;
  totalLines?: number;
}

/**
 * Structured metadata for a completed sub-agent (`Agent`) tool invocation,
 * summarising the spawned agent's outcome and resource usage.
 */
export interface AgentToolResultData {
  /** Terminal state of the sub-agent run. */
  status: "completed" | "failed" | "aborted" | string;
  agentId: string;
  /** The prompt passed to the sub-agent. */
  prompt?: string;
  /** Content blocks returned by the sub-agent as its final response. */
  content?: ContentBlock[];
  totalDurationMs?: number;
  totalTokens?: number;
  totalToolUseCount?: number;
  /** Full token-breakdown usage object as returned by the API. */
  usage?: Record<string, unknown>;
}

/**
 * Union of all known tool-result metadata shapes, plus an open `Record` for
 * unrecognised tools and a `string` literal for user rejection events (e.g.,
 * `"User rejected tool use"`).
 *
 * Consumers should narrow with `instanceof`-style checks or inspect known
 * discriminating fields (e.g., `agentId` for `AgentToolResultData`) before
 * accessing tool-specific properties.
 */
export type ToolUseResultData =
  | BashToolResultData
  | FileToolResultData
  | AgentToolResultData
  | Record<string, unknown>
  | string; // "User rejected tool use" etc.
