import { validateGradingSystem, type GradingDefinition } from '../grading/engine';
import { validateAiEvaluationScores } from './validation';
import type { AiAssessmentConstraint } from './validation';
import type { EvaluationDefinition } from '../evaluation/engine';

export type SavedForecastLike = {
  predictedStanding?: number | null;
  riskProbability?: number | null;
  predictionGeneratedAt?: string | null;
  modelProvider?: string | null;
  modelName?: string | null;
  modelVersion?: string | null;
  dataBasis?: string | null;
};

export type ForecastFreshness = 'recent_by_time' | 'older_by_time' | 'unknown';

/**
 * A display-only summary of the latest saved forecast. Time freshness is not
 * data freshness: the current API does not persist a comparable record/schema
 * fingerprint, so this function never claims the forecast matches current data.
 */
export function summarizeSavedForecast(
  forecast: SavedForecastLike | null | undefined,
  nowMs = Date.now(),
  recentWindowMs = 24 * 60 * 60 * 1000,
) {
  const value = forecast?.predictedStanding;
  const available = typeof value === 'number' && Number.isFinite(value);
  const probability = forecast?.riskProbability;
  const riskProbability = typeof probability === 'number' && Number.isFinite(probability) && probability >= 0 && probability <= 1
    ? probability
    : null;
  const generatedAtMs = forecast?.predictionGeneratedAt ? Date.parse(forecast.predictionGeneratedAt) : Number.NaN;
  const ageHours = Number.isFinite(generatedAtMs) && Number.isFinite(nowMs)
    ? Math.max(0, (nowMs - generatedAtMs) / 3_600_000)
    : null;
  const freshness: ForecastFreshness = ageHours == null
    ? 'unknown'
    : ageHours <= recentWindowMs / 3_600_000 ? 'recent_by_time' : 'older_by_time';

  return {
    available,
    predictedStanding: available ? value : null,
    riskProbability,
    generatedAt: Number.isFinite(generatedAtMs) ? new Date(generatedAtMs).toISOString() : null,
    ageHours,
    freshness,
    modelProvider: forecast?.modelProvider || null,
    modelName: forecast?.modelName || null,
    modelVersion: forecast?.modelVersion || null,
    dataBasis: forecast?.dataBasis || null,
    advisory: true as const,
    currentness: 'not_verified' as const,
  };
}

export type AssessmentForecastForDisplay = {
  enrollmentId: string;
  assessmentId: string;
  value: string;
  label: string;
  color: string;
  /** Preserve numeric values so a host can apply its own display precision. */
  numericValue?: number;
  numericMaximum?: number;
};

/**
 * Compile current, per-instance grading rules for validating stored overlays.
 * This intentionally does not re-run whole-roster count constraints: a single
 * saved forecast is checked against its current type and score/category domain.
 */
export function createAssessmentForecastDomainValidator(
  grading: GradingDefinition,
  assessments: readonly AiAssessmentConstraint[],
): (assessmentId: string, prediction: { result: { kind: 'numeric'; value: number; maximum: number } | { kind: 'categorical'; value: string } }) => boolean {
  if (!validateGradingSystem(grading).valid) return () => false;
  const domains = new Map(assessments.map((assessment) => {
    const scoring = grading.components.find((component: any) => component.assessmentDefinition?.typeId === assessment.typeId)?.assessmentDefinition?.scoring;
    return [assessment.assessmentRef, { assessment, scoring }] as const;
  }));
  return (assessmentId, prediction) => {
    const domain = domains.get(assessmentId);
    if (!domain?.scoring || !Number.isFinite(domain.assessment.maximumScore) || domain.assessment.maximumScore <= 0) return false;
    const { scoring } = domain;
    if (scoring.mode === 'value_mapping') {
      return prediction.result.kind === 'categorical'
        && typeof prediction.result.value === 'string'
        && scoring.mapping.some((item: any) => String(item.value) === prediction.result.value);
    }
    if (prediction.result.kind !== 'numeric') return false;
    const { value, maximum } = prediction.result;
    if (!Number.isFinite(value) || value < 0 || value > domain.assessment.maximumScore || maximum !== domain.assessment.maximumScore) return false;
    if (scoring.mode === 'numeric_mapping') {
      const points = scoring.mapping.map((item: any) => item.value).filter((item: unknown): item is number => typeof item === 'number' && Number.isFinite(item));
      if (!points.length || value < Math.min(...points) || value > Math.max(...points)) return false;
    }
    return true;
  };
}

