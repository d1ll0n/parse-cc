/**
 * Observed-corpus storage for the type-coverage audit.
 *
 * The corpus is a serialized `Schema` representing every shape ever audited
 * and accepted. Combined with the local scan during audit, it preserves
 * shape memory across machines and across time without bloating to gigabytes
 * (option A) or losing structural meaning (option C).
 *
 * Capture is **type-guided + allowlist-driven**:
 *   - Type-guided: at every typed `discUnion` position, samples are routed
 *     per-sample by their discriminator value. This means the corpus's
 *     structure mirrors the typed schema's structure, so `auditMerged` can
 *     do straightforward structural comparison. At typed `object` positions,
 *     capture walks per-typed-property (recursing with the right sub-schema)
 *     and records observed extras as plain inferred shapes.
 *   - Allowlist-driven: at any path matching the allowlist, capture stops
 *     and records `opaque(reason)`. Skip patterns in the allowlist come
 *     from two sources: walker-derived (for typed-`unknown` / typed-`Record`
 *     positions) and user-supplied entries.
 *
 * Result: the corpus is compact, structurally meaningful, and grows only
 * when real new variants appear in observed data.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { Schema, PrimKind } from "./schema.ts";
import { mergeSchemas, isPlainObject, MAX_DEPTH } from "./observed.ts";
import type { Allowlist } from "./allowlist.ts";

/**
 * Build a corpus `Schema` from raw JSONL entries, guided by the typed
 * schema. The result mirrors the typed schema's structural skeleton —
 * every typed `discUnion` becomes a discUnion of observed variants, every
 * typed `object` walks per-property, and so on.
 *
 * Properties / discriminator values not in `typed` are still captured (with
 * plain observed inference) so the audit can later report them as
 * missing-field / unknown-variant gaps.
 *
 * Allowlist matches at any path short-circuit to `opaque(reason)`.
 */
export function captureCorpus(
  samples: Iterable<unknown>,
  typed: Schema,
  allowlist: Allowlist
): Schema {
  return captureRouted(toArray(samples), typed, allowlist, "$", 0);
}

/**
 * Type-guided capture. Walks both the typed schema and the sample list
 * in lockstep, producing a corpus Schema that mirrors typed's structure.
 *
 * Exposed for tests — most callers should use `captureCorpus`.
 */
export function captureRouted(
  samples: unknown[],
  typed: Schema,
  allowlist: Allowlist,
  path: string,
  depth: number
): Schema {
  if (depth > MAX_DEPTH) return { kind: "opaque", reason: "max-depth" };

  const skipReason = allowlist.match(path);
  if (skipReason) return { kind: "opaque", reason: skipReason };

  if (samples.length === 0) {
    // No observed samples reached this position — leave a placeholder.
    return { kind: "opaque", reason: "no samples observed at this position" };
  }

  switch (typed.kind) {
    case "opaque":
      return { kind: "opaque", reason: typed.reason };

    case "literal":
      // Trust the typed literal. The audit catches mismatches separately
      // by comparing samples directly.
      return { kind: "literal", value: typed.value };

    case "prim":
      return capturePrim(samples);

    case "array":
      return captureArray(samples, typed, allowlist, path, depth);

    case "record":
      return captureRecord(samples, typed, allowlist, path, depth);

    case "discUnion":
      return captureDiscUnion(samples, typed, allowlist, path, depth);

    case "union":
      return captureUnion(samples, typed, allowlist, path, depth);

    case "object":
      return captureObject(samples, typed, allowlist, path, depth);
  }
}

