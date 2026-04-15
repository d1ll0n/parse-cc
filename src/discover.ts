import { readdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import path from "node:path";
import type { LogEntry } from "./types/entries.js";
import { parseEntry } from "./parse/entry.js";
import { firstObservedMetadata } from "./derive/first-observed.js";
import { extractFirstUserMessage, type FirstUserMessage } from "./derive/first-message.js";

/**
 * Returns the default Claude Code projects directory: `~/.claude/projects`.
 *
 * Pass the return value as `projectsDir` to override the root used by
 * `listProjects` and `findAllSessions`.
 */
export function defaultProjectsDir(): string {
  return path.join(homedir(), ".claude", "projects");
}

/**
 * Lightweight descriptor for one Claude Code project directory.
 *
 * Produced by `listProjects`; `sessionCount` reflects only the top-level
 * `.jsonl` files and does not include subagent files nested in subdirectories.
 */
export interface ProjectInfo {
  /** Slugified directory name (e.g. "-root-d1ll0n-cc-logs") */
  name: string;
  /** Absolute path to the project directory */
  path: string;
  /** Count of .jsonl files at the top level of the project dir (excludes subagent files) */
  sessionCount: number;
}

/**
 * Cheap metadata for one session, derived from a head-of-file slice rather
 * than a full parse.
 *
 * Produced by `listSessions`. For full introspection, construct a
 * `Session(summary.path)` from the returned `path`.
 */
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

/**
 * Options for `listSessions`.
 */
export interface ListSessionsOptions {
  /** How many lines to read from the head of each file when computing summaries. Default 200. */
  headLines?: number;
}

/**
 * Stream-reads up to maxLines non-empty lines from a file, parses each as a
 * LogEntry, and returns the collected entries. Closes the stream early once the
 * line cap is reached so we never read a whole 27MB file just for metadata.
 */
async function readHeadEntries(filePath: string, maxLines: number): Promise<LogEntry[]> {
  const entries: LogEntry[] = [];
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let linesRead = 0;
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    linesRead++;
    try {
      const parsed = JSON.parse(trimmed);
      const entry = parseEntry(parsed);
      if (entry) entries.push(entry);
    } catch {
      // skip malformed lines
    }
    if (linesRead >= maxLines) {
      rl.close();
      stream.destroy();
      break;
    }
  }

  return entries;
}

/**
 * List all project directories under a projects root. Only reads directory
 * listings — does not open any session files.
 *
 * Returns an empty array (rather than throwing) when `projectsDir` does not
 * exist. Results are sorted alphabetically by directory name.
 */
export async function listProjects(
  projectsDir: string = defaultProjectsDir()
): Promise<ProjectInfo[]> {
  let entries: string[];
  try {
    entries = await readdir(projectsDir);
  } catch {
    return [];
  }

  const projects: ProjectInfo[] = [];

  for (const name of entries) {
    const dirPath = path.join(projectsDir, name);
    let statResult: Awaited<ReturnType<typeof stat>>;
    try {
      statResult = await stat(dirPath);
    } catch {
      continue;
    }
    if (!statResult.isDirectory()) continue;

    // Count top-level .jsonl files (not recursive — excludes subagent subdirs)
    let sessionCount = 0;
    try {
      const children = await readdir(dirPath);
      sessionCount = children.filter((f) => f.endsWith(".jsonl")).length;
    } catch {
      // leave sessionCount = 0
    }

    projects.push({ name, path: dirPath, sessionCount });
  }

  // Alphabetical by name
  projects.sort((a, b) => a.name.localeCompare(b.name));
  return projects;
}

/**
 * List all session files in a project directory, with cheap metadata per session.
 * Only reads the head of each file (default 200 lines) — enough to capture the
 * initial scalar metadata and the first real user message. For full parsing,
 * construct a Session(path) from the returned path.
 *
 * Subagent files (under <stem>/subagents/) are NOT included — use findSubagentFiles
 * if you want them.
 */
export async function listSessions(
  projectDir: string,
  opts: ListSessionsOptions = {}
): Promise<SessionSummary[]> {
  const maxLines = opts.headLines ?? 200;

  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch {
    return [];
  }

  const jsonlFiles = entries.filter((f) => f.endsWith(".jsonl"));
  const summaries: SessionSummary[] = [];

  for (const file of jsonlFiles) {
    const filePath = path.join(projectDir, file);

    // Get file size
    let fileSize = 0;
    try {
      const s = await stat(filePath);
      fileSize = s.size;
    } catch {
      // leave fileSize = 0
    }

    // Default summary for error case
    const summary: SessionSummary = {
      path: filePath,
      sessionId: "",
      version: null,
      gitBranch: null,
      cwd: null,
      firstUserMessage: null,
      firstTimestamp: null,
      lastTimestamp: null,
      fileSize,
    };

    try {
      const headEntries = await readHeadEntries(filePath, maxLines);

      const meta = firstObservedMetadata(headEntries);
      summary.sessionId = meta.sessionId ?? "";
      summary.version = meta.version;
      summary.gitBranch = meta.gitBranch;
      summary.cwd = meta.cwd;

      summary.firstUserMessage = extractFirstUserMessage(headEntries);

      // First and last timestamps from the slice
      for (const e of headEntries) {
        const rec = e as Record<string, unknown>;
        if (typeof rec.timestamp === "string") {
          if (!summary.firstTimestamp) summary.firstTimestamp = rec.timestamp;
          summary.lastTimestamp = rec.timestamp;
        }
      }
    } catch {
      // leave nulls — don't throw
    }

    summaries.push(summary);
  }

  // Sort by firstTimestamp DESC (most recent first); null timestamps sort to end, then by path
  summaries.sort((a, b) => {
    if (a.firstTimestamp && b.firstTimestamp) {
      return b.firstTimestamp.localeCompare(a.firstTimestamp);
    }
    if (a.firstTimestamp) return -1;
    if (b.firstTimestamp) return 1;
    return a.path.localeCompare(b.path);
  });

  return summaries;
}

/**
 * Walk every project directory and return all session summaries across the
 * entire projects root.
 *
 * Combines `listProjects` and `listSessions`; accepts the same options as
 * `listSessions` for controlling the head-slice depth.
 */
export async function findAllSessions(
  projectsDir: string = defaultProjectsDir(),
  opts: ListSessionsOptions = {}
): Promise<SessionSummary[]> {
  const projects = await listProjects(projectsDir);
  const all: SessionSummary[] = [];
  for (const p of projects) {
    const sessions = await listSessions(p.path, opts);
    all.push(...sessions);
  }
  return all;
}
