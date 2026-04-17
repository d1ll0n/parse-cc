import { describe, it, expect } from "vitest";
import {
  captureCorpus,
  captureOne,
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

// ─────────────────────────────────────────────────────────────────────────────
// captureCorpus — bucketing by entry type.
// ─────────────────────────────────────────────────────────────────────────────

describe("captureCorpus — top-level bucketing", () => {
  it("buckets entries by their `type` field into a discUnion", () => {
    const corpus = captureCorpus(
      [
        { type: "user", message: "hi" },
        { type: "assistant", message: "ok" },
        { type: "user", message: "yo" },
      ],
      EMPTY_ALLOWLIST
    );
    expect(corpus.kind).toBe("discUnion");
    if (corpus.kind !== "discUnion") return;
    expect(corpus.discriminator).toBe("type");
    expect(Object.keys(corpus.variants).sort()).toEqual(["assistant", "user"]);
  });

  it("places typeless entries under `<no-type>`", () => {
    const corpus = captureCorpus(
      [{ uuid: "x", message: "hi" }],
      EMPTY_ALLOWLIST
    );
    if (corpus.kind !== "discUnion") return;
    expect(corpus.variants["<no-type>"]).toBeDefined();
  });

  it("merges multiple samples of the same type into one schema with optional widening", () => {
    const corpus = captureCorpus(
      [
        { type: "user", message: "hi" },
        { type: "user", message: "yo", isMeta: true },
      ],
      EMPTY_ALLOWLIST
    );
    if (corpus.kind !== "discUnion") return;
    const user = corpus.variants.user;
    expect(user.kind).toBe("object");
    if (user.kind !== "object") return;
    expect(user.props.message?.required).toBe(true);
    expect(user.props.isMeta?.required).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// captureOne — allowlist short-circuit.
// ─────────────────────────────────────────────────────────────────────────────

describe("captureOne — allowlist short-circuit", () => {
  it("returns opaque(reason) when the path matches an allowlist entry", () => {
    const al = parseAllowlist(`
entries:
  - path: $[user].toolUseResult.*
    reason: opaque-by-allowlist
`);
    const result = captureOne(
      { stdout: "...", stderr: "..." },
      "$[user].toolUseResult",
      al,
      0
    );
    expect(result).toEqual({ kind: "opaque", reason: "opaque-by-allowlist" });
  });

  it("recurses into objects when no path matches", () => {
    const result = captureOne({ a: 1, b: "x" }, "$.foo", EMPTY_ALLOWLIST, 0);
    expect(result.kind).toBe("object");
    if (result.kind !== "object") return;
    expect(result.props.a?.schema).toEqual({ kind: "prim", types: ["number"] });
    expect(result.props.b?.schema).toEqual({ kind: "prim", types: ["string"] });
  });

  it("inlines literal opaque markers in arrays when allowlist matches the element path", () => {
    const al = parseAllowlist(`
entries:
  - path: $.items[]
    reason: per-item opaque
`);
    const result = captureOne([{ a: 1 }, { b: 2 }], "$.items", al, 0);
    expect(result.kind).toBe("array");
    if (result.kind !== "array") return;
    expect(result.element).toEqual({ kind: "opaque", reason: "per-item opaque" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// captureCorpus — measured against the file-history-snapshot bloat case.
// ─────────────────────────────────────────────────────────────────────────────

describe("captureCorpus — allowlist-driven shape collapse (file-history case)", () => {
  it("collapses Record-keyed positions when allowlisted", () => {
    const al = parseAllowlist(`
entries:
  - path: $[file-history-snapshot].snapshot.trackedFileBackups.*
    reason: Record<string, TrackedFileBackup> — keys are file paths
`);
    const samples = [
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
    ];
    const corpus = captureCorpus(samples, al);
    if (corpus.kind !== "discUnion") return;
    const fhs = corpus.variants["file-history-snapshot"];
    if (fhs.kind !== "object") return;
    const tracked = fhs.props.snapshot.schema;
    if (tracked.kind !== "object") return;
    expect(tracked.props.trackedFileBackups.schema).toEqual({
      kind: "opaque",
      reason: "Record<string, TrackedFileBackup> — keys are file paths",
    });
  });

  it("WITHOUT the allowlist, file paths fan out as keys (the bug we're avoiding)", () => {
    const samples = [
      {
        type: "file-history-snapshot",
        snapshot: {
          trackedFileBackups: {
            "/repo/src/a.ts": { backupFileName: "a@v1", version: 1 },
            "/repo/src/b.ts": { backupFileName: "b@v1", version: 1 },
          },
        },
      },
    ];
    const corpus = captureCorpus(samples, EMPTY_ALLOWLIST);
    if (corpus.kind !== "discUnion") return;
    const fhs = corpus.variants["file-history-snapshot"];
    if (fhs.kind !== "object") return;
    const snap = fhs.props.snapshot.schema;
    if (snap.kind !== "object") return;
    const tracked = snap.props.trackedFileBackups.schema;
    if (tracked.kind !== "object") return;
    // Without allowlist, file paths show up as property names (the bloat).
    expect(Object.keys(tracked.props).sort()).toEqual([
      "/repo/src/a.ts",
      "/repo/src/b.ts",
    ]);
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
    // V8 preserves insertion order on JSON.parse, so Object.keys gives the
    // serialized order back.
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
  // Sort object/discUnion keys for equality comparison after a serialize round-trip.
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
    const existing = captureCorpus([{ type: "user", message: "hi" }], EMPTY_ALLOWLIST);
    const local = captureCorpus([{ type: "assistant", message: "ok" }], EMPTY_ALLOWLIST);
    const merged = mergeIntoCorpus(existing, local);
    if (merged.kind !== "discUnion") return;
    expect(Object.keys(merged.variants).sort()).toEqual(["assistant", "user"]);
  });

  it("widens optional/required when local sees additional optional properties", () => {
    const existing = captureCorpus([{ type: "user", message: "hi" }], EMPTY_ALLOWLIST);
    const local = captureCorpus(
      [{ type: "user", message: "hi", isMeta: true }],
      EMPTY_ALLOWLIST
    );
    const merged = mergeIntoCorpus(existing, local);
    if (merged.kind !== "discUnion") return;
    const user = merged.variants.user;
    if (user.kind !== "object") return;
    expect(user.props.isMeta?.required).toBe(false);
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

  it("emits {*} patterns for record positions", () => {
    const typed = object({
      snapshot: object({
        trackedFileBackups: record(prim("string")),
      }),
    });
    const patterns = deriveSkipPatternsFromTypedSchema(typed);
    const recordPattern = patterns.find((p) => p.path.includes("trackedFileBackups"));
    expect(recordPattern).toBeDefined();
    expect(recordPattern!.path).toBe("$.snapshot.trackedFileBackups{*}");
  });
});
