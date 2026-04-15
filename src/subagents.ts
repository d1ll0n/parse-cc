import { readdir, access, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function readFirstLine(p: string): Promise<string | null> {
  const rl = createInterface({
    input: createReadStream(p, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    rl.close();
    return line;
  }
  return null;
}

async function getSessionIdFromFile(p: string): Promise<string | null> {
  try {
    const line = await readFirstLine(p);
    if (!line) return null;
    const parsed = JSON.parse(line) as { sessionId?: string };
    return parsed.sessionId ?? null;
  } catch {
    return null;
  }
}

/**
 * Locate all subagent `.jsonl` files associated with a parent session file.
 *
 * Two directory layouts are supported and checked in order:
 *
 * 1. **New layout** — `<parent-stem>/subagents/agent-*.jsonl` next to the
 *    parent file. If this directory exists, its non-empty `agent-*.jsonl`
 *    files are returned and the legacy scan is skipped.
 *
 * 2. **Legacy layout** — `agent-*.jsonl` files sitting at the same level as
 *    the parent file, filtered by matching `sessionId` from the first line of
 *    each candidate against the parent's own `sessionId`.
 *
 * Returns an empty array when no subagent files are found.
 */
export async function findSubagentFiles(parentPath: string): Promise<string[]> {
  const dir = path.dirname(parentPath);
  const stem = path.basename(parentPath, ".jsonl");
  const found: string[] = [];

  // New layout: <dir>/<stem>/subagents/agent-*.jsonl
  const newDir = path.join(dir, stem, "subagents");
  if (await exists(newDir)) {
    const names = await readdir(newDir);
    for (const n of names) {
      if (n.startsWith("agent-") && n.endsWith(".jsonl")) {
        const full = path.join(newDir, n);
        const s = await stat(full);
        if (s.size > 0) found.push(full);
      }
    }
  }

  // Old layout: <dir>/agent-*.jsonl, filtered by sessionId match
  const parentSessionId = await getSessionIdFromFile(parentPath);
  if (parentSessionId) {
    const names = await readdir(dir);
    for (const n of names) {
      if (!n.startsWith("agent-") || !n.endsWith(".jsonl")) continue;
      const full = path.join(dir, n);
      const childId = await getSessionIdFromFile(full);
      if (childId === parentSessionId) found.push(full);
    }
  }

  return found;
}
