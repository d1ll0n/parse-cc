#!/usr/bin/env node
// src/cli.ts
import { writeFileSync } from "node:fs";
import { Session } from "./session.js";
import { handleAssistant, type AssistantOptions } from "./handlers/assistant.js";
import { handleUser, type UserOptions } from "./handlers/user.js";
import { isAssistantEntry, isUserEntry } from "./types/entries.js";
import type { CondensedMessage } from "./handlers/types.js";

interface CliOptions extends AssistantOptions, UserOptions {}

function printHelp(): void {
  console.log(`Usage: cc-logs <input.jsonl> [options]

Options:
  -o, --output <file>        Write output to file (default: stdout)
  --thinking-max <n>         Max chars for thinking blocks (default: 500)
  --tool-input-max <n>       Max chars for tool input values (default: 500)
  --result-max <n>           Max chars for tool result content (default: 1000)
  -h, --help                 Show this help`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  const inputPath = args[0];
  let outputPath: string | undefined;
  const opts: CliOptions = {};

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case "-o":
      case "--output":
        outputPath = args[++i];
        break;
      case "--thinking-max":
        opts.thinkingMaxLen = parseInt(args[++i], 10);
        break;
      case "--tool-input-max":
        opts.toolInputMaxLen = parseInt(args[++i], 10);
        break;
      case "--result-max":
        opts.resultMaxLen = parseInt(args[++i], 10);
        break;
    }
  }

  const sess = new Session(inputPath);
  const entries = await sess.messages();
  const condensed: CondensedMessage[] = [];
  for (const entry of entries) {
    if (isAssistantEntry(entry)) {
      condensed.push(handleAssistant(entry, opts));
    } else if (isUserEntry(entry)) {
      condensed.push(handleUser(entry, opts));
    }
    // All other entry types (attachment, permission-mode, system, etc.) are
    // intentionally dropped by the condenser — it only cares about conversation
    // content. Consumers who want the full picture should use the Session class
    // directly.
  }

  const json = JSON.stringify(condensed, null, 2);
  if (outputPath) {
    writeFileSync(outputPath, json);
    console.error(`Wrote ${condensed.length} condensed messages to ${outputPath}`);
  } else {
    console.log(json);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