/** Validate persisted model-owned factor IDs before they can affect evaluation. */
export function extractValidatedSavedAiFactorValues(definition: EvaluationDefinition, persisted: unknown) {
  if (!persisted || typeof persisted !== 'object' || Array.isArray(persisted)) return {};
  const record = persisted as Record<string, unknown>;
  // Stored explanations may contain only a subset of AI-owned factors. Relax
  // absence requirements here; the evaluation engine combines these values
  // with current context and enforces its required-factor and confidence rules.
  const partialDefinition: EvaluationDefinition = {
    ...definition,
    factors: definition.factors.map((factor) => {
      const isModelOwned = factor.aiGenerated === true || factor.origin === 'ai_prediction';
      return isModelOwned
        ? { ...factor, required: false, missingValuePolicy: factor.missingValuePolicy === 'unavailable' ? 'ignore_rule' : factor.missingValuePolicy }
        : factor;
    }),
  };
  const result: Record<string, unknown> = {};
  for (const factor of definition.factors) {
    if ((factor.aiGenerated !== true && factor.origin !== 'ai_prediction') || !Object.prototype.hasOwnProperty.call(record, factor.id)) continue;
    // Validate one ID at a time so different factors sharing a source never
    // collapse into one value or overwrite a manual factor's value.
    const validated = validateAiEvaluationScores(partialDefinition, { [factor.id]: record[factor.id] });
    if (!validated.valid || !Object.prototype.hasOwnProperty.call(validated.values, factor.source)) return {};
    const aggregation = factor.gradingAggregation ?? 'average';
    const key = factor.source === 'grading_component' && factor.gradingComponentId
      ? `grading_component:${factor.gradingComponentId}:${aggregation}`
      : factor.source === 'grading_group' && factor.gradingGroupId
        ? `grading_group:${factor.gradingGroupId}:${aggregation}`
        : factor.source;
    result[key] = validated.values[factor.source];
  }
  return result;
}

/** Split large classes into independent, explicit batches accepted by the API. */
export function planForecastBatches<T>(items: readonly T[], batchSize = 100): T[][] {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new RangeError('Forecast batch size must be an integer from 1 to 100.');
  }
  const batches: T[][] = [];
  for (let offset = 0; offset < items.length; offset += batchSize) {
    batches.push(items.slice(offset, offset + batchSize));
  }
  return batches;
}

/** Build read-only gradebook overlays and suppress any assessment now scored. */
export function buildUnscoredAssessmentForecastOverlays<T extends {
  assessmentPredictions?: Array<{
    assessment_id: string;
    result: { kind: 'numeric'; value: number; maximum: number } | { kind: 'categorical'; value: string };
  }>;
}>(input: {
  students: Array<{ enrollmentId: string }>;
  assessments: Array<{ id: string }>;
  evaluations: Record<string, T | undefined>;
  scores: Record<string, number | null | undefined>;
  categoricalScores: Record<string, string | null | undefined>;
  /** Validate the saved output against the current grading/assessment rules. */
  isPredictionValid?: (assessmentId: string, prediction: NonNullable<T['assessmentPredictions']>[number]) => boolean;
}): AssessmentForecastForDisplay[] {
  const validAssessmentIds = new Set(input.assessments.map((assessment) => assessment.id));
  return input.students.flatMap((student) => (input.evaluations[student.enrollmentId]?.assessmentPredictions ?? []).flatMap((prediction) => {
    const key = `${student.enrollmentId}:${prediction.assessment_id}`;
    if (!validAssessmentIds.has(prediction.assessment_id) || input.scores[key] != null || input.categoricalScores[key] != null
      || (input.isPredictionValid && !input.isPredictionValid(prediction.assessment_id, prediction))) return [];
    const value = prediction.result.kind === 'numeric'
      ? `${prediction.result.value} / ${prediction.result.maximum}`
      : prediction.result.value;
    return [{
      enrollmentId: student.enrollmentId,
      assessmentId: prediction.assessment_id,
      value,
      label: `AI · ${value}`,
      color: '#64748B',
      ...(prediction.result.kind === 'numeric'
        ? { numericValue: prediction.result.value, numericMaximum: prediction.result.maximum }
        : {}),
    }];
  }));
}
