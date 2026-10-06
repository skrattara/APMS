import { Button, Field, HelpTooltip, SelectField } from '@/components/ui';
import { DEFAULT_EVALUATION_SYSTEM, type EvaluationDefinition } from '@apms/domain';
import type { GradingDefinition } from '@apms/domain';
import { colors } from '@/theme/tokens';
import { useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';

const newId = () => globalThis.crypto?.randomUUID?.() ?? 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => { const value = Math.floor(Math.random() * 16); return (char === 'x' ? value : (value & 3) | 8).toString(16); });
const factorSources = [
  ['current_standing', 'Current standing'], ['attendance_rate', 'Attendance rate'],
  ['recent_scores', 'Recent scores'], ['recent_score_average', 'Recent score average'], ['recent_trend', 'Recent trend'],
  ['missing_assessment_count', 'Missing assessments'], ['grading_component', 'Grading component'], ['grading_group', 'Grading group'], ['predicted_standing', 'AI predicted standing'],
  ['risk_probability', 'AI risk probability'], ['ai_risk_level', 'AI risk level'], ['trend', 'AI trend'],
  ['model_confidence', 'Model confidence (when available)'], ['prediction_available', 'Prediction available'], ['prediction_age_hours', 'Prediction age (hours)'], ['ai_factor_count', 'AI explanation factor count'], ['data_basis', 'AI data basis'],
] as const;
const sourceHelp: Record<string, { helpText: string; helpExample: string }> = {
  current_standing: { helpText: 'The student’s current calculated overall standing.', helpExample: 'A current standing of 68% can match a rule for values below 70%.' },
  attendance_rate: { helpText: 'The share of recorded attendance sessions attended, counting late attendance as half.', helpExample: '8 attended sessions out of 10 is 80%.' },
  recent_scores: { helpText: 'The most recent assessment percentages as a list. Use contains rules to check for a particular score.', helpExample: 'Recent scores: [78, 84, 91].' },
  recent_score_average: { helpText: 'The mean percentage across the selected number of recent assessment scores.', helpExample: 'Scores 70, 80, and 90 produce an average of 80%.' },
  recent_trend: { helpText: 'A trend derived from the selected window of recent scores.', helpExample: 'Consistently increasing scores produce an improving trend.' },
  missing_assessment_count: { helpText: 'The count of assessments without a recorded score.', helpExample: 'Three unscored assessments produce a count of 3.' },
  grading_component: { helpText: 'A calculated percentage from one component in the class grading system.', helpExample: 'Select Mastery Grade or Project Grade to evaluate that component.' },
  grading_group: { helpText: 'The weighted mean percentage of scored assessments assigned to this group and its child groups.', helpExample: 'Select Module 2 to evaluate scores recorded in that module.' },
  predicted_standing: { helpText: 'The advisory standing produced by the latest available prediction.', helpExample: 'An estimated standing of 74%.' },
  risk_probability: { helpText: 'The saved AI risk probability. APMS currently treats this as a heuristic, not a calibrated probability.', helpExample: 'A value of 0.7 means the model reported 70% risk probability.' },
  ai_risk_level: { helpText: 'The low, medium, or high risk label from the saved AI prediction.', helpExample: 'Use equals high to match a high model risk label.' },
  trend: { helpText: 'The improving, stable, or declining trend label from the saved AI prediction.', helpExample: 'Use equals declining to match a declining prediction trend.' },
  model_confidence: { helpText: 'Confidence associated with the available prediction, when supplied by the model.', helpExample: 'Use a minimum threshold to ignore lower-confidence prediction signals.' },
  prediction_available: { helpText: 'Whether a prediction is available for the student.', helpExample: 'Is false when no prediction has been saved.' },
  prediction_age_hours: { helpText: 'Elapsed hours since the latest prediction was generated.', helpExample: 'A prediction generated 12 hours ago has an age of 12.' },
  ai_factor_count: { helpText: 'The number of explanatory factors returned with the AI prediction.', helpExample: 'Four returned factors produce a count of 4.' },
  data_basis: { helpText: 'A category describing the data basis used for the AI prediction.', helpExample: 'Match a particular saved data basis label.' },
};
const categorySources = new Set<string>(['recent_trend', 'ai_risk_level', 'trend', 'data_basis']);
const booleanSources = new Set<string>(['prediction_available']);
const numericSources = new Set<string>(factorSources.map(([value]) => value).filter((value) => !categorySources.has(value) && !booleanSources.has(value)));
function spectrumColor(index: number, count: number, scheme: 'green_to_red' | 'white_to_red') {
  const position = count <= 1 ? 1 : index / (count - 1);
  if (scheme === 'white_to_red') {
    const channel = Math.round(255 * (1 - position)).toString(16).padStart(2, '0');
    return `#FF${channel}${channel}`.toUpperCase();
  }
  const hue = 120 * (1 - position);
  const saturation = 0.72; const lightness = 0.46;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs((hue / 60) % 2 - 1)); const match = lightness - chroma / 2;
  const [r, g, b] = hue < 60 ? [chroma, x, 0] : hue < 120 ? [x, chroma, 0] : hue < 180 ? [0, chroma, x] : hue < 240 ? [0, x, chroma] : hue < 300 ? [x, 0, chroma] : [chroma, 0, x];
  return `#${[r, g, b].map((value) => Math.round((value + match) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}
function applyColorScheme(levels: EvaluationDefinition['levels'], scheme: 'green_to_red' | 'white_to_red' | 'custom') {
  if (scheme === 'custom') return levels;
  const rank = { low: 0, medium: 1, high: 2 };
  const ordered = [...levels].sort((a, b) => rank[a.severity] - rank[b.severity] || a.priority - b.priority);
  const colorById = new Map(ordered.map((level, index) => [level.id, spectrumColor(index, ordered.length, scheme)]));
  return levels.map((level) => ({ ...level, color: colorById.get(level.id) }));
}
const operatorOptionsFor = (source?: string) => categorySources.has(String(source))
  ? [{ label: 'Equals', value: 'equals' }, { label: 'Does not equal', value: 'not_equals' }, { label: 'Is one of', value: 'in' }, { label: 'Is not one of', value: 'not_in' }, { label: 'Is available', value: 'is_available' }, { label: 'Is unavailable', value: 'is_unavailable' }]
  : booleanSources.has(String(source))
    ? [{ label: 'Is true', value: 'is_true' }, { label: 'Is false', value: 'is_false' }, { label: 'Is available', value: 'is_available' }, { label: 'Is unavailable', value: 'is_unavailable' }]
    : source === 'recent_scores'
      ? [{ label: 'Contains score', value: 'contains' }, { label: 'Does not contain score', value: 'not_contains' }, { label: 'Is available', value: 'is_available' }, { label: 'Is unavailable', value: 'is_unavailable' }]
      : [{ label: 'Below', value: 'below' }, { label: 'At most', value: 'at_most' }, { label: 'Above', value: 'above' }, { label: 'At least', value: 'at_least' }, { label: 'Is available', value: 'is_available' }, { label: 'Is unavailable', value: 'is_unavailable' }];

export function EvaluationSystemBuilderForm({ definition, onChange, gradingSystem, gradingSystems }: { definition: EvaluationDefinition; onChange: (value: EvaluationDefinition) => void; gradingSystem?: GradingDefinition; gradingSystems?: GradingDefinition[] }) {
  const [step, setStep] = useState<'factors' | 'rules'>('factors');
  const [openLevelId, setOpenLevelId] = useState<string | null>(definition.levels[0]?.id ?? null);
  const [editingFactorNames, setEditingFactorNames] = useState(false);
  const [colorPickerLevelId, setColorPickerLevelId] = useState<string | null>(null);
  const systems = gradingSystems?.length ? gradingSystems : gradingSystem ? [gradingSystem] : [];
  const componentOptions = Array.from(new Map<string, { label: string; value: string }>(systems.flatMap((system) => system.components.map((component: any) => [component.id, { label: component.name ?? component.id, value: component.id }] as [string, { label: string; value: string }]))).values());
  const groupOptions = Array.from(new Map<string, { label: string; value: string }>(systems.flatMap((system) => (system.groups ?? []).map((group: any) => [group.id, { label: group.name ?? group.label ?? group.id, value: group.id }] as [string, { label: string; value: string }]))).values());
  const patchLevel = (index: number, patch: Partial<EvaluationDefinition['levels'][number]>) => {
    const levels = definition.levels.map((level, i) => i === index ? { ...level, ...patch } : level);
    const scheme = definition.classification?.colorScheme ?? 'custom';
    onChange({ ...definition, levels: patch.severity && scheme !== 'custom' ? applyColorScheme(levels, scheme) : levels, ...(patch.color ? { classification: { ...definition.classification, colorScheme: 'custom' } } : {}) });
  };
  const orderedLevels = [...definition.levels].sort((a, b) => b.priority - a.priority);
  const addFactor = () => onChange({ ...definition, factors: [...definition.factors, { id: newId(), name: 'New factor', source: 'current_standing' }] });
  const addLevel = () => {
    const level = { id: newId(), name: 'New risk level', severity: 'medium' as const, color: '#D97706', priority: Math.max(0, ...definition.levels.map((item) => item.priority)) + 10, match: 'any' as const, rules: [] };
    const levels = [...definition.levels, level]; setOpenLevelId(level.id);
    const scheme = definition.classification?.colorScheme ?? 'custom';
    onChange({ ...definition, levels: applyColorScheme(levels, scheme) });
  };
  return <View style={{ gap: 16 }}>
    <Field label="Evaluation system name" value={definition.name} onChangeText={(name) => onChange({ ...definition, name })} helpText="The name shown to academic admins when they review this evaluation system." helpExample="Department Student Risk Evaluation" />
    <Field label="Description" value={definition.description ?? ''} onChangeText={(description) => onChange({ ...definition, description })} multiline helpText="Summarize what this evaluation system monitors and how its results should be used." helpExample="Advisory monitoring based on current standing, attendance, and recent results." />
    <View accessibilityRole="tablist" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
      {([{ id: 'factors', label: 'Evaluation factors' }, { id: 'rules', label: 'Risk levels and rules' }] as const).map((item, index) => <Pressable key={item.id} accessibilityRole="tab" accessibilityState={{ selected: step === item.id }} onPress={() => setStep(item.id)} style={{ paddingVertical: 8, paddingHorizontal: 10, borderRadius: 18, borderWidth: 1, borderColor: step === item.id ? colors.brand : '#D5DCE7', backgroundColor: step === item.id ? colors.brand : '#FFFFFF' }}><Text style={{ color: step === item.id ? '#FFFFFF' : colors.textMuted, fontSize: 12, fontWeight: '600' }}>{index + 1}. {item.label}</Text></Pressable>)}
    </View>
    <Text style={{ color: colors.textMuted, fontSize: 12 }}>{step === 'factors' ? 'Evaluation factors · Step 1 of 2' : 'Risk levels and rules · Step 2 of 2'}</Text>
    {step === 'factors' ? <>
    <View style={{ gap: 8 }}><View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}><View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><View><Text style={{ fontWeight: '700' }}>Evaluation factors</Text><Text style={{ color: '#64748B', fontSize: 12 }}>Choose the measures that influence evaluation. In weighted mode, each factor's weight contributes to matching risk levels.</Text></View><HelpTooltip title="Evaluation factors" text="Factors are the data inputs used by risk rules. A rule refers to a factor and compares its value with a condition or threshold." example="Current standing below 70% can match High Risk." /></View><Button label={editingFactorNames ? 'Done editing names' : 'Edit factor names'} variant="secondary" onPress={() => setEditingFactorNames((value) => !value)} /></View>
      {definition.factors.map((factor, index) => <View key={factor.id} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }}>
        {editingFactorNames ? <Field label="Factor name" value={factor.name} onChangeText={(name) => onChange({ ...definition, factors: definition.factors.map((item, i) => i === index ? { ...item, name } : item) })} containerStyle={{ flex: 1, minWidth: 180 }} helpText="A short display name used for this data factor throughout the rule editor." helpExample="Recent score average" /> : null}
        <SelectField label="Data source" value={factor.source} options={factorSources.map(([value, label]) => ({ label, value, ...sourceHelp[value] }))} onChange={(source) => onChange({ ...definition, factors: definition.factors.map((item, i) => i === index ? { ...item, source: source as typeof item.source, valueType: categorySources.has(source) ? 'category' : booleanSources.has(source) ? 'boolean' : source === 'recent_scores' ? 'number_array' : 'number', origin: source.startsWith('ai_') || source === 'predicted_standing' || source === 'risk_probability' || source === 'trend' || source === 'model_confidence' || source === 'data_basis' ? 'ai_prediction' : 'derived', aiGenerated: source.startsWith('ai_') || ['predicted_standing', 'risk_probability', 'trend', 'model_confidence', 'data_basis'].includes(source), gradingAggregation: source === 'grading_component' || source === 'grading_group' ? item.gradingAggregation ?? 'average' : item.gradingAggregation, windowSize: ['recent_scores', 'recent_score_average', 'recent_trend'].includes(source) ? item.windowSize ?? 5 : item.windowSize } : item) })} containerStyle={{ flex: 1, minWidth: 180 }} helpText="Choose the student data this factor reads." helpExample="Recent score average calculates a mean from the most recent scores." />
        {factor.source === 'grading_component' ? <SelectField label="Grade component" value={factor.gradingComponentId ?? ''} options={componentOptions} onChange={(gradingComponentId) => onChange({ ...definition, factors: definition.factors.map((item, i) => i === index ? { ...item, gradingComponentId } : item) })} containerStyle={{ flex: 1, minWidth: 180 }} helpText="Select a calculated component from the active grading definition." helpExample="Mastery Grade · Project Grade" /> : null}
        {factor.source === 'grading_group' ? <SelectField label="Grade group" value={factor.gradingGroupId ?? ''} options={groupOptions} onChange={(gradingGroupId) => onChange({ ...definition, factors: definition.factors.map((item, i) => i === index ? { ...item, gradingGroupId } : item) })} containerStyle={{ flex: 1, minWidth: 180 }} helpText="Select an assessment group. Child groups are included in the group percentage." helpExample="Module 2 includes its directly assigned assessments and nested groups." /> : null}
        {factor.source === 'grading_component' || factor.source === 'grading_group' ? <SelectField label="Summarize scores using" value={factor.gradingAggregation ?? 'average'} options={[{ label: 'Average', value: 'average', helpText: 'Use the arithmetic mean of the matching assessment percentages.' }, { label: 'Highest', value: 'highest', helpText: 'Use the highest matching assessment percentage.' }, { label: 'Lowest', value: 'lowest', helpText: 'Use the lowest matching assessment percentage.' }]} onChange={(gradingAggregation) => onChange({ ...definition, factors: definition.factors.map((item, i) => i === index ? { ...item, gradingAggregation: gradingAggregation as 'average' | 'highest' | 'lowest' } : item) })} containerStyle={{ width: 180 }} helpText="Choose how scores for the selected grade component or group are summarized." helpExample="Scores 65%, 80%, and 95% produce Average 80%, Highest 95%, or Lowest 65%." /> : null}
        {['recent_scores', 'recent_score_average', 'recent_trend'].includes(factor.source) ? <Field label="Recent window" value={String(factor.windowSize ?? 5)} keyboardType="numeric" onChangeText={(value) => onChange({ ...definition, factors: definition.factors.map((item, i) => i === index ? { ...item, windowSize: Math.min(50, Math.max(1, Number(value) || 1)) } : item) })} containerStyle={{ width: 120 }} helpText="How many most recent assessment records are included in this factor." helpExample="A recent window of 5 uses the five latest scores to calculate the recent score average or trend." /> : null}
        <Field label="Factor weight" value={String(factor.weight ?? 1)} keyboardType="decimal-pad" onChangeText={(value) => onChange({ ...definition, factors: definition.factors.map((item, i) => i === index ? { ...item, weight: value === '' ? undefined : Math.max(0, Math.min(100, Number(value) || 0)) } : item) })} containerStyle={{ width: 110 }} helpText="Relative influence in weighted evaluation mode. Set to 0 to exclude this factor from the weighted score." />
        <Button label="Remove" variant="ghost" disabled={definition.factors.length <= 1} onPress={() => onChange({
          ...definition,
          factors: definition.factors.filter((item) => item.id !== factor.id),
          levels: definition.levels.map((level) => ({ ...level, rules: level.rules.filter((rule) => rule.factorId !== factor.id) })),
        })} />
      </View>)}
      <Button label="Add factor" variant="secondary" onPress={addFactor} />
    </View>
    <Button label="Continue to risk levels and rules →" onPress={() => setStep('rules')} />
    </> : <>
    <View style={{ gap: 10 }}><View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}><View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><View><Text style={{ fontWeight: '700' }}>Risk levels and rules</Text><Text style={{ color: '#64748B', fontSize: 12 }}>Choose priority matching or weighted matching. Colors label each severity band in risk views.</Text></View><HelpTooltip title="Risk levels and rules" text="Each risk level has a severity, priority, and conditions. The highest-priority matching level wins in priority mode; weighted mode selects the level with the largest sum of matched factor weights." example="Current standing below 70% OR attendance below 70% can match High Risk." /></View><Button label="Add risk level" variant="secondary" onPress={addLevel} /></View>
      <SelectField label="Evaluation method" value={definition.classification?.strategy ?? 'priority'} options={[{ label: 'Priority rules', value: 'priority', helpText: 'Use the first matching risk level in priority order.', helpExample: 'High Risk is checked before Medium Risk.' }, { label: 'Weighted factor score', value: 'weighted', helpText: 'Add the weights of matched factors for each level and select the highest total.', helpExample: 'A matched factor weighted 4 contributes twice as much as a matched factor weighted 2.' }]} onChange={(strategy) => onChange({ ...definition, classification: { ...definition.classification, strategy: strategy as 'priority' | 'weighted' } })} helpText="Choose how matching risk levels are selected." helpExample="Priority rules use order; weighted scoring compares the total weights of matching factors." />
      <SelectField label="Color spectrum" value={definition.classification?.colorScheme ?? 'custom'} options={[{ label: 'Green (Low Risk) to Red (High Risk)', value: 'green_to_red', helpText: 'Assigns a continuous spectrum across all levels from green at Low Risk to red at High Risk.', helpExample: 'Three levels receive green, yellow, and red.' }, { label: 'White (Low Risk) to Red (High Risk)', value: 'white_to_red', helpText: 'Assigns a continuous spectrum across all levels from white at Low Risk to red at High Risk.', helpExample: 'Three levels receive white, pink, and red.' }, { label: 'Custom colors by level', value: 'custom', helpText: 'Keep independently selected colors for each risk level.', helpExample: 'Choose a color circle on each risk level to set its color.' }]} onChange={(value) => { const colorScheme = value as 'green_to_red' | 'white_to_red' | 'custom'; onChange({ ...definition, classification: { ...definition.classification, colorScheme }, levels: applyColorScheme(definition.levels, colorScheme) }); }} helpText="Applies one continuous color spectrum across every risk level, ordered from Low to High severity. Choosing a spectrum updates all level colors together." helpExample="With three levels, Green to Red assigns green → yellow → red. White to Red assigns white → pink → red." />
      <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}><Button label={openLevelId === '__all__' ? 'Collapse all levels' : 'Expand all levels'} variant="secondary" onPress={() => setOpenLevelId(openLevelId === '__all__' ? null : '__all__')} /></View>
      {orderedLevels.map((level, levelIndex) => {
        const index = definition.levels.findIndex((item) => item.id === level.id);
        const expanded = openLevelId === '__all__' || openLevelId === level.id;
        return <View key={level.id} style={{ padding: 12, borderWidth: 1, borderColor: level.color ?? '#DCE3EC', backgroundColor: level.color ? `${level.color}18` : '#F8FAFC', borderRadius: 8, gap: 8 }}>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setOpenLevelId(expanded && openLevelId !== '__all__' ? null : level.id)} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: level.color ?? '#94A3B8' }} /><Text style={{ flex: 1, fontWeight: '700' }}>{level.name} · {level.severity.toUpperCase()} · {level.rules.length} {level.rules.length === 1 ? 'condition' : 'conditions'}</Text><Text style={{ color: colors.textMuted }}>{expanded ? 'Hide' : 'Edit'}</Text></Pressable>
          {expanded ? <>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', gap: 8 }}>
            <Field label="Level name" value={level.name} onChangeText={(name) => patchLevel(index, { name })} containerStyle={{ flex: 1, minWidth: 160 }} helpText="The label shown to educators when a student matches this level." helpExample="High Risk" />
            <SelectField label="Severity" value={level.severity} options={[{ label: 'High', value: 'high', helpText: 'Indicates the strongest configured risk signal.' }, { label: 'Medium', value: 'medium', helpText: 'Indicates a moderate configured risk signal.' }, { label: 'Low', value: 'low', helpText: 'Indicates the lowest configured risk signal or fallback.' }]} onChange={(severity) => patchLevel(index, { severity: severity as typeof level.severity })} containerStyle={{ width: 130 }} helpText="Severity controls how this level is described and how palette colors are ordered." />
            <Field label="Priority" value={String(level.priority)} keyboardType="numeric" onChangeText={(value) => patchLevel(index, { priority: Number(value) || 0 })} containerStyle={{ width: 100 }} helpText="In priority mode, higher numbers are checked first. Priority also breaks weighted-score ties." helpExample="High Risk 30 · Medium Risk 20 · Low Risk 10" />
            <View style={{ minWidth: 90, gap: 4 }}><View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}><Text style={{ color: '#64748B', fontSize: 12 }}>Band color</Text><HelpTooltip title="Band color" text="Choose a shared spectrum above or click this circle to set a custom color for this level." example="Use green for low risk and red for high risk." /></View><Pressable accessibilityRole="button" accessibilityLabel={`Choose ${level.name} color`} onPress={() => setColorPickerLevelId(level.id)} style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: level.color ?? '#94A3B8', borderWidth: 2, borderColor: '#FFFFFF', outlineStyle: 'solid', outlineWidth: 1, outlineColor: '#94A3B8' } as any} /></View>
            <SelectField label="Match conditions with" value={level.match} options={[{ label: 'OR · Any condition', value: 'any', helpText: 'The level matches when at least one condition is true.', helpExample: 'Standing below 70 OR attendance below 70.' }, { label: 'AND · All conditions', value: 'all', helpText: 'The level matches only when every condition is true.', helpExample: 'Standing below 70 AND attendance below 70.' }]} onChange={(match) => patchLevel(index, { match: match as typeof level.match })} containerStyle={{ width: 190 }} helpText="Choose how this risk level combines its conditions." helpExample="OR matches if any one condition is true. AND matches only when every condition is true." />
            <Button label="Remove level" variant="ghost" disabled={level.severity === 'low' && definition.levels.filter((item) => item.severity === 'low').length === 1} onPress={() => onChange({ ...definition, levels: definition.levels.filter((item) => item.id !== level.id) })} />
          </View>
          {level.rules.map((rule, ruleIndex) => <View key={`${rule.factorId}-${ruleIndex}`} style={{ gap: 6 }}>{ruleIndex > 0 ? <Text style={{ alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, backgroundColor: '#E2E8F0', color: '#334155', fontSize: 11, fontWeight: '700' }}>{level.match === 'all' ? 'AND' : 'OR'}</Text> : null}<View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', gap: 8 }}>
            <SelectField label="Factor" value={rule.factorId} options={definition.factors.map((factor) => ({ label: factor.name, value: factor.id, helpText: `Uses ${factor.name} as the value checked by this condition.`, helpExample: `${factor.name} below 70` }))} onChange={(factorId) => patchLevel(index, { rules: level.rules.map((item, i) => i === ruleIndex ? { ...item, factorId } : item) })} containerStyle={{ flex: 1, minWidth: 160 }} helpText="Choose which evaluation factor this condition checks." />
            <SelectField label="Condition" value={rule.operator} options={operatorOptionsFor(definition.factors.find((factor) => factor.id === rule.factorId)?.source).map((option) => ({ ...option, helpText: `This condition determines when ${definition.factors.find((factor) => factor.id === rule.factorId)?.name ?? 'the factor'} matches.`, helpExample: option.value === 'below' ? 'Current standing below 70' : option.value === 'at_least' ? 'Attendance at least 80' : option.value === 'is_available' ? 'A value exists for this factor' : option.value === 'is_unavailable' ? 'No value exists for this factor' : option.label }))} onChange={(operator) => patchLevel(index, { rules: level.rules.map((item, i) => i === ruleIndex ? { ...item, operator: operator as typeof item.operator } : item) })} containerStyle={{ width: 160 }} helpText="Choose the comparison applied to the selected factor." />
            {['is_available', 'is_unavailable', 'is_true', 'is_false'].includes(rule.operator) ? null : <Field label={numericSources.has(String(definition.factors.find((factor) => factor.id === rule.factorId)?.source)) ? 'Threshold' : 'Expected value'} value={Array.isArray(rule.threshold) ? rule.threshold.join(', ') : String(rule.threshold)} keyboardType={numericSources.has(String(definition.factors.find((factor) => factor.id === rule.factorId)?.source)) ? 'numeric' : 'default'} onChangeText={(value) => { const source = definition.factors.find((factor) => factor.id === rule.factorId)?.source; const threshold = numericSources.has(String(source)) ? Number(value) : value; patchLevel(index, { rules: level.rules.map((item, i) => i === ruleIndex ? { ...item, threshold } : item) }); }} containerStyle={{ width: 150 }} helpText="The value compared with the selected factor. Numeric factors use a number; categorical factors use a category label." helpExample="For Current standing below, enter 70." />}
            <Button label="Remove rule" variant="ghost" onPress={() => patchLevel(index, { rules: level.rules.filter((_, i) => i !== ruleIndex) })} />
          </View></View>)}
          {level.severity !== 'low' ? <Button label="Add condition" variant="secondary" onPress={() => patchLevel(index, { rules: [...level.rules, { factorId: definition.factors[0]?.id ?? DEFAULT_EVALUATION_SYSTEM.factors[0].id, operator: 'below', threshold: 70 }] })} /> : null}
          </> : null}
        </View>;
      })}
    </View>
    <Button label="← Back to evaluation factors" variant="secondary" onPress={() => setStep('factors')} />
    </>}
    <Modal visible={Boolean(colorPickerLevelId)} transparent animationType="fade" onRequestClose={() => setColorPickerLevelId(null)}>
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20, backgroundColor: '#0F172A66' }}>
        <Pressable onPress={() => setColorPickerLevelId(null)} style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }} />
        <View style={{ width: '100%', maxWidth: 360, padding: 18, borderRadius: 14, backgroundColor: '#FFFFFF', gap: 14 }}>
          <Text style={{ fontSize: 16, fontWeight: '700' }}>Choose band color</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>{['#16A34A', '#84CC16', '#EAB308', '#F97316', '#DC2626', '#BE123C', '#9333EA', '#2563EB', '#0891B2', '#FFFFFF', '#64748B', '#111827'].map((color) => <Pressable key={color} accessibilityRole="button" accessibilityLabel={`Set band color ${color}`} onPress={() => { const index = definition.levels.findIndex((level) => level.id === colorPickerLevelId); if (index >= 0) patchLevel(index, { color }); setColorPickerLevelId(null); }} style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: color, borderWidth: color === '#FFFFFF' ? 1 : 0, borderColor: '#94A3B8' }} />)}</View>
          {(() => { const index = definition.levels.findIndex((level) => level.id === colorPickerLevelId); const level = definition.levels[index]; return level ? <Field label="Custom color" value={level.color ?? ''} onChangeText={(color) => patchLevel(index, { color })} inputType="color" helpText="Choose any color. On mobile, enter a hex value such as #2255AA." /> : null; })()}
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}><Button label="Done" onPress={() => setColorPickerLevelId(null)} /></View>
        </View>
      </View>
    </Modal>
  </View>;
}