function captureDiscUnion(
  samples: unknown[],
  typed: Extract<Schema, { kind: "discUnion" }>,
  allowlist: Allowlist,
  path: string,
  depth: number
): Schema {
  const byDisc: Record<string, unknown[]> = {};
  const noDisc: unknown[] = [];
  for (const s of samples) {
    if (!isPlainObject(s)) continue;
    const v = s[typed.discriminator];
    if (typeof v === "string") {
      if (!byDisc[v]) byDisc[v] = [];
      byDisc[v].push(s);
    } else {
      noDisc.push(s);
    }
  }

  const variants: Record<string, Schema> = {};
  for (const [discValue, subset] of Object.entries(byDisc)) {
    const subPath = `${path}[${discValue}]`;
    const typedVariant = typed.variants[discValue];
    if (typedVariant) {
      variants[discValue] = captureRouted(subset, typedVariant, allowlist, subPath, depth + 1);
    } else {
      // Unknown variant — capture observed shape so the audit can flag it.
      variants[discValue] = captureUntyped(subset, allowlist, subPath, depth + 1);
    }
  }

  // Discriminator-less samples bucket separately (rare in practice; they'd
  // show up in audit as ambiguous-fit gaps).
  if (noDisc.length > 0) {
    variants["<no-discriminator>"] = captureUntyped(noDisc, allowlist, `${path}[<no-discriminator>]`, depth + 1);
  }

  return { kind: "discUnion", discriminator: typed.discriminator, variants };
}

function captureObject(
  samples: unknown[],
  typed: Extract<Schema, { kind: "object" }>,
  allowlist: Allowlist,
  path: string,
  depth: number
): Schema {
  const objSamples = samples.filter(isPlainObject);
  if (objSamples.length === 0) {
    // Type expects object but no observed sample is one — capture observed
    // shape standalone so the audit reports the kind-mismatch.
    return captureUntyped(samples, allowlist, path, depth + 1);
  }

  const allKeys = new Set<string>();
  for (const s of objSamples) for (const k of Object.keys(s)) allKeys.add(k);

  const props: Record<string, { schema: Schema; required: boolean }> = {};
  for (const k of allKeys) {
    const subSamples: unknown[] = [];
    let timesPresent = 0;
    for (const s of objSamples) {
      const v = s[k];
      if (v !== undefined) {
        subSamples.push(v);
        timesPresent++;
      }
    }
    const subPath = `${path}.${k}`;
    const typedProp = typed.props[k];
    let subSchema: Schema;
    if (typedProp) {
      subSchema = captureRouted(subSamples, typedProp.schema, allowlist, subPath, depth + 1);
    } else if (typed.openExtras) {
      // openExtras absorbs unknown keys — record as opaque
      subSchema = { kind: "opaque", reason: "openExtras (parent)" };
    } else {
      // Unknown property — capture observed shape; audit will report missing-field.
      subSchema = captureUntyped(subSamples, allowlist, subPath, depth + 1);
    }
    props[k] = { schema: subSchema, required: timesPresent === objSamples.length };
  }

  return { kind: "object", props, openExtras: typed.openExtras };
}

function captureArray(
  samples: unknown[],
  typed: Extract<Schema, { kind: "array" }>,
  allowlist: Allowlist,
  path: string,
  depth: number
): Schema {
  const elements: unknown[] = [];
  for (const s of samples) if (Array.isArray(s)) elements.push(...s);
  return {
    kind: "array",
    element: captureRouted(elements, typed.element, allowlist, `${path}[]`, depth + 1),
  };
}

function captureRecord(
  samples: unknown[],
  typed: Extract<Schema, { kind: "record" }>,
  allowlist: Allowlist,
  path: string,
  depth: number
): Schema {
  const values: unknown[] = [];
  for (const s of samples) {
    if (!isPlainObject(s)) continue;
    for (const v of Object.values(s)) values.push(v);
  }
  return {
    kind: "record",
    value: captureRouted(values, typed.value, allowlist, `${path}{*}`, depth + 1),
  };
}

