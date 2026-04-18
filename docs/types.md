# Data types

Every type the `parse-cc` library exports, organized by category. Use Ctrl-F with the type name to jump directly; all `#anchor` links from other docs point here.

This doc is a reference — if you want examples of how to USE these types, see [getting-started.md](getting-started.md), [querying.md](querying.md), and other topic guides.

## Discriminated unions at a glance

- [`LogEntry`](#logentry) — every top-level entry in a session `.jsonl`, keyed on `type`
- [`ContentBlock`](#contentblock) — items inside a user/assistant message content array
- [`AttachmentPayload`](#attachmentpayload) — subtypes of `attachment` entries
- [`ToolUseResultData`](#tooluseresultdata) — per-tool shapes for `toolUseResult`

---

## Top-level entries

Every line in a session `.jsonl` file parses to one of these types. The `type` field is the discriminant. Most entry types extend an internal `ConversationalBase` that adds `uuid`, `parentUuid`, `timestamp`, `sessionId`, and a handful of optional context fields.

### LogEntry

The top-level discriminated union of every entry that can appear in a session JSONL file. Keyed on the `type` field.

```ts
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
```

**Variants:**
- [`UserEntry`](#userentry) — `type: "user"`
- [`AssistantEntry`](#assistantentry) — `type: "assistant"`
- [`SystemEntry`](#systementry) — `type: "system"`
- [`SummaryEntry`](#summaryentry) — `type: "summary"`
- [`FileHistorySnapshotEntry`](#filehistorysnapshotentry) — `type: "file-history-snapshot"`
- [`QueueOperationEntry`](#queueoperationentry) — `type: "queue-operation"`
- [`AttachmentEntry`](#attachmententry) — `type: "attachment"`
- [`PermissionModeEntry`](#permissionmodeentry) — `type: "permission-mode"`
- [`ProgressEntry`](#progressentry) — `type: "progress"`
- [`LastPromptEntry`](#lastpromptentry) — `type: "last-prompt"`
- [`AgentNameEntry`](#agentnameentry) — `type: "agent-name"`
- [`CustomTitleEntry`](#customtitleentry) — `type: "custom-title"`
- [`PrLinkEntry`](#prlinkentry) — `type: "pr-link"`
- [`WorktreeStateEntry`](#worktreestateentry) — `type: "worktree-state"`
- [`UnknownEntry`](#unknownentry) — any unrecognized `type` value

---

### UserEntry

A turn from the human side of the conversation — either a direct user message or a tool result being fed back to the model.

```ts
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
```

**Produced by:** parsed from `user` entries in session JSONL logs

**Example:**

```json
{
  "type": "user",
  "uuid": "u1",
  "parentUuid": null,
  "timestamp": "2026-04-10T00:00:00Z",
  "sessionId": "sess-1",
  "message": { "role": "user", "content": "Fix the bug in parser.ts" }
}
```

---

### AssistantEntry

A model response turn, carrying the full message payload including token usage and stop reason.

```ts
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
```

**Produced by:** parsed from `assistant` entries in session JSONL logs

**Example:**

```json
{
  "type": "assistant",
  "uuid": "a1",
  "parentUuid": "u1",
  "timestamp": "2026-04-10T00:00:01Z",
  "sessionId": "sess-1",
  "message": {
    "role": "assistant",
    "id": "msg_1",
    "model": "claude-sonnet-4-6",
    "content": [{ "type": "text", "text": "I'll look at the file." }],
    "stop_reason": "tool_use",
    "stop_sequence": null,
    "usage": { "input_tokens": 100, "output_tokens": 20 }
  }
}
```

---

### SystemEntry

A structured event emitted by the Claude Code harness itself — session init, turn timing, local command output, or hook summaries.

```ts
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
```

**Produced by:** parsed from `system` entries in session JSONL logs

**Example:**

```json
{
  "type": "system",
  "uuid": "s1",
  "parentUuid": "u3",
  "sessionId": "sess-1",
  "timestamp": "2026-01-01T00:00:06Z",
  "subtype": "stop_hook_summary"
}
```

---

### SummaryEntry

A compaction summary injected at the beginning of a condensed context window, containing a prose description of earlier conversation content.

```ts
export interface SummaryEntry {
  type: "summary";
  summary: string;
  /** UUID of the last message in the thread this summary covers. */
  leafUuid: string;
}
```

**Produced by:** parsed from `summary` entries in session JSONL logs (written during context compaction)

**Example:**

```json
{
  "type": "summary",
  "summary": "The user asked to fix a parsing bug. The assistant identified the issue in parser.ts and corrected the variable assignment.",
  "leafUuid": "a3"
}
```

---

### FileHistorySnapshotEntry

A snapshot of tracked file backups at a point in the conversation, recording which file versions were saved to the file-history store.

```ts
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
```

**Produced by:** parsed from `file-history-snapshot` entries in session JSONL logs

**Example:**

```json
{
  "type": "file-history-snapshot",
  "messageId": "m1",
  "snapshot": {
    "messageId": "m1",
    "trackedFileBackups": {
      "notes.md": {
        "backupFileName": "abc123@v2",
        "version": 2,
        "backupTime": "2026-04-10T10:00:05Z"
      }
    },
    "timestamp": "2026-04-10T10:00:04Z"
  },
  "isSnapshotUpdate": false
}
```

---

### QueueOperationEntry

Records an operation on the Claude Code command queue — typically enqueue or dequeue events for user-submitted commands.

```ts
export interface QueueOperationEntry {
  type: "queue-operation";
  /** Describes the queue mutation (e.g., `"enqueue"`, `"dequeue"`). */
  operation: string;
  timestamp?: string;
  sessionId?: string;
  content?: string;
}
```

**Produced by:** parsed from `queue-operation` entries in session JSONL logs

**Example:**

```json
{
  "type": "queue-operation",
  "operation": "enqueue",
  "timestamp": "2026-04-10T12:00:00Z",
  "sessionId": "sess-1"
}
```

---

### AttachmentEntry

A structured side-channel payload attached to a conversation turn — used for skill listings, hook results, IDE events, and other harness-generated metadata.

```ts
export interface AttachmentEntry extends ConversationalBase {
  type: "attachment";
  attachment: AttachmentPayload;
  entrypoint: string;
  forkedFrom?: { messageUuid: string; sessionId: string };
  slug?: string;
}
```

**Produced by:** parsed from `attachment` entries in session JSONL logs; the `attachment` field is a [`AttachmentPayload`](#attachmentpayload) discriminated union

**Example:**

```json
{
  "type": "attachment",
  "uuid": "att-1",
  "parentUuid": "u1",
  "timestamp": "2026-04-10T00:00:00Z",
  "sessionId": "sess-1",
  "attachment": {
    "type": "skill_listing",
    "content": "- commit: Create git commits\n- review-pr: Review pull requests\n",
    "skillCount": 2,
    "isInitial": true
  }
}
```

---

### PermissionModeEntry

Records the active tool-permission mode for a session (e.g. `"default"`, `"acceptEdits"`).

```ts
export interface PermissionModeEntry {
  type: "permission-mode";
  sessionId: string;
  /** The permission mode now in effect. */
  permissionMode: string;
}
```

**Produced by:** parsed from `permission-mode` entries in session JSONL logs

**Example:**

```json
{
  "type": "permission-mode",
  "sessionId": "sess-1",
  "permissionMode": "default"
}
```

---

### ProgressEntry

An in-flight progress notification from a running tool or subagent, emitted asynchronously during long operations.

```ts
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
```

**Produced by:** parsed from `progress` entries in session JSONL logs

**Example:**

```json
{
  "type": "progress",
  "parentUuid": "a2",
  "sessionId": "sess-1",
  "timestamp": "2026-01-01T00:00:04.5Z",
  "data": { "type": "agent_progress", "agentId": "abc" },
  "toolUseID": "tmsg",
  "parentToolUseID": "toolu_2"
}
```

---

### LastPromptEntry

Records the last prompt sent in a session, persisted so it can be restored after a crash or resumption.

```ts
export interface LastPromptEntry {
  type: "last-prompt";
  lastPrompt: string;
  sessionId?: string;
  timestamp?: string;
}
```

**Produced by:** parsed from `last-prompt` entries in session JSONL logs

**Example:**

```json
{
  "type": "last-prompt",
  "lastPrompt": "Can you also add tests for the new function?",
  "sessionId": "sess-1",
  "timestamp": "2026-04-10T15:30:00Z"
}
```

---

### AgentNameEntry

Records the display name assigned to a sub-agent for the current session — written by the harness so tooling can surface a friendly label without re-deriving it.

```ts
export interface AgentNameEntry {
  type: "agent-name";
  sessionId: string;
  agentName: string;
}
```

**Produced by:** parsed from `agent-name` entries in session JSONL logs

**Example:**

```json
{
  "type": "agent-name",
  "sessionId": "sess-1",
  "agentName": "code-reviewer"
}
```

---

### CustomTitleEntry

Records a user- or harness-assigned custom title for a session. Used by the Claude Code UI to display a human-readable session name in place of the default first-prompt preview.

```ts
export interface CustomTitleEntry {
  type: "custom-title";
  sessionId: string;
  customTitle: string;
}
```

**Produced by:** parsed from `custom-title` entries in session JSONL logs

**Example:**

```json
{
  "type": "custom-title",
  "sessionId": "sess-1",
  "customTitle": "Refactor auth middleware"
}
```

---

### PrLinkEntry

Records that a session was associated with a GitHub pull request — typically written when the user creates or links a PR from within Claude Code.

```ts
export interface PrLinkEntry {
  type: "pr-link";
  sessionId: string;
  /** Owner/name slug of the repository the PR lives in (e.g. `"acme/app"`). */
  prRepository: string;
  prNumber: number;
  prUrl: string;
  timestamp: string;
}
```

**Produced by:** parsed from `pr-link` entries in session JSONL logs

**Example:**

```json
{
  "type": "pr-link",
  "sessionId": "sess-1",
  "prRepository": "acme/app",
  "prNumber": 42,
  "prUrl": "https://github.com/acme/app/pull/42",
  "timestamp": "2026-04-10T12:34:56Z"
}
```

---

### WorktreeStateEntry

Records the worktree context for a session that was launched inside a disposable git worktree, preserving enough information to map results back to the original branch/checkout after the worktree is removed.

```ts
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
```

**Produced by:** parsed from `worktree-state` entries in session JSONL logs

**Example:**

```json
{
  "type": "worktree-state",
  "sessionId": "sess-1",
  "worktreeSession": {
    "sessionId": "sess-1",
    "worktreeName": "feat-auth",
    "worktreePath": "/tmp/worktrees/feat-auth",
    "worktreeBranch": "feat/auth",
    "originalBranch": "main",
    "originalCwd": "/home/user/repo",
    "originalHeadCommit": "abc123"
  }
}
```

---

### UnknownEntry

Fallback for entry types not recognized by the parser — the raw object is preserved verbatim so no data is silently dropped.

```ts
export interface UnknownEntry {
  type: string;
  [key: string]: unknown;
}
```

**Produced by:** parsed from any entry whose `type` field doesn't match a known variant

**Example:**

```json
{
  "type": "some-future-entry-type",
  "data": "unknown payload preserved as-is"
}
```

---

### UsageMetadata

Token counts from a single assistant API call, including cache activity. Nested inside [`AssistantEntry`](#assistantentry).

```ts
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
```

**Produced by:** part of `AssistantEntry.message.usage`; aggregated by `Session.metrics()` in `src/derive/metrics.ts`

**Example:**

```json
{
  "input_tokens": 2048,
  "output_tokens": 312,
  "cache_read_input_tokens": 1800,
  "cache_creation_input_tokens": 248
}
```

---

### StopReason

Why the model stopped generating — mirrors the Anthropic API stop reason values.

```ts
export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | null;
```

**Produced by:** part of `AssistantEntry.message.stop_reason`

**Example:** `"end_turn"`, `"tool_use"`, or `null`

---

## Content blocks

Items inside a `message.content` array. Assistant entries always use `ContentBlock[]`; user entries use either a plain `string` (simple text prompt) or `ContentBlock[]` (tool results and multi-part messages).

### ContentBlock

Discriminated union of all block types that can appear inside a message content array. Keyed on the `type` field.

```ts
export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | ImageBlock;
```

**Variants:**
- [`TextBlock`](#textblock) — `type: "text"`
- [`ThinkingBlock`](#thinkingblock) — `type: "thinking"`
- [`ToolUseBlock`](#tooluseblock) — `type: "tool_use"`
- [`ToolResultBlock`](#toolresultblock) — `type: "tool_result"`
- [`ImageBlock`](#imageblock) — `type: "image"`

---

### TextBlock

A plain prose block from the model — the primary output of a non-tool response turn.

```ts
export interface TextBlock {
  type: "text";
  text: string;
}
```

**Produced by:** part of `AssistantEntry.message.content`

**Example:**

```json
{ "type": "text", "text": "Found the issue. Let me fix it." }
```

---

### ThinkingBlock

An extended thinking block emitted when the model reasons through a problem before responding. The `signature` field is an opaque integrity token from the API.

```ts
export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  /** Cryptographic signature attesting to the thinking content's authenticity. */
  signature?: string;
}
```

**Produced by:** part of `AssistantEntry.message.content` when extended thinking is enabled

**Example:**

```json
{
  "type": "thinking",
  "thinking": "Let me look at the code to understand the structure.",
  "signature": "ErUB..."
}
```

---

### ToolUseBlock

A tool invocation emitted by the model — carries the tool name, a unique ID used to match it with its result, and the structured input.

```ts
export interface ToolUseBlock {
  type: "tool_use";
  /** Unique identifier for this specific tool invocation. */
  id: string;
  /** Name of the tool being called (e.g., `"Bash"`, `"Read"`, `"Write"`). */
  name: string;
  /** Arguments passed to the tool, keyed by parameter name. */
  input: Record<string, unknown>;
  caller?: { type: string };
}
```

**Produced by:** part of `AssistantEntry.message.content` when `stop_reason` is `"tool_use"`

**Example:**

```json
{
  "type": "tool_use",
  "id": "toolu_01abc",
  "name": "Read",
  "input": { "file_path": "/src/parser.ts" }
}
```

---

### ToolResultBlock

The result of a tool call, fed back to the model in a subsequent user turn. The `tool_use_id` links it to the originating [`ToolUseBlock`](#tooluseblock).

```ts
export interface ToolResultBlock {
  type: "tool_result";
  /** References the `id` of the `ToolUseBlock` this result corresponds to. */
  tool_use_id: string;
  content: string | ContentBlock[];
  /** `true` when the tool execution returned an error. */
  is_error?: boolean;
}
```

**Produced by:** part of `UserEntry.message.content` for tool-result turns

**Example:**

```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_01abc",
  "content": "1\tconst x = 1;\n2\tconst y = 2;\n",
  "is_error": false
}
```

---

### ImageBlock

An image passed to the model, encoded as base64. Appears in user message content when a file or screenshot is attached.

```ts
export interface ImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    /** Base64-encoded image bytes. May be truncated in parsed logs for size. */
    data: string;
  };
}
```

**Produced by:** part of `UserEntry.message.content` when an image is attached

**Example:**

```json
{
  "type": "image",
  "source": {
    "type": "base64",
    "media_type": "image/png",
    "data": "iVBORw0KGgo..."
  }
}
```

---

## Attachment payloads

The `attachment` field of an [`AttachmentEntry`](#attachmententry) is one of these payloads, keyed on `type`.

### AttachmentPayload

Discriminated union of every structured payload that can appear inside an `AttachmentEntry`. Keyed on the `type` field.

```ts
export type AttachmentPayload =
  | DeferredToolsDeltaPayload
  | SkillListingPayload
  | HookSuccessPayload
  | HookAdditionalContextPayload
  | HookSystemMessagePayload
  | CommandPermissionsPayload
  | OpenedFileInIdePayload
  | SelectedLinesInIdePayload
  | QueuedCommandPayload
  | CompactFileReferencePayload
  | DateChangePayload
  | DiagnosticsPayload
  | EditedTextFilePayload
  | FilePayload
  | HookNonBlockingErrorPayload
  | InvokedSkillsPayload
  | NestedMemoryPayload
  | PlanFileReferencePayload
  | PlanModeExitPayload
  | PlanModePayload
  | TaskReminderPayload
  | TodoReminderPayload;
```

**Variants:**
- [`DeferredToolsDeltaPayload`](#deferredtoolsdeltapayload) — `type: "deferred_tools_delta"`
- [`SkillListingPayload`](#skilllistingpayload) — `type: "skill_listing"`
- [`HookSuccessPayload`](#hooksuccesspayload) — `type: "hook_success"`
- [`HookAdditionalContextPayload`](#hookadditionalcontextpayload) — `type: "hook_additional_context"`
- [`HookSystemMessagePayload`](#hooksystemmessagepayload) — `type: "hook_system_message"`
- [`CommandPermissionsPayload`](#commandpermissionspayload) — `type: "command_permissions"`
- [`OpenedFileInIdePayload`](#openedfileinidepayload) — `type: "opened_file_in_ide"`
- [`SelectedLinesInIdePayload`](#selectedlinesinidepayload) — `type: "selected_lines_in_ide"`
- [`QueuedCommandPayload`](#queuedcommandpayload) — `type: "queued_command"`

---

### SkillListingPayload

The full skill listing injected by the harness at session start (or on update), listing available slash commands and their descriptions.

```ts
export interface SkillListingPayload {
  type: "skill_listing";
  /** Full text of the skill listing as injected into the system prompt. */
  content: string;
  /** Total number of skills present at the time of this snapshot. */
  skillCount: number;
  /** `true` for the first listing injected at session start. */
  isInitial: boolean;
}
```

**Produced by:** parsed from `attachment` entries with `attachment.type === "skill_listing"`; consumed by `Session.skills()` in `src/derive/skills.ts`

**Example:**

```json
{
  "type": "skill_listing",
  "content": "- commit: Create git commits\n- review-pr: Review a pull request\n",
  "skillCount": 2,
  "isInitial": true
}
```

---

### DeferredToolsDeltaPayload

An incremental update to the deferred-tools registry, listing tool names added or removed since the last delta.

```ts
export interface DeferredToolsDeltaPayload {
  type: "deferred_tools_delta";
  /** Names of tools newly added to the deferred set. */
  addedNames: string[];
  /** Raw schema lines corresponding to the added tools. */
  addedLines: string[];
  /** Names of tools removed from the deferred set. */
  removedNames: string[];
}
```

**Produced by:** parsed from `attachment` entries with `attachment.type === "deferred_tools_delta"`

**Example:**

```json
{
  "type": "deferred_tools_delta",
  "addedNames": ["WebFetch", "WebSearch"],
  "addedLines": ["WebFetch — fetch a URL", "WebSearch — search the web"],
  "removedNames": []
}
```

---

### HookSuccessPayload

The result of a hook that ran successfully and produced output, including command details, timing, and the content surfaced to the model.

```ts
export interface HookSuccessPayload {
  type: "hook_success";
  hookName: string;
  /** The lifecycle event that triggered the hook (e.g., `"PreToolUse"`). */
  hookEvent: string;
  /** Shell command that was executed. */
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  /** Formatted content injected into the tool result. */
  content: string;
  /** ID of the tool-use block this hook is associated with. */
  toolUseID: string;
}
```

**Produced by:** parsed from `attachment` entries with `attachment.type === "hook_success"`

**Example:**

```json
{
  "type": "hook_success",
  "hookName": "pre-tool",
  "hookEvent": "PreToolUse",
  "command": "scripts/check-lint.sh",
  "stdout": "All checks passed.\n",
  "stderr": "",
  "exitCode": 0,
  "durationMs": 312,
  "content": "Lint: OK",
  "toolUseID": "toolu_01abc"
}
```

---

### HookAdditionalContextPayload

Extra context lines injected by a hook into the model's system prompt for the current turn.

```ts
export interface HookAdditionalContextPayload {
  type: "hook_additional_context";
  hookName: string;
  hookEvent: string;
  toolUseID: string;
  /** Lines of additional context to inject. */
  content: string[];
}
```

**Produced by:** parsed from `attachment` entries with `attachment.type === "hook_additional_context"`

**Example:**

```json
{
  "type": "hook_additional_context",
  "hookName": "context-injector",
  "hookEvent": "PreToolUse",
  "toolUseID": "toolu_01abc",
  "content": ["Current branch: feature/my-feature", "Last deploy: 2026-04-09"]
}
```

---

### HookSystemMessagePayload

A system-level message injected by a hook — similar to `HookAdditionalContextPayload` but as a single string rather than an array.

```ts
export interface HookSystemMessagePayload {
  type: "hook_system_message";
  hookName: string;
  hookEvent: string;
  toolUseID: string;
  content: string;
}
```

**Produced by:** parsed from `attachment` entries with `attachment.type === "hook_system_message"`

**Example:**

```json
{
  "type": "hook_system_message",
  "hookName": "safety-check",
  "hookEvent": "PreToolUse",
  "toolUseID": "toolu_01abc",
  "content": "Warning: this file is marked read-only in project settings."
}
```

---

### CommandPermissionsPayload

The set of tools the user has explicitly allowed for this session, recorded at session start.

```ts
export interface CommandPermissionsPayload {
  type: "command_permissions";
  /** Names of tools the agent is permitted to call in this session. */
  allowedTools: string[];
}
```

**Produced by:** parsed from `attachment` entries with `attachment.type === "command_permissions"`

**Example:**

```json
{
  "type": "command_permissions",
  "allowedTools": ["Bash", "Read", "Edit", "Write"]
}
```

---

### OpenedFileInIdePayload

Records that the user opened a file in an IDE integration, providing context about the active file.

```ts
export interface OpenedFileInIdePayload {
  type: "opened_file_in_ide";
  filename: string;
}
```

**Produced by:** parsed from `attachment` entries with `attachment.type === "opened_file_in_ide"`

**Example:**

```json
{
  "type": "opened_file_in_ide",
  "filename": "/src/parser.ts"
}
```

---

### SelectedLinesInIdePayload

Records that the user selected a range of lines in an IDE integration, providing the selected content as context.

```ts
export interface SelectedLinesInIdePayload {
  type: "selected_lines_in_ide";
  filename: string;
  /** IDE-relative display path shown in the editor tab. */
  displayPath: string;
  /** Name of the IDE that reported the selection. */
  ideName: string;
  lineStart: number;
  lineEnd: number;
  /** Text of the selected lines. */
  content: string;
}
```

**Produced by:** parsed from `attachment` entries with `attachment.type === "selected_lines_in_ide"`

**Example:**

```json
{
  "type": "selected_lines_in_ide",
  "filename": "/src/parser.ts",
  "displayPath": "src/parser.ts",
  "ideName": "VS Code",
  "lineStart": 42,
  "lineEnd": 58,
  "content": "function parse(input: string) {\n  // ...\n}\n"
}
```

---

### QueuedCommandPayload

A command that was queued for execution, with optional content and arbitrary additional fields.

```ts
export interface QueuedCommandPayload {
  type: "queued_command";
  content?: string;
  [key: string]: unknown;
}
```

**Produced by:** parsed from `attachment` entries with `attachment.type === "queued_command"`

**Example:**

```json
{
  "type": "queued_command",
  "content": "/commit"
}
```

---

## Tool-result data

The optional `toolUseResult` field on a [`UserEntry`](#userentry) carries structured metadata about the tool that was called. This is richer than the raw `tool_result` content block — it duplicates and extends the tool output for analysis.

### ToolUseResultData

Discriminated union of per-tool structured metadata shapes. Note that not all values are typed objects — the union includes `string` (e.g. `"User rejected tool use"`) and a catch-all `Record<string, unknown>` for unrecognized tools.

```ts
export type ToolUseResultData =
  | BashToolResultData
  | FileToolResultData
  | AgentToolResultData
  | Record<string, unknown>
  | string; // "User rejected tool use" etc.

```

**Variants:**
- [`BashToolResultData`](#bashtoolresultdata) — bash/shell command results
- [`FileToolResultData`](#filetoolresultdata) — file read/write/edit results
- [`AgentToolResultData`](#agenttoolresultdata) — subagent/Task tool results
- `Record<string, unknown>` — unrecognized tool with object data
- `string` — plain string result (e.g. rejection message)

---

### BashToolResultData

Structured metadata for a completed Bash tool call — stdout/stderr and process state. The text content also appears in the `tool_result` block; this shape provides typed access to the components.

```ts
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
```

**Produced by:** `UserEntry.toolUseResult` when the tool was `Bash`

**Example:**

```json
{
  "stdout": "Tests passed: 42\n",
  "stderr": "",
  "exitCode": 0,
  "interrupted": false,
  "sandbox": true
}
```

---

### FileToolResultData

Structured metadata for a file tool call (Read, Edit, Write, etc.), carrying the affected path and change details.

```ts
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
```

**Produced by:** `UserEntry.toolUseResult` when the tool was `Read`, `Edit`, `Write`, or similar file tools

**Example:**

```json
{
  "filePath": "/src/parser.ts",
  "oldString": "const x = 1;",
  "newString": "const x = 2;",
  "originalFile": "const x = 1;\nconst y = 2;\n",
  "structuredPatch": []
}
```

---

### AgentToolResultData

Structured metadata for a completed subagent (Agent/Task tool) call, including status, token totals, and the agent's final content.

```ts
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
```

**Produced by:** `UserEntry.toolUseResult` when the tool was `Agent` or `Task`

**Example:**

```json
{
  "status": "completed",
  "agentId": "agent-xyz",
  "totalDurationMs": 14200,
  "totalTokens": 8340,
  "totalToolUseCount": 12,
  "content": [{ "type": "text", "text": "Done. All tests pass." }]
}
```

---

## Derived types

These types are computed from raw log entries by `Session` methods. They are not stored in the JSONL files — they are produced on demand by the `src/derive/` modules.

### SessionMetrics

Aggregate token and timing statistics across all entries in a session, computed by summing usage fields from every [`AssistantEntry`](#assistantentry).

```ts
export interface SessionMetrics {
  durationMs: number;
  /** Sum of input, output, cache-read, and cache-creation tokens. */
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  /** Tokens read back from the prompt cache. */
  cacheReadTokens: number;
  /** Tokens written to the prompt cache. */
  cacheCreationTokens: number;
  /** Count of every entry in the session, regardless of type. */
  messageCount: number;
}
```

**Produced by:** `Session.metrics()` in `src/derive/metrics.ts`

**Example:**

```json
{
  "durationMs": 183000,
  "totalTokens": 48200,
  "inputTokens": 35000,
  "outputTokens": 4200,
  "cacheReadTokens": 8500,
  "cacheCreationTokens": 500,
  "messageCount": 47
}
```

---

### CompactionAnalysis

Analysis of how a session's context window was managed, broken into phases separated by compaction events (each compaction truncates the window and summarizes earlier content).

```ts
export interface CompactionAnalysis {
  /** Total unique context tokens consumed across all phases. Undefined when
   * the session contains no main-chain assistant entries. */
  contextConsumption: number | undefined;
  /** Ordered breakdown of context growth and compaction events. */
  phases: CompactionPhase[];
  compactionCount: number;
}
```

**Produced by:** `Session.compaction()` in `src/derive/compaction.ts`

**Example:**

```json
{
  "contextConsumption": 185000,
  "compactionCount": 2,
  "phases": [
    { "phaseNumber": 1, "contribution": 82000, "peakTokens": 82000, "postCompaction": 12000 },
    { "phaseNumber": 2, "contribution": 74000, "peakTokens": 86000, "postCompaction": 9500 },
    { "phaseNumber": 3, "contribution": 29000, "peakTokens": 38500 }
  ]
}
```

---

### CompactionPhase

One phase within a [`CompactionAnalysis`](#compactionanalysis), spanning from the previous compaction (or session start) to the next compaction event.

```ts
export interface CompactionPhase {
  phaseNumber: number;
  /** Net tokens added to context consumption during this phase. Computed as
   * the phase's peak tokens minus the post-compaction baseline from the
   * previous phase. */
  contribution: number;
  /** Highest context token count observed at the start of this phase (the
   * last main-chain assistant input_tokens seen before the compaction). */
  peakTokens: number;
  /** Token count immediately after the compaction that ended this phase.
   * Undefined for the final phase when no compaction followed it. */
  postCompaction?: number;
}
```

**Produced by:** part of `CompactionAnalysis.phases`; computed in `src/derive/compaction.ts`

**Example:**

```json
{
  "phaseNumber": 1,
  "contribution": 82000,
  "peakTokens": 82000,
  "postCompaction": 12000
}
```

---

### ToolCall

A single tool invocation extracted from an assistant message, with a flag indicating whether it is a subagent dispatch (Agent/Task tool).

```ts
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
```

**Produced by:** `Session.toolCalls()` in `src/derive/tool-calls.ts`

**Example:**

```json
{
  "id": "toolu_01abc",
  "name": "Bash",
  "input": { "command": "npm test" },
  "entryUuid": "a2",
  "isTask": false
}
```

---

### ToolResult

A single tool result extracted from a user message, paired back to its originating tool call by `toolUseId`.

```ts
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
```

**Produced by:** `Session.toolResults()` in `src/derive/tool-calls.ts`

**Example:**

```json
{
  "toolUseId": "toolu_01abc",
  "content": "Tests passed: 42\n",
  "isError": false,
  "entryUuid": "u2"
}
```

---

### FirstUserMessage

The first meaningful user prompt in a session — noise entries (system reminders, local command output) and pure slash-command turns are skipped. Truncated to 500 characters.

```ts
export interface FirstUserMessage {
  /** The user's prompt text, truncated to 500 characters. When the only user
   * entries are slash commands, this is the command name (e.g. `"/model"`). */
  text: string;
  timestamp: string;
}
```

**Produced by:** `Session.firstUserMessage()` in `src/derive/first-message.ts`; also used by `listSessions()` in `src/discover.ts`

**Example:**

```json
{
  "text": "Fix the bug in parser.ts",
  "timestamp": "2026-01-01T00:00:01Z"
}
```

---

### FirstObservedMetadata

Session-level scalar metadata extracted from the first entries that carry each field — used when you need basic context without loading the full session.

```ts
export interface FirstObservedMetadata {
  sessionId: string | null;
  /** Claude Code version string (e.g. `"1.2.3"`). */
  version: string | null;
  gitBranch: string | null;
  cwd: string | null;
  /** The active permission mode (e.g. `"default"`, `"bypassPermissions"`).
   * Only sourced from `permission-mode` entries. */
  permissionMode: string | null;
}
```

**Produced by:** `Session.firstObservedMetadata()` in `src/derive/first-observed.ts`; also used internally by `listSessions()` in `src/discover.ts`

**Example:**

```json
{
  "sessionId": "sess-1",
  "version": "1.9.3",
  "gitBranch": "feature/my-feature",
  "cwd": "/root/myproject",
  "permissionMode": "default"
}
```

---

### SkillsInfo

The skill listing observed in the session, with the raw payload and a pre-parsed list of skill names.

```ts
export interface SkillsInfo {
  /** The raw skill_listing attachment payload, or null if none was found. */
  listing: SkillListingPayload | null;
  /** Parsed skill names extracted from the bullet list in `listing.content`.
   * Plugin-scoped names (e.g. `"plugin-dev:plugin-structure"`) are preserved
   * in full — the colon within the name is not treated as a separator. */
  names: string[];
}
```

**Produced by:** `Session.skills()` in `src/derive/skills.ts`

**Example:**

```json
{
  "names": ["commit", "review-pr", "feature-dev"],
  "listing": {
    "type": "skill_listing",
    "content": "- commit: Create git commits\n- review-pr: Review a pull request\n- feature-dev: Guided feature development\n",
    "skillCount": 3,
    "isInitial": true
  }
}
```

---

### PersistedOutputRef

A reference to a large tool result that was too big to inline — the harness wrote it to disk and stored a `<persisted-output>` wrapper in its place. Call `loadPersistedOutput(ref)` to read the full content.

```ts
export interface PersistedOutputRef {
  /** Absolute path to the off-log file that holds the full output. */
  filePath: string;
  /** Human-readable size label extracted from the wrapper header (e.g. `"2.3 MB"`). */
  sizeLabel: string;
  /** Truncated preview text included inside the wrapper. */
  preview: string;
}
```

**Produced by:** `parsePersistedOutput()` in `src/persisted-output.ts`

**Example:**

```json
{
  "filePath": "/tmp/claude/output-abc123.txt",
  "sizeLabel": "2.4 MB",
  "preview": "line 1\nline 2\nline 3\n..."
}
```

---

## Discovery types

These types are returned by the `listProjects`, `listSessions`, and `findAllSessions` functions in `src/discover.ts`. They provide lightweight metadata without loading full session content.

### ProjectInfo

Metadata for a single Claude Code project directory, returned by `listProjects()`.

```ts
export interface ProjectInfo {
  /** Slugified directory name (e.g. "-home-user-myproject") */
  name: string;
  /** Absolute path to the project directory */
  path: string;
  /** Count of .jsonl files at the top level of the project dir (excludes subagent files) */
  sessionCount: number;
}
```

**Produced by:** `listProjects()` in `src/discover.ts`

**Example:**

```json
{
  "name": "-home-user-myproject",
  "path": "/home/user/.claude/projects/-home-user-myproject",
  "sessionCount": 14
}
```

---

### SessionSummary

Lightweight metadata about a single session file, computed by reading only the first `headLines` lines (default 200). Returned by `listSessions()` and `findAllSessions()`.

```ts
export interface SessionSummary {
  /** Absolute path to the .jsonl file */
  path: string;
  sessionId: string;
  version: string | null;
  gitBranch: string | null;
  cwd: string | null;
  /** First real user prompt (with command-name fallback). */
  firstUserMessage: FirstUserMessage | null;
  /** Timestamp of the first entry that has a timestamp, or null. */
  firstTimestamp: string | null;
  /** Timestamp of the last entry scanned (within the head-of-file slice). */
  lastTimestamp: string | null;
  /** Byte size of the session file. */
  fileSize: number;
}
```

**Produced by:** `listSessions()` / `findAllSessions()` in `src/discover.ts`

**Example:**

```json
{
  "path": "/home/user/.claude/projects/-home-user-myproject/abc123.jsonl",
  "sessionId": "sess-abc123",
  "version": "1.9.3",
  "gitBranch": "main",
  "cwd": "/root/myproject",
  "firstUserMessage": { "text": "Fix the bug in parser.ts", "timestamp": "2026-01-01T00:00:01Z" },
  "firstTimestamp": "2026-01-01T00:00:00Z",
  "lastTimestamp": "2026-01-01T00:05:42Z",
  "fileSize": 184320
}
```

---

### ListSessionsOptions

Options accepted by `listSessions()` and `findAllSessions()` to control how much of each file is scanned.

```ts
export interface ListSessionsOptions {
  /** How many lines to read from the head of each file when computing summaries. Default 200. */
  headLines?: number;
}
```

**Produced by:** passed as input to `listSessions()` / `findAllSessions()` in `src/discover.ts`

**Example:**

```json
{ "headLines": 500 }
```

---

## File-history types

These types relate to the file-history store — a directory of versioned file blobs that Claude Code maintains alongside sessions. See [file-history.md](file-history.md) for the full picture.

### FileHistoryVersion

A single version of a tracked file, joining the snapshot metadata from the session log with on-disk state in the file-history blob store.

```ts
export interface FileHistoryVersion {
  /** The path the file was tracked under (as it appeared in trackedFileBackups). */
  filePath: string;
  /** Version number (starts at 1). */
  version: number;
  /** Timestamp from the snapshot entry. */
  backupTime: string;
  /** The blob's filename inside the file-history dir, or null if no blob was stored. */
  backupFileName: string | null;
  /** Absolute path to the blob on disk, or null if no blob was stored or the blob is missing. */
  blobPath: string | null;
  /** Size in bytes, or null if unknown. */
  size: number | null;
}
```

**Produced by:** `Session.fileHistory()` in `src/file-history.ts`

**Example:**

```json
{
  "filePath": "notes.md",
  "version": 2,
  "backupTime": "2026-04-10T10:00:05Z",
  "backupFileName": "abc123@v2",
  "blobPath": "/home/user/.claude/file-history/sess-fh/abc123@v2",
  "size": 2048
}
```

---

### TrackedFileBackup

The raw per-file backup record stored inside a [`FileHistorySnapshotEntry`](#filehistorysnapshotentry) snapshot, before it is joined with on-disk blob metadata.

```ts
export interface TrackedFileBackup {
  /** Filename of the backup copy, or `null` if the backup was not persisted. */
  backupFileName: string | null;
  /** Monotonically increasing version counter for this file's backup history. */
  version: number;
  backupTime: string;
}
```

**Produced by:** parsed from `FileHistorySnapshotEntry.snapshot.trackedFileBackups[path]`

**Example:**

```json
{
  "backupFileName": "abc123@v2",
  "version": 2,
  "backupTime": "2026-04-10T10:00:05Z"
}
```
---

### CompactFileReferencePayload

Synthesized by codegen — see source JSDoc.

```ts
export interface CompactFileReferencePayload {
  type: "compact_file_reference";
  displayPath: string;
  filename: string;
}
```
---

### DateChangePayload

Synthesized by codegen — see source JSDoc.

```ts
export interface DateChangePayload {
  type: "date_change";
  newDate: string;
}
```
---

### DiagnosticsPayload

Synthesized by codegen — see source JSDoc.

```ts
export interface DiagnosticsPayload {
  type: "diagnostics";
  files: {
    diagnostics: {
      code: string;
      message: string;
      range: {
        end: { character: number; line: number };
        start: { character: number; line: number };
      };
      severity: string;
      source: string;
    }[];
    uri: string;
  }[];
  isNew: boolean;
}
```
---

### EditedTextFilePayload

Synthesized by codegen — see source JSDoc.

```ts
export interface EditedTextFilePayload {
  type: "edited_text_file";
  filename: string;
  snippet: string;
}
```
---

### FilePayload

Synthesized by codegen — see source JSDoc.

```ts
export interface FilePayload {
  type: "file";
  content: {
    file: {
      content: string;
      filePath: string;
      numLines: number;
      startLine: number;
      totalLines: number;
    };
    type: string;
  };
  displayPath: string;
  filename: string;
}
```
---

### HookNonBlockingErrorPayload

Synthesized by codegen — see source JSDoc.

```ts
export interface HookNonBlockingErrorPayload {
  type: "hook_non_blocking_error";
  command: string;
  durationMs: number;
  exitCode: number;
  hookEvent: string;
  hookName: string;
  stderr: string;
  stdout: string;
  toolUseID: string;
}
```
---

### InvokedSkillsPayload

Synthesized by codegen — see source JSDoc.

```ts
export interface InvokedSkillsPayload {
  type: "invoked_skills";
  skills: { content: string; name: string; path: string }[];
}
```
---

### NestedMemoryPayload

Synthesized by codegen — see source JSDoc.

```ts
export interface NestedMemoryPayload {
  type: "nested_memory";
  content: {
    content: string;
    contentDiffersFromDisk: boolean;
    path: string;
    rawContent?: string;
    type: string;
  };
  displayPath: string;
  path: string;
}
```
---

### PlanFileReferencePayload

Synthesized by codegen — see source JSDoc.

```ts
export interface PlanFileReferencePayload {
  type: "plan_file_reference";
  planContent: string;
  planFilePath: string;
}
```
---

### PlanModeExitPayload

Synthesized by codegen — see source JSDoc.

```ts
export interface PlanModeExitPayload {
  type: "plan_mode_exit";
  planExists: boolean;
  planFilePath: string;
}
```
---

### PlanModePayload

Synthesized by codegen — see source JSDoc.

```ts
export interface PlanModePayload {
  type: "plan_mode";
  isSubAgent: boolean;
  planExists: boolean;
  planFilePath: string;
  reminderType: string;
}
```
---

### TaskReminderPayload

Synthesized by codegen — see source JSDoc.

```ts
export interface TaskReminderPayload {
  type: "task_reminder";
  content: (
    | unknown /* empty */
    | {
        activeForm?: string;
        blockedBy: (unknown /* empty */ | string)[];
        blocks: (unknown /* empty */ | string)[];
        description: string;
        id: string;
        metadata?: unknown /* Task.metadata is Record<string, unknown> — caller-supplied keys, not part of the harness contract.
         */;
        owner?: string;
        status: string;
        subject: string;
      }
  )[];
  itemCount: number;
}
```
---

### TodoReminderPayload

Synthesized by codegen — see source JSDoc.

```ts
export interface TodoReminderPayload {
  type: "todo_reminder";
  content: unknown /* empty */[];
  itemCount: number;
}
```
