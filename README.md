# cc-logs

[![CI](https://github.com/d1ll0n/cc-logs/actions/workflows/ci.yml/badge.svg)](https://github.com/d1ll0n/cc-logs/actions/workflows/ci.yml)
[![coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/d1ll0n/cc-logs/badges/coverage-badge.json)](https://github.com/d1ll0n/cc-logs/actions/workflows/ci.yml)

TypeScript library for parsing Claude Code session log files (`.jsonl`). Exposes a `Session` class with lazy-cached getters for metrics, tool calls, skill listings, subagents, persisted-output references, file history, and more.

## Library API

Use the `Session` class to parse, query, and navigate session logs. Use the module-level helpers (`listProjects`, `findAllSessions`, etc.) to discover sessions without opening them.

```ts
import { Session, findAllSessions } from "cc-logs";

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
npm install cc-logs
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

### Schema drift detection

Claude Code occasionally adds new entry types or fields to its session log format. The `audit:logs` script walks every session under `~/.claude/projects` (including subagents), builds a structural inventory (path → primitive type union, discriminated by `entry.type` and content block `type`), and compares it against a committed baseline at [`tests/fixtures/log-schema-baseline.json`](tests/fixtures/log-schema-baseline.json). It also exercises every `Session` introspection method to surface any that throw on real data.

```bash
npm run audit:logs            # compare current logs to baseline (exits 1 on drift)
npm run audit:logs:update     # regenerate the baseline after accepting drift
npm run audit:logs -- -v      # verbose: per-error details + removed paths
```

**Run it when:**
- You upgrade Claude Code to a new version — catches newly-emitted fields before they become silent `UnknownEntry` entries.
- Before cutting a release — confirms the parser still resolves every session shape seen locally.
- A user reports a session this library fails on — the audit pinpoints which shape drifted.

The script reads only from your local `~/.claude`, so it's not wired into CI — run it manually. New findings should either be typed properly in [`src/types/entries.ts`](src/types/entries.ts) or accepted into the baseline via `audit:logs:update`.

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
  fixtures/             JSONL fixtures and persisted-output samples
                        (includes log-schema-baseline.json for drift detection)
  parse/, derive/       Unit tests per module
  audit/                Schema inventory walker + diff tests
  integration/          Real-session E2E
scripts/
  sync-types-md.ts      Regenerates docs/types.md ts fences from JSDoc
  audit-log-schema.ts   Walks ~/.claude, diffs schema against baseline
  audit/                Inventory walker + comparator used by the script
```
