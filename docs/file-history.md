# File history

Claude Code backs up pre-edit file contents under `~/.claude/file-history/<session-id>/<contentHash>@v<N>`. Session log entries of type `file-history-snapshot` record which files were backed up and when; the actual content lives in separate blob files on disk. This module joins the two.

## Relationship to the session log

**Important:** the same content that file-history stores is usually ALSO retained in the session log itself — Edit's `toolUseResult.originalFile`, Write's `toolUseResult.content`, or line-numbered Read output. File-history is mostly a **convenience store** for content-addressed direct access to specific versions, not a unique source of data.

Use file-history when:

- You want to jump straight to a specific version without replaying operations
- You want to diff v2 vs v3 of a tracked file without reconstructing from patches
- You want to enumerate what Claude backed up without walking every tool result

Use the session log directly (via [querying.md](querying.md)) when:

- You want the full context of what edit produced each version
- You're comparing against `tool_use` input (old_string/new_string) rather than whole files

## Quick index

| I want to... | Use |
|---|---|
| List every tracked file version in a session | [`sess.fileHistory()`](#sessfilehistory) |
| Read the content of a specific version | [`sess.readFileHistoryContent(v)`](#sessreadfilehistorycontent) |
| Find the file-history dir for a session | [`findFileHistoryDir(id)`](#findfilehistorydir) |
| List blobs without consulting the session log | [`listFileHistoryBlobs(id)`](#listfilehistoryblobs) |
| Read a blob from a `FileHistoryVersion` | [`readFileHistoryBlob(version)`](#readfilehistoryblob) |

## sess.fileHistory()

```ts
import { Session } from "parse-cc";

const sess = new Session("/path/to/session.jsonl");
await sess.messages(); // prime sessionId

const versions = await sess.fileHistory();
for (const v of versions) {
  console.log(v.filePath, "v" + v.version, v.backupTime, v.size ?? "missing");
}
```

Returns [`FileHistoryVersion[]`](types.md#filehistoryversion), sorted by file path then version ascending.

Each version is joined with its on-disk blob if one exists. When `backupFileName` is `null` (typical for version 1 placeholders), `blobPath` is `null` — the version is known to exist as a marker but no blob was stored. The session log's Read/Edit/Write `toolUseResult` fields are usually the source of that content if you need it.

Pass a custom base directory as the first argument if your file-history root isn't in the default location:

```ts
const versions = await sess.fileHistory("/custom/file-history");
```

This is useful for fixtures and for cross-user inspection.

## sess.readFileHistoryContent()

```ts
const versions = await sess.fileHistory();

for (const v of versions) {
  if (!v.blobPath) continue;
  const content = await sess.readFileHistoryContent(v);
  if (content) {
    console.log(`${v.filePath} v${v.version}:`);
    console.log(content);
  }
}
```

Returns the raw blob content as a UTF-8 string, or `null` if `blobPath` is null or the file can't be read.

### Example: diff consecutive versions

```ts
const versions = await sess.fileHistory();
const byPath = new Map<string, typeof versions>();
for (const v of versions) {
  const arr = byPath.get(v.filePath) ?? [];
  arr.push(v);
  byPath.set(v.filePath, arr);
}

for (const [path, vs] of byPath) {
  if (vs.length < 2) continue;
  for (let i = 1; i < vs.length; i++) {
    const prev = await sess.readFileHistoryContent(vs[i - 1]);
    const curr = await sess.readFileHistoryContent(vs[i]);
    if (prev && curr) {
      console.log(`${path}: v${vs[i - 1].version} → v${vs[i].version}`);
      // hand to a diff library of your choice
    }
  }
}
```

## Module-level helpers

When you don't have a `Session` instance, these are exported at the top level.

### findFileHistoryDir()

Resolve the file-history directory for a given session ID. Returns the absolute path if it exists, `null` otherwise.

```ts
import { findFileHistoryDir } from "parse-cc";

const dir = await findFileHistoryDir("sess-abc123");
// "/home/user/.claude/file-history/sess-abc123" or null
```

Pass a custom `baseDir` as the second argument to point at a non-default location.

### listFileHistoryBlobs()

Walk the file-history directory directly — does NOT consult any session log. Useful for detecting orphan blobs whose session file is gone, or for cross-referencing against what a session's snapshot entries actually recorded.

```ts
import { listFileHistoryBlobs } from "parse-cc";

const blobs = await listFileHistoryBlobs("sess-abc123");
// [{ backupFileName, blobPath, size }, ...]
```

Returns an empty array if the session's file-history directory doesn't exist.

### readFileHistoryBlob()

Low-level blob reader that takes a [`FileHistoryVersion`](types.md#filehistoryversion):

```ts
import { readFileHistoryBlob } from "parse-cc";

const content = await readFileHistoryBlob(version);
// string or null
```

`sess.readFileHistoryContent` is a thin wrapper around this.

### defaultFileHistoryDir()

```ts
import { defaultFileHistoryDir } from "parse-cc";

console.log(defaultFileHistoryDir()); // "/home/user/.claude/file-history"
```

Used as the default `baseDir` argument for the other helpers.

## See also

- [querying.md](querying.md) — for the Edit/Write tool result fields in the session log itself, which usually contain the same content
- [session-basics.md](session-basics.md)
- [types.md#filehistoryversion](types.md#filehistoryversion)
- [types.md#trackedfilebackup](types.md#trackedfilebackup)
- [types.md#filehistorysnapshotentry](types.md#filehistorysnapshotentry)
