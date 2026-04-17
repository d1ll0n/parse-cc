/**
 * Type-coverage comparator.
 *
 * Walks the typed `Schema` and routes raw observed JSONL samples through it
 * per-sample at every `discUnion` position. Merging only happens at object
 * positions AFTER routing — pre-merging samples would collapse discriminator
 * literals into `prim("string")` and break union routing.
 *
 * Returns a list of `Gap`s describing positions where the observed shape
 * isn't covered by the typed schema.
 *
 * See spec §Comparator semantics for full rationale.
 */
import type { Schema } from "./schema.ts";
import { describe } from "./schema.ts";
import { mergeObserved, isPlainObject } from "./observed.ts";

export type GapKind =
  /** No typed schema at this position; should never occur in normal walks. */
  | "missing-typed"
  /** Typed expects a literal; observed value differs. */
  | "literal-mismatch"
  /** Typed primitive union doesn't cover observed primitive types. */
  | "widen-prim"
  /** Observed property has no typed match (and parent isn't openExtras). */
  | "missing-field"
  /** Typed expects an object but observed is a non-object value. */
  | "kind-mismatch"
  /** Discriminator value present in observed but not in typed variant map. */
  | "unknown-variant"
  /** Discriminator-less observed object; best-fit overlap below threshold. */
  | "no-variant-match"
  /** Discriminator-less observed object met threshold but variant doesn't structurally match. */
  | "ambiguous-fit"
  /** Internal: comparator hit a typed kind it doesn't handle (bug). */
  | "unhandled-typed-kind";

export interface Gap {
  /** Path-style location, e.g. `$[assistant].message.usage.cache_creation_input_tokens`. */
  path: string;
  kind: GapKind;
  detail: string;
}

/**
 * Compare a typed schema against a list of raw observed samples. Returns
 * every coverage gap. Path argument is for recursion; caller should omit it.
 */
export function audit(typed: Schema, samples: unknown[], path = "$"): Gap[] {
  if (!typed) return [{ path, kind: "missing-typed", detail: "no typed schema at this position" }];
  if (typed.kind === "opaque") return [];
  if (samples.length === 0) return [];

  switch (typed.kind) {
    case "literal":
      for (const s of samples) {
        if (s !== typed.value) {
          return [{
            path,
            kind: "literal-mismatch",
            detail: `expected ${JSON.stringify(typed.value)}, observed ${JSON.stringify(s)}`,
          }];
        }
      }
      return [];

    case "prim": {
      const seen = new Set<string>();
      for (const s of samples) {
        if (s === null) seen.add("null");
        else if (s === undefined) seen.add("null");
        else seen.add(typeof s);
      }
      const extras = [...seen].filter((t) => !typed.types.includes(t as never));
      return extras.length
        ? [{ path, kind: "widen-prim", detail: `observed +${extras.join(",")}` }]
        : [];
    }

    case "array": {
      const elements: unknown[] = [];
      for (const s of samples) if (Array.isArray(s)) elements.push(...s);
      return audit(typed.element, elements, `${path}[]`);
    }

    case "record": {
      const gaps: Gap[] = [];
      for (const s of samples) {
        if (!isPlainObject(s)) continue;
        for (const v of Object.values(s)) {
          gaps.push(...audit(typed.value, [v], `${path}{*}`));
        }
      }
      return dedupGaps(gaps);
    }

    case "discUnion":
      return routeDiscUnion(typed, samples, path);

    case "union": {
      // Untagged: try each variant per sample, pick the lowest-gap result.
      const gaps: Gap[] = [];
      for (const s of samples) {
        let best: Gap[] | null = null;
        for (const v of typed.variants) {
          const g = audit(v, [s], path);
          if (best === null || g.length < best.length) best = g;
        }
        gaps.push(...(best ?? []));
      }
      return dedupGaps(gaps);
    }

    case "object":
      return auditObject(typed, samples, path);
  }

  return [{ path, kind: "unhandled-typed-kind", detail: (typed as Schema).kind }];
}

