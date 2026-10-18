import { describe, expect, it } from 'vitest';
import {
  buildRecordedAssessmentColumns,
  formatForecastAggregate,
  formatRecordedAssessmentScore,
  isForecastOutputEnabled,
} from '../../../../apps/mobile/src/services/forecastGradeColumns';

describe('forecast page recorded-grade columns', () => {
  it('formats existing aggregates and preserves score zero without filling missing values', () => {
    expect(formatForecastAggregate(0)).toBe('0.0%');
    expect(formatForecastAggregate(null)).toBe('—');
    expect(formatRecordedAssessmentScore(0, 20)).toBe('0 / 20');
    expect(formatRecordedAssessmentScore('A', null)).toBe('A');
    expect(formatRecordedAssessmentScore('A', 100, true)).toBe('A');
    expect(formatRecordedAssessmentScore(null, 20)).toBe('—');
  });

  it('builds distinct readable assessment headers without exposing reference ids', () => {
    const columns = buildRecordedAssessmentColumns([
      { id: 'internal-a', title: 'Quiz', assessmentDate: '2026-10-01', maximumScore: 10 },
      { id: 'internal-b', title: 'Quiz', assessmentDate: '2026-10-01', maximumScore: 10, categorical: true },
    ]);
    expect(columns.map(({ label }) => label)).toEqual([
      'Quiz · 2026-10-01',
      'Quiz · 2026-10-01 (2)',
    ]);
    expect(columns.map(({ key }) => key)).toEqual(['internal-a', 'internal-b']);
    expect(columns.map(({ assessmentIndex }) => assessmentIndex)).toEqual([0, 1]);
    expect(columns.map(({ categorical }) => categorical)).toEqual([false, true]);
  });

  it('shows predicted standing when it is an enabled model output, even without a matching evaluation factor', () => {
    expect(isForecastOutputEnabled({ ai: { outputFields: ['predicted_standing'] } }, 'predicted_standing')).toBe(true);
    expect(isForecastOutputEnabled({ ai: { outputFields: ['risk_probability'] } }, 'predicted_standing')).toBe(false);
    expect(isForecastOutputEnabled({}, 'predicted_standing')).toBe(false);
  });
});
