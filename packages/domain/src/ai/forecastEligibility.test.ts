import { describe, expect, it } from 'vitest';
import { calculateGradingSystem, IT_GLOBAL_GRADING_SYSTEM } from '../grading/engine';
import { buildForecastEvidence } from '../../../../apps/mobile/src/services/forecastEligibility';

describe('forecast evidence eligibility', () => {
  it('allows mapped history with an incomplete final grade without inventing a standing', () => {
    const system = IT_GLOBAL_GRADING_SYSTEM;
    const assessmentComponent = system.components.find((component: any) => component.assessmentDefinition?.typeId);
    const assessmentType = assessmentComponent.assessmentDefinition.typeId;
    const period = system.periods[0];
    const group = (system.groups ?? []).find((item: any) => item.typeId === assessmentType)
      ?? (system.groups ?? []).find((item: any) => period.groupIds?.includes(item.id));
    const calculated = calculateGradingSystem(system, [{
      id: 'recorded-assessment',
      typeId: assessmentType,
      score: 75,
      maximumScore: 100,
      weight: 1,
      periodId: period.id,
      groupId: group?.id,
    }]);
    expect(calculated.finalGrade).toBeNull();

    const evidence = buildForecastEvidence({
      currentStanding: calculated.finalGrade,
      recentScores: [75],
      inputFeatures: ['recent_scores'],
    });
    expect(evidence).toEqual({ currentStanding: null, recentScores: [75] });
  });

  it('accepts a finite current standing, including zero, when that input is allowed', () => {
    expect(buildForecastEvidence({ currentStanding: 82.125, recentScores: [], inputFeatures: ['current_standing'] }))
      .toEqual({ currentStanding: 82.125, recentScores: [] });
    expect(buildForecastEvidence({ currentStanding: 0, recentScores: [], inputFeatures: ['current_standing'] }))
      .toEqual({ currentStanding: 0, recentScores: [] });
  });

  it('requires allowed recent-score evidence when the final grade is missing', () => {
    expect(buildForecastEvidence({ currentStanding: null, recentScores: [0], inputFeatures: ['recent_scores'] }))
      .toEqual({ currentStanding: null, recentScores: [0] });
    expect(buildForecastEvidence({ currentStanding: null, recentScores: [75], inputFeatures: ['assessment_results', 'assessment_instance_details'] }))
      .toBeNull();
    expect(buildForecastEvidence({ currentStanding: null, recentScores: [75], inputFeatures: ['current_standing'] }))
      .toBeNull();
  });

  it('rejects empty or nonfinite score evidence', () => {
    expect(buildForecastEvidence({ currentStanding: null, recentScores: [], inputFeatures: ['recent_scores'] }))
      .toBeNull();
    expect(buildForecastEvidence({ currentStanding: null, recentScores: [Number.NaN, Number.POSITIVE_INFINITY], inputFeatures: ['recent_scores'] }))
      .toBeNull();
    expect(buildForecastEvidence({ currentStanding: null, recentScores: [-0.1, 100.1], inputFeatures: ['recent_scores'] }))
      .toBeNull();
    expect(buildForecastEvidence({ currentStanding: 100.1, recentScores: [], inputFeatures: ['current_standing'] }))
      .toBeNull();
    expect(buildForecastEvidence({ currentStanding: -1, recentScores: [], inputFeatures: ['current_standing'] }))
      .toBeNull();
    expect(buildForecastEvidence({ currentStanding: 100, recentScores: [0, 100], inputFeatures: ['current_standing', 'recent_scores'] }))
      .toEqual({ currentStanding: 100, recentScores: [0, 100] });
  });
});
