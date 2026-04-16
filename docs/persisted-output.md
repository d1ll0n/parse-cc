# Persisted tool-result output

When a tool returns an output larger than Claude Code's inline limit, the session transcript replaces the inline content with a `<persisted-output>` wrapper pointing to a separate file on disk. This library parses the wrapper and loads the external content on demand.

## Quick index

| I want to... | Use |
|---|---|
| Detect a persisted wrapper in a tool result | [`sess.parsePersistedOutput(content)`](#parsepersistedoutput) |
| Read the full external content | [`sess.loadPersistedOutput(ref)`](#loadpersistedoutput) |
| Iterate every tool result and resolve spills | [Full example](#full-example) |
| Use without a `Session` instance | [Module-level helpers](#module-level-helpers) |

## What the wrapper looks like

Real-world content found inside a `tool_result` block:

```
<persisted-output>
Output too large (51.3KB). Full output saved to: /abs/path/<session-id>/tool-results/toolu_XXX.json

Preview (first 2KB):
[
  {
    "type": "text",
    "text": "..."
  }
```

There is NO closing tag in real data — the block runs to the end of the string. The library's regex handles this; don't try to match `</persisted-output>` yourself.

The referenced file lives in the session's sibling `tool-results/` directory:

```
~/.claude/projects/<project>/
  <session-id>.jsonl              # session log
  <session-id>/
    tool-results/
      toolu_XXX.json              # spilled content
      toolu_YYY.txt
```

## parsePersistedOutput()

```ts
import { Session } from "parse-cc";

const sess = new Session("/path/to/session.jsonl");
const results = await sess.toolResults();

for (const r of results) {
  if (typeof r.content !== "string") continue;
  const ref = sess.parsePersistedOutput(r.content);
  if (ref) {
    console.log(`${r.toolUseId}: ${ref.sizeLabel} at ${ref.filePath}`);
  }
}
```

Returns [`PersistedOutputRef | null`](types.md#persistedoutputref).

The method is **synchronous** (no `await` needed). Pass anything — a string, an object, `null`, `undefined`. Only string inputs that match the wrapper pattern return a ref; everything else returns `null`.

A matched ref contains:

- `filePath` — absolute path to the spilled file
- `sizeLabel` — human-readable size as printed in the wrapper, e.g. `"51.3KB"`
- `preview` — the first ~2KB preview text embedded in the wrapper itself

## loadPersistedOutput()

```ts
const ref = sess.parsePersistedOutput(r.content);
if (ref) {
  const full = await sess.loadPersistedOutput(ref);
  // full is ContentBlock[] if ref.filePath ends in .json
  // full is a raw string if ref.filePath ends in .txt
}
```

The return type depends on the file extension:

- **`.json`** — the file contains a JSON-serialized [`ContentBlock[]`](types.md#contentblock) (the same shape that would have been inline had it fit). Parsed and returned as an array.
- **`.txt`** — raw text output. Returned as a string.

If the file is missing or unreadable, the underlying `readFile` throws — wrap in try/catch if you want to tolerate missing spill files.

## Full example

Iterate every tool result and fully resolve any spilled ones:

```ts
import { Session } from "parse-cc";

const sess = new Session(path);
const results = await sess.toolResults();

for (const r of results) {
  if (typeof r.content !== "string") {
    // already-inline ContentBlock array
    continue;
  }

  const ref = sess.parsePersistedOutput(r.content);
  if (!ref) continue; // normal short string result

  const full = await sess.loadPersistedOutput(ref);
  console.log(`${r.toolUseId} (${ref.sizeLabel}):`);

  if (typeof full === "string") {
    console.log(full.slice(0, 200));
  } else {
    for (const block of full) {
      if (block.type === "text") console.log(block.text.slice(0, 200));
    }
  }
}
```

## Module-level helpers

If you don't have a `Session` instance (e.g., you only parsed a tool_result string from somewhere else), the same functions are exported at the top level:

```ts
import { parsePersistedOutput, loadPersistedOutput } from "parse-cc";

const ref = parsePersistedOutput(someString);
if (ref) {
  const full = await loadPersistedOutput(ref);
}
```

The `Session` methods are thin wrappers around these — same implementation, just more convenient when you already have a session loaded.

## See also

- [querying.md](querying.md) — how to get the tool results array in the first place
- [session-basics.md](session-basics.md)
- [types.md#persistedoutputref](types.md#persistedoutputref)
- [types.md#contentblock](types.md#contentblock)
- [types.md#toolresult](types.md#toolresult)
