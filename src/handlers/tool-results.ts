// src/handlers/tool-results.ts
import type { ToolResultBlock, ContentBlock } from "../types/content.js";
import { truncateString } from "../truncate.js";
import { parsePersistedOutput } from "../persisted-output.js";
import type { CondensedToolResult } from "./types.js";

export interface ToolResultOptions {
  resultMaxLen?: number;
}

const DEFAULT_RESULT_MAX = 1000;

/** Runtime-only extension: some real tool_result content arrays include `tool_reference` blocks that aren't in our main ContentBlock union. */
interface ToolReferenceBlock {
  type: "tool_reference";
  tool_name: string;
}

export function condenseTool(
  toolUseId: string,
  block: ToolResultBlock,
  toolUseResult?: Record<string, unknown>,
  opts: ToolResultOptions = {}
): CondensedToolResult {
  const maxLen = opts.resultMaxLen ?? DEFAULT_RESULT_MAX;

  // Persisted output: string content that spills to an external file
  if (typeof block.content === "string") {
    const ref = parsePersistedOutput(block.content);
    if (ref) {
      return {
        toolUseId,
        content: truncateString(ref.preview, maxLen),
        isError: block.is_error || undefined,
        persistedOutput: { filePath: ref.filePath, sizeLabel: ref.sizeLabel },
        metadata:
          toolUseResult && typeof toolUseResult === "object"
            ? condenseMetadata(toolUseResult, maxLen) ?? undefined
            : undefined,
      };
    }
  }

  return {
    toolUseId,
    content: condenseContent(block.content, maxLen),
    isError: block.is_error || undefined,
    metadata:
      toolUseResult && typeof toolUseResult === "object"
        ? condenseMetadata(toolUseResult, maxLen) ?? undefined
        : undefined,
  };
}

function condenseContent(
  content: string | ContentBlock[],
  maxLen: number
): string {
  if (typeof content === "string") return truncateString(content, maxLen);

  const parts: string[] = [];
  for (const item of content) {
    // Use runtime checks so we can handle extension types like tool_reference.
    const t = (item as { type: string }).type;
    if (t === "text") {
      parts.push(truncateString((item as { text: string }).text, maxLen));
    } else if (t === "image") {
      const src = (item as { source: { media_type: string } }).source;
      parts.push(`[image: ${src.media_type}]`);
    } else if (t === "tool_reference") {
      const ref = item as unknown as ToolReferenceBlock;
      parts.push(`[tool_reference: ${ref.tool_name}]`);
    }
  }
  return parts.join("\n");
}

function condenseMetadata(
  tr: Record<string, unknown>,
  maxLen: number
): Record<string, unknown> | null {
  // Write: has filePath + content + type in {create, update}
  if (
    "filePath" in tr &&
    "content" in tr &&
    typeof tr.content === "string" &&
    (("type" in tr && (tr.type === "create" || tr.type === "update")) || "structuredPatch" in tr)
  ) {
    return stripFields(tr, ["content", "originalFile", "structuredPatch"]);
  }

  // Edit: redundant with tool_use input — drop entirely
  if ("oldString" in tr && "newString" in tr) return null;

  // Read: has type: "text" + file: {filePath, content}
  if (tr.type === "text" && tr.file && typeof tr.file === "object") {
    const file = tr.file as Record<string, unknown>;
    return { filePath: file.filePath };
  }

  // Agent: has agentId + status
  if ("agentId" in tr && "status" in tr) return stripFields(tr, ["content", "prompt"]);

  // Bash: stdout/stderr duplicates tool_result content — drop entirely
  if ("stdout" in tr) return null;

  // Default: strip any deeply nested base64 image data, then return
  return stripLargeValues(tr, maxLen);
}

function stripLargeValues(
  obj: Record<string, unknown>,
  maxLen: number
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string") {
      result[key] = truncateString(value, maxLen);
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      const inner = value as Record<string, unknown>;
      if (inner.type === "image" && inner.source && typeof inner.source === "object") {
        const src = inner.source as Record<string, unknown>;
        result[key] = `[image: ${src.media_type ?? "unknown"}]`;
      } else {
        result[key] = stripLargeValues(inner, maxLen);
      }
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) => {
        if (typeof item === "string") return truncateString(item, maxLen);
        if (item && typeof item === "object")
          return stripLargeValues(item as Record<string, unknown>, maxLen);
        return item;
      });
    } else {
      result[key] = value;
    }
  }
  return result;
}

function stripFields(
  obj: Record<string, unknown>,
  fields: string[]
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const strip = new Set(fields);
  for (const [key, value] of Object.entries(obj)) {
    if (!strip.has(key)) result[key] = value;
  }
  return result;
}
