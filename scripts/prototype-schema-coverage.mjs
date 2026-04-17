// ─────────────────────────────────────────────────────────────────────────────
// TEMPORARY — DESIGN-VALIDATION PROTOTYPE
//
// This file exists to validate the Schema ADT and per-sample-routing comparator
// before Phase 1 of the type-coverage audit (see PR #5) ships. Reviewers can
// run it to confirm the design behaves as the spec claims.
//
// >>> REMOVE THIS FILE WHEN PHASE 1 LANDS at scripts/audit/type-coverage.ts <<<
// ─────────────────────────────────────────────────────────────────────────────
//
// Run:  node scripts/prototype-schema-coverage.mjs
//
// What this is NOT: production code, TypeScript-aware (no ts-morph yet),
// streaming-safe, or wired to ~/.claude. The typed schemas below are
// hand-written. The point is to learn what breaks before we automate.

// ─────────────────────────────────────────────────────────────────────────────
// Schema ADT (plain objects so it's serializable + diffable)
// ─────────────────────────────────────────────────────────────────────────────
//
//  prim        : { kind: "prim", types: ["string", "number", "boolean", "null"] }
//  literal     : { kind: "literal", value: "x" }
//  array       : { kind: "array", element: Schema }
//  object      : { kind: "object", props: { name: { schema, required } }, openExtras }
//  record      : { kind: "record", value: Schema }
//  discUnion   : { kind: "discUnion", discriminator: "type", variants: { foo: Schema, bar: Schema } }
//  union       : { kind: "union", variants: [Schema, ...] }     // untagged
//  opaque      : { kind: "opaque", reason: "string" }

// Constructors
const prim = (...types) => ({ kind: "prim", types: [...new Set(types)].sort() });
const literal = (value) => ({ kind: "literal", value });
const array = (element) => ({ kind: "array", element });
const object = (props, openExtras = false) => ({
  kind: "object",
  props: Object.fromEntries(
    Object.entries(props).map(([k, v]) =>
      v?.kind ? [k, { schema: v, required: true }] : [k, v]
    )
  ),
  openExtras,
});
const optional = (schema) => ({ schema, required: false });
const record = (value) => ({ kind: "record", value });
const discUnion = (discriminator, variants) => ({ kind: "discUnion", discriminator, variants });
const union = (variants) => ({ kind: "union", variants });
const opaque = (reason) => ({ kind: "opaque", reason });

// ─────────────────────────────────────────────────────────────────────────────
// Observed-merger: raw JSON → Schema, accumulating across samples.
// ─────────────────────────────────────────────────────────────────────────────

function inferLeaf(value) {
  if (value === null) return prim("null");
  if (Array.isArray(value)) {
    let element = null;
    for (const v of value) element = mergeObserved(element, v);
    return array(element ?? opaque("empty array, no element samples"));
  }
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return prim(typeof value);
    case "object": {
      const props = {};
      for (const [k, v] of Object.entries(value)) {
        props[k] = { schema: inferLeaf(v), required: true };
      }
      return { kind: "object", props, openExtras: false };
    }
  }
  return opaque(`unhandled typeof ${typeof value}`);
}

function mergeObserved(existing, sample) {
  if (existing === null || existing === undefined) return inferLeaf(sample);
  const fresh = inferLeaf(sample);
  return mergeSchemas(existing, fresh);
}