function captureUnion(
  samples: unknown[],
  typed: Extract<Schema, { kind: "union" }>,
  allowlist: Allowlist,
  path: string,
  depth: number
): Schema {
  // For each sample, pick the variant it best fits and accumulate per-variant.
  // Uses plain inference for fit measurement to avoid unbounded recursion.
  const buckets: Map<number, unknown[]> = new Map();
  for (const s of samples) {
    let bestIdx = -1;
    let bestScore = -1;
    for (let i = 0; i < typed.variants.length; i++) {
      const score = fitScore(typed.variants[i], s);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      const bucket = buckets.get(bestIdx) ?? [];
      bucket.push(s);
      buckets.set(bestIdx, bucket);
    }
  }

  const captured: Schema[] = [];
  for (let i = 0; i < typed.variants.length; i++) {
    const subset = buckets.get(i) ?? [];
    if (subset.length === 0) continue;
    captured.push(captureRouted(subset, typed.variants[i], allowlist, path, depth + 1));
  }
  return captured.length === 1 ? captured[0] : { kind: "union", variants: captured };
}

function capturePrim(samples: unknown[]): Schema {
  const types = new Set<PrimKind>();
  for (const s of samples) {
    if (s === null) types.add("null");
    else if (s === undefined) types.add("null");
    else if (typeof s === "string") types.add("string");
    else if (typeof s === "number") types.add("number");
    else if (typeof s === "boolean") types.add("boolean");
  }
  if (types.size === 0) return { kind: "opaque", reason: "no scalar samples" };
  return { kind: "prim", types: [...types].sort() };
}

/**
 * Plain observed-side inference for positions the typed schema doesn't
 * know about (extra properties, unknown discriminator values). Used when
 * type-guided routing has nothing to route into.
 */
function captureUntyped(
  samples: unknown[],
  allowlist: Allowlist,
  path: string,
  depth: number
): Schema {
  if (depth > MAX_DEPTH) return { kind: "opaque", reason: "max-depth" };
  const skipReason = allowlist.match(path);
  if (skipReason) return { kind: "opaque", reason: skipReason };
  let merged: Schema | null = null;
  for (const s of samples) {
    const sub = inferOneRespectingAllowlist(s, path, allowlist, depth);
    merged = merged ? mergeSchemas(merged, sub, depth) : sub;
  }
  return merged ?? { kind: "opaque", reason: "no samples" };
}

function inferOneRespectingAllowlist(
  value: unknown,
  path: string,
  allowlist: Allowlist,
  depth: number
): Schema {
  if (depth > MAX_DEPTH) return { kind: "opaque", reason: "max-depth" };
  const skipReason = allowlist.match(path);
  if (skipReason) return { kind: "opaque", reason: skipReason };

  if (value === null) return { kind: "prim", types: ["null"] };
  if (Array.isArray(value)) {
    let element: Schema | null = null;
    for (const v of value) {
      const sub = inferOneRespectingAllowlist(v, `${path}[]`, allowlist, depth + 1);
      element = element ? mergeSchemas(element, sub, depth + 1) : sub;
    }
    return {
      kind: "array",
      element: element ?? { kind: "opaque", reason: "empty" },
    };
  }
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return { kind: "prim", types: [typeof value as PrimKind] };
    case "object": {
      const props: Record<string, { schema: Schema; required: boolean }> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        props[k] = {
          schema: inferOneRespectingAllowlist(v, `${path}.${k}`, allowlist, depth + 1),
          required: true,
        };
      }
      return { kind: "object", props, openExtras: false };
    }
  }
  return { kind: "opaque", reason: `unhandled typeof ${typeof value}` };
}

function fitScore(typed: Schema, value: unknown): number {
  if (typed.kind === "opaque") return 0;
  if (typed.kind === "prim") {
    if (value === null) return typed.types.includes("null") ? 1 : 0;
    if (typeof value === "string") return typed.types.includes("string") ? 1 : 0;
    if (typeof value === "number") return typed.types.includes("number") ? 1 : 0;
    if (typeof value === "boolean") return typed.types.includes("boolean") ? 1 : 0;
    return 0;
  }
  if (typed.kind === "literal") return value === typed.value ? 2 : 0;
  if (typed.kind === "array") return Array.isArray(value) ? 1 : 0;
  if (typed.kind === "object" || typed.kind === "discUnion" || typed.kind === "record") {
    return isPlainObject(value) ? 1 : 0;
  }
  return 0;
}

