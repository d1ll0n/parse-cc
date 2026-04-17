# Tasks

Read the per-session todo list that the harness writes when Claude uses the `TaskCreate` / `TaskUpdate` tools. Tasks live outside the session `.jsonl` — one JSON file per task, under `~/.claude/tasks/<sessionId>/<id>.json`.

This is a sidecar store (the same pattern as file-history). `parse-cc` exposes module-level helpers and a `Session.tasks()` shortcut that joins by session ID.

## Quick index

| I want to... | Use |
|---|---|
| Read all tasks for a known session ID | [`listTasks(sessionId)`](#listtasks) |
| List every session ID that has tasks | [`listTaskSessionIds()`](#listtasksessionids) |
| Read one task by ID | [`readTask(sessionId, taskId)`](#readtask) |
| Check whether a session has a task dir | [`findTasksDir(sessionId)`](#findtasksdir) |
| Join tasks to a parsed `Session` | [`Session.tasks()`](#sesstasks) |
| Know where Claude Code stores tasks | [`defaultTasksDir()`](#defaulttasksdir) |

## On-disk layout

```text
~/.claude/tasks/
  <session-id>/
    1.json            # one file per task, numeric string IDs (monotonic per session)
    2.json
    10.json
    .lock             # harness internal — skipped by parse-cc
    .highwatermark    # harness internal — skipped by parse-cc
```

The directory basename is the session UUID — the same UUID that appears in the `.jsonl` filename under `~/.claude/projects/`. Tasks deleted via `TaskUpdate { status: "deleted" }` are removed from disk, so you will never observe a `"deleted"` status.

## defaultTasksDir()

Returns `~/.claude/tasks`.

```ts
import { defaultTasksDir } from "parse-cc";

console.log(defaultTasksDir()); // "/root/.claude/tasks"
```

Every other tasks function accepts an optional `baseDir` argument; defaults to this path.

## findTasksDir()

Resolve the per-session task directory. Returns `null` when it doesn't exist.

```ts
import { findTasksDir } from "parse-cc";

const dir = await findTasksDir("abc-123-...");
// "/root/.claude/tasks/abc-123-..." or null
```

## listTaskSessionIds()

List every session ID that has a task directory.

```ts
import { listTaskSessionIds } from "parse-cc";

const sessionIds = await listTaskSessionIds();
console.log(`${sessionIds.length} sessions have tasks`);
```

Returns directory basenames sorted alphabetically. Hidden bookkeeping files (`.lock`, `.highwatermark`) are skipped. Returns an empty array when the tasks root does not exist.

## listTasks()

Read all tasks for a session. Returns [`Task[]`](types.md#task) sorted by numeric `id` ascending.

```ts
import { listTasks } from "parse-cc";

const tasks = await listTasks("abc-123-...");
for (const t of tasks) {
  console.log(`[${t.status}] #${t.id} ${t.subject}`);
  if (t.blockedBy.length > 0) console.log(`  blocked by: ${t.blockedBy.join(", ")}`);
}
```

Malformed JSON files and internal bookkeeping files are skipped silently. Returns an empty array when the session has no task directory.

## readTask()

Read a single task by its ID. Returns `null` when absent or malformed.

```ts
import { readTask } from "parse-cc";

const t = await readTask("abc-123-...", "1");
if (t?.status === "in_progress") { /* ... */ }
```

## sess.tasks()

Shortcut on the `Session` class. Automatically primes the session ID by awaiting `messages()` internally.

```ts
import { Session } from "parse-cc";

const sess = new Session("/root/.claude/projects/-root-myproj/abc.jsonl");
const tasks = await sess.tasks();
```

Pass a `baseDir` string to override the lookup directory (e.g. when pointing at a fixture store):

```ts
const tasks = await sess.tasks("/custom/tasks/root");
```

Results are cached across calls.

## From task to tool-call

`Task` records are a snapshot of the latest persisted state, not an event log. If you want the *history* of how a task evolved (when it was created, when status changed, who claimed it), look at the session's `toolCalls()` and filter on tool names `TaskCreate` / `TaskUpdate` — those carry the original per-event arguments. Tasks and tool-calls are complementary: the former tells you the current shape, the latter tells you the path that got it there.

## See also

- [session-basics.md](session-basics.md) — the `Session` class
- [file-history.md](file-history.md) — the closest analog (another sidecar-by-sessionId store)
- [types.md#task](types.md#task) — full field reference
