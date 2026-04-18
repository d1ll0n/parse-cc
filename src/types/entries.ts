// src/types/entries.ts
import type { ContentBlock } from "./content.js";
import type { AttachmentPayload } from "./attachments.js";
import type { ToolUseResultData } from "./tool-results.js";

/**
 * The reason the model stopped generating tokens.
 *
 * - `"end_turn"` — model decided it was done.
 * - `"tool_use"` — model emitted a tool-use block and paused for results.
 * - `"max_tokens"` — response was cut off at the context or output-token limit.
 * - `"stop_sequence"` — a configured stop sequence was encountered.
 * - `null` — stop reason not yet available or not applicable.
 */
export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | null;

/**
 * Token-usage breakdown attached to every assistant message.
 * Values come directly from the Anthropic API response.
 */
export interface UsageMetadata {
  input_tokens: number;
  output_tokens: number;
  /** Tokens served from the prompt cache, avoiding re-processing cost. */
  cache_read_input_tokens?: number;
  /** Tokens written into the prompt cache during this request. */
  cache_creation_input_tokens?: number;
  /** Granular cache-creation breakdown by TTL tier. */
  cache_creation?: {
    ephemeral_1h_input_tokens?: number;
    ephemeral_5m_input_tokens?: number;
  };
  /** API service tier used for this request (e.g., `"standard"`). */
  service_tier?: string;
  inference_geo?: null | string;
  iterations?:
    | (
        | unknown /* empty */
        | {
            cache_creation: {
              ephemeral_1h_input_tokens: number;
              ephemeral_5m_input_tokens: number;
            };
            cache_creation_input_tokens: number;
            cache_read_input_tokens: number;
            input_tokens: number;
            output_tokens: number;
            type: string;
          }
      )[]
    | null;
  server_tool_use?: { web_fetch_requests: number; web_search_requests: number };
  speed?: null | string;
}

/**
 * Fields shared by all conversational entry types (user, assistant, system,
 * attachment). Not exported — use the concrete entry types directly.
 */
interface ConversationalBase {
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
  sessionId: string;
  /** Working directory of the Claude Code process at the time of the entry. */
  cwd?: string;
  gitBranch?: string;
  version?: string;
  /**
   * `true` when this entry belongs to a sidechain (sub-agent or background
   * conversation) rather than the main session thread.
   */
  isSidechain?: boolean;
  /** Origin of the actor that produced this entry (e.g., `"human"`, `"agent"`). */
  userType?: string;
  /** Identifier of the sub-agent that produced this entry, when applicable. */
  agentId?: string;
}

/**
 * A user-role entry in a session JSONL. Produced when the human sends a
 * prompt, when Claude Code auto-injects synthetic user content (tool results,
 * system-reminders, hook output), or when a compaction summary replaces prior
 * history.
 */
export interface UserEntry extends ConversationalBase {
  type: "user";
  message: { role: "user"; content: string | ContentBlock[] };
  /** Set by the harness for entries that wrap tool results, not human input. */
  isMeta?: boolean;
  /** `true` on the single entry that records a context-compaction summary. */
  isCompactSummary?: boolean;
  /** Tool-specific metadata for the tool whose result lives in `message.content`. */
  toolUseResult?: ToolUseResultData;
  sourceToolUseID?: string;
  sourceToolAssistantUUID?: string;
  entrypoint?: string;
  forkedFrom?: { messageUuid: string; sessionId: string };
  isVisibleInTranscriptOnly?: boolean;
  origin?: { kind: string };
  permissionMode?: string;
  planContent?: string;
  promptId?: string;
  slug?: string;
}

/**
 * An assistant-role entry containing the model's response for one turn.
 * Always carries a `UsageMetadata` block and a `StopReason`.
 */
