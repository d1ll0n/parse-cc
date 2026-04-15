# Discovery

Find Claude Code projects and their session files on disk. All functions are exported at the top level — you don't need a `Session` instance to use them.

## Quick index

| I want to... | Use |
|---|---|
| Find all projects in `~/.claude/projects` | [`listProjects()`](#listprojects) |
| List sessions inside one project | [`listSessions(dir)`](#listsessions) |
| Walk every session across every project | [`findAllSessions()`](#findallsessions) |
| Know where Claude Code stores projects | [`defaultProjectsDir()`](#defaultprojectsdir) |

## defaultProjectsDir()

Returns `~/.claude/projects`.

```ts
import { defaultProjectsDir } from "cc-logs";

console.log(defaultProjectsDir()); // "/root/.claude/projects"
```

All other discovery functions use this as their default `projectsDir` argument. Pass a custom path as the first argument if you want to point at a fixture directory or a different user's home.

## listProjects()

Lists every project directory under a projects root. Only reads directory entries — does **not** open any session files.

```ts
import { listProjects } from "cc-logs";

const projects = await listProjects();
for (const p of projects) {
  console.log(`${p.name} — ${p.sessionCount} sessions at ${p.path}`);
}
```

Returns [`ProjectInfo[]`](types.md#projectinfo), sorted alphabetically by `name`.

```ts
interface ProjectInfo {
  name: string;         // slugified dir name, e.g. "-root-d1ll0n-cc-logs"
  path: string;         // absolute path to the project directory
  sessionCount: number; // count of top-level .jsonl files
}
```

Pass a custom projects root as the first argument:

```ts
const projects = await listProjects("/custom/projects/dir");
```

If the directory doesn't exist, the function returns an empty array rather than throwing.

## listSessions()

Given a project directory, returns a summary for each session file inside it. Only reads the head of each file (default 200 lines) to extract cheap metadata.

```ts
import { listProjects, listSessions } from "cc-logs";

const projects = await listProjects();
const sessions = await listSessions(projects[0].path);

for (const s of sessions) {
  console.log(s.sessionId, s.firstTimestamp, s.firstUserMessage?.text);
}
```

Returns [`SessionSummary[]`](types.md#sessionsummary) sorted by `firstTimestamp` descending (most recent first).

Each summary contains:
- `path` — absolute path to the `.jsonl` file
- `sessionId`, `version`, `gitBranch`, `cwd` — first-observed scalar metadata
- `firstUserMessage` — the first real user prompt (with command-name fallback), or `null`
- `firstTimestamp`, `lastTimestamp` — bounds over the head slice
- `fileSize` — total byte size

Configure how much of each file is scanned:

```ts
const fast = await listSessions(dir, { headLines: 50 });
const thorough = await listSessions(dir, { headLines: 1000 });
```

See [`ListSessionsOptions`](types.md#listsessionsoptions).

### Subagent files are excluded

`listSessions` only returns top-level `.jsonl` files in the project directory. Subagent files under `<session-id>/subagents/` are NOT included. If you need those, use [`Session.subagents()`](subagents.md#sesssubagents) or [`findSubagentFiles()`](subagents.md#findsubagentfiles) from [subagents.md](subagents.md).

## findAllSessions()

Walks every project under the projects root and returns a flat summary list across all of them.

```ts
import { findAllSessions } from "cc-logs";

const all = await findAllSessions();
console.log(`found ${all.length} sessions total`);

// Most recent session across everything (sorted desc by firstTimestamp within each project)
const newest = all[0];
```

Takes the same `opts` as `listSessions`:

```ts
const quick = await findAllSessions(undefined, { headLines: 30 });
```

## From summary to full session

A `SessionSummary` contains a `path` field. Hand it to `new Session(path)` to load the full thing:

```ts
import { Session, findAllSessions } from "cc-logs";

const summaries = await findAllSessions();
const target = summaries.find((s) => s.firstUserMessage?.text.includes("database migration"));

if (target) {
  const sess = new Session(target.path);
  await sess.messages();
  const metrics = await sess.metrics();
  console.log(`${metrics.totalTokens} tokens in that session`);
}
```

See [session-basics.md](session-basics.md) for what you can do with the loaded session.

## See also

- [session-basics.md](session-basics.md) — what to do with the path once you've found it
- [querying.md](querying.md) — inspecting a loaded session
- [subagents.md](subagents.md) — finding subagent files (separate API from `listSessions`)
- [types.md#projectinfo](types.md#projectinfo)
- [types.md#sessionsummary](types.md#sessionsummary)
- [types.md#listsessionsoptions](types.md#listsessionsoptions)
