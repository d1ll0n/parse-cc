// src/index.ts
export { Session } from "./session.js";
export type {
  LogEntry,
  UserEntry,
  AssistantEntry,
  SystemEntry,
  SummaryEntry,
  FileHistorySnapshotEntry,
  TrackedFileBackup,
  QueueOperationEntry,
  AttachmentEntry,
  PermissionModeEntry,
  ProgressEntry,
  LastPromptEntry,
  AgentNameEntry,
  CustomTitleEntry,
  PrLinkEntry,
  WorktreeStateEntry,
  UnknownEntry,
  UsageMetadata,
  StopReason,
} from "./types/entries.js";
export {
  isUserEntry,
  isAssistantEntry,
  isSystemEntry,
  isSummaryEntry,
  isFileHistorySnapshotEntry,
  isQueueOperationEntry,
  isAttachmentEntry,
  isPermissionModeEntry,
  isProgressEntry,
  isLastPromptEntry,
  isAgentNameEntry,
  isCustomTitleEntry,
  isPrLinkEntry,
  isWorktreeStateEntry,
} from "./types/entries.js";
export type {
  ContentBlock,
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
  ToolResultBlock,
  ImageBlock,
} from "./types/content.js";
export {
  isTextBlock,
  isThinkingBlock,
  isToolUseBlock,
  isToolResultBlock,
  isImageBlock,
} from "./types/content.js";
export type {
  AttachmentPayload,
  SkillListingPayload,
  DeferredToolsDeltaPayload,
  HookSuccessPayload,
  HookAdditionalContextPayload,
  HookSystemMessagePayload,
  CommandPermissionsPayload,
  OpenedFileInIdePayload,
  SelectedLinesInIdePayload,
  QueuedCommandPayload,
} from "./types/attachments.js";
export type {
  ToolUseResultData,
  BashToolResultData,
  FileToolResultData,
  AgentToolResultData,
} from "./types/tool-results.js";
export type { SessionMetrics } from "./derive/metrics.js";
export type { CompactionAnalysis, CompactionPhase } from "./derive/compaction.js";
export type { ToolCall, ToolResult } from "./derive/tool-calls.js";
export type { FirstUserMessage } from "./derive/first-message.js";
export type { FirstObservedMetadata } from "./derive/first-observed.js";
export type { SkillsInfo } from "./derive/skills.js";
export type { PersistedOutputRef } from "./persisted-output.js";
export { parsePersistedOutput, loadPersistedOutput } from "./persisted-output.js";
export { findSubagentFiles } from "./subagents.js";
export {
  defaultProjectsDir,
  listProjects,
  listSessions,
  findAllSessions,
} from "./discover.js";
export type { ProjectInfo, SessionSummary, ListSessionsOptions } from "./discover.js";
export {
  defaultFileHistoryDir,
  findFileHistoryDir,
  listFileHistoryBlobs,
  readFileHistoryBlob,
} from "./file-history.js";
export type { FileHistoryVersion } from "./file-history.js";
export {
  defaultTasksDir,
  findTasksDir,
  listTaskSessionIds,
  listTasks,
  readTask,
} from "./tasks.js";
export type { Task } from "./tasks.js";
