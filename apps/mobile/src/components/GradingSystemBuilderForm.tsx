import { useState, type ComponentProps, type ReactNode } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';

import { Button, Field as BaseField, HelpTooltip, SelectField as BaseSelectField } from '@/components/ui';
import { colors } from '@/theme/tokens';
import type { GradingDefinition } from '@apms/domain';

type AnyRecord = Record<string, any>;
type Props = { definition: GradingDefinition; onChange: (value: GradingDefinition) => void; onValidate: () => void; errors: string[] };

const fieldHelp: Record<string, string> = {
  Name: 'Give this item a short, recognizable name. It appears anywhere users choose or review it.',
  Description: 'Add context to help other academic admins understand when this grading system should be used.',
  'Short code': 'An optional compact label used in tables and reports.',
  Sequence: 'Controls the order in which this item appears and is processed.',
  'Calculation root': 'Select the top-level component used to calculate the overall assessment result.',
  'Period strategy': 'Choose whether periods are calculated independently, cumulatively, or with custom formulas.',
  'Cumulative scope': 'Choose whether cumulative results build across periods or across groups.',
  'Final period': 'Choose the period whose cumulative calculation represents the end of the grading system.',
  'Final result source': 'Choose whether the final percentage comes from one component or a period grade.',
  'Passing percentage': 'The minimum percentage considered passing. This separates the passing and failing grade scales.',
  'Passing scale': 'Choose how passing percentages map to grade points, or use an explicit mapping in the JSON editor.',
  'Failing scale': 'Choose how failing percentages map to grade points, or use an explicit mapping in the JSON editor.',
  Rounding: 'Choose how calculated grade points are rounded.',
  'Decimal precision': 'Set how many decimal places are kept after rounding.',
  'Assessment type': 'Choose which assessment records contribute to this component.',
  'Minimum count': 'The minimum number of matching assessments required for a valid result.',
  'Maximum count': 'The maximum number of matching assessments included in this component.',
  'Maximum score': 'The default full-credit score used to convert assessment scores to percentages.',
  'Count applies': 'Choose whether assessment count limits apply overall, separately per period, or separately per group.',
  Scoring: 'Choose how recorded scores or values are converted to percentages.',
  Aggregation: 'Choose how multiple assessment results are combined into one component result.',
  'Input value': 'The score or category value that triggers this mapping row.',
  Percentage: 'The percentage assigned to the matching score or category value.',
  'Weight mode': 'Relative weights are normalized into a weighted average. Absolute contributions are added directly.',
  'Weight (decimal or n/d)': 'Enter a decimal such as 0.25 or a fraction such as 1/4. The value is used as this component’s weight.',
  Component: 'Choose the component whose result contributes to this weighted calculation.',
  'Period scope': 'Optionally evaluate the selected component in one specific period.',
  'Parent group': 'Choose the group that contains this group. Leave empty to keep it at the top level.',
  Type: 'Choose which group type this group belongs to.',
};
const fieldExamples: Record<string, string> = {
  Name: 'Example: Module 1',
  Description: 'Example: Quizzes make up 40%; the final project makes up 60%.',
  Sequence: 'Example: 1 → 2 → 3',
  'Short code': 'Example: QUIZ',
  'Calculation root': 'Example: Final Course Grade',
  'Passing percentage': 'Example: 50 means scores from 50% are passing.',
  'Decimal precision': 'Example: 2 keeps grades such as 3.25.',
  'Maximum score': 'Example: 18 out of 20 becomes 90%.',
  'Minimum count': 'Example: 3 requires at least three quizzes.',
  'Maximum count': 'Example: 5 uses no more than five quizzes.',
  'Weight (decimal or n/d)': 'Example: 0.25 or 1/4 gives this component one quarter of the relative weight.',
};

const choiceHelp: Record<string, string> = {
  independent: 'Calculate this period separately from the other periods.',
  cumulative: 'Include earlier periods or groups in later period results.',
  period_formula: 'Use custom per-period formulas configured in the JSON editor.',
  periods: 'Build cumulative results across periods in sequence.',
  groups: 'Build cumulative results across groups of the selected type.',
  component: 'Use a grading component as the source of the final percentage.',
  period_grade: 'Use a period’s calculated result as the final percentage.',
  equal_interval: 'Spread grade points evenly across the percentage range.',
  mapping: 'Use percentage thresholds and grade points specified in the JSON editor.',
  nearest: 'Round to the closest value at the selected decimal precision.',
  floor: 'Round down at the selected decimal precision.',
  ceiling: 'Round up at the selected decimal precision.',
  assessments: 'Calculate this component directly from matching assessment records.',
  weighted: 'Calculate this component by combining the results of child components.',
  linear: 'Convert a score to a percentage in direct proportion to its maximum score.',
  numeric_mapping: 'Map numeric score thresholds to percentages.',
  value_mapping: 'Map exact text or category values to percentages.',
  equal: 'Give each assessment result the same influence.',
  points: 'Combine results according to their maximum possible points.',
  relative: 'Normalize these weights by their total. Relative percentages normally add to 100%.',
  absolute: 'Apply each weight as a direct contribution without normalizing the total.',
  per_period: 'Apply the count limit separately within each period.',
  per_group: 'Apply the count limit separately within each group of the selected type.',
  overall: 'Apply the count limit across all matching assessments.',
};
const choiceExamples: Record<string, string> = {
  independent: 'P1 and P2 are calculated separately.', cumulative: 'P2 includes P1 results plus P2 results.', period_formula: 'P1 = Quiz × 20% + Exam × 80%.',
  periods: 'P1 → P2 → P3 builds the result across periods.', groups: 'Module 1 → Module 2 builds the result across modules.',
  component: 'Final result ← Course Grade component.', period_grade: 'Final result ← P3 period grade.',
  equal_interval: '80% maps to a better point than 60%, at even steps.', mapping: '≥ 90% → 1.0; ≥ 75% → 2.0.',
  nearest: '3.246 with 2 decimals becomes 3.25.', floor: '3.249 with 2 decimals becomes 3.24.', ceiling: '3.241 with 2 decimals becomes 3.25.',
  assessments: 'Quiz scores → Quiz component percentage.', weighted: 'Quiz 40% + Exam 60% → Course Grade.',
  linear: '18/20 points → 90%.', numeric_mapping: 'Score 80 or higher → 90%.', value_mapping: '“Excellent” → 95%.',
  equal: '80% and 100% → 90%.', points: '10/10 and 50/100 combine by available points.',
  relative: 'Quiz 25% + Project 75% = 100%.', absolute: 'Quiz contributes 25 points; exam contributes 75 points.',
  per_period: 'Require 2–5 quizzes in each period.', per_group: 'Require at least 1 assessment in each module.', overall: 'Require 3–5 quizzes across the course.',
};

function Field(props: ComponentProps<typeof BaseField>) {
  return <BaseField {...props} helpText={props.helpText ?? fieldHelp[props.label] ?? `Enter the ${props.label.toLowerCase()} for this grading system.`} helpExample={props.helpExample ?? fieldExamples[props.label] ?? `Example: ${props.label}`} />;
}

function SelectField(props: ComponentProps<typeof BaseSelectField>) {
  const contextualExample = (value: string) => {
    if (props.label === 'Period strategy') return ({ independent: 'P1 = 80% and P2 = 60% are reported separately.', cumulative: 'With one equally weighted assessment per period, P2 = (80% + 60%) ÷ 2 = 70%.', period_formula: 'Quiz 90% × 20% + Exam 70% × 80% = 74%.' } as Record<string, string>)[value];
    if (props.label === 'Aggregation') return ({ equal: '8/10 and 90/100 → ((8 ÷ 10 × 100%) + (90 ÷ 100 × 100%)) ÷ 2 = (80% + 90%) ÷ 2 = 85%.', points: '8/10 and 90/100 → (8 + 90) ÷ (10 + 100) = 98/110 ≈ 89.09%.', weighted: '80% at weight 1 and 90% at weight 3 → (80 × 1 + 90 × 3) ÷ 4 = 87.5%.' } as Record<string, string>)[value];
    return undefined;
  };
  const contextualHelp = (value: string) => {
    if (props.label === 'Aggregation') return ({ equal: 'Average the percentages, giving each assessment one equal share.', points: 'Weight each assessment percentage by its maximum possible points.', weighted: 'Use the weight entered for each assessment instance.' } as Record<string, string>)[value];
    return undefined;
  };
  const options = props.options.map((option) => ({ ...option, helpText: option.helpText ?? contextualHelp(option.value) ?? choiceHelp[option.value] ?? `Choose ${option.label} for ${props.label.toLowerCase()}.`, helpExample: option.helpExample ?? contextualExample(option.value) ?? choiceExamples[option.value] ?? `Example selection: ${option.label}.` }));
  return <BaseSelectField {...props} options={options} helpText={props.helpText ?? fieldHelp[props.label] ?? `Choose the ${props.label.toLowerCase()} for this grading system.`} helpExample={props.helpExample ?? `Example: ${props.label}`} />;
}

