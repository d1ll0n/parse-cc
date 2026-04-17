// ─────────────────────────────────────────────────────────────────────────────
// TEMPORARY — CODEGEN RESOLVER SPIKE
//
// Day-1 spike for Phase 2 (codegen). Validates that ts-morph can resolve a
// gap path like `$[assistant].message.usage.cache_creation_input_tokens` back
// to the source declaration that would need to be modified to add the field.
//
// The hardest part of codegen is "given an audit gap path, find the target
// interface declaration". Once that works, patch synthesis (add property,
// widen union, etc.) is mechanical ts-morph manipulation.
//
// >>> DELETE WHEN PHASE 2 LANDS at scripts/audit/type-coverage/codegen.ts <<<
// ─────────────────────────────────────────────────────────────────────────────
//
// Run: node --experimental-strip-types scripts/prototype-codegen-resolver.mjs
//
// What this validates:
//   1. Walk gap.path through the typed schema via ts-morph alongside our
//      Schema-walker logic, tracking the most-recently-resolved interface.
//   2. For TypeReferences, follow the symbol to the declaration so the
//      target is the REFERENCED interface, not an inline anchor.
//   3. For inline TypeLiterals, the target is the enclosing named interface.

import { Project, Node, SyntaxKind } from "ts-morph";

const project = new Project({ tsConfigFilePath: "tsconfig.json" });
const entriesFile = project.getSourceFileOrThrow("src/types/entries.ts");
const logEntryAlias = entriesFile.getTypeAliasOrThrow("LogEntry");

// Parse a gap path into segments.
//   $[user].message.content[][text].text
//   →  [{kind:"discBucket",value:"user"}, {kind:"prop",name:"message"},
//       {kind:"prop",name:"content"}, {kind:"arrayElem"},
//       {kind:"discBucket",value:"text"}, {kind:"prop",name:"text"}]
function parsePath(path) {
  if (!path.startsWith("$")) throw new Error(`path must start with $: ${path}`);
  const segs = [];
  let i = 1;
  while (i < path.length) {
    const ch = path[i];
    if (ch === ".") {
      // Property name follows
      i++;
      let name = "";
      while (i < path.length && /[A-Za-z0-9_-]/.test(path[i])) {
        name += path[i++];
      }
      segs.push({ kind: "prop", name });
    } else if (ch === "[") {
      const close = path.indexOf("]", i);
      const inner = path.slice(i + 1, close);
      if (inner === "") segs.push({ kind: "arrayElem" });
      else segs.push({ kind: "discBucket", value: inner });
      i = close + 1;
    } else if (ch === "{") {
      const close = path.indexOf("}", i);
      segs.push({ kind: "recordKey", value: path.slice(i + 1, close) });
      i = close + 1;
    } else {
      throw new Error(`unexpected char at index ${i} in path: ${path}`);
    }
  }
  return segs;
}

/**
 * Walk a gap path through the typed schema and return the resolved target.
 *
 * Returns:
 *   { mode: "addPropToInterface", interfaceDecl, propName }
 *     When the path's terminal segment is a property the immediate parent
 *     interface doesn't yet declare. Codegen would add the property here.
 *
 *   { mode: "addVariantToUnion", unionDeclOrAlias, discriminator, variantName }
 *     When the terminal segment is a discBucket the typed union doesn't
 *     have a variant for. Codegen would synthesize a new variant.
 *
 *   { mode: "widenInlineUnion", typeNode } / { mode: "widenAlias", aliasDecl }
 *     For widen-prim cases.
 *
 * Returns null when the gap can't be resolved (e.g., path runs into opaque).
 */
