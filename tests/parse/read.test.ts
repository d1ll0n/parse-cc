import { describe, it, expect } from "vitest";
import { readJsonlFile } from "../../src/parse/read.js";

describe("readJsonlFile", () => {
  it("reads each non-empty line as a parsed JSON object", async () => {
    const entries = await readJsonlFile("tests/fixtures/modern-session.jsonl");
    expect(entries).toHaveLength(3);
    expect((entries[0] as { type: string }).type).toBe("permission-mode");
    expect((entries[1] as { type: string }).type).toBe("user");
    expect((entries[2] as { type: string }).type).toBe("assistant");
  });

  it("skips blank lines", async () => {
    const { writeFile, unlink } = await import("node:fs/promises");
    const tmp = "tests/fixtures/blank-lines.jsonl";
    await writeFile(tmp, '\n{"type":"x"}\n\n{"type":"y"}\n');
    try {
      const entries = await readJsonlFile(tmp);
      expect(entries).toHaveLength(2);
    } finally {
      await unlink(tmp).catch(() => {});
    }
  });

  it("silently skips malformed JSON lines", async () => {
    const { writeFile, unlink } = await import("node:fs/promises");
    const tmp = `${process.env.TMPDIR ?? "/tmp"}/malformed-test.jsonl`;
    await writeFile(tmp, '{"type":"good"}\nnot-json-at-all\n{"type":"also-good"}\n');
    try {
      const entries = await readJsonlFile(tmp);
      expect(entries).toHaveLength(2);
    } finally {
      await unlink(tmp).catch(() => {});
    }
  });
});