function uuid() {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return random;
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16);
    return (char === 'x' ? value : (value & 0x3) | 0x8).toString(16);
  });
}
export function createGradingDefinitionId() { return uuid(); }

const panel = { borderWidth: 1, borderColor: '#E3E7EE', borderRadius: 12, padding: 14, gap: 10, backgroundColor: '#FFFFFF' } as const;
const row = { flexDirection: 'row', gap: 10, alignItems: 'center', flexWrap: 'wrap' } as const;

export function GradingSystemBuilderForm({ definition, onChange, onValidate, errors }: Props) {
  const [section, setSection] = useState<'overview' | 'structure' | 'components' | 'grading' | 'review'>('overview');
  const [openType, setOpenType] = useState<number | null>(null);
  const [openPeriod, setOpenPeriod] = useState<number | null>(null);
  const [openGroup, setOpenGroup] = useState<number | null>(null);
  const [openComponent, setOpenComponent] = useState<number | null>(null);
  const [draggedPeriod, setDraggedPeriod] = useState<number | null>(null);
  const [draggedGroup, setDraggedGroup] = useState<string | null>(null);
  const [draggedComponentId, setDraggedComponentId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ kind: 'group' | 'component'; id: string; position: 'before' | 'inside' | 'after' } | null>(null);
  const [openGradeSection, setOpenGradeSection] = useState<'period' | 'final' | 'scale' | null>('period');
  const patch = (values: AnyRecord) => onChange({ ...definition, ...values });
  const getDropPosition = (event: any): 'before' | 'inside' | 'after' => {
    const rect = event.currentTarget?.getBoundingClientRect?.();
    if (!rect?.height) return 'inside';
    const ratio = (event.clientY - rect.top) / rect.height;
    return ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : 'inside';
  };
  const updateList = (key: 'assessmentTypes' | 'periods' | 'groupTypes' | 'groups' | 'components', index: number, values: AnyRecord) => {
    const source = [...((definition as AnyRecord)[key] ?? [])];
    const list = key === 'periods' || key === 'groups' ? source.sort((a, b) => a.sequence - b.sequence) : source;
    list[index] = { ...list[index], ...values }; patch({ [key]: list });
  };
  const addItem = (key: 'assessmentTypes' | 'periods' | 'groupTypes' | 'groups' | 'components', item: AnyRecord) => patch({ [key]: [...(((definition as AnyRecord)[key] ?? []) as AnyRecord[]), item] });
  const removeItem = (key: 'assessmentTypes' | 'periods' | 'groupTypes' | 'groups' | 'components', index: number) => {
    const source = [...(((definition as AnyRecord)[key] ?? []) as AnyRecord[])];
    const list = key === 'periods' || key === 'groups' ? source.sort((a, b) => a.sequence - b.sequence) : source;
    patch({ [key]: list.filter((_: AnyRecord, i: number) => i !== index) });
  };
  const componentParentId = (componentId: string): string | undefined => definition.components.find((item: AnyRecord) => item.calculation?.mode === 'weighted' && item.calculation.components?.some((ref: AnyRecord) => ref.componentId === componentId))?.id;
  const componentChildren = (componentId: string): AnyRecord[] => {
    const item = definition.components.find((entry: AnyRecord) => entry.id === componentId);
    const childIds = item?.calculation?.mode === 'weighted' ? (item.calculation.components ?? []).map((ref: AnyRecord) => ref.componentId) : [];
    return childIds.map((id: string) => definition.components.find((entry: AnyRecord) => entry.id === id)).filter(Boolean);
  };
  const canNestComponent = (componentId: string, parentId: string) => {
    if (componentId === parentId) return false;
    const visited = new Set<string>();
    const contains = (id: string): boolean => {
      if (id === componentId) return true;
      if (visited.has(id)) return false;
      visited.add(id);
      return componentChildren(id).some((child: AnyRecord) => contains(child.id));
    };
    return !contains(parentId);
  };
  const setComponentParent = (componentId: string, parentId?: string) => {
    if (parentId && !canNestComponent(componentId, parentId)) return;
    const components = definition.components.map((item: AnyRecord) => {
      if (item.calculation?.mode !== 'weighted') return item;
      const refs = (item.calculation.components ?? []).filter((ref: AnyRecord) => ref.componentId !== componentId);
      return { ...item, calculation: { ...item.calculation, components: refs } };
    });
    if (parentId) {
      const index = components.findIndex((item: AnyRecord) => item.id === parentId);
      const parent = components[index];
      const calculation = parent.calculation?.mode === 'weighted' ? parent.calculation : { mode: 'weighted', weightMode: 'relative', components: [] };
      components[index] = { ...parent, calculation: { ...calculation, components: [...(calculation.components ?? []), { source: 'component', componentId, weight: 1 }] } };
    }
    patch({ components, ...(definition.calculationRootComponentId === componentId && parentId ? { calculationRootComponentId: parentId } : {}) });
  };
  const moveComponentChild = (componentId: string, offset: number) => {
    const parentId = componentParentId(componentId);
    if (!parentId) return;
    const parent = definition.components.find((item: AnyRecord) => item.id === parentId);
    const refs = [...(parent?.calculation?.components ?? [])];
    const index = refs.findIndex((ref: AnyRecord) => ref.componentId === componentId);
    const next = index + offset;
    if (index < 0 || next < 0 || next >= refs.length) return;
    const [moved] = refs.splice(index, 1);
    refs.splice(next, 0, moved);
    patch({ components: definition.components.map((item: AnyRecord) => item.id === parentId ? { ...item, calculation: { ...item.calculation, components: refs } } : item) });
  };
  const moveComponentNear = (componentId: string, targetId: string, position: 'before' | 'after') => {
    if (componentId === targetId) return;
    const targetParentId = componentParentId(targetId);
    if (targetParentId === componentId) return;
    const currentParentId = componentParentId(componentId);
    if (currentParentId !== targetParentId && targetParentId && !canNestComponent(componentId, targetParentId)) return;
    const existingRef = definition.components.flatMap((item: AnyRecord) => item.calculation?.mode === 'weighted' ? item.calculation.components ?? [] : []).find((ref: AnyRecord) => ref.componentId === componentId);
    let components = [...definition.components].sort((a: AnyRecord, b: AnyRecord) => a.sequence - b.sequence).map((item: AnyRecord) => item.calculation?.mode === 'weighted' ? { ...item, calculation: { ...item.calculation, components: (item.calculation.components ?? []).filter((ref: AnyRecord) => ref.componentId !== componentId) } } : item);
    if (targetParentId) {
      const parentIndex = components.findIndex((item: AnyRecord) => item.id === targetParentId);
      const parent = components[parentIndex];
      const refs = [...(parent.calculation?.components ?? [])];
      const targetIndex = refs.findIndex((ref: AnyRecord) => ref.componentId === targetId);
      refs.splice(targetIndex + (position === 'after' ? 1 : 0), 0, existingRef ?? { source: 'component', componentId, weight: 1 });
      components[parentIndex] = { ...parent, calculation: { ...parent.calculation, components: refs } };
    } else {
      const roots = components.filter((item: AnyRecord) => !components.some((parent: AnyRecord) => parent.calculation?.mode === 'weighted' && parent.calculation.components?.some((ref: AnyRecord) => ref.componentId === item.id)));
      const filtered = roots.filter((item: AnyRecord) => item.id !== componentId);
      const targetIndex = filtered.findIndex((item: AnyRecord) => item.id === targetId);
      const moving = components.find((item: AnyRecord) => item.id === componentId);
      if (!moving) return;
      filtered.splice(targetIndex + (position === 'after' ? 1 : 0), 0, moving);
      const rootIds = new Set(filtered.map((item: AnyRecord) => item.id));
      let rootIndex = 0;
      components = components.map((item: AnyRecord) => rootIds.has(item.id) ? filtered[rootIndex++] : item).map((item: AnyRecord, sequence: number) => ({ ...item, sequence: sequence + 1 }));
    }
    patch({ components, ...(definition.calculationRootComponentId === componentId && targetParentId ? { calculationRootComponentId: targetParentId } : {}) });
  };
  const movePeriod = (from: number, to: number) => {
    const list = [...periods]; if (to < 0 || to >= list.length) return;
    const [item] = list.splice(from, 1); list.splice(to, 0, item); patch({ periods: list.map((period, sequence) => ({ ...period, sequence: sequence + 1 })) });
  };
  const setGroupParent = (groupId: string, parentGroupId?: string) => {
    if (groupId === parentGroupId) return;
    const descendants = new Set<string>();
    const collect = (id: string) => groups.filter((group: AnyRecord) => group.parentGroupId === id).forEach((child: AnyRecord) => { descendants.add(child.id); collect(child.id); });
    collect(groupId);
    if (parentGroupId && descendants.has(parentGroupId)) return;
    patch({ groups: groups.map((group: AnyRecord) => group.id === groupId ? { ...group, parentGroupId } : group) });
  };
  const moveGroupSibling = (groupId: string, offset: number) => {
    const item = groups.find((group: AnyRecord) => group.id === groupId);
    if (!item) return;
    const siblings = groups.filter((group: AnyRecord) => group.parentGroupId === item.parentGroupId);
    const index = siblings.findIndex((group: AnyRecord) => group.id === groupId);
    const next = index + offset;
    if (next < 0 || next >= siblings.length) return;
    const reordered = [...siblings];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(next, 0, moved);
    saveGroupSiblingOrder(item.parentGroupId, reordered);
  };
  const saveGroupSiblingOrder = (parentGroupId: string | undefined, reordered: AnyRecord[]) => {
    const siblingIds = new Set(reordered.map((group: AnyRecord) => group.id));
    let reorderedIndex = 0;
    const list = groups.map((group: AnyRecord) => siblingIds.has(group.id) ? reordered[reorderedIndex++] : group).map((group: AnyRecord, sequence: number) => ({ ...group, ...(siblingIds.has(group.id) ? { parentGroupId } : {}), sequence: sequence + 1 }));
    patch({ groups: list });
  };
  const moveGroupNear = (groupId: string, targetId: string, position: 'before' | 'after') => {
    if (groupId === targetId) return;
    const target = groups.find((group: AnyRecord) => group.id === targetId);
    if (!target) return;
    let ancestorId = target.parentGroupId;
    while (ancestorId) {
      if (ancestorId === groupId) return;
      ancestorId = groups.find((group: AnyRecord) => group.id === ancestorId)?.parentGroupId;
    }
    const siblings = groups.filter((group: AnyRecord) => group.parentGroupId === target.parentGroupId && group.id !== groupId);
    const targetIndex = siblings.findIndex((group: AnyRecord) => group.id === targetId);
    const moving = groups.find((group: AnyRecord) => group.id === groupId);
    if (!moving || targetIndex < 0) return;
    const reordered = [...siblings];
    reordered.splice(targetIndex + (position === 'after' ? 1 : 0), 0, { ...moving, parentGroupId: target.parentGroupId });
    saveGroupSiblingOrder(target.parentGroupId, reordered);
  };
  const componentIds = definition.components.map((component) => ({ label: component.name, value: component.id }));
  const typeIds = (definition.assessmentTypes ?? []).map((item: AnyRecord) => ({ label: item.name, value: item.id }));
  const groupTypeIds = (definition.groupTypes ?? []).map((item: AnyRecord) => ({ label: item.name, value: item.id }));
  const periods = [...(definition.periods ?? [])].sort((a: AnyRecord, b: AnyRecord) => a.sequence - b.sequence);
  const groups = [...(definition.groups ?? [])].sort((a: AnyRecord, b: AnyRecord) => a.sequence - b.sequence);
  const Wrapper: any = Platform.OS === 'web' ? 'div' : View;
  const renderGroup = (item: AnyRecord, depth = 0): ReactNode => {
    const siblings = groups.filter((group: AnyRecord) => group.parentGroupId === item.parentGroupId);
    const siblingIndex = siblings.findIndex((group: AnyRecord) => group.id === item.id);
    const children = groups.filter((group: AnyRecord) => group.parentGroupId === item.id);
    return <View key={`group-${item.id}`} style={{ marginLeft: depth * 18 }}>
      <Wrapper style={getDropStyle(listItem, draggedGroup === item.id, dropTarget?.kind === 'group' && dropTarget.id === item.id ? dropTarget.position : null)} draggable={Platform.OS === 'web'} onDragStart={(event: any) => { setDraggedGroup(item.id); event.dataTransfer?.setData('text/plain', item.id); }} onDragEnd={() => { setDraggedGroup(null); setDropTarget(null); }} onDragOver={(event: any) => { event.preventDefault?.(); const position = getDropPosition(event); setDropTarget(dropTarget?.kind === 'group' && dropTarget.id === item.id && dropTarget.position === position ? dropTarget : { kind: 'group', id: item.id, position }); }} onDrop={(event: any) => { event.preventDefault?.(); event.stopPropagation?.(); const groupId = event.dataTransfer?.getData('text/plain') || draggedGroup; const position = getDropPosition(event); if (groupId && position === 'inside') setGroupParent(groupId, item.id); else if (groupId && position !== 'inside') moveGroupNear(groupId, item.id, position); setDraggedGroup(null); setDropTarget(null); }}>
        <View style={row}><Text style={hint}>{children.length ? '▾' : '☰'} {item.sequence}</Text><Pressable onPress={() => setOpenGroup(openGroup === groups.findIndex((group: AnyRecord) => group.id === item.id) ? null : groups.findIndex((group: AnyRecord) => group.id === item.id))} style={{ flex: 1 }}><Text style={itemHeading}>{item.name}</Text></Pressable><Button label="↑" variant="secondary" disabled={siblingIndex === 0} onPress={() => moveGroupSibling(item.id, -1)} /><Button label="↓" variant="secondary" disabled={siblingIndex === siblings.length - 1} onPress={() => moveGroupSibling(item.id, 1)} /><Button label={openGroup === groups.findIndex((group: AnyRecord) => group.id === item.id) ? 'Done' : 'Edit'} variant="secondary" onPress={() => { const index = groups.findIndex((group: AnyRecord) => group.id === item.id); setOpenGroup(openGroup === index ? null : index); }} /><Button label="Remove" variant="danger" onPress={() => removeItem('groups', groups.findIndex((group: AnyRecord) => group.id === item.id))} /></View>
        {openGroup === groups.findIndex((group: AnyRecord) => group.id === item.id) ? <View style={row}>
          <Field label="Name" value={item.name} onChangeText={(name) => updateList('groups', groups.findIndex((group: AnyRecord) => group.id === item.id), { name })} helpText="Name this organizational group so admins can assign assessments and build nested structures." helpExample="Module 1 → Lesson 1" containerStyle={{ flex: 1, minWidth: 120 }} />
          <SelectField label="Type" value={item.typeId} options={groupTypeIds} onChange={(typeId) => updateList('groups', groups.findIndex((group: AnyRecord) => group.id === item.id), { typeId })} containerStyle={{ flex: 1, minWidth: 150 }} />
          <SelectField label="Parent group" value={item.parentGroupId ?? ''} options={[{ label: 'No parent', value: '' }, ...groups.filter((group: AnyRecord) => group.id !== item.id && !(() => { const descendants = new Set<string>(); const walk = (id: string) => groups.filter((entry: AnyRecord) => entry.parentGroupId === id).forEach((entry: AnyRecord) => { descendants.add(entry.id); walk(entry.id); }); walk(item.id); return descendants.has(group.id); })()).map((group: AnyRecord) => ({ label: group.name, value: group.id }))]} onChange={(parentGroupId) => setGroupParent(item.id, parentGroupId || undefined)} containerStyle={{ flex: 1, minWidth: 150 }} />
          {Platform.OS === 'web' ? <Button label="Make top level" variant="secondary" disabled={!item.parentGroupId} onPress={() => setGroupParent(item.id)} /> : null}
        </View> : null}
      </Wrapper>
      {children.map((child: AnyRecord) => renderGroup(child, depth + 1))}
    </View>;
  };
  const renderComponent = (component: AnyRecord, depth = 0): ReactNode => {
    const index = definition.components.findIndex((item: AnyRecord) => item.id === component.id);
    const children = componentChildren(component.id);
    const parentId = componentParentId(component.id);
    const siblings = parentId ? componentChildren(parentId) : definition.components.filter((item: AnyRecord) => !componentParentId(item.id)).sort((a: AnyRecord, b: AnyRecord) => a.sequence - b.sequence);
    const siblingIndex = siblings.findIndex((item: AnyRecord) => item.id === component.id);
    const targetPosition = dropTarget?.kind === 'component' && dropTarget.id === component.id ? dropTarget.position : null;
    const moveRelative = (offset: number) => {
      const target = siblings[siblingIndex + offset];
      if (target) moveComponentNear(component.id, target.id, offset < 0 ? 'before' : 'after');
    };
    return <View key={`component-tree-${component.id}`} style={{ marginLeft: depth * 18 }}>
      <Wrapper style={getDropStyle(componentPanel, draggedComponentId === component.id, targetPosition)} draggable={Platform.OS === 'web'} onDragStart={(event: any) => { setDraggedComponentId(component.id); event.dataTransfer?.setData('text/plain', component.id); }} onDragEnd={() => { setDraggedComponentId(null); setDropTarget(null); }} onDragOver={(event: any) => { event.preventDefault?.(); const position = getDropPosition(event); setDropTarget(dropTarget?.kind === 'component' && dropTarget.id === component.id && dropTarget.position === position ? dropTarget : { kind: 'component', id: component.id, position }); }} onDrop={(event: any) => { event.preventDefault?.(); event.stopPropagation?.(); const componentId = event.dataTransfer?.getData('text/plain') || draggedComponentId; const position = getDropPosition(event); if (componentId && position === 'inside') setComponentParent(componentId, component.id); else if (componentId && position !== 'inside') moveComponentNear(componentId, component.id, position); setDraggedComponentId(null); setDropTarget(null); }}>
        <View style={row}>
          <Pressable onPress={() => setOpenComponent(openComponent === index ? null : index)} style={{ flex: 1 }}><Text style={itemHeading}>{children.length ? '▾' : '☰'} {index + 1}. {component.name || component.id}</Text></Pressable>
          <Button label={openComponent === index ? 'Done' : 'Edit'} variant="secondary" onPress={() => setOpenComponent(openComponent === index ? null : index)} />
          <Button label="↑" variant="secondary" disabled={siblingIndex === 0} onPress={() => moveRelative(-1)} />
          <Button label="↓" variant="secondary" disabled={siblingIndex === siblings.length - 1} onPress={() => moveRelative(1)} />
          <Button label="Remove" variant="danger" onPress={() => removeItem('components', index)} />
        </View>
        {openComponent === index ? <><View style={row}>
          <Field label="Name" value={component.name} onChangeText={(name) => updateList('components', index, { name })} helpText="Name the calculation component as users will recognize it in the grading system." helpExample="Final Project" containerStyle={{ flex: 2, minWidth: 150 }} />
          <Field label="Short code" value={component.shortCode ?? ''} onChangeText={(shortCode) => updateList('components', index, { shortCode })} containerStyle={{ flex: 1, minWidth: 100 }} />
          <Field label="Sequence" value={String(component.sequence ?? index + 1)} keyboardType="numeric" onChangeText={(value) => updateList('components', index, { sequence: Number(value) })} helpText="Controls the component’s order in the grading system and in ordered component lists." helpExample="1 · Quiz → 2 · Project → 3 · Final Grade" containerStyle={{ width: 100 }} />
        </View>
        <SelectField label="Calculation" value={component.calculation?.mode ?? 'assessments'} options={[{ label: 'Assessments', value: 'assessments' }, { label: 'Weighted components', value: 'weighted' }]} onChange={(mode) => updateList('components', index, { calculation: mode === 'weighted' ? { mode, weightMode: 'relative', components: [] } : { mode: 'assessments' }, ...(mode === 'assessments' ? { assessmentDefinition: component.assessmentDefinition ?? { typeId: typeIds[0]?.value ?? '', maxScore: 100, scoring: { mode: 'linear' }, aggregation: { mode: 'equal' } } } : {}) })} />
        {component.calculation?.mode === 'weighted' ? <WeightedComponentEditor component={component} index={index} update={(values) => updateList('components', index, values)} componentIds={componentIds} periods={periods} /> : <AssessmentComponentEditor component={component} index={index} update={(values) => updateList('components', index, values)} typeIds={typeIds} groupTypeIds={groupTypeIds} />}</> : null}
      </Wrapper>
      {children.map((child: AnyRecord) => renderComponent(child, depth + 1))}
    </View>;
  };

  const sections = [
    { id: 'overview', label: 'Overview' }, { id: 'structure', label: 'Periods & groups' },
    { id: 'components', label: 'Assessment components' }, { id: 'grading', label: 'Grade rules' }, { id: 'review', label: 'Validate' },
  ] as const;
  const activeLabel = sections.find((item) => item.id === section)?.label;
  return <View style={{ gap: 12 }}>
    <View style={stepNavigation}>{sections.map((item, index) => <Pressable key={item.id} onPress={() => setSection(item.id)} accessibilityRole="tab" accessibilityState={{ selected: section === item.id }} style={[stepButton, section === item.id && activeStepButton]}><Text style={[stepButtonText, section === item.id && activeStepText]}>{index + 1}. {item.label}</Text></Pressable>)}</View>
    <Text style={hint}>{activeLabel} · Step {sections.findIndex((item) => item.id === section) + 1} of {sections.length}</Text>
    {section === 'overview' ? <><View style={panel}>
      <SectionHeading title="System details" helpText="Set the title and purpose shown to academic admins when they choose a grading system." example="SWUNEXT Grading System · AY 2026–2027" />
      <Field label="Name" value={definition.name} onChangeText={(name) => patch({ name })} helpText="This is the grading system’s display name in lists and when it is applied to classes." helpExample="SWUNEXT Grading System · AY 2026–2027" />
      <Field label="Description" value={definition.description ?? ''} onChangeText={(description) => patch({ description })} helpText="Summarize when to use this grading system and any important rule it follows." helpExample="Uses quizzes for 40% and the final project for 60%." multiline numberOfLines={3} />
    </View>

    <View style={panel}>
      <SectionHeading title="Assessment types" helpText="Define the assessment categories that instructors can assign to scores." example="Quiz · Project · Final Exam" />
      {(definition.assessmentTypes ?? []).map((item: AnyRecord, index: number) => <View key={`type-${index}`} style={listItem}>
        <View style={row}><Pressable onPress={() => setOpenType(openType === index ? null : index)} style={{ flex: 1 }}><Text style={itemHeading}>{item.name}</Text></Pressable><Button label={openType === index ? 'Done' : 'Edit'} variant="secondary" onPress={() => setOpenType(openType === index ? null : index)} /><Button label="Remove" variant="danger" onPress={() => removeItem('assessmentTypes', index)} /></View>
        {openType === index ? <View style={row}><Field label="Name" value={item.name} onChangeText={(name) => updateList('assessmentTypes', index, { name })} helpText="Use a clear label for this kind of assessment." helpExample="Quiz" containerStyle={{ flex: 2, minWidth: 160 }} /><Field label="Short code" value={item.shortCode ?? ''} onChangeText={(shortCode) => updateList('assessmentTypes', index, { shortCode })} containerStyle={{ flex: 1, minWidth: 100 }} /></View> : null}
      </View>)}
      <Button label="Add assessment type" variant="secondary" onPress={() => addItem('assessmentTypes', { id: uuid(), name: 'New assessment type' })} />
    </View></> : null}

    {section === 'structure' ? <><View style={panel}>
      <SectionHeading title="Periods" helpText="Define the grading periods and the groups whose assessments count in each period." example="Quarter 1 includes Module 1 and Module 2." />
      <Text style={hint}>Drag rows to change their order. Sequence numbers update automatically; arrows work on touch screens.</Text>
      {periods.map((item: AnyRecord, index: number) => <Wrapper key={`period-${item.id}`} style={listItem} draggable={Platform.OS === 'web'} onDragStart={(event: any) => { setDraggedPeriod(index); event.dataTransfer?.setData('text/plain', String(index)); }} onDragOver={(event: any) => event.preventDefault?.()} onDrop={(event: any) => { event.preventDefault?.(); const from = Number(event.dataTransfer?.getData('text/plain') ?? draggedPeriod); if (Number.isInteger(from)) movePeriod(from, index); setDraggedPeriod(null); }}>
        <View style={row}><Text style={hint}>☰ {index + 1}</Text><Pressable onPress={() => setOpenPeriod(openPeriod === index ? null : index)} style={{ flex: 1 }}><Text style={itemHeading}>{item.name} <Text style={hint}>· {item.groupIds?.length ?? 0} groups</Text></Text></Pressable><Button label="↑" variant="secondary" disabled={index === 0} onPress={() => movePeriod(index, index - 1)} /><Button label="↓" variant="secondary" disabled={index === periods.length - 1} onPress={() => movePeriod(index, index + 1)} /><Button label={openPeriod === index ? 'Done' : 'Edit'} variant="secondary" onPress={() => setOpenPeriod(openPeriod === index ? null : index)} /><Button label="Remove" variant="danger" onPress={() => removeItem('periods', index)} /></View>
        {openPeriod === index ? <><View style={row}><Field label="Name" value={item.name} onChangeText={(name) => updateList('periods', index, { name })} helpText="Name this grading period in the order students complete it." helpExample="Quarter 1" containerStyle={{ flex: 1, minWidth: 120 }} /></View>
          <View style={{ gap: 5 }}><Text style={hint}>Groups in this period</Text><View style={row}>{groups.map((group: AnyRecord) => { const active = (item.groupIds ?? []).includes(group.id); return <View key={group.id} style={row}><Pressable accessibilityRole="checkbox" accessibilityState={{ checked: active }} onPress={() => updateList('periods', index, { groupIds: active ? item.groupIds.filter((id: string) => id !== group.id) : [...(item.groupIds ?? []), group.id] })} style={[groupChip, active && activeGroupChip]}><Text style={{ color: active ? '#FFFFFF' : colors.text }}>{active ? '✓ ' : ''}{group.name}</Text></Pressable><HelpTooltip title={group.name} text={`Include assessments assigned to ${group.name} when calculating this period.`} example="Quarter 1 includes Module 1 and Module 2." /></View>; })}</View></View></> : null}
      </Wrapper>)}
      <Button label="Add period" variant="secondary" onPress={() => addItem('periods', { id: uuid(), name: `Period ${periods.length + 1}`, sequence: periods.length + 1, groupIds: [] })} />
    </View>

    <View style={panel}>
      <SectionHeading title="Group types and groups" helpText="Create group categories and organize individual groups into parent and child levels." example="Module 1 → Lesson 1 → Activity 1" />
      <Text style={hint}>Drag a group onto another to nest it. Drop on the top-level area to unnest. Use arrows to reorder within the same level; parent can also be set while editing.</Text>
      {definition.groupTypes?.map((item: AnyRecord, index: number) => <View key={`gt-${index}`} style={row}>
        <Field label="Name" value={item.name} onChangeText={(name) => updateList('groupTypes', index, { name })} helpText="Name the category shared by related groups." helpExample="Module" containerStyle={{ flex: 1 }} />
        <Button label="Remove" variant="danger" onPress={() => removeItem('groupTypes', index)} />
      </View>)}
      <Button label="Add group type" variant="secondary" onPress={() => addItem('groupTypes', { id: uuid(), name: 'Group type' })} />
      {Platform.OS === 'web' ? <Wrapper style={getDropStyle(rootDropZone, false, dropTarget?.kind === 'group' && dropTarget.id === '__group_root__' ? 'inside' : null)} onDragOver={(event: any) => { event.preventDefault?.(); setDropTarget({ kind: 'group', id: '__group_root__', position: 'inside' }); }} onDrop={(event: any) => { event.preventDefault?.(); const groupId = event.dataTransfer?.getData('text/plain') || draggedGroup; if (groupId) setGroupParent(groupId); setDraggedGroup(null); setDropTarget(null); }}><Text style={hint}>Drop here to move a group to the top level</Text></Wrapper> : null}
      {groups.filter((item: AnyRecord) => !item.parentGroupId || !groups.some((group: AnyRecord) => group.id === item.parentGroupId)).map((item: AnyRecord) => renderGroup(item))}
      <Button label="Add group" variant="secondary" disabled={!groupTypeIds.length} onPress={() => addItem('groups', { id: uuid(), name: 'Group', typeId: groupTypeIds[0]?.value, sequence: groups.length + 1 })} />
    </View></> : null}

    {section === 'components' ? <View style={panel}>
      <SectionHeading title="Grading components" helpText="Build assessment-based components and combine them into the overall grading result." example="Quiz 40% + Project 60% → Course Grade" />
      <Text style={hint}>Drag to a row’s top or bottom line to place components beside it; drop in the shaded center to make it a weighted child. Touch screens use the arrows and the weighted component editor.</Text>
      {Platform.OS === 'web' ? <Wrapper style={getDropStyle(rootDropZone, false, dropTarget?.kind === 'component' && dropTarget.id === '__component_root__' ? dropTarget.position : null)} onDragOver={(event: any) => { event.preventDefault?.(); setDropTarget({ kind: 'component', id: '__component_root__', position: 'inside' }); }} onDrop={(event: any) => { event.preventDefault?.(); const componentId = event.dataTransfer?.getData('text/plain') || draggedComponentId; if (componentId) setComponentParent(componentId); setDraggedComponentId(null); setDropTarget(null); }}><Text style={hint}>Drop here to move a component to the top level</Text></Wrapper> : null}
      {definition.components.filter((component: AnyRecord) => !componentParentId(component.id)).sort((a: AnyRecord, b: AnyRecord) => a.sequence - b.sequence).map((component: AnyRecord) => renderComponent(component))}
      <Button label="Add component" variant="secondary" onPress={() => addItem('components', { id: uuid(), name: 'New component', sequence: definition.components.length + 1, calculation: { mode: 'assessments' }, assessmentDefinition: { typeId: typeIds[0]?.value ?? '', maxScore: 100, scoring: { mode: 'linear' }, aggregation: { mode: 'equal' } } })} />
      <SelectField label="Calculation root" value={definition.calculationRootComponentId} options={componentIds} onChange={(calculationRootComponentId) => patch({ calculationRootComponentId })} />
    </View> : null}

    {section === 'grading' ? <View style={panel}>
      <SectionHeading title="Grade rules" helpText="Set how period results, final results, and percentages map to grades." example="82% → passing scale → 2.0" />
      <Text style={hint}>Set how periods combine, choose the final result, then define grade conversion.</Text>
      <AccordionSection title="Period calculation" summary={definition.periodCalculation?.mode === 'cumulative' ? 'Cumulative' : definition.periodCalculation?.mode === 'period_formula' ? 'Period formulas' : 'Independent periods'} helpText="Choose how each period’s results are calculated." example="P2 cumulative = P1 results + P2 results." open={openGradeSection === 'period'} onToggle={() => setOpenGradeSection(openGradeSection === 'period' ? null : 'period')}>
      <SelectField label="Period strategy" value={definition.periodCalculation?.mode ?? 'independent'} helpText="Choose whether each period stands alone, builds on earlier periods, or uses its own formula." helpExample="Independent: P1 = 80%, P2 = 60%. Cumulative with equal counts: P2 = (80 + 60) ÷ 2 = 70%." options={[{ label: 'Independent', value: 'independent' }, { label: 'Cumulative', value: 'cumulative' }, { label: 'Period formulas (configure in JSON editor)', value: 'period_formula' }]} onChange={(mode) => patch({ periodCalculation: mode === 'cumulative' ? { mode, scope: 'groups', groupTypeId: groupTypeIds[0]?.value, finalPeriodId: periods.at(-1)?.id } : mode === 'period_formula' ? { mode, periods: [] } : { mode } })} />
      {definition.periodCalculation?.mode === 'cumulative' ? <View style={row}>
        <SelectField label="Cumulative scope" value={definition.periodCalculation.scope} options={[{ label: 'Periods', value: 'periods' }, { label: 'Groups', value: 'groups' }]} onChange={(scope) => patch({ periodCalculation: { ...definition.periodCalculation, scope } })} />
        {definition.periodCalculation.scope === 'groups' ? <SelectField label="Group type" value={definition.periodCalculation.groupTypeId ?? ''} options={groupTypeIds} onChange={(groupTypeId) => patch({ periodCalculation: { ...definition.periodCalculation, groupTypeId } })} /> : null}
        <SelectField label="Final period" value={definition.periodCalculation.finalPeriodId ?? ''} options={periods.map((period: AnyRecord) => ({ label: period.name, value: period.id }))} onChange={(finalPeriodId) => patch({ periodCalculation: { ...definition.periodCalculation, finalPeriodId } })} />
      </View> : null}
      </AccordionSection>
      <AccordionSection title="Final result" summary={definition.finalResult.source === 'component' ? 'From a component' : 'From a period grade'} helpText="Select which calculated component or period supplies the final percentage." example="Course Grade component → 82%." open={openGradeSection === 'final'} onToggle={() => setOpenGradeSection(openGradeSection === 'final' ? null : 'final')}>
      <View style={row}>
        <SelectField label="Final result source" value={definition.finalResult.source} options={[{ label: 'Component', value: 'component' }, { label: 'Period grade', value: 'period_grade' }]} onChange={(source) => patch({ finalResult: source === 'component' ? { source, componentId: componentIds[0]?.value ?? '' } : { source, periodId: periods[0]?.id ?? '' } })} containerStyle={{ flex: 1, minWidth: 180 }} />
        {definition.finalResult.source === 'component' ? <SelectField label="Final component" value={definition.finalResult.componentId} options={componentIds} onChange={(componentId) => patch({ finalResult: { ...definition.finalResult, componentId } })} /> : <SelectField label="Final period" value={definition.finalResult.periodId} options={periods.map((period: AnyRecord) => ({ label: period.name, value: period.id }))} onChange={(periodId) => patch({ finalResult: { ...definition.finalResult, periodId } })} />}
      </View>
      </AccordionSection>
      <AccordionSection title="Grade conversion" summary={`Passing at ${definition.finalGradeConversion.passingPercentage}% · ${definition.finalGradeConversion.rounding.mode} rounding`} helpText="Set the passing threshold, grade point scales, and rounding precision." example="82% → passing scale → 2.0." open={openGradeSection === 'scale'} onToggle={() => setOpenGradeSection(openGradeSection === 'scale' ? null : 'scale')}>
      <Field label="Passing percentage" value={String(definition.finalGradeConversion.passingPercentage)} keyboardType="numeric" onChangeText={(value) => patch({ finalGradeConversion: { ...definition.finalGradeConversion, passingPercentage: Number(value) } })} />
      <View style={row}>
        <SelectField label="Passing scale" value={definition.finalGradeConversion.passingScale.mode} options={[{ label: 'Equal intervals', value: 'equal_interval' }, { label: 'Explicit mapping', value: 'mapping' }]} onChange={(mode) => patch({ finalGradeConversion: { ...definition.finalGradeConversion, passingScale: mode === 'equal_interval' ? { mode, maximumPercentage: 100, bestPoint: 1, passingPoint: 3, pointInterval: 0.25 } : { mode, mapping: [{ minimumPercentage: definition.finalGradeConversion.passingPercentage, point: 3 }] } } })} />
        {definition.finalGradeConversion.passingScale.mode === 'equal_interval' ? <><Field label="Best point" value={String(definition.finalGradeConversion.passingScale.bestPoint)} keyboardType="numeric" onChangeText={(value) => patch({ finalGradeConversion: { ...definition.finalGradeConversion, passingScale: { ...definition.finalGradeConversion.passingScale, bestPoint: Number(value) } } })} /><Field label="Passing point" value={String(definition.finalGradeConversion.passingScale.passingPoint)} keyboardType="numeric" onChangeText={(value) => patch({ finalGradeConversion: { ...definition.finalGradeConversion, passingScale: { ...definition.finalGradeConversion.passingScale, passingPoint: Number(value) } } })} /><Field label="Point interval" value={String(definition.finalGradeConversion.passingScale.pointInterval)} keyboardType="numeric" onChangeText={(value) => patch({ finalGradeConversion: { ...definition.finalGradeConversion, passingScale: { ...definition.finalGradeConversion.passingScale, pointInterval: Number(value) } } })} /></> : null}
        <SelectField label="Failing scale" value={definition.finalGradeConversion.failingScale.mode} options={[{ label: 'Equal intervals', value: 'equal_interval' }, { label: 'Explicit mapping', value: 'mapping' }]} onChange={(mode) => patch({ finalGradeConversion: { ...definition.finalGradeConversion, failingScale: mode === 'equal_interval' ? { mode, minimumPercentage: 0, firstFailingPoint: 3.25, worstPoint: 5, pointInterval: 0.25 } : { mode, mapping: [{ minimumPercentage: 0, point: 5 }] } } })} />
        {definition.finalGradeConversion.failingScale.mode === 'equal_interval' ? <><Field label="First failing point" value={String(definition.finalGradeConversion.failingScale.firstFailingPoint)} keyboardType="numeric" onChangeText={(value) => patch({ finalGradeConversion: { ...definition.finalGradeConversion, failingScale: { ...definition.finalGradeConversion.failingScale, firstFailingPoint: Number(value) } } })} /><Field label="Worst point" value={String(definition.finalGradeConversion.failingScale.worstPoint)} keyboardType="numeric" onChangeText={(value) => patch({ finalGradeConversion: { ...definition.finalGradeConversion, failingScale: { ...definition.finalGradeConversion.failingScale, worstPoint: Number(value) } } })} /><Field label="Point interval" value={String(definition.finalGradeConversion.failingScale.pointInterval)} keyboardType="numeric" onChangeText={(value) => patch({ finalGradeConversion: { ...definition.finalGradeConversion, failingScale: { ...definition.finalGradeConversion.failingScale, pointInterval: Number(value) } } })} /></> : null}
      </View>
      <View style={row}>
        <SelectField label="Rounding" value={definition.finalGradeConversion.rounding.mode} options={[{ label: 'Nearest', value: 'nearest' }, { label: 'Floor', value: 'floor' }, { label: 'Ceiling', value: 'ceiling' }]} onChange={(mode) => patch({ finalGradeConversion: { ...definition.finalGradeConversion, rounding: { ...definition.finalGradeConversion.rounding, mode } } })} />
        <Field label="Decimal precision" value={String(definition.finalGradeConversion.rounding.precision)} keyboardType="numeric" onChangeText={(value) => patch({ finalGradeConversion: { ...definition.finalGradeConversion, rounding: { ...definition.finalGradeConversion.rounding, precision: Number(value) } } })} />
      </View>
      {definition.finalGradeConversion.passingScale.mode === 'mapping' ? <GradeMappingEditor title="Passing grade mappings" mapping={definition.finalGradeConversion.passingScale.mapping} boundary={definition.finalGradeConversion.passingPercentage} side="above" defaultPoint={definition.finalGradeConversion.passingScale.passingPoint ?? 3} onChange={(mapping) => patch({ finalGradeConversion: { ...definition.finalGradeConversion, passingScale: { ...definition.finalGradeConversion.passingScale, mapping } } })} /> : null}
      {definition.finalGradeConversion.failingScale.mode === 'mapping' ? <GradeMappingEditor title="Failing grade mappings" mapping={definition.finalGradeConversion.failingScale.mapping} boundary={definition.finalGradeConversion.passingPercentage} side="below" defaultPoint={definition.finalGradeConversion.failingScale.firstFailingPoint ?? 3.25} onChange={(mapping) => patch({ finalGradeConversion: { ...definition.finalGradeConversion, failingScale: { ...definition.finalGradeConversion.failingScale, mapping } } })} /> : null}
      <GradeConversionPreview conversion={definition.finalGradeConversion} />
      </AccordionSection>
    </View> : null}
    {section === 'review' ? <View style={panel}>
      <SectionHeading title="Check before saving" helpText="Validate the definition to catch missing references and invalid grade rules." example="Fix every listed issue, then validate again." />
      <Text style={hint}>{definition.assessmentTypes?.length ?? 0} assessment types · {definition.periods?.length ?? 0} periods · {definition.groups?.length ?? 0} groups · {definition.components.length} components.</Text>
      <Button label="Validate grading system" onPress={onValidate} />
      {errors.length ? errors.map((error, index) => <Text key={`${index}-${error}`} style={{ color: colors.danger }}>{error}</Text>) : <Text style={{ color: '#16803C' }}>Run validation before saving or applying this definition.</Text>}
    </View> : null}
    {section !== 'review' ? <View style={stepFooter}>
      {sections.findIndex((item) => item.id === section) > 0 ? <Button label="Back" variant="secondary" onPress={() => setSection(sections[Math.max(0, sections.findIndex((item) => item.id === section) - 1)].id)} /> : <View />}
      <Button label={`Continue: ${sections[sections.findIndex((item) => item.id === section) + 1].label}`} onPress={() => setSection(sections[sections.findIndex((item) => item.id === section) + 1].id)} />
    </View> : <View style={stepFooter}><Button label="Edit grade rules" variant="secondary" onPress={() => setSection('grading')} /><Button label="Back to components" variant="secondary" onPress={() => setSection('components')} /></View>}
  </View>;
}

