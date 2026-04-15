import { describe, it, expect } from "vitest";
import { calculateMetrics } from "../../src/derive/metrics.js";
import type { LogEntry } from "../../src/types/entries.js";

const mkAssistant = (ts: string, input: number, output: number): LogEntry => ({
  type: "assistant",
  uuid: ts,
  parentUuid: null,
  timestamp: ts,
  sessionId: "s1",
  message: {
    role: "assistant",
    id: "m",
    model: "claude-sonnet-4-6",
    content: [],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: input, output_tokens: output },
  },
});

describe("calculateMetrics", () => {
  it("sums tokens and computes duration across assistant entries", () => {
    const entries: LogEntry[] = [
      mkAssistant("2026-04-10T00:00:00Z", 10, 5),
      mkAssistant("2026-04-10T00:00:30Z", 20, 15),
    ];
    const m = calculateMetrics(entries);
    expect(m.inputTokens).toBe(30);
    expect(m.outputTokens).toBe(20);
    expect(m.totalTokens).toBe(50);
    expect(m.durationMs).toBe(30_000);
    expect(m.messageCount).toBe(2);
  });

  it("returns zeroed metrics for empty input", () => {
    const m = calculateMetrics([]);
    expect(m.totalTokens).toBe(0);
    expect(m.durationMs).toBe(0);
    expect(m.messageCount).toBe(0);
  });

  it("includes cache tokens in totalTokens", () => {
    const e: LogEntry = {
      type: "assistant",
      uuid: "a",
      parentUuid: null,
      timestamp: "2026-04-10T00:00:00Z",
      sessionId: "s",
      message: {
        role: "assistant",
        id: "m",
        model: "x",
        content: [],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 50,
        },
      },
    };
    const m = calculateMetrics([e]);
    expect(m.cacheReadTokens).toBe(100);
    expect(m.cacheCreationTokens).toBe(50);
    expect(m.totalTokens).toBe(180);
  });

  it("treats missing/undefined usage token fields as zero", () => {
    const e: LogEntry = {
      type: "assistant",
      uuid: "a",
      parentUuid: null,
      timestamp: "2026-04-10T00:00:00Z",
      sessionId: "s",
      message: {
        role: "assistant",
        id: "m",
        model: "x",
        content: [],
        stop_reason: "end_turn",
        stop_sequence: null,
        // Omit input_tokens and cache fields to exercise the ?? 0 fallbacks
        usage: {} as { input_tokens: number; output_tokens: number },
      },
    };
    const m = calculateMetrics([e]);
    expect(m.inputTokens).toBe(0);
    expect(m.outputTokens).toBe(0);
    expect(m.cacheReadTokens).toBe(0);
    expect(m.cacheCreationTokens).toBe(0);
    expect(m.totalTokens).toBe(0);
  });

  it("skips non-assistant entries when computing timestamps", () => {
    const userEntry: LogEntry = {
      type: "user",
      uuid: "u",
      parentUuid: null,
      timestamp: "2026-04-10T00:01:00Z",
      sessionId: "s",
      message: { role: "user", content: "hi" },
    };
    const m = calculateMetrics([userEntry, mkAssistant("2026-04-10T00:00:00Z", 10, 5)]);
    // User entry timestamp should also contribute to min/maxTime
    expect(m.durationMs).toBe(60_000);
  });
});
