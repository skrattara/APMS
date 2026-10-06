import Ajv2020 from 'ajv/dist/2020';
import schema from './evaluation_system_schema.json';

export type EvaluationMetric = 'current_standing' | 'mastery' | 'attendance' | 'attendance_rate' | 'recent_scores' | 'recent_score_average' | 'recent_trend' | 'missing_assessment_count' | 'predicted_standing' | 'risk_probability' | 'ai_risk_level' | 'trend' | 'model_confidence' | 'prediction_available' | 'prediction_age_hours' | 'ai_factor_count' | 'data_basis' | 'grading_component' | 'grading_group';
export type EvaluationScalar = number | string | boolean;
export type EvaluationValue = Partial<Record<EvaluationMetric | string, EvaluationScalar | EvaluationScalar[] | null>>;
export type EvaluationDefinition = {
  id: string; name: string; description?: string;
  schemaVersion?: number;
  definitionVersion?: number;
  effectiveFrom?: string; effectiveUntil?: string;
  factors: { id: string; name: string; source: EvaluationMetric; valueType?: 'number' | 'number_array' | 'boolean' | 'category'; unit?: string; origin?: 'academic_record' | 'derived' | 'ai_prediction'; required?: boolean; missingValuePolicy?: 'ignore_rule' | 'treat_as_zero' | 'unavailable'; minimum?: number; maximum?: number; categories?: string[]; windowSize?: number; weight?: number; gradingComponentId?: string; gradingGroupId?: string; gradingAggregation?: 'average' | 'highest' | 'lowest'; aiGenerated?: boolean; description?: string }[];
  levels: { id: string; name: string; severity: 'low' | 'medium' | 'high'; priority: number; match: 'any' | 'all'; rules: { factorId: string; operator: string; threshold: EvaluationScalar | EvaluationScalar[]; description?: string }[]; color?: string }[];
  classification?: { strategy?: 'priority' | 'weighted'; colorScheme?: 'green_to_red' | 'white_to_red' | 'custom'; unmatchedSeverity?: 'low' | 'medium' | 'high'; missingValuePolicy?: 'ignore_rule' | 'treat_as_zero' | 'return_unavailable'; minimumEvidenceCount?: number; requireRecentPrediction?: boolean; maximumPredictionAgeHours?: number };
  ai?: { enabled?: boolean; advisoryOnly?: true; institutionallyValidated?: false; provider?: string; modelName?: string; modelVersion?: string; supportedScenarios?: string[]; inputFeatures?: string[]; outputFields?: string[]; riskProbabilityMeaning?: 'heuristic' | 'calibrated'; minimumConfidence?: number; unavailablePolicy?: 'continue_with_available_rules' | 'return_unavailable'; explanationPolicy?: 'show_model_factors_as_advisory' | 'hide_model_factors' };
  decisionPolicy?: { advisoryOnly?: true; maySetOfficialGrade?: false; mayApplyAutomaticPenalty?: false; requiresEducatorReview?: boolean; officialRecordSystem?: string };
  explanation?: { includeMatchedRules?: boolean; includeInputValues?: boolean; includeMissingInputs?: boolean; includeAiFactors?: boolean };
};

export type EvaluationResult = { severity: 'low' | 'medium' | 'high' | 'unavailable'; matchedLevelId: string | null; matchedRuleIds: string[]; evidenceCount: number; unavailableFactors: string[] };

