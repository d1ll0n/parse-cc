/**
 * Observed-side schema inference + merge.
 *
 * Given raw JSONL values, produces a `Schema` describing their shape.
 * Multiple samples merge into a single schema where:
 *   - Properties present in some samples but not others become optional.
 *   - Different primitive types at the same position widen into a union.
 *   - Mismatched complex shapes (object vs primitive) become an untagged union.
 *
 * Used by:
 *   - The comparator at object positions, for "what type was actually observed
 *     here?" in gap output.
 *   - The corpus loader for serialized historical shapes.
 *
 * NOTE: this is a leaf-style inference — does NOT do per-sample routing the
 * way the comparator does. Pre-merging samples through this loses
 * discriminator info. The comparator only ever calls into the merger
 * AFTER routing has happened at object positions. See spec §Comparator
 * semantics for why.
 *
 * CORRECTNESS REQUIREMENTS (per spec §Merger correctness requirements):
 *   1. mergeSchemas flattens same-kind variants on union construction. Without
 *      this, mergeSchemas(union([A, B]), C) returns union([union([A, B]), C])
 *      and depth grows unboundedly. Real corpora hit stack overflow within
 *      seconds without the flatten.
 *   2. Recursion depth is capped via inferLeaf/mergeSchemas/mergeObserved
 *      taking a depth parameter; beyond MAX_DEPTH we return an opaque marker.
 *      Embedded API messages (in ProgressEntry) and nested tree structures
 *      (in FileHistorySnapshotEntry) blow the stack on unbounded merge.
 */
import type { Schema, PrimKind } from "./schema.ts";

/**
 * Maximum recursion depth before the merger short-circuits to opaque. Tuned
 * empirically against real ~/.claude logs — 32 is well past anything the
 * library actually models, while bounding pathological cases (deeply nested
 * tool outputs, embedded API messages).
 */
export const MAX_DEPTH = 32;

/** Infer a Schema from a single raw JSONL value (object/array/primitive/null). */
export function inferLeaf(value: unknown, depth = 0): Schema {
  if (depth > MAX_DEPTH) return { kind: "opaque", reason: "max-depth" };
  if (value === null) return { kind: "prim", types: ["null"] };
  if (Array.isArray(value)) {
    let element: Schema | null = null;
    for (const v of value) element = mergeObserved(element, v, depth + 1);
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
        props[k] = { schema: inferLeaf(v, depth + 1), required: true };
      }
      return { kind: "object", props, openExtras: false };
    }
  }
  return { kind: "opaque", reason: `unhandled typeof ${typeof value}` };
}

/** Merge a fresh sample into an existing accumulated schema. Returns the merged result. */
export function mergeObserved(existing: Schema | null, sample: unknown, depth = 0): Schema {
  if (depth > MAX_DEPTH) return { kind: "opaque", reason: "max-depth" };
  if (existing === null || existing === undefined) return inferLeaf(sample, depth);
  return mergeSchemas(existing, inferLeaf(sample, depth), depth);
}

/**
 * Structural merge of two schemas. Public for the corpus merge step.
 *
 * Same-kind merges: union the primitive type sets, recurse into array
 * elements, merge object properties (with optional/required widening),
 * recurse into record values, etc.
 *
 * Mismatched-kind merges: produce a `union(...)` that has been *flattened*
 * via `flattenUnion` so we never end up with `union([union([A, B]), C])`.
 */
export function mergeSchemas(a: Schema, b: Schema, depth = 0): Schema {
  if (depth > MAX_DEPTH) return { kind: "opaque", reason: "max-depth" };
  if (a.kind === b.kind) {
    switch (a.kind) {
      case "prim": {
        const set = new Set<PrimKind>([...a.types, ...(b as typeof a).types]);
        return { kind: "prim", types: [...set].sort() };
      }
      case "array":
        return {
          kind: "array",
          element: mergeSchemas(a.element, (b as typeof a).element, depth + 1),
        };
      case "object": {
        const otherObj = b as typeof a;
        const allKeys = new Set([
          ...Object.keys(a.props),
          ...Object.keys(otherObj.props),
        ]);
        const props: Record<string, { schema: Schema; required: boolean }> = {};
        for (const k of allKeys) {
          const inA = a.props[k];
          const inB = otherObj.props[k];
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
        return {
          kind: "object",
          props,
          openExtras: a.openExtras || otherObj.openExtras,
        };
      }
      case "literal": {
        const otherLit = b as typeof a;
        return a.value === otherLit.value
          ? a
          : flattenUnion([a, otherLit], depth);
      }
      case "record":
        return {
          kind: "record",
          value: mergeSchemas(a.value, (b as typeof a).value, depth + 1),
        };
      case "opaque": {
        // Identical opaques (same reason) collapse to one — without this,
        // merging two identical opaques recurses infinitely via flattenUnion.
        const otherOpaque = b as typeof a;
        return a.reason === otherOpaque.reason
          ? a
          : { kind: "union", variants: [a, otherOpaque] };
      }
      case "discUnion":
      case "union":
        // These don't naturally appear in inferLeaf output; flatten if they
        // ever show up via direct corpus merge.
        return flattenUnion([a, b], depth);
    }
  }
  return flattenUnion([a, b], depth);
}

/**
 * Build a union from a list of schema parts, with two simplifications:
 *
 * 1. Any part that is itself a `union` is spliced in (no nested unions).
 * 2. Same-kind parts are merged together (so `[object{a}, object{b}]`
 *    becomes one widened object instead of an untagged union of two
 *    structurally-similar objects).
 *
 * If the result has only one part, returns it directly (no synthetic union
 * wrapper). This is the load-bearing fix without which deep merges crash.
 */
export function flattenUnion(parts: Schema[], depth = 0): Schema {
  if (depth > MAX_DEPTH) return { kind: "opaque", reason: "max-depth" };

  const flat: Schema[] = [];
  for (const p of parts) {
    if (p.kind === "union") flat.push(...p.variants);
    else flat.push(p);
  }

  // Group by kind, merge each group via mergeSchemas. literal/opaque get
  // grouped by-value/by-reason so identical entries dedupe naturally.
  const byKind: Record<string, Schema[]> = {};
  for (const v of flat) {
    const groupKey =
      v.kind === "literal"
        ? `literal:${JSON.stringify(v.value)}`
        : v.kind === "opaque"
          ? `opaque:${v.reason}`
          : v.kind;
    if (!byKind[groupKey]) byKind[groupKey] = [];
    byKind[groupKey].push(v);
  }

  const merged: Schema[] = [];
  for (const group of Object.values(byKind)) {
    let acc = group[0];
    for (let i = 1; i < group.length; i++) {
      acc = mergeSchemas(acc, group[i], depth + 1);
    }
    merged.push(acc);
  }

  return merged.length === 1 ? merged[0] : { kind: "union", variants: merged };
}

// ─────────────────────────────────────────────────────────────────────────────
// Predicate helpers shared with the comparator.
// ─────────────────────────────────────────────────────────────────────────────

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
