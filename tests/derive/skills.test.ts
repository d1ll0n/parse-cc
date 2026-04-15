import { describe, it, expect } from "vitest";
import { extractSkills } from "../../src/derive/skills.js";
import type { LogEntry } from "../../src/types/entries.js";

const skillListing = (content: string, count = 2): LogEntry => ({
  type: "attachment",
  uuid: "att1",
  parentUuid: null,
  timestamp: "t",
  sessionId: "s",
  attachment: {
    type: "skill_listing",
    content,
    skillCount: count,
    isInitial: true,
  },
});

describe("extractSkills", () => {
  it("parses skill names from the bullet list", () => {
    const entries = [
      skillListing("- simplify: Review changed code\n- loop: Run a prompt on an interval"),
    ];
    const r = extractSkills(entries);
    expect(r.listing?.skillCount).toBe(2);
    expect(r.names).toEqual(["simplify", "loop"]);
  });

  it("returns empty when no skill_listing is present", () => {
    const r = extractSkills([]);
    expect(r.listing).toBeNull();
    expect(r.names).toEqual([]);
  });

  it("returns the first skill_listing when multiple are present", () => {
    const r = extractSkills([
      skillListing("- foo: f", 1),
      skillListing("- bar: b", 1),
    ]);
    expect(r.names).toEqual(["foo"]);
  });

  it("handles plugin-scoped skill names with colons in description", () => {
    const r = extractSkills([
      skillListing("- plugin-dev:plugin-structure: Structure guide for plugins"),
    ]);
    expect(r.names).toEqual(["plugin-dev:plugin-structure"]);
  });

  it("skips bullet lines that have no ': ' separator (sep <= 0)", () => {
    // A line like "- malformed-no-description" has no ": " so sep = -1, skip it
    // Also include a non-bullet line (doesn't start with "- ") to hit the continue branch
    const r = extractSkills([
      skillListing("Available skills:\n- valid-skill: has description\n- no-description\n- another-valid: yes\n"),
    ]);
    expect(r.names).toEqual(["valid-skill", "another-valid"]);
  });
});
