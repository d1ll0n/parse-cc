import { describe, it, expect } from "vitest";
import { analyzeCompaction } from "../../src/derive/compaction.js";
import type { LogEntry } from "../../src/types/entries.js";

const assistant = (input: number, cacheRead = 0, cacheCreation = 0): LogEntry => ({
  type: "assistant",
  uuid: "a",
  parentUuid: null,
  timestamp: "t",
  sessionId: "s",
  message: {
    role: "assistant",
    id: "m",
    model: "claude-sonnet-4-6",
    content: [],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: input,
      output_tokens: 0,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheCreation,
    },
  },
});

const compact = (): LogEntry => ({
  type: "user",
  uuid: "u",
  parentUuid: null,
  timestamp: "t",
  sessionId: "s",
  isCompactSummary: true,
  message: { role: "user", content: "compaction summary" },
});

describe("analyzeCompaction", () => {
  it("returns a single phase when there is no compaction", () => {
    const r = analyzeCompaction([assistant(10, 90)]);
    expect(r.contextConsumption).toBe(100);
    expect(r.phases).toHaveLength(1);
    expect(r.phases[0].contribution).toBe(100);
    expect(r.compactionCount).toBe(0);
  });

  it("tracks a compaction event with pre/post values", () => {
    const entries: LogEntry[] = [
      assistant(0, 100), // pre-compaction: 100
      compact(),
      assistant(0, 40), // post-compaction: 40 (new phase start)
      assistant(0, 80), // final: 80
    ];
    const r = analyzeCompaction(entries);
    // Phase 1 contribution = 100 (up to compaction)
    // Phase 2 contribution = 80 - 40 = 40
    expect(r.phases).toHaveLength(2);
    expect(r.phases[0].contribution).toBe(100);
    expect(r.phases[1].contribution).toBe(40);
    expect(r.contextConsumption).toBe(140);
    expect(r.compactionCount).toBe(1);
  });

  it("returns undefined contextConsumption when no assistant entries", () => {
    const r = analyzeCompaction([]);
    expect(r.contextConsumption).toBeUndefined();
    expect(r.phases).toEqual([]);
  });

  it("ignores sidechain assistant entries", () => {
    const sideAssistant: LogEntry = {
      ...(assistant(0, 50) as LogEntry),
      isSidechain: true,
    } as LogEntry;
    const r = analyzeCompaction([sideAssistant, assistant(0, 100)]);
    // Only the main-thread entry contributes
    expect(r.contextConsumption).toBe(100);
  });

  it("ignores assistant entries with model <synthetic>", () => {
    const base = assistant(0, 50);
    const synth: LogEntry = {
      ...base,
      message: {
        ...(base as { type: "assistant"; message: Record<string, unknown> }).message,
        model: "<synthetic>",
      },
    } as LogEntry;
    const r = analyzeCompaction([synth, assistant(0, 100)]);
    expect(r.contextConsumption).toBe(100);
  });

  it("treats missing cache token fields as zero via ?? 0 fallback", () => {
    // Assistant entry with only input_tokens — no cache fields at all
    const entry: LogEntry = {
      type: "assistant",
      uuid: "a",
      parentUuid: null,
      timestamp: "t",
      sessionId: "s",
      message: {
        role: "assistant",
        id: "m",
        model: "claude-sonnet-4-6",
        content: [],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 50, output_tokens: 0 } as {
          input_tokens: number;
          output_tokens: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        },
      },
    };
    const r = analyzeCompaction([entry]);
    expect(r.contextConsumption).toBe(50);
  });

  it("skips assistant entries with all-zero token counts (inputTokens == 0)", () => {
    // An assistant entry with all tokens = 0 is skipped by the inputTokens > 0 guard
    // followed by an entry with real tokens, ensuring the guard's false branch is covered
    const entries: LogEntry[] = [
      assistant(0, 0, 0), // inputTokens = 0, skipped by guard
      assistant(0, 80), // inputTokens = 80, processed normally
    ];
    const r = analyzeCompaction(entries);
    expect(r.contextConsumption).toBe(80);
  });

  it("handles assistant entry with undefined token fields via ?? 0 fallback", () => {
    // An entry where input_tokens is undefined — exercises the ?? 0 branches
    const entry: LogEntry = {
      type: "assistant",
      uuid: "a",
      parentUuid: null,
      timestamp: "t",
      sessionId: "s",
      message: {
        role: "assistant",
        id: "m",
        model: "claude-sonnet-4-6",
        content: [],
        stop_reason: "end_turn",
        stop_sequence: null,
        // Cast to force undefined fields for branch coverage
        usage: {} as { input_tokens: number; output_tokens: number },
      },
    };
    // All undefined → inputTokens = 0 → skipped by guard → no assistant processed
    const r = analyzeCompaction([entry]);
    expect(r.contextConsumption).toBeUndefined();
  });

  it("handles two compaction events (three phases)", () => {
    // Phase 1: grows to 100, then compact
    // Phase 2: starts at 40, grows to 80, then compact
    // Phase 3: starts at 30, ends at 90
    const entries: LogEntry[] = [
      assistant(0, 100), // pre-compaction 1: 100
      compact(),
      assistant(0, 40), // post-compaction 1: 40 — also pre-compaction 2 start
      assistant(0, 80), // pre-compaction 2: 80
      compact(),
      assistant(0, 30), // post-compaction 2: 30
      assistant(0, 90), // final: 90
    ];
    const r = analyzeCompaction(entries);
    expect(r.compactionCount).toBe(2);
    expect(r.phases).toHaveLength(3);
    // Phase 1 contribution = 100
    expect(r.phases[0].contribution).toBe(100);
    expect(r.phases[0].postCompaction).toBe(40);
    // Phase 2 contribution = 80 - 40 = 40
    expect(r.phases[1].contribution).toBe(40);
    expect(r.phases[1].postCompaction).toBe(30);
    // Phase 3 contribution = 90 - 30 = 60
    expect(r.phases[2].contribution).toBe(60);
    expect(r.contextConsumption).toBe(200);
  });
});
