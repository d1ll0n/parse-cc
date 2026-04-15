/**
 * Schema drift detection for Claude Code session logs.
 *
 * Walks raw JSONL entries and builds a flat "path → primitive type union"
 * inventory. Polymorphic arrays are discriminated on a named field (e.g.
 * `entry.type`, `message.content[].type`) so that `user` and `assistant`
 * entries don't flatten into one mega-union. Known unstructured regions
 * (tool_use.input) are recorded as opaque objects with no recursion.
 *
 * Compare inventories with `compareInventories` in ./compare.ts.
 */

/** Flat map from observation path to the sorted union of primitive types seen. */
export type Inventory = Record<string, string[]>;

/** Runtime type labels recorded at each path. */
export type PrimitiveKind =
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "undefined"
  | "object"
  | "array";

export interface WalkContext {
  /** Paths where recursion stops — the value is recorded as its kind, children are ignored. */
  stopPaths: Set<string>;
  /**
   * Array paths whose items should be bucketed by a discriminator field.
   * Key is the array path (e.g. `"entry[assistant].message.content"`),
   * value is the discriminator field name on each item (e.g. `"type"`).
   * Items without a matching string field fall back to a `[]` bucket.
   */
  arrayDiscriminators: Map<string, string>;
  /**
   * Object paths representing `Record<string, T>` shapes with dynamic keys.
   * Instead of walking each child key under its own name, all values are
   * merged into a single `${path}{*}` child path. Prevents per-file-path,
   * per-id, etc. key explosions.
   */
  recordPaths: Set<string>;
}

/**
 * Default walk context tuned for Claude Code session logs.
 *
 * Stop paths: `tool_use.input` — per-tool shape, nothing to gain from drilling.
 * Discriminators: `message.content[].type`, nested `tool_result.content[].type`.
 */
export function createDefaultContext(): WalkContext {
  return {
    stopPaths: new Set([
      "entry[assistant].message.content[tool_use].input",
      "entry[user].message.content[tool_use].input",
      // progress entries embed a full Anthropic API message; same tool_use.input
      // unstructured region, just nested deeper.
      "entry[progress].data.message.message.content[tool_use].input",
    ]),
    arrayDiscriminators: new Map([
      ["entry[user].message.content", "type"],
      ["entry[assistant].message.content", "type"],
      ["entry[user].message.content[tool_result].content", "type"],
      ["entry[assistant].message.content[tool_result].content", "type"],
      ["entry[progress].data.message.message.content", "type"],
    ]),
    recordPaths: new Set([
      // Record<filePath, TrackedFileBackup> — collapsed to a single {*} child.
      "entry[file-history-snapshot].snapshot.trackedFileBackups",
    ]),
  };
}

function kindOf(value: unknown): PrimitiveKind {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "array";
  const t = typeof value;
  if (t === "object") return "object";
  if (t === "string" || t === "number" || t === "boolean") return t;
  return "object";
}

function recordKind(inv: Inventory, path: string, kind: PrimitiveKind): void {
  const existing = inv[path];
  if (!existing) {
    inv[path] = [kind];
    return;
  }
  if (!existing.includes(kind)) {
    existing.push(kind);
    existing.sort();
  }
}

/**
 * Walk a value at a given path, mutating `inv` with every observed
 * `path → kind` pair. Recursion is bounded by `ctx.stopPaths`; polymorphic
 * arrays are bucketed per `ctx.arrayDiscriminators`.
 */
export function walkValue(inv: Inventory, path: string, value: unknown, ctx: WalkContext): void {
  const kind = kindOf(value);
  recordKind(inv, path, kind);

  if (ctx.stopPaths.has(path)) return;
  if (kind !== "object" && kind !== "array") return;

  if (kind === "array") {
    const discriminator = ctx.arrayDiscriminators.get(path);
    for (const item of value as unknown[]) {
      let childPath = `${path}[]`;
      if (discriminator && item && typeof item === "object" && !Array.isArray(item)) {
        const disc = (item as Record<string, unknown>)[discriminator];
        if (typeof disc === "string") childPath = `${path}[${disc}]`;
      }
      walkValue(inv, childPath, item, ctx);
    }
    return;
  }

  if (ctx.recordPaths.has(path)) {
    const wildcardPath = `${path}{*}`;
    for (const v of Object.values(value as Record<string, unknown>)) {
      walkValue(inv, wildcardPath, v, ctx);
    }
    return;
  }

  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    walkValue(inv, `${path}.${k}`, v, ctx);
  }
}

/**
 * Record a single raw JSONL entry (parsed as `unknown`) into the inventory.
 * Top-level entries are bucketed on the `.type` field; entries without a
 * string `type` go into `entry[<no-type>]`.
 */
export function recordEntry(inv: Inventory, raw: unknown, ctx: WalkContext): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const type = (raw as Record<string, unknown>).type;
  const bucket = typeof type === "string" ? `entry[${type}]` : "entry[<no-type>]";
  walkValue(inv, bucket, raw, ctx);
}

/**
 * Build an inventory from a list of raw JSONL values. Convenience wrapper
 * around `recordEntry` that returns a fresh inventory.
 */
export function buildInventory(
  entries: unknown[],
  ctx: WalkContext = createDefaultContext()
): Inventory {
  const inv: Inventory = {};
  for (const e of entries) recordEntry(inv, e, ctx);
  return sortInventory(inv);
}

/**
 * Return a new inventory with keys sorted alphabetically and each type union
 * sorted. Useful for stable serialization into the baseline JSON file.
 */
export function sortInventory(inv: Inventory): Inventory {
  const sorted: Inventory = {};
  for (const k of Object.keys(inv).sort()) {
    sorted[k] = [...inv[k]].sort();
  }
  return sorted;
}
