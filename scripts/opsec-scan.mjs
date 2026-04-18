#!/usr/bin/env node
// scripts/opsec-scan.mjs
//
// Pre-commit / pre-push secret and PII scanner.
//
// Checks three sources of sensitive values:
//   1. .env values — every non-trivial value is searched for in commits
//   2. .opsec.local — machine-specific paths, usernames, emails
//   3. Built-in regex patterns — JWTs, ETH private keys, connection
//      strings, basic-auth URLs, AWS keys, etc.
//   4. Claude project names + session IDs (discovered from ~/.claude)
//
// .opsec.local is gitignored — each developer creates their own with
// their usernames, email, machine paths. See .opsec.local.example.
//
// Usage:
//   node scripts/opsec-scan.mjs             # full: all history + staged
//   node scripts/opsec-scan.mjs --unpushed  # commits not yet on remote
//   node scripts/opsec-scan.mjs --head      # HEAD tree only + staged
//   node scripts/opsec-scan.mjs --staged    # staged only (fastest)
//
// Exit: 0 = clean, 1 = hard-fail found, 2 = internal error.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

function gitBuf(args, opts = {}) {
  return execFileSync("git", args, { maxBuffer: 64 * 1024 * 1024, ...opts });
}

// ---------------------------------------------------------------------------
// Value sources
// ---------------------------------------------------------------------------

// Minimum value length to bother scanning for.
const MIN_LENGTH = 8;

// Generic config values that aren't secrets.
const ALLOWLIST = new Set(["true", "false", "Wildcat Sepolia Fork"]);

/** Read .env file, return array of {value, key, severity} */
function readEnvValues(envPath = ".env") {
  try {
    const lines = readFileSync(envPath, "utf8").split("\n");
    const entries = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (value.length < MIN_LENGTH) continue;
      if (ALLOWLIST.has(value)) continue;
      entries.push({ value, key, severity: "fail" });
    }
    return entries;
  } catch {
    return [];
  }
}

/** Read .opsec.local file, return array of {value, severity} */
function readOpsecLocal(path = ".opsec.local") {
  try {
    const lines = readFileSync(path, "utf8").split("\n");
    const entries = [];
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      let severity = "fail";
      let value = line;
      if (line.startsWith("warn:")) {
        severity = "warn";
        value = line.slice(5);
      } else if (line.startsWith("fail:")) {
        value = line.slice(5);
      }
      if (value.length < 2) continue;
      entries.push({ value, severity });
    }
    return entries;
  } catch {
    return [];
  }
}

