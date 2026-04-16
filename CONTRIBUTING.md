# Contributing to parse-cc

This file documents the non-obvious invariants you need to know before touching this codebase. It covers architecture patterns, parsing edge cases, and tooling quirks that have real consequences if ignored. Read it before opening a PR.

## Commands

| Command | What it does |
|---|---|
| `npm test` | Run the full Vitest test suite |
| `npm test -- path/to/file.test.ts` | Run a single test file |
| `npm test -- -t "pattern"` | Run tests whose name matches a pattern |
| `npm run test:watch` | Vitest watch mode |
| `npm run build` | Compile TypeScript → `dist/` via `tsc` |
| `npx tsc --noEmit` | Typecheck only, no output |
| `npm run types:sync` | Regenerate the TypeScript fences in `docs/types.md` from `src/` JSDoc |
| `npm run types:check` | Dry-run of the above; exits 1 if `docs/types.md` is out of sync |
| `npm run audit:logs` | Walk `~/.claude/projects`, compare schema against baseline, surface errors |
| `npm run audit:logs:update` | Accept current schema as the new baseline |

## Architecture tour

`Session` (`src/session.ts`) is the library's central class. It wraps a single `.jsonl` file and exposes typed introspection over its contents. Construction is free — no I/O happens until you `await` an async method. Every async method is lazy-cached: the first call parses the underlying data and stores a `Promise`; subsequent calls return the same `Promise` immediately. This means you can pass a `Session` around and call multiple methods without redundant reads.

The raw-to-typed pipeline lives in `src/parse/`. `read.ts` streams the `.jsonl` file line by line. `entry.ts` parses each raw JSON object into a discriminated `LogEntry` union. `dedupe.ts` collapses streaming duplicates (see the dedupe section below). `Session.messages()` chains these three steps and caches the result.

Derived data lives in `src/derive/`. Each file in that directory exports exactly one interface and one function that produces it from a `LogEntry[]`. `Session`'s async methods (`metrics()`, `compaction()`, `toolCalls()`, `skills()`, etc.) are thin wrappers that call the relevant derive function on the cached messages array. This keeps the `Session` class shallow and the derive logic independently testable.

## The sync-getter pattern

Five scalar metadata values — `sessionId`, `version`, `gitBranch`, `cwd`, `permissionMode` — are exposed as synchronous getters on `Session`. They are populated as a side-effect of parsing inside `messages()`, which means they are only available after at least one async method has been awaited.

**If you read a sync getter before priming, it throws:**

```ts
const sess = new Session(filePath);
console.log(sess.sessionId); // throws: "Session.sessionId accessed before metadata loaded"
```

The idiomatic pattern is to prime once and then read freely:

```ts
const sess = new Session(filePath);
await sess.messages(); // primes all scalar getters as a side effect
console.log(sess.sessionId);
console.log(sess.gitBranch);
```

Any of the other async methods (`metrics()`, `compaction()`, etc.) will also prime the getters as a side effect, because they all call `messages()` internally.

This throw-on-unprimed behavior is deliberate. A silent `null` would silently propagate into metrics calculations and mislead callers. The explicit throw makes the mistake visible immediately. If you add a new scalar getter, follow the same pattern: prime inside `messages()`, throw with an explanatory error message otherwise.

## Streaming dedupe is mandatory

Claude Code writes partial assistant messages as separate JSONL lines during streaming. All the partial lines for one assistant turn share the same `requestId`, and each line carries progressively larger `output_tokens` counts — only the final line has the correct totals.

`src/parse/dedupe.ts` exports `deduplicateByRequestId`, which keeps only the last entry per `requestId`. **Without dedupe, token sums are 2–10× too high on any streamed session.** This is already enforced inside `Session.messages()`, so callers of `Session` are safe. However, if you write code that processes raw log entries directly (e.g. in a script or a new derive function that receives entries from outside `Session`), you must run them through `deduplicateByRequestId` first.

## `<persisted-output>` has no closing tag

When a tool result is too large to inline, Claude Code replaces the full content with a `<persisted-output>` wrapper. The wrapper runs to the end of the string — **there is no `</persisted-output>` closing tag**. Do not write a parser that tries to match one.

