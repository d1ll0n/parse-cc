import { describe, it, expect } from "vitest";
import {
  buildInventory,
  createDefaultContext,
  recordEntry,
  walkValue,
  sortInventory,
  type Inventory,
} from "../../scripts/audit/inventory.ts";
import {
  compareInventories,
  driftCount,
} from "../../scripts/audit/compare.ts";

describe("inventory walker", () => {
  it("buckets top-level entries by .type", () => {
    const inv = buildInventory([
      { type: "user", uuid: "u1" },
      { type: "assistant", uuid: "a1" },
    ]);
    expect(inv["entry[user]"]).toEqual(["object"]);
    expect(inv["entry[assistant]"]).toEqual(["object"]);
    expect(inv["entry[user].uuid"]).toEqual(["string"]);
    expect(inv["entry[assistant].uuid"]).toEqual(["string"]);
  });

  it("records primitive kinds at leaf paths", () => {
    const inv = buildInventory([
      {
        type: "assistant",
        uuid: "a1",
        message: {
          role: "assistant",
          usage: { input_tokens: 10, cache_read_input_tokens: null },
        },
        requestId: "req_1",
      },
    ]);
    expect(inv["entry[assistant].message.role"]).toEqual(["string"]);
    expect(inv["entry[assistant].message.usage.input_tokens"]).toEqual(["number"]);
    expect(inv["entry[assistant].message.usage.cache_read_input_tokens"]).toEqual(["null"]);
    expect(inv["entry[assistant].requestId"]).toEqual(["string"]);
  });

  it("unions primitive kinds across entries", () => {
    const inv = buildInventory([
      { type: "assistant", message: { stop_reason: "end_turn" } },
      { type: "assistant", message: { stop_reason: null } },
    ]);
    expect(inv["entry[assistant].message.stop_reason"]).toEqual(["null", "string"]);
  });

  it("discriminates content blocks by .type", () => {
    const inv = buildInventory([
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "hello" },
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
          ],
        },
      },
    ]);
    expect(inv["entry[assistant].message.content[text].text"]).toEqual(["string"]);
    expect(inv["entry[assistant].message.content[tool_use].name"]).toEqual(["string"]);
    expect(inv["entry[assistant].message.content[tool_use].id"]).toEqual(["string"]);
  });

  it("records tool_use.input as opaque object without recursing", () => {
    const inv = buildInventory([
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "Bash",
              input: { command: "ls", timeout: 5000, description: "list files" },
            },
          ],
        },
      },
    ]);
    expect(inv["entry[assistant].message.content[tool_use].input"]).toEqual(["object"]);
    expect(
      inv["entry[assistant].message.content[tool_use].input.command"]
    ).toBeUndefined();
    expect(
      inv["entry[assistant].message.content[tool_use].input.timeout"]
    ).toBeUndefined();
  });

  it("handles string content (not array) without crashing", () => {
    const inv = buildInventory([
      { type: "user", message: { role: "user", content: "plain text prompt" } },
    ]);
    expect(inv["entry[user].message.content"]).toEqual(["string"]);
  });

  it("unions object and string for fields that take both shapes", () => {
    const inv = buildInventory([
      { type: "user", message: { content: "plain" } },
      { type: "user", message: { content: [{ type: "text", text: "x" }] } },
    ]);
    expect(inv["entry[user].message.content"]).toEqual(["array", "string"]);
    expect(inv["entry[user].message.content[text].text"]).toEqual(["string"]);
  });

  it("buckets tool_result nested content blocks by .type", () => {
    const inv = buildInventory([
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [
                { type: "text", text: "stdout" },
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: "iVBOR..." },
                },
              ],
            },
          ],
        },
      },
    ]);
    expect(
      inv["entry[user].message.content[tool_result].content[text].text"]
    ).toEqual(["string"]);
    expect(
      inv["entry[user].message.content[tool_result].content[image].source.media_type"]
    ).toEqual(["string"]);
  });

  it("falls back to [] bucket when discriminator is missing", () => {
    const inv: Inventory = {};
    walkValue(
      inv,
      "entry[assistant].message.content",
      [{ weird: true }],
      createDefaultContext()
    );
    expect(inv["entry[assistant].message.content[]"]).toEqual(["object"]);
    expect(inv["entry[assistant].message.content[].weird"]).toEqual(["boolean"]);
  });

  it("skips non-object entries silently", () => {
    const inv: Inventory = {};
    recordEntry(inv, null, createDefaultContext());
    recordEntry(inv, "string", createDefaultContext());
    recordEntry(inv, 42, createDefaultContext());
    recordEntry(inv, [], createDefaultContext());
    expect(Object.keys(inv)).toHaveLength(0);
  });

  it("collapses record-typed objects into a single {*} child path", () => {
    const inv = buildInventory([
      {
        type: "file-history-snapshot",
        snapshot: {
          messageId: "m1",
          trackedFileBackups: {
            "/a/b.ts": { backupFileName: "abc", version: 1, backupTime: "t1" },
            "/c/d.ts": { backupFileName: null, version: 2, backupTime: "t2" },
            "/e/f.ts": { backupFileName: "xyz", version: 3, backupTime: "t3" },
          },
          timestamp: "t0",
        },
      },
    ]);
    expect(
      inv["entry[file-history-snapshot].snapshot.trackedFileBackups"]
    ).toEqual(["object"]);
    expect(
      inv["entry[file-history-snapshot].snapshot.trackedFileBackups{*}"]
    ).toEqual(["object"]);
    expect(
      inv["entry[file-history-snapshot].snapshot.trackedFileBackups{*}.version"]
    ).toEqual(["number"]);
    expect(
      inv["entry[file-history-snapshot].snapshot.trackedFileBackups{*}.backupFileName"]
    ).toEqual(["null", "string"]);
    // Dynamic per-file keys should NOT exist in the inventory
    expect(
      inv["entry[file-history-snapshot].snapshot.trackedFileBackups./a/b.ts"]
    ).toBeUndefined();
  });

  it("uses entry[<no-type>] bucket when .type is missing", () => {
    const inv = buildInventory([{ uuid: "x1", foo: "bar" }]);
    expect(inv["entry[<no-type>]"]).toEqual(["object"]);
    expect(inv["entry[<no-type>].uuid"]).toEqual(["string"]);
  });

  it("sortInventory produces deterministic key order and sorted types", () => {
    const unsorted: Inventory = {
      "zebra.foo": ["string", "null"],
      "alpha.bar": ["object"],
      "alpha.baz": ["number", "boolean"],
    };
    const sorted = sortInventory(unsorted);
    expect(Object.keys(sorted)).toEqual(["alpha.bar", "alpha.baz", "zebra.foo"]);
    expect(sorted["zebra.foo"]).toEqual(["null", "string"]);
    expect(sorted["alpha.baz"]).toEqual(["boolean", "number"]);
  });
});

