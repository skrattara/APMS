export type ForecastEvidence = {
  currentStanding: number | null;
  recentScores: number[];
};

const isPercentage = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;

/** Return finite numeric evidence only when the applied AI inputs allow using it. */
export function buildForecastEvidence(input: {
  currentStanding: unknown;
  recentScores: readonly unknown[];
  inputFeatures: readonly string[];
}): ForecastEvidence | null {
  const allowed = new Set(input.inputFeatures);
  const standing = isPercentage(input.currentStanding)
    ? input.currentStanding
    : null;
  const scores = input.recentScores.filter(isPercentage);
  const hasAllowedStanding = allowed.has('current_standing') && standing != null;
  const hasAllowedRecentScores = allowed.has('recent_scores') && scores.length > 0;
  // The current runtime adapter consumes recent_scores for history forecasting;
  // assessment_results alone is not yet a usable numeric-history input.
  if (!hasAllowedStanding && !hasAllowedRecentScores) return null;
  return { currentStanding: standing, recentScores: scores };
}
