# Querying a session

Pull derived values — metrics, tool calls, results, compaction info — from a loaded `Session`.

## Quick index

| I want to... | Use |
|---|---|
| Get token counts + duration | [`sess.metrics()`](#metrics) |
| Find the first real user prompt | [`sess.firstUserMessage()`](#first-user-message) |
| Check if a session is mid-turn | [`sess.isOngoing()`](#ongoing-detection) |
| See when context compaction happened | [`sess.compaction()`](#compaction) |
| List every tool call | [`sess.toolCalls()`](#tool-calls) |
| List every tool result | [`sess.toolResults()`](#tool-results) |
| Look up a call or result by `tool_use_id` | [`sess.findToolCall(id)` / `sess.findToolResult(id)`](#lookups) |

All examples assume you already have a loaded session:

```ts
import { Session } from "cc-logs";

const sess = new Session("/path/to/session.jsonl");
await sess.messages();
```

See [session-basics.md](session-basics.md) if that's not yet familiar.

## Metrics

```ts
const m = await sess.metrics();
console.log(`${m.totalTokens} tokens, ${m.durationMs}ms, ${m.messageCount} entries`);
console.log(`input: ${m.inputTokens}, output: ${m.outputTokens}, cache_read: ${m.cacheReadTokens}`);
```

Returns [`SessionMetrics`](types.md#sessionmetrics). Token counts are summed across all non-sidechain assistant entries; `durationMs` is `max - min` timestamp across all entries (not just assistant ones).

`cacheCreationTokens` counts tokens written to the prompt cache; `cacheReadTokens` counts tokens read back from it. Both are included in `totalTokens`.

## First user message

```ts
const first = await sess.firstUserMessage();
if (first) {
  console.log(first.text, "at", first.timestamp);
}
```

Returns [`FirstUserMessage | null`](types.md#firstusermessage).

Skips noise prefixes (`<local-command-stdout>`, `<local-command-caveat>`, `<system-reminder>`, `[Request interrupted`). If the only user entries are slash commands like `<command-name>/model</command-name>`, falls back to returning the command name (`"/model"`).

Plain text is preferred over command fallbacks when both exist. Returned text is truncated to 500 characters.

## Ongoing detection

```ts
const ongoing = await sess.isOngoing();
```

Returns `true` if the session has any "open" activity with no subsequent ending event. Ending events are:

- A non-empty assistant text block
- `ExitPlanMode` tool call
- `SendMessage` with `shutdown_response.approve === true`
- `[Request interrupted` user text
- User rejection of a tool use (`toolUseResult === "User rejected tool use"`)

If the last activity in the log is a `tool_use` with no matching result, or a `thinking` block with no follow-up, the session is ongoing.

Empty thinking blocks are ignored (they don't count as activity).

## Compaction

```ts
const c = await sess.compaction();
console.log(`${c.compactionCount} compactions, ${c.contextConsumption} total tokens across lifetime`);

for (const phase of c.phases) {
  console.log(`phase ${phase.phaseNumber}: +${phase.contribution} (peak ${phase.peakTokens})`);
}
```

Returns [`CompactionAnalysis`](types.md#compactionanalysis).

Compaction events are detected via `isCompactSummary: true` on user entries. Each phase represents tokens accumulated between compactions. `contextConsumption` is the sum of per-phase contributions — this is what the session actually consumed over its lifetime (as opposed to the "peak" context window at any one point, which resets after each compaction).

### Gotcha: sidechain and synthetic entries are excluded

Assistant entries with `isSidechain: true` (subagent messages) and entries with `model: "<synthetic>"` are ignored when computing per-phase token contributions. Subagent tokens are tracked separately via [`sess.subagents()`](subagents.md#sesssubagents).

## Tool calls

```ts
const calls = await sess.toolCalls();
for (const c of calls) {
  console.log(c.name, c.input);
}
```

Returns [`ToolCall[]`](types.md#toolcall) — a flat list of every `tool_use` block across all assistant entries, each with:

- `id` — the `tool_use_id`
- `name` — the tool name (`Bash`, `Edit`, `Write`, `Agent`, etc.)
- `input` — the input `Record<string, unknown>`
- `entryUuid` — uuid of the containing assistant entry
- `isTask` — `true` if the call is a subagent dispatch (name is `Agent` or `Task`)

### Filter by tool name

```ts
const bashCalls = calls.filter((c) => c.name === "Bash");
const edits = calls.filter((c) => c.name === "Edit" || c.name === "Write");
const subagentDispatches = calls.filter((c) => c.isTask);
```

## Tool results

```ts
const results = await sess.toolResults();
for (const r of results) {
  if (r.isError) console.log("ERROR:", r.toolUseId, r.content);
}
```

Returns [`ToolResult[]`](types.md#toolresult) — a flat list of every `tool_result` block across all user entries, each with:

- `toolUseId` — matches the `id` of its originating [`ToolCall`](types.md#toolcall)
- `content` — `string | ContentBlock[]`
- `isError` — `true` if the tool failed
- `entryUuid` — uuid of the containing user entry

Large results may be stored separately on disk via the `<persisted-output>` wrapper. See [persisted-output.md](persisted-output.md) for how to detect and resolve those.

## Lookups

Cross-reference calls and results by their shared `tool_use_id`:

```ts
const call = await sess.findToolCall("toolu_abc123");
const result = await sess.findToolResult("toolu_abc123");

if (call && result) {
  console.log(`${call.name} → ${result.isError ? "ERROR" : "OK"}`);
}
```

Both return `null` if not found. Each is a linear search over the cached flat array — fine for occasional lookups, but if you're doing many, build your own `Map<string, ToolCall>` from `await sess.toolCalls()`.

## See also

- [session-basics.md](session-basics.md) — Session construction and the scalar-getter gotcha
- [persisted-output.md](persisted-output.md) — reading large tool results from spill files
- [subagents.md](subagents.md) — sidechain work (excluded from metrics and compaction)
- [types.md#sessionmetrics](types.md#sessionmetrics)
- [types.md#toolcall](types.md#toolcall)
- [types.md#toolresult](types.md#toolresult)
- [types.md#compactionanalysis](types.md#compactionanalysis)
- [types.md#firstusermessage](types.md#firstusermessage)