/** Discover claude project names from ~/.claude/projects */
function discoverProjectNames() {
  const dir = join(homedir(), ".claude", "projects");
  try {
    return readdirSync(dir).filter((n) => !n.startsWith("."));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Build checks
// ---------------------------------------------------------------------------

const ESC = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function buildChecks() {
  const checks = [];

  // --- .env values ---
  const envValues = readEnvValues();
  for (const { value, key, severity } of envValues) {
    // Split comma-separated values and process each independently.
    const parts = value.includes(",")
      ? value.split(",").map((v) => v.trim())
      : [value];

    for (const part of parts) {
      if (part.length < MIN_LENGTH) continue;
      if (ALLOWLIST.has(part)) continue;

      // Try parsing as URL.
      let isUrl = false;
      try {
        const url = new URL(part);
        isUrl = url.protocol === "http:" || url.protocol === "https:";
        if (isUrl && url.password) {
          // URL with auth: scan for the password (the real secret).
          // Infrastructure hostnames go in .opsec.local instead.
          const pass = decodeURIComponent(url.password);
          if (pass.length >= MIN_LENGTH) {
            checks.push({
              name: `.env ${key} (password)`,
              severity,
              re: new RegExp(ESC(pass), "g"),
            });
          }
        }
        // URL without auth: skip — public endpoints aren't secrets.
        // Add hostnames to .opsec.local if you want to catch them.
      } catch {
        /* not a URL */
      }

      // Non-URL values: exact match (API keys, secrets, tokens, etc.)
      if (!isUrl) {
        checks.push({
          name: `.env ${key}`,
          severity,
          re: new RegExp(ESC(part), "g"),
        });
      }
    }
  }

  // --- .opsec.local values ---
  const opsecValues = readOpsecLocal();
  for (const { value, severity } of opsecValues) {
    checks.push({
      name: `opsec-local: ${value.slice(0, 20)}`,
      severity,
      re: new RegExp(ESC(value), "gi"),
    });
  }

  // --- Built-in regex patterns ---
  checks.push(
    // Superpowers plugin references — intermediate plan docs shouldn't
    // be committed to public repos.
    {
      name: "superpowers reference",
      severity: "fail",
      re: /superpowers/gi,
    },
    // Email addresses (not from .opsec.local — catches any email)
    {
      name: "email address",
      severity: "warn",
      re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    },
    // JWT tokens (eyJ...)
    {
      name: "JWT token",
      severity: "fail",
      re: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g,
    },
    // Ethereum private keys (0x + 64 hex chars, with keyword context)
    {
      name: "ETH private key",
      severity: "fail",
      re: /(?:private.?key|PRIVATE.?KEY|pvt.?key|PVT.?KEY|secret.?key|SECRET.?KEY|wallet.?key|WALLET.?KEY)\s*[:=]\s*["']?0x[0-9a-fA-F]{64}/g,
    },
    // Bare 0x + 64 hex that looks like a key (not an address which is 40 chars)
    {
      name: "possible ETH private key (bare hex)",
      severity: "warn",
      re: /\b0x[0-9a-fA-F]{64}\b/g,
    },
    // PostgreSQL / MySQL connection strings with passwords
    {
      name: "database connection string",
      severity: "fail",
      re: /(?:postgres(?:ql)?|mysql|mariadb):\/\/[^:]+:[^@]+@[^/]+/g,
    },
    // Basic auth in URLs (user:pass@host). Excludes the literal
    // "user:pass@host" example used in code comments.
    {
      name: "basic auth in URL",
      severity: "fail",
      re: /https?:\/\/(?!user:pass@)[^/:@\s]+:[^/:@\s]+@[^/\s]+/g,
    },
    // AWS access key IDs
    {
      name: "AWS access key",
      severity: "fail",
      re: /\bAKIA[0-9A-Z]{16}\b/g,
    },
    // Generic "secret" / "password" assignments
    {
      name: "hardcoded secret assignment",
      severity: "warn",
      re: /(?:password|secret|token|api_key|apikey|api-key)\s*[:=]\s*["'][^"']{8,}["']/gi,
    },
  );

  // --- Claude project names (session IDs skipped — only relevant for
  // repos that directly operate on claude session data) ---
  //
  // Severity is `warn` for parse-cc specifically: this is a public OSS
  // repo whose project-directory slug already encodes the public repo
  // name (`-<homedir>-<owner>-<repo>`), so leaking the slug discloses
  // little beyond what's already visible. The airdrop-app version of
  // this scanner uses `fail` because that's a private commercial
  // codebase where leaking project paths could enumerate internal
  // projects. Per-repo policy choice; revisit if the threat model
  // changes (e.g., this repo starts containing internal-only paths).
  const projects = discoverProjectNames();
  const longProjects = projects.filter((p) => p.length >= 10);
  if (longProjects.length) {
    checks.push({
      name: "claude project name",
      severity: "warn",
      re: new RegExp(
        longProjects
          .sort((a, b) => b.length - a.length)
          .map((p) => `(?<![a-zA-Z0-9-])${ESC(p)}(?![a-zA-Z0-9-])`)
          .join("|"),
        "g",
      ),
    });
  }

  return { checks, envCount: envValues.length, opsecCount: opsecValues.length, projects };
}

// ---------------------------------------------------------------------------
// Scanning (same structure as alembic/parse-claude-logs)
// ---------------------------------------------------------------------------

const SELF_PATH = "scripts/opsec-scan.mjs";
const SKIP_PATHS = new Set([
  "package-lock.json",
  ".opsec.local.example", // template with example values
  ".env.example", // placeholder values, not real secrets
  ".gitignore", // references gitignored dir names, not leaks
  // parse-cc fixtures: JSONL test data containing illustrative log
  // shapes — synthetic session IDs ("sess-1") and example file paths.
  // Scanning would false-positive every CI run.
  "tests/fixtures/modern-session.jsonl",
  "tests/fixtures/no-session-id.jsonl",
]);

function scanText(text, checks, location) {
  const issues = [];
  for (const check of checks) {
    check.re.lastIndex = 0; // reset stateful regex
    for (const match of text.matchAll(check.re)) {
      const prefix = text.slice(0, match.index);
      const lineNum = prefix.split("\n").length;
      const lineStart = prefix.lastIndexOf("\n") + 1;
      const lineEnd = text.indexOf("\n", match.index);
      const line = text
        .slice(lineStart, lineEnd === -1 ? text.length : lineEnd)
        .trim();
      issues.push({
        check: check.name,
        severity: check.severity,
        location,
        line: lineNum,
        match: match[0].length > 40 ? match[0].slice(0, 37) + "..." : match[0],
        context: line.slice(0, 140),
      });
    }
  }
  return issues;
}

function isBinary(buf) {
  const len = Math.min(buf.length, 8192);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// History scan
// ---------------------------------------------------------------------------

function scanHistory(checks) {
  const issues = [];
  let blobCount = 0;
  let msgCount = 0;

  const objectList = git(["rev-list", "--objects", "--all"]);
  const blobsBySha = new Map();
  for (const line of objectList.split("\n")) {
    const idx = line.indexOf(" ");
    if (idx === -1) continue;
    const sha = line.slice(0, idx);
    const path = line.slice(idx + 1);
    if (!blobsBySha.has(sha)) blobsBySha.set(sha, new Set());
    blobsBySha.get(sha).add(path);
  }

  for (const [sha, paths] of blobsBySha) {
    for (const p of paths) {
      if (p === SELF_PATH || SKIP_PATHS.has(p)) continue;
      issues.push(...scanText(p, checks, `${p} (path)`));
    }

    const shouldSkip = [...paths].every(
      (p) => p === SELF_PATH || SKIP_PATHS.has(p),
    );
    if (shouldSkip) continue;

    let buf;
    try {
      buf = gitBuf(["cat-file", "blob", sha], {
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      continue;
    }
    if (buf.length > 2 * 1024 * 1024 || isBinary(buf)) continue;
    blobCount++;
    const content = buf.toString("utf8");
    const label = [...paths][0];
    issues.push(...scanText(content, checks, label));
  }

  const logSep = "<<<OPSEC_SEP>>>";
  const log = git(["log", "--all", `--format=%H%x00%B${logSep}`]);
  for (const chunk of log.split(logSep)) {
    if (!chunk.trim()) continue;
    const nullIdx = chunk.indexOf("\x00");
    if (nullIdx === -1) continue;
    const hash = chunk.slice(0, nullIdx).trim();
    const body = chunk.slice(nullIdx + 1);
    if (!body.trim()) continue;
    msgCount++;
    issues.push(...scanText(body, checks, `commit ${hash.slice(0, 8)}`));
  }

  return { issues, blobCount, msgCount };
}

// ---------------------------------------------------------------------------
// Staged scan
// ---------------------------------------------------------------------------

function scanStaged(checks) {
  const issues = [];
  let count = 0;

  let names;
  try {
    // --diff-filter=d excludes deleted files — avoids "does not exist"
    // errors when scanning staged deletions (e.g. storybook-static/).
    names = git(["diff", "--cached", "--diff-filter=d", "--name-only", "-z"])
      .split("\0")
      .filter(Boolean);
  } catch {
    return { issues, count };
  }

  for (const p of names) {
    if (p === SELF_PATH || SKIP_PATHS.has(p)) continue;
    count++;
    issues.push(...scanText(p, checks, `staged ${p} (path)`));
    let buf;
    try {
      buf = gitBuf(["show", `:${p}`]);
    } catch {
      continue;
    }
    if (buf.length > 2 * 1024 * 1024 || isBinary(buf)) continue;
    issues.push(...scanText(buf.toString("utf8"), checks, `staged ${p}`));
  }
  return { issues, count };
}

// ---------------------------------------------------------------------------
// HEAD-only scan
// ---------------------------------------------------------------------------

function scanHead(checks) {
  const issues = [];
  let blobCount = 0;

  const tree = git(["ls-tree", "-r", "HEAD"]);
  for (const line of tree.split("\n")) {
    const m = line.match(/^\S+ blob (\S+)\s+(.+)$/);
    if (!m) continue;
    const [, sha, p] = m;
    if (p === SELF_PATH || SKIP_PATHS.has(p)) continue;

    issues.push(...scanText(p, checks, `${p} (path)`));

    let buf;
    try {
      buf = gitBuf(["cat-file", "blob", sha], {
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      continue;
    }
    if (buf.length > 2 * 1024 * 1024 || isBinary(buf)) continue;
    blobCount++;
    issues.push(...scanText(buf.toString("utf8"), checks, p));
  }

  const headMsg = git(["log", "-1", "--format=%B"]).trim();
  let msgCount = 0;
  if (headMsg) {
    msgCount = 1;
    issues.push(...scanText(headMsg, checks, "HEAD commit message"));
  }

  return { issues, blobCount, msgCount };
}

// ---------------------------------------------------------------------------
// Unpushed scan
// ---------------------------------------------------------------------------

function getUnpushedRange() {
  try {
    const upstream = execFileSync(
      "git",
      ["rev-parse", "--abbrev-ref", "@{upstream}"],
      { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] },
    ).trim();
    if (upstream) return `${upstream}..HEAD`;
  } catch {
    /* no upstream */
  }
  return null;
}

function scanUnpushed(checks) {
  const range = getUnpushedRange();
  const issues = [];
  let blobCount = 0;
  let msgCount = 0;

  let commitList;
  if (range) {
    try {
      commitList = git(["rev-list", range]).trim().split("\n").filter(Boolean);
    } catch {
      commitList = [];
    }
  } else {
    commitList = git(["rev-list", "--all"]).trim().split("\n").filter(Boolean);
  }

  if (commitList.length === 0) {
    return scanHead(checks);
  }

  const blobsBySha = new Map();
  for (const commit of commitList) {
    let tree;
    try {
      tree = git(["ls-tree", "-r", commit]);
    } catch {
      continue;
    }
    for (const line of tree.split("\n")) {
      const m = line.match(/^\S+ blob (\S+)\s+(.+)$/);
      if (!m) continue;
      const [, sha, p] = m;
      if (!blobsBySha.has(sha)) blobsBySha.set(sha, new Set());
      blobsBySha.get(sha).add(p);
    }
  }

  for (const [sha, paths] of blobsBySha) {
    for (const p of paths) {
      if (p === SELF_PATH || SKIP_PATHS.has(p)) continue;
      issues.push(...scanText(p, checks, `${p} (path)`));
    }
    const shouldSkip = [...paths].every(
      (p) => p === SELF_PATH || SKIP_PATHS.has(p),
    );
    if (shouldSkip) continue;

    let buf;
    try {
      buf = gitBuf(["cat-file", "blob", sha], {
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      continue;
    }
    if (buf.length > 2 * 1024 * 1024 || isBinary(buf)) continue;
    blobCount++;
    const label = [...paths][0];
    issues.push(...scanText(buf.toString("utf8"), checks, label));
  }

  for (const commit of commitList) {
    try {
      const body = git(["log", "-1", "--format=%B", commit]).trim();
      if (!body) continue;
      msgCount++;
      issues.push(...scanText(body, checks, `commit ${commit.slice(0, 8)}`));
    } catch {
      /* skip */
    }
  }

  return { issues, blobCount, msgCount };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function report(allIssues, stats) {
  const { blobCount, msgCount, stagedCount } = stats;
  const w = (s) => process.stderr.write(`${s}\n`);

  w(
    `opsec-scan: ${blobCount} blobs, ${msgCount} commit messages, ${stagedCount} staged files`,
  );

  const fails = allIssues.filter((i) => i.severity === "fail");
  const warns = allIssues.filter((i) => i.severity === "warn");

  if (fails.length === 0 && warns.length === 0) {
    w("  ✓ no issues found");
    return 0;
  }

  const grouped = new Map();
  for (const i of [...fails, ...warns]) {
    const key = `[${i.severity.toUpperCase()}] ${i.check}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(i);
  }

  w("");
  for (const [key, items] of grouped) {
    w(`${key} (${items.length} hits):`);
    const seen = new Set();
    let printed = 0;
    for (const i of items) {
      const sig = `${i.location}:${i.line}:${i.match}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      if (printed >= 25) {
        w(`  ... and ${items.length - printed} more (${seen.size} unique)`);
        break;
      }
      w(`  ${i.location}:${i.line}  match=${JSON.stringify(i.match)}`);
      printed++;
    }
    w("");
  }

  w(`totals: ${fails.length} fail, ${warns.length} warn`);
  return fails.length > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const stagedOnly = process.argv.includes("--staged");
  const headOnly = process.argv.includes("--head");
  const unpushed = process.argv.includes("--unpushed");
  const { checks, envCount, opsecCount, projects } = buildChecks();
  process.stderr.write(
    `opsec-scan: ${envCount} .env values, ${opsecCount} .opsec.local values, ` +
      `${projects.length} claude projects\n`,
  );

  let treeResult = { issues: [], blobCount: 0, msgCount: 0 };
  if (unpushed) {
    treeResult = scanUnpushed(checks);
  } else if (headOnly) {
    treeResult = scanHead(checks);
  } else if (!stagedOnly) {
    treeResult = scanHistory(checks);
  }
  const stagedResult = scanStaged(checks);

  const allIssues = [...treeResult.issues, ...stagedResult.issues];
  return report(allIssues, {
    blobCount: treeResult.blobCount,
    msgCount: treeResult.msgCount,
    stagedCount: stagedResult.count,
  });
}

try {
  process.exit(main());
} catch (err) {
  process.stderr.write(`opsec-scan: fatal: ${err.message}\n`);
  process.exit(2);
}