function AssessmentComponentEditor({ component, index, update, typeIds, groupTypeIds }: { component: AnyRecord; index: number; update: (value: AnyRecord) => void; typeIds: { label: string; value: string }[]; groupTypeIds: { label: string; value: string }[] }) {
  const [section, setSection] = useState<'setup' | 'scoring'>('setup');
  const d = component.assessmentDefinition ?? {};
  const updateDefinition = (values: AnyRecord) => update({ assessmentDefinition: { ...d, ...values } });
  const scoring = d.scoring ?? { mode: 'linear' };
  const aggregation = d.aggregation ?? { mode: 'equal' };
  const mapping: AnyRecord[] = scoring.mapping ?? [];
  const updateMapping = (entries: AnyRecord[]) => updateDefinition({ scoring: { ...scoring, mapping: entries } });
  return <View style={{ gap: 10 }}>
    <View style={subNavigation}>{(['setup', 'scoring'] as const).map((item) => <View key={item} style={row}><Pressable accessibilityRole="tab" accessibilityState={{ selected: section === item }} onPress={() => setSection(item)} style={[subTab, section === item && activeSubTab]}><Text style={[subTabText, section === item && activeSubTabText]}>{item === 'setup' ? 'Assessment setup' : 'Scoring & aggregation'}</Text></Pressable><HelpTooltip title={item === 'setup' ? 'Assessment setup' : 'Scoring & aggregation'} text={item === 'setup' ? 'Choose the assessment type, score range, count limits, and where those limits apply.' : 'Choose how assessment scores convert to percentages and how multiple results are combined.'} example={item === 'setup' ? 'Quiz · Max score 20 · Count 3–5 per period' : '18/20 → 90%; equal aggregation combines it with other scores.'} /></View>)}</View>
    {section === 'setup' ? <>
    <SelectField label="Assessment type" value={d.typeId ?? ''} options={typeIds} onChange={(typeId) => updateDefinition({ typeId })} />
    <View style={row}>
      <Field label="Minimum count" value={d.count?.min == null ? '' : String(d.count.min)} keyboardType="numeric" onChangeText={(value) => updateDefinition({ count: { ...(d.count ?? {}), min: value === '' ? undefined : Number(value) } })} containerStyle={{ flex: 1, minWidth: 120 }} />
      <Field label="Maximum count" value={d.count?.max == null ? '' : String(d.count.max)} keyboardType="numeric" onChangeText={(value) => updateDefinition({ count: { ...(d.count ?? {}), max: value === '' ? undefined : Number(value) } })} containerStyle={{ flex: 1, minWidth: 120 }} />
      <Field label="Maximum score" value={String(d.maxScore ?? 100)} keyboardType="numeric" onChangeText={(value) => updateDefinition({ maxScore: Number(value) })} containerStyle={{ flex: 1, minWidth: 120 }} />
    </View>
    <SelectField label="Count applies" value={d.count?.scope?.type ?? 'overall'} options={[{ label: 'Overall', value: 'overall' }, { label: 'Per period', value: 'per_period' }, { label: 'Per group type', value: 'per_group' }]} onChange={(type) => updateDefinition({ count: { ...(d.count ?? {}), scope: type === 'per_group' ? { type, groupTypeId: d.count?.scope?.groupTypeId ?? '' } : { type } } })} />
    {d.count?.scope?.type === 'per_group' ? <SelectField label="Group type" value={d.count.scope.groupTypeId ?? ''} options={groupTypeIds} onChange={(groupTypeId) => updateDefinition({ count: { ...d.count, scope: { ...d.count.scope, groupTypeId } } })} /> : null}
    </> : null}
    {section === 'scoring' ? <>
    <View style={row}>
      <SelectField label="Scoring" value={scoring.mode} options={[{ label: 'Linear', value: 'linear' }, { label: 'Numeric mapping', value: 'numeric_mapping' }, { label: 'Value mapping', value: 'value_mapping' }]} onChange={(mode) => updateDefinition({ scoring: mode === 'linear' ? { mode } : { mode, mapping: [] } })} containerStyle={{ flex: 1, minWidth: 160 }} />
      <SelectField label="Aggregation" value={aggregation.mode} options={[{ label: 'Equal', value: 'equal' }, { label: 'Points', value: 'points' }, { label: 'Weighted instances', value: 'weighted' }]} onChange={(mode) => updateDefinition({ aggregation: { mode } })} containerStyle={{ flex: 1, minWidth: 160 }} />
    </View>
    {scoring.mode !== 'linear' ? <View style={{ gap: 8 }}>
      <Text style={hint}>Score mapping</Text>
      {mapping.map((entry, mappingIndex) => <View key={`${component.id}-${index}-map-${mappingIndex}`} style={row}>
        <Field label="Input value" value={String(entry.value ?? '')} onChangeText={(value) => updateMapping(mapping.map((item, i) => i === mappingIndex ? { ...item, value: scoring.mode === 'numeric_mapping' ? Number(value) : value } : item))} containerStyle={{ flex: 1 }} />
        <Field label="Percentage" value={String(entry.percentage ?? '')} keyboardType="numeric" onChangeText={(value) => updateMapping(mapping.map((item, i) => i === mappingIndex ? { ...item, percentage: Number(value) } : item))} containerStyle={{ flex: 1 }} />
        <Button label="Remove" variant="danger" onPress={() => updateMapping(mapping.filter((_, i) => i !== mappingIndex))} />
      </View>)}
      <Button label="Add mapping" variant="secondary" onPress={() => updateMapping([...mapping, { value: scoring.mode === 'numeric_mapping' ? 0 : '', percentage: 0 }])} />
    </View> : null}
    </> : null}
  </View>;
}

