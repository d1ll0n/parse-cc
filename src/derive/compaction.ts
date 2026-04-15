import type { LogEntry } from "../types/entries.js";
import { isAssistantEntry, isUserEntry } from "../types/entries.js";

/**
 * Tokens consumed during a single phase between two compaction events.
 *
 * A phase begins at the start of the session or immediately after a
 * compaction and ends when the next compaction fires.
 */
export interface CompactionPhase {
  phaseNumber: number;
  /** Net tokens added to context consumption during this phase. Computed as
   * the phase's peak tokens minus the post-compaction baseline from the
   * previous phase. */
  contribution: number;
  /** Highest context token count observed at the start of this phase (the
   * last main-chain assistant input_tokens seen before the compaction). */
  peakTokens: number;
  /** Token count immediately after the compaction that ended this phase.
   * Undefined for the final phase when no compaction followed it. */
  postCompaction?: number;
}

/**
 * Aggregated result of compaction analysis for a session.
 *
 * `contextConsumption` is a measure of total unique context processed across
 * all phases — it is the sum of per-phase contributions, not the peak token
 * count. This accounts for tokens that were "reclaimed" by compaction and
 * reused in later phases.
 */
export interface CompactionAnalysis {
  /** Total unique context tokens consumed across all phases. Undefined when
   * the session contains no main-chain assistant entries. */
  contextConsumption: number | undefined;
  /** Ordered breakdown of context growth and compaction events. */
  phases: CompactionPhase[];
  compactionCount: number;
}

/**
 * Analyze context compaction events within a session and compute per-phase
 * token consumption.
 *
 * Ported from claude-devtools. Only main-chain assistant entries are
 * considered — sidechain entries (`isSidechain === true`) and entries with
 * model `"<synthetic>"` are ignored. Returns `contextConsumption: undefined`
 * when the session contains no qualifying assistant entries at all.
 *
 * Each compaction event is detected by a user entry with `isCompactSummary`
 * set. The token count immediately before and after each compaction boundary
 * is used to calculate the net contribution of every phase.
 */
export function analyzeCompaction(entries: LogEntry[]): CompactionAnalysis {
  let lastMainAssistantInputTokens = 0;
  const compactionPhases: { pre: number; post: number }[] = [];
  let awaitingPostCompaction = false;

  for (const e of entries) {
    if (isAssistantEntry(e) && !e.isSidechain && e.message.model !== "<synthetic>") {
      const u = e.message.usage;
      const inputTokens =
        (u.input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0);
      if (inputTokens > 0) {
        if (awaitingPostCompaction && compactionPhases.length > 0) {
          compactionPhases[compactionPhases.length - 1].post = inputTokens;
          awaitingPostCompaction = false;
        }
        lastMainAssistantInputTokens = inputTokens;
      }
    }
    if (isUserEntry(e) && e.isCompactSummary) {
      compactionPhases.push({ pre: lastMainAssistantInputTokens, post: 0 });
      awaitingPostCompaction = true;
    }
  }

  if (lastMainAssistantInputTokens === 0) {
    return {
      contextConsumption: undefined,
      phases: [],
      compactionCount: compactionPhases.length,
    };
  }

  const phases: CompactionPhase[] = [];
  let total = 0;

  if (compactionPhases.length === 0) {
    total = lastMainAssistantInputTokens;
    phases.push({
      phaseNumber: 1,
      contribution: lastMainAssistantInputTokens,
      peakTokens: lastMainAssistantInputTokens,
    });
  } else {
    const first = compactionPhases[0].pre;
    total += first;
    phases.push({
      phaseNumber: 1,
      contribution: first,
      peakTokens: compactionPhases[0].pre,
      postCompaction: compactionPhases[0].post,
    });
    for (let i = 1; i < compactionPhases.length; i++) {
      const contribution = compactionPhases[i].pre - compactionPhases[i - 1].post;
      total += contribution;
      phases.push({
        phaseNumber: i + 1,
        contribution,
        peakTokens: compactionPhases[i].pre,
        postCompaction: compactionPhases[i].post,
      });
    }
    const last = compactionPhases[compactionPhases.length - 1];
    if (last.post > 0) {
      const lastContribution = lastMainAssistantInputTokens - last.post;
      total += lastContribution;
      phases.push({
        phaseNumber: compactionPhases.length + 1,
        contribution: lastContribution,
        peakTokens: lastMainAssistantInputTokens,
      });
    }
  }

  return { contextConsumption: total, phases, compactionCount: compactionPhases.length };
}
