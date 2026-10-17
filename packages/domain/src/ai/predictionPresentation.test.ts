import { describe, expect, it } from 'vitest';
import { buildUnscoredAssessmentForecastOverlays, createAssessmentForecastDomainValidator, extractValidatedSavedAiFactorValues, planForecastBatches, summarizeSavedForecast } from './predictionPresentation';
import { IT_GLOBAL_GRADING_SYSTEM } from '../grading/engine';
import { DEFAULT_EVALUATION_SYSTEM } from '../evaluation/engine';

describe('saved AI forecast presentation', () => {
  it('preserves a zero forecast and identifies freshness as time-only', () => {
    const result = summarizeSavedForecast({
      predictedStanding: 0,
      riskProbability: 0.82,
      predictionGeneratedAt: '2026-10-16T12:00:00.000Z',
      modelProvider: 'custom',
      modelName: 'apms:v1',
    }, Date.parse('2026-10-17T00:00:00.000Z'));

    expect(result.available).toBe(true);
    expect(result.predictedStanding).toBe(0);
    expect(result.riskProbability).toBe(0.82);
    expect(result.freshness).toBe('recent_by_time');
    expect(result.currentness).toBe('not_verified');
    expect(result.advisory).toBe(true);
  });

  it('does not substitute risk probability for an absent confidence value', () => {
    const result = summarizeSavedForecast({ predictedStanding: 60, riskProbability: 0.91 });
    expect(result.available).toBe(true);
    expect(result.riskProbability).toBe(0.91);
    expect(result.freshness).toBe('unknown');
  });

  it('displays only unscored forecasts and preserves numeric zero', () => {
    const overlays = buildUnscoredAssessmentForecastOverlays({
      students: [{ enrollmentId: 'a' }, { enrollmentId: 'b' }],
      assessments: [{ id: 'one' }, { id: 'two' }],
      evaluations: {
        a: { assessmentPredictions: [
          { assessment_id: 'one', result: { kind: 'numeric', value: 0, maximum: 100 } },
          { assessment_id: 'two', result: { kind: 'categorical', value: 'B' } },
          { assessment_id: 'removed', result: { kind: 'numeric', value: 20, maximum: 100 } },
        ] },
        b: { assessmentPredictions: [
          { assessment_id: 'one', result: { kind: 'numeric', value: 70, maximum: 100 } },
        ] },
      },
      scores: { 'a:two': 0 },
      categoricalScores: {},
    });

    expect(overlays.map(({ enrollmentId, assessmentId, value }) => [enrollmentId, assessmentId, value])).toEqual([
      ['a', 'one', '0 / 100'],
      ['b', 'one', '70 / 100'],
    ]);
  });

  it('suppresses saved values that no longer fit the current assessment domain', () => {
    const overlays = buildUnscoredAssessmentForecastOverlays({
      students: [{ enrollmentId: 'a' }],
      assessments: [{ id: 'numeric' }, { id: 'category' }],
      evaluations: { a: { assessmentPredictions: [
        { assessment_id: 'numeric', result: { kind: 'numeric', value: 8, maximum: 10 } },
        { assessment_id: 'category', result: { kind: 'categorical', value: 'A' } },
      ] } },
      scores: {}, categoricalScores: {},
      // The caller supplies the current grading-schema validation result.
      isPredictionValid: (id, prediction) => id === 'numeric'
        ? prediction.result.kind === 'numeric' && prediction.result.value <= 5
        : prediction.result.kind === 'categorical' && prediction.result.value === 'B',
    });
    expect(overlays).toEqual([]);
  });

  it('validates an individual saved score against the current grading domain without applying whole-class counts', () => {
    const component = IT_GLOBAL_GRADING_SYSTEM.components.find((item: any) => item.assessmentDefinition?.scoring && item.assessmentDefinition.scoring.mode !== 'value_mapping');
    expect(component).toBeDefined();
    const typeId = component.assessmentDefinition.typeId;
    const points = component.assessmentDefinition.scoring.mode === 'numeric_mapping' ? component.assessmentDefinition.scoring.mapping.map((item: any) => item.value) : [];
    const maximumScore = Math.max(10, ...points);
    const validScore = points.length ? (Math.min(...points) + Math.max(...points)) / 2 : 8;
    const constraint = { assessmentRef: 'instance', typeId, maximumScore, periodId: null, groupId: null };
    const validate = createAssessmentForecastDomainValidator(IT_GLOBAL_GRADING_SYSTEM, [constraint]);
    expect(validate('instance', { result: { kind: 'numeric', value: 0, maximum: maximumScore } })).toBe(true);
    expect(validate('instance', { result: { kind: 'numeric', value: validScore, maximum: maximumScore } })).toBe(true);
    expect(validate('instance', { result: { kind: 'numeric', value: validScore, maximum: maximumScore - 1 } })).toBe(false);
    expect(validate('unknown', { result: { kind: 'numeric', value: validScore, maximum: maximumScore } })).toBe(false);
  });

  it('suppresses a category forecast removed from the current mapping', () => {
    const component = IT_GLOBAL_GRADING_SYSTEM.components.find((item: any) => item.assessmentDefinition?.scoring?.mode === 'value_mapping');
    expect(component).toBeDefined();
    const mapping = component.assessmentDefinition.scoring.mapping;
    const validCategory = String(mapping[0].value);
    const validate = createAssessmentForecastDomainValidator(IT_GLOBAL_GRADING_SYSTEM, [{
      assessmentRef: 'category-instance', typeId: component.assessmentDefinition.typeId, maximumScore: 10,
    }]);
    expect(validate('category-instance', { result: { kind: 'categorical', value: validCategory } })).toBe(true);
    expect(validate('category-instance', { result: { kind: 'categorical', value: '__removed__' } })).toBe(false);
  });

  it('loads persisted AI categories only when the current AI factor ID and domain validate', () => {
    const factor = DEFAULT_EVALUATION_SYSTEM.factors.find((item) => item.source === 'ai_risk_level')!;
    expect(extractValidatedSavedAiFactorValues(DEFAULT_EVALUATION_SYSTEM, { [factor.id]: 'high' })).toEqual({ ai_risk_level: 'high' });
    expect(extractValidatedSavedAiFactorValues(DEFAULT_EVALUATION_SYSTEM, { [factor.id]: 'manual_high' })).toEqual({});
    expect(extractValidatedSavedAiFactorValues(DEFAULT_EVALUATION_SYSTEM, { current_standing: 0, ai_risk_level: 'high' })).toEqual({});
  });

  it('keeps a valid saved category when a different required AI score is supplied by current context', () => {
    const requiredStanding = DEFAULT_EVALUATION_SYSTEM.factors.find((item) => item.source === 'predicted_standing')!;
    const risk = DEFAULT_EVALUATION_SYSTEM.factors.find((item) => item.source === 'ai_risk_level')!;
    const definition = {
      ...DEFAULT_EVALUATION_SYSTEM,
      factors: DEFAULT_EVALUATION_SYSTEM.factors.map((item) => item.id === requiredStanding.id ? { ...item, required: true } : item),
    };
    expect(extractValidatedSavedAiFactorValues(definition, { [risk.id]: 'high' })).toEqual({ ai_risk_level: 'high' });
  });

  it('maps saved AI grading factors to the active component or group aggregation key', () => {
    const target = DEFAULT_EVALUATION_SYSTEM.factors.find((item) => item.source === 'grading_component')!;
    const manual = { ...target, id: '11111111-1111-4111-8111-111111111111', gradingComponentId: 'manual-component' };
    const aiFirst = { ...target, id: '22222222-2222-4222-8222-222222222222', aiGenerated: true, origin: 'ai_prediction' as const, gradingComponentId: 'component-1', gradingAggregation: 'highest' as const };
    const aiSecond = { ...target, id: '33333333-3333-4333-8333-333333333333', aiGenerated: true, origin: 'ai_prediction' as const, gradingComponentId: 'component-2', gradingAggregation: 'average' as const };
    const definition = {
      ...DEFAULT_EVALUATION_SYSTEM,
      factors: DEFAULT_EVALUATION_SYSTEM.factors.flatMap((item) => item.id === target.id ? [manual, aiFirst, aiSecond] : [item]),
    };
    expect(extractValidatedSavedAiFactorValues(definition, { [aiFirst.id]: 45, [aiSecond.id]: 88 })).toEqual({
      'grading_component:component-1:highest': 45,
      'grading_component:component-2:average': 88,
    });
  });

  it('plans all students across explicit API-sized batches without truncation', () => {
    const students = Array.from({ length: 250 }, (_, index) => index);
    const batches = planForecastBatches(students);
    expect(batches.map((batch) => batch.length)).toEqual([100, 100, 50]);
    expect(batches.flat()).toEqual(students);
  });
});
