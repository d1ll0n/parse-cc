/**
 * scripts/sync-types-md.ts
 *
 * Extracts exported `interface` and `type` declarations from src/ and syncs
 * them into the ```ts``` code fences under matching `### TypeName` headings in
 * docs/types.md. Prose descriptions, examples, and "See also" links are left
 * alone.
 *
 * The LEADING JSDoc block above each declaration is intentionally stripped
 * when writing to the doc — the prose paragraph above each `###` heading is
 * the canonical narrative in types.md. Inline field-level JSDoc is preserved
 * because it's not duplicated anywhere else.
 *
 * Usage:
 *   node --experimental-strip-types scripts/sync-types-md.ts          # rewrite docs/types.md in place
 *   node --experimental-strip-types scripts/sync-types-md.ts --check  # exit 1 if any section is out of sync
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";

interface ExtractedType {
  name: string;
  kind: "interface" | "type";
  /** The full declaration text including leading JSDoc and trailing semicolon/brace. */
  text: string;
  sourceFile: string;
}

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...walkTs(full));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Find the line index of the closing `}` that terminates an interface body. */
function findInterfaceEnd(lines: string[], startLine: number): number {
  let depth = 0;
  let seenOpening = false;
  for (let i = startLine; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") {
        depth++;
        seenOpening = true;
      } else if (ch === "}") {
        depth--;
        if (depth === 0 && seenOpening) return i;
      }
    }
  }
  return lines.length - 1;
}

/** Find the line index of the terminator of a `type Foo = ...;` declaration. */
function findTypeEnd(lines: string[], startLine: number): number {
  // Type declarations end with a line that ends in `;`. Brace-balanced so inline
  // object types don't fool us.
  let depth = 0;
  for (let i = startLine; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{" || ch === "<" || ch === "(") depth++;
      else if (ch === "}" || ch === ">" || ch === ")") depth--;
    }
    if (depth <= 0 && lines[i].trimEnd().endsWith(";")) return i;
  }
  return lines.length - 1;
}

function extractTypesFromFile(filePath: string): ExtractedType[] {
  const source = readFileSync(filePath, "utf8");
  const lines = source.split("\n");
  const out: ExtractedType[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const interfaceMatch = /^export interface (\w+)/.exec(line);
    const typeMatch = /^export type (\w+)/.exec(line);

    if (interfaceMatch) {
      const name = interfaceMatch[1];
      const endLine = findInterfaceEnd(lines, i);
      // Start from the `export` line, intentionally skipping any leading JSDoc.
      // The prose paragraph above each `###` heading in types.md is the
      // canonical narrative; leading JSDoc here would duplicate it.
      const text = lines.slice(i, endLine + 1).join("\n");
      out.push({ name, kind: "interface", text, sourceFile: filePath });
      i = endLine + 1;
    } else if (typeMatch) {
      const name = typeMatch[1];
      const endLine = findTypeEnd(lines, i);
      const text = lines.slice(i, endLine + 1).join("\n");
      out.push({ name, kind: "type", text, sourceFile: filePath });
      i = endLine + 1;
    } else {
      i++;
    }
  }
  return out;
}

interface SyncResult {
  /** Count of `### TypeName` sections that were updated (or would be, in --check mode). */
  changes: number;
  /** Types found in source that had no matching `### TypeName` section in the doc. */
  missingInDoc: string[];
  /** `### Name` headings in the doc that had no matching source type. */
  missingInSource: string[];
}

function syncTypesMd(docPath: string, types: ExtractedType[], check: boolean): SyncResult {
  const content = readFileSync(docPath, "utf8");
  const lines = content.split("\n");
  const typeByName = new Map(types.map((t) => [t.name, t]));

  const result: string[] = [];
  let changes = 0;
  const syncedNames = new Set<string>();
  const unknownHeadings: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const headingMatch = /^### (\w+)/.exec(line);
    if (!headingMatch) {
      result.push(line);
      i++;
      continue;
    }

    const typeName = headingMatch[1];
    const extracted = typeByName.get(typeName);
    if (!extracted) {
      // `### Name` that isn't a recognized exported type — leave it alone.
      // (E.g. subsection headings, or types that stopped being exported.)
      unknownHeadings.push(typeName);
      result.push(line);
      i++;
      continue;
    }

    syncedNames.add(typeName);
    result.push(line);
    i++;

    // Skip prose lines until we hit the first ```ts fence or the next heading.
    while (i < lines.length && !/^```ts\s*$/.test(lines[i])) {
      if (/^#{1,6} /.test(lines[i])) break;
      result.push(lines[i]);
      i++;
    }

    if (i >= lines.length || !/^```ts\s*$/.test(lines[i] ?? "")) {
      // No ts fence under this heading — nothing to sync here.
      continue;
    }

    // At the opening ```ts.
    result.push(lines[i]); // opening fence
    i++;

    // Capture the existing fenced content and skip past it.
    const oldContentStart = i;
    while (i < lines.length && lines[i] !== "```") i++;
    const oldContent = lines.slice(oldContentStart, i).join("\n");

    // Emit the refreshed declaration text.
    for (const newLine of extracted.text.split("\n")) {
      result.push(newLine);
    }

    // Closing fence.
    if (i < lines.length) {
      result.push(lines[i]);
      i++;
    }

    if (oldContent !== extracted.text) {
      changes++;
    }
  }

  const missingInDoc = types.filter((t) => !syncedNames.has(t.name)).map((t) => `${t.name} (${t.sourceFile})`);
  const missingInSource = unknownHeadings;

  const newContent = result.join("\n");

  if (check) {
    if (changes > 0) {
      process.exitCode = 1;
    }
  } else {
    if (newContent !== content) {
      writeFileSync(docPath, newContent);
    }
  }

  return { changes, missingInDoc, missingInSource };
}

function main(): void {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const verbose = args.includes("--verbose") || args.includes("-v");

  const srcFiles = walkTs("src");
  const allTypes = srcFiles.flatMap(extractTypesFromFile);

  if (verbose) {
    console.error(`[sync-types-md] scanned ${srcFiles.length} source files, found ${allTypes.length} exported types`);
  }

  const { changes, missingInDoc, missingInSource } = syncTypesMd("docs/types.md", allTypes, check);

  if (check) {
    if (changes > 0) {
      console.error(`[sync-types-md] ${changes} section(s) out of sync with source. Run 'npm run types:sync' to update.`);
      process.exit(1);
    } else {
      console.log("[sync-types-md] docs/types.md is in sync with source.");
    }
  } else {
    console.log(`[sync-types-md] ${changes} section(s) updated in docs/types.md`);
  }

  if (missingInDoc.length > 0) {
    console.warn(`[sync-types-md] WARNING: ${missingInDoc.length} exported type(s) have no section in docs/types.md:`);
    for (const m of missingInDoc) console.warn(`  - ${m}`);
  }
  if (missingInSource.length > 0) {
    console.warn(`[sync-types-md] WARNING: ${missingInSource.length} '### ...' heading(s) in docs/types.md have no matching source type:`);
    for (const m of missingInSource) console.warn(`  - ${m}`);
  }
}

main();
