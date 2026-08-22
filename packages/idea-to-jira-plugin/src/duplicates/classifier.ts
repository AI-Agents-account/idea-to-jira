import type { VersionedDraft } from "../domain/draft.js";
import type { DuplicateDecision, JiraSearchBinding, JiraSearchResult } from "../jira/types.js";

function tokens(value: unknown): Set<string> {
  if (typeof value !== "string") return new Set();
  return new Set((value.toLocaleLowerCase("ru").match(/[\p{L}\p{N}]{3,}/gu) ?? []).slice(0, 2_000));
}
function similarity(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let intersection = 0; for (const item of left) if (right.has(item)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}
function sameBinding(left: JiraSearchBinding, right: JiraSearchBinding): boolean {
  return left.draftId === right.draftId && left.draftVersion === right.draftVersion && left.configHash === right.configHash && left.metadataHash === right.metadataHash;
}
export function assertCurrentDuplicateDecision(decision: DuplicateDecision, expected: JiraSearchBinding): void {
  if (!sameBinding(decision.binding, expected)) throw new Error("JIRA_STALE_BINDING");
}
export function classifyDuplicates(draft: VersionedDraft, search: JiraSearchResult): DuplicateDecision {
  if (search.binding.draftId !== draft.id || search.binding.draftVersion !== draft.version) throw new Error("JIRA_STALE_BINDING");
  const source = tokens(`${draft.content.summary.value ?? ""} ${draft.description}`);
  const ranked = search.candidates.map((candidate) => {
    const candidateText = Object.values(candidate.fields).filter((value) => typeof value === "string").join(" ");
    return { key: candidate.key, score: similarity(source, tokens(candidateText)) };
  }).sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  const best = ranked[0]?.score ?? 0; let outcome: DuplicateDecision["outcome"]; let recommendedAction: DuplicateDecision["recommendedAction"]; let reason: string;
  if (best >= 0.72) { outcome = "DUPLICATE"; recommendedAction = "USE_EXISTING"; reason = "A Jira candidate has very high bounded textual overlap."; }
  else if (best >= 0.35) { outcome = "RELATED"; recommendedAction = "REVIEW_RELATED"; reason = "One or more Jira candidates appear related but are not an exact duplicate."; }
  else if (!search.complete) { outcome = "UNCERTAIN"; recommendedAction = "CLARIFY_OR_OVERRIDE"; reason = "The configured Jira search was partial or failed, so uniqueness cannot be established."; }
  else { outcome = "UNIQUE"; recommendedAction = "PROCEED"; reason = "No materially similar issue was found in the complete bounded configured search."; }
  return Object.freeze({ outcome, candidateKeys: Object.freeze(ranked.slice(0, 5).filter((item) => item.score > 0).map((item) => item.key)), confidence: Math.round((outcome === "UNIQUE" ? 1 - best : best) * 100) / 100, reason, recommendedAction, binding: search.binding });
}