function mergeSchemas(a, b) {
  if (a.kind === b.kind) {
    switch (a.kind) {
      case "prim":
        return prim(...a.types, ...b.types);
      case "array":
        return array(mergeSchemas(a.element, b.element));
      case "object": {
        const allKeys = new Set([...Object.keys(a.props), ...Object.keys(b.props)]);
        const props = {};
        for (const k of allKeys) {
          const inA = a.props[k];
          const inB = b.props[k];
          if (inA && inB) {
            props[k] = { schema: mergeSchemas(inA.schema, inB.schema), required: inA.required && inB.required };
          } else if (inA) {
            props[k] = { schema: inA.schema, required: false };
          } else {
            props[k] = { schema: inB.schema, required: false };
          }
        }
        return { kind: "object", props, openExtras: a.openExtras || b.openExtras };
      }
      case "literal":
        return a.value === b.value ? a : union([a, b]);
    }
  }
  // Mismatched kinds → untagged union
  return union([a, b]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Comparator: audit(typed, samples) → Gap[]
//
// Walks typed, routing raw samples at discUnion positions, merging only at
// object positions after routing. This is the architecturally-correct path —
// pre-merging samples loses discriminator info and breaks union routing.
//
// Gap shape: { path, kind, detail }
// ─────────────────────────────────────────────────────────────────────────────

function audit(typed, samples, path = "$") {
  if (!typed) return [{ path, kind: "missing-typed", detail: "no typed schema at this position" }];
  if (typed.kind === "opaque") return []; // allowlisted subtree
  if (samples.length === 0) return []; // nothing observed at this path

  if (typed.kind === "literal") {
    const gaps = [];
    for (const s of samples) {
      if (s !== typed.value) {
        gaps.push({ path, kind: "literal-mismatch", detail: `expected ${JSON.stringify(typed.value)}, observed ${JSON.stringify(s)}` });
        break; // one is enough
      }
    }
    return gaps;
  }

  if (typed.kind === "prim") {
    const seen = new Set();
    for (const s of samples) {
      if (s === null) seen.add("null");
      else seen.add(typeof s);
    }
    const extras = [...seen].filter((t) => !typed.types.includes(t));
    return extras.length ? [{ path, kind: "widen-prim", detail: `observed +${extras.join(",")}` }] : [];
  }

  if (typed.kind === "array") {
    const elements = [];
    for (const s of samples) if (Array.isArray(s)) elements.push(...s);
    return audit(typed.element, elements, `${path}[]`);
  }

  if (typed.kind === "record") {
    const gaps = [];
    for (const s of samples) {
      if (!isPlainObject(s)) continue;
      for (const v of Object.values(s)) {
        gaps.push(...audit(typed.value, [v], `${path}{*}`));
      }
    }
    return dedupGaps(gaps);
  }

  if (typed.kind === "discUnion") {
    return routeDiscUnion(typed, samples, path);
  }

  if (typed.kind === "union") {
    // Untagged: try each variant per sample, pick the one with fewest gaps.
    const gaps = [];
    for (const s of samples) {
      let bestGaps = null;
      for (const v of typed.variants) {
        const g = audit(v, [s], path);
        if (bestGaps === null || g.length < bestGaps.length) bestGaps = g;
      }
      gaps.push(...(bestGaps ?? []));
    }
    return dedupGaps(gaps);
  }

  if (typed.kind === "object") {
    return auditObject(typed, samples, path);
  }

  return [{ path, kind: "unhandled-typed-kind", detail: typed.kind }];
}

function routeDiscUnion(disc, samples, path) {
  const gaps = [];
  const byDisc = {};
  const noDisc = [];
  for (const s of samples) {
    if (!isPlainObject(s)) continue;
    const v = s[disc.discriminator];
    if (typeof v === "string") (byDisc[v] ??= []).push(s);
    else noDisc.push(s);
  }

  for (const [discValue, subset] of Object.entries(byDisc)) {
    const variant = disc.variants[discValue];
    if (!variant) {
      gaps.push({
        path: `${path}[${discValue}]`,
        kind: "unknown-variant",
        detail: `discriminator ${disc.discriminator}=${JSON.stringify(discValue)} has no typed variant. observed properties: ${propsAcross(subset).join(", ")}`,
      });
      continue;
    }
    gaps.push(...audit(variant, subset, `${path}[${discValue}]`));
  }

  for (const s of noDisc) {
    gaps.push(...bestFitOne(disc, s, path));
  }

  return dedupGaps(gaps);
}

function bestFitOne(disc, sample, path) {
  if (!isPlainObject(sample)) return [];
  const observedKeys = new Set(Object.keys(sample));
  let bestName = null;
  let bestScore = 0;
  for (const [name, v] of Object.entries(disc.variants)) {
    if (v.kind !== "object") continue;
    const overlap = [...observedKeys].filter((k) => v.props[k]).length;
    if (overlap > bestScore) {
      bestScore = overlap;
      bestName = name;
    }
  }
  // Heuristic: if best-fit covers <50% of observed keys, treat as a brand-new variant.
  const threshold = Math.max(1, Math.ceil(observedKeys.size * 0.5));
  if (bestScore < threshold) {
    return [{
      path,
      kind: "no-variant-match",
      detail: `discriminator-less observed object did not structurally match any typed variant. observed properties: ${[...observedKeys].join(", ")}. variants: ${Object.keys(disc.variants).join(", ")}`,
    }];
  }
  // Best-fit met threshold; if recursion produces gaps, those mean the structure
  // doesn't actually match — collapse the situation into a single ambiguous-fit
  // gap so callers don't get misleading per-field gaps under [~variantName].
  const downstream = audit(disc.variants[bestName], [sample], `${path}[~${bestName}]`);
  if (downstream.length === 0) return [];
  const summary = downstream.map(g => `${g.kind}: ${g.path} (${g.detail})`).join("; ");
  return [{
    path,
    kind: "ambiguous-fit",
    detail: `best-fit variant=${bestName} (score ${bestScore}/${observedKeys.size}); structural mismatches: ${summary}; observed properties: ${[...observedKeys].join(", ")}`,
  }];
}

function auditObject(typed, samples, path) {
  // Merge samples into a property-set view so we can detect missing fields and
  // compute optional/required from observation counts.
  const objectSamples = samples.filter(isPlainObject);
  if (objectSamples.length === 0) {
    // Type expects object but no observed sample is one
    const observedKinds = [...new Set(samples.map(s => s === null ? "null" : Array.isArray(s) ? "array" : typeof s))];
    return [{ path, kind: "kind-mismatch", detail: `typed=object observed=${observedKinds.join("|")}` }];
  }

  const gaps = [];
  const allKeys = new Set();
  for (const s of objectSamples) for (const k of Object.keys(s)) allKeys.add(k);

  for (const k of allKeys) {
    const typedProp = typed.props[k];
    if (!typedProp) {
      if (!typed.openExtras) {
        const sampleVals = objectSamples.map(s => s[k]).filter(v => v !== undefined);
        gaps.push({
          path: `${path}.${k}`,
          kind: "missing-field",
          detail: `observed type: ${describe(inferLeafSafe(sampleVals))}`,
        });
      }
      continue;
    }
    const subSamples = objectSamples.map(s => s[k]).filter(v => v !== undefined);
    gaps.push(...audit(typedProp.schema, subSamples, `${path}.${k}`));
  }

  return gaps;
}

function inferLeafSafe(samples) {
  let merged = null;
  for (const s of samples) merged = mergeObserved(merged, s);
  return merged ?? opaque("no samples");
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function propsAcross(samples) {
  const all = new Set();
  for (const s of samples) if (isPlainObject(s)) for (const k of Object.keys(s)) all.add(k);
  return [...all];
}

function dedupGaps(gaps) {
  const seen = new Set();
  const out = [];
  for (const g of gaps) {
    const key = `${g.path}::${g.kind}::${g.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(g);
  }
  return out;
}

function describe(s) {
  if (!s) return "?";
  if (s.kind === "prim") return s.types.join("|");
  if (s.kind === "literal") return JSON.stringify(s.value);
  if (s.kind === "array") return `array<${describe(s.element)}>`;
  if (s.kind === "object") return `object{${Object.keys(s.props).join(",")}}`;
  return s.kind;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const fixtures = [];

// Fixture 1: clean discriminated union by `type` field.
fixtures.push({
  name: "discriminated union with literal `type` (UserEntry / AssistantEntry)",
  typed: discUnion("type", {
    user: object({
      type: literal("user"),
      message: object({ role: prim("string"), content: prim("string") }),
    }),
    assistant: object({
      type: literal("assistant"),
      message: object({ role: prim("string"), content: prim("string") }),
      usage: object({ input_tokens: prim("number"), output_tokens: prim("number") }),
    }),
  }),
  samples: [
    { type: "user", message: { role: "user", content: "hi" } },
    { type: "assistant", message: { role: "assistant", content: "ok" }, usage: { input_tokens: 10, output_tokens: 5 } },
  ],
  expectedGaps: 0,
  hypothesis: "Both samples covered exactly. Zero gaps.",
});

// Fixture 2: NEW field on existing variant (UsageMetadata gains a field).
fixtures.push({
  name: "new field on assistant.usage that types don't model",
  typed: discUnion("type", {
    assistant: object({
      type: literal("assistant"),
      usage: object({ input_tokens: prim("number"), output_tokens: prim("number") }),
    }),
  }),
  samples: [
    { type: "assistant", usage: { input_tokens: 10, output_tokens: 5 } },
    { type: "assistant", usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 200 } },
  ],
  expectedGaps: 1,
  hypothesis: "One gap at $[assistant].usage.cache_creation_input_tokens (number).",
});

// Fixture 3: discriminator-less object union (the task-list attachment problem).
fixtures.push({
  name: "AttachmentPayload-ish discriminated union, but observed payload has NO discriminator literal",
  typed: discUnion("type", {
    skill_listing: object({
      type: literal("skill_listing"),
      content: prim("string"),
      skillCount: prim("number"),
    }),
    hook_success: object({
      type: literal("hook_success"),
      hookName: prim("string"),
      content: prim("string"),
    }),
  }),
  samples: [
    // Has discriminator — covered.
    { type: "skill_listing", content: "...", skillCount: 42 },
    // Missing discriminator AND observed properties don't overlap any variant: a brand-new task-list attachment subtype.
    { content: [{ id: "1", subject: "Task", status: "pending" }] },
  ],
  expectedGaps: 1,
  hypothesis: "Discriminator-less observed object should report `no-variant-match` (or land on best-fit + gaps).",
});

// Fixture 4: open record `Record<string, unknown>` — every observed key is allowed.
fixtures.push({
  name: "Record<string, unknown> covers any keys (mcp__* tool results)",
  typed: object({
    type: literal("user"),
    toolUseResult: record(opaque("MCP tool result; user-defined per server")),
  }),
  samples: [
    { type: "user", toolUseResult: { mcp__github__create_issue: { number: 42, url: "https://..." } } },
    { type: "user", toolUseResult: { mcp__slack__send: { ok: true, channel: "#general" } } },
  ],
  expectedGaps: 0,
  hypothesis: "Every dynamic key matched against `record(opaque)` — zero gaps.",
});

// Fixture 5: openExtras: true (QueuedCommandPayload-style).
fixtures.push({
  name: "object with openExtras: true ([key: string]: unknown)",
  typed: object(
    { type: literal("queued_command"), content: optional(prim("string")) },
    /* openExtras */ true
  ),
  samples: [
    { type: "queued_command", content: "/foo" },
    { type: "queued_command", commandId: "abc-123", customField: { nested: true } },
  ],
  expectedGaps: 0,
  hypothesis: "openExtras absorbs the unknown properties — zero gaps.",
});

// Fixture 6: nested array of discriminated content blocks.
fixtures.push({
  name: "message.content[] is array of discriminated content blocks",
  typed: object({
    type: literal("assistant"),
    message: object({
      content: array(discUnion("type", {
        text: object({ type: literal("text"), text: prim("string") }),
        tool_use: object({ type: literal("tool_use"), id: prim("string"), name: prim("string"), input: opaque("per-tool") }),
      })),
    }),
  }),
  samples: [
    {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "let me check" },
          { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/x" } },
        ],
      },
    },
    {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "done" },
          // NEW content block type, not in typed union → should report unknown-variant.
          { type: "thinking", thinking: "internal..." },
        ],
      },
    },
  ],
  expectedGaps: 1,
  hypothesis: "Unknown content-block variant `thinking` reported.",
});

// Fixture 7: optional inference. A field present in some samples, absent in others.
fixtures.push({
  name: "optional vs required inference across samples",
  typed: object({
    type: literal("user"),
    message: object({ role: prim("string"), content: prim("string") }),
    isMeta: optional(prim("boolean")),
    isCompactSummary: optional(prim("boolean")),
  }),
  samples: [
    { type: "user", message: { role: "user", content: "a" }, isMeta: false },
    { type: "user", message: { role: "user", content: "b" } },
    { type: "user", message: { role: "user", content: "c" }, isCompactSummary: true },
  ],
  expectedGaps: 0,
  hypothesis: "Both isMeta and isCompactSummary are optional in types and observed inconsistently — should be fine.",
});

// ─────────────────────────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────────────────────────

function runFixture(fx) {
  const gaps = audit(fx.typed, fx.samples);
  return { gaps };
}

const out = [];
let pass = 0;
let fail = 0;
for (const fx of fixtures) {
  const { gaps } = runFixture(fx);
  const ok = gaps.length === fx.expectedGaps;
  if (ok) pass++;
  else fail++;
  out.push({
    fixture: fx.name,
    hypothesis: fx.hypothesis,
    expectedGaps: fx.expectedGaps,
    actualGaps: gaps.length,
    status: ok ? "PASS" : "FAIL",
    gaps,
  });
}

for (const r of out) {
  console.log(`\n[${r.status}] ${r.fixture}`);
  console.log(`  hypothesis: ${r.hypothesis}`);
  console.log(`  expected ${r.expectedGaps} gap(s), got ${r.actualGaps}`);
  for (const g of r.gaps) {
    console.log(`    ${g.kind} @ ${g.path}: ${g.detail}`);
  }
}

console.log(`\n${pass}/${pass + fail} fixtures matched expected gap count.`);
if (fail > 0) process.exit(1);
