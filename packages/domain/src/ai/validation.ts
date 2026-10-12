import type { EvaluationDefinition, EvaluationValue } from '../evaluation/engine';
import { validateEvaluationSystem } from '../evaluation/engine';
import type { GradingDefinition } from '../grading/engine';
import { validateGradingSystem } from '../grading/engine';
import type { AiAssessmentScorePredictionOutput, AiStandingPredictionOutput } from './contracts';

/** Safe, request-local assessment context. `assessmentRef` is random and is never a database ID. */
export type AiAssessmentConstraint = {
  assessmentRef: string;
  typeId: string;
  maximumScore: number;
  periodId?: string | null;
  groupId?: string | null;
  weight?: number | null;
  optional?: boolean;
};

function assessmentDefinitionFor(grading: GradingDefinition, typeId: string) {
  return grading.components.find((component: any) => component.assessmentDefinition?.typeId === typeId)?.assessmentDefinition;
}

/** Shared strict validation for the live standing/risk forecast response. */
export function validateAiStandingPrediction(
  grading: GradingDefinition,
  evaluation: EvaluationDefinition,
  output: AiStandingPredictionOutput,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const gradingValidation = validateGradingSystem(grading);
  const evaluationValidation = validateEvaluationSystem(evaluation);
  if (!gradingValidation.valid) errors.push(...gradingValidation.errors);
  if (!evaluationValidation.valid) errors.push(...evaluationValidation.errors);
  if (!gradingValidation.valid || !evaluationValidation.valid) return { valid: false, errors };
  const factor = (source: string) => evaluation.factors.find((item) => item.source === source);
  const standing = factor('predicted_standing');
  if (typeof output?.predictedStanding !== 'number' || !Number.isFinite(output.predictedStanding) || output.predictedStanding < Math.max(0, standing?.minimum ?? 0) || output.predictedStanding > Math.min(100, standing?.maximum ?? 100)) errors.push('Predicted standing is outside the active grading/evaluation range.');
  const probability = factor('risk_probability');
  if (output?.riskProbability != null && (typeof output.riskProbability !== 'number' || !Number.isFinite(output.riskProbability) || output.riskProbability < Math.max(0, probability?.minimum ?? 0) || output.riskProbability > Math.min(1, probability?.maximum ?? 1))) errors.push('Risk probability is outside the active evaluation range.');
  if ((probability?.required || probability?.missingValuePolicy === 'unavailable') && output?.riskProbability == null) errors.push('The active evaluation criteria require a risk-probability score.');
  if (!['improving', 'stable', 'declining'].includes(output?.trend)) errors.push('Trend is not an allowed value.');
  const trend = factor('trend') ?? factor('recent_trend');
  if (trend?.categories?.length && !trend.categories.includes(output.trend)) errors.push('Trend is not an active evaluation category.');
  const risk = factor('ai_risk_level');
  if (output?.aiRiskLevel != null && !risk?.categories?.includes(output.aiRiskLevel)) errors.push('AI risk level is not an active evaluation category.');
  if ((risk?.required || risk?.missingValuePolicy === 'unavailable') && output?.aiRiskLevel == null) errors.push('The active evaluation criteria require an AI risk category.');
  if (!Array.isArray(output?.factors) || output.factors.length > 8 || output.factors.some((item) => typeof item !== 'string' || item.length > 500)) errors.push('Prediction evidence must contain at most eight text items of at most 500 characters.');
  return { valid: errors.length === 0, errors };
}

