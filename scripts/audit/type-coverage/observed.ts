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
 *   - The corpus loader (Phase 1, next commit) for serialized historical shapes.
 *
 * NOTE: this is a leaf-style inference — does NOT do per-sample routing the
 * way the comparator does. Pre-merging samples through this loses
 * discriminator info. The comparator only ever calls into the merger
 * AFTER routing has happened at object positions. See spec §Comparator
 * semantics for why.
 */
import type { Schema, PrimKind } from "./schema.ts";

/** Infer a Schema from a single raw JSONL value (object/array/primitive/null). */
export function inferLeaf(value: unknown): Schema {
  if (value === null) return { kind: "prim", types: ["null"] };
  if (Array.isArray(value)) {
    let element: Schema | null = null;
    for (const v of value) element = mergeObserved(element, v);
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
        props[k] = { schema: inferLeaf(v), required: true };
      }
      return { kind: "object", props, openExtras: false };
    }
  }
  return { kind: "opaque", reason: `unhandled typeof ${typeof value}` };
}

/** Merge a fresh sample into an existing accumulated schema. Returns the merged result. */
export function mergeObserved(existing: Schema | null, sample: unknown): Schema {
  if (existing === null || existing === undefined) return inferLeaf(sample);
  return mergeSchemas(existing, inferLeaf(sample));
}

/** Structural merge of two schemas. Public for the corpus merge step. */
export function mergeSchemas(a: Schema, b: Schema): Schema {
  if (a.kind === b.kind) {
    switch (a.kind) {
      case "prim": {
        const set = new Set<PrimKind>([...a.types, ...(b as typeof a).types]);
        return { kind: "prim", types: [...set].sort() };
      }
      case "array":
        return {
          kind: "array",
          element: mergeSchemas(a.element, (b as typeof a).element),
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
              schema: mergeSchemas(inA.schema, inB.schema),
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
        return a.value === otherLit.value ? a : { kind: "union", variants: [a, otherLit] };
      }
      case "record":
        return {
          kind: "record",
          value: mergeSchemas(a.value, (b as typeof a).value),
        };
      case "discUnion":
      case "union":
      case "opaque":
        // These don't naturally appear in inferLeaf output; fall through to
        // the safe untagged-union case if they ever do.
        return { kind: "union", variants: [a, b] };
    }
  }
  return { kind: "union", variants: [a, b] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Predicate helpers shared with the comparator.
// ─────────────────────────────────────────────────────────────────────────────

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