The wrapper header looks like this:

```
<persisted-output>
Output too large (2.3 MB). Full output saved to: /absolute/path/to/tool-results/<tool_use_id>.json

Preview (first ...):
<truncated content>
```

The full output is saved under `<session-dir>/tool-results/<tool_use_id>.{json,txt}`. `src/persisted-output.ts` is the reference parser; if you need to touch this logic, mirror its approach (a single anchored regex against the raw string, no attempt to find a closing tag).

## Subagent layouts

Subagent files are discovered from two layouts, checked in order:

**New layout** — subagent files sit in a subdirectory named after the parent session file's stem:
```
~/.claude/projects/<project>/<parent-stem>/subagents/agent-<id>.jsonl
```

**Legacy layout** — subagent files sit at the same level as the parent session file, filtered by matching `sessionId` from each file's first line against the parent's own `sessionId`:
```
~/.claude/projects/<project>/agent-<id>.jsonl
```

`src/subagents.ts` handles both. New layout wins — if the new-layout directory exists, the legacy scan is skipped entirely.

Subagent entries carry `isSidechain: true`. The parent session's `metrics()` and `compaction()` exclude sidechain entries; sidechain token counts are tracked separately and accessible via `(await sess.subagents())[i].metrics()`.

## `docs/types.md` is codegen'd

`scripts/sync-types-md.ts` extracts every `export interface X { ... }` and `export type Y = ...` declaration from `src/`, then finds the matching `### X` heading in `docs/types.md` and replaces the contents of the TypeScript fence beneath it.

The script strips the leading type-level JSDoc block before writing (it would duplicate the prose paragraph above each `### X` heading, which is the canonical narrative). Inline field-level JSDoc is preserved because it is not duplicated anywhere else.

**Do not hand-edit the TypeScript fences inside `docs/types.md`.** Edit the types and their field JSDoc in `src/`, then run `npm run types:sync`. The `npm run types:check` command (used in CI) exits 1 if the fences are out of sync with source.

## Derive module convention

Each file in `src/derive/` exports exactly one interface and one function that derives it from a `LogEntry[]`:

```ts
// src/derive/foo.ts
export interface Foo {
  bar: number;
}

export function deriveFoo(entries: LogEntry[]): Foo {
  // ...
}
```

`Session` async methods are thin wrappers:

```ts
async foo(): Promise<Foo> {
  if (!this._foo) {
    this._foo = (async () => deriveFoo(await this.messages()))();
  }
  return this._foo;
}
```

To add a new derived getter:

1. Create a new file in `src/derive/` exporting `interface Foo { ... }` and `deriveFoo(entries): Foo`.
2. Add a lazy-cached method on `Session` following the pattern above.
3. Add JSDoc to the interface and its fields.
4. Add a `### Foo` section to `docs/types.md` (with a prose paragraph and an empty ts fence) and run `npm run types:sync` to populate the fence.

## Script runtime: tsx vs node --experimental-strip-types

Two ad-hoc TypeScript scripts live under `scripts/`, and they intentionally use different runtimes:

**`scripts/sync-types-md.ts`** runs via `node --experimental-strip-types` (Node ≥ 22.6). This flag strips TypeScript type annotations at parse time without transpilation. The script uses this runtime because it spawns child processes, and `tsx` creates an IPC pipe under a temp directory; in certain sandboxed or restricted environments, that pipe creation fails with EPERM. Plain Node with `--experimental-strip-types` avoids the issue entirely.

**`scripts/audit-log-schema.ts`** runs via `tsx`. It does not spawn child processes, so the EPERM issue does not apply. It also imports `Session` directly from `src/`, whose constructor uses TypeScript parameter-property shorthand — a syntax that `node --experimental-strip-types` does not support (`tsx` handles it fine).

Do not "fix" this asymmetry. Both choices are load-bearing.

## Commit hooks

`npm install` triggers `npm run prepare`, which installs Husky hooks. A pre-push hook runs the linter and the test suite before every push. If the hook fails, fix the underlying issue — bypassing with `--no-verify` is strongly discouraged and will be flagged in review.
