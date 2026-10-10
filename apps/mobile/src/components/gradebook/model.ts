import { calculateGradingSystem, IT_GLOBAL_GRADING_SYSTEM, swunextAssessmentComponents, type SwunextAssessmentComponent } from '@apms/domain';
import type { ClassWorkspace, FacultyAssessment } from '@/services/faculty';
import { storedAssessmentValue, valueMappingForType } from './shared';
export type FullViewColumn = {
  id: string;
  kind: 'assessment' | 'component' | 'group' | 'period' | 'non_period' | 'final' | 'final_equivalent' | 'final_status';
  width: number;
  period: { key: string; label: string };
  group: { key: string; label: string };
  componentPath: { id: string; name: string }[];
  leafLabel: string;
  assessment?: FacultyAssessment;
  targetId?: string;
  periodId?: string;
  groupId?: string;
  nonPeriodScope?: boolean;
};

export function componentLabel(component: SwunextAssessmentComponent, typeId?: string | null, gradingSystem?: any) {
  const configuredType = gradingSystem?.assessmentTypes?.find((item: any) => item.id === typeId);
  return configuredType?.name ?? swunextAssessmentComponents.find((item) => item.key === component)?.label ?? 'Assessment';
}

export function assessmentGroupLabel(assessment: { gradingGroupId?: string | null; moduleNumber?: number | null }, groups: { id: string; name: string }[]) {
  const groupId = assessment.gradingGroupId ?? (assessment.moduleNumber == null ? '' : `m${assessment.moduleNumber}`);
  return groups.find((group) => group.id === groupId)?.name ?? 'No group';
}

export function assessmentPeriodLabel(assessment: { gradingPeriodId?: string | null; gradingPeriod?: string | null }, periods: { id: string; name: string }[]) {
  return periods.find((period) => period.id === assessment.gradingPeriodId)?.name ?? assessment.gradingPeriod ?? '';
}

export function assessmentComponentPath(system: any, typeId: string): { id: string; name: string }[] {
  const components = Array.isArray(system?.components) ? system.components : [];
  const target = components.find((component: any) => component.assessmentDefinition?.typeId === typeId);
  if (!target) return [{ id: typeId, name: componentLabel('other', typeId, system) }];
  const findPath = (currentId: string, path: { id: string; name: string }[], visited: Set<string>): { id: string; name: string }[] | undefined => {
    if (visited.has(currentId)) return undefined;
    const current = components.find((component: any) => component.id === currentId);
    if (!current) return undefined;
    const nextPath = [...path, { id: current.id, name: current.name }];
    if (current.id === target.id) return nextPath;
    const children = (current.calculation?.components ?? []).map((item: any) => item.componentId).filter(Boolean);
    for (const childId of children) {
      const found = findPath(childId, nextPath, new Set([...visited, currentId]));
      if (found) return found;
    }
    return undefined;
  };
  const rootId = system?.calculationRootComponentId;
  const path = rootId ? findPath(rootId, [], new Set()) : undefined;
  return path ?? [{ id: target.id, name: target.name }];
}

export function gradingComponentPath(system: any, componentId: string) {
  const components = system.components ?? [];
  const findPath = (currentId: string, path: { id: string; name: string }[], seen: Set<string>): { id: string; name: string }[] | undefined => {
    if (seen.has(currentId)) return undefined;
    const current = components.find((component: any) => component.id === currentId);
    if (!current) return undefined;
    const nextPath = [...path, { id: current.id, name: current.name }];
    if (currentId === componentId) return nextPath;
    for (const ref of current.calculation?.components ?? []) {
      const result = findPath(ref.componentId, nextPath, new Set([...seen, currentId]));
      if (result) return result;
    }
    return undefined;
  };
  return findPath(system.calculationRootComponentId, [], new Set()) ?? [{ id: componentId, name: components.find((component: any) => component.id === componentId)?.name ?? componentId }];
}

