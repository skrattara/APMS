import { describe, expect, it } from 'vitest';
import { DEFAULT_EVALUATION_SYSTEM, evaluateStudentPerformanceDetailed } from './engine';

function definition() {
  return { ...DEFAULT_EVALUATION_SYSTEM, ai: { ...DEFAULT_EVALUATION_SYSTEM.ai, minimumConfidence: 0.8 } };
}

describe('minimum AI confidence gating', () => {
  it('does not treat high failure probability as model confidence', () => {
    const result = evaluateStudentPerformanceDetailed(definition(), {
      current_standing: 95,
      predicted_standing: 95,
      risk_probability: 0.99,
      ai_risk_level: 'high',
      model_confidence: null,
    });
    expect(result.severity).toBe('low');
    expect(result.unavailableFactors).toContain('AI risk probability');
  });

  it('disables AI factors when confidence is missing or below the configured minimum', () => {
    for (const confidence of [null, Number.NaN, -0.1, 1.01, 0.79]) {
      const result = evaluateStudentPerformanceDetailed(definition(), {
        current_standing: 95, risk_probability: 0.99, model_confidence: confidence,
      });
      expect(result.severity).toBe('low');
    }
  });

  it('uses AI factors when independent confidence meets the threshold', () => {
    const result = evaluateStudentPerformanceDetailed(definition(), {
      current_standing: 95,
      risk_probability: 0.99,
      model_confidence: 0.9,
    });
    expect(result.severity).toBe('high');
  });

  it('honors return-unavailable when confidence blocks required AI evidence', () => {
    const configured = definition();
    configured.ai = { ...configured.ai, unavailablePolicy: 'return_unavailable' };
    const result = evaluateStudentPerformanceDetailed(configured, {
      current_standing: 95, risk_probability: 0.99, model_confidence: null,
    });
    expect(result.severity).toBe('unavailable');
  });
});
