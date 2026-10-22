import { describe, expect, it } from 'vitest';
import { buildUnscoredAssessmentForecastOverlays } from '@apms/domain';
import {
  assessmentPreviewColumnWidth,
  adaptAssessmentForecastOverlay,
  fullViewColumns,
} from './model';

const enrollmentId = 'enrollment-a';
const assessment: Parameters<typeof fullViewColumns>[0][number] = {
  id: 'assessment-a',
  title: 'Quiz 1',
  type: 'Quiz',
  component: 'wuq' as any,
  moduleNumber: 1,
  maximumScore: 10,
  assessmentDate: '2026-10-01',
  gradingPeriod: 'Period 1',
  source: 'manual',
  gradingTypeId: 'quiz-type',
  gradingGroupId: 'group-a',
  gradingPeriodId: 'period-a',
};

const gradingSystem = {
  calculationRootComponentId: 'root',
  periods: [{ id: 'period-a', name: 'Period 1', groupIds: ['group-a'] }],
  groups: [{ id: 'group-a', name: 'Group A' }],
  components: [
    { id: 'root', name: 'Course', calculation: { components: [{ componentId: 'quiz-component' }] } },
    { id: 'quiz-component', name: 'Quiz scores', assessmentDefinition: { typeId: 'quiz-type' } },
  ],
};

describe('Gradebook forecast overlay column keys', () => {
  it.each([
    [{ kind: 'numeric', value: 8, maximum: 10 } as const, '8 / 10'],
    [{ kind: 'categorical', value: 'A' } as const, 'A'],
  ])('matches the generated full-view column for %s forecasts', (result, displayedValue) => {
    const columns = fullViewColumns([assessment], gradingSystem, () => 120, false);
    const generatedColumn = columns.find((column) => column.kind === 'assessment' && column.assessment?.id === assessment.id);
    expect(generatedColumn).toBeDefined();

    const overlays = buildUnscoredAssessmentForecastOverlays({
      students: [{ enrollmentId }],
      assessments: [assessment],
      evaluations: { [enrollmentId]: { assessmentPredictions: [{ assessment_id: assessment.id, result }] } },
      scores: {},
      categoricalScores: {},
    });
    expect(overlays).toHaveLength(1);
    expect(overlays[0].value).toBe(displayedValue);

    // Exercise the same adapter used by FacultyLivePortalContent, then the key
    // lookup used by FullAssessmentView against an actual generated column.
    const hostOverlay = adaptAssessmentForecastOverlay(overlays[0]);
    const lookupKey = `${hostOverlay.enrollmentId}:${hostOverlay.columnId}`;
    const cellLookupKey = `${enrollmentId}:${generatedColumn!.id}`;
    expect(lookupKey).toBe(cellLookupKey);
    expect(hostOverlay.value).toBe(displayedValue);
  });

  it('does not create a preview when an existing numeric zero is recorded', () => {
    const overlays = buildUnscoredAssessmentForecastOverlays({
      students: [{ enrollmentId }],
      assessments: [assessment],
      evaluations: { [enrollmentId]: { assessmentPredictions: [{ assessment_id: assessment.id, result: { kind: 'numeric', value: 8, maximum: 10 } }] } },
      scores: { [`${enrollmentId}:${assessment.id}`]: 0 },
      categoricalScores: {},
    });
    expect(overlays).toEqual([]);
  });

  it('widens only columns with visible numeric or categorical previews', () => {
    const widthFor = (labels: string[]) => fullViewColumns(
      [assessment],
      gradingSystem,
      () => assessmentPreviewColumnWidth(42, labels),
      false,
    ).find((column) => column.id === 'assessment:assessment-a')!.width;

    const savedOnlyWidth = widthFor([]);
    const numericPreviewWidth = widthFor(['AI · 8.25 / 10']);
    const categoricalPreviewWidth = widthFor(['AI · Complete with distinction']);

    expect(savedOnlyWidth).toBe(42);
    expect(numericPreviewWidth).toBeGreaterThan(savedOnlyWidth);
    expect(categoricalPreviewWidth).toBeGreaterThan(numericPreviewWidth);
    expect(widthFor(['AI · ' + 'a'.repeat(200)])).toBe(320);
    // Hiding previews restores the normal saved-score width on the next render.
    expect(widthFor([])).toBe(savedOnlyWidth);
  });
});
