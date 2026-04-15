import { describe, it, expect } from "vitest";
import { extractFirstUserMessage } from "../../src/derive/first-message.js";
import type { LogEntry } from "../../src/types/entries.js";

const user = (content: unknown, ts: string): LogEntry => ({
  type: "user",
  uuid: "u",
  parentUuid: null,
  timestamp: ts,
  sessionId: "s",
  message: { role: "user", content: content as string },
});

describe("extractFirstUserMessage", () => {
  it("returns first plain user text", () => {
    const got = extractFirstUserMessage([
      user("<local-command-caveat>ignored</local-command-caveat>", "t1"),
      user("tell me a joke", "t2"),
    ]);
    expect(got?.text).toBe("tell me a joke");
    expect(got?.timestamp).toBe("t2");
  });

  it("falls back to command name when no plain text is seen", () => {
    const got = extractFirstUserMessage([user("<command-name>/model</command-name>", "t1")]);
    expect(got?.text).toBe("/model");
  });

  it("prefers plain text over command name when both exist", () => {
    const got = extractFirstUserMessage([
      user("<command-name>/foo</command-name>", "t1"),
      user("real prompt", "t2"),
    ]);
    expect(got?.text).toBe("real prompt");
  });

  it("returns null when nothing usable", () => {
    expect(extractFirstUserMessage([])).toBeNull();
  });

  it("truncates long messages to 500 chars", () => {
    const long = "a".repeat(2000);
    const got = extractFirstUserMessage([user(long, "t")]);
    expect(got?.text).toHaveLength(500);
  });

  it("extracts text from ContentBlock array content", () => {
    const e: LogEntry = {
      type: "user",
      uuid: "u",
      parentUuid: null,
      timestamp: "t1",
      sessionId: "s",
      message: {
        role: "user",
        content: [
          { type: "text", text: "block one" },
          { type: "text", text: "block two" },
        ],
      },
    };
    const got = extractFirstUserMessage([e]);
    expect(got?.text).toBe("block one block two");
  });

  it("skips messages that start with [Request interrupted", () => {
    const got = extractFirstUserMessage([
      user("[Request interrupted by user for input]", "t1"),
      user("real question", "t2"),
    ]);
    expect(got?.text).toBe("real question");
    expect(got?.timestamp).toBe("t2");
  });

  it("skips user entries with empty or whitespace-only content", () => {
    const got = extractFirstUserMessage([
      user("   ", "t1"), // whitespace only → text.trim() = "" → skipped
      user("actual content", "t2"),
    ]);
    expect(got?.text).toBe("actual content");
    expect(got?.timestamp).toBe("t2");
  });

  it("skips non-text blocks in ContentBlock array (e.g. tool_result)", () => {
    const e: LogEntry = {
      type: "user",
      uuid: "u",
      parentUuid: null,
      timestamp: "t1",
      sessionId: "s",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "output" },
          { type: "text", text: "human follow-up" },
        ] as never,
      },
    };
    const got = extractFirstUserMessage([e]);
    expect(got?.text).toBe("human follow-up");
  });
});
