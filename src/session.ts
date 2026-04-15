// src/session.ts
import path from "node:path";
import { readJsonlFile } from "./parse/read.js";
import { parseEntry } from "./parse/entry.js";
import { deduplicateByRequestId } from "./parse/dedupe.js";
import type { LogEntry } from "./types/entries.js";
import { isFileHistorySnapshotEntry } from "./types/entries.js";
import { calculateMetrics, type SessionMetrics } from "./derive/metrics.js";
import {
  findFileHistoryDir,
  readFileHistoryBlob,
  defaultFileHistoryDir,
  type FileHistoryVersion,
} from "./file-history.js";
import { firstObservedMetadata, type FirstObservedMetadata } from "./derive/first-observed.js";
import { extractFirstUserMessage, type FirstUserMessage } from "./derive/first-message.js";
import { checkOngoing } from "./derive/ongoing.js";
import { analyzeCompaction, type CompactionAnalysis } from "./derive/compaction.js";
import {
  extractToolCalls,
  extractToolResults,
  type ToolCall,
  type ToolResult,
} from "./derive/tool-calls.js";
import { extractSkills, type SkillsInfo } from "./derive/skills.js";
import { extractDeferredTools } from "./derive/deferred-tools.js";
import {
  parsePersistedOutput,
  loadPersistedOutput,
  type PersistedOutputRef,
} from "./persisted-output.js";
import { findSubagentFiles } from "./subagents.js";
import type { ContentBlock } from "./types/content.js";

/**
 * The library's central class. Wraps a single Claude Code session `.jsonl`
 * file and exposes typed introspection over its contents.
 *
 * **Construction is free** — the file is never opened until you await an
 * async method. Every async method is lazy-cached: the first call parses
 * the underlying data and stores a `Promise`; subsequent calls return the
 * same `Promise` immediately.
 *
 * **Scalar getters** (`sessionId`, `version`, `gitBranch`, `cwd`,
 * `permissionMode`) throw a descriptive `Error` until at least one async
 * method has been awaited, because they are populated as a side-effect of
 * parsing. The simplest way to prime them is:
 *
 * ```ts
 * const sess = new Session(filePath);
 * await sess.messages(); // primes all scalar getters
 * console.log(sess.sessionId);
 * ```
 */
export class Session {
  private _messages?: Promise<LogEntry[]>;
  private _meta: FirstObservedMetadata = {
    sessionId: null,
    version: null,
    gitBranch: null,
    cwd: null,
    permissionMode: null,
  };
  private _metaLoaded = false;
  private _metrics?: Promise<SessionMetrics>;
  private _firstUser?: Promise<FirstUserMessage | null>;
  private _isOngoing?: Promise<boolean>;
  private _compaction?: Promise<CompactionAnalysis>;
  private _toolCalls?: Promise<ToolCall[]>;
  private _toolResults?: Promise<ToolResult[]>;
  private _skills?: Promise<SkillsInfo>;
  private _deferredTools?: Promise<string[]>;
  private _subagents?: Promise<Session[]>;
  private _fileHistory?: Promise<FileHistoryVersion[]>;

  constructor(
    /** Absolute or relative path to a session `.jsonl` file. */
    public readonly path: string
  ) {}

  /**
   * Parse the session file and return every entry as a typed `LogEntry`.
   *
   * Entries are deduplicated by `requestId` so replayed messages are not
   * double-counted. The scalar metadata getters (`sessionId`, `version`,
   * etc.) are primed as a side effect of this call.
   */
  async messages(): Promise<LogEntry[]> {
    if (!this._messages) {
      this._messages = (async () => {
        const raw = await readJsonlFile(this.path);
        const parsed: LogEntry[] = [];
        for (const r of raw) {
          const e = parseEntry(r);
          if (e) parsed.push(e);
        }
        const deduped = deduplicateByRequestId(parsed);
        this._meta = firstObservedMetadata(deduped);
        this._metaLoaded = true;
        return deduped;
      })();
    }
    return this._messages;
  }

