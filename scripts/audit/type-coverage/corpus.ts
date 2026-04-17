/**
 * Observed-corpus storage for the type-coverage audit.
 *
 * The corpus is a serialized `Schema` representing every shape ever audited
 * and accepted. Combined with the local scan during audit, it preserves
 * shape memory across machines and across time without bloating to gigabytes
 * (option A) or losing structural meaning (option C).
 *
 * Per spec §Observed corpus, capture is allowlist-driven:
 *   1. Walk raw JSONL samples.
 *   2. At every path, check the allowlist (auto-derived walker-opaques
 *      union user-supplied entries).
 *   3. If matched → record `opaque({reason})` and stop recursing.
 *   4. Otherwise → infer/merge the leaf shape into the running corpus.
 *
 * Result: the corpus is compact, structurally meaningful, and grows only
 * when real new variants appear in observed data.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { Schema, PrimKind } from "./schema.ts";
import {
  mergeSchemas,
  isPlainObject,
  MAX_DEPTH,
} from "./observed.ts";
import type { Allowlist } from "./allowlist.ts";

/**
 * Build a corpus `Schema` from raw JSONL entries. Top-level entries are
 * bucketed by their `type` value into a `discUnion`, mirroring the typed
 * walker's output shape — so the corpus and the typed schema have the
 * same top-level structure, making structural comparison straightforward.
 *
 * Entries without a string `type` field are bucketed under the literal key
 * `<no-type>`, preserving them for inspection without crashing the walk.
 */
export function captureCorpus(
  samples: Iterable<unknown>,
  allowlist: Allowlist
): Schema {
  const byType: Record<string, Schema> = {};

  for (const sample of samples) {
    if (!isPlainObject(sample)) continue;
    const type =
      typeof sample.type === "string" && sample.type !== ""
        ? sample.type
        : "<no-type>";
    const subPath = `$[${type}]`;
    const subSchema = captureOne(sample, subPath, allowlist, 0);
    byType[type] = byType[type]
      ? mergeSchemas(byType[type], subSchema)
      : subSchema;
  }

  return { kind: "discUnion", discriminator: "type", variants: byType };
}

/**
 * Walk a single value, producing a Schema. Stops at allowlist-matched paths
 * (records `opaque({reason})` instead of recursing) and at `MAX_DEPTH`.
 */
export function captureOne(
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
      const sub = captureOne(v, `${path}[]`, allowlist, depth + 1);
      element = element ? mergeSchemas(element, sub, depth + 1) : sub;
    }
    return {
      kind: "array",
      element: element ?? { kind: "opaque", reason: "empty array, no element samples" },
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
        const sub = captureOne(v, `${path}.${k}`, allowlist, depth + 1);
        props[k] = { schema: sub, required: true };
      }
      return { kind: "object", props, openExtras: false };
    }
  }

  return { kind: "opaque", reason: `unhandled typeof ${typeof value}` };
}

/**
 * Merge a freshly-captured local schema into an existing corpus.
 *
 * Strict-additive by default: every shape in `existing` survives, every new
 * shape in `local` joins. The merge is `mergeSchemas`, which:
 *   - Unions primitive types where both sides are primitive.
 *   - Recurses into matching objects/arrays/records.
 *   - Falls back to a flat union for mismatched kinds (no nested unions).
 *
 * This is what the capture script uses.
 */
export function mergeIntoCorpus(existing: Schema, local: Schema): Schema {
  return mergeSchemas(existing, local);
}

// ─────────────────────────────────────────────────────────────────────────────
// Serialization with deterministic key ordering (for stable PR diffs).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Serialize a corpus Schema to pretty-printed JSON with all object keys
 * sorted alphabetically. Diffs in the corpus file directly correspond to
 * "we observed a new variant or new property" — the sort is the load-bearing
 * piece for that property to hold.
 */
export function serializeCorpus(schema: Schema): string {
  return JSON.stringify(sortKeys(schema), null, 2);
}

/** Deserialize a corpus Schema from JSON text. Trusts the input is well-formed. */
export function deserializeCorpus(jsonText: string): Schema {
  return JSON.parse(jsonText) as Schema;
}

/** Convenience: read corpus from disk, returning null when the file doesn't exist. */
export function readCorpusFile(filePath: string): Schema | null {
  if (!existsSync(filePath)) return null;
  return deserializeCorpus(readFileSync(filePath, "utf8"));
}

/** Convenience: write corpus to disk with the deterministic serializer. */
export function writeCorpusFile(filePath: string, schema: Schema): void {
  writeFileSync(filePath, `${serializeCorpus(schema)}\n`);
}

/**
 * Recursively sort every Record's keys alphabetically. Schema-tree
 * positions: object.props, discUnion.variants. Other Record-like fields
 * (prim.types is already sorted by the constructor; arrays preserve order).
 */
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
 * Walks the typed Schema and, for every position where it finds an `opaque`
 * or `record`, emits a path pattern that capture will treat as a stop point.
 *
 * - `opaque(reason)` → emits the path with a trailing wildcard (`.*`) so any
 *   observed descendant is short-circuited with the typed reason.
 * - `record(value)` → emits the path with `{*}` glob so per-key fan-out is
 *   collapsed (and recurses into the value type for further opaques).
 *
 * Returned entries are merged with the user-supplied allowlist by the CLI.
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
        path: `${path}{*}`,
        reason: `Record<string, T>; per-key fan-out collapsed`,
      });
      walkForSkips(schema.value, `${path}{*}`, out);
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