function GradeMappingEditor({ title, mapping, boundary, side, defaultPoint, onChange }: { title: string; mapping: AnyRecord[]; boundary: number; side: 'above' | 'below'; defaultPoint: number; onChange: (mapping: AnyRecord[]) => void }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const updateNumber = (index: number, key: 'minimumPercentage' | 'point', value: string) => {
    const draftKey = `${index}:${key}`;
    setDrafts((current) => ({ ...current, [draftKey]: value }));
    if (value.trim() === '' || !/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return;
    const number = Number(value);
    if (!Number.isFinite(number)) return;
    onChange(mapping.map((entry, i) => i === index ? { ...entry, [key]: number } : entry));
  };
  const sorted = mapping.map((entry, index) => ({ entry, index })).sort((a, b) => b.entry.minimumPercentage - a.entry.minimumPercentage);
  return <View style={mappingPanel}>
    <SectionHeading title={title} helpText="Each row applies at its minimum percentage and remains active until a higher threshold is reached." example="Minimum 75% → point grade 3.25; minimum 70% → point grade 3.5." />
    <View style={mappingTableHeader}><Text style={[mappingTableHeading, { flex: 1 }]}>Point grade</Text><Text style={[mappingTableHeading, { flex: 1 }]}>Percentage range</Text><Text style={[mappingTableHeading, { flex: 1 }]}>Letter (optional)</Text><View style={{ width: 66 }} /></View>
    {sorted.map(({ entry, index }) => <View key={`grade-map-${index}`} style={mappingTableRow}>
      <Field label="Point grade" value={drafts[`${index}:point`] ?? String(entry.point ?? '')} keyboardType="decimal-pad" onChangeText={(value) => updateNumber(index, 'point', value)} containerStyle={{ flex: 1, minWidth: 90 }} />
      <View style={{ flex: 1, minWidth: 130, gap: 4 }}><Text style={hint}>Range</Text><Text style={previewCell}>{entry.minimumPercentage}%–{side === 'above' ? (sorted[sorted.findIndex((item) => item.index === index) - 1]?.entry.minimumPercentage ?? 100) : `<${sorted[sorted.findIndex((item) => item.index === index) - 1]?.entry.minimumPercentage ?? boundary}`}%</Text><Field label="Minimum percentage" value={drafts[`${index}:minimumPercentage`] ?? String(entry.minimumPercentage ?? '')} keyboardType="decimal-pad" onChangeText={(value) => updateNumber(index, 'minimumPercentage', value)} /></View>
      <Field label="Letter grade" value={entry.letter ?? ''} onChangeText={(letter) => onChange(mapping.map((item, i) => { if (i !== index) return item; const next = { ...item }; if (letter.trim()) next.letter = letter; else delete next.letter; return next; }))} containerStyle={{ flex: 1, minWidth: 90 }} />
      <Button label="Remove" variant="danger" disabled={mapping.length <= 1} onPress={() => { onChange(mapping.filter((_, i) => i !== index)); setDrafts({}); }} />
    </View>)}
    <Button label="Add grade mapping" variant="secondary" onPress={() => onChange([...mapping, { minimumPercentage: Math.max(0, Math.min(100, boundary + (side === 'above' ? 1 : -1) * 5 * (mapping.length + 1))), point: defaultPoint }])} />
  </View>;
}

function GradeConversionPreview({ conversion }: { conversion: AnyRecord }) {
  const round = (point: number) => { const factor = 10 ** conversion.rounding.precision; return conversion.rounding.mode === 'floor' ? Math.floor(point * factor) / factor : conversion.rounding.mode === 'ceiling' ? Math.ceil(point * factor) / factor : Math.round(point * factor) / factor; };
  const rows: { key: string; point: number; range: string; letter: string; section: string }[] = [];
  const addScale = (scale: AnyRecord, passing: boolean) => {
    if (scale.mode === 'mapping') {
      const sorted = [...(scale.mapping ?? [])].sort((a: AnyRecord, b: AnyRecord) => b.minimumPercentage - a.minimumPercentage);
      sorted.forEach((entry: AnyRecord, index) => {
        const upper = sorted[index - 1]?.minimumPercentage ?? (passing ? scale.maximumPercentage ?? 100 : conversion.passingPercentage);
        rows.push({ key: `${passing ? 'p' : 'f'}-${entry.minimumPercentage}-${index}`, point: entry.point, range: passing ? `${entry.minimumPercentage}%–${upper}%` : `${entry.minimumPercentage}%–<${upper}%`, letter: entry.letter ?? '', section: passing ? 'Passing' : 'Failing' });
      });
      return;
    }
    const low = passing ? scale.bestPoint : scale.firstFailingPoint;
    const high = passing ? scale.passingPoint : scale.worstPoint;
    const interval = Math.max(Number(scale.pointInterval) || 1, Number.EPSILON);
    const steps = Math.max(1, Math.ceil(Math.abs(high - low) / interval));
    const count = steps + 1;
    const pctLow = passing ? conversion.passingPercentage : scale.minimumPercentage;
    const pctHigh = passing ? scale.maximumPercentage : conversion.passingPercentage;
    for (let i = 0; i < count; i++) {
      const point = low + (high - low) * i / steps;
      // For both scales, the first configured point is the best edge nearest
      // the pass boundary (or maximum percentage); subsequent points descend.
      const start = pctHigh - (pctHigh - pctLow) * (i + 1) / count;
      const end = pctHigh - (pctHigh - pctLow) * i / count;
      rows.push({ key: `${passing ? 'p' : 'f'}-${i}`, point: round(point), range: passing ? `${start.toFixed(1)}%–${end.toFixed(1)}%` : `${start.toFixed(1)}%–<${end.toFixed(1)}%`, letter: '', section: passing ? 'Passing' : 'Failing' });
    }
  };
  addScale(conversion.passingScale, true);
  addScale(conversion.failingScale, false);
  return <View style={mappingPanel}>
    <SectionHeading title="Percentage to point grade preview" helpText="Each row shows the percentage range that maps to its point grade. The upper bound is exclusive when shown with <." example="Point grade 1.0: 90–100%; point grade 2.0: 80–<90%." />
    <Text style={hint}>Ranges update from the current passing threshold, mappings, interval settings, and rounding.</Text>
    <View style={previewTableHeader}><Text style={[previewHeader, { flex: 1 }]}>Point grade</Text><Text style={[previewHeader, { flex: 1.5 }]}>Percentage range</Text><Text style={[previewHeader, { flex: 1 }]}>Letter grade</Text></View>
    {rows.map((item) => <View key={`preview-${item.key}`} style={previewTableRow}><Text style={[previewCell, { flex: 1 }]}>{item.point.toFixed(conversion.rounding.precision)}</Text><Text style={[previewCell, { flex: 1.5 }]}>{item.range}</Text><Text style={[previewCell, { flex: 1 }]}>{item.letter || '—'}</Text></View>)}
  </View>;
}

function WeightedComponentEditor({ component, update, componentIds, periods }: { component: AnyRecord; index: number; update: (value: AnyRecord) => void; componentIds: { label: string; value: string }[]; periods: AnyRecord[] }) {
  const [weightDrafts, setWeightDrafts] = useState<Record<string, string>>({});
  const calculation = component.calculation;
  const refs: AnyRecord[] = calculation.components ?? [];
  const setRefs = (next: AnyRecord[]) => update({ calculation: { ...calculation, components: next } });
  return <View style={{ gap: 10 }}>
    <SelectField label="Weight mode" value={calculation.weightMode ?? 'relative'} options={[{ label: 'Relative', value: 'relative' }, { label: 'Absolute contributions', value: 'absolute' }]} onChange={(weightMode) => update({ calculation: { ...calculation, weightMode } })} />
    {refs.map((ref, refIndex) => <View key={`${component.id}-ref-${refIndex}`} style={row}>
      <SelectField label="Component" value={ref.componentId} options={componentIds.filter((item) => item.value !== component.id)} onChange={(componentId) => setRefs(refs.map((item, i) => i === refIndex ? { ...item, source: 'component', componentId } : item))} containerStyle={{ flex: 2, minWidth: 170 }} />
      <Field label="Weight (decimal or n/d)" value={weightDrafts[`${component.id}:${refIndex}`] ?? (typeof ref.weight === 'number' ? String(ref.weight) : ref.weight?.numerator != null ? `${ref.weight.numerator}/${ref.weight.denominator}` : '')} onChangeText={(value) => {
        const key = `${component.id}:${refIndex}`;
        setWeightDrafts((drafts) => ({ ...drafts, [key]: value }));
        const fraction = value.match(/^\s*(\d+)\s*\/\s*(\d+)\s*$/);
        const decimal = value.trim() !== '' && /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim());
        if (fraction && Number(fraction[2]) !== 0) setRefs(refs.map((item, i) => i === refIndex ? { ...item, weight: { numerator: Number(fraction[1]), denominator: Number(fraction[2]) } } : item));
        else if (decimal) setRefs(refs.map((item, i) => i === refIndex ? { ...item, weight: Number(value) } : item));
      }} containerStyle={{ flex: 1, minWidth: 120 }} />
      <SelectField label="Period scope" value={ref.periodId ?? ''} options={[{ label: 'All periods', value: '' }, ...periods.map((period) => ({ label: period.name, value: period.id }))]} onChange={(periodId) => setRefs(refs.map((item, i) => i === refIndex ? { ...item, ...(periodId ? { periodId } : { periodId: undefined }) } : item))} />
      <Button label="Remove" variant="danger" onPress={() => setRefs(refs.filter((_, i) => i !== refIndex))} />
    </View>)}
    <Button label="Add weighted component" variant="secondary" onPress={() => { const target = componentIds.find((item) => item.value !== component.id); if (target) setRefs([...refs, { source: 'component', componentId: target.value, weight: 1 }]); }} />
    <Text style={hint}>Conditional weighting rules and period-specific formula details can be edited in the JSON panel below.</Text>
  </View>;
}

