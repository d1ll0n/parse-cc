import { describe, it, expect } from "vitest";
import {
  captureCorpus,
  mergeIntoCorpus,
  serializeCorpus,
  deserializeCorpus,
  deriveSkipPatternsFromTypedSchema,
} from "../../../scripts/audit/type-coverage/corpus.ts";
import { parseAllowlist } from "../../../scripts/audit/type-coverage/allowlist.ts";
import {
  prim,
  literal,
  array,
  object,
  optional,
  record,
  discUnion,
  opaque,
} from "../../../scripts/audit/type-coverage/schema.ts";
import type { Schema } from "../../../scripts/audit/type-coverage/schema.ts";

const EMPTY_ALLOWLIST = parseAllowlist(`entries: []`);

// Convenience: a typed schema with a top-level discUnion for entry types.
function makeTypedTopLevel(variants: Record<string, Schema>): Schema {
  return discUnion("type", variants);
}

// ─────────────────────────────────────────────────────────────────────────────
// captureCorpus — type-guided routing at top-level discUnion.
// ─────────────────────────────────────────────────────────────────────────────

describe("captureCorpus — top-level routing", () => {
  it("routes samples by type into a discUnion mirroring the typed schema", () => {
    const typed = makeTypedTopLevel({
      user: object({ type: literal("user"), message: prim("string") }),
      assistant: object({ type: literal("assistant"), message: prim("string") }),
    });
    const corpus = captureCorpus(
      [
        { type: "user", message: "hi" },
        { type: "assistant", message: "ok" },
        { type: "user", message: "yo" },
      ],
      typed,
      EMPTY_ALLOWLIST
    );
    expect(corpus.kind).toBe("discUnion");
    if (corpus.kind !== "discUnion") return;
    expect(corpus.discriminator).toBe("type");
    expect(Object.keys(corpus.variants).sort()).toEqual(["assistant", "user"]);
  });

  it("preserves discriminator literals at routed positions (no literal-mismatch noise)", () => {
    const typed = makeTypedTopLevel({
      user: object({ type: literal("user") }),
    });
    const corpus = captureCorpus([{ type: "user" }], typed, EMPTY_ALLOWLIST);
    if (corpus.kind !== "discUnion") return;
    const userVariant = corpus.variants.user;
    if (userVariant.kind !== "object") return;
    expect(userVariant.props.type?.schema).toEqual({ kind: "literal", value: "user" });
  });

  it("buckets unknown discriminator values separately for the audit to flag", () => {
    const typed = makeTypedTopLevel({
      user: object({ type: literal("user") }),
    });
    const corpus = captureCorpus(
      [
        { type: "user" },
        { type: "task-reminder", taskId: "t1" }, // unknown variant
      ],
      typed,
      EMPTY_ALLOWLIST
    );
    if (corpus.kind !== "discUnion") return;
    expect(Object.keys(corpus.variants).sort()).toEqual(["task-reminder", "user"]);
    const tr = corpus.variants["task-reminder"];
    if (tr.kind !== "object") return;
    expect(Object.keys(tr.props)).toContain("taskId");
  });

  it("buckets discriminator-less samples under <no-discriminator>", () => {
    const typed = makeTypedTopLevel({
      user: object({ type: literal("user") }),
    });
    const corpus = captureCorpus(
      [{ message: "hi" }],
      typed,
      EMPTY_ALLOWLIST
    );
    if (corpus.kind !== "discUnion") return;
    expect(corpus.variants["<no-discriminator>"]).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// captureCorpus — nested discUnions and per-property routing.
// ─────────────────────────────────────────────────────────────────────────────

describe("captureCorpus — nested routing", () => {
  it("routes nested discUnions (e.g. AttachmentPayload)", () => {
    const typed = makeTypedTopLevel({
      attachment: object({
        type: literal("attachment"),
        attachment: discUnion("type", {
          skill_listing: object({ type: literal("skill_listing"), content: prim("string") }),
          hook_success: object({ type: literal("hook_success"), hookName: prim("string") }),
        }),
      }),
    });
    const corpus = captureCorpus(
      [
        { type: "attachment", attachment: { type: "skill_listing", content: "..." } },
        { type: "attachment", attachment: { type: "hook_success", hookName: "PreToolUse" } },
      ],
      typed,
      EMPTY_ALLOWLIST
    );
    if (corpus.kind !== "discUnion") return;
    const att = corpus.variants.attachment;
    if (att.kind !== "object") return;
    const innerPayload = att.props.attachment.schema;
    expect(innerPayload.kind).toBe("discUnion");
    if (innerPayload.kind !== "discUnion") return;
    expect(Object.keys(innerPayload.variants).sort()).toEqual(["hook_success", "skill_listing"]);
  });

  it("captures observed properties typed doesn't model (for missing-field gaps)", () => {
    const typed = makeTypedTopLevel({
      user: object({ type: literal("user"), message: prim("string") }),
    });
    const corpus = captureCorpus(
      [{ type: "user", message: "hi", surpriseField: 42 }],
      typed,
      EMPTY_ALLOWLIST
    );
    if (corpus.kind !== "discUnion") return;
    const user = corpus.variants.user;
    if (user.kind !== "object") return;
    expect(user.props.surpriseField?.schema).toEqual({ kind: "prim", types: ["number"] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// captureCorpus — allowlist short-circuit + skip-set behavior.
// ─────────────────────────────────────────────────────────────────────────────

describe("captureCorpus — allowlist short-circuit", () => {
  it("collapses Record-keyed positions when allowlist matches via .*", () => {
    const al = parseAllowlist(`
entries:
  - path: $[file-history-snapshot].snapshot.trackedFileBackups.*
    reason: Record<string, TrackedFileBackup> — keys are file paths
`);
    const typed = makeTypedTopLevel({
      "file-history-snapshot": object({
        type: literal("file-history-snapshot"),
        snapshot: object({
          trackedFileBackups: record(
            object({ backupFileName: prim("string"), version: prim("number") })
          ),
        }),
      }),
    });
    const corpus = captureCorpus(
      [
        {
          type: "file-history-snapshot",
          snapshot: {
            trackedFileBackups: {
              "/repo/src/a.ts": { backupFileName: "a@v1", version: 1 },
              "/repo/src/b.ts": { backupFileName: "b@v1", version: 1 },
              "/repo/src/c.ts": { backupFileName: "c@v1", version: 1 },
            },
          },
        },
      ],
      typed,
      al
    );
    if (corpus.kind !== "discUnion") return;
    const fhs = corpus.variants["file-history-snapshot"];
    if (fhs.kind !== "object") return;
    const snap = fhs.props.snapshot.schema;
    if (snap.kind !== "object") return;
    expect(snap.props.trackedFileBackups.schema).toEqual({
      kind: "opaque",
      reason: "Record<string, TrackedFileBackup> — keys are file paths",
    });
  });

  it("openExtras=true on typed object absorbs unknown observed keys", () => {
    const typed = makeTypedTopLevel({
      attachment: object(
        { type: literal("attachment") },
        /* openExtras */ true
      ),
    });
    const corpus = captureCorpus(
      [{ type: "attachment", randomKey: "x", another: 42 }],
      typed,
      EMPTY_ALLOWLIST
    );
    if (corpus.kind !== "discUnion") return;
    const a = corpus.variants.attachment;
    if (a.kind !== "object") return;
    // Extras captured as opaque (openExtras parent reason)
    expect(a.props.randomKey?.schema.kind).toBe("opaque");
    expect(a.props.another?.schema.kind).toBe("opaque");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Serialization round-trip + deterministic key ordering.
// ─────────────────────────────────────────────────────────────────────────────

describe("serializeCorpus / deserializeCorpus — round-trip + determinism", () => {
  it("round-trips a complex schema without loss", () => {
    const original: Schema = discUnion("type", {
      user: object({ type: literal("user"), message: prim("string"), isMeta: optional(prim("boolean")) }),
      assistant: object({
        type: literal("assistant"),
        usage: object({ input_tokens: prim("number") }),
      }),
    });
    const json = serializeCorpus(original);
    const parsed = deserializeCorpus(json);
    expect(parsed).toEqual(sortShallow(original));
  });

  it("sorts object property keys alphabetically", () => {
    const original = object({
      zebra: prim("string"),
      apple: prim("number"),
      mango: prim("boolean"),
    });
    const reparsed = JSON.parse(serializeCorpus(original)) as { props: Record<string, unknown> };
    expect(Object.keys(reparsed.props)).toEqual(["apple", "mango", "zebra"]);
  });

  it("sorts discUnion variant keys alphabetically", () => {
    const original = discUnion("type", {
      user: object({}),
      assistant: object({}),
      summary: object({}),
    });
    const reparsed = JSON.parse(serializeCorpus(original)) as { variants: Record<string, unknown> };
    expect(Object.keys(reparsed.variants)).toEqual(["assistant", "summary", "user"]);
  });
});

function sortShallow(s: Schema): Schema {
  if (s.kind === "object") {
    const sorted: Record<string, { schema: Schema; required: boolean }> = {};
    for (const k of Object.keys(s.props).sort()) {
      sorted[k] = { schema: sortShallow(s.props[k].schema), required: s.props[k].required };
    }
    return { kind: "object", props: sorted, openExtras: s.openExtras };
  }
  if (s.kind === "discUnion") {
    const sorted: Record<string, Schema> = {};
    for (const k of Object.keys(s.variants).sort()) sorted[k] = sortShallow(s.variants[k]);
    return { kind: "discUnion", discriminator: s.discriminator, variants: sorted };
  }
  if (s.kind === "array") return array(sortShallow(s.element));
  if (s.kind === "record") return record(sortShallow(s.value));
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// mergeIntoCorpus — additive merge.
// ─────────────────────────────────────────────────────────────────────────────

describe("mergeIntoCorpus", () => {
  it("preserves shapes from the existing corpus when local doesn't see them", () => {
    const typed = makeTypedTopLevel({
      user: object({ type: literal("user"), message: prim("string") }),
      assistant: object({ type: literal("assistant"), message: prim("string") }),
    });
    const existing = captureCorpus([{ type: "user", message: "hi" }], typed, EMPTY_ALLOWLIST);
    const local = captureCorpus([{ type: "assistant", message: "ok" }], typed, EMPTY_ALLOWLIST);
    const merged = mergeIntoCorpus(existing, local);
    // Assert kind hard rather than `if (...) return;` — skip-on-narrowing
    // hid a real merger bug (discUnion+discUnion went through flattenUnion
    // and recursed into max-depth opaque) until a real-data run caught it.
    expect(merged.kind).toBe("discUnion");
    if (merged.kind !== "discUnion") throw new Error("unreachable");
    expect(Object.keys(merged.variants).sort()).toEqual(["assistant", "user"]);
  });

  it("widens optional/required when local sees additional optional properties", () => {
    const typed = makeTypedTopLevel({
      user: object({
        type: literal("user"),
        message: prim("string"),
        isMeta: optional(prim("boolean")),
      }),
    });
    const existing = captureCorpus([{ type: "user", message: "hi" }], typed, EMPTY_ALLOWLIST);
    const local = captureCorpus(
      [{ type: "user", message: "hi", isMeta: true }],
      typed,
      EMPTY_ALLOWLIST
    );
    const merged = mergeIntoCorpus(existing, local);
    expect(merged.kind).toBe("discUnion");
    if (merged.kind !== "discUnion") throw new Error("unreachable");
    const user = merged.variants.user;
    expect(user.kind).toBe("object");
    if (user.kind !== "object") throw new Error("unreachable");
    expect(user.props.isMeta?.required).toBe(false);
  });

  it("handles multiple round-trip merges without collapsing to opaque", () => {
    // Regression for the discUnion+discUnion → flattenUnion → max-depth bug.
    const typed = makeTypedTopLevel({
      user: object({ type: literal("user"), message: prim("string") }),
    });
    const a = captureCorpus([{ type: "user", message: "a" }], typed, EMPTY_ALLOWLIST);
    const b = captureCorpus([{ type: "user", message: "b" }], typed, EMPTY_ALLOWLIST);
    const c = captureCorpus([{ type: "user", message: "c" }], typed, EMPTY_ALLOWLIST);
    const merged = mergeIntoCorpus(mergeIntoCorpus(a, b), c);
    expect(merged.kind).toBe("discUnion");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// deriveSkipPatternsFromTypedSchema
// ─────────────────────────────────────────────────────────────────────────────

describe("deriveSkipPatternsFromTypedSchema", () => {
  it("emits trailing-wildcard patterns for opaque positions", () => {
    const typed = object({
      type: literal("assistant"),
      message: object({
        content: array(
          object({ type: literal("tool_use"), input: opaque("per-tool") })
        ),
      }),
    });
    const patterns = deriveSkipPatternsFromTypedSchema(typed);
    const inputPattern = patterns.find((p) => p.path.includes("input"));
    expect(inputPattern).toBeDefined();
    expect(inputPattern!.path).toBe("$.message.content[].input.*");
    expect(inputPattern!.reason).toBe("per-tool");
  });

  it("emits trailing-`.*` patterns for record positions (matches capture's `.key` syntax)", () => {
    const typed = object({
      snapshot: object({
        trackedFileBackups: record(prim("string")),
      }),
    });
    const patterns = deriveSkipPatternsFromTypedSchema(typed);
    const recordPattern = patterns.find((p) => p.path.includes("trackedFileBackups"));
    expect(recordPattern).toBeDefined();
    expect(recordPattern!.path).toBe("$.snapshot.trackedFileBackups.*");
  });
});