/** Validate model-produced assessment results without clamping or repairing invalid output. */
export function validateAiAssessmentScorePrediction(
  grading: GradingDefinition,
  assessments: readonly AiAssessmentConstraint[],
  output: AiAssessmentScorePredictionOutput,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const gradingValidation = validateGradingSystem(grading);
  if (!gradingValidation.valid) return { valid: false, errors: gradingValidation.errors };
  if (!Array.isArray(output?.predictions)) return { valid: false, errors: ['Assessment predictions must be a list.'] };
  const byRef = new Map(assessments.map((assessment) => [assessment.assessmentRef, assessment]));
  if (byRef.size !== assessments.length) errors.push('Assessment references must be unique within a request.');
  const seen = new Set<string>();
  for (const assessment of assessments) {
    const scoring = assessmentDefinitionFor(grading, assessment.typeId);
    if (!scoring) errors.push(`Assessment ${assessment.assessmentRef} is not a type used by the active grading system.`);
    if (assessment.weight != null && (typeof assessment.weight !== 'number' || !Number.isFinite(assessment.weight) || assessment.weight < 0)) errors.push(`Assessment ${assessment.assessmentRef} has an invalid instance weight.`);
    if (scoring?.aggregation?.mode === 'weighted' && assessment.weight == null) errors.push(`Assessment ${assessment.assessmentRef} needs an instance weight for weighted aggregation.`);
    if (assessment.periodId && !grading.periods?.some((period: any) => period.id === assessment.periodId)) errors.push(`Assessment ${assessment.assessmentRef} references an unknown grading period.`);
    const group = assessment.groupId ? grading.groups?.find((item: any) => item.id === assessment.groupId) : undefined;
    if (assessment.groupId && !group) errors.push(`Assessment ${assessment.assessmentRef} references an unknown grading group.`);
    if (assessment.periodId && group && Array.isArray(grading.periods?.find((period: any) => period.id === assessment.periodId)?.groupIds)) {
      const period = grading.periods.find((item: any) => item.id === assessment.periodId);
      const groupAncestors = new Set<string>();
      if (assessment.groupId) groupAncestors.add(assessment.groupId);
      let parent = group;
      while (parent?.parentGroupId && !groupAncestors.has(parent.parentGroupId)) {
        groupAncestors.add(parent.parentGroupId);
        parent = grading.groups.find((item: any) => item.id === parent.parentGroupId);
      }
      if (!period.groupIds.some((id: string) => groupAncestors.has(id))) errors.push(`Assessment ${assessment.assessmentRef} has a group outside its assigned period.`);
    }
  }
  for (const prediction of output.predictions) {
    const ref = prediction?.assessmentRef;
    const assessment = typeof ref === 'string' ? byRef.get(ref) : undefined;
    if (!assessment || seen.has(ref)) { errors.push('A prediction references an unknown or repeated assessment instance.'); continue; }
    seen.add(ref);
    if (typeof assessment.maximumScore !== 'number' || !Number.isFinite(assessment.maximumScore) || assessment.maximumScore <= 0) {
      errors.push(`Assessment ${ref} has an invalid maximum score.`); continue;
    }
    const definition = assessmentDefinitionFor(grading, assessment.typeId);
    if (!definition?.scoring) { errors.push(`Assessment ${ref} does not map to an assessment scoring definition.`); continue; }
    const result: any = prediction.result;
    if (definition.scoring.mode === 'value_mapping') {
      const allowed = definition.scoring.mapping.map((item: any) => String(item.value));
      if (result?.kind !== 'categorical' || typeof result.value !== 'string' || !allowed.includes(result.value)) errors.push(`Assessment ${ref} must use one of the categories allowed by its grading definition.`);
    } else {
      if (result?.kind !== 'numeric' || typeof result.value !== 'number' || !Number.isFinite(result.value) || result.value < 0 || result.value > assessment.maximumScore) {
        errors.push(`Assessment ${ref} must have a numeric score from 0 through its instance maximum.`); continue;
      }
      if (result.maximum !== assessment.maximumScore) errors.push(`Assessment ${ref} must use its instance maximum score.`);
      if (definition.scoring.mode === 'numeric_mapping') {
        const values = definition.scoring.mapping.map((item: any) => item.value as number);
        const minimum = Math.min(...values);
        const maximum = Math.max(...values);
        if (result.value < minimum || result.value > maximum) errors.push(`Assessment ${ref} is outside the numeric mapping range in its grading definition.`);
      }
    }
    if (prediction.confidence != null && (typeof prediction.confidence !== 'number' || !Number.isFinite(prediction.confidence) || prediction.confidence < 0 || prediction.confidence > 1)) errors.push(`Assessment ${ref} confidence must be from 0 to 1.`);
    if (prediction.evidence != null && (!Array.isArray(prediction.evidence) || prediction.evidence.length > 8 || prediction.evidence.some((item) => typeof item !== 'string' || item.length > 500))) errors.push(`Assessment ${ref} evidence is invalid.`);
  }
  for (const assessment of assessments) if (!assessment.optional && !seen.has(assessment.assessmentRef)) errors.push(`A required assessment result prediction is missing for ${assessment.assessmentRef}.`);
  for (const component of grading.components as any[]) {
    const definition = component.assessmentDefinition;
    if (!definition?.count) continue;
    const matching = assessments.filter((assessment) => assessment.typeId === definition.typeId);
    const countInScope = (scope: readonly AiAssessmentConstraint[]) =>
      (definition.count.min != null && scope.length < definition.count.min) || (definition.count.max != null && scope.length > definition.count.max);
    const scopeType = definition.count.scope?.type ?? 'overall';
    if (scopeType === 'overall' && countInScope(matching)) errors.push(`Assessment count for ${definition.typeId} violates the active overall count constraint.`);
    else if (scopeType === 'per_period') for (const period of grading.periods ?? []) {
      if (countInScope(matching.filter((assessment) => assessment.periodId === period.id))) errors.push(`Assessment count for ${definition.typeId} violates the count constraint in a grading period.`);
    }
    else if (scopeType === 'per_group') for (const group of grading.groups ?? []) {
      if (group.typeId !== definition.count.scope.groupTypeId) continue;
      if (countInScope(matching.filter((assessment) => assessment.groupId === group.id))) errors.push(`Assessment count for ${definition.typeId} violates the count constraint in a grading group.`);
    }
  }
  return { valid: errors.length === 0, errors };
}

