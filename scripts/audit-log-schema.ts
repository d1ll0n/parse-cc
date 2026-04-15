/**
 * Walk every Claude Code session under ~/.claude/projects, build a schema
 * inventory, exercise every Session introspection method, and compare the
 * result against a committed baseline.
 *
 * Run via tsx (not `node --experimental-strip-types`) because it imports
 * Session, whose constructor uses TypeScript parameter-property shorthand
 * that strip-types doesn't support.
 *
 * Usage:
 *   npm run audit:logs
 *   npm run audit:logs:update            # rewrite the baseline
 *   npx tsx scripts/audit-log-schema.ts --verbose
 *   npx tsx scripts/audit-log-schema.ts --projects-dir <path>
 *
 * Exit codes:
 *   0 — no drift, no errors
 *   1 — drift detected OR Session method errors on ≥ 1 session
 *   2 — baseline missing (run with --update-baseline to create)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findAllSessions, defaultProjectsDir } from "../src/discover.ts";
import { readJsonlFile } from "../src/parse/read.ts";
import { Session } from "../src/session.ts";
import {
  createDefaultContext,
  recordEntry,
  sortInventory,
  type Inventory,
} from "./audit/inventory.ts";
import { compareInventories, driftCount } from "./audit/compare.ts";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = path.resolve(scriptDir, "../tests/fixtures/log-schema-baseline.json");

interface CliOptions {
  updateBaseline: boolean;
  verbose: boolean;
  projectsDir: string;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    updateBaseline: false,
    verbose: false,
    projectsDir: defaultProjectsDir(),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--update-baseline") opts.updateBaseline = true;
    else if (a === "--verbose" || a === "-v") opts.verbose = true;
    else if (a === "--projects-dir") opts.projectsDir = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log(
        "usage: audit-log-schema [--update-baseline] [--verbose] [--projects-dir <path>]"
      );
      process.exit(0);
    }
  }
  return opts;
}

interface SessionError {
  path: string;
  method: string;
  error: string;
}

interface AuditStats {
  sessionsScanned: number;
  subagentsScanned: number;
  entriesWalked: number;
  errors: SessionError[];
}

async function auditSession(
  filePath: string,
  inv: Inventory,
  ctx: ReturnType<typeof createDefaultContext>,
  stats: AuditStats,
  isSubagent: boolean
): Promise<Session | null> {
  if (isSubagent) stats.subagentsScanned++;
  else stats.sessionsScanned++;

  try {
    const raw = await readJsonlFile(filePath);
    for (const r of raw) {
      recordEntry(inv, r, ctx);
      stats.entriesWalked++;
    }
  } catch (e) {
    stats.errors.push({ path: filePath, method: "readJsonlFile", error: String(e) });
    return null;
  }

  const sess = new Session(filePath);
  const methods: Array<[string, () => Promise<unknown>]> = [
    ["messages", () => sess.messages()],
    ["metrics", () => sess.metrics()],
    ["compaction", () => sess.compaction()],
    ["toolCalls", () => sess.toolCalls()],
    ["toolResults", () => sess.toolResults()],
    ["skills", () => sess.skills()],
    ["deferredTools", () => sess.deferredTools()],
    ["firstUserMessage", () => sess.firstUserMessage()],
    ["isOngoing", () => sess.isOngoing()],
    ["fileHistory", () => sess.fileHistory()],
  ];
  for (const [name, call] of methods) {
    try {
      await call();
    } catch (e) {
      stats.errors.push({ path: filePath, method: name, error: String(e) });
    }
  }

  return sess;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  console.log(`[audit] projects dir: ${opts.projectsDir}`);
  const summaries = await findAllSessions(opts.projectsDir);
  console.log(`[audit] discovered ${summaries.length} top-level sessions`);

  const inv: Inventory = {};
  const ctx = createDefaultContext();
  const stats: AuditStats = {
    sessionsScanned: 0,
    subagentsScanned: 0,
    entriesWalked: 0,
    errors: [],
  };

  const progressEvery = Math.max(1, Math.floor(summaries.length / 20));
  for (let i = 0; i < summaries.length; i++) {
    const summary = summaries[i];
    if (i % progressEvery === 0) {
      process.stdout.write(
        `\r[audit] ${i}/${summaries.length} sessions (${stats.entriesWalked} entries, ${stats.errors.length} errors)   `
      );
    }

    const sess = await auditSession(summary.path, inv, ctx, stats, false);
    if (!sess) continue;

    try {
      const subs = await sess.subagents();
      for (const sub of subs) {
        await auditSession(sub.path, inv, ctx, stats, true);
      }
    } catch (e) {
      stats.errors.push({
        path: summary.path,
        method: "subagents",
        error: String(e),
      });
    }
  }
  process.stdout.write(`\r${" ".repeat(80)}\r`);

  const sortedInv = sortInventory(inv);
  console.log(`[audit] sessions:   ${stats.sessionsScanned}`);
  console.log(`[audit] subagents:  ${stats.subagentsScanned}`);
  console.log(`[audit] entries:    ${stats.entriesWalked}`);
  console.log(`[audit] unique paths: ${Object.keys(sortedInv).length}`);
  console.log(`[audit] errors:     ${stats.errors.length}`);

  if (opts.updateBaseline) {
    fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
    const json = `${JSON.stringify(sortedInv, null, 2)}\n`;
    fs.writeFileSync(BASELINE_PATH, json);
    console.log(`[audit] wrote baseline: ${BASELINE_PATH} (${formatBytes(json.length)})`);
    reportErrors(stats.errors, opts.verbose);
    process.exit(stats.errors.length > 0 ? 1 : 0);
  }

  if (!fs.existsSync(BASELINE_PATH)) {
    console.error(
      `[audit] no baseline at ${BASELINE_PATH}\n` +
        `[audit] run with --update-baseline to create one from current logs`
    );
    process.exit(2);
  }

  const baseline: Inventory = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
  const diff = compareInventories(baseline, sortedInv);
  const drift = driftCount(diff);

  if (drift === 0) {
    console.log(`[audit] no schema drift vs baseline`);
  } else {
    console.log("");
    console.log(`[audit] SCHEMA DRIFT DETECTED (${drift} findings):`);
    if (diff.newPaths.length > 0) {
      console.log(`  ${diff.newPaths.length} new path(s) not in baseline:`);
      for (const p of diff.newPaths) {
        console.log(`    + ${p}  (${sortedInv[p].join("|")})`);
      }
    }
    if (diff.newTypes.length > 0) {
      console.log(`  ${diff.newTypes.length} path(s) with new types:`);
      for (const t of diff.newTypes) {
        console.log(
          `    ~ ${t.path}: baseline ${baseline[t.path].join("|")} → observed +${t.added.join(",")}`
        );
      }
    }
    console.log("");
    console.log(`[audit] to accept these changes, rerun with --update-baseline`);
  }

  if (diff.removedPaths.length > 0 && opts.verbose) {
    console.log("");
    console.log(
      `  ${diff.removedPaths.length} baseline path(s) not seen this run (possibly stale):`
    );
    for (const p of diff.removedPaths) console.log(`    - ${p}`);
  }

  reportErrors(stats.errors, opts.verbose);

  process.exit(drift > 0 || stats.errors.length > 0 ? 1 : 0);
}

function reportErrors(errors: SessionError[], verbose: boolean): void {
  if (errors.length === 0) return;
  console.log("");
  console.log(`[audit] ${errors.length} session method error(s):`);
  const byMethod = new Map<string, number>();
  for (const e of errors) {
    byMethod.set(e.method, (byMethod.get(e.method) ?? 0) + 1);
  }
  for (const [method, count] of [...byMethod.entries()].sort()) {
    console.log(`    ${method}: ${count}`);
  }
  if (verbose) {
    console.log("");
    for (const e of errors.slice(0, 50)) {
      console.log(`    ${e.method} @ ${path.basename(e.path)}`);
      console.log(`      ${e.error.split("\n")[0]}`);
    }
    if (errors.length > 50) console.log(`    ... (${errors.length - 50} more)`);
  }
}

main().catch((e) => {
  console.error("[audit] fatal:", e);
  process.exit(1);
});