export function groupHierarchyName(group: any, groups: any[]) {
  const path = [group.name];
  let parentId = group.parentGroupId;
  const seen = new Set<string>([group.id]);
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = groups.find((item) => item.id === parentId);
    if (!parent) break;
    path.unshift(parent.name);
    parentId = parent.parentGroupId;
  }
  return path.join(' › ');
}

export function calculateFullViewGrades(workspace: ClassWorkspace, enrollmentId: string, gradingSystem: any, pendingValues: Record<string, string> = {}, missingScoreHandling: 'ignore' | 'zero' | 'full' = 'ignore') {
  const assessmentById = new Map(workspace.assessments.map((assessment) => [assessment.id, assessment]));
  const assessments = workspace.assessments.map((assessment) => {
    const rawScore = pendingValues[`${enrollmentId}:${assessment.id}`] ?? storedAssessmentValue(workspace, enrollmentId, assessment.id);
    return {
      id: assessment.id,
      typeId: assessment.gradingTypeId ?? assessment.component,
      score: rawScore == null || rawScore === '' ? null : rawScore,
      missingScorePercentage: missingScoreHandling === 'zero' ? 0 : missingScoreHandling === 'full' ? 100 : undefined,
      maximumScore: assessment.maximumScore,
      weight: assessment.instanceWeight ?? undefined,
      periodId: assessment.gradingPeriodId,
      groupId: assessment.gradingGroupId ?? (assessment.moduleNumber == null ? undefined : `m${assessment.moduleNumber}`),
    };
  });
  if (missingScoreHandling !== 'ignore') {
    const missingScorePercentage = missingScoreHandling === 'zero' ? 0 : 100;
    const aliases: Record<string, string> = { start_of_class: 'soc', lets_practice: 'lp', reflection: 'tb', wrap_up_quiz: 'wuq', project_checkin: 'cig', final_project: 'fo' };
    const matchesType = (rowType: string, definitionType: string) => rowType === definitionType || (aliases[rowType] ?? rowType) === (aliases[definitionType] ?? definitionType);
    for (const component of gradingSystem.components ?? []) {
      const definition = component.assessmentDefinition;
      const minimum = Number(definition?.count?.min ?? 0);
      if (!definition || minimum <= 0) continue;
      const typeId = definition.typeId;
      const typeRows = assessments.filter((item) => matchesType(item.typeId, typeId));
      const addMissing = (count: number, periodId?: string, groupId?: string) => {
        for (let index = 0; index < count; index += 1) assessments.push({
          id: `missing:${typeId}:${periodId ?? ''}:${groupId ?? ''}:${index}`,
          typeId,
          score: null,
          missingScorePercentage,
          maximumScore: definition.maxScore ?? 100,
          weight: 1,
          periodId,
          groupId,
        });
      };
      const scope = definition.count?.scope?.type;
      if (scope === 'per_group') {
        const requiredGroups = (gradingSystem.groups ?? []).filter((group: any) => group.typeId === definition.count.scope.groupTypeId);
        for (const group of requiredGroups) {
          const present = typeRows.filter((item) => item.groupId === group.id).length;
          addMissing(Math.max(0, minimum - present), undefined, group.id);
        }
      } else if (scope === 'per_period') {
        for (const period of gradingSystem.periods ?? []) {
          const present = typeRows.filter((item) => item.periodId === period.id).length;
          addMissing(Math.max(0, minimum - present), period.id);
        }
      } else {
        addMissing(Math.max(0, minimum - typeRows.length));
      }
    }
  }
  const result = calculateGradingSystem(gradingSystem, assessments);
  const contributingTypeIds = new Set((gradingSystem.components ?? []).map((component: any) => component.assessmentDefinition?.typeId).filter(Boolean));
  const missingRequired = workspace.assessments.filter((assessment) => {
    const typeId = assessment.gradingTypeId ?? assessment.component;
    const currentValue = pendingValues[`${enrollmentId}:${assessment.id}`] ?? storedAssessmentValue(workspace, enrollmentId, assessment.id);
    return !assessment.optional && contributingTypeIds.has(typeId)
      && (currentValue == null || currentValue === '');
  });
  let gradebookStatus = result.remarks === 'passing' ? 'Pass' : result.remarks === 'failing' ? 'Fail' : 'Incomplete';
  if (missingRequired.length) {
    const missingRequiredIds = new Set(missingRequired.map((assessment) => assessment.id));
    const bestMappedValueByType = new Map<string, string | undefined>();
    const bestPossibleInputs = assessments.map((input) => {
      if (!missingRequiredIds.has(input.id)) return input;
      const assessment = assessmentById.get(input.id);
      if (!assessment) return input;
      const typeId = assessment.gradingTypeId ?? assessment.component;
      let bestMappedValue = bestMappedValueByType.get(typeId);
      if (!bestMappedValueByType.has(typeId)) {
        const mapping = valueMappingForType(gradingSystem, typeId);
        bestMappedValue = mapping?.length ? mapping.reduce((best, option) => option.percentage > best.percentage ? option : best, mapping[0]).value : undefined;
        bestMappedValueByType.set(typeId, bestMappedValue);
      }
      return { ...input, score: bestMappedValue ?? assessment.maximumScore };
    });
    const bestPossibleGrade = calculateGradingSystem(gradingSystem, bestPossibleInputs).finalGrade;
    const passingPercentage = Number(gradingSystem.finalGradeConversion?.passingPercentage ?? 80);
    if (bestPossibleGrade != null && bestPossibleGrade < passingPercentage) gradebookStatus = 'Fail';
    else if (workspace.semesterEndsOn) {
      const today = new Date();
      const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      gradebookStatus = workspace.semesterEndsOn < todayKey ? 'Incomplete (final)' : 'Incomplete (ongoing)';
    }
  }
  return { ...result, gradebookStatus };
}

