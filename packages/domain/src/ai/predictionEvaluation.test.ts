import { describe, expect, it } from 'vitest';
import { DEFAULT_EVALUATION_SYSTEM, type EvaluationDefinition } from '../evaluation/engine';
import { validateAiEvaluationScores } from './validation';
import { projectPredictionValuesToAIFactors } from '../../../../apps/mobile/src/services/predictionEvaluation';

describe('post-response model evaluation values', () => {
  it('accepts valid model outputs while leaving locally derived context outside model validation', () => {
    const modelValues = {
      current_standing: 15,
      predicted_standing: 72,
      risk_probability: 0.4,
      model_confidence: null,
      trend: 'stable',
      recent_trend: 'stable',
      ai_risk_level: 'medium',
      prediction_available: true,
      prediction_age_hours: 0,
      ai_factor_count: 0,
      data_basis: 'applied_grading_and_evaluation_schemas',
    };
    const projected = projectPredictionValuesToAIFactors(DEFAULT_EVALUATION_SYSTEM, modelValues);
    expect(projected).not.toBeNull();
    const validation = validateAiEvaluationScores(DEFAULT_EVALUATION_SYSTEM, projected!);

    expect(validation.valid).toBe(true);
    expect(validation.values.predicted_standing).toBe(72);
    expect(validation.values.risk_probability).toBe(0.4);
    expect(projected).not.toHaveProperty('current_standing');
    expect(projected).not.toHaveProperty('prediction_available');
    expect(projected).not.toHaveProperty('prediction_age_hours');
  });

  it('projects distinct AI factor IDs independently and excludes non-AI factors', () => {
    const definition: EvaluationDefinition = {
      ...DEFAULT_EVALUATION_SYSTEM,
      factors: [
        ...DEFAULT_EVALUATION_SYSTEM.factors,
        { id: 'custom-factor-a', name: 'Custom A', source: 'grading_group', origin: 'ai_prediction', aiGenerated: true, minimum: 0, maximum: 100 },
        { id: 'custom-factor-b', name: 'Custom B', source: 'grading_group', origin: 'ai_prediction', aiGenerated: true, minimum: 0, maximum: 100 },
      ],
    };
    const projected = projectPredictionValuesToAIFactors(definition, {
      predicted_standing: 72,
      risk_probability: 0.4,
      ai_risk_level: 'medium',
      trend: 'stable',
      ai_factor_count: 0,
      data_basis: 'applied_grading_and_evaluation_schemas',
      'custom-factor-a': 45,
      'custom-factor-b': 88,
      grading_group: 1,
      current_standing: 0,
    });

    expect(projected).not.toBeNull();
    expect(projected).toMatchObject({ 'custom-factor-a': 45, 'custom-factor-b': 88 });
    expect(projected).not.toHaveProperty('current_standing');
  });

  it('keeps active factor type and range validation strict', () => {
    const projected = projectPredictionValuesToAIFactors(DEFAULT_EVALUATION_SYSTEM, {
      predicted_standing: 101,
      risk_probability: 0.2,
      ai_risk_level: 'medium',
      trend: 'stable',
      ai_factor_count: 0,
      data_basis: 'applied_grading_and_evaluation_schemas',
    });
    expect(projected).not.toBeNull();
    expect(validateAiEvaluationScores(DEFAULT_EVALUATION_SYSTEM, projected!).valid).toBe(false);
  });

  it('rejects unknown or manual score IDs instead of silently dropping them', () => {
    const manualFactor = DEFAULT_EVALUATION_SYSTEM.factors.find((factor) => factor.source === 'current_standing')!;
    expect(projectPredictionValuesToAIFactors(DEFAULT_EVALUATION_SYSTEM, {}, [manualFactor.id])).toBeNull();
    expect(projectPredictionValuesToAIFactors(DEFAULT_EVALUATION_SYSTEM, {}, ['not-in-the-active-schema'])).toBeNull();
  });
});
