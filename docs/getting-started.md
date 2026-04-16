# Getting started

Parse and explore a Claude Code session log in under 5 minutes.

## Install

```bash
npm install cc-logs
```

### Building from source

For contributors working on the library itself:

```bash
git clone https://github.com/d1ll0n/cc-logs.git
cd cc-logs
npm install
npm run build
```

## Hello world

Pick any `.jsonl` file from `~/.claude/projects/<project>/` and load it:

```ts
import { Session } from "cc-logs";

const sess = new Session("/root/.claude/projects/-home-username-myproject/abc123.jsonl");

// Parse the file and prime scalar metadata.
await sess.messages();

console.log("session:", sess.sessionId);
console.log("version:", sess.version);
console.log("git branch:", sess.gitBranch);
console.log("cwd:", sess.cwd);

const metrics = await sess.metrics();
console.log(`tokens: ${metrics.totalTokens} over ${metrics.durationMs}ms across ${metrics.messageCount} entries`);

const first = await sess.firstUserMessage();
console.log("first prompt:", first?.text);

console.log("still running?", await sess.isOngoing());
```

### Gotcha: scalar getters throw before `messages()` is awaited

```ts
const sess = new Session(path);
console.log(sess.sessionId); // 💥 throws: "Session metadata not yet loaded"

await sess.messages();       // priming call
console.log(sess.sessionId); // ✓ works
```

Any async method (`metrics()`, `firstUserMessage()`, etc.) primes the metadata too, so you don't strictly need `messages()` first. But it's the clearest idiom.

## Next steps

Once you've loaded a session, pick the guide that matches what you want to do:

| I want to... | Go to |
|---|---|
| Understand the `Session` class in depth | [session-basics.md](session-basics.md) |
| Find every session across all my projects | [discovery.md](discovery.md) |
| List every tool call with its input | [querying.md](querying.md) |
| Know when the session ran out of context | [querying.md](querying.md#compaction) |
| Walk into subagent work | [subagents.md](subagents.md) |
| Read a tool result that was too big to inline | [persisted-output.md](persisted-output.md) |
| See pre-edit versions of files Claude changed | [file-history.md](file-history.md) |
| List skills and deferred tools a session had | [skills-and-deferred-tools.md](skills-and-deferred-tools.md) |
| Look up the exact shape of any type | [types.md](types.md) |

## See also

- [session-basics.md](session-basics.md) — deeper on the `Session` class, caching, and the scalar gotcha
- [types.md](types.md) — full data type reference
- [types.md#sessionmetrics](types.md#sessionmetrics) — the shape of `sess.metrics()` output
- [types.md#firstusermessage](types.md#firstusermessage) — the shape of `sess.firstUserMessage()` output
