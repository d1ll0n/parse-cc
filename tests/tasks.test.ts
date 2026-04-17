import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  defaultTasksDir,
  findTasksDir,
  listTaskSessionIds,
  listTasks,
  readTask,
} from "../src/tasks.js";
import { Session } from "../src/session.js";

const STORE = path.resolve("tests/fixtures/tasks-store");
const MODERN_STORE = path.resolve("tests/fixtures/tasks-store-modern");

describe("defaultTasksDir", () => {
  it("returns ~/.claude/tasks", () => {
    expect(defaultTasksDir()).toMatch(/\.claude\/tasks$/);
  });
});

describe("findTasksDir", () => {
  it("returns the dir when it exists", async () => {
    const dir = await findTasksDir("sess-tasks-a", STORE);
    expect(dir).toBe(path.join(STORE, "sess-tasks-a"));
  });

  it("returns null when the dir does not exist", async () => {
    expect(await findTasksDir("nonexistent", STORE)).toBeNull();
  });
});

describe("listTaskSessionIds", () => {
  it("lists every session dir and skips dotfiles", async () => {
    const ids = await listTaskSessionIds(STORE);
    expect(ids).toEqual(["sess-tasks-a", "sess-tasks-bad-shape", "sess-tasks-empty"]);
  });

  it("returns empty array when baseDir does not exist", async () => {
    expect(await listTaskSessionIds("/nonexistent/path/xyz")).toEqual([]);
  });
});

describe("listTasks", () => {
  it("parses all tasks, preserves optional fields, and sorts numerically", async () => {
    const tasks = await listTasks("sess-tasks-a", STORE);
    const ids = tasks.map((t) => t.id);
    // Numeric sort: 1, 2, 10 — not lexicographic 1, 10, 2
    expect(ids).toEqual(["1", "2", "10"]);

    const t1 = tasks[0];
    expect(t1.status).toBe("in_progress");
    expect(t1.owner).toBe("alice");
    expect(t1.activeForm).toBe("Investigating ingest pipeline");
    expect(t1.blocks).toEqual(["2"]);
    expect(t1.blockedBy).toEqual([]);
    expect(t1.metadata).toEqual({ phase: "alpha", tag: "ingest" });

    const t2 = tasks[1];
    expect(t2.status).toBe("pending");
    expect(t2.blockedBy).toEqual(["1"]);
    expect(t2.owner).toBeUndefined();
    expect(t2.activeForm).toBeUndefined();
    expect(t2.metadata).toBeUndefined();

    expect(tasks[2].status).toBe("completed");
  });

  it("skips malformed JSON files and harness bookkeeping files", async () => {
    // sess-tasks-a contains .lock, .highwatermark, and bad.json — none should
    // produce a task, and none should throw. Only the three valid fixtures
    // (1, 2, 10) come back.
    const tasks = await listTasks("sess-tasks-a", STORE);
    expect(tasks.map((t) => t.id)).toEqual(["1", "2", "10"]);
  });

  it("rejects tasks missing required fields or with an unknown status", async () => {
    // sess-tasks-bad-shape contains 4 well-formed-JSON files:
    //   1.json — missing required `description` and `status` → rejected
    //   2.json — `status` is "archived" (not in the allowed enum) → rejected
    //   3.json — `metadata` is an array → accepted, but metadata is dropped
    //            (optional-field validation is permissive: copy when valid, drop when not)
    //   4.json — well-formed → accepted
    const tasks = await listTasks("sess-tasks-bad-shape", STORE);
    expect(tasks.map((t) => t.id)).toEqual(["3", "4"]);

    const t3 = tasks[0];
    expect(t3.subject).toBe("Metadata as array");
    expect(t3.metadata).toBeUndefined();

    const t4 = tasks[1];
    expect(t4.subject).toBe("Valid alongside the bad ones");
  });

  it("returns empty array for a session dir with no task files", async () => {
    expect(await listTasks("sess-tasks-empty", STORE)).toEqual([]);
  });

  it("returns empty array for a session with no task directory", async () => {
    expect(await listTasks("nonexistent-session", STORE)).toEqual([]);
  });
});

describe("readTask", () => {
  it("reads a single task by id", async () => {
    const t = await readTask("sess-tasks-a", "1", STORE);
    expect(t?.subject).toBe("Investigate ingest pipeline");
    expect(t?.status).toBe("in_progress");
  });

  it("returns null when the task file does not exist", async () => {
    expect(await readTask("sess-tasks-a", "999", STORE)).toBeNull();
  });

  it("returns null when the session dir does not exist", async () => {
    expect(await readTask("no-such-session", "1", STORE)).toBeNull();
  });

  it("returns null when the file parses but fails Task shape validation", async () => {
    // bad-shape/1 is missing required fields; bad-shape/2 has an unknown status
    expect(await readTask("sess-tasks-bad-shape", "1", STORE)).toBeNull();
    expect(await readTask("sess-tasks-bad-shape", "2", STORE)).toBeNull();
    // bad-shape/4 is the valid one
    const t = await readTask("sess-tasks-bad-shape", "4", STORE);
    expect(t?.id).toBe("4");
  });
});

describe("Session.tasks", () => {
  it("joins tasks to the session by session ID", async () => {
    const sess = new Session("tests/fixtures/modern-session.jsonl");
    const tasks = await sess.tasks(MODERN_STORE);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].subject).toBe("Parse modern session");
    // Session ID was primed as a side effect of tasks()
    expect(sess.sessionId).toBe("sess-1");
  });

  it("caches results across calls", async () => {
    const sess = new Session("tests/fixtures/modern-session.jsonl");
    const a = await sess.tasks(MODERN_STORE);
    const b = await sess.tasks(MODERN_STORE);
    expect(a).toBe(b);
  });

  it("returns empty array when the session has no task dir", async () => {
    const sess = new Session("tests/fixtures/modern-session.jsonl");
    // Pointing baseDir at a store that has no sess-1 subdir
    const tasks = await sess.tasks(STORE);
    expect(tasks).toEqual([]);
  });
});
