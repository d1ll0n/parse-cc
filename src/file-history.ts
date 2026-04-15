// src/file-history.ts
import { access, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Returns the default Claude Code file-history root: `~/.claude/file-history`.
 *
 * Pass the return value as `baseDir` to override the lookup directory in
 * `findFileHistoryDir`, `listFileHistoryBlobs`, and `Session.fileHistory`.
 */
export function defaultFileHistoryDir(): string {
  return path.join(homedir(), ".claude", "file-history");
}

/**
 * One version of a tracked file, joining session-snapshot metadata with
 * on-disk blob state.
 *
 * Produced by `Session.fileHistory()`. `blobPath` is `null` when
 * `backupFileName` is `null`, or when the expected blob file is absent from
 * disk.
 */
export interface FileHistoryVersion {
  /** The path the file was tracked under (as it appeared in trackedFileBackups). */
  filePath: string;
  /** Version number (starts at 1). */
  version: number;
  /** Timestamp from the snapshot entry. */
  backupTime: string;
  /** The blob's filename inside the file-history dir, or null if no blob was stored. */
  backupFileName: string | null;
  /** Absolute path to the blob on disk, or null if no blob was stored or the blob is missing. */
  blobPath: string | null;
  /** Size in bytes, or null if unknown. */
  size: number | null;
}

/**
 * Resolve the session-specific file-history subdirectory for a given session
 * ID. Returns `null` if the directory does not exist.
 *
 * The resolved path is `<baseDir>/<sessionId>`, where `baseDir` defaults to
 * `defaultFileHistoryDir()`.
 */
export async function findFileHistoryDir(
  sessionId: string,
  baseDir: string = defaultFileHistoryDir()
): Promise<string | null> {
  const dir = path.join(baseDir, sessionId);
  try {
    await access(dir);
    return dir;
  } catch {
    return null;
  }
}

/**
 * Read the UTF-8 content of a file-history blob identified by a
 * `FileHistoryVersion`. Returns `null` when `version.blobPath` is `null` or
 * when the file cannot be read.
 */
export async function readFileHistoryBlob(version: FileHistoryVersion): Promise<string | null> {
  if (!version.blobPath) return null;
  try {
    return await readFile(version.blobPath, "utf8");
  } catch {
    return null;
  }
}

/**
 * List every blob that exists on disk under a session's file-history
 * directory, without consulting the session log.
 *
 * Only files whose names contain `@v` (the blob naming convention) are
 * returned. Useful for discovering orphaned backups that no live session
 * references. Returns an empty array when the directory does not exist.
 */
export async function listFileHistoryBlobs(
  sessionId: string,
  baseDir: string = defaultFileHistoryDir()
): Promise<{ backupFileName: string; blobPath: string; size: number }[]> {
  const dir = await findFileHistoryDir(sessionId, baseDir);
  if (!dir) return [];
  const out: { backupFileName: string; blobPath: string; size: number }[] = [];
  const names = await readdir(dir);
  for (const name of names) {
    if (!name.includes("@v")) continue;
    const full = path.join(dir, name);
    try {
      const s = await stat(full);
      out.push({ backupFileName: name, blobPath: full, size: s.size });
    } catch {
      // skip
    }
  }
  return out;
}
