// ─────────────────────────────────────────────────────────────────────────────
// TEMPORARY — TS-MORPH WALKER SPIKE
//
// Day-1 spike for Phase 1 of the type-coverage audit (PR #5). Confirms that
// ts-morph can walk LogEntry from the real src/types/ and emit the same
// Schema ADT shape that scripts/prototype-schema-coverage.mjs validated.
//
// >>> REMOVE THIS FILE WHEN PHASE 1 LANDS at scripts/audit/type-coverage.ts <<<
// ─────────────────────────────────────────────────────────────────────────────
//
// Run:  node scripts/prototype-ts-walker.mjs
//
// Outputs:
//  - per-variant summary to stdout (variant name, prop count, openExtras flag)
//  - assertions for known-tricky cases (Partial<X>, [key:string]:unknown, etc.)
//  - full Schema written to /tmp/log-entry-schema.json for inspection
//
// What this validates:
//   1. ts-morph resolves TypeReference (UsageMetadata, ContentBlock, etc.)
//   2. extends ConversationalBase pulls inherited props
//   3. Partial<ConversationalBase> on ProgressEntry resolves with all-optional
//   4. [key: string]: unknown on QueuedCommandPayload + UnknownEntry → openExtras=true
//   5. Discriminator detection picks "type" field automatically
//   6. UnknownEntry's non-literal `type: string` excludes it from the discUnion
//      (which is the correct behavior — observed entries with unmodeled `type`
//       values become coverage gaps instead of silently matching UnknownEntry)

import { Project, ts } from "ts-morph";
import { writeFileSync } from "node:fs";

const project = new Project({ tsConfigFilePath: "tsconfig.json" });
const entriesFile = project.getSourceFileOrThrow("src/types/entries.ts");
const logEntryAlias = entriesFile.getTypeAliasOrThrow("LogEntry");
const logEntryType = logEntryAlias.getType();

const checker = project.getTypeChecker().compilerObject;

// ─────────────────────────────────────────────────────────────────────────────
// Schema ADT walker
// ─────────────────────────────────────────────────────────────────────────────

const PRIM_FLAGS = {
  string: ts.TypeFlags.String | ts.TypeFlags.StringLiteral,
  number: ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral,
  boolean: ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral,
  null: ts.TypeFlags.Null,
  undefined: ts.TypeFlags.Undefined | ts.TypeFlags.Void,
};

function isPrimitiveOnly(t) {
  // string | number | boolean | null | literal of those — no objects/arrays
  return t.isString() || t.isNumber() || t.isBoolean() ||
         t.isLiteral() || t.isNull() || t.isUndefined();
}

