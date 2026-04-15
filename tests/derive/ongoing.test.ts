// tests/derive/ongoing.test.ts
import { describe, it, expect } from "vitest";
import { checkOngoing } from "../../src/derive/ongoing.js";
import type { LogEntry } from "../../src/types/entries.js";

const assistant = (content: unknown[]): LogEntry => ({
  type: "assistant",
  uuid: "a",
  parentUuid: null,
  timestamp: "t",
  sessionId: "s",
  message: {
    role: "assistant",
    id: "m",
    model: "x",
    content: content as never,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  },
});

const userToolResult = (tool_use_id: string, toolUseResult?: unknown): LogEntry => ({
  type: "user",
  uuid: "u",
  parentUuid: null,
  timestamp: "t",
  sessionId: "s",
  toolUseResult: toolUseResult as never,
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id, content: "ok" }],
  },
});

describe("checkOngoing", () => {
  it("is ongoing when last activity is a tool_use with no follow-up", () => {
    const entries = [assistant([{ type: "tool_use", id: "t1", name: "Bash", input: {} }])];
    expect(checkOngoing(entries)).toBe(true);
  });

  it("is not ongoing when last activity is an assistant text block", () => {
    const entries = [assistant([{ type: "text", text: "done" }])];
    expect(checkOngoing(entries)).toBe(false);
  });

  it("is ongoing when a tool_use appears AFTER an assistant text block", () => {
    const entries = [
      assistant([{ type: "text", text: "hold on" }]),
      assistant([{ type: "tool_use", id: "t1", name: "Bash", input: {} }]),
    ];
    expect(checkOngoing(entries)).toBe(true);
  });

  it("treats an empty entry list as not ongoing", () => {
    expect(checkOngoing([])).toBe(false);
  });

  it("treats ExitPlanMode as an ending event", () => {
    const entries = [
      assistant([{ type: "tool_use", id: "t1", name: "ExitPlanMode", input: {} }]),
    ];
    expect(checkOngoing(entries)).toBe(false);
  });

  it("treats user rejection as an ending event", () => {
    const entries = [
      assistant([{ type: "tool_use", id: "t1", name: "Bash", input: {} }]),
      userToolResult("t1", "User rejected tool use"),
    ];
    expect(checkOngoing(entries)).toBe(false);
  });

  it("treats SendMessage shutdown_response.approve=true as an ending", () => {
    const entries = [
      assistant([
        {
          type: "tool_use",
          id: "t1",
          name: "SendMessage",
          input: { type: "shutdown_response", approve: true },
        },
      ]),
    ];
    expect(checkOngoing(entries)).toBe(false);
  });

  it("ignores empty thinking blocks", () => {
    const entries = [
      assistant([{ type: "text", text: "done" }]),
      assistant([{ type: "thinking", thinking: "" }]),
    ];
    expect(checkOngoing(entries)).toBe(false);
  });

  it("counts non-empty thinking blocks as ongoing activity", () => {
    const entries = [
      assistant([{ type: "thinking", thinking: "I am reasoning..." }]),
    ];
    expect(checkOngoing(entries)).toBe(true);
  });

  it("treats [Request interrupted user text block as an ending event", () => {
    const entries = [
      assistant([{ type: "tool_use", id: "t1", name: "Bash", input: {} }]),
      {
        type: "user" as const,
        uuid: "u",
        parentUuid: null as null,
        timestamp: "t",
        sessionId: "s",
        message: {
          role: "user" as const,
          content: [
            { type: "text", text: "[Request interrupted by user]" },
          ],
        },
      },
    ];
    expect(checkOngoing(entries)).toBe(false);
  });

  it("non-shutdown tool_result bumps ongoing after an ending event", () => {
    const entries = [
      assistant([{ type: "text", text: "I'll run this" }]),
      assistant([{ type: "tool_use", id: "t2", name: "Bash", input: {} }]),
      userToolResult("t2"),
    ];
    expect(checkOngoing(entries)).toBe(true);
  });
});
