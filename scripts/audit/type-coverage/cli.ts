// Intentionally runs via tsx (matches scripts/audit-log-schema.ts convention).
//
// CLI for the type-coverage audit. Replaces the schema-drift baseline-diff
// audit. Walks every JSONL entry under ~/.claude/projects, builds the typed
// schema from src/types/, reads the corpus + allowlist, and reports every
// observed shape that isn't either typed or explicitly allowlisted.
//
// Exit codes:
//   0 — no gaps; observed ⊆ typed ∪ allowlist holds.
//   1 — coverage gaps detected.
//   2 — bootstrapping required (no corpus, no allowlist).
//
// Usage:
//   npm run audit:logs                       # default scan + report
//   tsx scripts/audit/type-coverage/cli.ts --verbose
//   tsx scripts/audit/type-coverage/cli.ts --projects-dir <path>

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { readdir, stat } from "node:fs/promises";

import { spawnSync } from "node:child_process";
import type { Project } from "ts-morph";

import { createProject, walkLogEntry } from "./walker.ts";
import {
  parseAllowlist,
  type Allowlist,
  type AllowlistEntry,
  compilePathPattern,
  findStaleEntries,
} from "./allowlist.ts";
import { readCorpusFile, deriveSkipPatternsFromTypedSchema } from "./corpus.ts";
import { audit, auditMerged, type Gap } from "./comparator.ts";
import { synthesizePatches, applyPatches, describePatch } from "./codegen.ts";
import type { Schema } from "./schema.ts";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(scriptDir, "../../..");
const ALLOWLIST_PATH = path.join(REPO_ROOT, "tests/fixtures/log-schema-allowlist.yml");
const CORPUS_PATH = path.join(REPO_ROOT, "tests/fixtures/observed-corpus.json");

interface CliOptions {
  verbose: boolean;
  projectsDir: string;
  /** Print proposed codegen patches without applying. */
  suggest: boolean;
  /** Apply codegen patches to source files (implies --suggest output too). */
  write: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    verbose: false,
    projectsDir: path.join(homedir(), ".claude", "projects"),
    suggest: false,
    write: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--verbose" || a === "-v") opts.verbose = true;
    else if (a === "--projects-dir") opts.projectsDir = argv[++i];
    else if (a === "--suggest") opts.suggest = true;
    else if (a === "--write") {
      opts.write = true;
      opts.suggest = true;
    }
    else if (a === "--help" || a === "-h") {
      console.log(
        "usage: audit-type-coverage [--verbose] [--suggest | --write] [--projects-dir <path>]"
      );
      console.log("");
      console.log("  --suggest       Print codegen patches that would close gaps (dry-run)");
      console.log("  --write         Apply patches to source files; runs `npm run lint` after");
      console.log("                  to normalize formatting. Leaves the working tree dirty");
      console.log("                  for human review.");
      process.exit(0);
    }
  }
  return opts;
}

interface LoadedInputs {
  project: Project;
  typed: Schema;
  walkerExclusions: ReturnType<typeof walkLogEntry>["exclusions"];
  derivedSkipPatterns: Array<{ path: string; reason: string }>;
  allowlist: Allowlist;
  corpus: Schema | null;
}

function loadAll(): LoadedInputs {
  const project = createProject(path.join(REPO_ROOT, "tsconfig.json"));
  const walkResult = walkLogEntry(project);

  const derivedSkipPatterns = deriveSkipPatternsFromTypedSchema(walkResult.schema);

  // Load user allowlist (or empty if missing — bootstrap mode)
  let userAllowlist: Allowlist;
  if (fs.existsSync(ALLOWLIST_PATH)) {
    userAllowlist = parseAllowlist(fs.readFileSync(ALLOWLIST_PATH, "utf8"), ALLOWLIST_PATH);
  } else {
    userAllowlist = parseAllowlist(`entries: []`);
  }

  // Combined allowlist = walker-derived patterns + user-supplied entries.
  // Walker-derived go first so user entries can override (later entries win
  // for length-tied paths via the existing precedence rule).
  const combinedYaml =
    `entries:\n` +
    [
      ...derivedSkipPatterns.map((p) => ({ path: p.path, reason: `(typed) ${p.reason}` })),
      ...userAllowlist.entries,
    ]
      .map((e) => `  - path: ${JSON.stringify(e.path)}\n    reason: ${JSON.stringify(e.reason)}\n`)
      .join("");
  const allowlist = parseAllowlist(combinedYaml || "entries: []");

  const corpus = readCorpusFile(CORPUS_PATH);

  return {
    project,
    typed: walkResult.schema,
    walkerExclusions: walkResult.exclusions,
    derivedSkipPatterns,
    allowlist,
    corpus,
  };
}

