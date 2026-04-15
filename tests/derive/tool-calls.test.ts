import { describe, it, expect } from "vitest";
import { extractToolCalls, extractToolResults } from "../../src/derive/tool-calls.js";
import type { LogEntry } from "../../src/types/entries.js";

describe("extractToolCalls", () => {
  it("returns tool_use blocks with entry uuid and isTask flag", () => {
    const entries: LogEntry[] = [
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: null,
        timestamp: "t",
        sessionId: "s",
        message: {
          role: "assistant",
          id: "m",
          model: "x",
          content: [
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
            { type: "tool_use", id: "t2", name: "Agent", input: { prompt: "go" } },
          ],
          stop_reason: "tool_use",
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
    ];
    const calls = extractToolCalls(entries);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ id: "t1", name: "Bash", entryUuid: "a1", isTask: false });
    expect(calls[1].isTask).toBe(true);
  });

  it("returns empty array when no assistant entries", () => {
    expect(extractToolCalls([])).toEqual([]);
  });
});

describe("extractToolResults", () => {
  it("returns tool_result blocks with entry uuid and is_error flag", () => {
    const entries: LogEntry[] = [
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        timestamp: "t",
        sessionId: "s",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "ok" },
            { type: "tool_result", tool_use_id: "t2", content: "err", is_error: true },
          ],
        },
      },
    ];
    const results = extractToolResults(entries);
    expect(results).toHaveLength(2);
    expect(results[1].isError).toBe(true);
  });

  it("skips user entries whose content is a string", () => {
    const entries: LogEntry[] = [
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        timestamp: "t",
        sessionId: "s",
        message: { role: "user", content: "plain text" },
      },
    ];
    expect(extractToolResults(entries)).toEqual([]);
  });
});
