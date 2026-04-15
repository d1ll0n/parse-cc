import { describe, it, expect } from "vitest";
import { handleAssistant } from "../../src/handlers/assistant.js";
import type { AssistantEntry } from "../../src/types/entries.js";
import type { ContentBlock } from "../../src/types/content.js";

function makeEntry(content: ContentBlock[]): AssistantEntry {
  return {
    type: "assistant",
    uuid: "a1",
    parentUuid: null,
    timestamp: "2026-01-01T00:00:00Z",
    sessionId: "s1",
    message: {
      role: "assistant",
      id: "m1",
      model: "claude-opus-4-6",
      content,
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 50 },
    },
  };
}

describe("handleAssistant", () => {
  it("preserves text blocks as-is", () => {
    const entry = makeEntry([{ type: "text", text: "Hello world" }]);
    const result = handleAssistant(entry);
    expect(result.content).toEqual([{ type: "text", text: "Hello world" }]);
  });

  it("truncates thinking blocks and drops signature", () => {
    const longThinking = "x".repeat(5000);
    const entry = makeEntry([{ type: "thinking", thinking: longThinking, signature: "abc123" }]);
    const result = handleAssistant(entry, { thinkingMaxLen: 200 });
    expect(result.content).toHaveLength(1);
    const block = result.content![0] as { type: "thinking"; summary: string };
    expect(block.type).toBe("thinking");
    expect(block.summary.length).toBeLessThan(5000);
    expect(block.summary).toContain("[truncated");
  });

  it("preserves short thinking blocks", () => {
    const entry = makeEntry([{ type: "thinking", thinking: "short thought", signature: "sig" }]);
    const result = handleAssistant(entry, { thinkingMaxLen: 200 });
    const block = result.content![0] as { type: "thinking"; summary: string };
    expect(block.summary).toBe("short thought");
  });

  it("condenses tool_use blocks — preserves name and truncates large inputs", () => {
    const entry = makeEntry([
      {
        type: "tool_use",
        id: "toolu_abc",
        name: "Write",
        input: { file_path: "/foo/bar.ts", content: "x".repeat(5000) },
      },
    ]);
    const result = handleAssistant(entry, { toolInputMaxLen: 200 });
    const block = result.content![0] as {
      type: "tool_use";
      name: string;
      input: Record<string, unknown>;
    };
    expect(block.name).toBe("Write");
    expect(block.input.file_path).toBe("/foo/bar.ts");
    expect((block.input.content as string).length).toBeLessThan(5000);
  });

  it("handles multiple blocks in order", () => {
    const entry = makeEntry([
      { type: "thinking", thinking: "hmm", signature: "s" },
      { type: "text", text: "I'll do it" },
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
    ]);
    const result = handleAssistant(entry);
    expect(result.content).toHaveLength(3);
    expect(result.content![0].type).toBe("thinking");
    expect(result.content![1].type).toBe("text");
    expect(result.content![2].type).toBe("tool_use");
  });

  it("returns role and timestamp", () => {
    const entry = makeEntry([{ type: "text", text: "hi" }]);
    const result = handleAssistant(entry);
    expect(result.role).toBe("assistant");
    expect(result.timestamp).toBe("2026-01-01T00:00:00Z");
  });

  it("drops empty thinking blocks", () => {
    const entry = makeEntry([
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text: "Hello" },
    ]);
    const result = handleAssistant(entry);
    expect(result.content).toHaveLength(1);
    expect(result.content![0].type).toBe("text");
  });

  it("treats thinking block with undefined thinking as empty (drops it)", () => {
    // block.thinking is undefined — the ?? "" fallback makes it an empty string, so it's dropped
    const entry = makeEntry([
      { type: "thinking", thinking: undefined as unknown as string, signature: "sig" },
      { type: "text", text: "World" },
    ]);
    const result = handleAssistant(entry);
    expect(result.content).toHaveLength(1);
    expect(result.content![0].type).toBe("text");
  });

  it("handles tool_use block with undefined input via ?? {} fallback", () => {
    const entry = makeEntry([
      {
        type: "tool_use",
        id: "t1",
        name: "Bash",
        input: undefined as unknown as Record<string, unknown>,
      },
    ]);
    const result = handleAssistant(entry);
    expect(result.content).toHaveLength(1);
    const block = result.content![0] as {
      type: string;
      name: string;
      input: Record<string, unknown>;
    };
    expect(block.name).toBe("Bash");
    expect(block.input).toEqual({});
  });
});
