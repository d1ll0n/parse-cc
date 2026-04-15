import { describe, it, expect } from "vitest";
import { condenseTool } from "../../src/handlers/tool-results.js";
import type { ToolResultBlock, ContentBlock } from "../../src/types/content.js";

function mkBlock(
  content: string | ContentBlock[],
  isError = false,
  toolUseId = "toolu_1"
): ToolResultBlock {
  return { type: "tool_result", tool_use_id: toolUseId, content, is_error: isError };
}

describe("condenseTool", () => {
  describe("content truncation", () => {
    it("preserves short string content", () => {
      const result = condenseTool("toolu_1", mkBlock("No files found"));
      expect(result.content).toBe("No files found");
    });

    it("truncates long string content", () => {
      const result = condenseTool("toolu_1", mkBlock("x".repeat(5000)), undefined, {
        resultMaxLen: 200,
      });
      expect(result.content.length).toBeLessThan(5000);
      expect(result.content).toContain("[truncated");
    });

    it("replaces image blocks with placeholder", () => {
      const result = condenseTool(
        "toolu_1",
        mkBlock([
          { type: "text", text: "### Result\nScreenshot taken" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "x".repeat(10000) },
          },
        ])
      );
      expect(result.content).toContain("Screenshot taken");
      expect(result.content).toContain("[image: image/png]");
      expect(result.content).not.toContain("x".repeat(100));
    });

    it("extracts persisted-output references into content+persistedOutput fields", () => {
      const wrapper = `<persisted-output>\nOutput too large (51.3KB). Full output saved to: /some/path.json\n\nPreview (first 2KB):\nSome preview content here...\n`;
      const result = condenseTool("toolu_1", mkBlock(wrapper));
      expect(result.content).toContain("Some preview content");
      expect(result.content).not.toContain("Full output saved to");
      expect(result.persistedOutput).toEqual({
        filePath: "/some/path.json",
        sizeLabel: "51.3KB",
      });
    });

    it("handles tool_reference blocks as an extension type", () => {
      // tool_reference is a runtime-only type outside the main ContentBlock union
      const result = condenseTool(
        "toolu_1",
        mkBlock([
          { type: "tool_reference", tool_name: "mcp__browser_navigate" } as unknown as ContentBlock,
        ])
      );
      expect(result.content).toContain("mcp__browser_navigate");
    });
  });

  describe("toolUseResult metadata truncation", () => {
    it("strips Write content and originalFile", () => {
      const result = condenseTool("toolu_1", mkBlock("File created successfully at: /foo/bar.ts"), {
        type: "create",
        filePath: "/foo/bar.ts",
        content: "x".repeat(5000),
        originalFile: "y".repeat(3000),
        structuredPatch: [],
      });
      expect(result.metadata).toBeDefined();
      expect(result.metadata!.filePath).toBe("/foo/bar.ts");
      expect(result.metadata!.type).toBe("create");
      expect(result.metadata!.content).toBeUndefined();
      expect(result.metadata!.originalFile).toBeUndefined();
    });

    it("drops Edit metadata entirely (redundant with tool_use input)", () => {
      const result = condenseTool(
        "toolu_1",
        mkBlock("The file has been updated successfully."),
        {
          filePath: "/foo/bar.ts",
          oldString: "x".repeat(3000),
          newString: "y".repeat(3000),
          originalFile: "z".repeat(10000),
          structuredPatch: [],
        },
        { resultMaxLen: 300 }
      );
      expect(result.metadata).toBeUndefined();
    });

    it("strips Read file content, preserves filePath", () => {
      const result = condenseTool("toolu_1", mkBlock("1\tline one\n2\tline two\n"), {
        type: "text",
        file: { filePath: "/foo/bar.ts", content: "x".repeat(5000) },
      });
      expect(result.metadata!.filePath).toBe("/foo/bar.ts");
      expect(result.metadata!.content).toBeUndefined();
    });

    it("drops Bash metadata entirely (duplicates tool_result content)", () => {
      const result = condenseTool(
        "toolu_1",
        mkBlock("x".repeat(5000)),
        { stdout: "x".repeat(5000), stderr: "y".repeat(3000) },
        { resultMaxLen: 300 }
      );
      expect(result.metadata).toBeUndefined();
    });

    it("strips Agent content, preserves summary fields", () => {
      const result = condenseTool("toolu_1", mkBlock("Agent completed"), {
        status: "completed",
        prompt: "Do a thing",
        agentId: "abc",
        agentType: "Explore",
        content: "x".repeat(10000),
        totalDurationMs: 5000,
        totalTokens: 12000,
        totalToolUseCount: 8,
      });
      expect(result.metadata!.status).toBe("completed");
      expect(result.metadata!.agentId).toBe("abc");
      expect(result.metadata!.totalTokens).toBe(12000);
      expect(result.metadata!.content).toBeUndefined();
    });

    it("stripLargeValues: replaces nested image objects with placeholder string", () => {
      // A toolUseResult with an embedded image object (not caught by any named handler)
      const result = condenseTool("toolu_1", mkBlock("ok"), {
        someKey: "plain string",
        screenshot: {
          type: "image",
          source: { media_type: "image/jpeg", data: "x".repeat(50000) },
        },
      });
      expect(result.metadata!.someKey).toBe("plain string");
      expect(result.metadata!.screenshot).toBe("[image: image/jpeg]");
    });

    it("stripLargeValues: processes array values — truncates strings, recurses objects", () => {
      const result = condenseTool("toolu_1", mkBlock("ok"), {
        items: ["short", "x".repeat(2000), { nested: "value", big: "y".repeat(2000) }, 42],
      });
      const items = result.metadata!.items as unknown[];
      expect(items[0]).toBe("short");
      expect((items[1] as string).length).toBeLessThan(2000);
      expect((items[2] as Record<string, unknown>).nested).toBe("value");
      expect(((items[2] as Record<string, unknown>).big as string).length).toBeLessThan(2000);
      expect(items[3]).toBe(42);
    });

    it("stripLargeValues: recurses into non-image nested objects", () => {
      // A toolUseResult with a nested object that is not an image
      const result = condenseTool("toolu_1", mkBlock("ok"), {
        meta: {
          description: "x".repeat(3000),
          count: 5,
        },
      });
      const meta = result.metadata!.meta as Record<string, unknown>;
      expect((meta.description as string).length).toBeLessThan(3000);
      expect(meta.count).toBe(5);
    });

    it("condenseMetadata called with toolUseResult in the persisted-output path", () => {
      const wrapper = `<persisted-output>\nOutput too large (10KB). Full output saved to: /some/output.json\n\nPreview (first 2KB):\npreview line...\n`;
      // Pass a toolUseResult that will go through condenseMetadata (default stripLargeValues path)
      const result = condenseTool("toolu_1", mkBlock(wrapper), {
        someExtra: "metadata here",
      });
      expect(result.persistedOutput).toBeDefined();
      expect(result.content).toContain("preview line");
      expect(result.metadata!.someExtra).toBe("metadata here");
    });

    it("persisted-output path: condenseMetadata returning null yields undefined metadata", () => {
      const wrapper = `<persisted-output>\nOutput too large (1KB). Full output saved to: /some/file.txt\n\nPreview (first 2KB):\nsome preview\n`;
      // Edit toolUseResult → condenseMetadata returns null → metadata becomes undefined
      const result = condenseTool("toolu_1", mkBlock(wrapper), {
        oldString: "old",
        newString: "new",
      });
      expect(result.persistedOutput).toBeDefined();
      expect(result.metadata).toBeUndefined();
    });

    it("Write detection via structuredPatch (without type field)", () => {
      // Object has filePath + content + structuredPatch but no 'type' field
      // This hits the 'structuredPatch' in tr branch on line 87
      const result = condenseTool("toolu_1", mkBlock("File updated"), {
        filePath: "/foo/bar.ts",
        content: "x".repeat(5000),
        structuredPatch: [{ op: "replace" }],
      });
      expect(result.metadata!.filePath).toBe("/foo/bar.ts");
      expect(result.metadata!.content).toBeUndefined();
    });

    it("Write detection with type: update", () => {
      // Covers the tr.type === 'update' branch
      const result = condenseTool("toolu_1", mkBlock("File updated at /foo/bar.ts"), {
        type: "update",
        filePath: "/foo/bar.ts",
        content: "x".repeat(5000),
        originalFile: "old content",
        structuredPatch: [],
      });
      expect(result.metadata!.filePath).toBe("/foo/bar.ts");
      expect(result.metadata!.type).toBe("update");
      expect(result.metadata!.content).toBeUndefined();
    });

    it("stripLargeValues: image source with unknown media_type uses fallback", () => {
      // Image object where source.media_type is undefined — hits the ?? 'unknown' branch
      const result = condenseTool("toolu_1", mkBlock("ok"), {
        screen: {
          type: "image",
          source: { data: "abc123" }, // no media_type field
        },
      });
      expect(result.metadata!.screen).toBe("[image: unknown]");
    });
  });
});
