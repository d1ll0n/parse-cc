# cc-logs

[![CI](https://github.com/d1ll0n/cc-logs/actions/workflows/ci.yml/badge.svg)](https://github.com/d1ll0n/cc-logs/actions/workflows/ci.yml)
[![coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/d1ll0n/cc-logs/badges/coverage-badge.json)](https://github.com/d1ll0n/cc-logs/actions/workflows/ci.yml)

TypeScript library and CLI for parsing Claude Code session log files (`.jsonl`). Exposes a `Session` class with lazy-cached getters for metrics, tool calls, skill listings, subagents, persisted-output references, and more. The CLI condenses a session into a compact JSON representation suitable for downstream analysis by smaller models.

## Purpose

Claude Code sessions generate large `.jsonl` log files (often 5-30MB) containing conversation history, tool use, thinking blocks, file contents, screenshots, and infrastructure metadata. This tool strips the bulk while preserving the conversational structure:

- User messages (prompts and tool results)
- Assistant messages (text, thinking summaries, tool use)
- Tool call metadata (what was called, key inputs, condensed results)

Typical reduction: **~97%** (27MB -> 800KB).

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

### Supported message types

The parser recognizes every entry type observed across hundreds of real session logs:

- `user`, `assistant`, `system`, `summary`
- `file-history-snapshot`, `queue-operation`
- `attachment` with subtypes: `skill_listing`, `deferred_tools_delta`, `hook_success`, `hook_additional_context`, `hook_system_message`, `command_permissions`, `opened_file_in_ide`, `selected_lines_in_ide`, `queued_command`
- `permission-mode`, `progress`, `last-prompt`

Unknown future types are preserved as `UnknownEntry` with their raw fields intact.

## Usage

```bash
# Output to stdout
npx tsx src/index.ts <session.jsonl>

# Output to file
npx tsx src/index.ts <session.jsonl> -o condensed.json

# With custom thresholds
npx tsx src/index.ts <session.jsonl> \
  --thinking-max 500 \
  --tool-input-max 500 \
  --result-max 1000
```

### Options

| Flag | Default | Description |
|---|---|---|
| `-o, --output <file>` | stdout | Write output to file |
| `--thinking-max <n>` | 500 | Max chars for thinking block summaries |
| `--tool-input-max <n>` | 500 | Max chars for large tool input fields (file content, commands, prompts) |
| `--result-max <n>` | 1000 | Max chars for tool result content |

### Built version

```bash
npm run build
node dist/index.js <session.jsonl>
```

## What gets preserved vs dropped

### Preserved
- User text messages (full)
- Assistant text responses (full)
- Thinking blocks (truncated to `--thinking-max`, empty blocks dropped)
- Tool use: tool name + inputs (large values like file content truncated to `--tool-input-max`)
- Tool results: content (truncated to `--result-max`)
- Tool metadata for Write (filePath, type), Read (filePath), Agent (status, agentId, token counts), Glob/Grep/Skill (as-is)

### Dropped
- Edit `toolUseResult` metadata (redundant with tool_use input)
- Bash `toolUseResult` metadata (identical to tool_result content)
- Write file content and originalFile from metadata
- Read file content from metadata (filePath preserved)
- Base64 image data (replaced with `[image: mime/type]`)
- Non-conversational log types: `progress`, `system`, `file-history-snapshot`, `queue-operation`, `permission-mode`, `last-prompt`, `attachment`
- `<system-reminder>` text blocks injected into user messages

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
npm run build         # compile typescript
```

## Project structure

```
src/
  index.ts              Public library entry point (exports Session + types)
  cli.ts                CLI entry point (condenser)
  session.ts            Session class with lazy getters
  truncate.ts           String truncation utility
  persisted-output.ts   <persisted-output> wrapper parser + loader
  subagents.ts          Subagent file locator (new + legacy layouts)
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
  handlers/             Condenser (used by the CLI)
    types.ts            CondensedMessage shapes
    assistant.ts        Condenses assistant entries
    user.ts             Condenses user entries
    tool-results.ts     Per-tool metadata rules
tests/
  fixtures/             JSONL fixtures and persisted-output samples
  parse/, derive/       Unit tests per module
  handlers/             Condenser tests
  integration/          Real-session E2E
```