const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addFormat('date-time', { type: 'string', validate: (value: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) });
const validateSchema = ajv.compile(schema as object);
function inferredValueType(source: EvaluationMetric): 'number' | 'number_array' | 'boolean' | 'category' {
  if (['recent_trend', 'ai_risk_level', 'trend', 'data_basis'].includes(source)) return 'category';
  if (source === 'prediction_available') return 'boolean';
  if (source === 'recent_scores') return 'number_array';
  return 'number';
}
function isCompatibleValue(factor: EvaluationDefinition['factors'][number], value: unknown): boolean {
  if (value === null || value === undefined) return true;
  const type = factor.valueType ?? inferredValueType(factor.source);
  if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return false;
  if (type === 'number' && typeof value === 'number' && ((factor.minimum != null && value < factor.minimum) || (factor.maximum != null && value > factor.maximum))) return false;
  if (type === 'number_array' && (!Array.isArray(value) || value.some((item) => typeof item !== 'number' || !Number.isFinite(item)))) return false;
  if (type === 'boolean' && typeof value !== 'boolean') return false;
  if (type === 'category' && (typeof value !== 'string' || (factor.categories?.length && !factor.categories.includes(value)))) return false;
  return true;
}
function valueForFactor(factor: EvaluationDefinition['factors'][number], values: EvaluationValue) {
  const aggregation = factor.gradingAggregation ?? 'average';
  if (factor.source === 'grading_component' && factor.gradingComponentId) return values[`grading_component:${factor.gradingComponentId}:${aggregation}`];
  if (factor.source === 'grading_group' && factor.gradingGroupId) return values[`grading_group:${factor.gradingGroupId}:${aggregation}`];
  return values[factor.source];
}
export function validateEvaluationSystem(value: unknown): { valid: boolean; errors: string[] } {
  if (!validateSchema(value)) return { valid: false, errors: (validateSchema.errors ?? []).map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`) };
  const definition = value as EvaluationDefinition;
  const errors: string[] = [];
  if (new Set(definition.factors.map((factor) => factor.id)).size !== definition.factors.length) errors.push('Factor IDs must be unique.');
  if (new Set(definition.levels.map((level) => level.id)).size !== definition.levels.length) errors.push('Risk level IDs must be unique.');
  const factors = new Map(definition.factors.map((factor) => [factor.id, factor]));
  const numericOperators = new Set(['below', 'at_most', 'above', 'at_least']);
  const priorities = definition.levels.map((level) => level.priority);
  if (new Set(priorities).size !== priorities.length) errors.push('Risk level priorities must be unique so rule order is deterministic.');
  const usedFactorIds = new Set(definition.levels.flatMap((level) => level.rules.map((rule) => rule.factorId)));
  for (const factor of definition.factors) {
    if (factor.minimum != null && factor.maximum != null && factor.minimum > factor.maximum) errors.push(`${factor.name} minimum cannot exceed its maximum.`);
    const inferred = inferredValueType(factor.source);
    if (factor.valueType && factor.valueType !== inferred) errors.push(`${factor.name} value type does not match its data source.`);
    if (factor.missingValuePolicy === 'treat_as_zero' && inferred !== 'number') errors.push(`${factor.name} can only treat missing numeric values as zero.`);
    if (factor.weight != null && (!Number.isFinite(factor.weight) || factor.weight < 0 || factor.weight > 100)) errors.push(`${factor.name} weight must be between 0 and 100.`);
    if (usedFactorIds.has(factor.id) && factor.source === 'grading_component' && !factor.gradingComponentId) errors.push(`${factor.name} must select a grading component before it can be used in a rule.`);
    if (usedFactorIds.has(factor.id) && factor.source === 'grading_group' && !factor.gradingGroupId) errors.push(`${factor.name} must select a grading group before it can be used in a rule.`);
  }
  for (const level of definition.levels) for (const rule of level.rules) {
    const factor = factors.get(rule.factorId);
    if (!factor) { errors.push(`Risk level ${level.name} references an unknown factor.`); continue; }
    const valueType = factor.valueType ?? inferredValueType(factor.source);
    if (['below', 'at_most', 'above', 'at_least'].includes(rule.operator) && valueType !== 'number') errors.push(`${level.name} uses a numeric condition on non-numeric factor ${factor.name}.`);
    if (['contains', 'not_contains'].includes(rule.operator) && valueType !== 'number_array') errors.push(`${level.name} uses a contains condition on non-list factor ${factor.name}.`);
    if (['is_true', 'is_false'].includes(rule.operator) && valueType !== 'boolean') errors.push(`${level.name} uses a boolean condition on non-boolean factor ${factor.name}.`);
    if (['below', 'at_most', 'above', 'at_least'].includes(rule.operator) && typeof rule.threshold !== 'number') errors.push(`${level.name} requires a numeric threshold for ${factor.name}.`);
    const expectedScalarType = valueType === 'category' ? 'string' : valueType;
    if (['equals', 'not_equals'].includes(rule.operator) && valueType !== 'number_array' && typeof rule.threshold !== expectedScalarType) errors.push(`${level.name} expected value type does not match ${factor.name}.`);
    if (['in', 'not_in'].includes(rule.operator) && (valueType !== 'category' || (typeof rule.threshold !== 'string' && !Array.isArray(rule.threshold)))) errors.push(`${level.name} can use an inclusion list only with a categorical factor.`);
    if (['contains', 'not_contains'].includes(rule.operator) && typeof rule.threshold !== 'number') errors.push(`${level.name} requires a numeric value for ${factor.name}.`);
    if (numericOperators.has(rule.operator) && typeof rule.threshold === 'number' && ((factor.minimum != null && rule.threshold < factor.minimum) || (factor.maximum != null && rule.threshold > factor.maximum))) errors.push(`${level.name} threshold is outside ${factor.name}'s allowed range.`);
  }
  if (!definition.levels.some((level) => level.severity === 'low')) errors.push('Add a low risk level as the fallback.');
  if (definition.effectiveFrom && definition.effectiveUntil && new Date(definition.effectiveFrom) >= new Date(definition.effectiveUntil)) errors.push('Effective end date must be after the start date.');
  return { valid: errors.length === 0, errors };
}

