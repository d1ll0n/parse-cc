import { describe, it, expect } from "vitest";
import { extractDeferredTools } from "../../src/derive/deferred-tools.js";
import type { LogEntry } from "../../src/types/entries.js";

const delta = (added: string[], removed: string[] = []): LogEntry => ({
  type: "attachment",
  uuid: "a",
  parentUuid: null,
  timestamp: "t",
  sessionId: "s",
  attachment: {
    type: "deferred_tools_delta",
    addedNames: added,
    addedLines: added,
    removedNames: removed,
  },
});

describe("extractDeferredTools", () => {
  it("unions added names across deltas", () => {
    const got = extractDeferredTools([delta(["A", "B"]), delta(["C"])]);
    expect(got).toEqual(["A", "B", "C"]);
  });

  it("applies removals", () => {
    const got = extractDeferredTools([delta(["A", "B", "C"]), delta([], ["B"])]);
    expect(got).toEqual(["A", "C"]);
  });

  it("returns empty when no deltas", () => {
    expect(extractDeferredTools([])).toEqual([]);
  });

  it("ignores non-attachment entries", () => {
    const got = extractDeferredTools([
      {
        type: "user",
        uuid: "u",
        parentUuid: null,
        timestamp: "t",
        sessionId: "s",
        message: { role: "user", content: "hi" },
      },
      delta(["X"]),
    ]);
    expect(got).toEqual(["X"]);
  });
});
