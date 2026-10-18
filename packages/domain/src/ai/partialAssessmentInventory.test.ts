import { describe, expect, it } from 'vitest';
import { IT_GLOBAL_GRADING_SYSTEM } from '../grading/engine';
import { validateAiAssessmentScorePrediction } from './validation';

describe('partial assessment inventory validation', () => {
  it('skips only minimum-count checks in partial mode and keeps strict mode as the default', () => {
    const component = IT_GLOBAL_GRADING_SYSTEM.components.find((item: any) => item.assessmentDefinition?.count?.min != null);
    expect(component).toBeDefined();
    const typeId = component!.assessmentDefinition!.typeId;
    const countScope = component!.assessmentDefinition!.count.scope;
    const group = countScope?.type === 'per_group'
      ? IT_GLOBAL_GRADING_SYSTEM.groups?.find((item: any) => item.typeId === countScope.groupTypeId)
      : undefined;
    const period = countScope?.type === 'per_period'
      ? IT_GLOBAL_GRADING_SYSTEM.periods?.[0]
      : group
        ? IT_GLOBAL_GRADING_SYSTEM.periods?.find((item: any) => item.groupIds?.includes(group.id))
        : undefined;
    const partialInstance = {
      assessmentRef: 'assessment-ref',
      typeId,
      maximumScore: 100,
      optional: true,
      ...(group ? { groupId: group.id } : {}),
      ...(period ? { periodId: period.id } : {}),
    };
    const output = { predictions: [] };

    expect(validateAiAssessmentScorePrediction(IT_GLOBAL_GRADING_SYSTEM, [partialInstance], output, 'partial').valid).toBe(true);
    expect(validateAiAssessmentScorePrediction(IT_GLOBAL_GRADING_SYSTEM, [partialInstance], output).valid).toBe(false);
    expect(validateAiAssessmentScorePrediction(IT_GLOBAL_GRADING_SYSTEM, [partialInstance], output, 'invalid' as any).valid).toBe(false);
  });

  it('requires valid references for count-scoped inventories so missing references cannot bypass maxima', () => {
    const perGroup = IT_GLOBAL_GRADING_SYSTEM.components.find((item: any) => item.assessmentDefinition?.count?.scope?.type === 'per_group');
    if (perGroup) {
      const definition = perGroup.assessmentDefinition!;
      const invalid = validateAiAssessmentScorePrediction(IT_GLOBAL_GRADING_SYSTEM, [{
        assessmentRef: 'missing-group', typeId: definition.typeId, maximumScore: 100, optional: true,
        ...(definition.aggregation?.mode === 'weighted' ? { weight: 1 } : {}),
      }], { predictions: [] }, 'partial');
      expect(invalid.valid).toBe(false);
      expect(invalid.errors.join(' ')).toContain('needs a grading group');
    }
    const perPeriod = IT_GLOBAL_GRADING_SYSTEM.components.find((item: any) => item.assessmentDefinition?.count?.scope?.type === 'per_period');
    if (perPeriod) {
      const definition = perPeriod.assessmentDefinition!;
      const invalid = validateAiAssessmentScorePrediction(IT_GLOBAL_GRADING_SYSTEM, [{
        assessmentRef: 'missing-period', typeId: definition.typeId, maximumScore: 100, optional: true,
        ...(definition.aggregation?.mode === 'weighted' ? { weight: 1 } : {}),
      }], { predictions: [] }, 'partial');
      expect(invalid.valid).toBe(false);
      expect(invalid.errors.join(' ')).toContain('needs a grading period');
    }
  });
});
