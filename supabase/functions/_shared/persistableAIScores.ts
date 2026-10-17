type EvaluationFactor = {
  id: string
  source: string
  aiGenerated?: boolean
  origin?: string
  categories?: string[]
}

type PredictionWithScores = {
  evaluation_scores?: unknown
  ai_risk_level?: unknown
}

/**
 * Preserve a validated model-owned risk category inside the existing score
 * payload. `risk_level` stays the deterministic snapshot written by the
 * established RPC, so the model value must live under its own factor ID.
 */
export function persistableAIScores(
  prediction: PredictionWithScores,
  factors: readonly EvaluationFactor[],
  outputFields: ReadonlySet<string>,
): Record<string, unknown> {
  const currentScores = prediction.evaluation_scores
  const scores: Record<string, unknown> = currentScores && typeof currentScores === 'object' && !Array.isArray(currentScores)
    ? { ...(currentScores as Record<string, unknown>) }
    : {}

  if (!outputFields.has('risk_level') || typeof prediction.ai_risk_level !== 'string') return scores
  const factor = factors.find((item) => item.source === 'ai_risk_level'
    && (item.aiGenerated === true || item.origin === 'ai_prediction'))
  if (!factor || (factor.categories?.length && !factor.categories.includes(prediction.ai_risk_level))) return scores

  scores[factor.id] = prediction.ai_risk_level
  return scores
}