async function walkSessions(projectsDir: string): Promise<{
  samples: unknown[];
  sessionsScanned: number;
  bytes: number;
}> {
  const samples: unknown[] = [];
  let sessionsScanned = 0;
  let bytes = 0;

  let projects: string[];
  try {
    projects = await readdir(projectsDir);
  } catch {
    return { samples, sessionsScanned, bytes };
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
      const fp = path.join(pdir, f);
      try { bytes += (await stat(fp)).size; } catch {}
      sessionsScanned++;

      const stream = createReadStream(fp, { encoding: "utf8" });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const entry = JSON.parse(trimmed);
          if (entry && typeof entry === "object" && !Array.isArray(entry)) {
            samples.push(entry);
          }
        } catch {
          // skip malformed lines
        }
      }
    }
  }

  return { samples, sessionsScanned, bytes };
}

interface SourceTaggedGap extends Gap {
  /** Where this gap was first detected: `local` or `corpus` or `both`. */
  source: "local" | "corpus" | "both";
}

function dedupAndTag(localGaps: Gap[], corpusGaps: Gap[]): SourceTaggedGap[] {
  const byKey = new Map<string, SourceTaggedGap>();
  for (const g of localGaps) {
    const key = `${g.path}::${g.kind}`;
    byKey.set(key, { ...g, source: "local" });
  }
  for (const g of corpusGaps) {
    const key = `${g.path}::${g.kind}`;
    const existing = byKey.get(key);
    byKey.set(key, existing ? { ...existing, source: "both" } : { ...g, source: "corpus" });
  }
  return [...byKey.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function groupGaps(gaps: SourceTaggedGap[]): Map<string, SourceTaggedGap[]> {
  // Group by leading $[entry-type] prefix — top-level finding-per-variant.
  const groups = new Map<string, SourceTaggedGap[]>();
  for (const g of gaps) {
    const m = g.path.match(/^\$(?:\[([^\]]+)\])?/);
    const groupKey = m?.[1] ? `entry[${m[1]}]` : "<root>";
    let bucket = groups.get(groupKey);
    if (!bucket) {
      bucket = [];
      groups.set(groupKey, bucket);
    }
    bucket.push(g);
  }
  return groups;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const t0 = Date.now();

  console.log(`[audit] type-coverage audit`);
  console.log(`[audit] projects dir: ${opts.projectsDir}`);

  const { project, typed, walkerExclusions, derivedSkipPatterns, allowlist, corpus } = loadAll();
  console.log(`[audit] typed walker: ${countDiscUnionVariants(typed)} variants, ${derivedSkipPatterns.length} auto-derived skip patterns`);
  console.log(`[audit] allowlist:    ${allowlist.entries.length} entries (${allowlist.entries.length - derivedSkipPatterns.length} user-supplied)`);
  console.log(`[audit] corpus:       ${corpus ? `${countDiscUnionVariants(corpus)} variants from ${CORPUS_PATH}` : "<not present, run audit:logs:capture --bootstrap>"}`);

  const { samples, sessionsScanned, bytes } = await walkSessions(opts.projectsDir);
  console.log(`[audit] scanned:      ${sessionsScanned} sessions, ${samples.length} entries, ${formatBytes(bytes)}`);

  const localGaps = audit(typed, samples);
  const corpusGaps = corpus ? auditMerged(typed, corpus) : [];

  const tagged = dedupAndTag(localGaps, corpusGaps);
  const groups = groupGaps(tagged);

  const newCount = tagged.filter((g) => g.source === "local").length;
  const longstandingCount = tagged.filter((g) => g.source !== "local").length;

  console.log(`[audit] elapsed:      ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log("");

  if (tagged.length === 0) {
    console.log(`[audit] no coverage gaps. observed ⊆ typed ∪ allowlist holds.`);
  } else {
    console.log(
      `[audit] ${tagged.length} coverage gap(s) — ${newCount} new (local-only), ${longstandingCount} longstanding (in corpus)`
    );
    console.log("");
    for (const [groupKey, groupGapsList] of [...groups.entries()].sort()) {
      console.log(`  ${groupKey}:`);
      const limit = opts.verbose ? Infinity : 8;
      for (const g of groupGapsList.slice(0, limit)) {
        const tag =
          g.source === "local" ? "[NEW]      " :
          g.source === "corpus" ? "[corpus]   " :
          "[both]     ";
        console.log(`    ${tag}${g.kind} @ ${g.path}`);
        if (opts.verbose) console.log(`               ${g.detail}`);
      }
      if (groupGapsList.length > limit) {
        console.log(`    ... ${groupGapsList.length - limit} more (rerun with -v)`);
      }
      console.log("");
    }
  }

  if (opts.verbose) {
    if (walkerExclusions.length > 0) {
      console.log(`[audit] excluded from typed set (non-literal discriminator):`);
      for (const e of walkerExclusions) {
        console.log(`  ${e.variantName}  (${e.sourceFile})  — ${e.reason}`);
      }
      console.log("");
    }

    // Stale allowlist entries: only check user-supplied ones (not auto-derived,
    // those don't have observed paths to match against in this run).
    const userOnly: AllowlistEntry[] = allowlist.entries.filter(
      (e) => !e.reason.startsWith("(typed)")
    );
    const observedPaths = new Set<string>();
    for (const g of tagged) observedPaths.add(g.path);
    const userAllowlist: Allowlist = {
      entries: userOnly,
      match: (p) => {
        for (const e of userOnly) if (compilePathPattern(e.path).test(p)) return e.reason;
        return null;
      },
    };
    const stale = findStaleEntries(userAllowlist, observedPaths);
    if (stale.length > 0) {
      console.log(`[audit] stale user-allowlist entries (matched zero observed paths this run):`);
      for (const e of stale) console.log(`  ${e.path}  — ${e.reason}`);
      console.log("");
    }
  }

  // Codegen path: --suggest prints proposed patches; --write applies them.
  if ((opts.suggest || opts.write) && tagged.length > 0) {
    runCodegen(opts, tagged, corpus, project);
  } else if (tagged.length > 0) {
    console.log(`[audit] rerun with --verbose for full gap detail and excluded-variant listing`);
    console.log(`[audit] rerun with --suggest to see codegen patches that would close these gaps`);
  }

  process.exit(tagged.length > 0 ? 1 : 0);
}

function runCodegen(
  opts: CliOptions,
  gaps: SourceTaggedGap[],
  corpus: Schema | null,
  project: Project
): void {
  const result = synthesizePatches(gaps, corpus, project);

  console.log("");
  console.log(
    `[codegen] ${result.patches.length} auto-fixable, ${result.unsupported.length} need manual review`
  );

  if (result.patches.length > 0) {
    console.log("");
    console.log("[codegen] proposed patches:");
    // Group by target file for diff readability.
    const byFile = new Map<string, typeof result.patches>();
    for (const p of result.patches) {
      const k = p.targetFile;
      let bucket = byFile.get(k);
      if (!bucket) {
        bucket = [];
        byFile.set(k, bucket);
      }
      bucket.push(p);
    }
    for (const [file, patches] of [...byFile.entries()].sort()) {
      const rel = file.startsWith(REPO_ROOT) ? file.slice(REPO_ROOT.length + 1) : file;
      console.log("");
      console.log(`  ${rel}:`);
      for (const p of patches) {
        console.log(`    ${describePatch(p)}`);
      }
    }
  }

  if (result.unsupported.length > 0) {
    console.log("");
    console.log("[codegen] not auto-fixable (need manual handling):");
    // Bucket by reason so review-required types group together.
    const byReason = new Map<string, number>();
    for (const u of result.unsupported) {
      byReason.set(u.reason, (byReason.get(u.reason) ?? 0) + 1);
    }
    for (const [reason, n] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${n.toString().padStart(4)}  ${reason}`);
    }
  }

  if (opts.write && result.patches.length > 0) {
    console.log("");
    console.log(`[codegen] --write: applying ${result.patches.length} patch(es)...`);
    applyPatches(result.patches, project);
    const touched = new Set(result.patches.map((p) => p.targetFile));
    console.log(`[codegen] modified ${touched.size} file(s).`);
    console.log(`[codegen] running 'npm run lint' to normalize formatting...`);
    const lintResult = spawnSync("npm", ["run", "lint:fix"], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
    if (lintResult.status !== 0) {
      console.log(`[codegen] lint:fix exited ${lintResult.status} (warnings remain — see above)`);
    }
    console.log("");
    console.log(`[codegen] done. review the diff before committing.`);
  } else if (opts.suggest) {
    console.log("");
    console.log(`[codegen] dry-run only. rerun with --write to apply.`);
  }
}

function countDiscUnionVariants(s: Schema): number {
  return s.kind === "discUnion" ? Object.keys(s.variants).length : 0;
}

main().catch((e) => {
  console.error("[audit] fatal:", e);
  process.exit(1);
});
