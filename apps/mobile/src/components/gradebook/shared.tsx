import { useEffect, useRef, useState } from 'react';
import { Field } from '@/components/ui';
import type { ClassWorkspace } from '@/services/faculty';
export function valueMappingForType(system: any, typeId: string) {
  for (const component of system.components ?? []) {
    const definition = component.assessmentDefinition;
    if (definition?.typeId === typeId && definition.scoring?.mode === 'value_mapping') return definition.scoring.mapping as { value: string; percentage: number }[];
  }
  return undefined;
}

const gradebookSelectOptionsCache = new WeakMap<object, { label: string; value: string }[]>();
export const EMPTY_GRADEBOOK_VALUES: Record<string, string> = {};
export function gradebookSelectOptions(mapping: { value: string; percentage: number }[]) {
  const cached = gradebookSelectOptionsCache.get(mapping);
  if (cached) return cached;
  const options = [{ label: 'Unscored', value: '' }, ...mapping.map((option) => ({ label: `${option.value} · ${option.percentage}%`, value: option.value }))];
  gradebookSelectOptionsCache.set(mapping, options);
  return options;
}

export function storedAssessmentValue(workspace: ClassWorkspace, enrollmentId: string, assessmentId: string) {
  const key = `${enrollmentId}:${assessmentId}`;
  return workspace.categoricalScores[key] ?? workspace.scores[key] ?? null;
}

export function DebouncedGradebookScoreField({
  value,
  error,
  placeholder,
  accessibilityLabel,
  style,
  containerStyle,
  inputRef,
  onKeyDown,
  onChangeText,
}: {
  value: string;
  error?: string;
  placeholder: string;
  accessibilityLabel: string;
  style: any;
  containerStyle: any;
  inputRef: (instance: any) => void;
  onKeyDown: (event: any) => void;
  onChangeText: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const draftRef = useRef(value);
  const committedRef = useRef(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    draftRef.current = value;
    committedRef.current = value;
    setDraft(value);
  }, [value]);
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);
  const updateDraft = (next: string) => {
    draftRef.current = next;
    setDraft(next);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      committedRef.current = next;
      onChangeText(next);
    }, 250);
  };
  const commitDraft = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    if (draftRef.current !== committedRef.current) {
      committedRef.current = draftRef.current;
      onChangeText(draftRef.current);
    }
  };
  return <Field compact label="" accessibilityLabel={accessibilityLabel} value={draft} error={error} placeholder={placeholder} keyboardType="decimal-pad" onChangeText={updateDraft} onBlur={commitDraft} inputRef={inputRef} onKeyDown={onKeyDown} style={style} containerStyle={containerStyle} />;
}

export function validateScore(value: string, maximum: number) {
  if (!value.trim()) return undefined;
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) return 'Enter a valid non-negative score.';
  const score = Number(value);
  if (!Number.isFinite(score)) return 'Enter a valid score.';
  if (score > maximum) return `Score must be no more than ${maximum}.`;
  return undefined;
}

export function validateAssessmentValue(value: string, maximum: number, categoryMapping?: { value: string; percentage: number }[]) {
  if (!categoryMapping) return validateScore(value, maximum);
  if (!value.trim()) return undefined;
  return categoryMapping.some((item) => item.value === value) ? undefined : 'Choose a category from the assessment type.';
}

