// src/tasks.ts
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Returns the default Claude Code tasks root: `~/.claude/tasks`.
 *
 * Pass the return value as `baseDir` to override the lookup directory in
 * `findTasksDir`, `listTaskSessionIds`, `listTasks`, `readTask`, and
 * `Session.tasks`.
 */
export function defaultTasksDir(): string {
  return path.join(homedir(), ".claude", "tasks");
}

/**
 * Persisted state for a single task as written by the harness's `TaskCreate` /
 * `TaskUpdate` tools. One file per task, named `<id>.json`, in
 * `<baseDir>/<sessionId>/`.
 *
 * Tasks deleted via `TaskUpdate { status: "deleted" }` are removed from disk
 * and therefore never observed; the on-disk `status` is one of
 * `"pending" | "in_progress" | "completed"`.
 */
export interface Task {
  /** Numeric string assigned at creation time, monotonically increasing per session ("1", "2", ...). */
  id: string;
  /** Brief task title (imperative form). */
  subject: string;
  /** Full task body. */
  description: string;
  /** Lifecycle state. `"deleted"` is never persisted — the file is removed instead. */
  status: "pending" | "in_progress" | "completed";
  /** IDs of tasks that cannot start until this one completes. Always present; may be empty. */
  blocks: string[];
  /** IDs of tasks that must complete before this one can start. Always present; may be empty. */
  blockedBy: string[];
  /** Present-continuous label shown in the harness spinner while this task is `in_progress`. */
  activeForm?: string;
  /** Agent identifier that has claimed this task, if any. */
  owner?: string;
  /** Arbitrary user-defined JSON merged via `TaskUpdate { metadata }`. */
  metadata?: Record<string, unknown>;
}

/**
 * Resolve the per-session task directory for a given session ID. Returns
 * `null` when the directory does not exist.
 *
 * The resolved path is `<baseDir>/<sessionId>`, where `baseDir` defaults to
 * `defaultTasksDir()`. The directory basename matches the session UUID — i.e.
 * the same UUID found in the `.jsonl` filename under `~/.claude/projects/`.
 */
export async function findTasksDir(
  sessionId: string,
  baseDir: string = defaultTasksDir()
): Promise<string | null> {
  const dir = path.join(baseDir, sessionId);
  try {
    const s = await stat(dir);
    return s.isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

/**
 * List every session ID that has a task directory under the tasks root.
 *
 * Returns directory basenames sorted alphabetically. Returns an empty array
 * (rather than throwing) when `baseDir` does not exist. Hidden bookkeeping
 * entries (anything starting with `.`) are skipped.
 */
export async function listTaskSessionIds(
  baseDir: string = defaultTasksDir()
): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(baseDir);
  } catch {
    return [];
  }

  const ids: string[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const full = path.join(baseDir, name);
    try {
      const s = await stat(full);
      if (s.isDirectory()) ids.push(name);
    } catch {
      // skip
    }
  }
  ids.sort();
  return ids;
}

/**
 * Read every task for a session and return them as parsed `Task` objects,
 * sorted by numeric `id` ascending.
 *
 * Returns an empty array when the session has no task directory or the
 * directory contains no `<id>.json` files. Internal bookkeeping files
 * (`.lock`, `.highwatermark`, etc.) and any unreadable / malformed JSON files
 * are skipped silently.
 */
export async function listTasks(
  sessionId: string,
  baseDir: string = defaultTasksDir()
): Promise<Task[]> {
  const dir = await findTasksDir(sessionId, baseDir);
  if (!dir) return [];

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const tasks: Task[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const full = path.join(dir, name);
    let raw: string;
    try {
      raw = await readFile(full, "utf8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const task = coerceTask(parsed);
    if (task) tasks.push(task);
  }

  tasks.sort((a, b) => numericIdCompare(a.id, b.id));
  return tasks;
}

/**
 * Read a single task by its `id`. Returns `null` when the file does not
 * exist, cannot be parsed, or fails minimal shape validation.
 */
export async function readTask(
  sessionId: string,
  taskId: string,
  baseDir: string = defaultTasksDir()
): Promise<Task | null> {
  const dir = await findTasksDir(sessionId, baseDir);
  if (!dir) return null;
  const full = path.join(dir, `${taskId}.json`);
  let raw: string;
  try {
    raw = await readFile(full, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return coerceTask(parsed);
}

/**
 * Validate a parsed JSON value and narrow it to a `Task`. Returns `null` if
 * required fields are missing or wrongly typed. Optional fields (`activeForm`,
 * `owner`, `metadata`) are copied through only when present and well-typed —
 * a wrongly-typed optional field is silently dropped rather than rejecting
 * the whole task, matching the repo's permissive-parsing convention.
 */
function coerceTask(value: unknown): Task | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;

  const id = v.id;
  const subject = v.subject;
  const description = v.description;
  const status = v.status;
  const blocks = v.blocks;
  const blockedBy = v.blockedBy;

  if (typeof id !== "string") return null;
  if (typeof subject !== "string") return null;
  if (typeof description !== "string") return null;
  if (status !== "pending" && status !== "in_progress" && status !== "completed") return null;
  if (!Array.isArray(blocks) || !blocks.every((b) => typeof b === "string")) return null;
  if (!Array.isArray(blockedBy) || !blockedBy.every((b) => typeof b === "string")) return null;

  const task: Task = {
    id,
    subject,
    description,
    status,
    blocks: blocks as string[],
    blockedBy: blockedBy as string[],
  };

  if (typeof v.activeForm === "string") task.activeForm = v.activeForm;
  if (typeof v.owner === "string") task.owner = v.owner;
  if (v.metadata && typeof v.metadata === "object" && !Array.isArray(v.metadata)) {
    task.metadata = v.metadata as Record<string, unknown>;
  }

  return task;
}

/**
 * Compare two task IDs numerically when both look like integers, otherwise
 * fall back to a stable lexicographic compare. The harness assigns numeric
 * IDs ("1", "2", ...), but this guards against any unforeseen format change.
 */
function numericIdCompare(a: string, b: string): number {
  const an = Number(a);
  const bn = Number(b);
  if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
  return a.localeCompare(b);
}
