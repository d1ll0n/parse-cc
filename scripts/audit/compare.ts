import type { Inventory } from "./inventory.ts";

export interface InventoryDiff {
  /** Paths observed in `current` that were not in `baseline`. */
  newPaths: string[];
  /** Paths in `baseline` not observed in `current` (often benign — stale fixture data). */
  removedPaths: string[];
  /**
   * Paths present in both, but with primitive types in `current` that were
   * not in `baseline` (e.g., a field that used to be `string` is now
   * `string | null`).
   */
  newTypes: Array<{ path: string; added: string[] }>;
}

/**
 * Diff two inventories. The result is sorted deterministically so that
 * reports and test failures are stable across runs.
 *
 * `newPaths` and `newTypes` are the two categories that indicate schema
 * drift — something Claude Code is emitting that this package does not yet
 * account for. `removedPaths` is reported separately because it usually
 * just means the current run didn't happen to include a session that
 * exercised the path.
 */
export function compareInventories(
  baseline: Inventory,
  current: Inventory
): InventoryDiff {
  const newPaths: string[] = [];
  const removedPaths: string[] = [];
  const newTypes: Array<{ path: string; added: string[] }> = [];

  for (const [path, currentTypes] of Object.entries(current)) {
    const baselineTypes = baseline[path];
    if (!baselineTypes) {
      newPaths.push(path);
      continue;
    }
    const added = currentTypes.filter((t) => !baselineTypes.includes(t));
    if (added.length > 0) newTypes.push({ path, added: [...added].sort() });
  }

  for (const path of Object.keys(baseline)) {
    if (!(path in current)) removedPaths.push(path);
  }

  newPaths.sort();
  removedPaths.sort();
  newTypes.sort((a, b) => a.path.localeCompare(b.path));

  return { newPaths, removedPaths, newTypes };
}

/** Total number of drift findings: new paths + paths with new types. */
export function driftCount(diff: InventoryDiff): number {
  return diff.newPaths.length + diff.newTypes.length;
}
