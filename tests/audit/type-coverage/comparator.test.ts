import { describe, it, expect } from "vitest";
import {
  audit,
  type Gap,
} from "../../../scripts/audit/type-coverage/comparator.ts";
import {
  prim,
  literal,
  array,
  object,
  optional,
  record,
  discUnion,
  union,
  opaque,
} from "../../../scripts/audit/type-coverage/schema.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Prototype-parity fixtures (ports of scripts/prototype-schema-coverage.mjs).
// ─────────────────────────────────────────────────────────────────────────────

describe("audit — prototype parity", () => {
  it("clean discriminated union by `type` (UserEntry / AssistantEntry)", () => {
    const typed = discUnion("type", {
      user: object({
        type: literal("user"),
        message: object({ role: prim("string"), content: prim("string") }),
      }),
      assistant: object({
        type: literal("assistant"),
        message: object({ role: prim("string"), content: prim("string") }),
        usage: object({
          input_tokens: prim("number"),
          output_tokens: prim("number"),
        }),
      }),
    });
    const samples = [
      { type: "user", message: { role: "user", content: "hi" } },
      {
        type: "assistant",
        message: { role: "assistant", content: "ok" },
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ];
    expect(audit(typed, samples)).toEqual([]);
  });

  it("missing-field gap when observed has a property the typed doesn't model", () => {
    const typed = discUnion("type", {
      assistant: object({
        type: literal("assistant"),
        usage: object({
          input_tokens: prim("number"),
          output_tokens: prim("number"),
        }),
      }),
    });
    const samples = [
      { type: "assistant", usage: { input_tokens: 10, output_tokens: 5 } },
      {
        type: "assistant",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 200, // ← not in typed
        },
      },
    ];
    const gaps = audit(typed, samples);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].kind).toBe("missing-field");
    expect(gaps[0].path).toBe("$[assistant].usage.cache_creation_input_tokens");
    expect(gaps[0].detail).toContain("number");
  });

  it("ambiguous-fit gap when discriminator-less observed object best-fits a wrong variant", () => {
    const typed = discUnion("type", {
      skill_listing: object({
        type: literal("skill_listing"),
        content: prim("string"),
        skillCount: prim("number"),
      }),
      hook_success: object({
        type: literal("hook_success"),
        hookName: prim("string"),
        content: prim("string"),
      }),
    });
    const samples = [
      // Has discriminator → covered.
      { type: "skill_listing", content: "...", skillCount: 42 },
      // Missing discriminator AND structurally distinct: brand-new attachment subtype.
      { content: [{ id: "1", subject: "Task", status: "pending" }] },
    ];
    const gaps = audit(typed, samples);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].kind).toBe("ambiguous-fit");
    expect(gaps[0].detail).toContain("best-fit variant=");
    expect(gaps[0].detail).toContain("structural mismatches");
  });

  it("Record<string, unknown> covers any keys (e.g. mcp__* tool results)", () => {
    const typed = object({
      type: literal("user"),
      toolUseResult: record(opaque("MCP tool result; user-defined per server")),
    });
    const samples = [
      {
        type: "user",
        toolUseResult: {
          mcp__github__create_issue: { number: 42, url: "https://..." },
        },
      },
      {
        type: "user",
        toolUseResult: {
          mcp__slack__send: { ok: true, channel: "#general" },
        },
      },
    ];
    expect(audit(typed, samples)).toEqual([]);
  });

  it("openExtras: true absorbs unknown properties (QueuedCommandPayload-style)", () => {
    const typed = object(
      { type: literal("queued_command"), content: optional(prim("string")) },
      /* openExtras */ true
    );
    const samples = [
      { type: "queued_command", content: "/foo" },
      { type: "queued_command", commandId: "abc-123", customField: { nested: true } },
    ];
    expect(audit(typed, samples)).toEqual([]);
  });

  it("unknown-variant gap for new content-block type (e.g. `thinking`)", () => {
    const typed = object({
      type: literal("assistant"),
      message: object({
        content: array(
          discUnion("type", {
            text: object({ type: literal("text"), text: prim("string") }),
            tool_use: object({
              type: literal("tool_use"),
              id: prim("string"),
              name: prim("string"),
              input: opaque("per-tool"),
            }),
          })
        ),
      }),
    });
    const samples = [
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "let me check" },
            { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/x" } },
          ],
        },
      },
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "done" },
            { type: "thinking", thinking: "internal..." }, // ← unknown variant
          ],
        },
      },
    ];
    const gaps = audit(typed, samples);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].kind).toBe("unknown-variant");
    expect(gaps[0].path).toBe("$.message.content[][thinking]");
  });

  it("optional/required inference works across samples (no false gaps)", () => {
    const typed = object({
      type: literal("user"),
      message: object({ role: prim("string"), content: prim("string") }),
      isMeta: optional(prim("boolean")),
      isCompactSummary: optional(prim("boolean")),
    });
    const samples = [
      { type: "user", message: { role: "user", content: "a" }, isMeta: false },
      { type: "user", message: { role: "user", content: "b" } },
      { type: "user", message: { role: "user", content: "c" }, isCompactSummary: true },
    ];
    expect(audit(typed, samples)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Spec §Worked-examples fixtures.
// ─────────────────────────────────────────────────────────────────────────────

describe("audit — spec worked examples", () => {
  it("Example 1: brand-new entry type → unknown-variant at top level", () => {
    const typed = discUnion("type", {
      user: object({ type: literal("user") }),
      assistant: object({ type: literal("assistant") }),
    });
    const samples = [
      {
        type: "worktree-state", // ← no typed variant
        uuid: "wts-1",
        sessionId: "s1",
        worktreeSession: { sessionId: "ws-1", worktreeName: "feat-x" },
      },
    ];
    const gaps = audit(typed, samples);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].kind).toBe("unknown-variant");
    expect(gaps[0].path).toBe("$[worktree-state]");
    expect(gaps[0].detail).toContain("worktreeSession");
  });

  it("Example 4: widening enum alias (observed `null` not in StopReason literals)", () => {
    // StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence"
    // (deliberately omitting null to simulate the pre-widening state)
    const typed = object({
      type: literal("assistant"),
      message: object({
        stop_reason: union([
          literal("end_turn"),
          literal("tool_use"),
          literal("max_tokens"),
          literal("stop_sequence"),
        ]),
      }),
    });
    const samples = [
      { type: "assistant", message: { stop_reason: "end_turn" } },
      { type: "assistant", message: { stop_reason: "tool_use" } },
      { type: "assistant", message: { stop_reason: null } }, // ← needs widening
    ];
    const gaps = audit(typed, samples);
    expect(gaps.length).toBeGreaterThan(0);
    // Comparator emits literal-mismatch (best-fit per sample under untagged union).
    // The signal IS that the union doesn't cover null; codegen reads this as
    // "widen the alias".
    expect(gaps[0].path).toBe("$.message.stop_reason");
    expect(["literal-mismatch"]).toContain(gaps[0].kind);
  });

  it("Example 5: opaque allowlist position (simulating allowlist behavior)", () => {
    // The allowlist is conceptually "wrap a typed subtree with opaque". This
    // fixture encodes that directly to test the comparator's opaque handling.
    const typed = object({
      type: literal("user"),
      toolUseResult: opaque(
        "MCP tool result; user-defined per server (would be allowlisted)"
      ),
    });
    const samples = [
      {
        type: "user",
        toolUseResult: {
          mcp__github__create_issue: { number: 42, url: "https://..." },
        },
      },
    ];
    expect(audit(typed, samples)).toEqual([]);
  });

  it("Example 6: untagged union holds when observed shapes match different variants", () => {
    // user.message.content: string | ContentBlock[]
    const typed = object({
      type: literal("user"),
      message: object({
        content: union([
          prim("string"),
          array(
            discUnion("type", {
              text: object({ type: literal("text"), text: prim("string") }),
            })
          ),
        ]),
      }),
    });
    const samples = [
      { type: "user", message: { content: "hi" } },
      { type: "user", message: { content: [{ type: "text", text: "hi" }] } },
    ];
    expect(audit(typed, samples)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge cases not covered by the prototype.
// ─────────────────────────────────────────────────────────────────────────────

describe("audit — edge cases", () => {
  it("returns empty when no samples are provided", () => {
    const typed = object({ type: literal("user") });
    expect(audit(typed, [])).toEqual([]);
  });

  it("kind-mismatch when typed expects object but observed is a primitive", () => {
    const typed = object({ x: prim("string") });
    const samples = ["not-an-object", 42, null];
    const gaps = audit(typed, samples);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].kind).toBe("kind-mismatch");
    expect(gaps[0].detail).toContain("typed=object");
  });

  it("dedups identical gaps across multiple samples", () => {
    // Same missing-field surfaced by multiple samples → reported once.
    const typed = discUnion("type", {
      user: object({ type: literal("user"), message: prim("string") }),
    });
    const samples = [
      { type: "user", message: "hi", extra: 1 },
      { type: "user", message: "yo", extra: 2 },
      { type: "user", message: "ok", extra: 3 },
    ];
    const gaps = audit(typed, samples).filter((g: Gap) => g.kind === "missing-field");
    expect(gaps).toHaveLength(1);
    expect(gaps[0].path).toBe("$[user].extra");
  });

  it("opaque short-circuits descent regardless of observed shape", () => {
    const typed = object({
      type: literal("system"),
      data: opaque("intentionally untyped"),
    });
    const samples = [
      { type: "system", data: { anything: { goes: "here" } } },
      { type: "system", data: ["even", "an", "array"] },
      { type: "system", data: 42 },
    ];
    expect(audit(typed, samples)).toEqual([]);
  });
});