export function gradePercent(value: number | null | undefined, decimalPlaces = 1, showPercentSign = true) {
  return value == null ? '—' : `${value.toFixed(decimalPlaces)}${showPercentSign ? '%' : ''}`;
}

export function fullAssessmentColumnWidth(assessment: FacultyAssessment, system: any, workspace: ClassWorkspace, values: Record<string, string>) {
  if (valueMappingForType(system, assessment.gradingTypeId ?? assessment.component)) return 108;
  const longest = workspace.students.reduce((length, student) => {
    const key = `${student.enrollmentId}:${assessment.id}`;
    const value = values[key] ?? storedAssessmentValue(workspace, student.enrollmentId, assessment.id);
    return Math.max(length, value == null ? 0 : String(value).trim().length);
  }, 3);
  return longest <= 3 ? 42 : Math.max(42, longest * 10 + 4);
}

export function fullViewColumns(assessments: FacultyAssessment[], system: any, columnWidth: (assessment: FacultyAssessment) => number, hideSingleChildComponentGrades: boolean): FullViewColumn[] {
  type TreeNode = { key: string; label: string; kind: 'period' | 'group' | 'component' | 'assessment'; children: TreeNode[]; periodId?: string; groupId?: string; groupLabel?: string; componentId?: string; componentPath: { id: string; name: string }[]; assessment?: FacultyAssessment };
  const roots: TreeNode[] = [];
  const ensureNode = (siblings: TreeNode[], key: string, label: string, kind: TreeNode['kind'], extra: Partial<TreeNode> = {}) => {
    let node = siblings.find((item) => item.key === key);
    if (!node) { node = { key, label, kind, children: [], componentPath: [], ...extra }; siblings.push(node); }
    return node;
  };
  const periodNode = (periodId?: string, periodName?: string) => ensureNode(roots, periodId ?? 'no-period', periodName ?? 'No period', 'period', { periodId });
  const groupNode = (period: TreeNode, groupId?: string, groupName = 'No group') => ensureNode(period.children, groupId ?? 'no-group', groupName, 'group', { periodId: period.periodId, groupId });

  for (const period of [...(system.periods ?? [])].sort((a: any, b: any) => (a.sequence ?? 0) - (b.sequence ?? 0))) {
    const pNode = periodNode(period.id, period.name);
    for (const groupId of period.groupIds ?? []) {
      const group = system.groups?.find((item: any) => item.id === groupId);
      if (group) groupNode(pNode, group.id, groupHierarchyName(group, system.groups ?? []));
    }
  }
  for (const group of [...(system.groups ?? [])].sort((a: any, b: any) => (a.sequence ?? 0) - (b.sequence ?? 0))) {
    if (!(system.periods ?? []).some((period: any) => period.groupIds?.includes(group.id))) groupNode(periodNode(undefined, 'No period'), group.id, groupHierarchyName(group, system.groups ?? []));
  }

  for (const assessment of assessments) {
    const periodId = assessment.gradingPeriodId ?? system.periods?.find((period: any) => period.name === assessment.gradingPeriod)?.id;
    const period = periodNode(periodId, assessmentPeriodLabel(assessment, system.periods ?? []) || 'No period');
    const groupId = assessment.gradingGroupId ?? (assessment.moduleNumber == null ? undefined : `m${assessment.moduleNumber}`);
    let current = groupNode(period, groupId, groupId ? assessmentGroupLabel(assessment, system.groups ?? []) : 'No group');
    const assignedGroup = current;
    const path = assessmentComponentPath(system, assessment.gradingTypeId ?? assessment.component);
    for (const [index, component] of path.entries()) {
      current = ensureNode(current.children, component.id, component.name, 'component', { periodId: period.periodId, groupId, groupLabel: assignedGroup.label, componentId: component.id, componentPath: path.slice(0, index + 1) });
    }
    current.children.push({ key: assessment.id, label: assessment.title, kind: 'assessment', children: [], periodId: period.periodId, groupId, groupLabel: assignedGroup.label, componentPath: path, assessment });
  }

  const columns: FullViewColumn[] = [];
  const addComputed = (node: TreeNode, kind: FullViewColumn['kind'], id: string, label: string, width: number, extra: Partial<FullViewColumn> = {}) => {
    const periodKey = node.periodId ?? 'no-period';
    const periodLabel = roots.find((item) => item.key === periodKey)?.label ?? 'No period';
    const groupKey = node.groupId ?? 'no-group';
    const groupLabel = node.kind === 'group' ? node.label : node.groupLabel ?? 'No group';
    columns.push({ id, kind, width, period: { key: periodKey, label: periodLabel }, group: { key: groupKey, label: groupLabel }, componentPath: node.componentPath, leafLabel: label, periodId: node.periodId, groupId: node.groupId, ...extra });
  };
  const visit = (node: TreeNode, parent?: TreeNode) => {
    if (node.kind === 'assessment' && node.assessment) {
      const assessment = node.assessment;
      columns.push({ id: `assessment:${assessment.id}`, kind: 'assessment', assessment, period: { key: node.periodId ?? 'no-period', label: roots.find((item) => item.key === (node.periodId ?? 'no-period'))?.label ?? 'No period' }, group: { key: node.groupId ?? 'no-group', label: node.groupLabel ?? 'No group' }, componentPath: node.componentPath, leafLabel: `${assessment.title} · ${assessment.maximumScore}`, width: columnWidth(assessment), periodId: node.periodId, groupId: node.groupId });
      return;
    }
    for (const child of node.children) visit(child, node);
    const isOnlySubcomponent = parent && (parent.kind === 'component' || parent.kind === 'group') && parent.children.filter((child) => child.kind === 'component').length === 1;
    const isOverallRootRepeatedForPeriod = system.periodCalculation?.mode === 'independent' && node.componentId === system.calculationRootComponentId && !!node.periodId;
    if (node.kind === 'component' && node.componentId && !isOverallRootRepeatedForPeriod && !(hideSingleChildComponentGrades && isOnlySubcomponent)) addComputed(node, 'component', `component:${node.key}:${node.periodId ?? ''}:${node.groupId ?? ''}`, 'Grade', 46, { targetId: node.componentId, nonPeriodScope: !node.periodId && !node.groupId });
    if (node.kind === 'group' && node.groupId) addComputed(node, 'group', `group:${node.groupId}:${node.periodId ?? ''}`, 'Group grade', 46, { targetId: node.groupId });
    if (node.kind === 'group' && !node.groupId && node.periodId === undefined) addComputed(node, 'non_period', 'non-period', 'Non-period grade', 46, { nonPeriodScope: true });
    if (node.kind === 'period' && node.periodId) addComputed(node, 'period', `period:${node.periodId}`, 'Period grade', 46, { targetId: node.periodId });
  };
  for (const root of roots) visit(root);
  columns.push({ id: 'final', kind: 'final', width: 72, period: { key: 'final-grade', label: 'Final grade' }, group: { key: 'final-grade', label: '' }, componentPath: [], leafLabel: 'Percentage grade' });
  columns.push({ id: 'final-equivalent', kind: 'final_equivalent', width: 82, period: { key: 'final-grade', label: 'Final grade' }, group: { key: 'final-grade', label: '' }, componentPath: [], leafLabel: 'Point / letter grade' });
  columns.push({ id: 'final-status', kind: 'final_status', width: 148, period: { key: 'final-grade', label: 'Final grade' }, group: { key: 'final-grade', label: '' }, componentPath: [], leafLabel: 'Status' });
  return columns;
}

