import { describe, it, expect } from "vitest";
import {
  parseAllowlist,
  compilePathPattern,
  findStaleEntries,
} from "../../../scripts/audit/type-coverage/allowlist.ts";

// ─────────────────────────────────────────────────────────────────────────────
// parseAllowlist — validation of YAML structure.
// ─────────────────────────────────────────────────────────────────────────────

describe("parseAllowlist — validation", () => {
  it("accepts a minimal valid allowlist", () => {
    const al = parseAllowlist(`
entries:
  - path: $.foo
    reason: tested
`);
    expect(al.entries).toHaveLength(1);
    expect(al.entries[0].path).toBe("$.foo");
    expect(al.entries[0].reason).toBe("tested");
  });

  it("rejects when `entries` is missing", () => {
    expect(() => parseAllowlist(`other: 1`)).toThrow(/entries/);
  });

  it("rejects when an entry lacks `path`", () => {
    expect(() =>
      parseAllowlist(`
entries:
  - reason: only
`)
    ).toThrow(/path/);
  });

  it("rejects when an entry lacks `reason`", () => {
    expect(() =>
      parseAllowlist(`
entries:
  - path: $.foo
`)
    ).toThrow(/reason/);
  });

  it("rejects when `reason` is empty/whitespace", () => {
    expect(() =>
      parseAllowlist(`
entries:
  - path: $.foo
    reason: "  "
`)
    ).toThrow(/reason/);
  });

  it("preserves entry order", () => {
    const al = parseAllowlist(`
entries:
  - path: $.a
    reason: first
  - path: $.b
    reason: second
  - path: $.c
    reason: third
`);
    expect(al.entries.map((e) => e.path)).toEqual(["$.a", "$.b", "$.c"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// compilePathPattern — pattern syntax.
// ─────────────────────────────────────────────────────────────────────────────

describe("compilePathPattern — exact paths", () => {
  it("matches a simple property path exactly", () => {
    const r = compilePathPattern("$.foo.bar");
    expect(r.test("$.foo.bar")).toBe(true);
    expect(r.test("$.foo")).toBe(false);
    expect(r.test("$.foo.bar.baz")).toBe(false);
  });

  it("matches discriminated entry paths", () => {
    const r = compilePathPattern("$[user].message");
    expect(r.test("$[user].message")).toBe(true);
    expect(r.test("$[assistant].message")).toBe(false);
  });

  it("matches array element positions via []", () => {
    const r = compilePathPattern("$.message.content[].input");
    expect(r.test("$.message.content[].input")).toBe(true);
    expect(r.test("$.message.content.input")).toBe(false);
  });
});

describe("compilePathPattern — globs in brackets/braces", () => {
  it("matches discriminator globs", () => {
    const r = compilePathPattern("$.tool[mcp__*].input");
    expect(r.test("$.tool[mcp__github__create_issue].input")).toBe(true);
    expect(r.test("$.tool[mcp__slack__send].input")).toBe(true);
    expect(r.test("$.tool[Bash].input")).toBe(false);
  });

  it("matches record-key globs", () => {
    const r = compilePathPattern("$.toolUseResult{mcp__*}");
    expect(r.test("$.toolUseResult{mcp__chrome_devtools__navigate}")).toBe(true);
    expect(r.test("$.toolUseResult{stdout}")).toBe(false);
  });

  it("`{*}` matches any record-key bucket value (including the comparator's literal `{*}` marker)", () => {
    const r = compilePathPattern("$.snapshot.trackedFileBackups{*}");
    expect(r.test("$.snapshot.trackedFileBackups{*}")).toBe(true);   // comparator's bucket-marker output
    expect(r.test("$.snapshot.trackedFileBackups{foo}")).toBe(true); // capture's per-key path
    expect(r.test("$.snapshot.trackedFileBackups{mcp__bar}")).toBe(true);
    expect(r.test("$.different.path{foo}")).toBe(false);
  });
});

describe("compilePathPattern — trailing .* (transitive)", () => {
  it("matches the parent itself", () => {
    const r = compilePathPattern("$.attachment.*");
    expect(r.test("$.attachment")).toBe(true);
  });

  it("matches direct descendants", () => {
    const r = compilePathPattern("$.attachment.*");
    expect(r.test("$.attachment.foo")).toBe(true);
    expect(r.test("$.attachment.bar.baz")).toBe(true);
  });

  it("does NOT match a sibling outside the parent", () => {
    const r = compilePathPattern("$.attachment.*");
    expect(r.test("$.attached.foo")).toBe(false);
    expect(r.test("$.x.attachment.foo")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// match() — full allowlist matching with precedence.
// ─────────────────────────────────────────────────────────────────────────────

describe("Allowlist.match — precedence", () => {
  it("returns the matched entry's reason", () => {
    const al = parseAllowlist(`
entries:
  - path: $.foo
    reason: foo-reason
`);
    expect(al.match("$.foo")).toBe("foo-reason");
    expect(al.match("$.bar")).toBeNull();
  });

  it("prefers the longer (more specific) entry when multiple match", () => {
    const al = parseAllowlist(`
entries:
  - path: $.toolUseResult.*
    reason: generic
  - path: $.toolUseResult{mcp__*}
    reason: mcp-specific
`);
    // The mcp__* one is longer and should win for an mcp__ key
    expect(al.match("$.toolUseResult{mcp__foo}")).toBe("mcp-specific");
    // Generic catches non-mcp paths under toolUseResult
    expect(al.match("$.toolUseResult.something")).toBe("generic");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// findStaleEntries — entries with no observed match.
// ─────────────────────────────────────────────────────────────────────────────

describe("findStaleEntries", () => {
  it("returns entries that match zero observed paths", () => {
    const al = parseAllowlist(`
entries:
  - path: $.live
    reason: actively-used
  - path: $.dead
    reason: nothing-here-anymore
`);
    const stale = findStaleEntries(al, ["$.live", "$.unrelated"]);
    expect(stale.map((e) => e.path)).toEqual(["$.dead"]);
  });

  it("returns empty when every entry matches at least one observed path", () => {
    const al = parseAllowlist(`
entries:
  - path: $.x
    reason: x
  - path: $.y
    reason: y
`);
    expect(findStaleEntries(al, ["$.x", "$.y"])).toEqual([]);
  });
});
