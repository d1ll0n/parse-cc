/**
 * Walks the TypeScript types in `src/types/` via ts-morph and emits a
 * `Schema` rooted at `LogEntry`. The result is the **typed set** for the
 * type-coverage audit: every path the type system explicitly models.
 *
 * Compared to the prototype at `scripts/prototype-ts-walker.mjs`, this
 * production version:
 *  - Lives in TypeScript with full types.
 *  - Returns a `WalkResult` that includes excluded variants (for `--verbose`
 *    listing — surfaces typo bugs like `interface FrobEntry { type: string }`
 *    where the maintainer meant a literal).
 *  - Has a deterministic project setup helper.
 *
 * See `docs/local-plans/plans/2026-04-17-type-coverage-audit.md` for the
 * design rationale.
 */
import { Project, ts } from "ts-morph";
import type { Type } from "ts-morph";
import type { Schema, PrimKind } from "./schema.ts";

/**
 * Result of walking a top-level union (typically `LogEntry`).
 *
 * `schema` is the derived `Schema`; for `LogEntry` this is a `discUnion`.
 *
 * `exclusions` lists variants that were dropped from the typed set during
 * discriminator detection — variants without a string-literal at the
 * discriminator field. `UnknownEntry` is the canonical case (catch-all
 * fallback by design); a typo'd new variant (`type: string` instead of a
 * literal) would also appear here. Surfaced in `--verbose` audit output.
 */
export interface WalkResult {
  schema: Schema;
  exclusions: Array<{ variantName: string; sourceFile: string; reason: string }>;
}

/** Construct a ts-morph Project pointed at the local tsconfig. */
export function createProject(tsConfigFilePath = "tsconfig.json"): Project {
  return new Project({ tsConfigFilePath });
}

/**
 * Walk the `LogEntry` type alias from `src/types/entries.ts` and return the
 * derived `Schema`. The most common entry point.
 */
export function walkLogEntry(project: Project): WalkResult {
  const sourceFile = project.getSourceFileOrThrow("src/types/entries.ts");
  const alias = sourceFile.getTypeAliasOrThrow("LogEntry");
  const exclusions: WalkResult["exclusions"] = [];
  const ctx: WalkContext = { depth: 0, exclusions };
  const schema = walkType(alias.getType(), ctx);
  return { schema, exclusions };
}

interface WalkContext {
  depth: number;
  exclusions: WalkResult["exclusions"];
}

const MAX_DEPTH = 12;

function walkType(type: Type, ctx: WalkContext): Schema {
  if (ctx.depth > MAX_DEPTH) return { kind: "opaque", reason: "max-depth" };
  const next = (sub: Type): Schema =>
    walkType(sub, { ...ctx, depth: ctx.depth + 1 });

  if (type.isUnknown()) return { kind: "opaque", reason: "declared as unknown" };
  if (type.isAny()) return { kind: "opaque", reason: "declared as any" };

  if (type.isStringLiteral() || type.isNumberLiteral() || type.isBooleanLiteral()) {
    return { kind: "literal", value: type.getLiteralValueOrThrow() as string | number | boolean };
  }

  if (type.isNull()) return { kind: "prim", types: ["null"] };
  if (type.isUndefined()) return { kind: "prim", types: ["null"] };
  if (type.isNever()) return { kind: "opaque", reason: "never" };

  if (type.isString()) return { kind: "prim", types: ["string"] };
  if (type.isNumber()) return { kind: "prim", types: ["number"] };
  if (type.isBoolean()) return { kind: "prim", types: ["boolean"] };

  if (type.isArray()) {
    return { kind: "array", element: next(type.getArrayElementTypeOrThrow()) };
  }

  if (type.isTuple()) {
    return { kind: "opaque", reason: "tuple — needs explicit handling" };
  }

  if (type.isUnion()) {
    return walkUnion(type, ctx, next);
  }

  if (type.isIntersection()) {
    const merged = mergeIntersection(type, next);
    if (merged) return merged;
    return { kind: "opaque", reason: "unhandled intersection" };
  }

  if (type.isObject()) {
    return walkObject(type, next);
  }

  return { kind: "opaque", reason: `unhandled ts type: ${type.getText()}` };
}

