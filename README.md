# parse-cc

[![CI](https://github.com/d1ll0n/parse-cc/actions/workflows/ci.yml/badge.svg)](https://github.com/d1ll0n/parse-cc/actions/workflows/ci.yml)
[![coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/d1ll0n/parse-cc/badges/coverage-badge.json)](https://github.com/d1ll0n/parse-cc/actions/workflows/ci.yml)

TypeScript library for parsing Claude Code session log files (`.jsonl`). Exposes a `Session` class with lazy-cached getters for metrics, tool calls, skill listings, subagents, persisted-output references, file history, and more.

## Library API

Use the `Session` class to parse, query, and navigate session logs. Use the module-level helpers (`listProjects`, `findAllSessions`, etc.) to discover sessions without opening them.

```ts
import { Session, findAllSessions } from "parse-cc";

const sess = new Session("/path/to/session.jsonl");
await sess.messages();
console.log(sess.sessionId, (await sess.metrics()).totalTokens);
```

Full docs live under [`docs/`](docs/). Pick a topic by what you want to do:

| I want to... | Go to |
|---|---|
| Install and run a first example | [docs/getting-started.md](docs/getting-started.md) |
| Understand the `Session` class | [docs/session-basics.md](docs/session-basics.md) |
| Find projects and sessions on disk | [docs/discovery.md](docs/discovery.md) |
| Get metrics, tool calls, compaction info | [docs/querying.md](docs/querying.md) |
| Walk subagent work | [docs/subagents.md](docs/subagents.md) |
| Read tool results too big to inline | [docs/persisted-output.md](docs/persisted-output.md) |
| Read pre-edit file backups | [docs/file-history.md](docs/file-history.md) |
| List skills and deferred tools available to a session | [docs/skills-and-deferred-tools.md](docs/skills-and-deferred-tools.md) |
| Look up the exact shape of any exported type | [docs/types.md](docs/types.md) |

`docs/types.md` is generated from JSDoc via `npm run types:sync` — do not hand-edit the TypeScript fences inside it.

### Supported message types

The parser recognizes every entry type observed across hundreds of real session logs:

- `user`, `assistant`, `system`, `summary`
- `file-history-snapshot`, `queue-operation`
- `attachment` with subtypes: `skill_listing`, `deferred_tools_delta`, `hook_success`, `hook_additional_context`, `hook_system_message`, `command_permissions`, `opened_file_in_ide`, `selected_lines_in_ide`, `queued_command`
- `permission-mode`, `progress`, `last-prompt`
- `agent-name`, `custom-title`, `pr-link`, `worktree-state`

Unknown future types are preserved as `UnknownEntry` with their raw fields intact.

## Install

```bash
npm install parse-cc
```

## Log file locations

Claude Code stores session logs at:
```
~/.claude/projects/<project-slug>/<session-id>.jsonl
~/.claude/projects/<project-slug>/<session-id>/subagents/<agent-id>.jsonl
```

## Development

```bash
npm install
npm test              # run tests
npm run test:watch    # watch mode
npm run coverage      # run tests with coverage report
npm run build         # compile typescript
```

### Type-coverage audit

`parseEntry` is a passthrough cast — the TypeScript types in [`src/types/`](src/types/) are the only contract with consumers. The `audit:logs` script verifies that every field observed in real Claude Code session logs is either modelled by the types or explicitly declared intentionally untyped in the allowlist.

```bash
npm run audit:logs              # check observed shapes against typed + allowlist
npm run audit:logs -- -v        # verbose: full gap detail, walker exclusions, stale allowlist entries
npm run audit:logs:capture      # merge current local scan into the committed corpus
npm run audit:logs:capture -- --bootstrap   # create the corpus from scratch (one-time)
```

The audit holds the invariant `observed ⊆ typed ∪ allowlist`. When a new entry type, field, or enum value lands in the harness, it surfaces as a coverage gap that must be either typed in `src/types/` or explicitly allowlisted in [`tests/fixtures/log-schema-allowlist.yml`](tests/fixtures/log-schema-allowlist.yml) with a written justification. A committed corpus at [`tests/fixtures/observed-corpus.json`](tests/fixtures/observed-corpus.json) preserves shape memory across machines and across time.

The corpus stores log **shape**, not log **content** — no file paths, project names, message text, tool inputs/outputs, IDs, timestamps, or header values. Only harness-controlled type/field names and primitive type unions land in it. The capture script prints a privacy reminder at the bottom of its output covering one edge case worth a glance (HTTP response header names from API errors) before committing.

**Run it when:**
- You upgrade Claude Code to a new version — surfaces newly-emitted fields immediately.
- Before cutting a release — confirms the type system covers every shape the library has seen.
- A user reports a session this library fails on — the audit pinpoints which shape isn't modelled.

The script reads only from your local `~/.claude`, so it's not wired into CI — run it manually. Coverage gaps should be either typed properly in [`src/types/entries.ts`](src/types/entries.ts) (Phase 2 codegen will automate most of this) or accepted into the allowlist with a `reason` that's understandable six months later.

## Acknowledgements

Much of the parsing, metrics, dedupe, and session-discovery logic in this library is derived from [matt1398/claude-devtools](https://github.com/matt1398/claude-devtools).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for architecture notes, invariants, and the non-obvious patterns every contributor needs to know before touching this codebase.

## Project structure

```
src/
  index.ts              Public library entry point (exports Session + types)
  session.ts            Session class with lazy getters
  persisted-output.ts   <persisted-output> wrapper parser + loader
  subagents.ts          Subagent file locator (new + legacy layouts)
  discover.ts           Project + session discovery helpers
  file-history.ts       Pre-edit backup blob reader
  types/
    entries.ts          LogEntry discriminated union
    content.ts          ContentBlock types
    attachments.ts      Attachment payload variants
    tool-results.ts     toolUseResult data shapes
  parse/
    read.ts             Streaming JSONL reader
    entry.ts            Raw → LogEntry passthrough
    dedupe.ts           Streaming requestId dedupe
  derive/
    metrics.ts          Token sums + duration
    first-observed.ts   Scalar metadata extractors
    first-message.ts    First user message
    ongoing.ts          Activity-index isOngoing
    compaction.ts       Compaction phase breakdown
    tool-calls.ts       Tool call/result flat extractors
    skills.ts           Skill listing aggregation
    deferred-tools.ts   Deferred tools aggregation
tests/
  fixtures/             JSONL fixtures, log-schema-allowlist.yml, observed-corpus.json
  parse/, derive/       Unit tests per module
  audit/type-coverage/  Walker / comparator / observed / corpus / allowlist tests
  integration/          Real-session E2E
scripts/
  sync-types-md.ts      Regenerates docs/types.md ts fences from JSDoc
  audit/type-coverage/  Type-coverage audit pipeline (cli.ts + capture.ts +
                        walker / comparator / corpus / allowlist / observed)
```