describe("compareInventories", () => {
  it("returns empty diff for identical inventories", () => {
    const inv: Inventory = { "a.b": ["string"], "a.c": ["number"] };
    const diff = compareInventories(inv, inv);
    expect(diff.newPaths).toEqual([]);
    expect(diff.removedPaths).toEqual([]);
    expect(diff.newTypes).toEqual([]);
    expect(driftCount(diff)).toBe(0);
  });

  it("flags new paths as drift", () => {
    const baseline: Inventory = { "a.b": ["string"] };
    const current: Inventory = { "a.b": ["string"], "a.c": ["number"] };
    const diff = compareInventories(baseline, current);
    expect(diff.newPaths).toEqual(["a.c"]);
    expect(diff.removedPaths).toEqual([]);
    expect(diff.newTypes).toEqual([]);
    expect(driftCount(diff)).toBe(1);
  });

  it("flags new primitive types on existing paths as drift", () => {
    const baseline: Inventory = { "a.b": ["string"] };
    const current: Inventory = { "a.b": ["null", "string"] };
    const diff = compareInventories(baseline, current);
    expect(diff.newPaths).toEqual([]);
    expect(diff.newTypes).toEqual([{ path: "a.b", added: ["null"] }]);
    expect(driftCount(diff)).toBe(1);
  });

  it("reports removed paths separately (not counted as drift)", () => {
    const baseline: Inventory = { "a.b": ["string"], "a.c": ["number"] };
    const current: Inventory = { "a.b": ["string"] };
    const diff = compareInventories(baseline, current);
    expect(diff.removedPaths).toEqual(["a.c"]);
    expect(driftCount(diff)).toBe(0);
  });

  it("sorts all diff arrays deterministically", () => {
    const baseline: Inventory = { "z.1": ["string"], "a.1": ["string"] };
    const current: Inventory = {
      "z.1": ["string"],
      "a.1": ["number", "string"],
      "m.2": ["boolean"],
      "b.3": ["null"],
    };
    const diff = compareInventories(baseline, current);
    expect(diff.newPaths).toEqual(["b.3", "m.2"]);
    expect(diff.newTypes.map((t) => t.path)).toEqual(["a.1"]);
  });
});
