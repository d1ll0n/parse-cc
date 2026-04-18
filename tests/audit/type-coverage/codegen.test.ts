import { describe, it, expect } from "vitest";
import { Project } from "ts-morph";
import {
  synthesizePatches,
  applyPatches,
  describePatch,
  schemaToTsType,
  synthesizeVariantName,
} from "../../../scripts/audit/type-coverage/codegen.ts";
import { createProject, walkLogEntry } from "../../../scripts/audit/type-coverage/walker.ts";
import { captureCorpus } from "../../../scripts/audit/type-coverage/corpus.ts";
import type { Gap } from "../../../scripts/audit/type-coverage/comparator.ts";
import { parseAllowlist } from "../../../scripts/audit/type-coverage/allowlist.ts";
import {
  prim,
  literal,
  array,
  object,
  optional,
  record,
} from "../../../scripts/audit/type-coverage/schema.ts";

const EMPTY_AL = parseAllowlist(`entries: []`);

// ─────────────────────────────────────────────────────────────────────────────
// schemaToTsType — observed schema → TS type expression
// ─────────────────────────────────────────────────────────────────────────────

describe("schemaToTsType", () => {
  it("renders primitive unions", () => {
    expect(schemaToTsType(prim("string"))).toBe("string");
    expect(schemaToTsType(prim("string", "null"))).toBe("null | string");
    expect(schemaToTsType(prim("number", "boolean"))).toBe("boolean | number");
  });

  it("renders literals as JSON", () => {
    expect(schemaToTsType(literal("foo"))).toBe('"foo"');
    expect(schemaToTsType(literal(42))).toBe("42");
    expect(schemaToTsType(literal(true))).toBe("true");
  });

  it("renders arrays with element type", () => {
    expect(schemaToTsType(array(prim("string")))).toBe("string[]");
    expect(schemaToTsType(array(prim("string", "number")))).toBe("(number | string)[]");
  });

  it("renders inline objects", () => {
    const s = object({
      name: prim("string"),
      age: optional(prim("number")),
    });
    expect(schemaToTsType(s)).toBe("{ name: string; age?: number }");
  });

  it("renders objects with openExtras as `[key: string]: unknown`", () => {
    const s = object({ id: prim("string") }, /* openExtras */ true);
    expect(schemaToTsType(s)).toBe("{ id: string; [key: string]: unknown }");
  });

  it("renders Record<string, T>", () => {
    expect(schemaToTsType(record(prim("number")))).toBe("Record<string, number>");
  });

  it("renders opaque with the reason as a comment", () => {
    expect(schemaToTsType({ kind: "opaque", reason: "per-tool" })).toBe(
      "unknown /* per-tool */"
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// synthesizePatches — end-to-end gap → patch synthesis
// ─────────────────────────────────────────────────────────────────────────────

describe("synthesizePatches — missing-field (Case B)", () => {
  it("produces an add-property patch for a missing field on a referenced interface", () => {
    const project = createProject();
    const walked = walkLogEntry(project);

    // Build a corpus with a synthetic new field on UsageMetadata.
    const corpus = captureCorpus(
      [
        {
          type: "assistant",
          uuid: "a1",
          parentUuid: null,
          timestamp: "2026-04-17T00:00:00Z",
          sessionId: "s1",
          message: {
            role: "assistant",
            id: "msg_1",
            model: "claude-sonnet-4-6",
            content: [{ type: "text", text: "hi" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              synthetic_new_field: "value", // <-- the new field
            },
          },
        },
      ],
      walked.schema,
      EMPTY_AL
    );

    const gap: Gap = {
      path: "$[assistant].message.usage.synthetic_new_field",
      kind: "missing-field",
      detail: "observed type: string",
    };

    const result = synthesizePatches([gap], corpus, project);
    expect(result.unsupported).toEqual([]);
    expect(result.patches).toHaveLength(1);

    const patch = result.patches[0];
    expect(patch.kind).toBe("add-property");
    if (patch.kind !== "add-property") return;
    expect(patch.interfaceName).toBe("UsageMetadata");
    expect(patch.propName).toBe("synthetic_new_field");
    expect(patch.propTypeText).toBe("string");
    expect(patch.required).toBe(true);
    expect(patch.pathWithinInterface).toEqual([]);
    expect(patch.targetFile).toMatch(/entries\.ts$/);
  });

  it("produces an add-property patch directly on the entry interface (no TypeReference)", () => {
    const project = createProject();
    const corpus = captureCorpus(
      [
        {
          type: "user",
          uuid: "u1",
          parentUuid: null,
          timestamp: "2026-04-17T00:00:00Z",
          sessionId: "s1",
          message: { role: "user", content: "hi" },
          __codegen_test_field__: "/some/path", // <-- synthetic field not in src/types/
        },
      ],
      walkLogEntry(project).schema,
      EMPTY_AL
    );

    const gap: Gap = {
      path: "$[user].__codegen_test_field__",
      kind: "missing-field",
      detail: "observed type: string",
    };

    const result = synthesizePatches([gap], corpus, project);
    expect(result.patches).toHaveLength(1);
    const patch = result.patches[0];
    if (patch.kind !== "add-property") throw new Error("unreachable");
    expect(patch.interfaceName).toBe("UserEntry");
    expect(patch.propName).toBe("__codegen_test_field__");
    expect(patch.propTypeText).toBe("string");
  });

  it("infers required=false when the property is observed in only some samples", () => {
    const project = createProject();
    const corpus = captureCorpus(
      [
        // First sample WITHOUT the new field
        {
          type: "user",
          uuid: "u1",
          parentUuid: null,
          timestamp: "2026-04-17T00:00:00Z",
          sessionId: "s1",
          message: { role: "user", content: "hi" },
        },
        // Second sample WITH it
        {
          type: "user",
          uuid: "u2",
          parentUuid: null,
          timestamp: "2026-04-17T00:00:01Z",
          sessionId: "s1",
          message: { role: "user", content: "yo" },
          __codegen_test_field__: "/x",
        },
      ],
      walkLogEntry(project).schema,
      EMPTY_AL
    );

    const result = synthesizePatches(
      [{ path: "$[user].__codegen_test_field__", kind: "missing-field", detail: "observed type: string" }],
      corpus,
      project
    );
    const patch = result.patches[0];
    if (patch.kind !== "add-property") throw new Error("unreachable");
    expect(patch.required).toBe(false);
  });

  it("falls back to gap.detail when corpus is null (renders observed-type from string)", () => {
    const project = createProject();
    const result = synthesizePatches(
      [{ path: "$[user].__codegen_test_field__", kind: "missing-field", detail: "observed type: number" }],
      null,
      project
    );
    const patch = result.patches[0];
    if (patch.kind !== "add-property") throw new Error("unreachable");
    expect(patch.propTypeText).toBe("number");
    expect(patch.required).toBe(false); // corpus-less: default optional
  });
});

describe("synthesizePatches — widen-prim (Case C)", () => {
  it("widens a primitive type to include null when observed +null", () => {
    const project = createProject();
    const result = synthesizePatches(
      [
        {
          // ConversationalBase.gitBranch is `string | undefined` — a property
          // that exists. Using it as a synthetic widening test target.
          path: "$[user].gitBranch",
          kind: "widen-prim",
          detail: "observed +null",
        },
      ],
      null,
      project
    );
    expect(result.unsupported).toEqual([]);
    expect(result.patches).toHaveLength(1);
    const patch = result.patches[0];
    if (patch.kind !== "widen-prim") throw new Error("unreachable");
    expect(patch.propName).toBe("gitBranch");
    expect(patch.addedTypes).toEqual(["null"]);
    expect(patch.newTypeText).toMatch(/\| null/);
  });

  it("rejects widening with non-primitive extras (suggests new variant instead)", () => {
    const project = createProject();
    const result = synthesizePatches(
      [
        {
          path: "$[user].gitBranch",
          kind: "widen-prim",
          detail: "observed +object",
        },
      ],
      null,
      project
    );
    expect(result.patches).toEqual([]);
    expect(result.unsupported).toHaveLength(1);
    expect(result.unsupported[0].reason).toMatch(/non-primitive/);
  });

  it("rejects widening when path doesn't resolve to an existing property", () => {
    const project = createProject();
    const result = synthesizePatches(
      [
        {
          path: "$[user].nonexistent_field_for_widen_test",
          kind: "widen-prim",
          detail: "observed +null",
        },
      ],
      null,
      project
    );
    expect(result.patches).toEqual([]);
    expect(result.unsupported).toHaveLength(1);
  });
});

describe("synthesizeVariantName — naming heuristics", () => {
  it("PascalCases snake_case discriminators with the union's suffix", () => {
    expect(synthesizeVariantName("AttachmentPayload", "task_reminder")).toBe("TaskReminderPayload");
    expect(synthesizeVariantName("AttachmentPayload", "skill_listing")).toBe("SkillListingPayload");
  });
  it("PascalCases kebab-case discriminators", () => {
    expect(synthesizeVariantName("LogEntry", "worktree-state")).toBe("WorktreeStateEntry");
    expect(synthesizeVariantName("LogEntry", "permission-mode")).toBe("PermissionModeEntry");
  });
  it("handles single-word discriminators", () => {
    expect(synthesizeVariantName("LogEntry", "user")).toBe("UserEntry");
    expect(synthesizeVariantName("ContentBlock", "text")).toBe("TextBlock");
  });
});

describe("synthesizePatches — unknown-variant (Case A)", () => {
  it("synthesizes a new interface from the corpus's observed shape and appends to union", () => {
    const project = createProject();
    const walked = walkLogEntry(project);

    // Synthetic gap: a discriminator value not present in src/types/.
    // Uses a sentinel that won't collide with any real (or future-codegen'd)
    // AttachmentPayload variant.
    const corpus = captureCorpus(
      [
        {
          type: "attachment",
          uuid: "att-1",
          parentUuid: null,
          timestamp: "2026-04-17T00:00:00Z",
          sessionId: "s1",
          attachment: {
            type: "__codegen_test_variant__",
            taskId: "t1",
            statusChange: "created",
            updatedFields: ["status", "subject"],
          },
        },
      ],
      walked.schema,
      EMPTY_AL
    );

    const gap: Gap = {
      path: "$[attachment].attachment[__codegen_test_variant__]",
      kind: "unknown-variant",
      detail: "discriminator type=\"__codegen_test_variant__\" has no typed variant. observed properties: type, taskId, statusChange, updatedFields",
    };

    const result = synthesizePatches([gap], corpus, project);
    expect(result.unsupported).toEqual([]);
    expect(result.patches).toHaveLength(1);

    const patch = result.patches[0];
    expect(patch.kind).toBe("add-variant-to-union");
    if (patch.kind !== "add-variant-to-union") return;
    expect(patch.newInterfaceName).toBe("CodegenTestVariantPayload");
    expect(patch.unionAliasName).toBe("AttachmentPayload");
    expect(patch.discriminatorValue).toBe("__codegen_test_variant__");
    // `type` excluded from members (emitted as literal in the apply step)
    const memberNames = patch.members.map((m) => m.name).sort();
    expect(memberNames).toEqual(["statusChange", "taskId", "updatedFields"]);
    expect(patch.targetFile).toMatch(/attachments\.ts$/);
  });

  it("rejects unknown-variant with no corpus (no observed shape to synthesize from)", () => {
    const project = createProject();
    const result = synthesizePatches(
      [{ path: "$[attachment].attachment[__codegen_test_variant__]", kind: "unknown-variant", detail: "" }],
      null,
      project
    );
    expect(result.unsupported).toHaveLength(1);
    expect(result.unsupported[0].reason).toMatch(/no corpus/);
  });
});

describe("synthesizePatches — ambiguous-fit (Case D, review-required)", () => {
  it("emits a proposed-variant-needs-review patch with a placeholder discriminator", () => {
    const project = createProject();
    const walked = walkLogEntry(project);

    // Synthetic: a discriminator-less attachment that doesn't fit any
    // existing AttachmentPayload variant. Capture buckets it under
    // <no-discriminator> at the union position.
    const corpus = captureCorpus(
      [
        {
          type: "attachment",
          uuid: "att-1",
          parentUuid: null,
          timestamp: "2026-04-17T00:00:00Z",
          sessionId: "s1",
          attachment: {
            // NOTE: no `type` field — this is the discriminator-less case
            content: [{ id: "1", subject: "Task" }],
            customField: "value",
          },
        },
      ],
      walked.schema,
      EMPTY_AL
    );

    const gap: Gap = {
      path: "$[attachment].attachment",
      kind: "ambiguous-fit",
      detail:
        "best-fit variant=skill_listing (score 1/2); structural mismatches: ...; observed properties: content, customField",
    };

    const result = synthesizePatches([gap], corpus, project);
    expect(result.unsupported).toEqual([]);
    expect(result.patches).toHaveLength(1);

    const patch = result.patches[0];
    expect(patch.kind).toBe("proposed-variant-needs-review");
    if (patch.kind !== "proposed-variant-needs-review") return;
    expect(patch.unionAliasName).toBe("AttachmentPayload");
    expect(patch.bestFitVariantName).toBe("skill_listing");
    const memberNames = patch.members.map((m) => m.name).sort();
    expect(memberNames).toEqual(["content", "customField"]);
  });

  it("rejects ambiguous-fit when no corpus is available", () => {
    const project = createProject();
    const result = synthesizePatches(
      [{ path: "$[attachment].attachment", kind: "ambiguous-fit", detail: "" }],
      null,
      project
    );
    expect(result.unsupported).toHaveLength(1);
    expect(result.unsupported[0].reason).toMatch(/no corpus/);
  });
});

describe("applyPatches — proposed-variant-needs-review", () => {
  it("does NOT apply review-required patches under --write (silent skip)", () => {
    const proj = new Project({ useInMemoryFileSystem: true });
    proj.createSourceFile(
      "/payload.ts",
      `export interface Existing { type: "x"; }\n` +
        `export type AttachmentPayload = Existing;\n`
    );
    const patch: import("../../../scripts/audit/type-coverage/codegen.ts").Patch = {
      kind: "proposed-variant-needs-review",
      targetFile: "/payload.ts",
      newInterfaceName: "ProposedPayload",
      unionAliasName: "AttachmentPayload",
      bestFitVariantName: "x",
      members: [{ name: "content", typeText: "string", required: true }],
      sourceGap: { path: "$[a].x", kind: "ambiguous-fit", detail: "" },
    };
    applyPatches([patch], proj);
    const updated = proj.getSourceFileOrThrow("/payload.ts").getFullText();
    // Source unchanged — review-required patches are never applied
    expect(updated).not.toContain("ProposedPayload");
    expect(updated).toContain("AttachmentPayload = Existing");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// applyPatches — actual ts-morph mutations
// ─────────────────────────────────────────────────────────────────────────────

describe("applyPatches — add-property", () => {
  it("adds a property to a target interface via ts-morph", () => {
    // Build an in-memory project with a synthetic source file we can mutate
    // safely (don't touch real src/).
    const proj = new Project({ useInMemoryFileSystem: true });
    proj.createSourceFile(
      "/types.ts",
      `
export interface UsageMetadata {
  input_tokens: number;
  output_tokens: number;
}
`.trimStart()
    );

    const patch: import("../../../scripts/audit/type-coverage/codegen.ts").Patch = {
      kind: "add-property",
      targetFile: "/types.ts",
      interfaceName: "UsageMetadata",
      pathWithinInterface: [],
      propName: "cache_creation_input_tokens",
      propTypeText: "number",
      required: false,
      sourceGap: {
        path: "$[assistant].message.usage.cache_creation_input_tokens",
        kind: "missing-field",
        detail: "observed type: number",
      },
    };

    applyPatches([patch], proj);

    const updated = proj.getSourceFileOrThrow("/types.ts").getFullText();
    expect(updated).toContain("cache_creation_input_tokens?: number");
  });

  it("batches multiple property-additions to the same interface into one walk", () => {
    const proj = new Project({ useInMemoryFileSystem: true });
    proj.createSourceFile("/types.ts", `export interface UserEntry {\n  type: "user";\n}\n`);

    const mk = (name: string, type: string): import("../../../scripts/audit/type-coverage/codegen.ts").Patch => ({
      kind: "add-property",
      targetFile: "/types.ts",
      interfaceName: "UserEntry",
      pathWithinInterface: [],
      propName: name,
      propTypeText: type,
      required: false,
      sourceGap: { path: `$[user].${name}`, kind: "missing-field", detail: "" },
    });

    applyPatches([mk("entrypoint", "string"), mk("forkedFrom", "string"), mk("planContent", "string")], proj);

    const updated = proj.getSourceFileOrThrow("/types.ts").getFullText();
    expect(updated).toContain("entrypoint?: string");
    expect(updated).toContain("forkedFrom?: string");
    expect(updated).toContain("planContent?: string");
  });

  it("applies a widen-prim patch by replacing the property's type expression", () => {
    const proj = new Project({ useInMemoryFileSystem: true });
    proj.createSourceFile(
      "/types.ts",
      `export interface Msg {\n  stop_reason: "end_turn" | "tool_use";\n}\n`
    );
    const patch: import("../../../scripts/audit/type-coverage/codegen.ts").Patch = {
      kind: "widen-prim",
      targetFile: "/types.ts",
      interfaceName: "Msg",
      pathWithinInterface: [],
      propName: "stop_reason",
      newTypeText: '"end_turn" | "tool_use" | null',
      addedTypes: ["null"],
      sourceGap: { path: "$[a].stop_reason", kind: "widen-prim", detail: "observed +null" },
    };
    applyPatches([patch], proj);
    const updated = proj.getSourceFileOrThrow("/types.ts").getFullText();
    expect(updated).toContain('"end_turn" | "tool_use" | null');
  });

  it("applies an add-variant-to-union patch by adding interface + extending alias", () => {
    const proj = new Project({ useInMemoryFileSystem: true });
    proj.createSourceFile(
      "/payload.ts",
      `export interface SkillListingPayload { type: "skill_listing"; content: string; }\n` +
        `export type AttachmentPayload = SkillListingPayload;\n`
    );
    const patch: import("../../../scripts/audit/type-coverage/codegen.ts").Patch = {
      kind: "add-variant-to-union",
      targetFile: "/payload.ts",
      newInterfaceName: "TaskReminderPayload",
      unionAliasName: "AttachmentPayload",
      discriminatorField: "type",
      discriminatorValue: "task_reminder",
      members: [
        { name: "taskId", typeText: "string", required: true },
        { name: "statusChange", typeText: "string", required: false },
      ],
      sourceGap: { path: "$[attachment].attachment[task_reminder]", kind: "unknown-variant", detail: "" },
    };
    applyPatches([patch], proj);
    const updated = proj.getSourceFileOrThrow("/payload.ts").getFullText();
    expect(updated).toContain('export interface TaskReminderPayload');
    expect(updated).toContain('type: "task_reminder"');
    expect(updated).toContain('taskId: string');
    expect(updated).toContain('statusChange?: string');
    expect(updated).toContain('SkillListingPayload | TaskReminderPayload');
  });

  it("is idempotent: re-applying the same add-variant patch is a no-op", () => {
    const proj = new Project({ useInMemoryFileSystem: true });
    proj.createSourceFile(
      "/payload.ts",
      `export interface SkillListingPayload { type: "skill_listing"; }\n` +
        `export type AttachmentPayload = SkillListingPayload;\n`
    );
    const patch: import("../../../scripts/audit/type-coverage/codegen.ts").Patch = {
      kind: "add-variant-to-union",
      targetFile: "/payload.ts",
      newInterfaceName: "TaskReminderPayload",
      unionAliasName: "AttachmentPayload",
      discriminatorField: "type",
      discriminatorValue: "task_reminder",
      members: [{ name: "taskId", typeText: "string", required: true }],
      sourceGap: { path: "$[attachment].attachment[task_reminder]", kind: "unknown-variant", detail: "" },
    };
    applyPatches([patch], proj);
    applyPatches([patch], proj);
    const updated = proj.getSourceFileOrThrow("/payload.ts").getFullText();
    expect(updated.match(/interface TaskReminderPayload/g)?.length).toBe(1);
    expect(updated.match(/TaskReminderPayload/g)?.length).toBe(2); // interface + union member
  });

  it("skips properties that already exist (defensive)", () => {
    const proj = new Project({ useInMemoryFileSystem: true });
    proj.createSourceFile(
      "/types.ts",
      `export interface UsageMetadata {\n  input_tokens: number;\n}\n`
    );
    const patch: import("../../../scripts/audit/type-coverage/codegen.ts").Patch = {
      kind: "add-property",
      targetFile: "/types.ts",
      interfaceName: "UsageMetadata",
      pathWithinInterface: [],
      propName: "input_tokens", // already exists
      propTypeText: "number",
      required: true,
      sourceGap: { path: "$[assistant].message.usage.input_tokens", kind: "missing-field", detail: "" },
    };
    applyPatches([patch], proj);
    const updated = proj.getSourceFileOrThrow("/types.ts").getFullText();
    // Still only one occurrence
    expect(updated.match(/input_tokens/g)?.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// describePatch — --suggest output formatting
// ─────────────────────────────────────────────────────────────────────────────

describe("describePatch", () => {
  it("renders an add-property patch in a single readable line + path context", () => {
    const patch: import("../../../scripts/audit/type-coverage/codegen.ts").Patch = {
      kind: "add-property",
      targetFile: `${process.cwd()}/src/types/entries.ts`,
      interfaceName: "UsageMetadata",
      pathWithinInterface: [],
      propName: "cache_creation_input_tokens",
      propTypeText: "number",
      required: false,
      sourceGap: {
        path: "$[assistant].message.usage.cache_creation_input_tokens",
        kind: "missing-field",
        detail: "",
      },
    };
    const desc = describePatch(patch);
    expect(desc).toContain("ADD-PROPERTY");
    expect(desc).toContain("UsageMetadata.cache_creation_input_tokens?: number");
    expect(desc).toContain("src/types/entries.ts");
  });
});
