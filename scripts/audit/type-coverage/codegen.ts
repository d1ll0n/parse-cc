/**
 * Codegen for the type-coverage audit (Phase 2).
 *
 * Reads a `Gap[]` from the comparator + the captured corpus Schema for
 * observed shape detail, and produces TypeScript edits via ts-morph that
 * close the gaps.
 *
 * Two-stage:
 *   1. `synthesizePatches(gaps, corpus, project)` → `Patch[]`
 *      Pure-data: no source mutation. Each Patch describes WHAT to change
 *      and WHERE. Used by `--suggest` for dry-run output.
 *   2. `applyPatches(patches, project)` → applies the edits and saves.
 *      Used by `--write`. Intentional that this is a separate step so
 *      `--suggest` can render diffs without touching disk.
 *
 * Patch coverage in this commit (Case B only):
 *   - `missing-field` → "add property to interface"
 *
 * Other cases (widen-prim, unknown-variant, ambiguous-fit) are stubbed and
 * return null — codegen reports them as "not auto-fixable yet" and the
 * maintainer handles by hand. Subsequent commits add each.
 */
import { Node, SyntaxKind } from "ts-morph";
import type { InterfaceDeclaration, Project, TypeLiteralNode } from "ts-morph";
import type { Schema } from "./schema.ts";
import type { Gap } from "./comparator.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Patch ADT
// ─────────────────────────────────────────────────────────────────────────────

export type Patch =
  | {
      kind: "add-property";
      targetFile: string;
      /** Name of the interface to modify. */
      interfaceName: string;
      /** Property names to drill through within the interface (for inline
       *  TypeLiterals). Empty array = add directly to the interface. */
      pathWithinInterface: string[];
      propName: string;
      /** TypeScript type expression text (e.g., "string", "number | null"). */
      propTypeText: string;
      required: boolean;
      /** The Gap that triggered this patch — used for --suggest context. */
      sourceGap: Gap;
    }
  | {
      kind: "widen-prim";
      targetFile: string;
      interfaceName: string;
      pathWithinInterface: string[];
      propName: string;
      /** Full new type expression text (existing union extended with new primitives). */
      newTypeText: string;
      /** Just the added primitives, for human-readable output. */
      addedTypes: string[];
      sourceGap: Gap;
    }
  | {
      kind: "add-variant-to-union";
      targetFile: string;
      /** Synthesized interface name (e.g., "TaskReminderPayload"). */
      newInterfaceName: string;
      /** The union alias to extend (e.g., "AttachmentPayload" or "LogEntry"). */
      unionAliasName: string;
      /** Field that discriminates the union (typically "type"). */
      discriminatorField: string;
      /** Discriminator literal value (e.g., "task_reminder"). */
      discriminatorValue: string;
      /** Per-property entries for the new interface body, excluding the
       *  discriminator field (which is emitted as a literal). */
      members: Array<{ name: string; typeText: string; required: boolean }>;
      sourceGap: Gap;
    };

/** A gap that codegen can't yet auto-fix (other Cases land in later commits). */
export interface UnsupportedGap {
  gap: Gap;
  reason: string;
}

