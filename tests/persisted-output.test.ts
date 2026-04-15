import { describe, it, expect } from "vitest";
import { parsePersistedOutput, loadPersistedOutput } from "../src/persisted-output.js";
import path from "node:path";

const sample = (absPath: string) =>
  `<persisted-output>\nOutput too large (51.3KB). Full output saved to: ${absPath}\n\nPreview (first 2KB):\nfoo\nbar\n`;

describe("parsePersistedOutput", () => {
  it("extracts path, size label and preview", () => {
    const abs = "/abs/path/to/tool-results/toolu_abc.json";
    const ref = parsePersistedOutput(sample(abs));
    expect(ref).not.toBeNull();
    expect(ref?.filePath).toBe(abs);
    expect(ref?.sizeLabel).toBe("51.3KB");
    expect(ref?.preview).toContain("foo");
    expect(ref?.preview).toContain("bar");
  });

  it("returns null for non-persisted content", () => {
    expect(parsePersistedOutput("just a normal string")).toBeNull();
    expect(parsePersistedOutput({ nope: true } as unknown as string)).toBeNull();
    expect(parsePersistedOutput(null)).toBeNull();
    expect(parsePersistedOutput(undefined)).toBeNull();
  });

  it("returns null when content is a ContentBlock array (not a string)", () => {
    expect(parsePersistedOutput([{ type: "text", text: "hi" }] as unknown)).toBeNull();
  });
});

describe("loadPersistedOutput", () => {
  it("returns ContentBlock[] for .json files", async () => {
    const abs = path.resolve("tests/fixtures/persisted-output/toolu_abc.json");
    const result = await loadPersistedOutput({
      filePath: abs,
      sizeLabel: "",
      preview: "",
    });
    expect(Array.isArray(result)).toBe(true);
    expect((result as { type: string }[])[0]).toMatchObject({ type: "text" });
  });

  it("returns raw string for .txt files", async () => {
    const abs = path.resolve("tests/fixtures/persisted-output/toolu_abc.txt");
    const result = await loadPersistedOutput({
      filePath: abs,
      sizeLabel: "",
      preview: "",
    });
    expect(typeof result).toBe("string");
    expect(result).toContain("full raw text");
  });
});