export const DEFAULT_EVALUATION_SYSTEM: EvaluationDefinition = {
  schemaVersion: 2,
  definitionVersion: 1, id: 'a9b1ea2d-3494-4df2-b045-14882e19c4d2', name: 'APMS Student Performance Evaluation',
  description: 'Monitoring guidance based on current standing, attendance, recent results, and advisory prediction signals. This is not an official SIS grade.',
  factors: [
    { id: '01531263-ec02-4a8b-9ac9-1dc571ab6519', name: 'Current standing', source: 'current_standing', unit: 'percentage', origin: 'academic_record', minimum: 0, maximum: 100 },
    { id: '32ec788c-7bfd-4e3e-b46c-2dbbd8fab97f', name: 'Grade component', source: 'grading_component', gradingAggregation: 'average', unit: 'percentage', origin: 'academic_record', minimum: 0, maximum: 100 },
    { id: '91e29a08-5922-4e78-8ba7-5b06d2435ad9', name: 'Attendance', source: 'attendance_rate', unit: 'percentage', origin: 'academic_record', minimum: 0, maximum: 100 },
    { id: '69e99f50-18da-465c-95d7-2cb2c8fa1307', name: 'Recent score average', source: 'recent_score_average', unit: 'percentage', origin: 'derived', minimum: 0, maximum: 100, windowSize: 5 },
    { id: '1f4a693e-ff84-4e9d-97d1-84a765d6e10c', name: 'Missing assessments', source: 'missing_assessment_count', unit: 'count', origin: 'derived', minimum: 0 },
    { id: 'fbd5e933-10cc-4e1b-9dc6-70e3a7eeb329', name: 'Predicted standing', source: 'predicted_standing', unit: 'percentage', origin: 'ai_prediction', minimum: 0, maximum: 100, aiGenerated: true },
    { id: '6d19c71f-333e-44aa-9b20-1a364840a778', name: 'AI risk probability', source: 'risk_probability', unit: 'probability', origin: 'ai_prediction', minimum: 0, maximum: 1, aiGenerated: true },
    { id: '6110f7d6-3ce6-4ffb-903d-56660217cf18', name: 'AI risk level', source: 'ai_risk_level', valueType: 'category', unit: 'category', origin: 'ai_prediction', categories: ['low', 'medium', 'high'], aiGenerated: true },
    { id: '18f42072-e8eb-416b-8142-3c92c76d263b', name: 'Performance trend', source: 'trend', valueType: 'category', unit: 'category', origin: 'ai_prediction', categories: ['improving', 'stable', 'declining'], aiGenerated: true },
    { id: '25d40d71-5a39-49a7-bd4a-eacbdcc9fc48', name: 'Prediction available', source: 'prediction_available', valueType: 'boolean', unit: 'boolean', origin: 'derived' },
    { id: 'f3c5f591-6e51-4f17-9e73-1e2ae49f80ac', name: 'AI explanation factor count', source: 'ai_factor_count', unit: 'count', origin: 'ai_prediction', minimum: 0, aiGenerated: true },
    { id: '821c03e5-3f92-4179-9c21-1d31f42a8395', name: 'Prediction age', source: 'prediction_age_hours', unit: 'count', origin: 'derived', minimum: 0 },
    { id: '3ad79be7-4ce9-4e61-85fa-91a125d3cf9b', name: 'AI data basis', source: 'data_basis', valueType: 'category', unit: 'category', origin: 'ai_prediction', aiGenerated: true }
  ],
  levels: [
    { id: 'e99f5100-6c55-4609-aefb-04f6e9144a28', name: 'High Risk', severity: 'high', color: '#CA2121', priority: 30, match: 'any', rules: [
      { factorId: '01531263-ec02-4a8b-9ac9-1dc571ab6519', operator: 'below', threshold: 70 },
      { factorId: '91e29a08-5922-4e78-8ba7-5b06d2435ad9', operator: 'below', threshold: 70 },
      { factorId: 'fbd5e933-10cc-4e1b-9dc6-70e3a7eeb329', operator: 'below', threshold: 70 },
      { factorId: '6d19c71f-333e-44aa-9b20-1a364840a778', operator: 'at_least', threshold: 0.7 },
      { factorId: '6110f7d6-3ce6-4ffb-903d-56660217cf18', operator: 'equals', threshold: 'high' }
    ] },
    { id: 'b1c00f6e-1d43-40a0-a7d6-8e79e6f7fe9e', name: 'Medium Risk', severity: 'medium', color: '#CACA21', priority: 20, match: 'any', rules: [
      { factorId: '01531263-ec02-4a8b-9ac9-1dc571ab6519', operator: 'below', threshold: 80 },
      { factorId: '91e29a08-5922-4e78-8ba7-5b06d2435ad9', operator: 'below', threshold: 80 },
      { factorId: 'fbd5e933-10cc-4e1b-9dc6-70e3a7eeb329', operator: 'below', threshold: 80 },
      { factorId: '6d19c71f-333e-44aa-9b20-1a364840a778', operator: 'at_least', threshold: 0.4 },
      { factorId: '6110f7d6-3ce6-4ffb-903d-56660217cf18', operator: 'equals', threshold: 'medium' },
      { factorId: '18f42072-e8eb-416b-8142-3c92c76d263b', operator: 'equals', threshold: 'declining' }
    ] },
    { id: 'ea27f1ee-cdce-467f-b0eb-34d4a57b1af5', name: 'Low Risk', severity: 'low', color: '#21CA21', priority: 10, match: 'any', rules: [] }
  ],
  classification: { unmatchedSeverity: 'low', missingValuePolicy: 'ignore_rule', minimumEvidenceCount: 1, requireRecentPrediction: false, colorScheme: 'green_to_red' },
  ai: { enabled: true, advisoryOnly: true, institutionallyValidated: false, provider: 'Gemini', supportedScenarios: ['minimum', 'maximum', 'minimum_pass', 'stable', 'custom'], inputFeatures: ['current_standing', 'recent_scores', 'attendance_rate', 'missing_assessment_count'], outputFields: ['predicted_standing', 'risk_probability', 'risk_level', 'trend', 'factors', 'model_version', 'data_basis', 'generated_at'], riskProbabilityMeaning: 'heuristic', unavailablePolicy: 'continue_with_available_rules', explanationPolicy: 'show_model_factors_as_advisory' },
  decisionPolicy: { advisoryOnly: true, maySetOfficialGrade: false, mayApplyAutomaticPenalty: false, requiresEducatorReview: true, officialRecordSystem: 'SWU SIS' },
  explanation: { includeMatchedRules: true, includeInputValues: true, includeMissingInputs: true, includeAiFactors: true }
};

