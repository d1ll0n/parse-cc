import { describe, it, expect } from "vitest";
import { firstObservedMetadata } from "../../src/derive/first-observed.js";
import type { LogEntry } from "../../src/types/entries.js";

describe("firstObservedMetadata", () => {
  it("extracts the first observed scalar fields across mixed entry types", () => {
    const entries: LogEntry[] = [
      { type: "permission-mode", sessionId: "s1", permissionMode: "acceptEdits" },
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        timestamp: "t",
        sessionId: "s1",
        version: "2.1.101",
        gitBranch: "main",
        cwd: "/repo",
        message: { role: "user", content: "hi" },
      },
    ];
    const m = firstObservedMetadata(entries);
    expect(m.sessionId).toBe("s1");
    expect(m.permissionMode).toBe("acceptEdits");
    expect(m.version).toBe("2.1.101");
    expect(m.gitBranch).toBe("main");
    expect(m.cwd).toBe("/repo");
  });

  it("returns nulls when nothing is present", () => {
    const m = firstObservedMetadata([]);
    expect(m.sessionId).toBeNull();
    expect(m.version).toBeNull();
    expect(m.gitBranch).toBeNull();
    expect(m.cwd).toBeNull();
    expect(m.permissionMode).toBeNull();
  });

  it("only reads permissionMode from permission-mode entries, not other types", () => {
    const entries: LogEntry[] = [
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        timestamp: "t",
        sessionId: "s1",
        message: { role: "user", content: "hi" },
        // deliberately plant a stray permissionMode on a user entry — must be ignored
        ...({ permissionMode: "bogus" } as object),
      } as LogEntry,
    ];
    const m = firstObservedMetadata(entries);
    expect(m.permissionMode).toBeNull();
  });
});