  private ensureMetaLoaded(field: string): void {
    if (!this._metaLoaded) {
      throw new Error(
        `Session.${field} accessed before metadata loaded — await sess.messages() first`
      );
    }
  }

  /** First-observed session UUID across the parsed entries. Returns `""` when absent. */
  get sessionId(): string {
    this.ensureMetaLoaded("sessionId");
    return this._meta.sessionId ?? "";
  }

  /** Claude Code version string from the first entry that carries it, or `null`. */
  get version(): string | null {
    this.ensureMetaLoaded("version");
    return this._meta.version;
  }

  /** Git branch recorded in the session metadata, or `null` if not present. */
  get gitBranch(): string | null {
    this.ensureMetaLoaded("gitBranch");
    return this._meta.gitBranch;
  }

  /** Working directory recorded in the session metadata, or `null` if not present. */
  get cwd(): string | null {
    this.ensureMetaLoaded("cwd");
    return this._meta.cwd;
  }

  /** Permission mode (e.g. `"default"`, `"bypassPermissions"`) or `null` if not recorded. */
  get permissionMode(): string | null {
    this.ensureMetaLoaded("permissionMode");
    return this._meta.permissionMode;
  }

  /**
   * Compute token-usage and timing metrics for the session.
   *
   * Delegates to `calculateMetrics` in the derive module; result is cached.
   */
  async metrics(): Promise<SessionMetrics> {
    if (!this._metrics) {
      this._metrics = (async () => calculateMetrics(await this.messages()))();
    }
    return this._metrics;
  }

  /**
   * Extract the first real user message (human turn) from the session.
   *
   * Returns `null` for sessions that contain no user turns (e.g. bare
   * subagent files). Result is cached.
   */
  async firstUserMessage(): Promise<FirstUserMessage | null> {
    if (!this._firstUser) {
      this._firstUser = (async () => extractFirstUserMessage(await this.messages()))();
    }
    return this._firstUser;
  }

  /**
   * Return `true` if the session appears to still be running (no terminal
   * entry detected). Result is cached.
   */
  async isOngoing(): Promise<boolean> {
    if (!this._isOngoing) {
      this._isOngoing = (async () => checkOngoing(await this.messages()))();
    }
    return this._isOngoing;
  }

  /**
   * Analyse compaction events in the session (context-window truncations).
   *
   * Delegates to `analyzeCompaction`; result is cached.
   */
  async compaction(): Promise<CompactionAnalysis> {
    if (!this._compaction) {
      this._compaction = (async () => analyzeCompaction(await this.messages()))();
    }
    return this._compaction;
  }

  /**
   * Return all tool-call (assistant-side `tool_use`) records in the session.
   *
   * Delegates to `extractToolCalls`; result is cached.
   */
  async toolCalls(): Promise<ToolCall[]> {
    if (!this._toolCalls) {
      this._toolCalls = (async () => extractToolCalls(await this.messages()))();
    }
    return this._toolCalls;
  }

  /**
   * Return all tool-result (user-side `tool_result`) records in the session.
   *
   * Delegates to `extractToolResults`; result is cached.
   */
  async toolResults(): Promise<ToolResult[]> {
    if (!this._toolResults) {
      this._toolResults = (async () => extractToolResults(await this.messages()))();
    }
    return this._toolResults;
  }

  /**
   * Extract skill-invocation metadata (slash-command calls) from the session.
   *
   * Delegates to `extractSkills`; result is cached.
   */
  async skills(): Promise<SkillsInfo> {
    if (!this._skills) {
      this._skills = (async () => extractSkills(await this.messages()))();
    }
    return this._skills;
  }

  /**
   * Return the list of deferred-tool names that were fetched during the session.
   *
   * Delegates to `extractDeferredTools`; result is cached.
   */
  async deferredTools(): Promise<string[]> {
    if (!this._deferredTools) {
      this._deferredTools = (async () => extractDeferredTools(await this.messages()))();
    }
    return this._deferredTools;
  }

