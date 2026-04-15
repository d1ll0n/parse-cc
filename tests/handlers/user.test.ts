import { describe, it, expect } from "vitest";
import { handleUser } from "../../src/handlers/user.js";
import type { UserEntry } from "../../src/types/entries.js";
import type { ContentBlock } from "../../src/types/content.js";
import type { ToolUseResultData } from "../../src/types/tool-results.js";

function mkUser(content: string | ContentBlock[], toolUseResult?: ToolUseResultData): UserEntry {
  return {
    type: "user",
    uuid: "u1",
    parentUuid: null,
    timestamp: "2026-01-01T00:00:00Z",
    sessionId: "s1",
    message: { role: "user", content },
    toolUseResult,
  };
}

describe("handleUser", () => {
  it("handles plain text user messages", () => {
    const entry = mkUser("Please review the codebase");
    const result = handleUser(entry);
    expect(result.role).toBe("user");
    expect(result.text).toBe("Please review the codebase");
    expect(result.toolResults).toBeUndefined();
  });

  it("handles user message with text blocks (array content)", () => {
    const entry = mkUser([{ type: "text", text: "Here is my request" }]);
    const result = handleUser(entry);
    expect(result.text).toBe("Here is my request");
  });

  it("handles tool_result blocks in user messages", () => {
    const entry = mkUser(
      [
        {
          type: "tool_result",
          tool_use_id: "toolu_abc",
          content: "No files found",
        },
      ],
      { filenames: [], durationMs: 10, numFiles: 0 }
    );
    const result = handleUser(entry);
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults![0].toolUseId).toBe("toolu_abc");
    expect(result.toolResults![0].content).toBe("No files found");
  });

  it("handles mixed text and tool_result blocks", () => {
    const entry = mkUser([
      { type: "text", text: "Some context" },
      { type: "tool_result", tool_use_id: "toolu_abc", content: "result data" },
    ]);
    const result = handleUser(entry);
    expect(result.text).toBe("Some context");
    expect(result.toolResults).toHaveLength(1);
  });

  it("skips system-reminder text blocks", () => {
    const entry = mkUser([
      { type: "text", text: "<system-reminder>The task tools haven't been used recently.</system-reminder>" },
      { type: "text", text: "My actual message" },
    ]);
    const result = handleUser(entry);
    expect(result.text).toBe("My actual message");
  });
});
