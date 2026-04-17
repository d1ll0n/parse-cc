// ─────────────────────────────────────────────────────────────────────────────
// TEMPORARY — CORPUS SIZING MEASUREMENT (rewritten to isolate per-type)
//
// >>> DELETE WHEN PHASE 1 LANDS — NOT PRODUCTION CODE <<<
// ─────────────────────────────────────────────────────────────────────────────
//
// Run: node --stack-size=16384 scripts/prototype-corpus-sizing.mjs
//
// First pass: walk all files, bucket entries by `type`. Report counts.
// Second pass: per type, attempt merge with depth cap. Report sizes per type.
// This isolates which entry types blow up the merger, which is itself a finding.

import { readdir, stat } from "node:fs/promises";
import { createReadStream, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import path from "node:path";

const PROJECTS = path.join(homedir(), ".claude", "projects");
const MAX_DEPTH = 32;

// Skip-set: positions where the typed schema declares opaque (or where the
// allowlist would). At these paths, capture stops merging and records an
// `opaque({reason})` marker. Mirrors the type-coverage audit's
// type-declared `unknown` / `Record<string, T>` positions.
//
// Path syntax: `entry[<type>]....` for top-level discriminator; `[]` for any
// array element; `{*}` for any object key.
const SKIP_PATTERNS = [
  { pattern: /^\$\[assistant\]\.message\.content\[\]\.input$/, reason: "tool_use.input is unknown — per-tool shape" },
  { pattern: /^\$\[user\]\.message\.content\[\]\.input$/, reason: "tool_use.input (in user-side blocks) is unknown" },
  { pattern: /^\$\[progress\]\.data\.message$/, reason: "ProgressEntry.data.message is declared unknown" },
  { pattern: /^\$\[file-history-snapshot\]\.snapshot\.trackedFileBackups$/, reason: "Record<string, TrackedFileBackup> — keys are file paths" },
];

function shouldSkip(path) {
  for (const { pattern, reason } of SKIP_PATTERNS) {
    if (pattern.test(path)) return reason;
  }
  return null;
}

function inferLeaf(value, depth = 0, path = "$") {
  if (depth > MAX_DEPTH) return { kind: "opaque", reason: "max-depth" };
  const skipReason = shouldSkip(path);
  if (skipReason) return { kind: "opaque", reason: skipReason };
  if (value === null) return { kind: "prim", types: ["null"] };
  if (Array.isArray(value)) {
    let element = null;
    for (const v of value) element = mergeObserved(element, v, depth + 1, `${path}[]`);
    return { kind: "array", element: element ?? { kind: "opaque", reason: "empty" } };
  }
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return { kind: "prim", types: [typeof value] };
    case "object": {
      const props = {};
      for (const [k, v] of Object.entries(value)) {
        props[k] = { schema: inferLeaf(v, depth + 1, `${path}.${k}`), required: true };
      }
      return { kind: "object", props, openExtras: false };
    }
  }
  return { kind: "opaque", reason: typeof value };
}

function mergeObserved(existing, sample, depth = 0, path = "$") {
  if (depth > MAX_DEPTH) return { kind: "opaque", reason: "max-depth" };
  if (!existing) return inferLeaf(sample, depth, path);
  return mergeSchemas(existing, inferLeaf(sample, depth, path), depth);
}

function mergeSchemas(a, b, depth = 0) {
  if (depth > MAX_DEPTH) return { kind: "opaque", reason: "max-depth" };
  if (a.kind === b.kind) {
    switch (a.kind) {
      case "prim":
        return { kind: "prim", types: [...new Set([...a.types, ...b.types])].sort() };
      case "array":
        return { kind: "array", element: mergeSchemas(a.element, b.element, depth + 1) };
      case "object": {
        const allKeys = new Set([...Object.keys(a.props), ...Object.keys(b.props)]);
        const props = {};
        for (const k of allKeys) {
          const inA = a.props[k];
          const inB = b.props[k];
          if (inA && inB) {
            props[k] = {
              schema: mergeSchemas(inA.schema, inB.schema, depth + 1),
              required: inA.required && inB.required,
            };
          } else if (inA) {
            props[k] = { schema: inA.schema, required: false };
          } else {
            props[k] = { schema: inB.schema, required: false };
          }
        }
        return { kind: "object", props, openExtras: a.openExtras || b.openExtras };
      }
    }
  }
  return flattenUnion([a, b], depth);
}

