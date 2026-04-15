/**
 * Truncate a string to maxLen characters, appending a marker showing how much was cut.
 */
export function truncateString(s: string, maxLen: number): string {
  if (!s) return "";
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + `\n[truncated: ${s.length} chars total, showing first ${maxLen}]`;
}
