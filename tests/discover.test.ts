import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  listProjects,
  listSessions,
  findAllSessions,
  defaultProjectsDir,
} from "../src/discover.js";

const FIXTURES = path.resolve("tests/fixtures/projects");

describe("defaultProjectsDir", () => {
  it("returns ~/.claude/projects", () => {
    const dir = defaultProjectsDir();
    expect(dir).toMatch(/\.claude\/projects$/);
  });
});

describe("listProjects", () => {
  it("lists projects in alphabetical order with session counts", async () => {
    const projects = await listProjects(FIXTURES);
    expect(projects.length).toBeGreaterThanOrEqual(2);
    const a = projects.find((p) => p.name === "-project-a");
    const b = projects.find((p) => p.name === "-project-b");
    expect(a).toBeDefined();
    expect(a?.sessionCount).toBe(2);
    expect(b).toBeDefined();
    expect(b?.sessionCount).toBe(1);
    // Projects must be in alphabetical order
    const aIdx = projects.indexOf(a!);
    const bIdx = projects.indexOf(b!);
    expect(aIdx).toBeLessThan(bIdx);
  });

  it("returns empty array for non-existent directory", async () => {
    const projects = await listProjects("/nonexistent/path/abc123");
    expect(projects).toEqual([]);
  });
});

describe("listSessions", () => {
  it("returns session summaries sorted by firstTimestamp desc", async () => {
    const sessions = await listSessions(path.join(FIXTURES, "-project-a"));
    expect(sessions).toHaveLength(2);
    // sess-2 (2026-04-11) should come before sess-1 (2026-04-10)
    expect(sessions[0].sessionId).toBe("sess-2");
    expect(sessions[1].sessionId).toBe("sess-1");
  });

  it("populates all cheap metadata fields", async () => {
    const sessions = await listSessions(path.join(FIXTURES, "-project-a"));
    const s = sessions.find((x) => x.sessionId === "sess-1");
    expect(s).toBeDefined();
    expect(s?.version).toBe("2.1.101");
    expect(s?.gitBranch).toBe("main");
    expect(s?.cwd).toBe("/repo");
    expect(s?.firstUserMessage?.text).toBe("first prompt");
    expect(s?.firstTimestamp).toBe("2026-04-10T10:00:00Z");
    expect(s?.fileSize).toBeGreaterThan(0);
  });

  it("returns empty array when project has no .jsonl files", async () => {
    const sessions = await listSessions("/nonexistent/path/abc123");
    expect(sessions).toEqual([]);
  });
});

describe("findAllSessions", () => {
  it("walks all projects and returns every session", async () => {
    const all = await findAllSessions(FIXTURES);
    // Now includes project-c sessions as well
    const ids = all.map((s) => s.sessionId).sort();
    expect(ids).toContain("sess-1");
    expect(ids).toContain("sess-2");
    expect(ids).toContain("sess-3");
  });
});

describe("listSessions sort by timestamp", () => {
  it("sorts sessions with timestamps before sessions without timestamps", async () => {
    const sessions = await listSessions(path.join(FIXTURES, "-project-c"));
    // sess-with-ts has a timestamp; the two sess-no-ts files do not
    const timestamped = sessions.filter((s) => s.firstTimestamp !== null);
    const noTimestamp = sessions.filter((s) => s.firstTimestamp === null);
    expect(timestamped.length).toBeGreaterThan(0);
    expect(noTimestamp.length).toBeGreaterThan(0);
    // All timestamped sessions should appear before any null-timestamp sessions
    const firstNullIdx = sessions.findIndex((s) => s.firstTimestamp === null);
    const lastTimestampedIdx = sessions.reduce(
      (acc, s, i) => (s.firstTimestamp !== null ? i : acc),
      -1
    );
    expect(lastTimestampedIdx).toBeLessThan(firstNullIdx);
  });

  it("sorts two sessions without timestamps by path", async () => {
    const sessions = await listSessions(path.join(FIXTURES, "-project-c"));
    const noTs = sessions.filter((s) => s.firstTimestamp === null);
    expect(noTs).toHaveLength(2);
    // They should be sorted alphabetically by path
    expect(noTs[0].path.localeCompare(noTs[1].path)).toBeLessThan(0);
  });
});
