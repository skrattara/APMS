type GradeScope = { periodId?: string; groupId?: string; nonPeriodOnly?: boolean };
type FormulaAssessment = { id: string; typeId?: string | null; gradingTypeId?: string | null; component?: string | null; gradingPeriodId?: string | null; gradingGroupId?: string | null; moduleNumber?: number | null; maximumScore?: number; instanceWeight?: number | null };

const legacyTypeIds: Record<string, string> = {
  start_of_class: 'soc', lets_practice: 'lp', reflection: 'tb', wrap_up_quiz: 'wuq',
  project_checkin: 'cig', final_project: 'fo', soc: 'soc', lp: 'lp', tb: 'tb', wuq: 'wuq', cig: 'cig', fo: 'fo',
};

const quoteExcelText = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
const excelWeight = (weight: any) => {
  if (typeof weight === 'number') return String(weight);
  if (typeof weight?.value === 'number') return String(weight.value);
  if (weight?.numerator != null && weight?.denominator) return `(${Number(weight.numerator)}/${Number(weight.denominator)})`;
  return '0';
};

/** Builds Excel formulas from grading-system schema nodes; assessment score cells are supplied by the caller. */
export function createGradingExcelFormulaBuilder(
  system: any,
  assessments: FormulaAssessment[],
  scoreCell: (assessmentId: string, studentRow: number) => string,
  componentCell?: (componentId: string, scope: GradeScope, studentRow: number) => string | null,
) {
  const componentById = new Map<string, any>((system.components ?? []).map((component: any) => [component.id, component]));
  const periodById = new Map<string, any>((system.periods ?? []).map((period: any) => [period.id, period]));
  const groupById = new Map<string, any>((system.groups ?? []).map((group: any) => [group.id, group]));
  const componentCache = new Map<string, string>();

  const assessmentTypeMatches = (actual: string, expected: string) => actual === expected || (legacyTypeIds[actual] ?? actual) === (legacyTypeIds[expected] ?? expected);
  const groupForAssessment = (assessment: FormulaAssessment) => assessment.gradingGroupId ?? (assessment.moduleNumber == null ? undefined : `m${assessment.moduleNumber}`);
  const periodIdsFor = (periodId?: string) => {
    if (!periodId) return null;
    const target = periodById.get(periodId);
    return new Set((system.periods ?? []).filter((period: any) => system.periodCalculation?.mode === 'cumulative' && system.periodCalculation.scope === 'periods' ? period.sequence <= target?.sequence : period.id === periodId).map((period: any) => period.id));
  };
  const groupsForPeriod = (periodId?: string) => {
    if (!periodId) return null;
    const period = periodById.get(periodId);
    if (system.periodCalculation?.mode === 'cumulative' && system.periodCalculation.scope === 'groups') {
      const last = Math.max(0, ...(period?.groupIds ?? []).map((id: string) => groupById.get(id)?.sequence ?? 0));
      return new Set((system.groups ?? []).filter((group: any) => group.typeId === system.periodCalculation.groupTypeId && group.sequence <= last).map((group: any) => group.id));
    }
    const periods = (system.periods ?? []).filter((item: any) => system.periodCalculation?.mode === 'cumulative' && system.periodCalculation.scope === 'periods' ? item.sequence <= period?.sequence : item.id === periodId);
    return new Set(periods.flatMap((item: any) => item.groupIds ?? []));
  };
  const assessmentsFor = (definition: any, scope: GradeScope) => assessments.filter((assessment) => assessmentTypeMatches(assessment.gradingTypeId ?? assessment.typeId ?? assessment.component ?? '', definition?.typeId ?? ''))
    .filter((assessment) => !scope.nonPeriodOnly || (!assessment.gradingPeriodId && !groupForAssessment(assessment)))
    .filter((assessment) => !scope.periodId || (assessment.gradingPeriodId && periodIdsFor(scope.periodId)?.has(assessment.gradingPeriodId)) || (groupForAssessment(assessment) && groupsForPeriod(scope.periodId)?.has(groupForAssessment(assessment)!)) || (!assessment.gradingPeriodId && !groupForAssessment(assessment)))
    .filter((assessment) => !scope.groupId || groupForAssessment(assessment) === scope.groupId || (!groupForAssessment(assessment) && !assessment.gradingPeriodId));
  const scoreRef = (assessment: FormulaAssessment, row: number) => scoreCell(assessment.id, row);
  const blankGuard = (ref: string, expression: string) => `IF(${ref}="","",${expression})`;
  const chooseMapping = (ref: string, mapping: any[], key: 'value' | 'minimum', valueKey: 'percentage', fallback = '""') => {
    const ordered = [...mapping].sort((a, b) => Number(b[key]) - Number(a[key]));
    return ordered.reduceRight((current, item) => `IF(${ref}>=${Number(item[key])},${Number(item[valueKey])},${current})`, fallback);
  };
  const assessmentValue = (component: any, assessment: FormulaAssessment, row: number) => {
    const definition = component.assessmentDefinition;
    const ref = scoreRef(assessment, row);
    const maxScore = assessment.maximumScore ?? definition.maxScore ?? 100;
    const scoring = definition.scoring ?? { mode: 'linear' };
    if (scoring.mode === 'value_mapping') {
      const mapped = (scoring.mapping ?? []).reduceRight((fallback: string, item: any) => `IF(${ref}=${quoteExcelText(item.value)},${Number(item.percentage)},${fallback})`, '""');
      return blankGuard(ref, mapped);
    }
    const linear = maxScore ? `${ref}/${Number(maxScore)}*100` : ref;
    const expression = scoring.mode === 'numeric_mapping' ? chooseMapping(ref, scoring.mapping ?? [], 'value', 'percentage', linear) : linear;
    return blankGuard(ref, expression);
  };
  const countIsValid = (definition: any, rows: FormulaAssessment[], scope: GradeScope) => {
    const count = (items: FormulaAssessment[]) => items.length;
    const valid = (n: number) => (definition.count?.min == null || n >= definition.count.min) && (definition.count?.max == null || n <= definition.count.max);
    const countScope = definition.count?.scope?.type;
    if (countScope === 'per_group' && !scope.groupId) {
      const targetGroups = (system.groups ?? []).filter((group: any) => group.typeId === definition.count.scope.groupTypeId && (!scope.periodId || groupsForPeriod(scope.periodId)?.has(group.id)));
      return targetGroups.every((group: any) => valid(count(rows.filter((assessment) => groupForAssessment(assessment) === group.id))));
    }
    if (countScope === 'per_period' && !scope.periodId) return (system.periods ?? []).every((period: any) => valid(count(rows.filter((assessment) => assessment.gradingPeriodId === period.id))));
    return valid(count(rows));
  };
  const sumWeighted = (entries: { formula: string; weight: number | string }[], mode: 'relative' | 'absolute' = 'relative') => {
    if (!entries.length) return '""';
    const numerator = entries.map(({ formula, weight }) => `IF(${formula}="",0,(${formula})*(${weight}))`);
    if (mode === 'absolute') return `IFERROR(SUM(${numerator.join(',')}),"")`;
    const denominator = entries.map(({ formula, weight }) => `IF(${formula}="",0,${weight})`);
    return `IFERROR(SUM(${numerator.join(',')})/SUM(${denominator.join(',')}),"")`;
  };
  const comparisonMatches = (count: number, condition: any) => condition.operator === 'eq' ? count === condition.value : condition.operator === 'ne' ? count !== condition.value : condition.operator === 'lt' ? count < condition.value : condition.operator === 'lte' ? count <= condition.value : condition.operator === 'gt' ? count > condition.value : count >= condition.value;
  const component = (componentId: string, scope: GradeScope, row: number, stack = new Set<string>(), useCellReference = false): string => {
    if (useCellReference) {
      const reference = componentCell?.(componentId, scope, row);
      if (reference) return reference;
    }
    const key = `${componentId}|${scope.periodId ?? ''}|${scope.groupId ?? ''}|${scope.nonPeriodOnly ? 'np' : ''}|${row}`;
    if (componentCache.has(key)) return componentCache.get(key)!;
    if (stack.has(componentId)) return '""';
    const node = componentById.get(componentId);
    if (!node) return '""';
    const nextStack = new Set(stack).add(componentId);
    let formula = '""';
    if (node.assessmentDefinition) {
      const definition = node.assessmentDefinition;
      const matching = assessmentsFor(definition, scope);
      if (!countIsValid(definition, matching, scope)) return formula;
      const entries = matching.map((assessment) => ({ assessment, formula: assessmentValue(node, assessment, row), scoreRef: scoreRef(assessment, row), maximum: assessment.maximumScore ?? definition.maxScore ?? 100, weight: assessment.instanceWeight }));
      const mode = definition.aggregation?.mode ?? 'equal';
      if (mode === 'points') formula = sumWeighted(entries.map((entry) => ({ formula: entry.formula, weight: entry.maximum })));
      else if (mode === 'weighted') {
        const missingWeight = entries.filter((entry) => entry.weight == null).map((entry) => `${entry.scoreRef}<>""`);
        if (missingWeight.length) {
          const value = sumWeighted(entries.map((entry) => ({ formula: entry.formula, weight: Number(entry.weight ?? 0) })));
          formula = `IF(OR(${missingWeight.join(',')}),"",${value})`;
        } else formula = sumWeighted(entries.map((entry) => ({ formula: entry.formula, weight: Number(entry.weight) })));
      } else formula = sumWeighted(entries.map((entry) => ({ formula: entry.formula, weight: 1 })));
    } else if (node.calculation?.mode === 'weighted') {
      let refs = node.calculation.components ?? [];
      let weightMode = node.calculation.weightMode ?? 'relative';
      for (const rule of node.calculation.rules ?? []) {
        const condition = rule.when;
        if (condition?.type !== 'assessment_count') continue;
        const target = componentById.get(condition.componentId);
        const count = target?.assessmentDefinition ? assessmentsFor(target.assessmentDefinition, scope).length : 0;
        if (comparisonMatches(count, condition)) { refs = rule.override?.components ?? refs; weightMode = rule.override?.weightMode ?? weightMode; break; }
      }
      const entries = refs.map((ref: any) => ({ formula: component(ref.componentId, { ...scope, periodId: ref.periodId ?? scope.periodId }, row, nextStack, true), weight: excelWeight(ref.weight) }));
      formula = sumWeighted(entries, weightMode);
    }
    componentCache.set(key, formula);
    return formula;
  };
  const period = (periodId: string, row: number, prior: Map<string, string>, stack = new Set<string>()): string => {
    const definition = periodById.get(periodId);
    if (!definition || stack.has(periodId)) return '""';
    let formula: string;
    if (system.periodCalculation?.mode === 'independent') {
      const root = componentById.get(system.calculationRootComponentId);
      const ref = root?.calculation?.components?.find((item: any) => item.source === 'period_component' && item.periodId === periodId);
      const targetId = ref?.componentId ?? system.calculationRootComponentId;
      const scope = { periodId: ref?.periodId ?? periodId };
      formula = componentCell?.(targetId, scope, row) ?? component(targetId, scope, row);
    } else if (system.periodCalculation?.mode === 'cumulative') {
      const assigned = definition.groupIds ?? [];
      let allowed = assigned;
      if (system.periodCalculation.scope === 'groups') {
        const last = Math.max(0, ...assigned.map((id: string) => groupById.get(id)?.sequence ?? 0));
        allowed = (system.groups ?? []).filter((group: any) => group.typeId === system.periodCalculation.groupTypeId && group.sequence <= last).map((group: any) => group.id);
      }
      const entries = allowed.map((id: string) => {
        const scope = { groupId: id };
        return {
          formula: componentCell?.(system.calculationRootComponentId, scope, row) ?? component(system.calculationRootComponentId, scope, row),
          weight: groupById.get(id)?.weight == null ? 1 : excelWeight(groupById.get(id)?.weight),
        };
      });
      const groupFormula = sumWeighted(entries);
      const periodScope = { periodId };
      const periodFallback = componentCell?.(system.calculationRootComponentId, periodScope, row) ?? component(system.calculationRootComponentId, periodScope, row);
      formula = entries.length ? `IF(${groupFormula}="",${periodFallback},${groupFormula})` : periodFallback;
    } else {
      const scope = { periodId };
      formula = componentCell?.(system.calculationRootComponentId, scope, row) ?? component(system.calculationRootComponentId, scope, row);
    }
    if (system.periodCalculation?.mode === 'period_formula') {
      const periodFormula = system.periodCalculation.periods?.find((item: any) => item.periodId === periodId);
      if (periodFormula) {
        const currentScope = { periodId };
        const entries = periodFormula.components.map((item: any) => ({ formula: item.source === 'current_period' ? componentCell?.(system.calculationRootComponentId, currentScope, row) ?? component(system.calculationRootComponentId, currentScope, row) : prior.get(item.periodId) ?? '""', weight: excelWeight(item.weight) }));
        formula = sumWeighted(entries);
      }
    }
    return formula;
  };
  const periods = (row: number) => {
    const prior = new Map<string, string>();
    for (const item of [...(system.periods ?? [])].sort((a: any, b: any) => a.sequence - b.sequence)) prior.set(item.id, period(item.id, row, prior));
    return prior;
  };
  const rawFinal = (row: number) => {
    const periodGrades = periods(row);
    if (system.finalResult?.source === 'period_grade') return periodGrades.get(system.finalResult.periodId) ?? '""';
    const componentId = system.finalResult?.componentId ?? system.calculationRootComponentId;
    return componentCell?.(componentId, {}, row) ?? component(componentId, {}, row);
  };
  const pointAndLetter = (raw: string) => {
    const conversion = system.finalGradeConversion;
    const scaleFormula = (scale: any, passing: boolean, output: 'point' | 'letter'): string => {
      if (!scale) return '""';
      if (scale.mode === 'mapping') {
        return (scale.mapping ?? []).slice().sort((a: any, b: any) => b.minimumPercentage - a.minimumPercentage).reduceRight((fallback: string, item: any) => {
          const mapped = output === 'point' ? Number(item.point) : quoteExcelText(item.letter ?? '');
          return `IF(${raw}>=${Number(item.minimumPercentage)},${mapped},${fallback})`;
        }, '""');
      }
      if (output === 'letter') return '""';
      const interval = Math.max(Number(scale.pointInterval) || 1, Number.EPSILON);
      const low = passing ? Number(scale.bestPoint) : Number(scale.firstFailingPoint);
      const high = passing ? Number(scale.passingPoint) : Number(scale.worstPoint);
      const steps = Math.max(1, Math.ceil(Math.abs(high - low) / interval));
      const count = steps + 1;
      const boundary = passing ? Number(conversion.passingPercentage) : Number(conversion.passingPercentage);
      const maximum = passing ? Number(scale.maximumPercentage ?? 100) : Number(scale.minimumPercentage);
      const progress = passing
        ? (maximum === boundary ? '1' : `MAX(0,MIN(1,(${maximum}-${raw})/(${maximum}-${boundary})))`)
        : (boundary === maximum ? '1' : `MAX(0,MIN(1,(${boundary}-${raw})/(${boundary}-${maximum})))`);
      const index = `MIN(${count - 1},INT((${progress})*${count}))`;
      const point = `${low}+(${high}-${low})*(${index})/${steps}`;
      const rounding = conversion.rounding;
      if (!rounding) return point;
      const digits = Number(rounding.precision ?? 0);
      const factor = 10 ** digits;
      if (rounding.mode === 'floor') return `INT((${point})*${factor})/${factor}`;
      if (rounding.mode === 'ceiling') return `-INT(-(${point})*${factor})/${factor}`;
      return `INT((${point})*${factor}+0.5)/${factor}`;
    };
    const passing = Number(conversion.passingPercentage);
    const point = `IF(${raw}="","",IF(${raw}>=${passing},${scaleFormula(conversion.passingScale, true, 'point')},${scaleFormula(conversion.failingScale, false, 'point')}))`;
    const letter = `IF(${raw}="","",IF(${raw}>=${passing},${scaleFormula(conversion.passingScale, true, 'letter')},${scaleFormula(conversion.failingScale, false, 'letter')}))`;
    return { point, letter };
  };
  const equivalent = (row: number) => {
    const raw = rawFinal(row);
    const { point, letter } = pointAndLetter(raw);
    return `IF(OR(${raw}="",${point}=""),"—",TEXT(${point},"0.00")&IF(${letter}="",""," / "&${letter}))`;
  };
  return { component, period, periods, rawFinal, pointAndLetter, equivalent };
}
