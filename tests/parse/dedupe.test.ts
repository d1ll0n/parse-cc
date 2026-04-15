import { describe, it, expect } from "vitest";
import { deduplicateByRequestId } from "../../src/parse/dedupe.js";
import type { LogEntry } from "../../src/types/entries.js";

const assistant = (uuid: string, requestId: string, outputTokens: number): LogEntry => ({
  type: "assistant",
  uuid,
  parentUuid: null,
  timestamp: "2026-04-10T00:00:00Z",
  sessionId: "s1",
  requestId,
  message: {
    role: "assistant",
    id: "m",
    model: "claude-sonnet-4-6",
    content: [],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: outputTokens },
  },
});

describe("deduplicateByRequestId", () => {
  it("keeps only the last entry per requestId", () => {
    const entries: LogEntry[] = [
      assistant("a1", "req1", 10),
      assistant("a2", "req1", 25),
      assistant("a3", "req2", 5),
      assistant("a4", "req1", 50),
    ];
    const deduped = deduplicateByRequestId(entries);
    expect(deduped).toHaveLength(2);
    expect(deduped[0]).toMatchObject({ uuid: "a3" });
    expect(deduped[1]).toMatchObject({ uuid: "a4" });
  });

  it("passes through entries without a requestId", () => {
    const entries: LogEntry[] = [
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        timestamp: "",
        sessionId: "s1",
        message: { role: "user", content: "hi" },
      },
      assistant("a1", "req1", 10),
    ];
    const deduped = deduplicateByRequestId(entries);
    expect(deduped).toHaveLength(2);
  });

  it("returns input unchanged if no requestIds present", () => {
    const entries: LogEntry[] = [
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        timestamp: "",
        sessionId: "s1",
        message: { role: "user", content: "hi" },
      },
    ];
    expect(deduplicateByRequestId(entries)).toEqual(entries);
  });
});
