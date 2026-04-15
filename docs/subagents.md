# Subagents

When a parent session dispatches work via the `Agent` or `Task` tool, the subagent's own conversation is recorded in a separate `.jsonl` file. This library exposes child sessions as nested `Session` instances.

## Quick index

| I want to... | Use |
|---|---|
| Walk all subagents of a parent session | [`sess.subagents()`](#sesssubagents) |
| Just find the file paths | [`findSubagentFiles(parentPath)`](#findsubagentfiles) |
| Understand the on-disk layout | [Directory layouts](#directory-layouts) |
| Recursively walk a tree of subagents | [Recursive traversal](#recursive-traversal) |
| Sum tokens across parent + subagents | [Aggregating across nesting](#aggregating-across-nesting) |

## sess.subagents()

```ts
import { Session } from "cc-logs";

const parent = new Session("/path/to/parent.jsonl");
const subs = await parent.subagents();

for (const sub of subs) {
  console.log(sub.path);
  const m = await sub.metrics();
  console.log(`  ${m.totalTokens} tokens, ${m.messageCount} messages`);
}
```

Returns `Session[]` — each element is a full [`Session`](session-basics.md) instance for a subagent's `.jsonl` file. Construction is lazy: nothing is parsed until you await something on each child session.

The result is cached on the parent session, so repeated calls to `sess.subagents()` return the same array.

## findSubagentFiles()

When you only want file paths (no `Session` construction):

```ts
import { findSubagentFiles } from "cc-logs";

const paths = await findSubagentFiles("/path/to/parent.jsonl");
// string[] — absolute paths to every subagent .jsonl for this parent
```

Useful if you're scanning paths in bulk without parsing. `sess.subagents()` is built on top of this helper.

## Directory layouts

Claude Code has used two storage layouts over time. This library handles both transparently.

### New layout (current)

```
~/.claude/projects/<project-slug>/
  <parent-uuid>.jsonl              # parent session
  <parent-uuid>/
    subagents/
      agent-<agent-uuid>.jsonl     # subagent
      agent-<agent-uuid>.jsonl
```

Subagents live in a dedicated `subagents/` subdirectory named after the parent's session UUID.

### Legacy layout (still supported)

```
~/.claude/projects/<project-slug>/
  <parent-uuid>.jsonl              # parent session
  agent-<agent-uuid>.jsonl         # subagent at project root
```

In the legacy layout, all `agent-*.jsonl` files at the project root are scanned. Each is included as a subagent of the parent only if its first-line `sessionId` matches the parent's — otherwise it belongs to some other parent in the same project directory.

`findSubagentFiles` (and therefore `sess.subagents()`) returns new-layout files first, then legacy-layout matches. An empty result means neither layout has subagents for this parent.

## What subagents see

Each subagent `.jsonl` has the same structure as a parent session — same entry types, same content blocks. Everything in [querying.md](querying.md) works on a subagent `Session`:

```ts
const sub = (await parent.subagents())[0];
const subMetrics = await sub.metrics();
const subToolCalls = await sub.toolCalls();
```

Subagents can themselves dispatch subagents. See [Recursive traversal](#recursive-traversal) below.

### Gotcha: `isSidechain: true` on every entry

Every entry inside a subagent `.jsonl` has `isSidechain: true`. This is how the PARENT session's derived getters know to exclude them:

- [`sess.compaction()`](querying.md#compaction) ignores sidechain entries when computing per-phase token contributions
- Token totals in [`sess.metrics()`](querying.md#metrics) come only from non-sidechain assistant entries

A subagent's own `metrics()` includes those sidechain entries (because from the subagent's perspective, it IS the main conversation). Don't double-count across parent and child.

## Recursive traversal

Subagents can dispatch further subagents. Walk the full tree:

```ts
async function walk(sess: Session, depth = 0): Promise<void> {
  console.log("  ".repeat(depth) + sess.path);
  for (const sub of await sess.subagents()) {
    await walk(sub, depth + 1);
  }
}

const parent = new Session("/path/to/parent.jsonl");
await walk(parent);
```

## Aggregating across nesting

Parent `metrics()` excludes subagent tokens (because their entries have `isSidechain: true`). If you want a combined total, sum recursively:

```ts
async function totalTokens(sess: Session): Promise<number> {
  let total = (await sess.metrics()).totalTokens;
  for (const sub of await sess.subagents()) {
    total += await totalTokens(sub);
  }
  return total;
}

const parent = new Session("/path/to/parent.jsonl");
const grandTotal = await totalTokens(parent);
```

Same pattern applies for message counts, tool calls, or anything else you want to aggregate — write a recursive helper that combines the parent's own value with the subagents' contributions.

## See also

- [session-basics.md](session-basics.md) — subagent sessions are regular `Session` instances
- [querying.md](querying.md) — all the getters work on subagent sessions too
- [discovery.md](discovery.md) — `listSessions` does NOT return subagent files; use this module instead
- [types.md#assistantentry](types.md#assistantentry) — the `isSidechain` field
- [types.md#userentry](types.md#userentry) — also carries `isSidechain`