function flattenUnion(parts, depth = 0) {
  const flat = [];
  for (const p of parts) {
    if (p.kind === "union") flat.push(...p.variants);
    else flat.push(p);
  }
  const byKind = {};
  for (const v of flat) (byKind[v.kind] ??= []).push(v);
  const out = [];
  for (const group of Object.values(byKind)) {
    let acc = group[0];
    for (let i = 1; i < group.length; i++) acc = mergeSchemas(acc, group[i], depth + 1);
    out.push(acc);
  }
  return out.length === 1 ? out[0] : { kind: "union", variants: out };
}

function schemaDepth(s, seen = new Set()) {
  if (!s || typeof s !== "object") return 0;
  if (seen.has(s)) return 0;
  seen.add(s);
  switch (s.kind) {
    case "object": {
      let max = 0;
      for (const { schema } of Object.values(s.props)) {
        const d = schemaDepth(schema, seen);
        if (d > max) max = d;
      }
      return max + 1;
    }
    case "array":
      return schemaDepth(s.element, seen) + 1;
    case "union":
      return Math.max(0, ...s.variants.map((v) => schemaDepth(v, seen))) + 1;
    case "record":
      return schemaDepth(s.value, seen) + 1;
    case "discUnion":
      return Math.max(0, ...Object.values(s.variants).map((v) => schemaDepth(v, seen))) + 1;
    default:
      return 0;
  }
}

