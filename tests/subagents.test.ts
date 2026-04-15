import { describe, it, expect } from "vitest";
import { Session } from "../src/session.js";
import { findSubagentFiles } from "../src/subagents.js";

describe("findSubagentFiles", () => {
  it("finds new-layout subagent files", async () => {
    const files = await findSubagentFiles("tests/fixtures/with-subagents/parent.jsonl");
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/agent-x\.jsonl$/);
  });

  it("finds old-layout subagent files filtered by sessionId", async () => {
    const files = await findSubagentFiles("tests/fixtures/with-subagents-legacy/parent.jsonl");
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/agent-x\.jsonl$/);
    expect(files[0]).not.toMatch(/agent-y\.jsonl$/);
  });

  it("returns empty array when no subagents exist", async () => {
    const files = await findSubagentFiles("tests/fixtures/modern-session.jsonl");
    expect(files).toEqual([]);
  });

  it("subagent entries all carry isSidechain=true", async () => {
    const files = await findSubagentFiles("tests/fixtures/with-subagents/parent.jsonl");
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const sub = new Session(f);
      const entries = await sub.messages();
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.isSidechain).toBe(true);
      }
    }
  });

  it("legacy subagent entries all carry isSidechain=true", async () => {
    const files = await findSubagentFiles("tests/fixtures/with-subagents-legacy/parent.jsonl");
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const sub = new Session(f);
      const entries = await sub.messages();
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.isSidechain).toBe(true);
      }
    }
  });

  it("ignores legacy agent files whose first line is empty (returns null sessionId)", async () => {
    // Create a temp parent with a known sessionId and a temp agent file that is empty
    const { writeFile, unlink, mkdir } = await import("node:fs/promises");
    const tmpDir = `${process.env.TMPDIR ?? "/tmp"}/subagent-empty-test`;
    await mkdir(tmpDir, { recursive: true });
    const parentPath = `${tmpDir}/parent.jsonl`;
    const emptyAgentPath = `${tmpDir}/agent-empty.jsonl`;
    // parent has a sessionId; emptyAgent has no content — readFirstLine returns null
    await writeFile(parentPath, '{"type":"user","uuid":"u1","parentUuid":null,"timestamp":"t","sessionId":"sess-tmp","message":{"role":"user","content":"x"}}\n');
    await writeFile(emptyAgentPath, "");
    try {
      const files = await findSubagentFiles(parentPath);
      // empty agent file should not be included (sessionId can't be extracted)
      expect(files.every((f) => !f.includes("agent-empty"))).toBe(true);
    } finally {
      await unlink(parentPath).catch(() => {});
      await unlink(emptyAgentPath).catch(() => {});
    }
  });

  it("ignores legacy agent files whose first line is not valid JSON", async () => {
    const { writeFile, unlink, mkdir } = await import("node:fs/promises");
    const tmpDir = `${process.env.TMPDIR ?? "/tmp"}/subagent-invalid-json-test`;
    await mkdir(tmpDir, { recursive: true });
    const parentPath = `${tmpDir}/parent.jsonl`;
    const badAgentPath = `${tmpDir}/agent-bad.jsonl`;
    await writeFile(parentPath, '{"type":"user","uuid":"u1","parentUuid":null,"timestamp":"t","sessionId":"sess-tmp2","message":{"role":"user","content":"x"}}\n');
    await writeFile(badAgentPath, "not-valid-json\n");
    try {
      const files = await findSubagentFiles(parentPath);
      expect(files.every((f) => !f.includes("agent-bad"))).toBe(true);
    } finally {
      await unlink(parentPath).catch(() => {});
      await unlink(badAgentPath).catch(() => {});
    }
  });

  it("ignores legacy agent files whose JSON has no sessionId field", async () => {
    // Covers the parsed.sessionId ?? null branch (when sessionId field is absent)
    const { writeFile, unlink, mkdir } = await import("node:fs/promises");
    const tmpDir = `${process.env.TMPDIR ?? "/tmp"}/subagent-no-sessionid-test`;
    await mkdir(tmpDir, { recursive: true });
    const parentPath = `${tmpDir}/parent.jsonl`;
    const noIdAgentPath = `${tmpDir}/agent-noid.jsonl`;
    await writeFile(parentPath, '{"type":"user","uuid":"u1","parentUuid":null,"timestamp":"t","sessionId":"sess-tmp3","message":{"role":"user","content":"x"}}\n');
    // First line has valid JSON but no sessionId field → returns null → not matched
    await writeFile(noIdAgentPath, '{"type":"user","uuid":"x"}\n');
    try {
      const files = await findSubagentFiles(parentPath);
      expect(files.every((f) => !f.includes("agent-noid"))).toBe(true);
    } finally {
      await unlink(parentPath).catch(() => {});
      await unlink(noIdAgentPath).catch(() => {});
    }
  });
});
