import { describe, it, expect } from "vitest";
import {
  inferLeaf,
  mergeObserved,
  mergeSchemas,
  flattenUnion,
  MAX_DEPTH,
  isPlainObject,
} from "../../../scripts/audit/type-coverage/observed.ts";
import type { Schema } from "../../../scripts/audit/type-coverage/schema.ts";

// ─────────────────────────────────────────────────────────────────────────────
// inferLeaf — basic shape inference from raw JSON values.
// ─────────────────────────────────────────────────────────────────────────────

describe("inferLeaf", () => {
  it("infers primitive types", () => {
    expect(inferLeaf("hi")).toEqual({ kind: "prim", types: ["string"] });
    expect(inferLeaf(42)).toEqual({ kind: "prim", types: ["number"] });
    expect(inferLeaf(true)).toEqual({ kind: "prim", types: ["boolean"] });
    expect(inferLeaf(null)).toEqual({ kind: "prim", types: ["null"] });
  });

  it("infers array shape from elements", () => {
    const s = inferLeaf([1, 2, 3]);
    expect(s).toEqual({
      kind: "array",
      element: { kind: "prim", types: ["number"] },
    });
  });

  it("infers object shape with all properties marked required", () => {
    const s = inferLeaf({ name: "alice", age: 30 });
    expect(s.kind).toBe("object");
    if (s.kind !== "object") return;
    expect(s.props.name?.required).toBe(true);
    expect(s.props.age?.required).toBe(true);
    expect(s.props.name?.schema).toEqual({ kind: "prim", types: ["string"] });
    expect(s.openExtras).toBe(false);
  });

  it("returns opaque({reason: max-depth}) past the depth cap", () => {
    // Build a deeply nested object — depth grows by 1 per level.
    let nest: unknown = "leaf";
    for (let i = 0; i < MAX_DEPTH + 10; i++) nest = { nested: nest };
    const result = inferLeaf(nest);
    // Walk down until we find an opaque marker.
    let cur: Schema = result;
    let foundOpaque = false;
    for (let i = 0; i < MAX_DEPTH + 5; i++) {
      if (cur.kind === "object" && cur.props.nested) {
        cur = cur.props.nested.schema;
        if (cur.kind === "opaque" && cur.reason === "max-depth") {
          foundOpaque = true;
          break;
        }
      } else {
        break;
      }
    }
    expect(foundOpaque).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mergeSchemas — same-kind merges, optional/required widening.
// ─────────────────────────────────────────────────────────────────────────────

describe("mergeSchemas — same-kind merges", () => {
  it("unions primitive type sets", () => {
    const a: Schema = { kind: "prim", types: ["string"] };
    const b: Schema = { kind: "prim", types: ["null"] };
    expect(mergeSchemas(a, b)).toEqual({ kind: "prim", types: ["null", "string"] });
  });

  it("recurses into array elements", () => {
    const a = inferLeaf([1, 2]);
    const b = inferLeaf(["x"]);
    const merged = mergeSchemas(a, b);
    expect(merged.kind).toBe("array");
    if (merged.kind !== "array") return;
    expect(merged.element.kind).toBe("prim");
    if (merged.element.kind !== "prim") return;
    expect(merged.element.types).toEqual(["number", "string"]);
  });

  it("widens object props to optional when one sample lacks them", () => {
    const a = inferLeaf({ x: 1, y: 2 });
    const b = inferLeaf({ x: 1 });
    const merged = mergeSchemas(a, b);
    expect(merged.kind).toBe("object");
    if (merged.kind !== "object") return;
    expect(merged.props.x?.required).toBe(true);
    expect(merged.props.y?.required).toBe(false);
  });

  it("propagates openExtras=true when either side has it", () => {
    const a: Schema = { kind: "object", props: {}, openExtras: false };
    const b: Schema = { kind: "object", props: {}, openExtras: true };
    const merged = mergeSchemas(a, b);
    expect(merged.kind).toBe("object");
    if (merged.kind !== "object") return;
    expect(merged.openExtras).toBe(true);
  });

  it("collapses identical literals into the original literal", () => {
    const a: Schema = { kind: "literal", value: "hi" };
    const b: Schema = { kind: "literal", value: "hi" };
    expect(mergeSchemas(a, b)).toEqual(a);
  });

  it("widens to a union when literals differ", () => {
    const a: Schema = { kind: "literal", value: "hi" };
    const b: Schema = { kind: "literal", value: "bye" };
    const merged = mergeSchemas(a, b);
    expect(merged.kind).toBe("union");
    if (merged.kind !== "union") return;
    expect(merged.variants).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// flattenUnion — the load-bearing correctness fix.
// ─────────────────────────────────────────────────────────────────────────────

describe("flattenUnion — load-bearing correctness", () => {
  it("splices nested unions instead of nesting them", () => {
    const inner: Schema = {
      kind: "union",
      variants: [{ kind: "prim", types: ["string"] }, { kind: "prim", types: ["number"] }],
    };
    const result = flattenUnion([inner, { kind: "prim", types: ["boolean"] }]);
    // All three primitive types should merge into one prim, not stay as a union.
    expect(result.kind).toBe("prim");
    if (result.kind !== "prim") return;
    expect(result.types).toEqual(["boolean", "number", "string"]);
  });

  it("merges same-kind parts together (does not produce a union of two objects)", () => {
    const a: Schema = inferLeaf({ x: 1 });
    const b: Schema = inferLeaf({ y: 2 });
    const result = flattenUnion([a, b]);
    expect(result.kind).toBe("object");
    if (result.kind !== "object") return;
    expect(Object.keys(result.props).sort()).toEqual(["x", "y"]);
    expect(result.props.x?.required).toBe(false);
    expect(result.props.y?.required).toBe(false);
  });

  it("returns the single part directly when only one remains after merging", () => {
    const a: Schema = { kind: "prim", types: ["string"] };
    const result = flattenUnion([a]);
    expect(result).toEqual(a);
  });

  it("produces a real union only across distinct kinds", () => {
    const result = flattenUnion([
      { kind: "prim", types: ["string"] },
      { kind: "object", props: {}, openExtras: false },
    ]);
    expect(result.kind).toBe("union");
    if (result.kind !== "union") return;
    expect(result.variants).toHaveLength(2);
  });

  it("dedupes identical literals into a single variant", () => {
    const result = flattenUnion([
      { kind: "literal", value: "x" },
      { kind: "literal", value: "x" },
      { kind: "literal", value: "y" },
    ]);
    expect(result.kind).toBe("union");
    if (result.kind !== "union") return;
    const literalValues = result.variants
      .filter((v): v is Extract<Schema, { kind: "literal" }> => v.kind === "literal")
      .map((v) => v.value)
      .sort();
    expect(literalValues).toEqual(["x", "y"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stress: deep merge under load (the case that crashed before the fixes).
// ─────────────────────────────────────────────────────────────────────────────

describe("mergeObserved — stress (no stack overflow)", () => {
  it("survives 1000 sequential merges of varying primitive types at one position", () => {
    let acc: Schema | null = null;
    const samples = ["string", 42, true, null, "another", 99, false];
    // 1000 iterations cycling through different primitive types — pre-fix this
    // would build union([union([union([...union([A, B])...]), N-1]), N) and crash.
    for (let i = 0; i < 1000; i++) {
      acc = mergeObserved(acc, samples[i % samples.length]);
    }
    // Should still be a single prim with 4 types; no nested union explosion.
    expect(acc).toBeTruthy();
    expect(acc!.kind).toBe("prim");
    if (acc!.kind !== "prim") return;
    expect(acc!.types.sort()).toEqual(["boolean", "null", "number", "string"]);
  });

  it("survives 500 merges of objects with overlapping but different shapes", () => {
    let acc: Schema | null = null;
    for (let i = 0; i < 500; i++) {
      // Each sample has a different combination of optional fields.
      const sample: Record<string, unknown> = { id: i };
      if (i % 2) sample.even = false;
      if (i % 3 === 0) sample.three = "yes";
      if (i % 5 === 0) sample.five = i;
      acc = mergeObserved(acc, sample);
    }
    expect(acc?.kind).toBe("object");
    if (acc?.kind !== "object") return;
    expect(acc.props.id?.required).toBe(true);
    expect(acc.props.even?.required).toBe(false);
    expect(acc.props.three?.required).toBe(false);
    expect(acc.props.five?.required).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Predicate helpers.
// ─────────────────────────────────────────────────────────────────────────────

describe("isPlainObject", () => {
  it("accepts plain objects", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
  });
  it("rejects arrays, null, primitives", () => {
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject("x")).toBe(false);
    expect(isPlainObject(42)).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
  });
});