function AccordionSection({ title, summary, helpText, example, open, onToggle, children }: { title: string; summary: string; helpText: string; example: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return <View style={listItem}>
    <View style={row}>
      <Pressable onPress={onToggle} accessibilityRole="button" accessibilityState={{ expanded: open }} style={[row, { flex: 1 }]}>
        <View style={{ flex: 1, gap: 3 }}><Text style={itemHeading}>{title}</Text><Text style={hint}>{summary}</Text></View>
        <Text style={{ color: colors.brand, fontWeight: '600' }}>{open ? 'Hide' : 'Edit'}</Text>
      </Pressable>
      <HelpTooltip title={title} text={helpText} example={example} />
    </View>
    {open ? <View style={{ gap: 10 }}>{children}</View> : null}
  </View>;
}

function SectionHeading({ title, helpText, example }: { title: string; helpText: string; example: string }) {
  return <View style={[row, { justifyContent: 'space-between' }]}>
    <Text style={heading}>{title}</Text>
    <HelpTooltip title={title} text={helpText} example={example} />
  </View>;
}

const heading = { fontSize: 16, fontWeight: '700' as const, color: colors.text };
const hint = { color: colors.textMuted, fontSize: 12 };
const componentPanel = { ...panel, marginBottom: 12 };
const listItem = { borderWidth: 1, borderColor: '#E3E7EE', borderRadius: 10, padding: 10, gap: 10, marginBottom: 8 } as const;
const mappingPanel = { borderWidth: 1, borderColor: '#DCE3ED', borderRadius: 10, padding: 12, gap: 8, backgroundColor: '#FBFCFE' } as const;
const mappingTableHeader = { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8, paddingVertical: 7, borderRadius: 7, backgroundColor: '#EEF2F7' } as const;
const mappingTableHeading = { color: colors.textMuted, fontSize: 11, fontWeight: '700' as const };
const mappingTableRow = { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', gap: 8, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: '#E3E7EE' } as const;
const previewTableHeader = { flexDirection: 'row', gap: 8, padding: 8, backgroundColor: '#EEF2F7', borderRadius: 7 } as const;
const previewHeader = { color: colors.textMuted, fontSize: 11, fontWeight: '700' as const };
const previewTableRow = { flexDirection: 'row', gap: 8, paddingHorizontal: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#E3E7EE' } as const;
const previewCell = { color: colors.text, fontSize: 12 };
const rootDropZone = { borderWidth: 1, borderStyle: 'dashed', borderColor: '#B8C4D5', borderRadius: 10, padding: 10, marginVertical: 8, backgroundColor: '#F8FAFC' } as const;
function getDropStyle(base: AnyRecord, dragged: boolean, position: 'before' | 'inside' | 'after' | null) {
  const { borderColor, borderTopColor, borderRightColor, borderBottomColor, borderLeftColor, ...baseWithoutBorderColors } = base;
  const normalized = {
    ...baseWithoutBorderColors,
    borderTopColor: borderTopColor ?? borderColor,
    borderRightColor: borderRightColor ?? borderColor,
    borderBottomColor: borderBottomColor ?? borderColor,
    borderLeftColor: borderLeftColor ?? borderColor,
  };
  if (position === 'before') return { ...normalized, borderTopWidth: 4, borderTopColor: colors.brand, backgroundColor: '#F3F6FF' };
  if (position === 'after') return { ...normalized, borderBottomWidth: 4, borderBottomColor: colors.brand, backgroundColor: '#F3F6FF' };
  if (position === 'inside') return { ...normalized, borderWidth: 2, borderTopColor: colors.brand, borderRightColor: colors.brand, borderBottomColor: colors.brand, borderLeftColor: colors.brand, backgroundColor: '#EAF1FF' };
  return dragged ? { ...normalized, opacity: 0.5 } : normalized;
}
const itemHeading = { color: colors.text, fontSize: 14, fontWeight: '600' as const };
const groupChip = { borderWidth: 1, borderColor: '#D5DCE7', borderRadius: 16, paddingVertical: 5, paddingHorizontal: 9 };
const activeGroupChip = { backgroundColor: colors.brand, borderColor: colors.brand };
const stepNavigation = { flexDirection: 'row', flexWrap: 'wrap', gap: 6 } as const;
const stepButton = { paddingVertical: 8, paddingHorizontal: 10, borderRadius: 18, borderWidth: 1, borderColor: '#D5DCE7', backgroundColor: '#FFFFFF' };
const activeStepButton = { backgroundColor: colors.brand, borderColor: colors.brand };
const stepButtonText = { color: colors.textMuted, fontSize: 12, fontWeight: '600' as const };
const activeStepText = { color: '#FFFFFF' };
const subNavigation = { flexDirection: 'row', flexWrap: 'wrap', gap: 6 } as const;
const subTab = { paddingVertical: 7, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: '#D5DCE7', backgroundColor: '#FFFFFF' };
const activeSubTab = { backgroundColor: '#EFF4FF', borderColor: colors.brand };
const subTabText = { color: colors.textMuted, fontSize: 12, fontWeight: '600' as const };
const activeSubTabText = { color: colors.brand };
const stepFooter = { flexDirection: 'row', justifyContent: 'space-between', gap: 8, paddingTop: 4 } as const;
