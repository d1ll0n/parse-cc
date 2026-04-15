import { describe, it, expect } from "vitest";
import { parseEntry } from "../../src/parse/entry.js";
import {
  isQueueOperationEntry,
  isPermissionModeEntry,
  type LogEntry,
} from "../../src/types/entries.js";
import { isImageBlock, type ContentBlock } from "../../src/types/content.js";

describe("parseEntry", () => {
  it("passes through an assistant entry with no transformation", () => {
    const raw = {
      type: "assistant",
      uuid: "a1",
      parentUuid: null,
      timestamp: "2026-04-10T00:00:00Z",
      sessionId: "s1",
      message: {
        role: "assistant",
        id: "m1",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "hi" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    };
    const entry = parseEntry(raw);
    expect(entry?.type).toBe("assistant");
    if (entry && entry.type === "assistant") {
      expect(entry.message.content[0]).toEqual({ type: "text", text: "hi" });
    }
  });

  it("tags unrecognized types as UnknownEntry but preserves them", () => {
    const raw = { type: "brand-new-type", foo: 1 };
    const entry = parseEntry(raw);
    expect(entry?.type).toBe("brand-new-type");
    expect((entry as { foo: number }).foo).toBe(1);
  });

  it("returns null for malformed input (no type field)", () => {
    expect(parseEntry({})).toBeNull();
    expect(parseEntry(null)).toBeNull();
    expect(parseEntry("string")).toBeNull();
  });
});

describe("entry type guards", () => {
  const base = { uuid: "u", parentUuid: null, timestamp: "t", sessionId: "s" };

  it("isQueueOperationEntry returns true for queue-operation type", () => {
    const e: LogEntry = { ...base, type: "queue-operation", operation: "enqueue" } as unknown as LogEntry;
    expect(isQueueOperationEntry(e)).toBe(true);
    const other: LogEntry = { ...base, type: "user", message: { role: "user", content: "x" } };
    expect(isQueueOperationEntry(other)).toBe(false);
  });

  it("isPermissionModeEntry returns true for permission-mode type", () => {
    const e: LogEntry = { ...base, type: "permission-mode", permissionMode: "acceptEdits" } as unknown as LogEntry;
    expect(isPermissionModeEntry(e)).toBe(true);
    const other: LogEntry = { ...base, type: "user", message: { role: "user", content: "x" } };
    expect(isPermissionModeEntry(other)).toBe(false);
  });
});

describe("content block type guards", () => {
  it("isImageBlock returns true only for image blocks", () => {
    const img: ContentBlock = { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } };
    expect(isImageBlock(img)).toBe(true);
    const txt: ContentBlock = { type: "text", text: "hello" };
    expect(isImageBlock(txt)).toBe(false);
  });
});