function resolveGapTarget(gapPath) {
  const segs = parsePath(gapPath);
  let currentType = logEntryAlias.getType();
  // Track the most-recent named interface we've descended through. This is
  // the natural "target" for a missing-field add when we land on a property
  // segment that doesn't exist yet.
  let lastInterfaceDecl = null;

  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const isLast = i === segs.length - 1;

    if (seg.kind === "discBucket") {
      // currentType should be a union; pick the variant whose discriminator
      // string-literal matches seg.value.
      if (!currentType.isUnion()) {
        return { mode: "fail", reason: `expected union at discBucket ${seg.value}, got ${currentType.getText()}` };
      }
      const variants = currentType.getUnionTypes();
      const matchedVariant = variants.find((v) => {
        const typeProp = v.getProperty("type");
        if (!typeProp) return false;
        const decl = typeProp.getValueDeclaration();
        if (!decl) return false;
        const propType = typeProp.getTypeAtLocation(decl);
        return propType.isStringLiteral() && propType.getLiteralValueOrThrow() === seg.value;
      });
      if (!matchedVariant) {
        // Brand-new variant — codegen should add to the union. Find the
        // union's declaring alias (LogEntry, AttachmentPayload, etc.).
        const unionAlias = currentType.getAliasSymbol()?.getDeclarations()[0];
        return {
          mode: "addVariantToUnion",
          unionAliasName: currentType.getAliasSymbol()?.getName() ?? "<unknown>",
          unionDecl: unionAlias?.getKindName(),
          unionDeclFile: unionAlias?.getSourceFile().getFilePath(),
          discriminatorValue: seg.value,
        };
      }
      currentType = matchedVariant;
      const matchedSym = matchedVariant.getSymbol();
      const matchedDecl = matchedSym?.getDeclarations()[0];
      if (matchedDecl?.getKind() === SyntaxKind.InterfaceDeclaration) {
        lastInterfaceDecl = matchedDecl;
      }
    } else if (seg.kind === "prop") {
      const prop = currentType.getProperty(seg.name);
      if (!prop) {
        // This is the missing-field case (when isLast). Add to the
        // last-named interface we descended through.
        if (isLast && lastInterfaceDecl) {
          return {
            mode: "addPropToInterface",
            interfaceName: lastInterfaceDecl.getName?.() ?? "<unknown>",
            interfaceFile: lastInterfaceDecl.getSourceFile().getFilePath(),
            propName: seg.name,
          };
        }
        return { mode: "fail", reason: `property ${seg.name} not found at segment ${i}` };
      }
      const decl = prop.getValueDeclaration();
      if (!decl) return { mode: "fail", reason: `no value-declaration for ${seg.name}` };
      currentType = prop.getTypeAtLocation(decl);

      // If the property's type resolved to a referenced interface, update
      // lastInterfaceDecl so subsequent missing-field gaps target THAT
      // interface, not the enclosing one.
      const sym = currentType.getSymbol() ?? currentType.getAliasSymbol();
      const resolvedDecl = sym?.getDeclarations()[0];
      if (resolvedDecl?.getKind() === SyntaxKind.InterfaceDeclaration) {
        lastInterfaceDecl = resolvedDecl;
      }
    } else if (seg.kind === "arrayElem") {
      const elemType = currentType.getArrayElementType();
      if (!elemType) return { mode: "fail", reason: `expected array at segment ${i}` };
      currentType = elemType;
    } else if (seg.kind === "recordKey") {
      const stringIdx = currentType.getStringIndexType();
      if (!stringIdx) return { mode: "fail", reason: `expected record at segment ${i}` };
      currentType = stringIdx;
    }
  }

  return { mode: "fail", reason: "path consumed but no terminal action determined" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test cases
// ─────────────────────────────────────────────────────────────────────────────

const cases = [
  {
    label: "Case B: add a synthetic new field to UsageMetadata (via TypeReference)",
    path: "$[assistant].message.usage.synthetic_new_field",
    expectMode: "addPropToInterface",
    expectInterface: "UsageMetadata", // <-- proves we follow `usage: UsageMetadata` reference
  },
  {
    label: "Case B: add `entrypoint` to UserEntry (or its base)",
    path: "$[user].entrypoint",
    expectMode: "addPropToInterface",
    expectInterface: "UserEntry",
  },
  {
    label: "Case A: brand-new attachment subtype `task_reminder`",
    path: "$[attachment].attachment[task_reminder]",
    expectMode: "addVariantToUnion",
    expectUnionAlias: "AttachmentPayload",
  },
  {
    label: "Case A: brand-new top-level entry type `worktree-cleanup` (synthetic)",
    path: "$[worktree-cleanup]",
    expectMode: "addVariantToUnion",
    expectUnionAlias: "LogEntry",
  },
  {
    label: "Case B: nested ContentBlock — add field to ToolUseBlock",
    path: "$[assistant].message.content[][tool_use].caller",
    expectMode: "addPropToInterface",
    expectInterface: "ToolUseBlock",
  },
];

let pass = 0;
let fail = 0;
for (const c of cases) {
  const result = resolveGapTarget(c.path);
  let ok = result.mode === c.expectMode;
  if (ok && c.expectInterface) ok = result.interfaceName === c.expectInterface;
  if (ok && c.expectUnionAlias) ok = result.unionAliasName === c.expectUnionAlias;
  console.log(`\n[${ok ? "PASS" : "FAIL"}] ${c.label}`);
  console.log(`  path:     ${c.path}`);
  console.log(`  expected: ${JSON.stringify({ mode: c.expectMode, interface: c.expectInterface, unionAlias: c.expectUnionAlias })}`);
  console.log(`  actual:   ${JSON.stringify(result, null, 2).split("\n").join("\n            ")}`);
  if (ok) pass++; else fail++;
}

console.log(`\n${pass}/${pass + fail} resolutions matched expected.`);
if (fail > 0) process.exit(1);
