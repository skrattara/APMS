import Ajv2020 from 'ajv/dist/2020';
import schema from './grading_system_schema.json';
import itGlobalDefinition from './systems/it_global_grading_system.json';

export type GradingDefinition = Record<string, any> & { id: string; name: string; components: any[]; calculationRootComponentId: string; finalResult: any; finalGradeConversion: any };
export const IT_GLOBAL_GRADING_SYSTEM = itGlobalDefinition as GradingDefinition;
export type GradingAssessment = { id: string; typeId: string; score: number | string | null; missingScorePercentage?: number; maximumScore?: number; weight?: number; periodId?: string | null; groupId?: string | null };
export type GradingResult = { components: Record<string, number | null>; groups: Record<string, number | null>; groupComponents: Record<string, Record<string, number | null>>; periods: Record<string, number | null>; periodComponents: Record<string, Record<string, number | null>>; nonPeriodComponents: Record<string, number | null>; nonPeriod: number | null; rawFinal: number | null; finalGrade: number | null; pointGrade: number | null; letterGrade: string | null; remarks: 'passing' | 'failing' | 'incomplete' };

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateSchema = ajv.compile(schema as object);
const builtinMappings: Record<string, string> = {
  start_of_class: 'soc', lets_practice: 'lp', reflection: 'tb', wrap_up_quiz: 'wuq',
  project_checkin: 'cig', final_project: 'fo', soc: 'soc', lp: 'lp', tb: 'tb', wuq: 'wuq', cig: 'cig', fo: 'fo',
};
const assessmentTypeMatches = (rowTypeId: string, definitionTypeId: string) =>
  rowTypeId === definitionTypeId || (builtinMappings[rowTypeId] ?? rowTypeId) === (builtinMappings[definitionTypeId] ?? definitionTypeId);