/** Accepts AI values only for AI-owned factors and enforces each active factor's declared domain. */
export function validateAiEvaluationScores(
  definition: EvaluationDefinition,
  values: Record<string, unknown>,
): { valid: boolean; errors: string[]; values: EvaluationValue } {
  const errors: string[] = [];
  const validation = validateEvaluationSystem(definition);
  if (!validation.valid) return { valid: false, errors: validation.errors, values: {} };
  const accepted: EvaluationValue = {};
  for (const factor of definition.factors) {
    const isAiOwned = factor.aiGenerated === true || factor.origin === 'ai_prediction';
    const hasId = Object.prototype.hasOwnProperty.call(values, factor.id);
    const hasSource = Object.prototype.hasOwnProperty.call(values, factor.source);
    if (!hasId && !hasSource) {
      if ((factor.required || factor.missingValuePolicy === 'unavailable') && (factor.aiGenerated || factor.origin === 'ai_prediction')) errors.push(`The required AI evaluation score for ${factor.id} is missing.`);
      continue;
    }
    if (!isAiOwned) { errors.push(`The model cannot provide the non-AI evaluation factor ${factor.id}.`); continue; }
    const value = hasId ? values[factor.id] : values[factor.source];
    if (value === null) {
      if (factor.required || factor.missingValuePolicy === 'unavailable') errors.push(`The required AI evaluation score for ${factor.id} cannot be null.`);
      else accepted[factor.source] = null;
      continue;
    }
    const type = factor.valueType ?? (['trend', 'recent_trend', 'ai_risk_level', 'data_basis'].includes(factor.source) ? 'category' : 'number');
    if (type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value) || (factor.minimum != null && value < factor.minimum) || (factor.maximum != null && value > factor.maximum)) errors.push(`The AI evaluation score for ${factor.id} is outside its declared numeric range.`);
      else accepted[factor.source] = value;
    } else if (type === 'category') {
      if (typeof value !== 'string' || (factor.categories?.length && !factor.categories.includes(value))) errors.push(`The AI evaluation score for ${factor.id} is not an allowed category.`);
      else accepted[factor.source] = value;
    } else if (type === 'boolean') {
      if (typeof value !== 'boolean') errors.push(`The AI evaluation score for ${factor.id} must be boolean.`);
      else accepted[factor.source] = value;
    } else {
      if (!Array.isArray(value) || value.length > 1000 || value.some((item) => typeof item !== 'number' || !Number.isFinite(item) || (factor.minimum != null && item < factor.minimum) || (factor.maximum != null && item > factor.maximum))) errors.push(`The AI evaluation scores for ${factor.id} are invalid.`);
      else accepted[factor.source] = value;
    }
  }
  for (const key of Object.keys(values)) if (!definition.factors.some((factor) => factor.id === key || factor.source === key)) errors.push(`The model returned an unknown evaluation factor ${key}.`);
  return { valid: errors.length === 0, errors, values: accepted };
}