function walkUnion(
  type: Type,
  ctx: WalkContext,
  next: (sub: Type) => Schema
): Schema {
  const variants = type.getUnionTypes();

  // Pure primitive union → collapse to prim with multiple types.
  if (variants.every(isPrimitiveOnly)) {
    const set = new Set<PrimKind>();
    for (const v of variants) {
      if (v.isString() || v.isStringLiteral()) set.add("string");
      else if (v.isNumber() || v.isNumberLiteral()) set.add("number");
      else if (v.isBoolean() || v.isBooleanLiteral()) set.add("boolean");
      else if (v.isNull() || v.isUndefined()) set.add("null");
    }
    return { kind: "prim", types: [...set].sort() };
  }

  const disc = detectDiscriminator(variants);
  if (disc) {
    const variantsMap: Record<string, Schema> = {};
    for (const v of variants) {
      const prop = v.getProperty(disc.field);
      const decl = prop?.getValueDeclaration() ?? prop?.getDeclarations()[0];
      const propType = decl ? prop?.getTypeAtLocation(decl) : undefined;
      if (propType?.isStringLiteral()) {
        const litValue = propType.getLiteralValueOrThrow() as string;
        variantsMap[litValue] = next(v);
      } else {
        const variantName =
          v.getSymbol()?.getName() ?? v.getAliasSymbol()?.getName() ?? v.getText();
        const sourceFile = sourceFileOf(v) ?? "<unknown>";
        ctx.exclusions.push({
          variantName,
          sourceFile,
          reason: `non-literal discriminator at \`${disc.field}\``,
        });
      }
    }
    return { kind: "discUnion", discriminator: disc.field, variants: variantsMap };
  }

  // Untagged union — comparator handles via best-fit-per-sample.
  return { kind: "union", variants: variants.map((v) => next(v)) };
}

function walkObject(type: Type, next: (sub: Type) => Schema): Schema {
  const props: Record<string, { schema: Schema; required: boolean }> = {};
  for (const sym of type.getProperties()) {
    const name = sym.getName();
    const decl = sym.getValueDeclaration() ?? sym.getDeclarations()[0];
    if (!decl) continue;
    const propType = sym.getTypeAtLocation(decl);
    const isOptional = (sym.getFlags() & ts.SymbolFlags.Optional) !== 0;
    props[name] = { schema: next(propType), required: !isOptional };
  }

  let openExtras = false;
  let recordValue: Schema | null = null;
  const stringIdx = type.getStringIndexType();
  if (stringIdx) {
    if (stringIdx.isUnknown() || stringIdx.isAny()) {
      openExtras = true;
    } else if (Object.keys(props).length === 0) {
      recordValue = next(stringIdx);
    } else {
      // Named props plus a typed index — treat as openExtras (rare in practice).
      openExtras = true;
    }
  }

  if (recordValue) return { kind: "record", value: recordValue };
  return { kind: "object", props, openExtras };
}

/**
 * Detect the discriminator field for a union. Tolerant: variants without a
 * string-literal at the chosen field are excluded from the resulting
 * `discUnion` rather than disqualifying the union as a whole. This matches
 * the `UnknownEntry`-exclusion policy in the spec — UnknownEntry's
 * `type: string` (non-literal) drops it from the typed set so observed
 * entries with unmodelled `type` values surface as `unknown-variant` gaps.
 *
 * Returns null when no candidate field has at least 2 unique string literals
 * across variants.
 */
export function detectDiscriminator(variants: Type[]): { field: string } | null {
  const allNames = new Set<string>();
  for (const v of variants) for (const p of v.getProperties()) allNames.add(p.getName());

  let best: { field: string; score: number } | null = null;
  for (const name of allNames) {
    const literals: string[] = [];
    for (const v of variants) {
      const prop = v.getProperty(name);
      if (!prop) continue;
      const decl = prop.getValueDeclaration() ?? prop.getDeclarations()[0];
      if (!decl) continue;
      const propType = prop.getTypeAtLocation(decl);
      if (propType.isStringLiteral()) {
        literals.push(propType.getLiteralValueOrThrow() as string);
      }
    }
    if (literals.length < 2) continue;
    if (new Set(literals).size !== literals.length) continue;

    const score = literals.length;
    if (!best || score > best.score || (score === best.score && name === "type")) {
      best = { field: name, score };
    }
  }
  return best ? { field: best.field } : null;
}

function isPrimitiveOnly(t: Type): boolean {
  return (
    t.isString() ||
    t.isNumber() ||
    t.isBoolean() ||
    t.isLiteral() ||
    t.isNull() ||
    t.isUndefined()
  );
}

function mergeIntersection(
  intersectionType: Type,
  walkRec: (sub: Type) => Schema
): Schema | null {
  const allProps: Record<string, { schema: Schema; required: boolean }> = {};
  let openExtras = false;
  for (const part of intersectionType.getIntersectionTypes()) {
    const partSchema = walkRec(part);
    if (partSchema.kind === "object") {
      Object.assign(allProps, partSchema.props);
      if (partSchema.openExtras) openExtras = true;
    } else {
      return null;
    }
  }
  return { kind: "object", props: allProps, openExtras };
}

function sourceFileOf(type: Type): string | undefined {
  const sym = type.getSymbol() ?? type.getAliasSymbol();
  const decl = sym?.getDeclarations()[0];
  if (!decl) return undefined;
  const sf = decl.getSourceFile();
  // Use repo-relative path when possible
  const full = sf.getFilePath();
  const cwd = process.cwd();
  return full.startsWith(cwd) ? full.slice(cwd.length + 1) : full;
}