export interface AssistantEntry extends ConversationalBase {
  type: "assistant";
  message: {
    role: "assistant";
    /** Anthropic API message ID (starts with `"msg_"`). */
    id: string;
    /** Model identifier used to generate this response. */
    model: string;
    content: ContentBlock[];
    stop_reason: StopReason;
    /** The actual stop-sequence string matched, or `null` if none. */
    stop_sequence: string | null;
    usage: UsageMetadata;
    container?: null;
    context_management?: null | { applied_edits: unknown /* empty */[] };
    stop_details?: null;
    type: string;
  };
  /** Unique request ID from the Anthropic API response headers. */
  requestId?: string;
  entrypoint?: string;
  error?: string;
  forkedFrom?: { messageUuid: string; sessionId: string };
  isApiErrorMessage?: boolean;
  slug?: string;
}

/**
 * A system-level operational entry emitted by the Claude Code harness itself,
 * not by the model. Covers session initialisation, turn-timing records,
 * local commands, and stop-hook summaries.
 */
export interface SystemEntry extends ConversationalBase {
  type: "system";
  /**
   * Categorises the system event:
   * - `"init"` — session started.
   * - `"turn_duration"` — wall-clock time for a completed model turn.
   * - `"local_command"` — a slash-command was run locally without an API call.
   * - `"stop_hook_summary"` — aggregated output from stop hooks.
   * - Other string values may appear for future or unreleased event types.
   */
  subtype: "init" | "turn_duration" | "local_command" | "stop_hook_summary" | string;
  /** Duration in milliseconds (present for `"turn_duration"` subtypes). */
  durationMs?: number;
  content?: string;
  /** `true` for system entries that are harness bookkeeping, not user-visible events. */
  isMeta?: boolean;
  cause?: { code: string; errno: number; path: string };
  compactMetadata?: {
    durationMs?: number;
    postTokens?: number;
    preCompactDiscoveredTools?: string[];
    preTokens: number;
    trigger: string;
  };
  entrypoint?: string;
  error?: {
    cause?: { code: string; errno: number; path: string };
    error?: { error: { message: string; type: string }; request_id: string; type: string };
    headers?: {
      "anthropic-organization-id": string;
      "cf-cache-status": string;
      "cf-ray": string;
      connection: string;
      "content-encoding": string;
      "content-security-policy": string;
      "content-type": string;
      date: string;
      "request-id": string;
      server: string;
      "server-timing": string;
      "strict-transport-security": string;
      "transfer-encoding": string;
      vary: string;
      "x-envoy-upstream-service-time": string;
      "x-robots-tag": string;
      "x-should-retry": string;
    };
    requestID?: string;
    status?: number;
    type?: null;
  };
  forkedFrom?: { messageUuid: string; sessionId: string };
  hasOutput?: boolean;
  hookCount?: number;
  hookErrors?: (unknown /* empty */ | string)[];
  hookInfos?: { command: string; durationMs: number }[];
  level?: string;
  logicalParentUuid?: string;
  maxRetries?: number;
  messageCount?: number;
  preventedContinuation?: boolean;
  retryAttempt?: number;
  retryInMs?: number;
  slug?: string;
  stopReason?: string;
  toolUseID?: string;
  url?: string;
}

/**
 * A high-level summary entry written at the end of a session (or sub-session)
 * by the compaction or summarisation process.
 */
export interface SummaryEntry {
  type: "summary";
  summary: string;
  /** UUID of the last message in the thread this summary covers. */
  leafUuid: string;
}

/**
 * Metadata about a single versioned backup of a tracked file, used to
 * support the undo/restore workflow.
 */
export interface TrackedFileBackup {
  /** Filename of the backup copy, or `null` if the backup was not persisted. */
  backupFileName: string | null;
  /** Monotonically increasing version counter for this file's backup history. */
  version: number;
  backupTime: string;
}

/**
 * A snapshot of the file-history tracker state at a particular message
 * boundary, enabling per-message file restoration.
 */
export interface FileHistorySnapshotEntry {
  type: "file-history-snapshot";
  /** ID of the message this snapshot is anchored to. */
  messageId: string;
  snapshot: {
    messageId: string;
    /** Map from file path to its backup metadata at this point in time. */
    trackedFileBackups: Record<string, TrackedFileBackup>;
    timestamp: string;
  };
  /** `true` when this entry reflects an incremental update rather than an initial snapshot. */
  isSnapshotUpdate?: boolean;
}

