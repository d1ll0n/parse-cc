/**
 * Delta update describing tools that were added to or removed from the
 * deferred-tools list during a session turn.
 */
export interface DeferredToolsDeltaPayload {
  type: "deferred_tools_delta";
  /** Names of tools newly added to the deferred set. */
  addedNames: string[];
  /** Raw schema lines corresponding to the added tools. */
  addedLines: string[];
  /** Names of tools removed from the deferred set. */
  removedNames: string[];
}

/**
 * A snapshot of the skill (slash-command) registry injected into the session
 * at startup or when the skill list changes.
 */
export interface SkillListingPayload {
  type: "skill_listing";
  /** Full text of the skill listing as injected into the system prompt. */
  content: string;
  /** Total number of skills present at the time of this snapshot. */
  skillCount: number;
  /** `true` for the first listing injected at session start. */
  isInitial: boolean;
}

/**
 * Result of a hook script that ran successfully and produced output to inject
 * back into the conversation as a tool result.
 */
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

/**
 * Additional context lines provided by a hook for injection into the
 * conversation without replacing the tool result.
 */
export interface HookAdditionalContextPayload {
  type: "hook_additional_context";
  hookName: string;
  hookEvent: string;
  toolUseID: string;
  /** Lines of additional context to inject. */
  content: string[];
}

/**
 * A system-level message emitted by a hook to be injected into the
 * conversation as a system prompt addition.
 */
export interface HookSystemMessagePayload {
  type: "hook_system_message";
  hookName: string;
  hookEvent: string;
  toolUseID: string;
  content: string;
}

/**
 * Snapshot of the tool allow-list in effect for the session, as set by
 * permission mode or `--allowedTools` CLI flags.
 */
export interface CommandPermissionsPayload {
  type: "command_permissions";
  /** Names of tools the agent is permitted to call in this session. */
  allowedTools: string[];
}

/**
 * Records that the harness opened a file in the connected IDE.
 */
export interface OpenedFileInIdePayload {
  type: "opened_file_in_ide";
  filename: string;
}

/**
 * Records that the connected IDE has a specific line range selected, providing
 * the agent with the selected text as context.
 */
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

/**
 * A command queued for the agent to execute, optionally carrying inline
 * content. The shape is intentionally open (`[key: string]: unknown`) because
 * queued commands can carry arbitrary extra fields depending on the command
 * type.
 */
export interface QueuedCommandPayload {
  type: "queued_command";
  content?: string;
  [key: string]: unknown;
}

/**
 * Discriminated union of all structured payloads that can appear inside an
 * `AttachmentEntry`. Attachment entries carry harness-level metadata that is
 * not part of the conversational message stream — things like hook outputs,
 * IDE context, skill listings, and permission snapshots. Each variant is
 * discriminated by its `type` field.
 */
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

export interface CompactFileReferencePayload {
  type: "compact_file_reference";
  displayPath: string;
  filename: string;
}

export interface DateChangePayload {
  type: "date_change";
  newDate: string;
}

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

export interface EditedTextFilePayload {
  type: "edited_text_file";
  filename: string;
  snippet: string;
}

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

export interface InvokedSkillsPayload {
  type: "invoked_skills";
  skills: { content: string; name: string; path: string }[];
}

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

export interface PlanFileReferencePayload {
  type: "plan_file_reference";
  planContent: string;
  planFilePath: string;
}

export interface PlanModeExitPayload {
  type: "plan_mode_exit";
  planExists: boolean;
  planFilePath: string;
}

export interface PlanModePayload {
  type: "plan_mode";
  isSubAgent: boolean;
  planExists: boolean;
  planFilePath: string;
  reminderType: string;
}

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

export interface TodoReminderPayload {
  type: "todo_reminder";
  content: unknown /* empty */[];
  itemCount: number;
}
