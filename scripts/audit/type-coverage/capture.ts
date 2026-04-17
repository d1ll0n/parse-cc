// Intentionally runs via tsx (matches the rest of the audit scripts).
//
// Capture script for the type-coverage audit corpus. Walks ~/.claude/projects,
// builds a corpus Schema, and merges it into the committed corpus file.
//
// Behavior:
//   default          — append-only merge. Existing corpus shapes survive
//                      regardless of whether this scan saw them. New shapes
//                      from the local scan get added.
//   --bootstrap      — write a fresh corpus from the local scan. Errors out
//                      if a corpus already exists (use it once on first run).
//   --prune          — interactive removal of corpus shapes not seen in the
//                      local scan. Prompts per shape since a missed sample
//                      isn't proof a shape is gone in the wild.
//
// Usage:
//   npm run audit:logs:capture
//   npm run audit:logs:capture -- --bootstrap
//   tsx scripts/audit/type-coverage/capture.ts --projects-dir <path>

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { readdir, stat } from "node:fs/promises";

import { createProject, walkLogEntry } from "./walker.ts";
import { parseAllowlist, type Allowlist } from "./allowlist.ts";
import {
  captureCorpus,
  readCorpusFile,
  writeCorpusFile,
  mergeIntoCorpus,
  deriveSkipPatternsFromTypedSchema,
} from "./corpus.ts";
import type { Schema } from "./schema.ts";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(scriptDir, "../../..");
const ALLOWLIST_PATH = path.join(REPO_ROOT, "tests/fixtures/log-schema-allowlist.yml");
const CORPUS_PATH = path.join(REPO_ROOT, "tests/fixtures/observed-corpus.json");

interface Options {
  bootstrap: boolean;
  prune: boolean;
  projectsDir: string;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    bootstrap: false,
    prune: false,
    projectsDir: path.join(homedir(), ".claude", "projects"),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--bootstrap") opts.bootstrap = true;
    else if (a === "--prune") opts.prune = true;
    else if (a === "--projects-dir") opts.projectsDir = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log(
        "usage: audit-capture [--bootstrap | --prune] [--projects-dir <path>]"
      );
      process.exit(0);
    }
  }
  return opts;
}

function loadAllowlist(): Allowlist {
  // Combine walker-derived skip patterns with the user allowlist (if any).
  const project = createProject(path.join(REPO_ROOT, "tsconfig.json"));
  const walked = walkLogEntry(project);
  const derivedSkipPatterns = deriveSkipPatternsFromTypedSchema(walked.schema);

  let userEntries: Array<{ path: string; reason: string }> = [];
  if (fs.existsSync(ALLOWLIST_PATH)) {
    const userList = parseAllowlist(fs.readFileSync(ALLOWLIST_PATH, "utf8"), ALLOWLIST_PATH);
    userEntries = userList.entries;
  }

  const yaml =
    `entries:\n` +
    [
      ...derivedSkipPatterns.map((p) => ({ path: p.path, reason: `(typed) ${p.reason}` })),
      ...userEntries,
    ]
      .map((e) => `  - path: ${JSON.stringify(e.path)}\n    reason: ${JSON.stringify(e.reason)}\n`)
      .join("");
  return parseAllowlist(yaml || "entries: []");
}

async function walkSamples(projectsDir: string): Promise<unknown[]> {
  const samples: unknown[] = [];
  let projects: string[];
  try {
    projects = await readdir(projectsDir);
  } catch {
    return samples;
  }
  for (const proj of projects) {
    const pdir = path.join(projectsDir, proj);
    let st: Awaited<ReturnType<typeof stat>>;
    try { st = await stat(pdir); } catch { continue; }
    if (!st.isDirectory()) continue;
    let files: string[];
    try { files = await readdir(pdir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const stream = createReadStream(path.join(pdir, f), { encoding: "utf8" });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of rl) {
        const t = line.trim();
        if (!t) continue;
        try {
          const e = JSON.parse(t);
          if (e && typeof e === "object" && !Array.isArray(e)) samples.push(e);
        } catch { /* skip */ }
      }
    }
  }
  return samples;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  const existing = readCorpusFile(CORPUS_PATH);
  if (opts.bootstrap && existing) {
    console.error(
      `[capture] --bootstrap refused: corpus already exists at ${CORPUS_PATH}\n` +
        `[capture] either remove it manually or run without --bootstrap to merge into it`
    );
    process.exit(2);
  }
  if (!opts.bootstrap && !existing && !opts.prune) {
    console.error(
      `[capture] no corpus at ${CORPUS_PATH}\n` +
        `[capture] run with --bootstrap to create one from the current local scan`
    );
    process.exit(2);
  }

  console.log(`[capture] projects dir: ${opts.projectsDir}`);
  console.log(`[capture] mode:         ${opts.bootstrap ? "bootstrap" : opts.prune ? "prune" : "merge (additive)"}`);

  if (opts.prune && existing) {
    // Prune is structurally hard with merged Schemas (no notion of "this
    // shape was last seen here"). Print a warning and treat as a no-op for
    // now; the spec calls this out as requiring per-shape confirmation, so
    // a future iteration can build a real diff UI on top of the corpus.
    console.error(
      `[capture] --prune is not yet implemented; corpus is append-only by design.\n` +
        `[capture] to remove specific shapes, edit ${CORPUS_PATH} directly and re-run audit:logs to verify.`
    );
    process.exit(2);
  }

  const allowlist = loadAllowlist();
  console.log(`[capture] allowlist:    ${allowlist.entries.length} entries`);

  const samples = await walkSamples(opts.projectsDir);
  console.log(`[capture] scanned:      ${samples.length} entries`);

  const localCorpus = captureCorpus(samples, allowlist);

  let finalCorpus: Schema;
  if (opts.bootstrap || !existing) {
    finalCorpus = localCorpus;
    console.log(`[capture] bootstrapping fresh corpus from local scan`);
  } else {
    finalCorpus = mergeIntoCorpus(existing, localCorpus);
    console.log(`[capture] merged local scan into existing corpus (additive)`);
  }

  fs.mkdirSync(path.dirname(CORPUS_PATH), { recursive: true });
  writeCorpusFile(CORPUS_PATH, finalCorpus);

  const finalSize = fs.statSync(CORPUS_PATH).size;
  console.log(`[capture] wrote ${CORPUS_PATH} (${formatBytes(finalSize)})`);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

main().catch((e) => {
  console.error("[capture] fatal:", e);
  process.exit(1);
});
