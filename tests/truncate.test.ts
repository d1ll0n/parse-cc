import { describe, it, expect } from "vitest";
import { truncateString } from "../src/truncate.js";

describe("truncateString", () => {
  it("returns short strings unchanged", () => {
    expect(truncateString("hello", 100)).toBe("hello");
  });

  it("truncates long strings with char count", () => {
    const long = "x".repeat(200);
    const result = truncateString(long, 50);
    expect(result.length).toBeLessThan(200);
    expect(result).toContain("[truncated");
    expect(result).toContain("200 chars");
  });

  it("handles empty string", () => {
    expect(truncateString("", 100)).toBe("");
  });

  it("handles undefined gracefully", () => {
    expect(truncateString(undefined as unknown as string, 100)).toBe("");
  });

  it("preserves string at exact threshold", () => {
    const exact = "x".repeat(100);
    expect(truncateString(exact, 100)).toBe(exact);
  });
});