/**
 * Records a mutation to the session's command queue (enqueue, dequeue, clear,
 * etc.).
 */
export interface QueueOperationEntry {
  type: "queue-operation";
  /** Describes the queue mutation (e.g., `"enqueue"`, `"dequeue"`). */
  operation: string;
  timestamp?: string;
  sessionId?: string;
  content?: string;
}

/**
 * Wraps a structured attachment payload — harness metadata that is not part
 * of the conversational message stream (hook outputs, IDE context, skill
 * listings, permission snapshots, etc.).
 */
export interface AttachmentEntry extends ConversationalBase {
  type: "attachment";
  attachment: AttachmentPayload;
  entrypoint: string;
  forkedFrom?: { messageUuid: string; sessionId: string };
  slug?: string;
}

/**
 * Records a change to the active permission mode for the session
 * (e.g., switching between `"default"`, `"acceptEdits"`, `"bypassPermissions"`).
 */
export interface PermissionModeEntry {
  type: "permission-mode";
  sessionId: string;
  /** The permission mode now in effect. */
  permissionMode: string;
}

/**
 * A streaming progress update emitted by a sub-agent or long-running tool
 * during execution. These entries carry partial status and are not part of the
 * final conversation history.
 */
export interface ProgressEntry extends Partial<ConversationalBase> {
  type: "progress";
  data: {
    type?: string;
    agentId?: string;
    message?: unknown;
    command?: string;
    elapsedTimeMs?: number;
    elapsedTimeSeconds?: number;
    fullOutput?: string;
    hookEvent?: string;
    hookName?: string;
    normalizedMessages?: unknown /* empty */[];
    output?: string;
    prompt?: string;
    query?: string;
    resultCount?: number;
    serverName?: string;
    status?: string;
    taskDescription?: string;
    taskId?: string;
    taskType?: string;
    timeoutMs?: number;
    toolName?: string;
    totalBytes?: number;
    totalLines?: number;
  };
  /** ID of the parent tool-use block this progress update belongs to. */
  parentToolUseID?: string;
  /** ID of the tool-use block directly associated with this progress event. */
  toolUseID?: string;
  entrypoint?: string;
  slug?: string;
}

/**
 * Persists the final user prompt text for quick retrieval without re-parsing
 * the full conversation history.
 */
export interface LastPromptEntry {
  type: "last-prompt";
  lastPrompt: string;
  sessionId?: string;
  timestamp?: string;
}

/**
 * Records the display name assigned to a sub-agent for the current session.
 * Emitted when the harness labels an agent (e.g. the user-visible title shown
 * in the TUI) so it can be surfaced in tooling without re-deriving it.
 */
export interface AgentNameEntry {
  type: "agent-name";
  sessionId: string;
  agentName: string;
}

/**
 * Records a user- or harness-assigned custom title for a session. Used by the
 * Claude Code UI to display a human-readable session name in place of the
 * default first-prompt preview.
 */
export interface CustomTitleEntry {
  type: "custom-title";
  sessionId: string;
  customTitle: string;
}

/**
 * Records that a session was associated with a GitHub pull request — typically
 * written when the user creates or links a PR from within Claude Code.
 */
export interface PrLinkEntry {
  type: "pr-link";
  sessionId: string;
  /** Owner/name slug of the repository the PR lives in (e.g. `"acme/app"`). */
  prRepository: string;
  prNumber: number;
  prUrl: string;
  timestamp: string;
}

/**
 * Records the worktree context for a session that was launched inside a
 * disposable git worktree, preserving enough information to map results back
 * to the original branch/checkout after the worktree is removed.
 */