function routeDiscUnion(
  disc: Extract<Schema, { kind: "discUnion" }>,
  samples: unknown[],
  path: string
): Gap[] {
  const gaps: Gap[] = [];
  const byDisc: Record<string, unknown[]> = {};
  const noDisc: unknown[] = [];

  for (const s of samples) {
    if (!isPlainObject(s)) continue;
    const v = s[disc.discriminator];
    if (typeof v === "string") {
      if (!byDisc[v]) byDisc[v] = [];
      byDisc[v].push(s);
    } else {
      noDisc.push(s);
    }
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

function bestFitOne(
  disc: Extract<Schema, { kind: "discUnion" }>,
  sample: unknown,
  path: string
): Gap[] {
  if (!isPlainObject(sample)) return [];
  const observedKeys = new Set(Object.keys(sample));

  let bestName: string | null = null;
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
  if (bestScore < threshold || bestName === null) {
    return [{
      path,
      kind: "no-variant-match",
      detail: `discriminator-less observed object did not structurally match any typed variant. observed properties: ${[...observedKeys].join(", ")}. variants: ${Object.keys(disc.variants).join(", ")}`,
    }];
  }

  // Best-fit met threshold; if recursion produces gaps, those mean the structure
  // doesn't actually match — collapse into one ambiguous-fit gap so callers don't
  // get misleading per-field gaps under [~variantName]. Codegen reads ambiguous-fit
  // as the signal to propose a NEW variant, never to widen the best-fit one.
  const downstream = audit(disc.variants[bestName], [sample], `${path}[~${bestName}]`);
  if (downstream.length === 0) return [];
  const summary = downstream.map((g) => `${g.kind}: ${g.path} (${g.detail})`).join("; ");
  return [{
    path,
    kind: "ambiguous-fit",
    detail: `best-fit variant=${bestName} (score ${bestScore}/${observedKeys.size}); structural mismatches: ${summary}; observed properties: ${[...observedKeys].join(", ")}`,
  }];
}

function auditObject(
  typed: Extract<Schema, { kind: "object" }>,
  samples: unknown[],
  path: string
): Gap[] {
  const objectSamples = samples.filter(isPlainObject);
  if (objectSamples.length === 0) {
    const observedKinds = [
      ...new Set(
        samples.map((s) =>
          s === null ? "null" : Array.isArray(s) ? "array" : typeof s
        )
      ),
    ];
    return [{
      path,
      kind: "kind-mismatch",
      detail: `typed=object observed=${observedKinds.join("|")}`,
    }];
  }

  const gaps: Gap[] = [];
  const allKeys = new Set<string>();
  for (const s of objectSamples) for (const k of Object.keys(s)) allKeys.add(k);

  for (const k of allKeys) {
    const typedProp = typed.props[k];
    if (!typedProp) {
      if (!typed.openExtras) {
        const sampleVals = objectSamples
          .map((s) => s[k])
          .filter((v) => v !== undefined);
        gaps.push({
          path: `${path}.${k}`,
          kind: "missing-field",
          detail: `observed type: ${describe(inferLeafSafe(sampleVals))}`,
        });
      }
      continue;
    }
    const subSamples = objectSamples
      .map((s) => s[k])
      .filter((v) => v !== undefined);
    gaps.push(...audit(typedProp.schema, subSamples, `${path}.${k}`));
  }

  return gaps;
}

function inferLeafSafe(samples: unknown[]): Schema {
  let merged: Schema | null = null;
  for (const s of samples) merged = mergeObserved(merged, s);
  return merged ?? { kind: "opaque", reason: "no samples" };
}

function propsAcross(samples: unknown[]): string[] {
  const all = new Set<string>();
  for (const s of samples) {
    if (isPlainObject(s)) for (const k of Object.keys(s)) all.add(k);
  }
  return [...all];
}

function dedupGaps(gaps: Gap[]): Gap[] {
  const seen = new Set<string>();
  const out: Gap[] = [];
  for (const g of gaps) {
    const key = `${g.path}::${g.kind}::${g.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(g);
  }
  return out;
}
