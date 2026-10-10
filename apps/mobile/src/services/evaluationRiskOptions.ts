import type { EvaluationDefinition, EvaluationResult } from '@apms/domain';

export type RiskSelectOption = { label: string; value: string };

export function evaluationRiskValue(definition: EvaluationDefinition, result: EvaluationResult) {
  if (result.matchedLevelId) return `level:${definition.id}:${result.matchedLevelId}`;
  return result.severity === 'unavailable' ? 'unavailable' : 'unmatched';
}

export function evaluationRiskOptions(
  definitions: EvaluationDefinition | EvaluationDefinition[],
  allLabel = 'All risk levels',
): RiskSelectOption[] {
  const definitionList = Array.isArray(definitions) ? definitions : [definitions];
  const uniqueDefinitions = [...new Map(definitionList.map((definition) => [definition.id, definition])).values()];
  const levels = uniqueDefinitions.flatMap((definition) => definition.levels.map((level) => ({ definition, level })))
    .sort((left, right) => right.level.priority - left.level.priority || left.level.name.localeCompare(right.level.name));
  const duplicateNames = new Set(levels.filter(({ level }, index) => levels.findIndex((candidate) => candidate.level.name === level.name) !== index).map(({ level }) => level.name));
  return [
    { label: allLabel, value: 'all' },
    ...levels.map(({ definition, level }) => ({
      label: `${level.name}${duplicateNames.has(level.name) ? ` · ${definition.name}` : ''} (${level.severity} risk)`,
      value: `level:${definition.id}:${level.id}`,
    })),
    { label: 'No matching risk level', value: 'unmatched' },
    { label: 'Risk unavailable', value: 'unavailable' },
  ];
}