export interface WorktreeStateEntry {
  type: "worktree-state";
  sessionId: string;
  worktreeSession: {
    sessionId: string;
    /** Short name of the worktree (typically matches the directory name). */
    worktreeName: string;
    /** Absolute path to the worktree checkout on disk. */
    worktreePath: string;
    /** Branch checked out inside the worktree. */
    worktreeBranch: string;
    /** Branch the parent repo had checked out when the worktree was created. */
    originalBranch: string;
    /** Absolute path the parent repo was in when the worktree was created. */
    originalCwd: string;
    /** Commit SHA of the parent repo's HEAD at worktree-creation time. */
    originalHeadCommit: string;
  };
}

/** Fallback for entry types we don't recognize yet — preserved verbatim. */
export interface UnknownEntry {
  type: string;
  [key: string]: unknown;
}

/**
 * Top-level discriminated union of every entry type that can appear in a
 * Claude Code session JSONL file. Each line in the file deserialises to one
 * of these variants, discriminated by the `type` field.
 *
 * The most commonly used variants are `UserEntry`, `AssistantEntry`, and
 * `SystemEntry`. The remaining variants carry harness bookkeeping data. When
 * an unrecognised `type` value is encountered, the entry is represented as
 * `UnknownEntry`.
 */
export type LogEntry =
  | UserEntry
  | AssistantEntry
  | SystemEntry
  | SummaryEntry
  | FileHistorySnapshotEntry
  | QueueOperationEntry
  | AttachmentEntry
  | PermissionModeEntry
  | ProgressEntry
  | LastPromptEntry
  | AgentNameEntry
  | CustomTitleEntry
  | PrLinkEntry
  | WorktreeStateEntry
  | UnknownEntry;

// Type guards
/** Type guard: returns true if the entry's discriminator is `"user"`. */
export const isUserEntry = (e: LogEntry): e is UserEntry => e.type === "user";
/** Type guard: returns true if the entry's discriminator is `"assistant"`. */
export const isAssistantEntry = (e: LogEntry): e is AssistantEntry => e.type === "assistant";
/** Type guard: returns true if the entry's discriminator is `"system"`. */
export const isSystemEntry = (e: LogEntry): e is SystemEntry => e.type === "system";
/** Type guard: returns true if the entry's discriminator is `"summary"`. */
export const isSummaryEntry = (e: LogEntry): e is SummaryEntry => e.type === "summary";
/** Type guard: returns true if the entry's discriminator is `"file-history-snapshot"`. */
export const isFileHistorySnapshotEntry = (e: LogEntry): e is FileHistorySnapshotEntry =>
  e.type === "file-history-snapshot";
/** Type guard: returns true if the entry's discriminator is `"queue-operation"`. */
export const isQueueOperationEntry = (e: LogEntry): e is QueueOperationEntry =>
  e.type === "queue-operation";
/** Type guard: returns true if the entry's discriminator is `"attachment"`. */
export const isAttachmentEntry = (e: LogEntry): e is AttachmentEntry => e.type === "attachment";
/** Type guard: returns true if the entry's discriminator is `"permission-mode"`. */
export const isPermissionModeEntry = (e: LogEntry): e is PermissionModeEntry =>
  e.type === "permission-mode";
/** Type guard: returns true if the entry's discriminator is `"progress"`. */
export const isProgressEntry = (e: LogEntry): e is ProgressEntry => e.type === "progress";
/** Type guard: returns true if the entry's discriminator is `"last-prompt"`. */
export const isLastPromptEntry = (e: LogEntry): e is LastPromptEntry => e.type === "last-prompt";
/** Type guard: returns true if the entry's discriminator is `"agent-name"`. */
export const isAgentNameEntry = (e: LogEntry): e is AgentNameEntry => e.type === "agent-name";
/** Type guard: returns true if the entry's discriminator is `"custom-title"`. */
export const isCustomTitleEntry = (e: LogEntry): e is CustomTitleEntry => e.type === "custom-title";
/** Type guard: returns true if the entry's discriminator is `"pr-link"`. */
export const isPrLinkEntry = (e: LogEntry): e is PrLinkEntry => e.type === "pr-link";
/** Type guard: returns true if the entry's discriminator is `"worktree-state"`. */
export const isWorktreeStateEntry = (e: LogEntry): e is WorktreeStateEntry =>
  e.type === "worktree-state";
