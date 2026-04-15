// tests/integration/real-session.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Session } from "../../src/session.js";
import type { PersistedOutputRef } from "../../src/persisted-output.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(__dirname, "../fixtures/integration");
const FIXTURE_SRC = join(FIXTURE_DIR, "session-with-persisted.jsonl");

// The fixture uses ##FIXTURE_DIR## as a placeholder for the absolute path to
// the fixture directory. Substitute it at test-time so the test works on any
// machine regardless of where the repo is checked out.
let FIXTURE: string;
beforeAll(() => {
  const raw = readFileSync(FIXTURE_SRC, "utf8");
  const patched = raw.replaceAll("##FIXTURE_DIR##", FIXTURE_DIR);
  const tmpDir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "pcl-test-"));
  FIXTURE = join(tmpDir, "session-with-persisted.jsonl");
  writeFileSync(FIXTURE, patched, "utf8");
});

describe("real session integration", () => {
  it("parses all messages from a real session", async () => {
    const sess = new Session(FIXTURE);
    const msgs = await sess.messages();
    expect(msgs.length).toBeGreaterThan(0);
    expect(sess.sessionId).toBeTruthy();
    expect(sess.version).toBeTruthy();
    expect(sess.gitBranch).toBe("main");
    expect(sess.cwd).toBe("/home/user/myproject");
  });

  it("computes non-zero metrics", async () => {
    const sess = new Session(FIXTURE);
    const metrics = await sess.metrics();
    expect(metrics.totalTokens).toBeGreaterThan(0);
    expect(metrics.messageCount).toBeGreaterThan(0);
    expect(metrics.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("extracts first user message", async () => {
    const sess = new Session(FIXTURE);
    const first = await sess.firstUserMessage();
    // Real session should have a first user message (either prompt or command name)
    expect(first).not.toBeNull();
    expect(first?.text).toBeTruthy();
  });

  it("extracts tool calls and tool results", async () => {
    const sess = new Session(FIXTURE);
    const calls = await sess.toolCalls();
    const results = await sess.toolResults();
    expect(calls.length).toBeGreaterThan(0);
    expect(results.length).toBeGreaterThan(0);
  });

  it("findToolResult returns non-null for a real ID and null for nonexistent", async () => {
    const sess = new Session(FIXTURE);
    const results = await sess.toolResults();
    expect(results.length).toBeGreaterThan(0);
    const firstId = results[0].toolUseId;
    const found = await sess.findToolResult(firstId);
    expect(found).not.toBeNull();
    expect(found?.toolUseId).toBe(firstId);
    expect(await sess.findToolResult("nonexistent")).toBeNull();
  });

  it("deferredTools returns a non-empty array of tool names", async () => {
    const sess = new Session(FIXTURE);
    const names = await sess.deferredTools();
    expect(Array.isArray(names)).toBe(true);
    expect(names.length).toBeGreaterThan(0);
  });

  it("isOngoing returns true for a session ending with a tool_use", async () => {
    const sess = new Session(FIXTURE);
    expect(await sess.isOngoing()).toBe(true);
  });

  it("skills returns a non-empty names array from skill_listing attachment", async () => {
    const sess = new Session(FIXTURE);
    const info = await sess.skills();
    expect(info.listing).not.toBeNull();
    expect(info.names.length).toBeGreaterThan(0);
  });

  it("compaction returns non-trivial results with at least one phase", async () => {
    const sess = new Session(FIXTURE);
    const result = await sess.compaction();
    expect(result.compactionCount).toBeGreaterThan(0);
    expect(result.phases.length).toBeGreaterThan(1);
    expect(result.contextConsumption).toBeGreaterThan(0);
  });

  it("parses persisted-output references and can load the referenced file", async () => {
    const sess = new Session(FIXTURE);
    const results = await sess.toolResults();

    // Find the first tool_result whose content is a string matching the wrapper
    let persistedRef: PersistedOutputRef | null = null;
    for (const r of results) {
      if (typeof r.content === "string") {
        const ref = sess.parsePersistedOutput(r.content);
        if (ref) {
          persistedRef = ref;
          break;
        }
      }
    }

    expect(persistedRef).not.toBeNull();
    if (!persistedRef) return;

    // Verify we can actually read the referenced file
    const loaded = await sess.loadPersistedOutput(persistedRef);
    expect(loaded).toBeTruthy();
    // .json files load as content block array, .txt files load as string
    if (persistedRef.filePath.endsWith(".json")) {
      expect(Array.isArray(loaded)).toBe(true);
    } else {
      expect(typeof loaded).toBe("string");
    }
  });
});