export function fullAssessmentHeaderRows(columns: FullViewColumn[]) {
  const maxDepth = Math.max(0, ...columns.map((column) => column.componentPath.length));
  const rows: { level: string; componentDepth?: number; cells: { label: string; width: number; mergeKey: string; columnStart: number; columnEnd: number }[] }[] = [];
  const makeRow = (level: string, keyAndLabel: (column: FullViewColumn) => { key: string; label: string }, componentDepth?: number) => {
    const cells: { label: string; width: number; mergeKey: string; columnStart: number; columnEnd: number }[] = [];
    columns.forEach((column, columnIndex) => {
      const item = keyAndLabel(column);
      const previous = cells[cells.length - 1];
      if (previous?.mergeKey === item.key) { previous.width += column.width; previous.columnEnd = columnIndex; }
      else cells.push({ label: item.label, width: column.width, mergeKey: item.key, columnStart: columnIndex, columnEnd: columnIndex });
    });
    rows.push({ level, componentDepth, cells });
  };
  makeRow('PERIOD', (column) => ({ key: column.period.key, label: column.period.label }));
  makeRow('GROUP', (column) => ({ key: `${column.period.key}/${column.group.key}`, label: column.group.label }));
  for (let depth = 0; depth < maxDepth; depth += 1) {
    makeRow(depth === 0 ? 'COMPONENT' : `SUBCOMPONENT ${depth}`, (column) => {
      const path = column.componentPath.slice(0, depth + 1);
      const node = column.componentPath[depth];
      return { key: `${column.period.key}/${column.group.key}/${path.map((item) => item.id).join('/')}`, label: node?.name ?? '' };
    }, depth);
  }
  makeRow('ASSESSMENT / RESULT', (column) => ({ key: column.id, label: column.leafLabel }));
  return rows;
}

