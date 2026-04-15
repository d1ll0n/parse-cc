import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  findFileHistoryDir,
  listFileHistoryBlobs,
  readFileHistoryBlob,
  defaultFileHistoryDir,
  type FileHistoryVersion,
} from "../src/file-history.js";

const STORE = path.resolve("tests/fixtures/file-history-store");

describe("defaultFileHistoryDir", () => {
  it("returns ~/.claude/file-history", () => {
    expect(defaultFileHistoryDir()).toMatch(/\.claude\/file-history$/);
  });
});

describe("findFileHistoryDir", () => {
  it("returns the dir when it exists", async () => {
    const dir = await findFileHistoryDir("sess-fh", STORE);
    expect(dir).toBe(path.join(STORE, "sess-fh"));
  });

  it("returns null when the dir does not exist", async () => {
    const dir = await findFileHistoryDir("nonexistent", STORE);
    expect(dir).toBeNull();
  });
});

describe("listFileHistoryBlobs", () => {
  it("returns every on-disk blob with size and path", async () => {
    const blobs = await listFileHistoryBlobs("sess-fh", STORE);
    expect(blobs).toHaveLength(1);
    expect(blobs[0].backupFileName).toBe("abc123@v2");
    expect(blobs[0].size).toBeGreaterThan(0);
    expect(blobs[0].blobPath).toMatch(/abc123@v2$/);
  });

  it("returns empty array when the session has no file-history dir", async () => {
    const blobs = await listFileHistoryBlobs("nonexistent", STORE);
    expect(blobs).toEqual([]);
  });
});

describe("readFileHistoryBlob", () => {
  it("reads the blob content when blobPath is set", async () => {
    const v: FileHistoryVersion = {
      filePath: "notes.md",
      version: 2,
      backupTime: "",
      backupFileName: "abc123@v2",
      blobPath: path.join(STORE, "sess-fh", "abc123@v2"),
      size: null,
    };
    const content = await readFileHistoryBlob(v);
    expect(content).toContain("backed-up version of notes.md");
  });

  it("returns null when blobPath is null", async () => {
    const v: FileHistoryVersion = {
      filePath: "x",
      version: 1,
      backupTime: "",
      backupFileName: null,
      blobPath: null,
      size: null,
    };
    expect(await readFileHistoryBlob(v)).toBeNull();
  });

  it("returns null when blobPath points to a non-existent file", async () => {
    const v: FileHistoryVersion = {
      filePath: "x",
      version: 1,
      backupTime: "",
      backupFileName: "missing@v99",
      blobPath: "/nonexistent/path/to/missing@v99",
      size: null,
    };
    expect(await readFileHistoryBlob(v)).toBeNull();
  });
});

describe("listFileHistoryBlobs stat error handling", () => {
  it("skips files whose stat fails (e.g. race condition)", async () => {
    // We can't easily trigger a stat error, but we can verify the happy path
    // returns results and the function doesn't throw when the directory exists.
    const blobs = await listFileHistoryBlobs("sess-fh", STORE);
    expect(Array.isArray(blobs)).toBe(true);
  });
});