/** Drops the retired standalone mastery factor from previously saved evaluation definitions. */
export function removeStandaloneMasteryFactor(definition: EvaluationDefinition): EvaluationDefinition {
  const removedIds = new Set(definition.factors.filter((factor) => factor.source === 'mastery').map((factor) => factor.id));
  if (!removedIds.size) return definition;
  return {
    ...definition,
    factors: definition.factors.filter((factor) => !removedIds.has(factor.id)),
    levels: definition.levels.map((level) => ({ ...level, rules: level.rules.filter((rule) => !removedIds.has(rule.factorId)) })),
  };
}

function ruleMatches(value: EvaluationScalar | EvaluationScalar[], operator: string, threshold: EvaluationScalar | EvaluationScalar[]): boolean {
  if (operator === 'is_available') return value !== null && value !== undefined;
  if (operator === 'is_unavailable') return value === null || value === undefined;
  if (operator === 'is_true') return value === true;
  if (operator === 'is_false') return value === false;
  if (operator === 'contains' || operator === 'not_contains') { const contains = Array.isArray(value) ? value.includes(threshold as EvaluationScalar) : String(value).includes(String(threshold)); return operator === 'contains' ? contains : !contains; }
  if (operator === 'in' || operator === 'not_in') { const contains = Array.isArray(threshold) ? threshold.includes(value as EvaluationScalar) : String(threshold).split(',').map((item) => item.trim()).includes(String(value)); return operator === 'in' ? contains : !contains; }
  if (operator === 'equals' || operator === 'not_equals') { const equal = String(value) === String(threshold); return operator === 'equals' ? equal : !equal; }
  const numericValue = Number(value); const numericThreshold = Number(threshold);
  if (!Number.isFinite(numericValue) || !Number.isFinite(numericThreshold)) return false;
  if (operator === 'below') return numericValue < numericThreshold;
  if (operator === 'at_most') return numericValue <= numericThreshold;
  if (operator === 'above') return numericValue > numericThreshold;
  if (operator === 'at_least') return numericValue >= numericThreshold;
  return false;
}