export function fullViewColumnValue(column: FullViewColumn, enrollmentId: string, result: ReturnType<typeof calculateFullViewGrades>, workspace: ClassWorkspace, pendingValues: Record<string, string>) {
  if (column.kind === 'assessment' && column.assessment) return pendingValues[`${enrollmentId}:${column.assessment.id}`] ?? storedAssessmentValue(workspace, enrollmentId, column.assessment.id) ?? '';
  if (column.kind === 'component') return column.groupId ? result.groupComponents[column.groupId]?.[column.targetId!] ?? null : column.periodId ? result.periodComponents[column.periodId]?.[column.targetId!] ?? null : column.nonPeriodScope ? result.nonPeriodComponents[column.targetId!] ?? null : result.components[column.targetId!] ?? null;
  if (column.kind === 'group') return result.groups[column.targetId!] ?? null;
  if (column.kind === 'period') return result.periods[column.targetId!] ?? null;
  if (column.kind === 'non_period') return result.nonPeriod;
  if (column.kind === 'final_equivalent') return `${result.pointGrade == null ? '—' : result.pointGrade.toFixed(2)}${result.letterGrade ? ` / ${result.letterGrade}` : ''}`;
  if (column.kind === 'final_status') return (result as typeof result & { gradebookStatus?: string }).gradebookStatus ?? (result.remarks === 'passing' ? 'Pass' : result.remarks === 'failing' ? 'Fail' : 'Incomplete');
  return result.finalGrade;
}