  /**
   * Find a single tool call by its `id`. Returns `null` when not found.
   *
   * Performs a linear search over the cached `toolCalls()` array.
   */
  async findToolCall(id: string): Promise<ToolCall | null> {
    const calls = await this.toolCalls();
    return calls.find((c) => c.id === id) ?? null;
  }

  /**
   * Find the tool result whose `toolUseId` matches the given string. Returns
   * `null` when not found.
   *
   * Performs a linear search over the cached `toolResults()` array.
   */
  async findToolResult(toolUseId: string): Promise<ToolResult | null> {
    const results = await this.toolResults();
    return results.find((r) => r.toolUseId === toolUseId) ?? null;
  }

  /**
   * Synchronously attempt to parse a `<persisted-output>` wrapper from a
   * tool-result content value. Returns `null` for non-strings or non-matching
   * strings.
   *
   * Thin wrapper around the module-level `parsePersistedOutput`.
   */
  parsePersistedOutput(content: unknown): PersistedOutputRef | null {
    return parsePersistedOutput(content);
  }

  /**
   * Asynchronously load the full content from a `PersistedOutputRef`. Returns
   * a raw string for `.txt` files, or a parsed `ContentBlock[]` for `.json`
   * files.
   *
   * Thin wrapper around the module-level `loadPersistedOutput`.
   */
  async loadPersistedOutput(ref: PersistedOutputRef): Promise<string | ContentBlock[]> {
    return loadPersistedOutput(ref);
  }

  /**
   * Locate and wrap all subagent session files for this session. Returns an
   * array of `Session` instances (one per subagent file). Result is cached.
   *
   * Delegates path discovery to `findSubagentFiles`, which checks the new
   * layout before falling back to the legacy layout.
   */
  async subagents(): Promise<Session[]> {
    if (!this._subagents) {
      this._subagents = (async () => {
        const paths = await findSubagentFiles(this.path);
        return paths.map((p) => new Session(p));
      })();
    }
    return this._subagents;
  }

  /**
   * List every tracked file version from the session's file-history-snapshot
   * entries, joined with on-disk blob availability under
   * ~/.claude/file-history/<sessionId>/. Versions with no stored blob
   * (backupFileName=null) are still returned with blobPath=null.
   *
   * Takes the LATEST observed entry per (filePath, version) tuple across
   * all snapshots in the session, since snapshots may be updated multiple
   * times during a session.
   */
  async fileHistory(baseDir: string = defaultFileHistoryDir()): Promise<FileHistoryVersion[]> {
    if (!this._fileHistory) {
      this._fileHistory = (async () => {
        const msgs = await this.messages();
        const map = new Map<string, FileHistoryVersion>();
        const dir = await findFileHistoryDir(this.sessionId, baseDir);

        for (const entry of msgs) {
          if (!isFileHistorySnapshotEntry(entry)) continue;
          const backups = entry.snapshot.trackedFileBackups ?? {};
          for (const [filePath, info] of Object.entries(backups)) {
            const key = `${filePath}@${info.version}`;
            const blobPath =
              info.backupFileName && dir ? path.join(dir, info.backupFileName) : null;
            map.set(key, {
              filePath,
              version: info.version,
              backupTime: info.backupTime,
              backupFileName: info.backupFileName,
              blobPath,
              size: null,
            });
          }
        }

        // Populate sizes for blobs that exist on disk
        const result = Array.from(map.values());
        await Promise.all(
          result.map(async (v) => {
            if (!v.blobPath) return;
            try {
              const { stat } = await import("node:fs/promises");
              const s = await stat(v.blobPath);
              v.size = s.size;
            } catch {
              // blob is missing — leave size=null but keep blobPath as a hint
              v.blobPath = null;
            }
          })
        );

        // Sort by filePath asc, then version asc
        result.sort((a, b) => {
          const p = a.filePath.localeCompare(b.filePath);
          if (p !== 0) return p;
          return a.version - b.version;
        });

        return result;
      })();
    }
    return this._fileHistory;
  }

  /** Convenience: read the content of a specific file history version. */
  async readFileHistoryContent(version: FileHistoryVersion): Promise<string | null> {
    return readFileHistoryBlob(version);
  }
}
