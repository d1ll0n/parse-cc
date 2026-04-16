# Skills and deferred tools

Claude Code injects two kinds of capability manifests into a session near its start:

- **Skills** — named capability packages (commands, agents, prompts) available via the `Skill` tool. Session logs record a `skill_listing` attachment containing the full list and descriptions.
- **Deferred tools** — tools whose names are available but whose JSONSchema definitions aren't loaded up front (to save context tokens). The agent calls `ToolSearch` to fetch a tool's full schema before using it. Session logs record these as `deferred_tools_delta` attachments.

This library aggregates both across a session's entries so you can see what the agent had access to at runtime.

## Quick index

| I want to... | Use |
|---|---|
| List skills available at session start | [`sess.skills()`](#sessskills) |
| Get just the parsed skill names | [`(await sess.skills()).names`](#sessskills) |
| List deferred tool names for a session | [`sess.deferredTools()`](#sessdeferredtools) |

## sess.skills()

```ts
import { Session } from "parse-cc";

const sess = new Session("/path/to/session.jsonl");
await sess.messages();

const { listing, names } = await sess.skills();

console.log(`${names.length} skills available:`);
for (const name of names) {
  console.log("  " + name);
}

if (listing) {
  console.log("full skill_listing payload:");
  console.log(listing.content);
}
```

Returns [`SkillsInfo`](types.md#skillsinfo):

```ts
interface SkillsInfo {
  listing: SkillListingPayload | null;
  names: string[];
}
```

- `listing` — the raw [`SkillListingPayload`](types.md#skilllistingpayload) from the first `skill_listing` attachment entry in the session (or `null` if none)
- `names` — skill names parsed from `listing.content`

### Plugin-scoped names

Skill names can include plugin scopes (e.g., `plugin-dev:plugin-structure`). The parser splits on `": "` (colon-space) rather than the first `":"`, so scoped names are preserved intact with their leading segment.

### Gotcha: not all sessions have skill listings

The `skill_listing` attachment type was introduced in Claude Code v2.1.94. Older sessions will return `{ listing: null, names: [] }`. This is not a bug — pre-2.1.94, skills existed but weren't persisted to the transcript as typed log entries.

## sess.deferredTools()

```ts
const tools = await sess.deferredTools();
console.log(`${tools.length} deferred tools:`);
for (const name of tools) {
  console.log("  " + name);
}
```

Returns `string[]` — the cumulative set of tool names after applying every `deferred_tools_delta` attachment in order. Later deltas can add or remove names; the result reflects the end-of-session state.

### Gotcha: `deferred_tools_delta` is also version-gated

`deferred_tools_delta` was introduced in Claude Code v2.1.90. Older sessions return an empty array.

## Why this is interesting

For friction analysis, knowing what the agent COULD HAVE used is as important as knowing what it DID use. An agent that doesn't invoke a skill may not have known it existed, or may have had it but chose a different path. Joining `sess.skills().names` with `sess.toolCalls()` gives you both sides:

```ts
const available = (await sess.skills()).names;
const used = new Set((await sess.toolCalls()).map((c) => c.name));
const unusedSkills = available.filter((n) => !used.has(n));
console.log("skills that were never invoked:", unusedSkills);
```

## See also

- [querying.md](querying.md) — for tool calls the agent actually made during the session
- [session-basics.md](session-basics.md)
- [types.md#skillsinfo](types.md#skillsinfo)
- [types.md#skilllistingpayload](types.md#skilllistingpayload)
- [types.md#deferredtoolsdeltapayload](types.md#deferredtoolsdeltapayload)
- [types.md#attachmentpayload](types.md#attachmentpayload)
