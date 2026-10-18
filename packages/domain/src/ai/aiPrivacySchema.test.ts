import { describe, expect, it } from 'vitest';
import { validateEvaluationSystem } from '../evaluation/engine';
import { validateGradingSystem, IT_GLOBAL_GRADING_SYSTEM } from '../grading/engine';
import { anonymizeSchemaRepresentation, type SchemaPrivacyMap } from '../../../../supabase/functions/_shared/aiPrivacy';
import defaultEvaluation from '../../../../supabase/functions/_shared/defaultEvaluationSystem.json';
import gradingSchema from '../grading/grading_system_schema.json';
import evaluationSchema from '../evaluation/evaluation_system_schema.json';
import itComponentGrading from '../grading/systems/it_component_grading_system.json';

function map() : SchemaPrivacyMap {
  return { ids: new Map(), categories: new Map() };
}

function schemaEnums(schema: unknown): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  const visit = (value: unknown, key = '') => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach((child) => visit(child, key)); return; }
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.enum)) for (const item of record.enum) if (typeof item === 'string') found.push([key, item]);
    if (typeof record.const === 'string') found.push([key, record.const]);
    for (const [childKey, child] of Object.entries(record)) visit(child, childKey === 'items' ? key : childKey);
  };
  visit(schema);
  return found;
}

describe('anonymized schema conformance', () => {
  it('keeps the real grading and evaluation definitions valid while replacing names and structural references', () => {
    const privacyMap = map();
    const cleanGrading = anonymizeSchemaRepresentation(IT_GLOBAL_GRADING_SYSTEM, privacyMap) as any;
    const cleanEvaluation = anonymizeSchemaRepresentation(defaultEvaluation, privacyMap) as any;

    expect(validateGradingSystem(cleanGrading).valid).toBe(true);
    expect(validateEvaluationSystem(cleanEvaluation).valid).toBe(true);
    expect(JSON.stringify(cleanGrading)).not.toContain('IT Global');
    expect(JSON.stringify(cleanEvaluation)).not.toContain('APMS Student Performance Evaluation');
    const originalPeriod = IT_GLOBAL_GRADING_SYSTEM.periods?.find((period: any) => period.groupIds?.length);
    if (originalPeriod) {
      const safePeriod = cleanGrading.periods.find((period: any) => period.id === privacyMap.ids.get(originalPeriod.id));
      expect(safePeriod.groupIds).toEqual(originalPeriod.groupIds.map((id: string) => privacyMap.ids.get(id)));
      expect(safePeriod.groupIds.every((id: string) => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id))).toBe(true);
    }

    const components = cleanGrading.components as any[];
    expect(JSON.stringify(cleanGrading)).toContain('"source":"component"');
    expect(components.some((component) => component.assessmentDefinition?.count?.scope)).toBe(true);
    expect(JSON.stringify(cleanGrading)).not.toContain('Start of Class');
    expect(JSON.stringify(cleanEvaluation)).not.toContain('Current standing');
  });

  it('preserves exact constrained enum spellings while mapping category labels consistently', () => {
    const privacyMap = map();
    const source = {
      calculation: { source: 'component', componentId: 'component-secret' },
      when: { type: 'assessment_count', operator: 'eq' },
      rounding: { mode: 'nearest' },
      weightMode: 'relative',
      scale: { mode: 'equal_interval' },
      finalResult: { source: 'period_grade', periodId: 'period-secret' },
      groups: [{ id: 'group-secret' }],
      periods: [{ id: 'period-secret', groupIds: ['group-secret'] }],
      categories: ['A', 'B'],
      decisionPolicy: { officialRecordSystem: 'Private institution name' },
      name: 'Private class title',
    };
    const clean = anonymizeSchemaRepresentation(source, privacyMap) as any;
    expect(clean.calculation.source).toBe('component');
    expect(clean.when).toEqual({ type: 'assessment_count', operator: 'eq' });
    expect(clean.rounding.mode).toBe('nearest');
    expect(clean.weightMode).toBe('relative');
    expect(clean.scale.mode).toBe('equal_interval');
    expect(clean.finalResult.source).toBe('period_grade');
    expect(clean.periods[0].groupIds).toEqual([clean.groups[0].id]);
    expect(clean.categories[0]).toBe(privacyMap.categories.get('A'));
    expect(clean.decisionPolicy.officialRecordSystem).toBe('Institutional record system');
    const hostile = anonymizeSchemaRepresentation({ source: 'bearer token text', mode: 'private class name', formula: 'student@example.edu' }, map()) as any;
    expect(hostile).toEqual({});
    const serialized = JSON.stringify(clean);
    for (const privateText of ['component-secret', 'period-secret', 'group-secret', 'Private class title']) {
      expect(serialized).not.toContain(privateText);
    }
  });

  it('preserves every string enum and const from the canonical schemas, and anonymizes both supported grading examples', () => {
    const enums = [...schemaEnums(gradingSchema), ...schemaEnums(evaluationSchema)];
    for (const [key, value] of enums) {
      const input = ['inputFeatures', 'outputFields', 'supportedScenarios'].includes(key)
        ? { [key]: [value] }
        : { [key]: value };
      const clean = anonymizeSchemaRepresentation(input, map()) as any;
      expect(clean[key], `${key}=${value}`).toEqual(input[key]);
    }

    const cleanGlobal = anonymizeSchemaRepresentation(IT_GLOBAL_GRADING_SYSTEM, map());
    expect(validateGradingSystem(cleanGlobal).valid).toBe(true);
    const cleanComponent = anonymizeSchemaRepresentation(itComponentGrading, map());
    // This checked-in component example is intentionally invalid: its declared
    // group aliases do not match the aliases referenced by assignments.
    expect(validateGradingSystem(cleanComponent).valid).toBe(false);
    for (const [definition, clean] of [[IT_GLOBAL_GRADING_SYSTEM, cleanGlobal], [itComponentGrading, cleanComponent]] as const) {
      const serialized = JSON.stringify(clean);
      expect(serialized).not.toContain((definition as any).name);
      for (const component of (definition as any).components) {
        if (typeof component.id === 'string') expect(serialized).not.toContain(JSON.stringify(component.id));
      }
    }
  });
});