function toArray(it: Iterable<unknown>): unknown[] {
  if (Array.isArray(it)) return it as unknown[];
  return [...it];
}

// ─────────────────────────────────────────────────────────────────────────────
// Merge into existing corpus.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Merge a freshly-captured local schema into an existing corpus.
 * Strict-additive: every shape in `existing` survives; new shapes from
 * `local` join. Implementation delegates to `mergeSchemas`.
 */
export function mergeIntoCorpus(existing: Schema, local: Schema): Schema {
  return mergeSchemas(existing, local);
}

// ─────────────────────────────────────────────────────────────────────────────
// Serialization with deterministic key ordering (for stable PR diffs).
// ─────────────────────────────────────────────────────────────────────────────

export function serializeCorpus(schema: Schema): string {
  return JSON.stringify(sortKeys(schema), null, 2);
}

export function deserializeCorpus(jsonText: string): Schema {
  return JSON.parse(jsonText) as Schema;
}

export function readCorpusFile(filePath: string): Schema | null {
  if (!existsSync(filePath)) return null;
  return deserializeCorpus(readFileSync(filePath, "utf8"));
}

export function writeCorpusFile(filePath: string, schema: Schema): void {
  writeFileSync(filePath, `${serializeCorpus(schema)}\n`);
}

function sortKeys(schema: Schema): Schema {
  switch (schema.kind) {
    case "object": {
      const sorted: Record<string, { schema: Schema; required: boolean }> = {};
      for (const k of Object.keys(schema.props).sort()) {
        sorted[k] = {
          schema: sortKeys(schema.props[k].schema),
          required: schema.props[k].required,
        };
      }
      return { kind: "object", props: sorted, openExtras: schema.openExtras };
    }
    case "discUnion": {
      const sorted: Record<string, Schema> = {};
      for (const k of Object.keys(schema.variants).sort()) {
        sorted[k] = sortKeys(schema.variants[k]);
      }
      return { kind: "discUnion", discriminator: schema.discriminator, variants: sorted };
    }
    case "array":
      return { kind: "array", element: sortKeys(schema.element) };
    case "record":
      return { kind: "record", value: sortKeys(schema.value) };
    case "union":
      return { kind: "union", variants: schema.variants.map(sortKeys) };
    case "prim":
      return { kind: "prim", types: [...schema.types].sort() };
    case "literal":
    case "opaque":
      return schema;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Walker → skip-set conversion.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert the typed walker's output into allowlist-shaped skip-set entries.
 *
 * For `opaque` positions: emit a trailing-`.*` pattern so any observed
 * descendant is short-circuited.
 *
 * For `record` positions: emit a trailing-`.*` pattern (NOT `{*}`). Capture
 * walks objects with `.key` syntax (it doesn't know which positions are
 * Records at the runtime layer); `.*` is the right transitive match.
 */
export function deriveSkipPatternsFromTypedSchema(
  typed: Schema
): Array<{ path: string; reason: string }> {
  const out: Array<{ path: string; reason: string }> = [];
  walkForSkips(typed, "$", out);
  return out;
}

function walkForSkips(
  schema: Schema,
  path: string,
  out: Array<{ path: string; reason: string }>
): void {
  switch (schema.kind) {
    case "opaque":
      out.push({ path: `${path}.*`, reason: schema.reason });
      return;
    case "record":
      out.push({
        path: `${path}.*`,
        reason: `Record<string, T>; per-key fan-out collapsed`,
      });
      return;
    case "object":
      for (const [k, { schema: sub }] of Object.entries(schema.props)) {
        walkForSkips(sub, `${path}.${k}`, out);
      }
      return;
    case "array":
      walkForSkips(schema.element, `${path}[]`, out);
      return;
    case "discUnion":
      for (const [k, sub] of Object.entries(schema.variants)) {
        walkForSkips(sub, `${path}[${k}]`, out);
      }
      return;
    case "union":
      for (const variant of schema.variants) {
        walkForSkips(variant, path, out);
      }
      return;
    case "prim":
    case "literal":
      return;
  }
}
