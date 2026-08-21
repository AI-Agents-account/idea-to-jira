import type { DraftContent, DraftFieldName } from "../domain/draft.js";
import { isConfirmed, type ProvenancedValue } from "../domain/provenance.js";

export interface DraftQuestion {
  readonly field: DraftFieldName;
  readonly kind: "REQUEST_VALUE" | "CONFIRM_PROPOSAL";
  readonly prompt: string;
}

const QUESTIONS: readonly [DraftFieldName, string][] = Object.freeze([
  ["targetAudience", "Кто является целевой аудиторией и сталкивается с этой проблемой?"],
  ["proposedSolution", "Что именно предлагается сделать и что не входит в границы решения?"],
  ["acceptanceCriteria", "Какие наблюдаемые критерии подтвердят, что решение принято?"],
  ["marketingRequired", "Какое допустимое значение Marketing Required следует выбрать?"],
  ["categoryId", "Какую допустимую Category следует выбрать?"],
  ["moscowId", "Какое допустимое значение Moscow следует выбрать?"],
  ["impactedMetricIds", "Какие допустимые Impacted Metrics затрагиваются?"],
  ["selectedRouteId", "Какой из предложенных допустимых маршрутов следует выбрать?"],
]);

function field(content: DraftContent, name: DraftFieldName): ProvenancedValue<string | readonly string[]> {
  return content[name] as ProvenancedValue<string | readonly string[]>;
}

/** Bounded deterministic question policy; confirmed fields are never asked again. */
export function selectDraftQuestions(content: DraftContent, maximum = 3): readonly DraftQuestion[] {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 3) throw new Error("DRAFT_INVALID");
  const questions: DraftQuestion[] = [];
  for (const [name, prompt] of QUESTIONS) {
    const value = field(content, name);
    if (isConfirmed(value)) continue;
    questions.push(Object.freeze({
      field: name,
      kind: value.provenance === "MODEL_PROPOSED" ? "CONFIRM_PROPOSAL" : "REQUEST_VALUE",
      prompt: value.provenance === "MODEL_PROPOSED" ? `Подтвердите предложенное значение: ${prompt}` : prompt,
    }));
    if (questions.length === maximum) break;
  }
  return Object.freeze(questions);
}