export function validateGradingSystem(value: unknown): { valid: boolean; errors: string[] } {
  if (!validateSchema(value)) return { valid: false, errors: (validateSchema.errors ?? []).map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`) };
  const system = value as GradingDefinition;
  const errors: string[] = [];
  const unique = (items: any[], label: string) => {
    const ids = items.map((item) => item.id);
    if (new Set(ids).size !== ids.length) errors.push(`${label} IDs must be unique.`);
  };
  unique(system.components, 'Component'); unique(system.periods ?? [], 'Period'); unique(system.groups ?? [], 'Group');
  const components = new Set(system.components.map((item) => item.id));
  const periods = new Set((system.periods ?? []).map((item: any) => item.id));
  const groups = new Set((system.groups ?? []).map((item: any) => item.id));
  const groupTypes = new Set((system.groupTypes ?? []).map((item: any) => item.id));
  const assessmentTypes = new Set((system.assessmentTypes ?? []).map((item: any) => item.id));
  if (!components.has(system.calculationRootComponentId)) errors.push('Calculation root must reference a component.');
  for (const period of system.periods ?? []) for (const groupId of (period as any).groupIds ?? []) if (!groups.has(groupId)) errors.push(`Period ${(period as any).id} references unknown group ${groupId}.`);
  for (const group of system.groups ?? []) {
    if (!groupTypes.has((group as any).typeId)) errors.push(`Group ${(group as any).id} references unknown group type ${(group as any).typeId}.`);
    if ((group as any).parentGroupId && !groups.has((group as any).parentGroupId)) errors.push(`Group ${(group as any).id} references an unknown parent group.`);
  }
  for (const component of system.components) if (component.assessmentDefinition && !assessmentTypes.has(component.assessmentDefinition.typeId)) errors.push(`Component ${component.id} references unknown assessment type ${component.assessmentDefinition.typeId}.`);
  const visitWeights = (component: any) => {
    const calc = component.calculation;
    if (calc?.components) for (const ref of calc.components) {
      if (!components.has(ref.componentId)) errors.push(`${component.id} references unknown component ${ref.componentId}.`);
      if (ref.periodId && !periods.has(ref.periodId)) errors.push(`${component.id} references unknown period ${ref.periodId}.`);
    }
    for (const rule of calc?.rules ?? []) for (const ref of rule.override?.components ?? []) {
      if (!components.has(ref.componentId)) errors.push(`${component.id} rule references unknown component ${ref.componentId}.`);
    }
  };
  system.components.forEach(visitWeights);
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) { errors.push(`Component dependency cycle includes ${id}.`); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    const component: any = system.components.find((item) => item.id === id);
    for (const ref of component?.calculation?.components ?? []) if (components.has(ref.componentId)) visit(ref.componentId);
    visiting.delete(id); visited.add(id);
  };
  system.components.forEach((component) => visit(component.id));
  if (system.finalResult?.componentId && !components.has(system.finalResult.componentId)) errors.push('Final result references an unknown component.');
  if (system.finalResult?.periodId && !periods.has(system.finalResult.periodId)) errors.push('Final result references an unknown period.');
  for (const formula of system.periodCalculation?.periods ?? []) {
    if (!periods.has(formula.periodId)) errors.push(`Period formula references unknown period ${formula.periodId}.`);
    for (const item of formula.components ?? []) if (item.source === 'period_grade' && !periods.has(item.periodId)) errors.push(`Period formula references unknown prior period ${item.periodId}.`);
  }
  return { valid: errors.length === 0, errors };
}

export function calculateGradingSystem(definition: GradingDefinition, assessments: GradingAssessment[]): GradingResult {
  const validation = validateGradingSystem(definition);
  if (!validation.valid) throw new Error(`Invalid grading system: ${validation.errors.join(' ')}`);
  const byId = new Map(definition.components.map((component) => [component.id, component]));
  const periodById = new Map((definition.periods ?? []).map((period: any) => [period.id, period]));
  const groupById = new Map((definition.groups ?? []).map((group: any) => [group.id, group]));
  const groupsForPeriod = (periodId?: string, groupId?: string) => {
    if (!periodId) return null;
    const period: any = periodById.get(periodId);
    const cumulativeGroups = definition.periodCalculation?.mode === 'cumulative' && definition.periodCalculation.scope === 'groups';
    if (cumulativeGroups) {
      const lastSequence = Math.max(0, ...(period?.groupIds ?? []).map((id: string) => (groupById.get(id) as any)?.sequence ?? 0));
      return new Set<string>((definition.groups ?? []).filter((group: any) => group.typeId === definition.periodCalculation.groupTypeId && group.sequence <= lastSequence).map((group: any) => group.id));
    }
    const cumulativePeriods = definition.periodCalculation?.mode === 'cumulative' && definition.periodCalculation.scope === 'periods';
    const includedPeriods = (definition.periods ?? []).filter((item: any) => cumulativePeriods ? item.sequence <= period?.sequence : item.id === periodId);
    return new Set<string>(includedPeriods.flatMap((item: any) => item.groupIds ?? []));
  };
  const periodIdsFor = (periodId?: string) => {
    if (!periodId) return null;
    const target: any = periodById.get(periodId);
    return new Set<string>((definition.periods ?? []).filter((period: any) => definition.periodCalculation?.mode === 'cumulative' && definition.periodCalculation.scope === 'periods'
      ? period.sequence <= target?.sequence : period.id === periodId).map((period: any) => period.id));
  };
  const scoreCache = new Map<string, number | null>();
  const countCache = new Map<string, number>();
  const calcComponent = (componentId: string, periodId?: string, groupId?: string, stack = new Set<string>(), nonPeriodOnly = false): number | null => {
    const key = `${componentId}|${periodId ?? ''}|${groupId ?? ''}|${nonPeriodOnly ? 'non-period' : 'all'}`;
    if (scoreCache.has(key)) return scoreCache.get(key)!;
    if (stack.has(componentId)) return null;
    const component: any = byId.get(componentId); if (!component) return null;
    const nextStack = new Set(stack).add(componentId);
    let result: number | null = null;
    if (component.assessmentDefinition) {
      const d = component.assessmentDefinition;
      const rows = assessments.filter((row) => assessmentTypeMatches(row.typeId, d.typeId))
        .filter((row) => !nonPeriodOnly || (!row.periodId && !row.groupId))
        .filter((row) => !periodId || (row.periodId && periodIdsFor(periodId)?.has(row.periodId)) || (row.groupId && groupsForPeriod(periodId)?.has(row.groupId)) || (!row.periodId && !row.groupId))
        .filter((row) => !groupId || row.groupId === groupId || (!row.groupId && !row.periodId));
      countCache.set(key, rows.length);
      let values = rows.flatMap((row) => {
        const max = row.maximumScore ?? d.maxScore ?? 100;
        const scoring = d.scoring;
        if (row.score == null) {
          return row.missingScorePercentage == null ? [] : [{ value: row.missingScorePercentage, weight: row.weight ?? 1, maxScore: max }];
        }
        let numeric: number | null = null;
        let percentage: number;
        if (scoring?.mode === 'value_mapping') {
          const mapped = scoring.mapping.find((m: any) => String(m.value) === String(row.score));
          if (!mapped) return [];
          percentage = mapped.percentage;
        } else {
          numeric = typeof row.score === 'number' ? row.score : Number(row.score);
          if (!Number.isFinite(numeric)) return [];
          percentage = max ? numeric / max * 100 : numeric;
        }
        if (scoring?.mode === 'numeric_mapping' && numeric != null) {
          const mapped = [...scoring.mapping].sort((a: any, b: any) => a.value - b.value).filter((m: any) => numeric >= m.value).at(-1);
          if (mapped) percentage = mapped.percentage;
        }
        return [{ value: percentage, weight: row.weight ?? 1, maxScore: row.maximumScore ?? d.maxScore ?? 100 }];
      });
      const weightsPresent = d.aggregation?.mode !== 'weighted' || rows.filter((row) => row.score != null || row.missingScorePercentage != null).every((row) => row.weight != null);
      let countValid = true;
      const countScope = d.count?.scope?.type;
      if (countScope === 'per_group' && !groupId) {
        const requiredGroups = (definition.groups ?? []).filter((group: any) => group.typeId === d.count.scope.groupTypeId && (!periodId || groupsForPeriod(periodId)?.has(group.id)));
        countValid = requiredGroups.every((group: any) => {
          const count = rows.filter((row) => row.groupId === group.id).length;
          return (d.count.min == null || count >= d.count.min) && (d.count.max == null || count <= d.count.max);
        });
      } else if (countScope === 'per_period' && !periodId) {
        countValid = (definition.periods ?? []).every((period: any) => {
          const count = rows.filter((row) => row.periodId === period.id).length;
          return (d.count.min == null || count >= d.count.min) && (d.count.max == null || count <= d.count.max);
        });
      } else countValid = (d.count?.min == null || rows.length >= d.count.min) && (d.count?.max == null || rows.length <= d.count.max);
      if (!countValid || !weightsPresent) result = null;
      else if (values.length) {
        if (d.aggregation?.mode === 'points') result = values.reduce((sum, item) => sum + item.value * item.maxScore, 0) / values.reduce((sum, item) => sum + item.maxScore, 0);
        else if (d.aggregation?.mode === 'weighted') result = values.reduce((sum, item) => sum + item.value * item.weight, 0) / values.reduce((sum, item) => sum + item.weight, 0);
        else result = values.reduce((sum, item) => sum + item.value, 0) / values.length;
      }
    } else if (component.calculation?.mode === 'assessments') {
      // The component's assessmentDefinition above performs the aggregation.
      result = null;
    } else if (component.calculation?.mode === 'weighted') {
      let refs = component.calculation.components ?? [];
      let weightMode = component.calculation.weightMode ?? 'relative';
      for (const rule of component.calculation.rules ?? []) {
        const condition = rule.when;
        if (condition?.type !== 'assessment_count') continue;
        const targetType = byId.get(condition.componentId)?.assessmentDefinition?.typeId;
        const count = countCache.get(`${condition.componentId}|${periodId ?? ''}|${groupId ?? ''}|${nonPeriodOnly ? 'non-period' : 'all'}`) ?? assessments.filter((item) => targetType && assessmentTypeMatches(item.typeId, targetType)).filter((item) => !nonPeriodOnly || (!item.periodId && !item.groupId)).filter((item) => !periodId || (item.periodId && periodIdsFor(periodId)?.has(item.periodId)) || (item.groupId && groupsForPeriod(periodId)?.has(item.groupId)) || (!item.periodId && !item.groupId)).filter((item) => !groupId || item.groupId === groupId || (!item.groupId && !item.periodId)).length;
        const expected = condition.value;
        const matches = condition.operator === 'eq' ? count === expected : condition.operator === 'ne' ? count !== expected : condition.operator === 'lt' ? count < expected : condition.operator === 'lte' ? count <= expected : condition.operator === 'gt' ? count > expected : count >= expected;
        if (matches) { refs = rule.override?.components ?? refs; weightMode = rule.override?.weightMode ?? weightMode; break; }
      }
      const weighted = refs.map((ref: any) => {
        const rawWeight = ref.weight;
        const weight = typeof rawWeight === 'number' ? rawWeight : rawWeight?.value ?? (rawWeight?.numerator != null ? rawWeight.numerator / rawWeight.denominator : 0);
        return { value: calcComponent(ref.componentId, ref.periodId ?? periodId, groupId, nextStack, nonPeriodOnly), weight };
      }).filter((item: any) => item.value != null);
      const denominator = weightMode === 'absolute' ? 1 : weighted.reduce((sum: number, item: any) => sum + item.weight, 0);
      if (weighted.length && denominator) result = weighted.reduce((sum: number, item: any) => sum + item.value * item.weight, 0) / denominator;
    }
    scoreCache.set(key, result); return result;
  };
  const components: Record<string, number | null> = {};
  for (const component of definition.components) components[component.id] = calcComponent(component.id);
  const groupGrades: Record<string, number | null> = {};
  const groupComponents: Record<string, Record<string, number | null>> = {};
  for (const group of definition.groups ?? []) {
    groupGrades[group.id] = calcComponent(definition.calculationRootComponentId, undefined, group.id);
    groupComponents[group.id] = Object.fromEntries(definition.components.map((component) => [component.id, calcComponent(component.id, undefined, group.id)]));
  }
  const periodComponents: Record<string, Record<string, number | null>> = {};
  for (const period of definition.periods ?? []) periodComponents[period.id] = Object.fromEntries(definition.components.map((component) => [component.id, calcComponent(component.id, period.id)]));
  const nonPeriodComponents = Object.fromEntries(definition.components.map((component) => [component.id, calcComponent(component.id, undefined, undefined, new Set(), true)]));
  const nonPeriod = calcComponent(definition.finalResult.componentId ?? definition.calculationRootComponentId, undefined, undefined, new Set(), true);
  const periodGrades: Record<string, number | null> = {};
  for (const period of [...(definition.periods ?? [])].sort((a: any, b: any) => a.sequence - b.sequence)) {
    if (definition.periodCalculation?.mode === 'cumulative') {
      const scope = definition.periodCalculation.scope;
      const groupIds: string[] = scope === 'groups' ? Array.from(groupById.keys()).map(String).filter((id) => (groupById.get(id) as any)?.typeId === definition.periodCalculation.groupTypeId) : [];
      const assignedGroupIds: string[] = ((period as any).groupIds ?? []).map(String);
      const lastSequence = Math.max(0, ...assignedGroupIds.map((id) => (groupById.get(id) as any)?.sequence ?? 0));
      const allowed: string[] = scope === 'groups' ? groupIds.filter((id) => (groupById.get(id) as any)?.sequence <= lastSequence) : assignedGroupIds;
      const vals = allowed.flatMap((id: string) => { const group: any = groupById.get(id); const v = calcComponent(definition.calculationRootComponentId, undefined, id); return v == null ? [] : [{ v, w: typeof group?.weight === 'number' ? group.weight : group?.weight?.numerator != null ? group.weight.numerator / group.weight.denominator : 1 }]; });
      periodGrades[period.id] = vals.length ? vals.reduce((a: number, x: {v:number,w:number}) => a + x.v * x.w, 0) / vals.reduce((a: number, x: {v:number,w:number}) => a + x.w, 0) : calcComponent(definition.calculationRootComponentId, period.id);
    } else if (definition.periodCalculation?.mode === 'independent') {
      // Independent period grades are the period-specific component inputs to the final grade,
      // not the final-grade component recalculated with a period filter. The latter still
      // combines all period references and makes each period appear to carry the same result.
      const root: any = byId.get(definition.calculationRootComponentId);
      const periodRef = root?.calculation?.components?.find((item: any) => item.source === 'period_component' && item.periodId === period.id);
      periodGrades[period.id] = periodRef
        ? calcComponent(periodRef.componentId, periodRef.periodId)
        : calcComponent(definition.calculationRootComponentId, period.id);
    } else periodGrades[period.id] = calcComponent(definition.calculationRootComponentId, period.id);
    if (definition.periodCalculation?.mode === 'period_formula') {
      const formula = definition.periodCalculation.periods.find((entry: any) => entry.periodId === period.id);
      if (formula) {
        const entries = formula.components.map((item: any) => ({ value: item.source === 'current_period' ? calcComponent(definition.calculationRootComponentId, period.id) : periodGrades[item.periodId], weight: typeof item.weight === 'number' ? item.weight : item.weight.numerator / item.weight.denominator })).filter((item: any) => item.value != null);
        const totalWeight = entries.reduce((sum: number, item: any) => sum + item.weight, 0);
        periodGrades[period.id] = entries.length && totalWeight ? entries.reduce((sum: number, item: any) => sum + item.value * item.weight, 0) / totalWeight : null;
      }
    }
  }
  const rawFinal = definition.finalResult.source === 'period_grade' ? periodGrades[definition.finalResult.periodId] ?? null : components[definition.finalResult.componentId] ?? null;
  const conversion: any = definition.finalGradeConversion;
  let pointGrade: number | null = null; let letterGrade: string | null = null;
  if (rawFinal != null) {
    if (rawFinal >= conversion.passingPercentage) {
      const scale: any = conversion.passingScale;
      if (scale.mode === 'equal_interval') {
        const pointSteps = Math.max(1, Math.ceil(Math.abs(scale.passingPoint - scale.bestPoint) / scale.pointInterval));
        const gradeCount = pointSteps + 1;
        const progress = scale.maximumPercentage === conversion.passingPercentage ? 1 : Math.max(0, Math.min(1, (scale.maximumPercentage - rawFinal) / (scale.maximumPercentage - conversion.passingPercentage)));
        const gradeIndex = Math.min(gradeCount - 1, Math.floor(progress * gradeCount));
        pointGrade = scale.bestPoint + (scale.passingPoint - scale.bestPoint) * gradeIndex / pointSteps;
      }
      else { const item = [...scale.mapping].sort((a: any,b: any)=>b.minimumPercentage-a.minimumPercentage).find((x: any)=>rawFinal>=x.minimumPercentage); pointGrade = item?.point ?? null; letterGrade = item?.letter ?? null; }
    } else {
      const scale: any = conversion.failingScale;
      if (scale.mode === 'equal_interval') {
        const pointSteps = Math.max(1, Math.ceil(Math.abs(scale.worstPoint - scale.firstFailingPoint) / scale.pointInterval));
        const gradeCount = pointSteps + 1;
        const progress = conversion.passingPercentage === scale.minimumPercentage ? 1 : Math.max(0, Math.min(1, (conversion.passingPercentage - rawFinal) / (conversion.passingPercentage - scale.minimumPercentage)));
        const gradeIndex = Math.min(gradeCount - 1, Math.floor(progress * gradeCount));
        pointGrade = scale.firstFailingPoint + (scale.worstPoint - scale.firstFailingPoint) * gradeIndex / pointSteps;
      }
      else { const item = [...scale.mapping].sort((a: any,b: any)=>b.minimumPercentage-a.minimumPercentage).find((x: any)=>rawFinal>=x.minimumPercentage); pointGrade = item?.point ?? null; letterGrade = item?.letter ?? null; }
    }
    const rounding = conversion.rounding;
    if (pointGrade != null && rounding) { const factor = 10 ** rounding.precision; pointGrade = rounding.mode === 'floor' ? Math.floor(pointGrade * factor) / factor : rounding.mode === 'ceiling' ? Math.ceil(pointGrade * factor) / factor : Math.round(pointGrade * factor) / factor; }
  }
  return { components, groups: groupGrades, groupComponents, periods: periodGrades, periodComponents, nonPeriodComponents, nonPeriod, rawFinal, finalGrade: rawFinal, pointGrade, letterGrade, remarks: rawFinal == null ? 'incomplete' : rawFinal >= conversion.passingPercentage ? 'passing' : 'failing' };
}
