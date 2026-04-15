import type { LogEntry } from "../types/entries.js";
import { isAttachmentEntry } from "../types/entries.js";
import type { SkillListingPayload } from "../types/attachments.js";

/**
 * Skill availability information extracted from the first `skill_listing`
 * attachment in a session.
 *
 * Sessions predating Claude Code v2.1.94 do not emit `skill_listing`
 * attachments; for those, `listing` is null and `names` is empty.
 */
export interface SkillsInfo {
  /** The raw skill_listing attachment payload, or null if none was found. */
  listing: SkillListingPayload | null;
  /** Parsed skill names extracted from the bullet list in `listing.content`.
   * Plugin-scoped names (e.g. `"plugin-dev:plugin-structure"`) are preserved
   * in full — the colon within the name is not treated as a separator. */
  names: string[];
}

/**
 * Find the first `skill_listing` attachment in a session and parse its
 * content into a list of skill names.
 *
 * Each line of the listing that starts with `"- "` is treated as a skill
 * entry. The name is everything before the first `": "` (colon-space)
 * separator, which allows plugin-scoped names like
 * `"plugin-dev:plugin-structure"` to round-trip correctly — the colon inside
 * the name is not confused with the description separator.
 *
 * Returns `{ listing: null, names: [] }` for sessions that predate
 * Claude Code v2.1.94 and therefore never emit this attachment type.
 */
export function extractSkills(entries: LogEntry[]): SkillsInfo {
  for (const e of entries) {
    if (!isAttachmentEntry(e)) continue;
    if (e.attachment.type !== "skill_listing") continue;
    const payload = e.attachment;
    const names: string[] = [];
    for (const line of payload.content.split("\n")) {
      if (!line.startsWith("- ")) continue;
      const rest = line.slice(2);
      // Split on first ": " (colon followed by space) — this handles plugin-scoped
      // names like "plugin-dev:plugin-structure: desc" where the name itself contains a colon.
      const sep = rest.indexOf(": ");
      if (sep > 0) names.push(rest.slice(0, sep).trim());
    }
    return { listing: payload, names };
  }
  return { listing: null, names: [] };
}