async function main() {
  const startTime = Date.now();
  const projects = await readdir(PROJECTS);

  // Phase 1: collect counts only.
  let totalEntries = 0;
  let totalSessions = 0;
  let totalBytes = 0;
  const uniqueShapes = new Set();
  const oneSamplePerShape = new Map();
  const samplesByType = new Map(); // type → array of sample objects (capped per type)
  const propKeyCounts = new Map();
  const SAMPLES_PER_TYPE = 500; // cap to avoid OOM

  for (const project of projects) {
    const pdir = path.join(PROJECTS, project);
    let st;
    try { st = await stat(pdir); } catch { continue; }
    if (!st.isDirectory()) continue;

    const files = await readdir(pdir);
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const fp = path.join(pdir, f);
      const fileStat = await stat(fp);
      totalBytes += fileStat.size;
      totalSessions++;

      const stream = createReadStream(fp, { encoding: "utf8" });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });

      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let entry;
        try { entry = JSON.parse(trimmed); } catch { continue; }
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;

        totalEntries++;

        const type = typeof entry.type === "string" ? entry.type : "<no-type>";
        const sortedKeys = Object.keys(entry).sort().join(",");
        const shapeKey = `${type}::${sortedKeys}`;
        uniqueShapes.add(shapeKey);
        if (!oneSamplePerShape.has(shapeKey)) {
          oneSamplePerShape.set(shapeKey, entry);
        }

        // Capped sampling for per-type merge (saves memory)
        const bucket = samplesByType.get(type);
        if (!bucket) samplesByType.set(type, [entry]);
        else if (bucket.length < SAMPLES_PER_TYPE) bucket.push(entry);

        if (type === "user" && entry.toolUseResult && typeof entry.toolUseResult === "object" && !Array.isArray(entry.toolUseResult)) {
          for (const k of Object.keys(entry.toolUseResult)) {
            const key = `entry[user].toolUseResult{${k}}`;
            propKeyCounts.set(key, (propKeyCounts.get(key) ?? 0) + 1);
          }
        }
        if (type === "system" && typeof entry.subtype === "string") {
          const key = `entry[system].subtype=${entry.subtype}`;
          propKeyCounts.set(key, (propKeyCounts.get(key) ?? 0) + 1);
        }
        if (type === "attachment" && entry.attachment && typeof entry.attachment === "object" && !Array.isArray(entry.attachment) && typeof entry.attachment.type === "string") {
          const key = `entry[attachment].attachment.type=${entry.attachment.type}`;
          propKeyCounts.set(key, (propKeyCounts.get(key) ?? 0) + 1);
        }
      }
    }
  }

  const phase1Ms = Date.now() - startTime;

  console.log(`\n=== Scan complete (${(phase1Ms / 1000).toFixed(1)}s) ===`);
  console.log(`session files:           ${totalSessions.toLocaleString()}`);
  console.log(`raw JSONL bytes:         ${formatBytes(totalBytes)}`);
  console.log(`entries scanned:         ${totalEntries.toLocaleString()}`);
  console.log(`unique (type, keys):     ${uniqueShapes.size.toLocaleString()} shapes`);
  console.log(`per-type sample cap:     ${SAMPLES_PER_TYPE} (limits per-type memory)`);

  // Phase 2: per-type merge with depth cap + skip-set applied.
  console.log(`\n=== Per-type merged Schema sizes (depth cap=${MAX_DEPTH}, skip-set applied) ===`);
  console.log(`Skip patterns:`);
  for (const { pattern, reason } of SKIP_PATTERNS) console.log(`  ${pattern.source}  // ${reason}`);
  console.log("");
  const perTypeResults = [];
  for (const [type, samples] of samplesByType) {
    let merged = null;
    let crashed = false;
    try {
      // Start path at $[<type>] so skip patterns can target by entry type.
      for (const s of samples) merged = mergeObserved(merged, s, 0, `$[${type}]`);
    } catch (e) {
      crashed = true;
      console.log(`  CRASH on type=${type}: ${e.message}`);
    }
    if (crashed || !merged) {
      perTypeResults.push({ type, samples: samples.length, bytes: 0, depth: 0, crashed: true });
      continue;
    }
    let bytes = 0;
    let depth = 0;
    try {
      bytes = JSON.stringify(merged).length;
      depth = schemaDepth(merged);
    } catch (e) {
      console.log(`  CRASH on serialize/depth for type=${type}: ${e.message}`);
      perTypeResults.push({ type, samples: samples.length, bytes: 0, depth: 0, crashed: true });
      continue;
    }
    perTypeResults.push({ type, samples: samples.length, bytes, depth, crashed: false });
  }

  perTypeResults.sort((a, b) => b.bytes - a.bytes);
  for (const r of perTypeResults) {
    if (r.crashed) {
      console.log(`  CRASHED         depth=??     n=${r.samples.toString().padStart(4)}  ${r.type}`);
    } else {
      console.log(`  ${formatBytes(r.bytes).padStart(10)}  depth=${r.depth.toString().padStart(2)}  n=${r.samples.toString().padStart(4)}  ${r.type}`);
    }
  }
  const totalSchemaBytes = perTypeResults.reduce((s, r) => s + r.bytes, 0);
  console.log(`  ${formatBytes(totalSchemaBytes).padStart(10)}  TOTAL (sum of typed buckets)`);

  // Option C: one sample per shape
  const optionCJson = [...oneSamplePerShape.values()].map((e) => JSON.stringify(e)).join("\n");
  console.log(`\n=== Option C — one sample per unique shape ===`);
  console.log(`  ${uniqueShapes.size.toLocaleString()} samples, ${formatBytes(optionCJson.length)} (JSONL)`);
  console.log(`  vs raw JSONL: ${(optionCJson.length / totalBytes * 100).toFixed(2)}%`);

  console.log(`\n=== Top high-cardinality property positions ===`);
  const sortedKeys = [...propKeyCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
  for (const [k, n] of sortedKeys) {
    console.log(`  ${n.toLocaleString().padStart(8)}× ${k}`);
  }
  console.log(`  (${propKeyCounts.size.toLocaleString()} distinct keys total at tracked paths)`);

  writeFileSync("/tmp/observed-corpus-sample-C.jsonl", optionCJson);
  console.log("\nWrote /tmp/observed-corpus-sample-C.jsonl");
}

function formatBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
