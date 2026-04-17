/**
 * Allowlist loader for the type-coverage audit.
 *
 * The allowlist is a YAML file declaring runtime path positions that are
 * intentionally untyped — each entry is one path pattern plus a mandatory
 * `reason`. The audit treats matched positions as opaque (no descendant
 * gaps emitted) and feeds them into the corpus capture skip-set.
 *
 * Path-pattern syntax (matches comparator gap paths and capture walk paths):
 *
 *   $                         the root (entry)
 *   $[user]                   discriminated entry where type === "user"
 *   $.message                 named property
 *   $.message.content[]       any element of an array
 *   $.toolUseResult{*}        any dynamic-key value of a Record-like position
 *   $.toolUseResult{mcp__*}   dynamic-key value where key matches the glob
 *   $.foo.*                   any descendant of $.foo (transitive)
 *   $.foo[bar]                discriminated variant where the local
 *                             discriminator value is "bar"
 *
 * Glob syntax inside `[...]` and `{...}` brackets:
 *   `*` matches any run of non-bracket characters.
 *   Anything else matches literally.
 *
 * "$.foo.*" with a trailing `.*` covers EVERY descendant of $.foo. A single
 * `.bar` at the end covers only the immediate child. `{*}` covers the
 * record-key bucket but is NOT transitive — descendants under the bucket
 * still need their own pattern (or the parent needs `.*`).
 */
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

export interface AllowlistEntry {
  /** Runtime path pattern (see syntax above). */
  path: string;
  /** Why this position is intentionally untyped. Required, non-empty. */
  reason: string;
}

export interface Allowlist {
  /** Original entries, in file order. */
  entries: AllowlistEntry[];
  /** Compiled matcher that returns the matched entry's reason or null. */
  match: (runtimePath: string) => string | null;
}

/**
 * Load and validate an allowlist YAML file. Throws with a descriptive error
 * message when entries are malformed (missing fields, non-string values,
 * empty reasons).
 */
export function loadAllowlist(filePath: string): Allowlist {
  const raw = readFileSync(filePath, "utf8");
  return parseAllowlist(raw, filePath);
}

/** Parse and validate an allowlist YAML string. */
export function parseAllowlist(yamlText: string, sourceLabel = "<inline>"): Allowlist {
  const parsed = parseYaml(yamlText) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${sourceLabel}: top-level must be an object with an "entries" key`);
  }
  const top = parsed as Record<string, unknown>;
  const rawEntries = top.entries;
  if (!Array.isArray(rawEntries)) {
    throw new Error(`${sourceLabel}: "entries" must be an array`);
  }

  const entries: AllowlistEntry[] = [];
  for (let i = 0; i < rawEntries.length; i++) {
    const e = rawEntries[i];
    if (!e || typeof e !== "object" || Array.isArray(e)) {
      throw new Error(`${sourceLabel}: entry #${i} must be an object`);
    }
    const obj = e as Record<string, unknown>;
    if (typeof obj.path !== "string" || obj.path.trim() === "") {
      throw new Error(`${sourceLabel}: entry #${i} is missing a non-empty "path" field`);
    }
    if (typeof obj.reason !== "string" || obj.reason.trim() === "") {
      throw new Error(
        `${sourceLabel}: entry #${i} (path=${JSON.stringify(obj.path)}) requires a non-empty "reason"`
      );
    }
    entries.push({ path: obj.path, reason: obj.reason });
  }

  // Compile matchers: each entry's path becomes a regex. Sort longest-first
  // so more-specific entries take precedence when multiple match.
  const compiled = entries
    .map((e) => ({ ...e, regex: compilePathPattern(e.path) }))
    .sort((a, b) => b.path.length - a.path.length);

  function match(runtimePath: string): string | null {
    for (const { regex, reason } of compiled) {
      if (regex.test(runtimePath)) return reason;
    }
    return null;
  }

  return { entries, match };
}

/**
 * Compile a path pattern (per the syntax above) into a regex that matches
 * runtime paths produced by the comparator and the corpus capture walk.
 *
 * Implementation: literal escape, then translate the special tokens:
 *   - `[*]`     → `\[[^\[\]]*\]`           (any single discriminator value)
 *   - `[FOO]`   → literal `[FOO]` (FOO already escaped)
 *   - `[GLOB]`  → translate `*` inside the brackets to `[^\[\]]*`
 *   - `{*}`     → `\{\*\}` literal (matches the comparator's `{*}` bucket)
 *   - `{GLOB}`  → translate `*` inside the braces
 *   - trailing `.*`  → matches any descendant (transitive)
 *   - other `*` → not allowed at top level (would be ambiguous)
 */
export function compilePathPattern(pattern: string): RegExp {
  // Trailing transitive wildcard
  let body = pattern;
  let trailing = "";
  if (body.endsWith(".*")) {
    body = body.slice(0, -2);
    trailing = "(?:\\..*)?";
  }

  // Translate bracketed/braced tokens, then escape everything else.
  // We process token-by-token so wildcards inside brackets/braces translate
  // separately from the surrounding literals.
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "[" || ch === "{") {
      const close = ch === "[" ? "]" : "}";
      const closeIdx = body.indexOf(close, i + 1);
      if (closeIdx === -1) throw new Error(`unclosed ${ch} in pattern: ${pattern}`);
      const inner = body.slice(i + 1, closeIdx);
      out += escapeRegex(ch);
      // Translate * inside the bracket to non-bracket-containing match
      const innerRegex = inner
        .split("*")
        .map(escapeRegex)
        .join("[^\\[\\]\\{\\}]*");
      out += innerRegex;
      out += escapeRegex(close);
      i = closeIdx;
    } else {
      out += escapeRegex(ch);
    }
  }

  return new RegExp(`^${out}${trailing}$`);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Report allowlist entries that didn't match any path during a run.
 * Stale entries are dead weight — surface them so the maintainer can prune.
 */
export function findStaleEntries(
  allowlist: Allowlist,
  runtimePathsObserved: Iterable<string>
): AllowlistEntry[] {
  const used = new Set<string>();
  for (const p of runtimePathsObserved) {
    for (const e of allowlist.entries) {
      const regex = compilePathPattern(e.path);
      if (regex.test(p)) used.add(e.path);
    }
  }
  return allowlist.entries.filter((e) => !used.has(e.path));
}