export interface SynthesisResult {
  patches: Patch[];
  unsupported: UnsupportedGap[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Synthesize patches for as many gaps as the current codegen supports.
 *
 * Pure: does not modify the project. Use `applyPatches` to write edits.
 */
export function synthesizePatches(
  gaps: Gap[],
  corpus: Schema | null,
  project: Project
): SynthesisResult {
  const patches: Patch[] = [];
  const unsupported: UnsupportedGap[] = [];

  for (const gap of gaps) {
    const result = synthesizeOne(gap, corpus, project);
    if ("patch" in result) patches.push(result.patch);
    else unsupported.push({ gap, reason: result.reason });
  }

  return { patches, unsupported };
}

/**
 * Apply patches to the project. Saves changed source files. Caller is
 * responsible for running formatter/lint afterwards.
 */
export function applyPatches(patches: Patch[], project: Project): void {
  // Group add-property patches by interface so multiple property-additions to
  // the same interface batch into one declaration walk (avoids anchor drift).
  const addByInterface = new Map<string, Patch[]>();
  const widens: Patch[] = [];
  const newVariants: Patch[] = [];
  for (const p of patches) {
    if (p.kind === "add-property") {
      const key = `${p.targetFile}::${p.interfaceName}::${p.pathWithinInterface.join(".")}`;
      const list = addByInterface.get(key) ?? [];
      list.push(p);
      addByInterface.set(key, list);
    } else if (p.kind === "widen-prim") {
      widens.push(p);
    } else if (p.kind === "add-variant-to-union") {
      newVariants.push(p);
    }
  }

  for (const [, group] of addByInterface) {
    applyAddPropertyGroup(group, project);
  }
  for (const w of widens) {
    applyWidenPrim(w, project);
  }
  for (const v of newVariants) {
    applyAddVariantToUnion(v, project);
  }

  project.saveSync();
}

/** Human-readable summary of a patch for --suggest output. */
export function describePatch(patch: Patch): string {
  if (patch.kind === "add-property") {
    const target =
      patch.pathWithinInterface.length === 0
        ? patch.interfaceName
        : `${patch.interfaceName}.${patch.pathWithinInterface.join(".")}`;
    const opt = patch.required ? "" : "?";
    return `ADD-PROPERTY  ${target}.${patch.propName}${opt}: ${patch.propTypeText}\n              ${shortPath(patch.targetFile)}  (gap: ${patch.sourceGap.path})`;
  }
  if (patch.kind === "widen-prim") {
    const target =
      patch.pathWithinInterface.length === 0
        ? patch.interfaceName
        : `${patch.interfaceName}.${patch.pathWithinInterface.join(".")}`;
    return `WIDEN-PRIM    ${target}.${patch.propName} += ${patch.addedTypes.join(" | ")}\n              new type: ${patch.newTypeText}\n              ${shortPath(patch.targetFile)}  (gap: ${patch.sourceGap.path})`;
  }
  if (patch.kind === "add-variant-to-union") {
    const memberLines = patch.members
      .map((m) => `                ${m.name}${m.required ? "" : "?"}: ${m.typeText};`)
      .join("\n");
    return `NEW-VARIANT   ${patch.newInterfaceName} (${patch.discriminatorField}: "${patch.discriminatorValue}") → ${patch.unionAliasName}\n              ${shortPath(patch.targetFile)}  (gap: ${patch.sourceGap.path})\n              interface body:\n${memberLines}`;
  }
  return `UNKNOWN-PATCH ${JSON.stringify(patch)}`;
}

function shortPath(p: string): string {
  // Trim leading repo path for readability in CLI output.
  const cwd = process.cwd();
  return p.startsWith(cwd) ? p.slice(cwd.length + 1) : p;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-gap synthesis dispatcher
// ─────────────────────────────────────────────────────────────────────────────

type SynthesisOutput = { patch: Patch } | { reason: string };

function synthesizeOne(
  gap: Gap,
  corpus: Schema | null,
  project: Project
): SynthesisOutput {
  switch (gap.kind) {
    case "missing-field":
      return synthesizeMissingField(gap, corpus, project);
    case "widen-prim":
      return synthesizeWidenPrim(gap, project);
    case "unknown-variant":
      return synthesizeUnknownVariant(gap, corpus, project);
    case "ambiguous-fit":
      return { reason: "ambiguous-fit requires manual review (no auto-fix by design)" };
    case "no-variant-match":
      return { reason: "no-variant-match requires manual review (no auto-fix by design)" };
    case "literal-mismatch":
    case "kind-mismatch":
    case "missing-typed":
    case "unhandled-typed-kind":
      return { reason: `${gap.kind} not auto-fixable` };
    default:
      return { reason: `unknown gap kind: ${(gap as Gap).kind}` };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Case B: missing-field → add-property
// ─────────────────────────────────────────────────────────────────────────────

function synthesizeMissingField(
  gap: Gap,
  corpus: Schema | null,
  project: Project
): SynthesisOutput {
  const target = resolveTarget(gap.path, project);
  if (target.mode !== "addPropToInterface") {
    return { reason: `resolver returned ${target.mode}: ${target.reason ?? ""}` };
  }

  // Find the observed shape for this property in the corpus, derive a
  // TypeScript type expression and required-ness.
  const observed = corpus ? lookupCorpusAtPath(corpus, gap.path) : null;
  const propTypeText = observed ? schemaToTsType(observed) : inferTypeFromDetail(gap.detail);
  const required = observed
    ? lookupCorpusRequired(corpus, gap.path)
    : false; // default to optional when unsure

  return {
    patch: {
      kind: "add-property",
      targetFile: target.interfaceFile,
      interfaceName: target.interfaceName,
      pathWithinInterface: target.pathWithinInterface,
      propName: target.propName,
      propTypeText,
      required,
      sourceGap: gap,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Case C: widen-prim → widen the existing type expression
// ─────────────────────────────────────────────────────────────────────────────

/** Parse "observed +null" or "observed +null,object" from gap.detail. */
function parseWidenExtras(detail: string): string[] {
  const m = detail.match(/observed \+([\w,]+)/);
  if (!m) return [];
  return m[1].split(",").filter(Boolean);
}

const PRIM_TYPES = new Set(["string", "number", "boolean", "null"]);

function synthesizeWidenPrim(gap: Gap, project: Project): SynthesisOutput {
  const target = resolveTarget(gap.path, project);
  if (target.mode !== "existingProperty") {
    return { reason: `widen-prim resolver returned ${target.mode}: ${target.reason ?? ""}` };
  }

  const extras = parseWidenExtras(gap.detail);
  if (extras.length === 0) {
    return { reason: `could not parse extras from gap.detail: ${gap.detail}` };
  }

  // Codegen only handles primitive widening. "object" / "array" extras
  // really mean "this is structurally a different shape" — those need
  // a new variant or a manual decision, not a primitive widening.
  const nonPrim = extras.filter((t) => !PRIM_TYPES.has(t));
  if (nonPrim.length > 0) {
    return {
      reason: `widen-prim with non-primitive extras (${nonPrim.join(", ")}) needs manual handling — likely a missing variant`,
    };
  }

  // Find the existing TypeNode and compute the new union text.
  const sourceFile = project.getSourceFile(target.interfaceFile);
  if (!sourceFile) return { reason: `cannot find source file: ${target.interfaceFile}` };
  const iface = sourceFile.getInterface(target.interfaceName);
  if (!iface) return { reason: `cannot find interface: ${target.interfaceName}` };

  const literalNode = drillToTypeLiteral(iface, target.pathWithinInterface);
  if (!literalNode) {
    return {
      reason: `cannot drill to inline path ${target.pathWithinInterface.join(".")} in ${target.interfaceName}`,
    };
  }

  const prop = literalNode.getProperty(target.propName);
  if (!prop) return { reason: `property ${target.propName} disappeared mid-resolve` };
  const typeNode = prop.getTypeNode();
  if (!typeNode) return { reason: `property ${target.propName} has no TypeNode` };

  const existingText = typeNode.getText();
  const newTypeText = `${existingText} | ${extras.join(" | ")}`;

  return {
    patch: {
      kind: "widen-prim",
      targetFile: target.interfaceFile,
      interfaceName: target.interfaceName,
      pathWithinInterface: target.pathWithinInterface,
      propName: target.propName,
      newTypeText,
      addedTypes: extras,
      sourceGap: gap,
    },
  };
}

function applyWidenPrim(patch: Patch, project: Project): void {
  if (patch.kind !== "widen-prim") return;
  const sourceFile = project.getSourceFile(patch.targetFile);
  if (!sourceFile) throw new Error(`cannot find source file: ${patch.targetFile}`);
  const iface = sourceFile.getInterfaceOrThrow(patch.interfaceName);
  const target = drillToTypeLiteral(iface, patch.pathWithinInterface);
  if (!target) throw new Error(`cannot drill to ${patch.pathWithinInterface.join(".")} in ${patch.interfaceName}`);
  const prop = target.getPropertyOrThrow(patch.propName);
  prop.setType(patch.newTypeText);
}

// ─────────────────────────────────────────────────────────────────────────────
// Case A: unknown-variant → synthesize new interface + extend union
// ─────────────────────────────────────────────────────────────────────────────

const KNOWN_UNION_SUFFIXES = ["Entry", "Payload", "Block", "Data"];

/**
 * Convert a discriminator value (e.g., "task_reminder", "worktree-state",
 * "user") to a PascalCase interface name with the union's conventional
 * suffix appended (e.g., "TaskReminderPayload", "WorktreeStateEntry").
 */
export function synthesizeVariantName(unionAliasName: string, discriminatorValue: string): string {
  // Find the suffix from the union's name (Entry / Payload / Block / Data).
  const suffix =
    KNOWN_UNION_SUFFIXES.find((s) => unionAliasName.endsWith(s)) ?? "";
  // PascalCase the discriminator: split on _ or - and capitalize.
  const pascal = discriminatorValue
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");
  return pascal + suffix;
}

function synthesizeUnknownVariant(
  gap: Gap,
  corpus: Schema | null,
  project: Project
): SynthesisOutput {
  const target = resolveTarget(gap.path, project);
  if (target.mode !== "addVariantToUnion") {
    return { reason: `unknown-variant resolver returned ${target.mode}: ${target.reason ?? ""}` };
  }

  if (!corpus) {
    return { reason: "no corpus available — cannot synthesize variant body without observed shape" };
  }
  const observedShape = lookupCorpusAtPath(corpus, gap.path);
  if (!observedShape) {
    return { reason: "no observed shape in corpus at gap path" };
  }
  if (observedShape.kind !== "object") {
    return {
      reason: `observed shape at gap path is ${observedShape.kind}, expected object — likely a primitive variant; manual handling`,
    };
  }

  const newInterfaceName = synthesizeVariantName(target.unionAliasName, target.discriminatorValue);

  // Build per-property members for the new interface. Skip the discriminator
  // field (we'll emit it separately as a literal). Also skip openExtras —
  // synthesizing `[key: string]: unknown` would mostly defeat the audit's
  // purpose; if needed, the maintainer can add it during review.
  const members: Array<{ name: string; typeText: string; required: boolean }> = [];
  for (const [name, { schema, required }] of Object.entries(observedShape.props)) {
    if (name === "type") continue; // discriminator emitted separately
    members.push({ name, typeText: schemaToTsType(schema), required });
  }

  return {
    patch: {
      kind: "add-variant-to-union",
      targetFile: target.unionDeclFile,
      newInterfaceName,
      unionAliasName: target.unionAliasName,
      discriminatorField: "type", // assumed; could derive from typed schema
      discriminatorValue: target.discriminatorValue,
      members,
      sourceGap: gap,
    },
  };
}

function applyAddVariantToUnion(patch: Patch, project: Project): void {
  if (patch.kind !== "add-variant-to-union") return;
  const sourceFile = project.getSourceFile(patch.targetFile);
  if (!sourceFile) throw new Error(`cannot find source file: ${patch.targetFile}`);

  // Don't double-add if a previous run already created this interface.
  if (!sourceFile.getInterface(patch.newInterfaceName)) {
    sourceFile.addInterface({
      name: patch.newInterfaceName,
      isExported: true,
      properties: [
        {
          name: patch.discriminatorField,
          type: JSON.stringify(patch.discriminatorValue),
        },
        ...patch.members.map((m) => ({
          name: m.name,
          type: m.typeText,
          hasQuestionToken: !m.required,
        })),
      ],
    });
  }

  // Extend the union alias by appending the new interface name.
  const aliasDecl = sourceFile.getTypeAlias(patch.unionAliasName);
  if (!aliasDecl) {
    throw new Error(
      `cannot find union alias ${patch.unionAliasName} in ${patch.targetFile}`
    );
  }
  const existing = aliasDecl.getTypeNode()?.getText() ?? "never";
  // Avoid re-adding if a prior run already extended the union.
  if (!new RegExp(`\\b${patch.newInterfaceName}\\b`).test(existing)) {
    aliasDecl.setType(`${existing} | ${patch.newInterfaceName}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Gap-path → declaration resolver (production version of the spike)
// ─────────────────────────────────────────────────────────────────────────────

type PathSeg =
  | { kind: "prop"; name: string }
  | { kind: "discBucket"; value: string }
  | { kind: "arrayElem" }
  | { kind: "recordKey"; value: string };

function parsePath(path: string): PathSeg[] {
  if (!path.startsWith("$")) throw new Error(`path must start with $: ${path}`);
  const segs: PathSeg[] = [];
  let i = 1;
  while (i < path.length) {
    const ch = path[i];
    if (ch === ".") {
      i++;
      let name = "";
      while (i < path.length && /[A-Za-z0-9_-]/.test(path[i])) name += path[i++];
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

type ResolveResult =
  | {
      mode: "addPropToInterface";
      interfaceName: string;
      interfaceFile: string;
      pathWithinInterface: string[];
      propName: string;
    }
  | {
      mode: "addVariantToUnion";
      unionAliasName: string;
      unionDeclFile: string;
      discriminatorValue: string;
    }
  | {
      /** Path landed on an existing property — used by widen-prim to find
       *  the type expression to widen. */
      mode: "existingProperty";
      interfaceName: string;
      interfaceFile: string;
      pathWithinInterface: string[];
      propName: string;
    }
  | { mode: "fail"; reason: string };

function resolveTarget(gapPath: string, project: Project): ResolveResult {
  const sourceFile = project.getSourceFileOrThrow("src/types/entries.ts");
  const logEntryAlias = sourceFile.getTypeAliasOrThrow("LogEntry");
  const segs = parsePath(gapPath);

  let currentType = logEntryAlias.getType();
  let lastInterfaceDecl: InterfaceDeclaration | null = null;
  // Property names walked SINCE the most-recent named interface boundary.
  // For inline TypeLiterals (e.g., AssistantEntry.message), tracks the
  // path within the interface so codegen drills into the right inline
  // literal to add the new property.
  let inlinePath: string[] = [];

  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const isLast = i === segs.length - 1;

    if (seg.kind === "discBucket") {
      if (!currentType.isUnion()) {
        return { mode: "fail", reason: `expected union at discBucket ${seg.value}` };
      }
      const variants = currentType.getUnionTypes();
      const matched = variants.find((v) => {
        const prop = v.getProperty("type");
        const decl = prop?.getValueDeclaration();
        if (!decl) return false;
        const t = prop.getTypeAtLocation(decl);
        return t.isStringLiteral() && t.getLiteralValueOrThrow() === seg.value;
      });
      if (!matched) {
        const aliasSym = currentType.getAliasSymbol();
        const aliasDecl = aliasSym?.getDeclarations()[0];
        return {
          mode: "addVariantToUnion",
          unionAliasName: aliasSym?.getName() ?? "<unknown>",
          unionDeclFile: aliasDecl?.getSourceFile().getFilePath() ?? "<unknown>",
          discriminatorValue: seg.value,
        };
      }
      currentType = matched;
      const decl = matched.getSymbol()?.getDeclarations()[0];
      if (decl && Node.isInterfaceDeclaration(decl)) {
        lastInterfaceDecl = decl;
        inlinePath = [];
      }
    } else if (seg.kind === "prop") {
      const prop = currentType.getProperty(seg.name);
      if (!prop) {
        if (isLast && lastInterfaceDecl) {
          return {
            mode: "addPropToInterface",
            interfaceName: lastInterfaceDecl.getName(),
            interfaceFile: lastInterfaceDecl.getSourceFile().getFilePath(),
            pathWithinInterface: [...inlinePath],
            propName: seg.name,
          };
        }
        return { mode: "fail", reason: `property ${seg.name} not found at segment ${i}` };
      }
      const decl = prop.getValueDeclaration();
      if (!decl) return { mode: "fail", reason: `no value-declaration for ${seg.name}` };

      // If this is the last segment AND the property exists, we've landed on
      // a known property. Used by widen-prim to find the type expression.
      // Follow the property's first declaration to find its ACTUAL declaring
      // interface — for inherited members (extends ConversationalBase, etc.)
      // the lastInterfaceDecl is the leaf type but the property lives upstream.
      if (isLast && lastInterfaceDecl) {
        const propDecl = prop.getDeclarations()[0];
        const declaringIface =
          propDecl?.getFirstAncestor(Node.isInterfaceDeclaration) ??
          (propDecl && Node.isInterfaceDeclaration(propDecl) ? propDecl : null) ??
          lastInterfaceDecl;
        // pathWithinInterface only makes sense when we descended through inline
        // literals on the leaf interface itself. If the property is inherited
        // (declaring interface != leaf), inlinePath doesn't apply.
        const pathWithin = declaringIface === lastInterfaceDecl ? [...inlinePath] : [];
        return {
          mode: "existingProperty",
          interfaceName: declaringIface.getName(),
          interfaceFile: declaringIface.getSourceFile().getFilePath(),
          pathWithinInterface: pathWithin,
          propName: seg.name,
        };
      }

      currentType = prop.getTypeAtLocation(decl);

      // If this property's type resolves to a referenced interface, that
      // becomes the new "current named interface" and we reset inlinePath.
      // If it's an inline TypeLiteral (or anonymous object type), we stay
      // anchored to the enclosing interface and extend inlinePath.
      const sym = currentType.getSymbol() ?? currentType.getAliasSymbol();
      const resolvedDecl = sym?.getDeclarations()[0];
      if (resolvedDecl && Node.isInterfaceDeclaration(resolvedDecl)) {
        lastInterfaceDecl = resolvedDecl;
        inlinePath = [];
      } else if (currentType.isObject() && !currentType.isArray()) {
        // Anonymous object — stay anchored, extend inline path
        inlinePath.push(seg.name);
      }
    } else if (seg.kind === "arrayElem") {
      const elem = currentType.getArrayElementType();
      if (!elem) return { mode: "fail", reason: `expected array at segment ${i}` };
      currentType = elem;
    } else if (seg.kind === "recordKey") {
      const idx = currentType.getStringIndexType();
      if (!idx) return { mode: "fail", reason: `expected record at segment ${i}` };
      currentType = idx;
    }
  }

  return { mode: "fail", reason: "path consumed but no terminal action determined" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Corpus-shape lookup
// ─────────────────────────────────────────────────────────────────────────────

function lookupCorpusAtPath(corpus: Schema, gapPath: string): Schema | null {
  const segs = parsePath(gapPath);
  let cur: Schema | null = corpus;
  for (const seg of segs) {
    if (!cur) return null;
    if (seg.kind === "discBucket") {
      if (cur.kind !== "discUnion") return null;
      cur = cur.variants[seg.value] ?? null;
    } else if (seg.kind === "prop") {
      if (cur.kind !== "object") return null;
      cur = cur.props[seg.name]?.schema ?? null;
    } else if (seg.kind === "arrayElem") {
      if (cur.kind !== "array") return null;
      cur = cur.element;
    } else if (seg.kind === "recordKey") {
      if (cur.kind !== "record") return null;
      cur = cur.value;
    }
  }
  return cur;
}

function lookupCorpusRequired(corpus: Schema | null, gapPath: string): boolean {
  if (!corpus) return false;
  const segs = parsePath(gapPath);
  if (segs.length === 0) return false;
  const lastSeg = segs[segs.length - 1];
  if (lastSeg.kind !== "prop") return false;

  // Walk parent path
  let cur: Schema | null = corpus;
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i];
    if (!cur) return false;
    if (s.kind === "discBucket" && cur.kind === "discUnion") cur = cur.variants[s.value] ?? null;
    else if (s.kind === "prop" && cur.kind === "object") cur = cur.props[s.name]?.schema ?? null;
    else if (s.kind === "arrayElem" && cur.kind === "array") cur = cur.element;
    else if (s.kind === "recordKey" && cur.kind === "record") cur = cur.value;
    else return false;
  }
  if (!cur || cur.kind !== "object") return false;
  return cur.props[lastSeg.name]?.required ?? false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema → TypeScript type expression
// ─────────────────────────────────────────────────────────────────────────────

/** Render an observed Schema as a TypeScript type expression for codegen. */
export function schemaToTsType(s: Schema): string {
  switch (s.kind) {
    case "prim": {
      const types = s.types.map((t) => (t === "null" ? "null" : t));
      return types.join(" | ");
    }
    case "literal":
      return JSON.stringify(s.value);
    case "array":
      return `${wrapIfUnion(schemaToTsType(s.element))}[]`;
    case "object": {
      const fields = Object.entries(s.props).map(([k, v]) => {
        const opt = v.required ? "" : "?";
        return `${k}${opt}: ${schemaToTsType(v.schema)}`;
      });
      const extras = s.openExtras ? "; [key: string]: unknown" : "";
      return `{ ${fields.join("; ")}${extras} }`;
    }
    case "record":
      return `Record<string, ${schemaToTsType(s.value)}>`;
    case "discUnion": {
      const variants = Object.values(s.variants).map(schemaToTsType);
      return variants.join(" | ");
    }
    case "union":
      return s.variants.map(schemaToTsType).join(" | ");
    case "opaque":
      return `unknown /* ${s.reason} */`;
  }
}

function wrapIfUnion(text: string): string {
  return text.includes(" | ") ? `(${text})` : text;
}

function inferTypeFromDetail(detail: string): string {
  // Fallback when corpus is missing — parse "observed type: <text>" from
  // the gap detail. Not as accurate as the corpus lookup but better than
  // returning `unknown`.
  const m = detail.match(/observed type:\s*(.+)$/);
  if (m) return m[1].trim();
  return "unknown";
}

// ─────────────────────────────────────────────────────────────────────────────
// ts-morph apply: add property to (possibly nested-inline) interface
// ─────────────────────────────────────────────────────────────────────────────

function applyAddPropertyGroup(group: Patch[], project: Project): void {
  const first = group[0];
  if (first.kind !== "add-property") return;

  const sourceFile = project.getSourceFile(first.targetFile);
  if (!sourceFile) {
    throw new Error(`cannot find source file: ${first.targetFile}`);
  }
  const iface = sourceFile.getInterfaceOrThrow(first.interfaceName);

  // Drill into the inline path to find the actual TypeLiteral to modify.
  const target = drillToTypeLiteral(iface, first.pathWithinInterface);
  if (!target) {
    throw new Error(
      `cannot drill to inline path ${first.pathWithinInterface.join(".")} in ${first.interfaceName}`
    );
  }

  for (const p of group) {
    if (p.kind !== "add-property") continue;
    // Skip if the property somehow already exists (defensive).
    const existing = target.getProperty(p.propName);
    if (existing) continue;
    target.addProperty({
      name: p.propName,
      type: p.propTypeText,
      hasQuestionToken: !p.required,
    });
  }
}

/**
 * Given an interface and a list of property names, drill into nested inline
 * TypeLiteral nodes to reach the position where a property should be added.
 * Returns either the interface itself (when path is empty) or the inner
 * TypeLiteralNode.
 */
function drillToTypeLiteral(
  iface: InterfaceDeclaration,
  path: string[]
): InterfaceDeclaration | TypeLiteralNode | null {
  let current: InterfaceDeclaration | TypeLiteralNode = iface;
  for (const name of path) {
    const prop = current.getProperty(name);
    if (!prop) return null;
    const typeNode = prop.getTypeNode();
    if (!typeNode) return null;
    if (typeNode.getKind() === SyntaxKind.TypeLiteral) {
      current = typeNode as TypeLiteralNode;
    } else {
      // Couldn't drill further — typeNode is not an inline literal.
      // This shouldn't happen if the resolver returned a valid inlinePath.
      return null;
    }
  }
  return current;
}