export function evaluateStudentPerformanceDetailed(definition: EvaluationDefinition, values: EvaluationValue): EvaluationResult {
  const validation = validateEvaluationSystem(definition);
  if (!validation.valid) throw new Error(`Invalid evaluation system: ${validation.errors.join(' ')}`);
  const factors = new Map(definition.factors.map((factor) => [factor.id, factor]));
  const levels = [...definition.levels].sort((a, b) => b.priority - a.priority);
  const unavailableFactors: string[] = [];
  const evidenceCount = definition.factors.filter((factor) => isCompatibleValue(factor, valueForFactor(factor, values)) && valueForFactor(factor, values) !== null && valueForFactor(factor, values) !== undefined).length;
  const minimumEvidenceCount = definition.classification?.minimumEvidenceCount ?? 1;
  const handlesUnavailable = definition.levels.some((level) => level.rules.some((rule) => rule.operator === 'is_unavailable'));
  if (evidenceCount < minimumEvidenceCount && !handlesUnavailable) return { severity: 'unavailable', matchedLevelId: null, matchedRuleIds: [], evidenceCount, unavailableFactors: definition.factors.map((factor) => factor.name) };
  const requiredFactors = definition.factors.filter((factor) => factor.required || factor.missingValuePolicy === 'unavailable');
  const missingRequired = requiredFactors.filter((factor) => !isCompatibleValue(factor, valueForFactor(factor, values)) || valueForFactor(factor, values) === null || valueForFactor(factor, values) === undefined);
  if (missingRequired.length) return { severity: 'unavailable', matchedLevelId: null, matchedRuleIds: [], evidenceCount, unavailableFactors: missingRequired.map((factor) => factor.name) };
  if (definition.ai?.enabled && definition.ai.unavailablePolicy === 'return_unavailable') {
    const unavailableAiFactors = definition.factors.filter((factor) => (factor.aiGenerated || factor.origin === 'ai_prediction') && (valueForFactor(factor, values) === null || valueForFactor(factor, values) === undefined));
    if (unavailableAiFactors.length) return { severity: 'unavailable', matchedLevelId: null, matchedRuleIds: [], evidenceCount, unavailableFactors: unavailableAiFactors.map((factor) => factor.name) };
  }
  if (definition.classification?.requireRecentPrediction && values.prediction_available !== true) return { severity: 'unavailable', matchedLevelId: null, matchedRuleIds: [], evidenceCount, unavailableFactors: ['Recent AI prediction'] };
  if (definition.classification?.maximumPredictionAgeHours != null && (typeof values.prediction_age_hours !== 'number' || values.prediction_age_hours > definition.classification.maximumPredictionAgeHours)) return { severity: 'unavailable', matchedLevelId: null, matchedRuleIds: [], evidenceCount, unavailableFactors: ['AI prediction is stale or unavailable'] };
  const confidence = values.model_confidence;
  const weightedMatches: { level: EvaluationDefinition['levels'][number]; matchedRuleIds: string[]; score: number }[] = [];
  for (const level of levels) {
    if (level.severity === 'low' && level.rules.length === 0) continue;
    const outcomes: { match: boolean; ruleId: string; factorName: string; factorId: string }[] = level.rules.flatMap((rule, ruleIndex) => {
      const factor = factors.get(rule.factorId);
      if (!factor) return [];
      let value = valueForFactor(factor, values);
      if (!isCompatibleValue(factor, value)) { unavailableFactors.push(factor.name); value = null; }
      if ((factor.aiGenerated || factor.origin === 'ai_prediction') && typeof confidence === 'number' && definition.ai?.minimumConfidence != null && confidence < definition.ai.minimumConfidence) value = null;
      if ((value === null || value === undefined) && factor.required) unavailableFactors.push(factor.name);
      if ((value === null || value === undefined) && !['is_unavailable', 'is_available'].includes(rule.operator) && factor.missingValuePolicy === 'treat_as_zero' && inferredValueType(factor.source) === 'number') value = 0;
      else if ((value === null || value === undefined) && !['is_unavailable', 'is_available'].includes(rule.operator) && definition.classification?.missingValuePolicy === 'treat_as_zero' && inferredValueType(factor.source) === 'number') value = 0;
      if ((value === null || value === undefined) && rule.operator !== 'is_unavailable' && rule.operator !== 'is_available') { unavailableFactors.push(factor.name); return []; }
      const matches = ruleMatches(value as EvaluationScalar | EvaluationScalar[], rule.operator, rule.threshold);
      return [{ match: matches, ruleId: `${level.id}:${ruleIndex}`, factorName: factor.name, factorId: factor.id }];
    });
    const matches = outcomes.length > 0 && (level.match === 'all' ? outcomes.length === level.rules.length && outcomes.every((item) => item.match) : outcomes.some((item) => item.match));
    if (matches) {
      const matched = outcomes.filter((item) => item.match);
      const matchedRuleIds = matched.map((item) => item.ruleId);
      if (definition.classification?.strategy !== 'weighted') return { severity: level.severity, matchedLevelId: level.id, matchedRuleIds, evidenceCount, unavailableFactors: [...new Set(unavailableFactors)] };
      const factorIds = new Set(matched.map((item) => item.factorId));
      const score = [...factorIds].reduce((total, factorId) => total + (factors.get(factorId)?.weight ?? 1), 0);
      weightedMatches.push({ level, matchedRuleIds, score });
    }
  }
  if (weightedMatches.length) {
    const winner = weightedMatches.sort((a, b) => b.score - a.score || b.level.priority - a.level.priority)[0];
    return { severity: winner.level.severity, matchedLevelId: winner.level.id, matchedRuleIds: winner.matchedRuleIds, evidenceCount, unavailableFactors: [...new Set(unavailableFactors)] };
  }
  if (definition.classification?.missingValuePolicy === 'return_unavailable' && unavailableFactors.length) return { severity: 'unavailable', matchedLevelId: null, matchedRuleIds: [], evidenceCount, unavailableFactors: [...new Set(unavailableFactors)] };
  return { severity: definition.classification?.unmatchedSeverity ?? 'low', matchedLevelId: null, matchedRuleIds: [], evidenceCount, unavailableFactors: [...new Set(unavailableFactors)] };
}

export function evaluateStudentPerformance(definition: EvaluationDefinition, values: EvaluationValue): 'low' | 'medium' | 'high' | 'unavailable' {
  const result = evaluateStudentPerformanceDetailed(definition, values);
  return result.severity;
}
