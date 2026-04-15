import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/**
 * Stream-read a `.jsonl` file and return all successfully parsed lines.
 *
 * Reads the file line-by-line to avoid loading the entire file into memory.
 * Empty and whitespace-only lines are skipped. Lines that are not valid JSON
 * are silently discarded — this matches the behavior of claude-devtools and
 * tolerates truncated writes at the end of an in-progress session file.
 */
export async function readJsonlFile(filePath: string): Promise<unknown[]> {
  const out: unknown[] = [];
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // skip malformed lines — matches claude-devtools behavior
    }
  }
  return out;
}
