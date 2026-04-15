// tests/session.test.ts
import { describe, it, expect } from "vitest";
import { Session } from "../src/session.js";

describe("Session", () => {
  it("exposes messages, metrics, and scalar metadata from a real fixture", async () => {
    const sess = new Session("tests/fixtures/modern-session.jsonl");
    const messages = await sess.messages();
    expect(messages).toHaveLength(3);
    expect(sess.sessionId).toBe("sess-1");
    expect(sess.permissionMode).toBe("default");
    const m = await sess.metrics();
    expect(m.messageCount).toBe(3);
  });

  it("caches parsed messages across getter calls", async () => {
    const sess = new Session("tests/fixtures/modern-session.jsonl");
    const a = await sess.messages();
    const b = await sess.messages();
    expect(a).toBe(b);
  });

  it("exposes subagents as lazy Session array", async () => {
    const sess = new Session("tests/fixtures/with-subagents/parent.jsonl");
    const subs = await sess.subagents();
    expect(subs).toHaveLength(1);
    expect(subs[0]).toBeInstanceOf(Session);
    // The sub-session should also be parseable
    const subMessages = await subs[0].messages();
    expect(subMessages.length).toBeGreaterThan(0);

    // Parent entries must all carry isSidechain=false explicitly
    const parentMessages = await sess.messages();
    for (const msg of parentMessages) {
      expect(msg.isSidechain).toBe(false);
    }

    // Parent must have dispatched the subagent via an Agent tool_use
    const parentCalls = await sess.toolCalls();
    const agentDispatch = parentCalls.find((c) => c.isTask);
    expect(agentDispatch).toBeDefined();
    expect(agentDispatch?.name).toBe("Agent");

    // Subagent must include at least one assistant turn (not just the prompt)
    const assistantTurns = subMessages.filter((m) => m.message?.role === "assistant");
    expect(assistantTurns.length).toBeGreaterThan(0);

    // Subagent entries must all carry isSidechain=true
    for (const msg of subMessages) {
      expect(msg.isSidechain).toBe(true);
    }
  });

  it("returns empty subagent array when none exist", async () => {
    const sess = new Session("tests/fixtures/modern-session.jsonl");
    const subs = await sess.subagents();
    expect(subs).toEqual([]);
  });

  it("findToolCall returns null when not found", async () => {
    const sess = new Session("tests/fixtures/modern-session.jsonl");
    await sess.messages();
    expect(await sess.findToolCall("nope")).toBeNull();
  });

  it("findToolCall returns the matching tool call by ID", async () => {
    const sess = new Session("tests/fixtures/with-subagents/parent.jsonl");
    const calls = await sess.toolCalls();
    expect(calls.length).toBeGreaterThan(0);
    const firstId = calls[0].id;
    const found = await sess.findToolCall(firstId);
    expect(found).not.toBeNull();
    expect(found?.name).toBe("Agent");
  });

  it("findToolResult returns null for non-existent ID and non-null for real ID", async () => {
    const sess = new Session("tests/fixtures/with-subagents/parent.jsonl");
    const results = await sess.toolResults();
    expect(results.length).toBeGreaterThan(0);
    const firstId = results[0].toolUseId;
    const found = await sess.findToolResult(firstId);
    expect(found).not.toBeNull();
    expect(found?.toolUseId).toBe(firstId);
    expect(await sess.findToolResult("nonexistent")).toBeNull();
  });

  it("legacy parent: all entries isSidechain=false, Agent tool call, subagent has assistant turns", async () => {
    const sess = new Session("tests/fixtures/with-subagents-legacy/parent.jsonl");
    const parentMessages = await sess.messages();

    // All parent entries must have isSidechain === false
    for (const msg of parentMessages) {
      expect(msg.isSidechain).toBe(false);
    }

    // Parent must have dispatched the subagent via an Agent tool_use
    const parentCalls = await sess.toolCalls();
    const agentDispatch = parentCalls.find((c) => c.isTask);
    expect(agentDispatch).toBeDefined();
    expect(agentDispatch?.name).toBe("Agent");

    // Must discover legacy subagents
    const subs = await sess.subagents();
    expect(subs.length).toBeGreaterThan(0);

    // Subagent must include at least one assistant turn
    const subMessages = await subs[0].messages();
    const assistantTurns = subMessages.filter((m) => m.message?.role === "assistant");
    expect(assistantTurns.length).toBeGreaterThan(0);

    // All subagent entries must have isSidechain === true
    for (const msg of subMessages) {
      expect(msg.isSidechain).toBe(true);
    }
  });

  it("isOngoing returns false for a session ending with an assistant text turn", async () => {
    const sess = new Session("tests/fixtures/modern-session.jsonl");
    expect(await sess.isOngoing()).toBe(false);
  });

  it("throws a descriptive error when scalar getter is accessed before messages()", () => {
    const sess = new Session("tests/fixtures/modern-session.jsonl");
    expect(() => sess.sessionId).toThrow(/accessed before metadata loaded/);
    expect(() => sess.version).toThrow(/accessed before metadata loaded/);
  });

  it("returns empty string for sessionId when no entries have a sessionId", async () => {
    const sess = new Session("tests/fixtures/no-session-id.jsonl");
    await sess.messages();
    // sessionId is absent in all entries → _meta.sessionId is undefined → ?? "" returns ""
    expect(sess.sessionId).toBe("");
  });

  it("sets blobPath to null when blob file is missing from disk", async () => {
    const sess = new Session("tests/fixtures/file-history-missing-blob/sess.jsonl");
    const versions = await sess.fileHistory("tests/fixtures/file-history-missing-blob-store");
    // Both snapshots reference blobs that don't exist in the store
    expect(versions.length).toBeGreaterThanOrEqual(1);
    const notesVersion = versions.find((v) => v.filePath === "notes.md");
    expect(notesVersion).toBeDefined();
    expect(notesVersion?.backupFileName).toBe("deadbeef@v1");
    // blobPath is nulled out because stat failed
    expect(notesVersion?.blobPath).toBeNull();
    expect(notesVersion?.size).toBeNull();
    // Multiple different filePaths → sort by filePath exercises the p !== 0 branch
    const filePaths = versions.map((v) => v.filePath);
    expect(new Set(filePaths).size).toBeGreaterThan(1);
  });

  it("exposes file history versions joined with on-disk blobs", async () => {
    const sess = new Session("tests/fixtures/file-history-session/sess.jsonl");
    const versions = await sess.fileHistory("tests/fixtures/file-history-store");
    // Two snapshot entries track the same file at v1 (placeholder) and v2 (real blob)
    expect(versions).toHaveLength(2);

    const v1 = versions.find((v) => v.version === 1);
    expect(v1).toBeDefined();
    expect(v1?.filePath).toBe("notes.md");
    expect(v1?.backupFileName).toBeNull();
    expect(v1?.blobPath).toBeNull();

    const v2 = versions.find((v) => v.version === 2);
    expect(v2).toBeDefined();
    expect(v2?.backupFileName).toBe("abc123@v2");
    expect(v2?.blobPath).toMatch(/abc123@v2$/);
    expect(v2?.size).toBeGreaterThan(0);

    // Reading the v2 blob should return its contents
    const content = await sess.readFileHistoryContent(v2!);
    expect(content).toContain("backed-up version");
  });
});