function walkType(type, ctx = { depth: 0, declarationNode: undefined }) {
  if (ctx.depth > 12) return { kind: "opaque", reason: "max-depth" };
  const next = (sub, opts = {}) => walkType(sub, { ...ctx, depth: ctx.depth + 1, ...opts });

  // unknown / any → opaque (per spec policy)
  if (type.isUnknown()) return { kind: "opaque", reason: "declared as unknown" };
  if (type.isAny()) return { kind: "opaque", reason: "declared as any" };

  // Literal types
  if (type.isStringLiteral() || type.isNumberLiteral() || type.isBooleanLiteral()) {
    return { kind: "literal", value: type.getLiteralValue() };
  }

  // Null / undefined / never as primitives
  if (type.isNull()) return { kind: "prim", types: ["null"] };
  if (type.isUndefined()) return { kind: "prim", types: ["null"] }; // collapse for prototype
  if (type.isNever()) return { kind: "opaque", reason: "never" };

  // Plain primitives
  if (type.isString()) return { kind: "prim", types: ["string"] };
  if (type.isNumber()) return { kind: "prim", types: ["number"] };
  if (type.isBoolean()) return { kind: "prim", types: ["boolean"] };

  // Arrays
  if (type.isArray()) {
    const el = type.getArrayElementTypeOrThrow();
    return { kind: "array", element: next(el) };
  }
  if (type.isTuple()) {
    return { kind: "opaque", reason: "tuple — needs explicit handling" };
  }

  // Unions
  if (type.isUnion()) {
    const variants = type.getUnionTypes();

    // Pure primitive union → collapse to prim with multiple types
    if (variants.every(isPrimitiveOnly)) {
      const types = new Set();
      for (const v of variants) {
        if (v.isString() || v.isStringLiteral()) types.add("string");
        else if (v.isNumber() || v.isNumberLiteral()) types.add("number");
        else if (v.isBoolean() || v.isBooleanLiteral()) types.add("boolean");
        else if (v.isNull() || v.isUndefined()) types.add("null");
      }
      return { kind: "prim", types: [...types].sort() };
    }

    // Discriminator detection: a field that has a string literal on most variants.
    // Variants without a literal at that field are excluded from the typed set
    // (per spec: UnknownEntry-style fallbacks must not silently match observed entries).
    const disc = detectDiscriminator(variants);
    if (disc) {
      const variantsMap = {};
      const excluded = [];
      for (const v of variants) {
        const prop = v.getProperty(disc.field);
        const decl = prop?.getValueDeclaration() ?? prop?.getDeclarations()[0];
        const propType = decl ? prop.getTypeAtLocation(decl) : null;
        if (propType?.isStringLiteral()) {
          variantsMap[propType.getLiteralValueOrThrow()] = next(v);
        } else {
          excluded.push(v.getSymbol()?.getName() ?? v.getText());
        }
      }
      return { kind: "discUnion", discriminator: disc.field, variants: variantsMap, _excluded: excluded };
    }

    // Untagged union
    return { kind: "union", variants: variants.map(v => next(v)) };
  }

  // Intersection (e.g. Partial<X> sometimes shows as intersection)
  if (type.isIntersection()) {
    // Merge object members from each part
    const merged = mergeIntersection(type, next);
    if (merged) return merged;
    return { kind: "opaque", reason: "unhandled intersection" };
  }

  // Object types
  if (type.isObject()) {
    const props = {};
    for (const sym of type.getProperties()) {
      const name = sym.getName();
      const decl = sym.getValueDeclaration() ?? sym.getDeclarations()[0];
      if (!decl) continue;
      const propType = sym.getTypeAtLocation(decl);
      const isOptional = (sym.getFlags() & ts.SymbolFlags.Optional) !== 0;
      props[name] = { schema: next(propType), required: !isOptional };
    }

    // Index signature → openExtras
    let openExtras = false;
    let recordValue = null;
    const stringIdx = type.getStringIndexType();
    if (stringIdx) {
      if (stringIdx.isUnknown() || stringIdx.isAny()) {
        openExtras = true;
      } else if (Object.keys(props).length === 0) {
        // Pure Record<string, T> — no named properties, just the index
        recordValue = next(stringIdx);
      } else {
        // Named props plus a typed index — treat the index as openExtras for now
        // (could be Record-like; for prototype we widen rather than fail)
        openExtras = true;
      }
    }

    if (recordValue) return { kind: "record", value: recordValue };
    return { kind: "object", props, openExtras };
  }

  return { kind: "opaque", reason: `unhandled ts type: ${type.getText()}` };
}

function detectDiscriminator(variants) {
  // Score each candidate field name by how many variants have a UNIQUE string
  // literal at that field. Pick the highest-scoring field. Variants without a
  // literal at that field are tolerated (and excluded from the discUnion at
  // the call site) — matches the spec's UnknownEntry-fallback policy.
  const allNames = new Set();
  for (const v of variants) for (const p of v.getProperties()) allNames.add(p.getName());

  let best = null;
  for (const name of allNames) {
    const literals = [];
    for (const v of variants) {
      const prop = v.getProperty(name);
      const decl = prop?.getValueDeclaration() ?? prop?.getDeclarations()[0];
      if (!decl) continue;
      const propType = prop.getTypeAtLocation(decl);
      if (propType.isStringLiteral()) literals.push(propType.getLiteralValueOrThrow());
    }
    // Need at least 2 variants with literals AND all literals unique
    if (literals.length < 2) continue;
    if (new Set(literals).size !== literals.length) continue;

    const score = literals.length;
    if (!best || score > best.score || (score === best.score && name === "type")) {
      best = { field: name, score };
    }
  }
  return best ? { field: best.field } : null;
}

function mergeIntersection(intersectionType, walkRec) {
  const allProps = {};
  let openExtras = false;
  for (const part of intersectionType.getIntersectionTypes()) {
    const partSchema = walkRec(part);
    if (partSchema.kind === "object") {
      Object.assign(allProps, partSchema.props);
      if (partSchema.openExtras) openExtras = true;
    } else {
      return null; // not all parts are objects → bail
    }
  }
  return { kind: "object", props: allProps, openExtras };
}

