/** Format already-recorded values for the advisory tables without creating estimates. */
export function formatForecastAggregate(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)}%` : '—';
}

/** Preserve numeric zero and categorical scores; absence stays visibly absent. */
export function formatRecordedAssessmentScore(score: unknown, maximum: unknown, categorical = false): string {
  if (score == null || score === '') return '—';
  const displayedScore = String(score);
  return !categorical && typeof maximum === 'number' && Number.isFinite(maximum)
    ? `${displayedScore} / ${maximum}`
    : displayedScore;
}

export type RecordedAssessmentColumn = { key: string; label: string; maximumScore: unknown; categorical: boolean; assessmentIndex: number };

/** Output visibility follows the applied AI output contract, not its evaluation rules. */
export function isForecastOutputEnabled(definition: { ai?: { outputFields?: unknown } }, output: string): boolean {
  return Array.isArray(definition.ai?.outputFields) && definition.ai.outputFields.includes(output);
}

/** Human-readable, unique headers for each recorded assessment column. */
export function buildRecordedAssessmentColumns(
  assessments: Array<{ id: string; title: string; assessmentDate: string; maximumScore: unknown; categorical?: boolean }>,
): RecordedAssessmentColumn[] {
  const seen = new Map<string, number>();
  return assessments.map((assessment, assessmentIndex) => {
    const base = `${assessment.title} · ${assessment.assessmentDate}`;
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    return {
      key: assessment.id,
      label: occurrence === 1 ? base : `${base} (${occurrence})`,
      maximumScore: assessment.maximumScore,
      categorical: assessment.categorical ?? false,
      assessmentIndex,
    };
  });
}
