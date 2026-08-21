import type { DraftContent } from "../domain/draft.js";
import { DESCRIPTION_FORMATTER_VERSION } from "../domain/draft-state.js";
import { isConfirmed, type ProvenancedValue } from "../domain/provenance.js";

export { DESCRIPTION_FORMATTER_VERSION };

function confirmedText(field: ProvenancedValue<string>): string | undefined {
  return isConfirmed(field) && field.value !== null ? field.value : undefined;
}

function confirmedList(field: ProvenancedValue<readonly string[]>): readonly string[] {
  return isConfirmed(field) && field.value !== null ? field.value : [];
}

function textSection(title: string, value: string | undefined): readonly string[] {
  return value ? [title, value] : [];
}

function bulletSection(title: string, values: readonly string[]): readonly string[] {
  return values.length > 0 ? [title, ...values.map((value) => `- ${value}`)] : [];
}

function numberedSection(title: string, values: readonly string[]): readonly string[] {
  return values.length > 0 ? [title, ...values.map((value, index) => `${index + 1}. ${value}`)] : [];
}

/** JC-004 v1: confirmed content only; empty optional sections are omitted uniformly. */
export function formatDescription(content: DraftContent): string {
  const details = [
    ...confirmedList(content.additionalDetails),
    ...confirmedList(content.links),
  ];
  const sections = [
    textSection("Контекст", confirmedText(content.context)),
    textSection("Цель / Проблема / Возможность", confirmedText(content.goalProblemOpportunity)),
    textSection("Целевая аудитория", confirmedText(content.targetAudience)),
    textSection("Что делаем / Предлагаемое решение", confirmedText(content.proposedSolution)),
    numberedSection("Критерии приёмки", confirmedList(content.acceptanceCriteria)),
    bulletSection("Ожидаемые метрики успеха", confirmedList(content.successMetrics)),
    bulletSection("Риски / ограничения / зависимости", confirmedList(content.risksConstraintsDependencies)),
    bulletSection("Дополнительные детали и ссылки", details),
  ].filter((section) => section.length > 0);
  return sections.map((section) => section.join("\n")).join("\n\n");
}