export function displayedFullViewColumnValue(column: FullViewColumn, enrollmentId: string, result: ReturnType<typeof calculateFullViewGrades>, workspace: ClassWorkspace, pendingValues: Record<string, string>, system: any, display: 'grade' | 'contribution') {
  const value = fullViewColumnValue(column, enrollmentId, result, workspace, pendingValues);
  if (display !== 'contribution' || typeof value !== 'number' || column.kind === 'final' || column.kind === 'final_equivalent') return value;
  const components = system.components ?? [];
  const weightValue = (weight: any) => typeof weight === 'number' ? weight : typeof weight?.value === 'number' ? weight.value : weight?.numerator != null && weight?.denominator ? weight.numerator / weight.denominator : 0;
  const contributionFromRefs = (refs: any[], weightMode: string | undefined, match: (ref: any) => boolean) => {
    const eligible = refs.filter(match);
    const ref = eligible[0];
    if (!ref) return null;
    const denominator = weightMode === 'absolute' ? 1 : refs.reduce((sum, item) => sum + weightValue(item.weight), 0);
    return denominator > 0 ? value * weightValue(ref.weight) / denominator : null;
  };
  if (column.kind === 'component' && column.targetId) {
    const path = column.componentPath;
    const parentId = path.length > 1 ? path[path.length - 2].id : null;
    const parent = components.find((item: any) => item.id === (parentId ?? system.calculationRootComponentId));
    if (parent && parent.id !== column.targetId) {
      const refs = parent.calculation?.components ?? [];
      const contribution = contributionFromRefs(refs, parent.calculation?.weightMode, (ref) => ref.componentId === column.targetId && (column.periodId == null || ref.periodId == null || ref.periodId === column.periodId));
      if (contribution != null) return contribution;
    }
  }
  if (column.kind === 'period' && column.targetId) {
    const root = components.find((item: any) => item.id === system.calculationRootComponentId);
    const contribution = contributionFromRefs(root?.calculation?.components ?? [], root?.calculation?.weightMode, (ref) => ref.source === 'period_component' && ref.periodId === column.targetId);
    if (contribution != null) return contribution;
  }
  if (column.kind === 'group' && column.targetId) {
    const groups = (system.groups ?? []).filter((group: any) => !column.periodId || group.periodIds?.includes?.(column.periodId) || system.periods?.find((period: any) => period.id === column.periodId)?.groupIds?.includes(group.id));
    const group = groups.find((item: any) => item.id === column.targetId);
    if (group) {
      const weight = weightValue(group.weight);
      const denominator = groups.reduce((sum: number, item: any) => sum + weightValue(item.weight), 0);
      if (denominator > 0) return value * weight / denominator;
    }
  }
  return value;
}

