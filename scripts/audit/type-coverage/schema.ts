/**
 * Schema ADT shared by the typed-set walker (derives from `src/types/` via
 * ts-morph) and the observed-set comparator (consumes raw JSONL samples).
 *
 * Both sides emit values of the same shape, and the comparator walks them in
 * parallel. The ADT explicitly handles object-position unions, discriminator-
 * less payloads, and open records — a flat-path inventory cannot represent
 * these symmetrically across the typed/observed boundary.
 *
 * See docs/local-plans/plans/2026-04-17-type-coverage-audit.md (PR #5) for
 * the full design.
 */

/** Primitive-type union recorded at a leaf. `"null"` represents both JSON null and TS undefined. */
export type PrimKind = "string" | "number" | "boolean" | "null";

/**
 * A single node in the structural schema. Discriminated by `kind`.
 *
 * - `prim`        — primitive type union (e.g. `string | number`).
 * - `literal`     — a single literal value (e.g. `"assistant"`).
 * - `array`       — homogeneous array; element type is itself a `Schema`.
 * - `object`      — named-property object. `openExtras: true` means a
 *                   `[key: string]: unknown` index signature is present and
 *                   extra observed properties are absorbed without producing
 *                   gaps. Reserved for designated extensibility points.
 * - `record`      — `Record<string, T>`; dynamic keys, all values share `value`.
 * - `discUnion`   — discriminated union; `discriminator` names the field whose
 *                   string-literal value selects a variant.
 * - `union`       — untagged union; comparator picks the lowest-gap variant
 *                   per sample. Rare in this codebase (zero today).
 * - `opaque`      — allowlisted subtree. Comparator stops; no descendant gaps.
 */
export type Schema =
  | { kind: "prim"; types: PrimKind[] }
  | { kind: "literal"; value: string | number | boolean }
  | { kind: "array"; element: Schema }
  | {
      kind: "object";
      props: Record<string, { schema: Schema; required: boolean }>;
      openExtras: boolean;
    }
  | { kind: "record"; value: Schema }
  | { kind: "discUnion"; discriminator: string; variants: Record<string, Schema> }
  | { kind: "union"; variants: Schema[] }
  | { kind: "opaque"; reason: string };

// ─────────────────────────────────────────────────────────────────────────────
// Constructors — terse helpers for tests and hand-built fixtures.
// ─────────────────────────────────────────────────────────────────────────────

export function prim(...types: PrimKind[]): Schema {
  return { kind: "prim", types: [...new Set(types)].sort() as PrimKind[] };
}

export function literal(value: string | number | boolean): Schema {
  return { kind: "literal", value };
}

export function array(element: Schema): Schema {
  return { kind: "array", element };
}

export function object(
  props: Record<string, Schema | { schema: Schema; required: boolean }>,
  openExtras = false
): Schema {
  const normalized: Record<string, { schema: Schema; required: boolean }> = {};
  for (const [k, v] of Object.entries(props)) {
    if (isPropEntry(v)) normalized[k] = v;
    else normalized[k] = { schema: v, required: true };
  }
  return { kind: "object", props: normalized, openExtras };
}

export function optional(schema: Schema): { schema: Schema; required: boolean } {
  return { schema, required: false };
}

export function record(value: Schema): Schema {
  return { kind: "record", value };
}

export function discUnion(
  discriminator: string,
  variants: Record<string, Schema>
): Schema {
  return { kind: "discUnion", discriminator, variants };
}

export function union(variants: Schema[]): Schema {
  return { kind: "union", variants };
}

export function opaque(reason: string): Schema {
  return { kind: "opaque", reason };
}

function isPropEntry(
  v: Schema | { schema: Schema; required: boolean }
): v is { schema: Schema; required: boolean } {
  return (
    typeof v === "object" &&
    v !== null &&
    "schema" in v &&
    "required" in v &&
    typeof (v as { required: unknown }).required === "boolean"
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Description helpers — used in gap-output formatting.
// ─────────────────────────────────────────────────────────────────────────────

/** Short, single-line summary of a Schema for human-readable gap output. */
export function describe(s: Schema): string {
  switch (s.kind) {
    case "prim":
      return s.types.join("|");
    case "literal":
      return JSON.stringify(s.value);
    case "array":
      return `array<${describe(s.element)}>`;
    case "object": {
      const propsList = Object.keys(s.props).join(",");
      return `object{${propsList}${s.openExtras ? ",..." : ""}}`;
    }
    case "record":
      return `record<${describe(s.value)}>`;
    case "discUnion":
      return `discUnion[${s.discriminator}]{${Object.keys(s.variants).join("|")}}`;
    case "union":
      return `union<${s.variants.map(describe).join(" | ")}>`;
    case "opaque":
      return `opaque(${s.reason})`;
  }
}
