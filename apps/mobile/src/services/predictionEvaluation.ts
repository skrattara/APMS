import type { EvaluationDefinition } from '@apms/domain';

/**
 * Restrict post-response values to factors the active schema explicitly marks
 * as AI-owned. Preserve ID keys when multiple schema factors share a source;
 * source keys are only a fallback for built-in prediction outputs.
 */
export function projectPredictionValuesToAIFactors(
  definition: EvaluationDefinition,
  modelValues: Record<string, unknown>,
  evaluationScoreIds: readonly string[] = [],
): Record<string, unknown> | null {
  const aiFactorIds = new Set(definition.factors
    .filter((factor) => factor.aiGenerated === true || factor.origin === 'ai_prediction')
    .map((factor) => factor.id));
  // The gateway persists custom evaluation scores by their original schema
  // IDs. Fail closed if any returned ID is unknown or belongs to a manual
  // factor; silently filtering it would hide an invalid service response.
  if (evaluationScoreIds.some((id) => !aiFactorIds.has(id))) return null;

  const projected: Record<string, unknown> = {};
  for (const factor of definition.factors) {
    if (factor.aiGenerated !== true && factor.origin !== 'ai_prediction') continue;
    if (Object.prototype.hasOwnProperty.call(modelValues, factor.id)) {
      projected[factor.id] = modelValues[factor.id];
    } else if (Object.prototype.hasOwnProperty.call(modelValues, factor.source)) {
      projected[factor.id] = modelValues[factor.source];
    }
  }
  return projected;
}