// ─────────────────────────────────────────────────────────────────────────────
// Run + assertions
// ─────────────────────────────────────────────────────────────────────────────

const schema = walkType(logEntryType);
writeFileSync("/tmp/log-entry-schema.json", JSON.stringify(schema, null, 2));

console.log("\n=== Top-level shape ===");
console.log(`kind: ${schema.kind}`);
if (schema.kind === "discUnion") {
  console.log(`discriminator: ${schema.discriminator}`);
  console.log(`variants (${Object.keys(schema.variants).length}):`);
  for (const [name, v] of Object.entries(schema.variants)) {
    const propCount = v.kind === "object" ? Object.keys(v.props).length : "?";
    const openExtras = v.kind === "object" && v.openExtras ? " [openExtras]" : "";
    console.log(`  ${name.padEnd(28)} props=${propCount}${openExtras}`);
  }
}

// Assertions
const checks = [];
function check(name, cond, detail = "") {
  checks.push({ name, ok: !!cond, detail });
}

check("top-level is discUnion on `type`",
  schema.kind === "discUnion" && schema.discriminator === "type");
check("has `user` variant",
  schema.kind === "discUnion" && "user" in schema.variants);
check("has `assistant` variant",
  schema.kind === "discUnion" && "assistant" in schema.variants);
check("has `permission-mode` variant",
  schema.kind === "discUnion" && "permission-mode" in schema.variants);
check("has `worktree-state` variant",
  schema.kind === "discUnion" && "worktree-state" in schema.variants);
check("UnknownEntry excluded (no string-literal `type`)",
  schema.kind === "discUnion" &&
  !Object.values(schema.variants).some(v =>
    v.kind === "object" && v.props.type?.schema?.kind === "prim"));

const assistantVariant = schema.kind === "discUnion" ? schema.variants.assistant : null;
check("assistant inherits ConversationalBase props (uuid, sessionId, timestamp)",
  assistantVariant?.kind === "object" &&
  assistantVariant.props.uuid?.required === true &&
  assistantVariant.props.sessionId?.required === true &&
  assistantVariant.props.timestamp?.required === true);

check("assistant.message.usage is an object with input_tokens (typed via UsageMetadata reference)",
  assistantVariant?.props?.message?.schema?.kind === "object" &&
  assistantVariant.props.message.schema.props.usage?.schema?.kind === "object" &&
  assistantVariant.props.message.schema.props.usage.schema.props.input_tokens?.schema?.kind === "prim");

const progressVariant = schema.kind === "discUnion" ? schema.variants.progress : null;
check("ProgressEntry resolves (extends Partial<ConversationalBase>)",
  progressVariant?.kind === "object");
check("ProgressEntry's inherited fields are all optional (Partial<>)",
  progressVariant?.kind === "object" &&
  progressVariant.props.uuid?.required === false &&
  progressVariant.props.sessionId?.required === false);

// QueuedCommandPayload is inside attachment.attachment, not at top level — fish for it
const attachmentVariant = schema.kind === "discUnion" ? schema.variants.attachment : null;
const attachmentPayload = attachmentVariant?.props?.attachment?.schema;
let queuedCmd = null;
if (attachmentPayload?.kind === "discUnion") {
  queuedCmd = attachmentPayload.variants?.queued_command;
}
check("AttachmentPayload is a discUnion under entry[attachment].attachment",
  attachmentPayload?.kind === "discUnion");
check("QueuedCommandPayload has openExtras=true ([key: string]: unknown)",
  queuedCmd?.kind === "object" && queuedCmd.openExtras === true);

const userVariant = schema.kind === "discUnion" ? schema.variants.user : null;
check("user.message.content is union of string and array<ContentBlock>",
  userVariant?.props?.message?.schema?.kind === "object" &&
  ["union", "prim"].includes(userVariant.props.message.schema.props.content?.schema?.kind));

console.log("\n=== Assertions ===");
let pass = 0, fail = 0;
for (const c of checks) {
  console.log(`  [${c.ok ? "PASS" : "FAIL"}] ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  if (c.ok) pass++; else fail++;
}
console.log(`\n${pass}/${pass + fail} assertions passed`);
console.log(`Full schema written to /tmp/log-entry-schema.json (${Object.keys(schema.variants ?? {}).length} variants)`);

if (fail > 0) process.exit(1);
