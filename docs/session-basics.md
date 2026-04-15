# Session basics

The `Session` class is the entry point for everything in this library. Construct one with a file path, then call lazy-cached async methods to parse and introspect the session.

## Quick index

| I want to... | Use |
|---|---|
| Load a session file | [`new Session(path)`](#construction) |
| Get the full typed message array | [`await sess.messages()`](#messages) |
| Get session ID, version, git branch, cwd | [Scalar metadata](#scalar-metadata) |
| Understand how caching works | [Lazy caching](#lazy-caching) |
| See every method at a glance | [Method reference](#method-reference) |

## Construction

```ts
import { Session } from "cc-logs";

const sess = new Session("/path/to/session.jsonl");
```

Construction does nothing — no file reads, no parsing. The file is only opened when you call an async method. This means you can construct many `Session` instances cheaply (e.g. wrapping the results of [`listSessions()`](discovery.md#listsessions)) without paying parse cost until you actually need each one.

## messages()

```ts
const msgs = await sess.messages();
// msgs is LogEntry[] — every entry in the JSONL, in order, with no filtering
```

Returns the full typed array. See [`LogEntry`](types.md#logentry) for the discriminated union of every entry variant.

The library does **not** filter, classify, or drop any entry types. Assistant messages, user messages, system entries, attachments, permission-mode markers, file-history snapshots, queue operations — they're all returned. If you only want one kind, filter with the exported type guards:

```ts
import { isAssistantEntry, isUserEntry, isAttachmentEntry } from "cc-logs";

const assistants = msgs.filter(isAssistantEntry);
const userTurns = msgs.filter(isUserEntry);
const attachments = msgs.filter(isAttachmentEntry);
```

The full list of type guards is in [types.md#logentry](types.md#logentry).

### Behind the scenes

`messages()` does three things on first call:

1. Streams the `.jsonl` file line by line via `node:readline`
2. Runs each non-empty line through `parseEntry` (a passthrough that validates `type: string`)
3. Deduplicates streaming entries by `requestId` (Claude Code writes partial assistant messages during streaming; only the last line per `requestId` has the final counts)

Malformed JSON lines are silently skipped — the same behavior as `claude-devtools` and other tools that read these logs.

## Scalar metadata

After `await sess.messages()` (or any other async method) has run at least once, these properties are primed and synchronous:

```ts
sess.sessionId;      // string — first entry with a sessionId field
sess.version;        // string | null — Claude Code version, e.g. "2.1.101"
sess.gitBranch;      // string | null — git branch recorded at session start
sess.cwd;            // string | null — working directory at session start
sess.permissionMode; // string | null — only populated from permission-mode entries
```

Each value is the **first observed** occurrence while scanning entries in order, except `permissionMode` which is only read from entries with `type: "permission-mode"` (ignoring stray fields on other types).

See [`FirstObservedMetadata`](types.md#firstobservedmetadata) for the full shape.

### Gotcha: scalar getters throw before `messages()` is awaited

```ts
const sess = new Session(path);
console.log(sess.sessionId); // 💥 throws: "Session.sessionId accessed before metadata loaded"

await sess.messages();       // priming call
console.log(sess.sessionId); // ✓ works
```

Any async method primes the metadata as a side effect — `sess.metrics()`, `sess.firstUserMessage()`, `sess.toolCalls()`, etc. all work. You don't strictly need to call `messages()` first, but it's the clearest idiom and the one used throughout these docs.

The getters throw rather than returning `null` to make the mistake loud. A silent `null` would propagate through downstream code and produce misleading results.

## Lazy caching

Every async method computes its result once and caches it:

```ts
const a = await sess.metrics();
const b = await sess.metrics();
// a === b — same object, no recomputation
```

`messages()` itself caches the parsed array, so all derived methods share one parse. This means:

- Calling 10 different derived methods is ~1 parse, not 10
- The order you call methods doesn't matter for correctness or performance
- There's no invalidation — if the file changes on disk, construct a new `Session`

## Method reference

All async methods (each lazy-cached on first call). Links go to the docs where each is covered in depth.

### Parsing and metadata

- [`messages()`](#messages) — full `LogEntry[]`
- Scalar properties: `sessionId`, `version`, `gitBranch`, `cwd`, `permissionMode` — see [Scalar metadata](#scalar-metadata)

### Querying

- `metrics()` → [`SessionMetrics`](types.md#sessionmetrics) — see [querying.md](querying.md#metrics)
- `firstUserMessage()` → [`FirstUserMessage | null`](types.md#firstusermessage) — see [querying.md](querying.md#first-user-message)
- `isOngoing()` → `boolean` — see [querying.md](querying.md#ongoing-detection)
- `compaction()` → [`CompactionAnalysis`](types.md#compactionanalysis) — see [querying.md](querying.md#compaction)
- `toolCalls()` → [`ToolCall[]`](types.md#toolcall) — see [querying.md](querying.md#tool-calls)
- `toolResults()` → [`ToolResult[]`](types.md#toolresult) — see [querying.md](querying.md#tool-results)
- `findToolCall(id)` → [`ToolCall | null`](types.md#toolcall) — see [querying.md](querying.md#lookups)
- `findToolResult(toolUseId)` → [`ToolResult | null`](types.md#toolresult) — see [querying.md](querying.md#lookups)

### Capability manifests

- `skills()` → [`SkillsInfo`](types.md#skillsinfo) — see [skills-and-deferred-tools.md](skills-and-deferred-tools.md)
- `deferredTools()` → `string[]` — see [skills-and-deferred-tools.md](skills-and-deferred-tools.md)

### Nested work

- `subagents()` → `Session[]` — see [subagents.md](subagents.md)

### Persisted output

- `parsePersistedOutput(content)` → [`PersistedOutputRef | null`](types.md#persistedoutputref) — see [persisted-output.md](persisted-output.md)
- `loadPersistedOutput(ref)` → `Promise<string | ContentBlock[]>` — see [persisted-output.md](persisted-output.md)

### File history

- `fileHistory(baseDir?)` → [`FileHistoryVersion[]`](types.md#filehistoryversion) — see [file-history.md](file-history.md)
- `readFileHistoryContent(version)` → `Promise<string | null>` — see [file-history.md](file-history.md)

## See also

- [getting-started.md](getting-started.md) — 5-minute walkthrough
- [discovery.md](discovery.md) — finding session files to feed into `new Session()`
- [querying.md](querying.md) — all the derived getters in detail
- [types.md#logentry](types.md#logentry) — the full entry union
