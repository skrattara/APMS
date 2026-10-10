/**
 * Reusable copy of the Faculty gradebook's full spreadsheet view.
 * This component owns grid presentation and interactions; the host supplies
 * data, persistence callbacks, and style tokens.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import * as XLSX from 'xlsx-js-style';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as DocumentPicker from 'expo-document-picker';
import { getErrorMessage } from '@/services/errors';
import { useAuth } from '@/auth/AuthProvider';
import { Badge, Button, Field, PageState, SelectField } from '@/components/ui';
import { AppIcon, type AppIconName } from '@/components/Icon';
import { colors } from '@/theme/tokens';
import type { ClassWorkspace, FacultyAssessment, GradebookHistoryCursor, GradebookHistoryPage, RosterStudent } from '@/services/faculty';
import {
  componentLabel,
  assessmentGroupLabel,
  assessmentPeriodLabel,
  assessmentComponentPath,
  gradingComponentPath,
  groupHierarchyName,
  calculateFullViewGrades,
  gradePercent,
  fullAssessmentColumnWidth,
  fullViewColumns,
  fullAssessmentHeaderRows,
  fullViewColumnValue,
  displayedFullViewColumnValue,
  type FullViewColumn,
} from './model';
import {
  EMPTY_GRADEBOOK_VALUES,
  DebouncedGradebookScoreField,
  gradebookSelectOptions,
  storedAssessmentValue,
  validateAssessmentValue,
  valueMappingForType,
} from './shared';
import { createGradingExcelFormulaBuilder } from '@/services/gradingExcelFormulaBuilder';
import { styles } from '@/screens/FacultyLivePortalContent.styles';
import type { GradebookCellOverlay, GradebookConditionalFormattingOperator, GradebookConditionalFormattingRule, GradebookOverlayControl } from './types';
export type FullAssessmentViewProps = {
  classId: string;
  assessments: FacultyAssessment[];
  students: RosterStudent[];
  allStudents: RosterStudent[];
  workspace: ClassWorkspace;
  gradingSystem: any;
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  onChangeMany: (updates: Record<string, string>) => void;
  dirtyCount: number;
  invalidCount: number;
  saving: boolean;
  onSave: () => void;
  autosaveEnabled: boolean;
  studentQuery: string;
  onStudentQuery: (value: string) => void;
  studentFilter: string;
  onStudentFilter: (value: string) => void;
  studentSort: string;
  onStudentSort: (value: string) => void;
  visibleCount: number;
  page: number;
  pageCount: number;
  paginationEnabled: boolean;
  onPageChange: (update: (current: number) => number) => void;
  onToast: (message: string) => void;
  onEditAssessment: (assessment: FacultyAssessment) => void;
  onLoadScoreHistory: (assessmentId: string, enrollmentId: string) => Promise<{ id: string; actorId: string | null; actorName: string | null; action: string; createdAt: string; before: any; after: any; restoredFromVersionId: string | null; batchId: string | null }[]>;
  onLoadGradebookHistory: (classId: string, cursor?: GradebookHistoryCursor | null) => Promise<GradebookHistoryPage>;
  onRestoreScoreVersion: (versionId: string, assessmentId: string, enrollmentId: string, restoreBefore?: boolean, restoreBatch?: boolean) => Promise<void>;
  onRestoreGradebookVersion: (versionId: string) => Promise<number>;
  onRestoreAssessmentVersion: (versionId: string) => Promise<void>;
  onNameGradebookVersion: (versionId: string, name: string) => Promise<void>;
  cellOverlays?: GradebookCellOverlay[];
  overlayControl?: GradebookOverlayControl;
  conditionalFormattingRules?: GradebookConditionalFormattingRule[];
  onConditionalFormattingRulesChange?: (rules: GradebookConditionalFormattingRule[]) => void;
};

type GradebookScoreVersion = GradebookHistoryPage['entries'][number];
type GradebookOverlayEdges = { top: boolean; right: boolean; bottom: boolean; left: boolean };

type ConditionalColumnStats = { count: number; numeric: number[]; frequencies: Map<string, number>; mean: number | null; deviation: number | null; min: number | null; max: number | null };
type ConditionalCellFormat = { style?: NonNullable<GradebookConditionalFormattingRule['style']>; badge?: GradebookConditionalFormattingRule['badge'] };
const identifyConditionalRules = (rules: GradebookConditionalFormattingRule[] | undefined) => (rules ?? []).map((rule, index) => ({ ...rule, id: rule.id ?? `conditional-imported-${index}` }));
const conditionalGlobalOperators = new Set<GradebookConditionalFormattingRule['operator']>([
  'is_duplicate', 'is_not_duplicate', 'top_n', 'top_percent', 'above_average', 'above_or_equal_average',
  'below_average', 'below_or_equal_average', 'std_deviations_above_average', 'std_deviations_above_or_equal_average',
  'std_deviations_below_average', 'std_deviations_below_or_equal_average',
]);
const conditionalOperatorOptions: { label: string; value: GradebookConditionalFormattingOperator }[] = [
  ['Equals', 'equals'], ['Is exactly', 'is_exactly'], ['Does not equal', 'not_equals'], ['Is one of', 'is_one_of'], ['Is not one of', 'is_not_one_of'],
  ['Contains', 'contains'], ['Does not contain', 'not_contains'], ['Contains one of', 'contains_one_of'], ['Contains none of', 'contains_none_of'],
  ['Begins with', 'begins_with'], ['Does not begin with', 'not_begins_with'], ['Begins with one of', 'begins_with_one_of'], ['Begins with none of', 'begins_with_none_of'],
  ['Ends with', 'ends_with'], ['Does not end with', 'not_ends_with'], ['Ends with one of', 'ends_with_one_of'], ['Ends with none of', 'ends_with_none_of'],
  ['Greater than', 'greater_than'], ['Greater than or equal to', 'greater_than_or_equal'], ['Less than', 'less_than'], ['Less than or equal to', 'less_than_or_equal'],
  ['Between (inclusive)', 'between'], ['Between (exclusive)', 'between_exclusive'], ['Not between', 'not_between'],
  ['Date is', 'date_is'], ['Date is on or before', 'date_on_or_before'], ['Date is on or after', 'date_on_or_after'], ['Date is between (inclusive)', 'date_between'], ['Date is between (exclusive)', 'date_between_exclusive'],
  ['Is blank', 'is_blank'], ['Is not blank', 'is_not_blank'], ['Is duplicate', 'is_duplicate'], ['Is not duplicate', 'is_not_duplicate'],
  ['Top N values', 'top_n'], ['Top N%', 'top_percent'], ['Above average', 'above_average'], ['Above or equal to average', 'above_or_equal_average'],
  ['Below average', 'below_average'], ['Below or equal to average', 'below_or_equal_average'], ['N standard deviations above average', 'std_deviations_above_average'],
  ['N standard deviations above or equal to average', 'std_deviations_above_or_equal_average'], ['N standard deviations below average', 'std_deviations_below_average'],
  ['N standard deviations below or equal to average', 'std_deviations_below_or_equal_average'],
].map(([label, value]) => ({ label: label as string, value: value as GradebookConditionalFormattingOperator }));
const conditionalListOperators = new Set<GradebookConditionalFormattingOperator>(['is_one_of', 'is_not_one_of', 'contains_one_of', 'contains_none_of', 'begins_with_one_of', 'begins_with_none_of', 'ends_with_one_of', 'ends_with_none_of']);
const conditionalBetweenOperators = new Set<GradebookConditionalFormattingOperator>(['between', 'between_exclusive', 'not_between', 'date_between', 'date_between_exclusive']);
const conditionalValueOperators = new Set<GradebookConditionalFormattingOperator>([
  'equals', 'is_exactly', 'not_equals', 'is_one_of', 'is_not_one_of', 'contains', 'not_contains', 'contains_one_of', 'contains_none_of',
  'begins_with', 'not_begins_with', 'begins_with_one_of', 'begins_with_none_of', 'ends_with', 'not_ends_with', 'ends_with_one_of', 'ends_with_none_of',
  'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'between', 'between_exclusive', 'not_between',
  'date_is', 'date_on_or_before', 'date_on_or_after', 'date_between', 'date_between_exclusive', 'top_n', 'top_percent',
  'std_deviations_above_average', 'std_deviations_above_or_equal_average', 'std_deviations_below_average', 'std_deviations_below_or_equal_average',
]);
const conditionalText = (value: unknown) => value == null ? '' : String(value).trim();
const conditionalNumber = (value: unknown) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = conditionalText(value).replace(/%$/, '');
  return text !== '' && Number.isFinite(Number(text)) ? Number(text) : null;
};
const conditionalDate = (value: unknown) => {
  const text = conditionalText(value);
  if (!text) return null;
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : null;
};
const conditionalLists = new WeakMap<object, string[]>();
const conditionalList = (rule: GradebookConditionalFormattingRule) => {
  const cached = conditionalLists.get(rule);
  if (cached) return cached;
  const source = rule.values?.map(String) ?? (typeof rule.value === 'string' ? rule.value.split(',') : rule.value == null ? [] : [String(rule.value)]);
  const result = source.map((item) => item.trim().toLocaleLowerCase()).filter(Boolean);
  conditionalLists.set(rule, result);
  return result;
};
function parseHexColor(color: string) {
  const match = color.trim().match(/^#([\da-f]{3}|[\da-f]{6})$/i);
  if (!match) return null;
  const hex = match[1].length === 3 ? match[1].split('').map((part) => part + part).join('') : match[1];
  return [0, 2, 4].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
}
type PreparedColorScale = { stops: { position: number; color: string; rgb: number[] | null }[] };
const preparedColorScales = new WeakMap<object, PreparedColorScale>();
function scaleColor(value: number, scale: NonNullable<GradebookConditionalFormattingRule['colorScale']>, stats?: ConditionalColumnStats) {
  if (stats?.min == null || stats.max == null || !scale.stops.length) return undefined;
  let prepared = preparedColorScales.get(scale);
  if (!prepared) {
    prepared = { stops: [...scale.stops].sort((a, b) => a.position - b.position).map((stop) => ({ ...stop, position: Math.max(0, Math.min(1, stop.position)), rgb: parseHexColor(stop.color) })) };
    preparedColorScales.set(scale, prepared);
  }
  const stops = prepared.stops;
  const normalized = stats.max === stats.min ? 0.5 : Math.max(0, Math.min(1, (value - stats.min) / (stats.max - stats.min)));
  if (scale.mode === 'discrete') {
    let low = 0; let high = stops.length - 1;
    while (low < high) { const middle = Math.ceil((low + high) / 2); if (normalized >= stops[middle].position) low = middle; else high = middle - 1; }
    return stops[low]?.color;
  }
  let upperIndex = 0;
  while (upperIndex < stops.length && stops[upperIndex].position < normalized) upperIndex += 1;
  if (upperIndex <= 0) return stops[upperIndex < 0 ? stops.length - 1 : 0]?.color;
  if (upperIndex >= stops.length) return stops[stops.length - 1]?.color;
  const lower = stops[upperIndex - 1];
  const upper = stops[upperIndex];
  const a = lower.rgb;
  const b = upper.rgb;
  if (!a || !b) return lower.color;
  const amount = upper.position === lower.position ? 0 : (normalized - lower.position) / (upper.position - lower.position);
  return `#${a.map((part, index) => Math.round(part + (b[index] - part) * amount).toString(16).padStart(2, '0')).join('')}`;
}
function conditionalFormattingForCell(rules: GradebookConditionalFormattingRule[] | undefined, column: FullViewColumn, value: unknown, stats?: ConditionalColumnStats, applyTo: 'cell' | 'row' = 'cell'): ConditionalCellFormat | undefined {
  if (!rules?.length) return undefined;
  const actualText = conditionalText(value);
  const actualLower = actualText.toLocaleLowerCase();
  const actualNumber = conditionalNumber(value);
  const formats: ConditionalCellFormat = {};
  let hasFormat = false;
  for (const rule of rules ?? []) {
    if ((rule.applyTo ?? 'cell') !== applyTo) continue;
    if (rule.columnIds?.length && !rule.columnIds.includes(column.id)) continue;
    if (rule.columnKinds?.length && !rule.columnKinds.includes(column.kind)) continue;
    let matches = rule.operator == null;
    const expectedText = conditionalText(rule.value);
    const expectedLower = expectedText.toLocaleLowerCase();
    const expectedNumber = conditionalNumber(rule.value);
    const endNumber = conditionalNumber(rule.valueTo);
    const list = conditionalList(rule);
    const isBlank = actualText === '' || actualText === '—';
    switch (rule.operator) {
      case 'equals': case 'is_exactly': matches = actualLower === expectedLower; break;
      case 'not_equals': matches = actualLower !== expectedLower; break;
      case 'is_one_of': matches = list.includes(actualLower); break;
      case 'is_not_one_of': matches = !list.includes(actualLower); break;
      case 'contains': matches = actualLower.includes(expectedLower); break;
      case 'not_contains': matches = !actualLower.includes(expectedLower); break;
      case 'contains_one_of': matches = list.some((item) => actualLower.includes(item)); break;
      case 'contains_none_of': matches = !list.some((item) => actualLower.includes(item)); break;
      case 'begins_with': matches = actualLower.startsWith(expectedLower); break;
      case 'not_begins_with': matches = !actualLower.startsWith(expectedLower); break;
      case 'begins_with_one_of': matches = list.some((item) => actualLower.startsWith(item)); break;
      case 'begins_with_none_of': matches = !list.some((item) => actualLower.startsWith(item)); break;
      case 'ends_with': matches = actualLower.endsWith(expectedLower); break;
      case 'not_ends_with': matches = !actualLower.endsWith(expectedLower); break;
      case 'ends_with_one_of': matches = list.some((item) => actualLower.endsWith(item)); break;
      case 'ends_with_none_of': matches = !list.some((item) => actualLower.endsWith(item)); break;
      case 'greater_than': matches = actualNumber != null && expectedNumber != null && actualNumber > expectedNumber; break;
      case 'greater_than_or_equal': matches = actualNumber != null && expectedNumber != null && actualNumber >= expectedNumber; break;
      case 'less_than': matches = actualNumber != null && expectedNumber != null && actualNumber < expectedNumber; break;
      case 'less_than_or_equal': matches = actualNumber != null && expectedNumber != null && actualNumber <= expectedNumber; break;
      case 'between': matches = actualNumber != null && expectedNumber != null && endNumber != null && actualNumber >= expectedNumber && actualNumber <= endNumber; break;
      case 'between_exclusive': matches = actualNumber != null && expectedNumber != null && endNumber != null && actualNumber > expectedNumber && actualNumber < endNumber; break;
      case 'not_between': matches = actualNumber != null && expectedNumber != null && endNumber != null && (actualNumber < expectedNumber || actualNumber > endNumber); break;
      case 'date_is': matches = conditionalDate(value) != null && conditionalDate(value) === conditionalDate(rule.value); break;
      case 'date_on_or_before': matches = conditionalDate(value) != null && conditionalDate(rule.value) != null && conditionalDate(value)! <= conditionalDate(rule.value)!; break;
      case 'date_on_or_after': matches = conditionalDate(value) != null && conditionalDate(rule.value) != null && conditionalDate(value)! >= conditionalDate(rule.value)!; break;
      case 'date_between': case 'date_between_exclusive': {
        const date = conditionalDate(value); const from = conditionalDate(rule.value); const to = conditionalDate(rule.valueTo);
        matches = date != null && from != null && to != null && (rule.operator === 'date_between' ? date >= from && date <= to : date > from && date < to); break;
      }
      case 'is_blank': case 'is_empty': matches = isBlank; break;
      case 'is_not_blank': case 'is_not_empty': matches = !isBlank; break;
      case 'is_duplicate': matches = !!actualLower && (stats?.frequencies.get(actualLower) ?? 0) > 1; break;
      case 'is_not_duplicate': matches = !!actualLower && (stats?.frequencies.get(actualLower) ?? 0) <= 1; break;
      case 'top_n': case 'top_percent': {
        const limit = rule.operator === 'top_n' ? Math.max(1, Math.floor(Number(rule.value) || 1)) : Math.max(0, Math.min(100, Number(rule.value) || 0));
        const sorted = stats?.numeric ?? [];
        const count = rule.operator === 'top_n' ? limit : Math.ceil(sorted.length * limit / 100);
        matches = count > 0 && actualNumber != null && sorted.length > 0 && actualNumber >= sorted[Math.min(sorted.length - 1, count - 1)];
        break;
      }
      case 'above_average': case 'above_or_equal_average': matches = actualNumber != null && stats?.mean != null && (rule.operator === 'above_average' ? actualNumber > stats.mean : actualNumber >= stats.mean); break;
      case 'below_average': case 'below_or_equal_average': matches = actualNumber != null && stats?.mean != null && (rule.operator === 'below_average' ? actualNumber < stats.mean : actualNumber <= stats.mean); break;
      case 'std_deviations_above_average': case 'std_deviations_above_or_equal_average': {
        const threshold = stats?.mean == null || stats.deviation == null ? null : stats.mean + (rule.value == null ? 1 : Number(rule.value)) * stats.deviation;
        matches = actualNumber != null && threshold != null && (rule.operator === 'std_deviations_above_average' ? actualNumber > threshold : actualNumber >= threshold); break;
      }
      case 'std_deviations_below_average': case 'std_deviations_below_or_equal_average': {
        const threshold = stats?.mean == null || stats.deviation == null ? null : stats.mean - (rule.value == null ? 1 : Number(rule.value)) * stats.deviation;
        matches = actualNumber != null && threshold != null && (rule.operator === 'std_deviations_below_average' ? actualNumber < threshold : actualNumber <= threshold); break;
      }
    }
    if (!matches) continue;
    if (rule.style) formats.style = { ...formats.style, ...rule.style };
    if (rule.badge) formats.badge = rule.badge;
    if (rule.colorScale && actualNumber != null) {
      const color = scaleColor(actualNumber, rule.colorScale, stats);
      if (color) formats.style = { ...formats.style, backgroundColor: color };
    }
    hasFormat ||= !!rule.style || !!rule.badge || !!rule.colorScale;
    if (hasFormat) return formats;
  }
  return hasFormat ? formats : undefined;
}

type GradebookContextAction = { label: string; onSelect?: () => void; destructive?: boolean; children?: GradebookContextAction[] };
type GradebookContextMenuState = { x: number; y: number; actions: GradebookContextAction[] } | null;

function organizeContextActions(actions: GradebookContextAction[]) {
  const groups = [
    { label: 'Copy/paste', matches: (action: GradebookContextAction) => /^(copy|paste|clear score)/i.test(action.label) },
    { label: 'Sort and filter', matches: (action: GradebookContextAction) => /^(sort |filter |clear .* filter)/i.test(action.label) },
    { label: 'Bulk edit', matches: (action: GradebookContextAction) => /^(clear values|set all .* scores|paste values)/i.test(action.label) },
  ];
  const grouped = new Map<GradebookContextAction, { label: string; actions: GradebookContextAction[] }>();
  const consumed = new Set<GradebookContextAction>();
  for (const group of groups) {
    const matches = actions.filter(group.matches);
    if (matches.length < 2) continue;
    matches.forEach((action) => consumed.add(action));
    const first = matches[0];
    const orderedMatches = group.label === 'Bulk edit'
      ? [...matches.filter((action) => !/^clear values/i.test(action.label)), ...matches.filter((action) => /^clear values/i.test(action.label))]
      : matches;
    grouped.set(first, { label: group.label, actions: orderedMatches });
  }
  return actions.flatMap((action) => {
    if (consumed.has(action)) {
      const group = grouped.get(action);
      return group ? [{ label: group.label, children: group.actions }] : [];
    }
    return [action];
  });
}

function gradebookContextIcon(label: string): AppIconName {
  const normalized = label.toLowerCase();
  if (normalized.includes('conditional formatting')) return 'settings';
  if (normalized.includes('copy')) return 'copy';
  if (normalized.includes('paste')) return 'paste';
  if (normalized.includes('delete') || normalized.includes('remove')) return 'delete';
  if (normalized.includes('clear')) return 'clear';
  if (normalized.includes('sort') && normalized.includes('descending')) return 'sortDescending';
  if (normalized.includes('sort')) return 'sortAscending';
  if (normalized.includes('filter')) return 'filter';
  if (normalized.includes('hide')) return 'hide';
  if (normalized.includes('show') || normalized.includes('unhide')) return 'show';
  if (normalized.includes('collapse')) return 'collapse';
  if (normalized.includes('expand')) return 'expand';
  if (normalized.includes('set all') || normalized.includes('edit')) return 'edit';
  return 'settings';
}
type GradebookRowFilter = { operator: string; value: string };
type GradebookFilterTarget = { key: string; label: string; kind: 'text' | 'number' | 'category'; options?: { label: string; value: string }[] };
type SavedGradebookView = {
  id: string; name: string; studentQuery: string; studentFilter: string; studentSort: string; columnHeaderQuery: string;
  hideComponentGrades: boolean; hideAssessmentInstanceColumns: boolean; hideNonFinalCalculatedGrades: boolean; hideFinalGradeColumns: boolean;
  showHierarchyLabels: boolean; hideSingleChildComponentGrades: boolean; calculatedCellDisplay: 'grade' | 'contribution';
  hiddenHeaderLevels: string[]; sectionStates: Record<string, { mode: 'collapsed' | 'hidden'; columnIds: string[]; keepColumnIds: string[] }>;
  rowFilters: Record<string, GradebookRowFilter>; headerSort: { key: string; label: string; direction: 'asc' | 'desc' } | null;
};

type FullGradebookRowProps = {
  student: RosterStudent;
  gradeResult: ReturnType<typeof calculateFullViewGrades>;
  cellOverlays: Map<string, GradebookCellOverlay>;
  cellOverlayEdges: Map<string, GradebookOverlayEdges>;
  conditionalFormattingRules?: GradebookConditionalFormattingRule[];
  conditionalFormattingRulesByColumn?: Map<string, GradebookConditionalFormattingRule[]>;
  conditionalFormattingRowColumnsByRule?: Map<string, FullViewColumn[]>;
  conditionalFormattingStats?: Map<string, ConditionalColumnStats>;
  columns: FullViewColumn[];
  offsets: Map<string, number>;
  workspace: ClassWorkspace;
  gradingSystem: any;
  valueMappings: Map<string, { value: string; percentage: number }[]>;
  values: Record<string, string>;
  displayMode: 'grade' | 'contribution';
  decimalPlaces: number;
  showPercent: boolean;
  passingGradePercentage: number;
  deemphasizeGroupGrades: boolean;
  showClassNumber: boolean;
  showStudentName: boolean;
  showStudentId: boolean;
  showAnonymousId: boolean;
  anonymousId: string;
  classNumberWidth: number;
  studentNameWidth: number;
  studentIdWidth: number;
  anonymousIdWidth: number;
  leftSpacerWidth: number;
  rightSpacerWidth: number;
  studentColumnOffsets: { classNumber: number; name: number; id: number; anonymous: number };
  scoreInputRefs: { current: Map<string, any> };
  columnCssKey: (key: string) => string;
  columnHoverProps: (ids: string[]) => any;
  navigateScoreInput: (event: any, enrollmentId: string, assessmentId: string, value: string) => void;
  onChange: (key: string, value: string) => void;
  onRowMeasured: (enrollmentId: string, height: number) => void;
};

const FullGradebookRow = memo(function FullGradebookRow(row: FullGradebookRowProps) {
  const { student, gradeResult, columns, offsets, workspace, gradingSystem, values } = row;
  const conditionalRulesFor = (column: FullViewColumn) => row.conditionalFormattingRulesByColumn?.get(column.id) ?? row.conditionalFormattingRules ?? [];
  const containerFormatStyle = (style: GradebookConditionalFormattingRule['style'] | undefined) => style ? [
    style.backgroundColor ? { backgroundColor: style.backgroundColor } : null,
    style.borderColor ? { borderWidth: 1, borderColor: style.borderColor } : null,
  ] : null;
  // Pass the active format color down to the hover CSS. A custom property keeps
  // the hover effect in CSS (no React updates per pointer movement) while letting
  // the tint retain the conditional-format color's hue.
  const hoverFormatStyle = (color: string | undefined) => Platform.OS === 'web' && color
    ? { '--gradebook-format-color': color } as any
    : null;
  const renderConditionalFormatMarker = () => <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no" style={{ position: 'absolute', right: 2, top: 1, zIndex: 6, width: 10, height: 10, alignItems: 'center', justifyContent: 'center', borderRadius: 3, backgroundColor: colors.surface }}><AppIcon name="format" size={9} color={colors.brand} /></View>;
  const textFormatStyle = (style: GradebookConditionalFormattingRule['style'] | undefined) => style ? {
    ...(style.textColor ? { color: style.textColor } : {}),
    ...(style.fontWeight ? { fontWeight: style.fontWeight } : {}),
  } : null;
  const rowConditionalStyle = (() => {
    const rules = (row.conditionalFormattingRules ?? []).filter((rule) => rule.applyTo === 'row');
    for (const rule of rules) {
      const targetColumns = row.conditionalFormattingRowColumnsByRule?.get(rule.id ?? '') ?? columns;
      for (const column of targetColumns) {
        let value: unknown;
        if (column.assessment) {
          const assessment = column.assessment;
          const stored = storedAssessmentValue(workspace, student.enrollmentId, assessment.id);
          const input = values[`${student.enrollmentId}:${assessment.id}`] ?? (stored == null ? '' : String(stored));
          const mapping = row.valueMappings.get(assessment.gradingTypeId ?? assessment.component);
          value = mapping?.find((item) => String(item.value) === input)?.percentage ?? (input.trim() !== '' && Number.isFinite(Number(input)) ? Number(input) : input);
        } else value = displayedFullViewColumnValue(column, student.enrollmentId, gradeResult, workspace, values, gradingSystem, row.displayMode);
        const format = conditionalFormattingForCell([rule], column, value, row.conditionalFormattingStats?.get(column.id), 'row');
        if (format?.style) return format.style;
      }
    }
    return undefined;
  })();
  const cellOverlayFor = (columnId: string) => row.cellOverlays.get(`${student.enrollmentId}:${columnId}`);
  const cellOverlayStyleFor = (columnId: string) => {
    const overlay = cellOverlayFor(columnId);
    if (!overlay || overlay.mode === 'value') return null;
    const edges = row.cellOverlayEdges.get(`${student.enrollmentId}:${columnId}`);
    return {
      backgroundColor: 'rgba(99,102,241,0.2)',
      borderTopWidth: edges?.top ? 2 : 0,
      borderRightWidth: edges?.right ? 2 : 0,
      borderBottomWidth: edges?.bottom ? 2 : 0,
      borderLeftWidth: edges?.left ? 2 : 0,
      borderColor: overlay.color ?? '#4F46E5',
    } as const;
  };
  const renderCellOverlay = (columnId: string) => {
    const overlay = cellOverlayFor(columnId);
    if (!overlay || (overlay.mode !== 'value' && overlay.mode !== 'value-highlight')) return null;
    const isValueOnly = overlay.mode === 'value';
    return <View pointerEvents="none" style={[StyleSheet.absoluteFill, { zIndex: 5, justifyContent: 'center', alignItems: 'center', backgroundColor: isValueOnly ? 'rgba(241,245,249,0.98)' : 'rgba(224,231,255,0.98)' }]}><Text numberOfLines={1} style={{ maxWidth: '100%', paddingHorizontal: 2, color: overlay.color ?? '#64748B', fontSize: 10, lineHeight: 12, fontWeight: '600' }}>{overlay.label ?? overlay.value ?? ''}</Text></View>;
  };
  return <View onLayout={(event: any) => {
    const height = Number(event?.nativeEvent?.layout?.height);
    if (Number.isFinite(height) && height > 0) row.onRowMeasured(student.enrollmentId, height);
  }} {...({ dataSet: { gradebookRow: 'true' } } as any)}>
    <View style={styles.fullTableRow}>
      {row.showClassNumber ? <View {...({ dataSet: { gradebookCol: row.columnCssKey('student_class_number'), gradebookColumnId: 'student_class_number', gradebookStudent: student.enrollmentId, gradebookHoverCell: 'true' } } as any)} {...row.columnHoverProps(['student_class_number'])} style={[styles.fullClassNumberColumn, { width: row.classNumberWidth }, Platform.OS === 'web' ? { position: 'sticky', left: row.studentColumnOffsets.classNumber, zIndex: 63, backgroundColor: colors.surface } as any : null, containerFormatStyle(rowConditionalStyle), hoverFormatStyle(rowConditionalStyle?.backgroundColor)]}><Text style={[styles.fullStudentMeta, textFormatStyle(rowConditionalStyle)]}>{student.classNumber}</Text></View> : null}
      {row.showStudentName ? <View {...({ dataSet: { gradebookCol: row.columnCssKey('student_name'), gradebookColumnId: 'student_name', gradebookStudent: student.enrollmentId, gradebookHoverCell: 'true' } } as any)} {...row.columnHoverProps(['student_name'])} style={[styles.fullStudentNameColumn, { width: row.studentNameWidth, position: 'relative' }, Platform.OS === 'web' ? { position: 'sticky', left: row.studentColumnOffsets.name, zIndex: 62, backgroundColor: colors.surface } as any : null, containerFormatStyle(rowConditionalStyle), hoverFormatStyle(rowConditionalStyle?.backgroundColor)]}><Text style={[styles.fullStudentName, textFormatStyle(rowConditionalStyle)]}>{student.name}</Text></View> : null}
      {row.showStudentId ? <View {...({ dataSet: { gradebookCol: row.columnCssKey('student_id'), gradebookColumnId: 'student_id', gradebookStudent: student.enrollmentId, gradebookHoverCell: 'true' } } as any)} {...row.columnHoverProps(['student_id'])} style={[styles.fullStudentIdColumn, { width: row.studentIdWidth }, Platform.OS === 'web' ? { position: 'sticky', left: row.studentColumnOffsets.id, zIndex: 61, backgroundColor: colors.surface } as any : null, containerFormatStyle(rowConditionalStyle), hoverFormatStyle(rowConditionalStyle?.backgroundColor)]}><Text style={[styles.fullStudentMeta, textFormatStyle(rowConditionalStyle)]}>{student.institutionalId}</Text></View> : null}
      {row.showAnonymousId ? <View {...({ dataSet: { gradebookCol: row.columnCssKey('student_anonymous_id'), gradebookColumnId: 'student_anonymous_id', gradebookStudent: student.enrollmentId, gradebookHoverCell: 'true' } } as any)} {...row.columnHoverProps(['student_anonymous_id'])} style={[styles.fullStudentIdColumn, { width: row.anonymousIdWidth }, Platform.OS === 'web' ? { position: 'sticky', left: row.studentColumnOffsets.anonymous, zIndex: 60, backgroundColor: colors.surface } as any : null, containerFormatStyle(rowConditionalStyle), hoverFormatStyle(rowConditionalStyle?.backgroundColor)]}><Text style={[styles.fullStudentMeta, textFormatStyle(rowConditionalStyle)]}>{row.anonymousId}</Text></View> : null}
      <View pointerEvents="none" style={{ width: row.leftSpacerWidth, flexShrink: 0 }} />
      {columns.map((column) => {
        const dataColumnOffset = offsets.get(column.id) ?? 0;
        const frozenPaneClip = Platform.OS === 'web' ? { clipPath: `inset(0 0 0 max(0px, calc(var(--gradebook-scroll-x, 0px) - ${dataColumnOffset}px)))` } as any : null;
        if (column.kind !== 'assessment' || !column.assessment) {
          const overlay = cellOverlayFor(column.id);
          const marksPreview = overlay?.mode === 'highlight' || overlay?.mode === 'value-highlight';
          const computed = displayedFullViewColumnValue(column, student.enrollmentId, gradeResult, workspace, values, gradingSystem, row.displayMode);
          const conditionalFormat = conditionalFormattingForCell(conditionalRulesFor(column), column, computed, row.conditionalFormattingStats?.get(column.id));
          const rowCellFormat = conditionalFormattingForCell(conditionalRulesFor(column), column, computed, row.conditionalFormattingStats?.get(column.id), 'row');
          const conditionalStyle = { ...rowConditionalStyle, ...conditionalFormat?.style };
          const conditionalBadge = conditionalFormat?.badge ?? rowCellFormat?.badge;
          const hasCellConditionalFormatting = !!(conditionalFormat?.style || conditionalFormat?.badge);
          const hasConditionalFormatting = hasCellConditionalFormatting || !!(rowCellFormat?.style || rowCellFormat?.badge);
          const finalNumber = typeof computed === 'number' ? computed : null;
          const finalDetail = column.kind === 'final' ? gradePercent(finalNumber, row.decimalPlaces, row.showPercent) : column.kind === 'final_equivalent' ? `${gradeResult.pointGrade == null ? '—' : gradeResult.pointGrade.toFixed(row.decimalPlaces)}${gradeResult.letterGrade ? ` / ${gradeResult.letterGrade}` : ''}` : column.kind === 'final_status' ? String(computed ?? 'Incomplete') : gradePercent(typeof computed === 'number' ? computed : null, row.decimalPlaces, row.showPercent);
          const emphasizeGrade = ['period', 'non_period', 'final', 'final_equivalent'].includes(column.kind)
            || (column.kind === 'group' && !row.deemphasizeGroupGrades);
          const statusTone = finalDetail === 'Pass' ? 'success' : finalDetail === 'Fail' ? 'danger' : finalDetail.includes('ongoing') ? 'info' : 'warning';
          return <View key={`${student.enrollmentId}-${column.id}`} accessible accessibilityRole="text" accessibilityLabel={`${student.name}, ${column.leafLabel}, ${finalDetail}${hasConditionalFormatting ? ', conditional formatting applied' : ''}`} {...({ dataSet: { gradebookCol: row.columnCssKey(column.id), gradebookColumnId: column.id, gradebookStudent: student.enrollmentId, gradebookHoverCell: 'true', ...(hasConditionalFormatting ? { gradebookFormatted: 'true' } : {}), ...(marksPreview ? { gradebookPreview: 'true' } : {}) } } as any)} {...row.columnHoverProps([column.id])} style={[styles.fullAssessmentColumn, styles.fullComputedCell, { width: column.width, position: 'relative' }, containerFormatStyle(conditionalStyle), hoverFormatStyle(conditionalStyle?.backgroundColor ?? conditionalBadge?.backgroundColor), cellOverlayStyleFor(column.id), frozenPaneClip]}>{column.kind === 'final_status' ? <Badge tone={statusTone}>{finalDetail}</Badge> : <Text style={[styles.fullComputedValue, emphasizeGrade && styles.fullEmphasizedGradeValue, textFormatStyle(conditionalStyle)]}>{finalDetail}</Text>}{hasCellConditionalFormatting ? renderConditionalFormatMarker() : null}{conditionalBadge ? <View pointerEvents="none" style={{ alignSelf: 'center', marginTop: 2, paddingHorizontal: 5, paddingVertical: 1, borderRadius: 8, backgroundColor: conditionalBadge.backgroundColor ?? '#E0E7FF' }}><Text style={{ color: conditionalBadge.textColor ?? '#3730A3', fontSize: 9, lineHeight: 12, fontWeight: '700' }}>{conditionalBadge.label}</Text></View> : null}{renderCellOverlay(column.id)}</View>;
        }
        const assessment = column.assessment;
        const key = `${student.enrollmentId}:${assessment.id}`;
        const mapping = row.valueMappings.get(assessment.gradingTypeId ?? assessment.component);
        const stored = storedAssessmentValue(workspace, student.enrollmentId, assessment.id);
        const value = values[key] ?? (stored == null ? '' : String(stored));
        const error = value.trim() ? validateAssessmentValue(value, assessment.maximumScore, mapping) : undefined;
        const mappedPercentage = mapping?.find((option) => String(option.value) === value)?.percentage;
        const categoricalTone = !value.trim() || mappedPercentage == null ? null : mappedPercentage >= row.passingGradePercentage ? 'passing' : 'failing';
        const comparableValue = mappedPercentage ?? (value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : value);
        const conditionalFormat = conditionalFormattingForCell(conditionalRulesFor(column), column, comparableValue, row.conditionalFormattingStats?.get(column.id));
        const rowCellFormat = conditionalFormattingForCell(conditionalRulesFor(column), column, comparableValue, row.conditionalFormattingStats?.get(column.id), 'row');
        const conditionalStyle = { ...rowConditionalStyle, ...conditionalFormat?.style };
        const conditionalBadge = conditionalFormat?.badge ?? rowCellFormat?.badge;
        const hasCellConditionalFormatting = !!(conditionalFormat?.style || conditionalFormat?.badge);
        const hasConditionalFormatting = hasCellConditionalFormatting || !!(rowCellFormat?.style || rowCellFormat?.badge);
        const overlay = cellOverlayFor(column.id);
        const marksPreview = overlay?.mode === 'highlight' || overlay?.mode === 'value-highlight';
        return <View key={`${student.enrollmentId}-${assessment.id}`} accessible accessibilityRole="text" accessibilityLabel={`${student.name}, ${assessment.title}, score ${value || 'unscored'}${hasConditionalFormatting ? ', conditional formatting applied' : ''}`} {...({ dataSet: { gradebookCol: row.columnCssKey(column.id), gradebookColumnId: column.id, gradebookStudent: student.enrollmentId, gradebookHoverCell: 'true', ...(hasConditionalFormatting ? { gradebookFormatted: 'true' } : {}), ...(marksPreview ? { gradebookPreview: 'true' } : {}) } } as any)} {...row.columnHoverProps([column.id])} style={[styles.fullAssessmentColumn, { width: column.width, position: 'relative' }, containerFormatStyle(conditionalStyle), hoverFormatStyle(conditionalStyle?.backgroundColor ?? conditionalBadge?.backgroundColor), cellOverlayStyleFor(column.id), frozenPaneClip]}>
          {mapping ? <SelectField compact label="" accessibilityLabel={`${student.name}, ${assessment.title} score`} controlDataSet={{ gradebookScoreControl: 'true' }} value={value} error={error} deferModalUntilOpen options={gradebookSelectOptions(mapping)} onChange={(next) => row.onChange(key, next)} controlRef={(input) => { if (input) row.scoreInputRefs.current.set(key, input); else row.scoreInputRefs.current.delete(key); }} onKeyDown={(event) => row.navigateScoreInput(event, student.enrollmentId, assessment.id, value)} containerStyle={[styles.fullScoreField, { gap: 0 }]} controlStyle={[styles.fullScoreControl, categoricalTone === 'passing' ? { backgroundColor: '#EAF6EC', borderColor: '#55A66A' } : null, categoricalTone === 'failing' ? { backgroundColor: '#FCEBEC', borderColor: '#D66B70' } : null, conditionalStyle?.backgroundColor ? { backgroundColor: conditionalStyle.backgroundColor } : null, conditionalStyle?.borderColor ? { borderColor: conditionalStyle.borderColor } : null]} valueStyle={[styles.fullScoreValue, categoricalTone === 'passing' ? { color: '#176B35' } : null, categoricalTone === 'failing' ? { color: '#A52B32' } : null, textFormatStyle(conditionalStyle)]} /> : <DebouncedGradebookScoreField accessibilityLabel={`${student.name}, ${assessment.title} score`} value={value} error={error} placeholder={`0–${assessment.maximumScore}`} onChangeText={(next) => row.onChange(key, next)} inputRef={(input) => { if (input) row.scoreInputRefs.current.set(key, input); else row.scoreInputRefs.current.delete(key); }} onKeyDown={(event) => row.navigateScoreInput(event, student.enrollmentId, assessment.id, value)} style={[styles.fullNumericInput, conditionalStyle?.backgroundColor ? { backgroundColor: conditionalStyle.backgroundColor } : null, textFormatStyle(conditionalStyle)]} containerStyle={styles.fullNumericScoreField} />}
          {hasCellConditionalFormatting ? renderConditionalFormatMarker() : null}
          {conditionalBadge ? <View pointerEvents="none" style={{ position: 'absolute', right: 2, bottom: 1, paddingHorizontal: 4, paddingVertical: 0, borderRadius: 7, backgroundColor: conditionalBadge.backgroundColor ?? '#E0E7FF' }}><Text style={{ color: conditionalBadge.textColor ?? '#3730A3', fontSize: 8, lineHeight: 10, fontWeight: '700' }}>{conditionalBadge.label}</Text></View> : null}
          {renderCellOverlay(column.id)}
        </View>;
      })}
      <View pointerEvents="none" style={{ width: row.rightSpacerWidth, flexShrink: 0 }} />
    </View>
  </View>;
}, (previous, next) => previous.student === next.student
  && previous.gradeResult === next.gradeResult
  && previous.cellOverlays === next.cellOverlays
  && previous.cellOverlayEdges === next.cellOverlayEdges
  && previous.conditionalFormattingRules === next.conditionalFormattingRules
  && previous.conditionalFormattingRulesByColumn === next.conditionalFormattingRulesByColumn
  && previous.conditionalFormattingRowColumnsByRule === next.conditionalFormattingRowColumnsByRule
  && previous.conditionalFormattingStats === next.conditionalFormattingStats
  && previous.columns === next.columns
  && previous.offsets === next.offsets
  && previous.workspace === next.workspace
  && previous.gradingSystem === next.gradingSystem
  && previous.valueMappings === next.valueMappings
  && previous.values === next.values
  && previous.displayMode === next.displayMode
  && previous.decimalPlaces === next.decimalPlaces
  && previous.showPercent === next.showPercent
  && previous.passingGradePercentage === next.passingGradePercentage
  && previous.deemphasizeGroupGrades === next.deemphasizeGroupGrades
  && previous.showClassNumber === next.showClassNumber
  && previous.showStudentName === next.showStudentName
  && previous.showStudentId === next.showStudentId
  && previous.showAnonymousId === next.showAnonymousId
  && previous.anonymousId === next.anonymousId
  && previous.classNumberWidth === next.classNumberWidth
  && previous.studentNameWidth === next.studentNameWidth
  && previous.studentIdWidth === next.studentIdWidth
  && previous.anonymousIdWidth === next.anonymousIdWidth
  && previous.leftSpacerWidth === next.leftSpacerWidth
  && previous.rightSpacerWidth === next.rightSpacerWidth
  && previous.studentColumnOffsets.classNumber === next.studentColumnOffsets.classNumber
  && previous.studentColumnOffsets.name === next.studentColumnOffsets.name
  && previous.studentColumnOffsets.id === next.studentColumnOffsets.id
  && previous.studentColumnOffsets.anonymous === next.studentColumnOffsets.anonymous
  && previous.onChange === next.onChange);

export function FullAssessmentView(props: FullAssessmentViewProps) {
  const { assessments, students, workspace, gradingSystem } = props;
  const { user } = useAuth();
  const columnCssKeyCacheRef = useRef(new Map<string, string>());
  const columnCssKey = useCallback((key: string) => {
    const cached = columnCssKeyCacheRef.current.get(key);
    if (cached != null) return cached;
    let hash = 2166136261;
    for (let index = 0; index < key.length; index += 1) hash = Math.imul(hash ^ key.charCodeAt(index), 16777619);
    const value = String(hash >>> 0);
    columnCssKeyCacheRef.current.set(key, value);
    return value;
  }, []);
  const [contextMenu, setContextMenu] = useState<GradebookContextMenuState>(null);
  const [conditionalRules, setConditionalRules] = useState<GradebookConditionalFormattingRule[]>(() => identifyConditionalRules(props.conditionalFormattingRules));
  const [conditionalFormattingTarget, setConditionalFormattingTarget] = useState<FullViewColumn | null>(null);
  const [conditionalEditingRuleId, setConditionalEditingRuleId] = useState<string | null>(null);
  const [draggedConditionalRuleIndex, setDraggedConditionalRuleIndex] = useState<number | null>(null);
  const [conditionalOperator, setConditionalOperator] = useState<GradebookConditionalFormattingOperator>('greater_than_or_equal');
  const [conditionalValue, setConditionalValue] = useState('');
  const [conditionalValueTo, setConditionalValueTo] = useState('');
  const [conditionalFormatMode, setConditionalFormatMode] = useState<'highlight' | 'discrete_scale' | 'continuous_scale' | 'badge'>('highlight');
  const [conditionalApplyTo, setConditionalApplyTo] = useState<'cell' | 'row'>('cell');
  const [conditionalColor, setConditionalColor] = useState('#DCFCE7');
  const [conditionalScaleColors, setConditionalScaleColors] = useState(['#FECACA', '#FEF3C7', '#BBF7D0']);
  const [conditionalBadgeLabel, setConditionalBadgeLabel] = useState('');
  const internalClipboardRef = useRef('');
  const [hiddenHeaderLevels, setHiddenHeaderLevels] = useState<Set<string>>(new Set());
  const [sectionStates, setSectionStates] = useState<Record<string, { mode: 'collapsed' | 'hidden'; columnIds: string[]; keepColumnIds: string[] }>>({});
  const [hideSingleChildComponentGrades, setHideSingleChildComponentGrades] = useState(false);
  const [hideComponentGrades, setHideComponentGrades] = useState(false);
  const [hideAssessmentInstanceColumns, setHideAssessmentInstanceColumns] = useState(false);
  const [showHierarchyLabels, setShowHierarchyLabels] = useState(false);
  const [hideNonFinalCalculatedGrades, setHideNonFinalCalculatedGrades] = useState(false);
  const [hideFinalGradeColumns, setHideFinalGradeColumns] = useState(false);
  const [calculatedCellDisplay, setCalculatedCellDisplay] = useState<'grade' | 'contribution'>('grade');
  const [missingScoreHandling, setMissingScoreHandling] = useState<'ignore' | 'zero' | 'full'>('ignore');
  const [gradeDecimalPlacesInput, setGradeDecimalPlacesInput] = useState('2');
  const [showGradePercentSign, setShowGradePercentSign] = useState(true);
  const gradeDecimalPlaces = Math.min(100, Math.max(0, Number.parseInt(gradeDecimalPlacesInput, 10) || 0));
  const passingGradePercentage = gradingSystem.finalGradeConversion?.passingPercentage ?? workspace.criteria?.passingThreshold ?? 80;
  const [viewOptionsOpen, setViewOptionsOpen] = useState(false);
  const [exportingExcel, setExportingExcel] = useState(false);
  const [bulkScoreAssessment, setBulkScoreAssessment] = useState<FacultyAssessment | null>(null);
  const [bulkScoreValue, setBulkScoreValue] = useState('');
  const [filterTarget, setFilterTarget] = useState<GradebookFilterTarget | null>(null);
  const [filterOperator, setFilterOperator] = useState('contains');
  const [filterValue, setFilterValue] = useState('');
  useEffect(() => { if (props.conditionalFormattingRules) setConditionalRules(identifyConditionalRules(props.conditionalFormattingRules)); }, [props.conditionalFormattingRules]);
  const [scoreHistoryTarget, setScoreHistoryTarget] = useState<{ assessment: FacultyAssessment; student: RosterStudent } | null>(null);
  const [scoreHistory, setScoreHistory] = useState<{ id: string; actorId: string | null; actorName: string | null; action: string; createdAt: string; before: any; after: any; restoredFromVersionId: string | null; batchId: string | null }[]>([]);
  const [scoreHistoryLoading, setScoreHistoryLoading] = useState(false);
  const [gradebookHistoryOpen, setGradebookHistoryOpen] = useState(false);
  const [historyPreviewOverlays, setHistoryPreviewOverlays] = useState<GradebookCellOverlay[]>([]);
  useEffect(() => { setHistoryPreviewOverlays([]); }, [props.classId]);
  const [gradebookHistory, setGradebookHistory] = useState<GradebookScoreVersion[]>([]);
  const [gradebookHistoryLoading, setGradebookHistoryLoading] = useState(false);
  const [gradebookHistoryScanning, setGradebookHistoryScanning] = useState(false);
  const [gradebookHistoryQuery, setGradebookHistoryQuery] = useState('');
  const [gradebookHistoryAction, setGradebookHistoryAction] = useState('all');
  const [expandedBulkHistoryIds, setExpandedBulkHistoryIds] = useState<Set<string>>(new Set());
  const [gradebookHistoryVisibleLimit, setGradebookHistoryVisibleLimit] = useState(100);
  const [gradebookHistoryCursor, setGradebookHistoryCursor] = useState<GradebookHistoryCursor | null>(null);
  const [gradebookHistoryHasMore, setGradebookHistoryHasMore] = useState(false);
  const [gradebookHistoryDate, setGradebookHistoryDate] = useState<string | null>(null);
  const [gradebookHistoryActor, setGradebookHistoryActor] = useState('all');
  const [gradebookVersionToName, setGradebookVersionToName] = useState<{ id: string; name: string } | null>(null);
  const [gradebookVersionNameInput, setGradebookVersionNameInput] = useState('');
  const [restoreMenuVersionId, setRestoreMenuVersionId] = useState<string | null>(null);
  const [gradebookVersionToRestore, setGradebookVersionToRestore] = useState<{ id: string; createdAt: string; assessmentTitle: string; studentName: string } | null>(null);
  const [assessmentVersionToRestore, setAssessmentVersionToRestore] = useState<{ id: string; assessmentTitle: string; action: string } | null>(null);
  const [scoreVersionToRestore, setScoreVersionToRestore] = useState<{ id: string; snapshot: any; assessmentId: string; enrollmentId: string; assessmentTitle: string; studentName: string; batchId?: string | null; restoreBatch?: boolean } | null>(null);
  const [restoringScoreVersion, setRestoringScoreVersion] = useState(false);
  const [gradeExplanationTarget, setGradeExplanationTarget] = useState<{ column: FullViewColumn; student: RosterStudent } | null>(null);
  const [scoreImportOpen, setScoreImportOpen] = useState(false);
  const [scoreImporting, setScoreImporting] = useState(false);
  const [scoreImportPreview, setScoreImportPreview] = useState<{ fileName: string; rows: { enrollmentId: string | null; studentLabel: string; updates: Record<string, string>; errors: string[] }[]; inputCount: number } | null>(null);
  const [rowFilters, setRowFilters] = useState<Record<string, GradebookRowFilter>>({});
  const [headerSort, setHeaderSort] = useState<{ key: string; label: string; direction: 'asc' | 'desc' } | null>(null);
  const [columnHeaderQuery, setColumnHeaderQuery] = useState('');
  const [savedViews, setSavedViews] = useState<SavedGradebookView[]>([]);
  const [savedViewsLoaded, setSavedViewsLoaded] = useState(false);
  const [savedViewName, setSavedViewName] = useState('');
  const [selectedSavedViewId, setSelectedSavedViewId] = useState('');
  const cellOverlayByKey = useMemo(() => {
    const overlays = new Map<string, GradebookCellOverlay>();
    for (const overlay of props.cellOverlays ?? []) overlays.set(`${overlay.enrollmentId}:${overlay.columnId}`, overlay);
    for (const overlay of historyPreviewOverlays) overlays.set(`${overlay.enrollmentId}:${overlay.columnId}`, overlay);
    return overlays;
  }, [props.cellOverlays, historyPreviewOverlays]);
  const savedViewStorageKey = user?.id && props.classId ? `apms:gradebook-views:${user.id}:${props.classId}` : '';
  const savedViewFileUri = FileSystem.documentDirectory ? `${FileSystem.documentDirectory}gradebook-views-${user?.id ?? 'user'}-${props.classId || 'class'}.json` : null;
  useEffect(() => {
    let active = true;
    setSavedViewsLoaded(false);
    if (!savedViewStorageKey) { setSavedViews([]); setSavedViewsLoaded(true); return () => { active = false; }; }
    void (async () => {
      try {
        const raw = Platform.OS === 'web'
          ? typeof localStorage !== 'undefined' ? localStorage.getItem(savedViewStorageKey) : null
          : savedViewFileUri ? await FileSystem.readAsStringAsync(savedViewFileUri) : null;
        const parsed = raw ? JSON.parse(raw) : [];
        if (active) setSavedViews(Array.isArray(parsed) ? parsed : []);
      } catch { if (active) setSavedViews([]); }
      finally { if (active) setSavedViewsLoaded(true); }
    })();
    return () => { active = false; };
  }, [savedViewStorageKey, savedViewFileUri]);
  useEffect(() => {
    if (!savedViewsLoaded || !savedViewStorageKey) return;
    const serialized = JSON.stringify(savedViews);
    if (Platform.OS === 'web') {
      try { localStorage.setItem(savedViewStorageKey, serialized); } catch { /* storage may be unavailable in private browsing */ }
    } else if (savedViewFileUri) {
      void FileSystem.writeAsStringAsync(savedViewFileUri, serialized).catch(() => {});
    }
  }, [savedViews, savedViewsLoaded, savedViewStorageKey, savedViewFileUri]);
  const [showClassNumber, setShowClassNumber] = useState(true);
  const [showStudentName, setShowStudentName] = useState(true);
  const [showStudentId, setShowStudentId] = useState(true);
  const [showAnonymousId, setShowAnonymousId] = useState(false);
  const [randomizeRows, setRandomizeRows] = useState(false);
  const [randomOrderSeed, setRandomOrderSeed] = useState(1);
  const [gridHasScrolled, setGridHasScrolled] = useState({ x: false, y: false });
  const [virtualStartIndex, setVirtualStartIndex] = useState(0);
  const fullRowHeight = 22;
  const [rowHeightModel, setRowHeightModel] = useState<{ baseline: number | null; exceptions: Record<string, number> }>({ baseline: null, exceptions: {} });
  const pendingRowHeightsRef = useRef(new Map<string, number>());
  const rowHeightFrameRef = useRef<number | null>(null);
  const [gridViewportWidth, setGridViewportWidth] = useState(1440);
  const [horizontalColumnRange, setHorizontalColumnRange] = useState({ start: 0, end: 32 });
  const gridScrollElementRef = useRef<any>(null);
  const headerHeightRef = useRef(0);
  const loadGradebookHistoryPage = async (cursor: GradebookHistoryCursor | null, append: boolean, force = false) => {
    if (gradebookHistoryLoading && !force) return;
    setGradebookHistoryLoading(true);
    try {
      let page = await props.onLoadGradebookHistory(props.classId, cursor);
      let entries = page.entries;
      let nextCursor = page.nextCursor;
      let hasMore = page.hasMore;

      // Bulk edits are stored as one history row per score. Finish loading the
      // trailing batch so a single click never shows a partial bulk edit.
      while (hasMore && entries.length) {
        const trailingBatchId = entries[entries.length - 1]?.batchId;
        if (!trailingBatchId) break;
        const continuation = await props.onLoadGradebookHistory(props.classId, nextCursor);
        if (!continuation.entries.length || continuation.entries[0]?.batchId !== trailingBatchId) break;
        entries = [...entries, ...continuation.entries];
        nextCursor = continuation.nextCursor;
        hasMore = continuation.hasMore;
      }

      setGradebookHistory((current) => append ? [...current, ...entries] : entries);
      setGradebookHistoryCursor(nextCursor);
      setGradebookHistoryHasMore(hasMore);
      if (append) setGradebookHistoryVisibleLimit((current) => current + entries.length);
    } catch (cause) {
      props.onToast(getErrorMessage(cause, 'Gradebook version history could not be loaded.'));
    } finally {
      setGradebookHistoryLoading(false);
    }
  };
  const searchAllGradebookHistory = async () => {
    if (gradebookHistoryLoading || !gradebookHistoryCursor) return;
    setGradebookHistoryLoading(true);
    setGradebookHistoryScanning(true);
    let cursor: GradebookHistoryCursor | null = gradebookHistoryCursor;
    try {
      while (cursor) {
        const page = await props.onLoadGradebookHistory(props.classId, cursor);
        setGradebookHistory((current) => [...current, ...page.entries]);
        cursor = page.nextCursor;
        setGradebookHistoryCursor(cursor);
        setGradebookHistoryHasMore(page.hasMore);
        if (!page.hasMore) break;
      }
    } catch (cause) {
      props.onToast(getErrorMessage(cause, 'The full version history search could not be completed.'));
    } finally {
      setGradebookHistoryScanning(false);
      setGradebookHistoryLoading(false);
    }
  };
  const rowOffsetsRef = useRef<number[]>([0]);
  const queueRowMeasurement = useCallback((enrollmentId: string, height: number) => {
    if (!Number.isFinite(height) || height <= 0) return;
    pendingRowHeightsRef.current.set(enrollmentId, height);
    if (rowHeightFrameRef.current != null || typeof requestAnimationFrame === 'undefined') return;
    rowHeightFrameRef.current = requestAnimationFrame(() => {
      rowHeightFrameRef.current = null;
      const measurements = pendingRowHeightsRef.current;
      pendingRowHeightsRef.current = new Map();
      if (!measurements.size) return;
      setRowHeightModel((current) => {
        let changed = false;
        let baseline = current.baseline;
        if (baseline == null) {
          const counts = new Map<number, number>();
          for (const measuredHeight of measurements.values()) {
            const roundedHeight = Math.round(measuredHeight * 2) / 2;
            counts.set(roundedHeight, (counts.get(roundedHeight) ?? 0) + 1);
          }
          baseline = [...counts].sort((left, right) => right[1] - left[1])[0]?.[0] ?? fullRowHeight;
          changed = true;
        }
        let exceptions = current.exceptions;
        let next: Record<string, number> | null = null;
        for (const [id, measuredHeight] of measurements) {
          const currentException = current.exceptions[id];
          if (Math.abs(measuredHeight - baseline) < 0.5) {
            if (currentException != null) {
              next ??= { ...exceptions };
              delete next[id];
              changed = true;
            }
          } else if (currentException == null || Math.abs(currentException - measuredHeight) >= 0.5) {
            next ??= { ...exceptions };
            next[id] = measuredHeight;
            changed = true;
          }
        }
        if (!changed) return current;
        if (next) exceptions = next;
        return { baseline, exceptions };
      });
    });
  }, [fullRowHeight]);
  const hoveredColumnRootRef = useRef<any>(null);
  const hoveredColumnNodesRef = useRef<any[]>([]);
  const hoveredCurrentNodeRef = useRef<any>(null);
  const hoveredColumnKeysRef = useRef('');
  const pendingColumnHoverRef = useRef<{ root: any; node: any; keys: string } | null>(null);
  const hoverUpdateFrameRef = useRef<number | null>(null);
  const columnHoverPropsCacheRef = useRef(new Map<string, any>());
  const displayStudentsRef = useRef<RosterStudent[]>([]);
  const displayStudentIndexByIdRef = useRef(new Map<string, number>());
  const visibleAssessmentIdsRef = useRef<string[]>([]);
  const visibleAssessmentIndexByIdRef = useRef(new Map<string, number>());
  const horizontalRangeUpdaterRef = useRef<(scrollLeft: number, viewportWidth: number) => void>(() => {});
  const revealAssessmentColumnRef = useRef<(assessmentId: string, enrollmentId: string) => void>(() => {});
  const revealCellRef = useRef<(columnId: string, enrollmentId: string) => void>(() => {});
  const pendingFocusKeyRef = useRef<string | null>(null);
  const horizontalColumnRangeRef = useRef(horizontalColumnRange);
  const gridViewportWidthRef = useRef(gridViewportWidth);
  const horizontalScrollLeftRef = useRef(0);
  const virtualOverscanRows = 2;
  const valueMappings = useMemo(() => new Map<string, { value: string; percentage: number }[]>(
    (gradingSystem.components ?? []).flatMap((component: any) => {
      const definition = component.assessmentDefinition;
      return definition?.scoring?.mode === 'value_mapping' && definition.scoring.mapping ? [[definition.typeId, definition.scoring.mapping]] : [];
    }),
  ), [gradingSystem]);
  const classNumberWidth = 40;
  const studentNameWidth = 136;
  const studentIdWidth = 100;
  const anonymousIdWidth = 76;
  const frozenStudentWidth = (showClassNumber ? classNumberWidth : 0) + (showStudentName ? studentNameWidth : 0) + (showStudentId ? studentIdWidth : 0) + (showAnonymousId ? anonymousIdWidth : 0);
  const showContextMenu = (event: any, actions: GradebookContextAction[]) => {
    if (Platform.OS !== 'web') return;
    event.preventDefault?.();
    event.stopPropagation?.();
    setContextMenu({ x: event.clientX ?? 0, y: event.clientY ?? 0, actions: organizeContextActions(actions) });
  };
  const openConditionalFormatting = (column: FullViewColumn) => {
    setConditionalFormattingTarget(column);
    setConditionalEditingRuleId(null);
    setConditionalOperator('greater_than_or_equal');
    setConditionalValue('');
    setConditionalValueTo('');
    setConditionalFormatMode('highlight');
    setConditionalApplyTo('cell');
    setConditionalColor('#DCFCE7');
    setConditionalScaleColors(['#FECACA', '#FEF3C7', '#BBF7D0']);
    setConditionalBadgeLabel('');
  };
  const editConditionalFormattingRule = (index: number) => {
    const existing = conditionalRules[index];
    if (!existing) return;
    setConditionalEditingRuleId(existing.id ?? null);
    setConditionalOperator(existing.operator ?? 'greater_than_or_equal');
    setConditionalValue(existing.values?.join(', ') ?? (existing.value == null ? '' : String(existing.value)));
    setConditionalValueTo(existing.valueTo == null ? '' : String(existing.valueTo));
    setConditionalFormatMode(existing.colorScale?.mode === 'discrete' ? 'discrete_scale' : existing.colorScale?.mode === 'continuous' ? 'continuous_scale' : existing.badge ? 'badge' : 'highlight');
    setConditionalApplyTo(existing.applyTo ?? 'cell');
    setConditionalColor(existing.style?.backgroundColor ?? existing.colorScale?.stops?.[0]?.color ?? existing.badge?.backgroundColor ?? '#DCFCE7');
    const scaleStops = [...(existing.colorScale?.stops ?? [])].sort((a, b) => a.position - b.position);
    setConditionalScaleColors([scaleStops[0]?.color ?? '#FECACA', scaleStops[1]?.color ?? '#FEF3C7', scaleStops[2]?.color ?? '#BBF7D0']);
    setConditionalBadgeLabel(existing.badge?.label ?? '');
  };
  const saveConditionalFormatting = () => {
    if (!conditionalFormattingTarget) return;
    const numericOperators = new Set<GradebookConditionalFormattingOperator>(['greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'between', 'between_exclusive', 'not_between', 'top_n', 'top_percent', 'std_deviations_above_average', 'std_deviations_above_or_equal_average', 'std_deviations_below_average', 'std_deviations_below_or_equal_average']);
    const value = conditionalValue.trim();
    const parsedValue = numericOperators.has(conditionalOperator) && value !== '' ? Number(value) : value;
    const isColorScale = conditionalFormatMode === 'discrete_scale' || conditionalFormatMode === 'continuous_scale';
    const rule: GradebookConditionalFormattingRule = {
      id: conditionalEditingRuleId ?? `conditional-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      applyTo: conditionalApplyTo,
      columnIds: [conditionalFormattingTarget.id],
      ...(!isColorScale ? { operator: conditionalOperator } : {}),
      ...(!isColorScale && conditionalListOperators.has(conditionalOperator) ? { values: value.split(',').map((part) => part.trim()).filter(Boolean) } : !isColorScale && conditionalValueOperators.has(conditionalOperator) ? { value: parsedValue } : {}),
      ...(!isColorScale && conditionalBetweenOperators.has(conditionalOperator) && conditionalValueTo.trim() ? { valueTo: numericOperators.has(conditionalOperator) ? Number(conditionalValueTo) : conditionalValueTo.trim() } : {}),
      ...(conditionalFormatMode === 'highlight' ? { style: { backgroundColor: conditionalColor } } : {}),
      ...(conditionalFormatMode === 'badge' ? { badge: { label: conditionalBadgeLabel.trim() || 'Match', backgroundColor: conditionalColor, textColor: '#14532D' } } : {}),
      ...(conditionalFormatMode === 'discrete_scale' || conditionalFormatMode === 'continuous_scale' ? { colorScale: { mode: conditionalFormatMode === 'discrete_scale' ? 'discrete' as const : 'continuous' as const, stops: [{ position: 0, color: conditionalScaleColors[0] }, { position: 0.5, color: conditionalScaleColors[1] }, { position: 1, color: conditionalScaleColors[2] }] } } : {}),
    };
    setConditionalRules((current) => {
      const next = conditionalEditingRuleId
        ? current.map((item) => item.id === conditionalEditingRuleId ? rule : item)
        : [...current, rule];
      props.onConditionalFormattingRulesChange?.(next);
      return next;
    });
    setConditionalEditingRuleId(null);
    setConditionalFormattingTarget(null);
  };
  const clearConditionalFormatting = () => {
    if (!conditionalFormattingTarget) return;
    setConditionalRules((current) => {
      const next = current.filter((item) => !item.columnIds?.includes(conditionalFormattingTarget.id));
      props.onConditionalFormattingRulesChange?.(next);
      return next;
    });
    setConditionalFormattingTarget(null);
  };
  const reorderConditionalFormattingRules = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return;
    setConditionalRules((current) => {
      if (fromIndex >= current.length || toIndex >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      props.onConditionalFormattingRulesChange?.(next);
      return next;
    });
  };
  const contextProps = (actions: GradebookContextAction[]) => ({ onContextMenu: (event: any) => showContextMenu(event, actions) } as any);
  const clickContextProps = (actions: GradebookContextAction[]) => ({ onClick: (event: any) => showContextMenu(event, actions), onContextMenu: (event: any) => showContextMenu(event, actions) } as any);
  const clearColumnHover = () => {
    if (hoverUpdateFrameRef.current != null && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(hoverUpdateFrameRef.current);
    hoverUpdateFrameRef.current = null;
    pendingColumnHoverRef.current = null;
    for (const node of hoveredColumnNodesRef.current) node?.classList?.remove('gradebook-column-hovered');
    hoveredColumnNodesRef.current = [];
    hoveredCurrentNodeRef.current?.classList?.remove('gradebook-column-hovered-current');
    hoveredColumnRootRef.current = null;
    hoveredCurrentNodeRef.current = null;
    hoveredColumnKeysRef.current = '';
  };
  const flushColumnHover = () => {
    hoverUpdateFrameRef.current = null;
    const pending = pendingColumnHoverRef.current;
    if (!pending) { clearColumnHover(); return; }
    if (hoveredColumnRootRef.current === pending.root && hoveredColumnKeysRef.current === pending.keys) {
      if (hoveredCurrentNodeRef.current !== pending.node) {
        hoveredCurrentNodeRef.current?.classList?.remove('gradebook-column-hovered-current');
        pending.node?.classList?.add('gradebook-column-hovered-current');
        hoveredCurrentNodeRef.current = pending.node;
      }
      return;
    }
    for (const node of hoveredColumnNodesRef.current) node?.classList?.remove('gradebook-column-hovered');
    const selectors = pending.keys.split(/\s+/).filter(Boolean).flatMap((key) => [
      `[data-gradebook-col="${key}"]`,
      `[data-gradebook-cols~="${key}"]`,
    ]).join(',');
    const nodes = selectors ? Array.from(pending.root.querySelectorAll(selectors)) as any[] : [];
    for (const node of nodes) node.classList?.add('gradebook-column-hovered');
    hoveredCurrentNodeRef.current?.classList?.remove('gradebook-column-hovered-current');
    pending.node?.classList?.add('gradebook-column-hovered-current');
    hoveredColumnNodesRef.current = nodes;
    hoveredColumnRootRef.current = pending.root;
    hoveredCurrentNodeRef.current = pending.node;
    hoveredColumnKeysRef.current = pending.keys;
  };
  const columnHoverProps = useCallback((ids: string[]) => {
    if (Platform.OS !== 'web') return {};
    const cacheKey = ids.join('\u0000');
    const cached = columnHoverPropsCacheRef.current.get(cacheKey);
    if (cached) return cached;
    const keys = ids.map(columnCssKey).join(' ');
    const props = { onMouseEnter: (event: any) => {
      const root = event.currentTarget?.closest?.('[data-gradebook-grid]');
      if (!root) return;
      const node = event.currentTarget;
      pendingColumnHoverRef.current = { root, node, keys };
      if (hoverUpdateFrameRef.current != null) return;
      hoverUpdateFrameRef.current = requestAnimationFrame(flushColumnHover);
    }, onMouseLeave: (event: any) => {
      if (!event.relatedTarget?.closest?.('[data-gradebook-col],[data-gradebook-cols]')) {
        pendingColumnHoverRef.current = null;
        if (hoverUpdateFrameRef.current == null) hoverUpdateFrameRef.current = requestAnimationFrame(flushColumnHover);
      }
    } };
    columnHoverPropsCacheRef.current.set(cacheKey, props);
    return props;
  }, [columnCssKey]);
  const noHeaderSelection = Platform.OS === 'web' ? ({ userSelect: 'none', WebkitUserSelect: 'none' } as any) : null;
  const copyText = async (value: string) => {
    internalClipboardRef.current = value;
    try { await globalThis.navigator?.clipboard?.writeText(value); } catch { /* keep the in-app clipboard available */ }
  };
  const pasteText = async () => {
    try { return await globalThis.navigator?.clipboard?.readText() ?? internalClipboardRef.current; } catch { return internalClipboardRef.current; }
  };
  const orderedAssessments = useMemo(() => {
    const periodSequenceById = new Map<string, number>();
    const periodSequenceByName = new Map<string, number>();
    (gradingSystem.periods ?? []).forEach((period: any, index: number) => {
      periodSequenceById.set(period.id, index);
      periodSequenceByName.set(period.name, index);
    });
    const groupSequenceById = new Map<string, number>((gradingSystem.groups ?? []).map((group: any, index: number) => [group.id, index]));
    const componentSequenceByType = new Map<string, number>((gradingSystem.components ?? []).map((component: any) => [component.assessmentDefinition?.typeId, component.sequence ?? 9999]));
    const sequence = (assessment: FacultyAssessment) => {
      const periodIndex = (assessment.gradingPeriodId ? periodSequenceById.get(assessment.gradingPeriodId) : undefined)
        ?? (assessment.gradingPeriod ? periodSequenceByName.get(assessment.gradingPeriod) : undefined)
        ?? Number.MAX_SAFE_INTEGER;
      const groupId = assessment.gradingGroupId ?? (assessment.moduleNumber == null ? '' : `m${assessment.moduleNumber}`);
      const groupIndex = groupSequenceById.get(groupId) ?? Number.MAX_SAFE_INTEGER;
      const componentType = assessment.gradingTypeId ?? assessment.component;
      const componentIndex = componentType ? componentSequenceByType.get(componentType) ?? 9999 : 9999;
      return [periodIndex, groupIndex, componentIndex, assessment.assessmentDate, assessment.title] as const;
    };
    const decorated = assessments.map((assessment) => ({ assessment, order: sequence(assessment) }));
    decorated.sort((left, right) => left.order[0] - right.order[0] || left.order[1] - right.order[1] || left.order[2] - right.order[2] || left.order[3].localeCompare(right.order[3]) || left.order[4].localeCompare(right.order[4]));
    return decorated.map(({ assessment }) => assessment);
  }, [assessments, gradingSystem]);
  const columnWidths = useMemo(() => new Map(orderedAssessments.map((assessment) => [assessment.id, fullAssessmentColumnWidth(assessment, gradingSystem, workspace, props.values)])), [orderedAssessments, gradingSystem, workspace.students, workspace.scores, workspace.categoricalScores, props.values]);
  const columns = useMemo(() => fullViewColumns(orderedAssessments, gradingSystem, (assessment) => columnWidths.get(assessment.id) ?? 42, hideSingleChildComponentGrades).map((column) => {
    if (column.kind === 'assessment') return column;
    const formattedGradeLength = column.kind === 'final_equivalent'
      ? Math.max(10, gradeDecimalPlaces + 8)
      : column.kind === 'final_status' ? 19 : gradeDecimalPlaces + 4 + (showGradePercentSign ? 1 : 0);
    const contentWidth = Math.max(column.width, 40, Math.ceil(column.leafLabel.length * 6 + 12), Math.ceil(formattedGradeLength * 8 + 8));
    return { ...column, width: contentWidth };
  }), [orderedAssessments, gradingSystem, columnWidths, hideSingleChildComponentGrades, gradeDecimalPlaces, showGradePercentSign]);
  const normalizedHeaderQuery = columnHeaderQuery.trim().toLocaleLowerCase();
  const getVisibleColumns = (source: FullViewColumn[]) => source.filter((column) => {
    if (normalizedHeaderQuery) {
      const searchable = [column.period.label, column.group.label, ...column.componentPath.map((item) => item.name), column.leafLabel, column.assessment?.title, column.assessment?.gradingTypeId, column.kind].filter(Boolean).join(' ').toLocaleLowerCase();
      if (!searchable.includes(normalizedHeaderQuery)) return false;
    }
    if (hideAssessmentInstanceColumns && column.kind === 'assessment') return false;
    if (hideComponentGrades && column.kind === 'component') return false;
    if (hideNonFinalCalculatedGrades && ['component', 'group', 'period', 'non_period'].includes(column.kind)) return false;
    if (hideFinalGradeColumns && ['final', 'final_equivalent', 'final_status'].includes(column.kind)) return false;
    return !Object.values(sectionStates).some((section) => section.columnIds.includes(column.id) && (section.mode === 'hidden' || !section.keepColumnIds.includes(column.id)));
  });
  let visibleColumns = useMemo(() => {
    const visible = getVisibleColumns(columns);
    if (!historyPreviewOverlays.length) return visible;
    const visibleIds = new Set(visible.map((column) => column.id));
    for (const overlay of historyPreviewOverlays) visibleIds.add(overlay.columnId);
    return columns.filter((column) => visibleIds.has(column.id));
  }, [columns, sectionStates, hideComponentGrades, hideAssessmentInstanceColumns, hideNonFinalCalculatedGrades, hideFinalGradeColumns, normalizedHeaderQuery, historyPreviewOverlays]);
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    let style = document.getElementById('gradebook-hover-styles') as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement('style');
      style.id = 'gradebook-hover-styles';
      document.head.appendChild(style);
    }
    style.textContent = [
      `[data-gradebook-grid] [data-gradebook-row]:hover [data-gradebook-hover-cell]:not([data-gradebook-preview="true"]),[data-gradebook-grid] [data-gradebook-row]:hover [data-gradebook-hover-cell]:not([data-gradebook-preview="true"]) :is(input,button,[role="button"]):not([data-gradebook-score-control="true"]){background-color:#F8FAFD!important}`,
      `[data-gradebook-grid] [data-gradebook-col].gradebook-column-hovered:not([data-gradebook-preview="true"]),[data-gradebook-grid] [data-gradebook-cols].gradebook-column-hovered:not([data-gradebook-preview="true"]),[data-gradebook-grid] [data-gradebook-col].gradebook-column-hovered:not([data-gradebook-preview="true"]) :is(input,button,[role="button"]):not([data-gradebook-score-control="true"]),[data-gradebook-grid] [data-gradebook-cols].gradebook-column-hovered:not([data-gradebook-preview="true"]) :is(input,button,[role="button"]):not([data-gradebook-score-control="true"]),[data-gradebook-grid] [data-gradebook-row]:hover [data-gradebook-hover-cell].gradebook-column-hovered:not([data-gradebook-preview="true"]),[data-gradebook-grid] [data-gradebook-row]:hover [data-gradebook-hover-cell].gradebook-column-hovered:not([data-gradebook-preview="true"]) :is(input,button,[role="button"]):not([data-gradebook-score-control="true"]){background-color:#F6F9FE!important}`,
      `[data-gradebook-grid] .gradebook-column-hovered-current:not([data-gradebook-preview="true"]),[data-gradebook-grid] .gradebook-column-hovered-current:not([data-gradebook-preview="true"]) :is(input,button,[role="button"]):not([data-gradebook-score-control="true"]),[data-gradebook-grid] [data-gradebook-row]:hover [data-gradebook-hover-cell].gradebook-column-hovered-current:not([data-gradebook-preview="true"]),[data-gradebook-grid] [data-gradebook-row]:hover [data-gradebook-hover-cell].gradebook-column-hovered-current:not([data-gradebook-preview="true"]) :is(input,button,[role="button"]):not([data-gradebook-score-control="true"]){background-color:#EEF4FF!important}`,
      `[data-gradebook-grid] [data-gradebook-row]:hover [data-gradebook-hover-cell][style*="--gradebook-format-color"]:not([data-gradebook-preview="true"]),[data-gradebook-grid] [data-gradebook-row]:hover [data-gradebook-hover-cell][style*="--gradebook-format-color"]:not([data-gradebook-preview="true"]) :is(input,button,[role="button"]):not([data-gradebook-score-control="true"]){background-color:color-mix(in srgb,var(--gradebook-format-color) 82%,#F8FAFD 18%)!important}`,
      `[data-gradebook-grid] [data-gradebook-col].gradebook-column-hovered[style*="--gradebook-format-color"]:not([data-gradebook-preview="true"]),[data-gradebook-grid] [data-gradebook-cols].gradebook-column-hovered[style*="--gradebook-format-color"]:not([data-gradebook-preview="true"]),[data-gradebook-grid] [data-gradebook-col].gradebook-column-hovered[style*="--gradebook-format-color"]:not([data-gradebook-preview="true"]) :is(input,button,[role="button"]):not([data-gradebook-score-control="true"]),[data-gradebook-grid] [data-gradebook-cols].gradebook-column-hovered[style*="--gradebook-format-color"]:not([data-gradebook-preview="true"]) :is(input,button,[role="button"]):not([data-gradebook-score-control="true"]),[data-gradebook-grid] [data-gradebook-row]:hover [data-gradebook-hover-cell].gradebook-column-hovered[style*="--gradebook-format-color"]:not([data-gradebook-preview="true"]),[data-gradebook-grid] [data-gradebook-row]:hover [data-gradebook-hover-cell].gradebook-column-hovered[style*="--gradebook-format-color"]:not([data-gradebook-preview="true"]) :is(input,button,[role="button"]):not([data-gradebook-score-control="true"]){background-color:color-mix(in srgb,var(--gradebook-format-color) 82%,#F6F9FE 18%)!important}`,
      `[data-gradebook-grid] .gradebook-column-hovered-current[style*="--gradebook-format-color"]:not([data-gradebook-preview="true"]),[data-gradebook-grid] .gradebook-column-hovered-current[style*="--gradebook-format-color"]:not([data-gradebook-preview="true"]) :is(input,button,[role="button"]):not([data-gradebook-score-control="true"]),[data-gradebook-grid] [data-gradebook-row]:hover [data-gradebook-hover-cell].gradebook-column-hovered-current[style*="--gradebook-format-color"]:not([data-gradebook-preview="true"]),[data-gradebook-grid] [data-gradebook-row]:hover [data-gradebook-hover-cell].gradebook-column-hovered-current[style*="--gradebook-format-color"]:not([data-gradebook-preview="true"]) :is(input,button,[role="button"]):not([data-gradebook-score-control="true"]){background-color:color-mix(in srgb,var(--gradebook-format-color) 65%,#EEF4FF 35%)!important}`,
    ].join('');
  }, []);
  const columnsById = useMemo(() => new Map(columns.map((column) => [column.id, column])), [columns]);
  const conditionalFormattingRulesByColumn = useMemo(() => new Map(columns.map((column) => [column.id, conditionalRules.filter((rule) => (!rule.columnIds?.length || rule.columnIds.includes(column.id)) && (!rule.columnKinds?.length || rule.columnKinds.includes(column.kind)))])), [columns, conditionalRules]);
  const conditionalFormattingRowColumnsByRule = useMemo(() => new Map(conditionalRules.filter((rule) => rule.applyTo === 'row').map((rule) => [rule.id ?? '', columns.filter((column) => (!rule.columnIds?.length || rule.columnIds.includes(column.id)) && (!rule.columnKinds?.length || rule.columnKinds.includes(column.kind)))])), [columns, conditionalRules]);
  const hiddenSectionCount = Object.values(sectionStates).filter((section) => section.mode === 'hidden').length;
  const collapsedSectionCount = Object.values(sectionStates).filter((section) => section.mode === 'collapsed').length;
  const hiddenHeaderLevelCount = hiddenHeaderLevels.size;
  let tableWidth = frozenStudentWidth + visibleColumns.reduce((total, column) => total + column.width, 0);
  const studentIds = useMemo(() => workspace.students.map((student) => student.enrollmentId).join('|'), [workspace.students]);
  // Use the observed row height. Student IDs and wrapped headers can make rows
  // much taller than the 22px fallback; sizing from that fallback mounts several
  // screens of unnecessary cells for the common wrapped-row case.
  const estimatedRowHeight = rowHeightModel.baseline ?? fullRowHeight;
  const virtualWindowSize = Math.max(20, Math.ceil(560 / estimatedRowHeight) + virtualOverscanRows * 2);
  const gradeCalculationStart = props.paginationEnabled ? (props.page - 1) * 10 : virtualStartIndex;
  const gradeCalculationCount = props.paginationEnabled ? 10 : virtualWindowSize;
  const gradeCalculationEnd = Math.min(props.allStudents.length, gradeCalculationStart + gradeCalculationCount);
  const studentIdentityKeys = ['student_class_number', 'student_name', 'student_id', 'student_anonymous_id'];
  const needsAllGradeResults = Object.keys(rowFilters).some((key) => !studentIdentityKeys.includes(key))
    || (!!headerSort && !studentIdentityKeys.includes(headerSort.key));
  const needsComputedRowValues = Object.keys(rowFilters).some((key) => !studentIdentityKeys.includes(key))
    || (!!headerSort && !studentIdentityKeys.includes(headerSort.key));
  const studentsToCalculate = useMemo(() => needsAllGradeResults
    ? props.allStudents
    : props.allStudents.slice(gradeCalculationStart, gradeCalculationEnd), [needsAllGradeResults, props.allStudents, gradeCalculationStart, gradeCalculationEnd]);
  const gradeResultsCacheRef = useRef<{
    workspace: ClassWorkspace;
    gradingSystem: any;
    studentIds: string;
    results: Map<string, { signature: string; result: ReturnType<typeof calculateFullViewGrades> }>;
  } | null>(null);
  const pendingValuesByStudent = useMemo(() => {
    const pendingByStudent = new Map<string, [string, string][]>();
    for (const [key, value] of Object.entries(props.values)) {
      const separator = key.indexOf(':');
      if (separator < 0) continue;
      const enrollmentId = key.slice(0, separator);
      const entries = pendingByStudent.get(enrollmentId) ?? [];
      entries.push([key, value]);
      pendingByStudent.set(enrollmentId, entries);
    }
    for (const entries of pendingByStudent.values()) entries.sort(([left], [right]) => left.localeCompare(right));
    return pendingByStudent;
  }, [props.values]);
  const gradeResults = useMemo(() => {
    let cachedResults = gradeResultsCacheRef.current;
    if (!cachedResults || cachedResults.workspace !== workspace || cachedResults.gradingSystem !== gradingSystem || cachedResults.studentIds !== studentIds) {
      cachedResults = { workspace, gradingSystem, studentIds, results: new Map() };
    }
    const nextResults = new Map(cachedResults.results);
    const visibleResults = new Map<string, ReturnType<typeof calculateFullViewGrades>>();
    for (const student of studentsToCalculate) {
      const pending = pendingValuesByStudent.get(student.enrollmentId) ?? [];
      const signature = JSON.stringify([pending, missingScoreHandling]);
      const cached = cachedResults.results.get(student.enrollmentId);
      const result = cached?.signature === signature
        ? cached.result
        : calculateFullViewGrades(workspace, student.enrollmentId, gradingSystem, props.values, missingScoreHandling);
      nextResults.set(student.enrollmentId, { signature, result });
      visibleResults.set(student.enrollmentId, result);
    }
    gradeResultsCacheRef.current = { workspace, gradingSystem, studentIds, results: nextResults };
    return visibleResults;
  }, [studentIds, workspace, gradingSystem, props.values, pendingValuesByStudent, props.allStudents, missingScoreHandling, studentsToCalculate, virtualStartIndex, props.paginationEnabled, props.page, headerSort, rowFilters]);
  const conditionalFormattingStats = useMemo(() => {
    const result = new Map<string, ConditionalColumnStats>();
    const rules = conditionalRules;
    const needsStats = (column: FullViewColumn) => rules.some((rule) => {
      const applies = (!rule.columnIds?.length || rule.columnIds.includes(column.id)) && (!rule.columnKinds?.length || rule.columnKinds.includes(column.kind));
      return applies && (conditionalGlobalOperators.has(rule.operator) || !!rule.colorScale);
    });
    const gradeCache = new Map<string, ReturnType<typeof calculateFullViewGrades>>();
    const gradeFor = (student: RosterStudent) => {
      let grade = gradeCache.get(student.enrollmentId);
      if (!grade) {
        const signature = JSON.stringify([pendingValuesByStudent.get(student.enrollmentId) ?? [], missingScoreHandling]);
        const cached = gradeResultsCacheRef.current?.results.get(student.enrollmentId);
        if (cached?.signature === signature) grade = cached.result;
      }
      if (!grade) {
        grade = calculateFullViewGrades(workspace, student.enrollmentId, gradingSystem, props.values, missingScoreHandling);
        const signature = JSON.stringify([pendingValuesByStudent.get(student.enrollmentId) ?? [], missingScoreHandling]);
        gradeResultsCacheRef.current?.results.set(student.enrollmentId, { signature, result: grade });
      }
      gradeCache.set(student.enrollmentId, grade);
      return grade;
    };
    for (const column of columns) {
      if (!needsStats(column)) continue;
      const values: unknown[] = [];
      for (const student of props.allStudents) {
        if (column.assessment) {
          const assessment = column.assessment;
          const stored = storedAssessmentValue(workspace, student.enrollmentId, assessment.id);
          const value = props.values[`${student.enrollmentId}:${assessment.id}`] ?? (stored == null ? '' : String(stored));
          const mapping = valueMappings.get(assessment.gradingTypeId ?? assessment.component);
          const mapped = mapping?.find((option) => String(option.value) === value)?.percentage;
          values.push(mapped ?? (value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : value));
        } else {
          values.push(displayedFullViewColumnValue(column, student.enrollmentId, gradeFor(student), workspace, props.values, gradingSystem, calculatedCellDisplay));
        }
      }
      const frequencies = new Map<string, number>();
      const numeric: number[] = [];
      for (const value of values) {
        const text = conditionalText(value).toLocaleLowerCase();
        if (text && text !== '—') frequencies.set(text, (frequencies.get(text) ?? 0) + 1);
        const number = conditionalNumber(value);
        if (number != null) numeric.push(number);
      }
      numeric.sort((a, b) => b - a);
      const mean = numeric.length ? numeric.reduce((sum, value) => sum + value, 0) / numeric.length : null;
      const deviation = mean == null ? null : Math.sqrt(numeric.reduce((sum, value) => sum + (value - mean) ** 2, 0) / numeric.length);
      let min: number | null = null;
      let max: number | null = null;
      for (const value of numeric) { min = min == null ? value : Math.min(min, value); max = max == null ? value : Math.max(max, value); }
      result.set(column.id, { count: values.length, numeric, frequencies, mean, deviation, min, max });
    }
    return result;
  }, [conditionalRules, columns, props.allStudents, workspace, gradingSystem, props.values, pendingValuesByStudent, missingScoreHandling, valueMappings, calculatedCellDisplay]);
  const rowValuesCacheRef = useRef(new Map<string, { signature: string; values: Record<string, string> }>());
  const rowValuesByStudent = useMemo(() => {
    const grouped = new Map<string, [string, string][]>();
    for (const [key, value] of Object.entries(props.values)) {
      const separator = key.indexOf(':');
      if (separator < 0) continue;
      const enrollmentId = key.slice(0, separator);
      const entries = grouped.get(enrollmentId) ?? [];
      entries.push([key, value]);
      grouped.set(enrollmentId, entries);
    }
    const result = new Map<string, Record<string, string>>();
    const nextCache = new Map(rowValuesCacheRef.current);
    for (const [enrollmentId, entries] of grouped) {
      const signature = JSON.stringify(entries);
      const cached = rowValuesCacheRef.current.get(enrollmentId);
      if (cached?.signature === signature) result.set(enrollmentId, cached.values);
      else {
        const values = Object.fromEntries(entries);
        nextCache.set(enrollmentId, { signature, values });
        result.set(enrollmentId, values);
      }
    }
    rowValuesCacheRef.current = nextCache;
    return result;
  }, [props.values]);
  const rowValue = useCallback((student: RosterStudent, key: string) => {
    if (key === 'student_class_number') return student.classNumber ?? '';
    if (key === 'student_name') return student.name ?? '';
    if (key === 'student_id') return student.institutionalId ?? '';
    const column = columnsById.get(key);
    if (!column) return '';
    return displayedFullViewColumnValue(column, student.enrollmentId, gradeResults.get(student.enrollmentId) ?? calculateFullViewGrades(workspace, student.enrollmentId, gradingSystem, props.values, missingScoreHandling), workspace, props.values, gradingSystem, calculatedCellDisplay);
  }, [columnsById, needsComputedRowValues ? gradeResults : null, needsComputedRowValues ? workspace : null, needsComputedRowValues ? gradingSystem : null, needsComputedRowValues ? props.values : null, needsComputedRowValues ? missingScoreHandling : null, needsComputedRowValues ? calculatedCellDisplay : null]);
  const activeRowValues = useMemo(() => {
    const keys = [...new Set([...Object.keys(rowFilters), ...(headerSort ? [headerSort.key] : [])])];
    const result = new Map<string, Map<string, unknown>>();
    if (!keys.length) return result;
    for (const student of props.allStudents) result.set(student.enrollmentId, new Map(keys.map((key) => [key, rowValue(student, key)])));
    return result;
  }, [props.allStudents, rowFilters, headerSort, rowValue]);
  const activeRowValue = (student: RosterStudent, key: string) => {
    const values = activeRowValues.get(student.enrollmentId);
    return values?.has(key) ? values.get(key) : rowValue(student, key);
  };
  const filteredStudents = useMemo(() => Object.keys(rowFilters).length ? props.allStudents.filter((student) => Object.entries(rowFilters).every(([key, filter]) => {
    const raw = String(activeRowValue(student, key) ?? '').trim();
    const actual = raw.toLocaleLowerCase();
    const expected = filter.value.trim().toLocaleLowerCase();
    switch (filter.operator) {
      case 'not_equals': case 'is_not': return actual !== expected;
      case 'contains': return actual.includes(expected);
      case 'greater_than': return raw !== '' && Number.parseFloat(raw.replace('%', '')) > Number(filter.value);
      case 'less_than': return raw !== '' && Number.parseFloat(raw.replace('%', '')) < Number(filter.value);
      case 'greater_than_or_equal': return raw !== '' && Number.parseFloat(raw.replace('%', '')) >= Number(filter.value);
      case 'less_than_or_equal': return raw !== '' && Number.parseFloat(raw.replace('%', '')) <= Number(filter.value);
      case 'is_empty': return raw === '' || raw === '—';
      case 'is_not_empty': return raw !== '' && raw !== '—';
      default: return actual === expected;
    }
  })) : props.allStudents, [props.allStudents, rowFilters, activeRowValues, rowValue]);
  const sortedStudents = useMemo(() => headerSort ? [...filteredStudents].sort((a, b) => {
    const left = String(activeRowValue(a, headerSort.key) ?? '').trim();
    const right = String(activeRowValue(b, headerSort.key) ?? '').trim();
    const leftNumber = Number.parseFloat(left.replace('%', '')); const rightNumber = Number.parseFloat(right.replace('%', ''));
    const comparison = left && right && Number.isFinite(leftNumber) && Number.isFinite(rightNumber) ? leftNumber - rightNumber : left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
    return headerSort.direction === 'asc' ? comparison : -comparison;
  }) : filteredStudents, [filteredStudents, headerSort, activeRowValues, rowValue]);
  const anonymizedIds = useMemo(() => {
    const used = new Set<string>();
    return new Map(workspace.students.map((student) => {
      let anonymousId = '';
      do { anonymousId = `S-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; } while (used.has(anonymousId));
      used.add(anonymousId);
      return [student.enrollmentId, anonymousId] as const;
    }));
  }, [workspace.students]);
  const rowHash = (id: string) => {
    let hash = Math.floor(randomOrderSeed * 2_147_483_647) || 1;
    for (let index = 0; index < id.length; index += 1) hash = Math.imul(hash ^ id.charCodeAt(index), 16777619);
    return hash >>> 0;
  };
  const orderedStudents = useMemo(() => {
    const previewStudentIds = new Set(historyPreviewOverlays.map((overlay) => overlay.enrollmentId));
    const includedIds = new Set(sortedStudents.map((student) => student.enrollmentId));
    const previewStudents = workspace.students.filter((student) => previewStudentIds.has(student.enrollmentId) && !includedIds.has(student.enrollmentId));
    const withPreview = [...sortedStudents, ...previewStudents];
    return randomizeRows ? withPreview.sort((a, b) => rowHash(a.enrollmentId) - rowHash(b.enrollmentId)) : withPreview;
  }, [randomizeRows, randomOrderSeed, sortedStudents, historyPreviewOverlays, workspace.students]);
  const localPageCount = Math.max(1, Math.ceil(orderedStudents.length / 10));
  const orderedStudentIndexById = useMemo(() => new Map(orderedStudents.map((student, index) => [student.enrollmentId, index])), [orderedStudents]);
  const cellOverlayEdges = useMemo(() => {
    const edges = new Map<string, GradebookOverlayEdges>();
    if (!cellOverlayByKey.size) return edges;
    const rowIndexById = orderedStudentIndexById;
    const columnIndexById = new Map(visibleColumns.map((column, index) => [column.id, index]));
    const neighbors = (rowIndex: number, columnIndex: number, overlay: GradebookCellOverlay) => {
      if (rowIndex < 0 || rowIndex >= orderedStudents.length || columnIndex < 0 || columnIndex >= visibleColumns.length) return false;
      const key = `${orderedStudents[rowIndex].enrollmentId}:${visibleColumns[columnIndex].id}`;
      const adjacent = cellOverlayByKey.get(key);
      return !!adjacent && adjacent.mode === overlay.mode && adjacent.mode !== 'value' && adjacent.color === overlay.color;
    };
    for (const [key, overlay] of cellOverlayByKey) {
      if (overlay.mode === 'value') continue;
      const rowIndex = rowIndexById.get(overlay.enrollmentId);
      const columnIndex = columnIndexById.get(overlay.columnId);
      if (rowIndex == null || columnIndex == null) continue;
      edges.set(key, {
        top: !neighbors(rowIndex - 1, columnIndex, overlay),
        right: !neighbors(rowIndex, columnIndex + 1, overlay),
        bottom: !neighbors(rowIndex + 1, columnIndex, overlay),
        left: !neighbors(rowIndex, columnIndex - 1, overlay),
      });
    }
    return edges;
  }, [cellOverlayByKey, orderedStudentIndexById, orderedStudents, visibleColumns]);
  const displayStudents = props.paginationEnabled ? orderedStudents.slice((props.page - 1) * 10, props.page * 10) : orderedStudents;
  const rowOffsets = useMemo(() => {
    const offsets = [0];
    const baseline = rowHeightModel.baseline ?? fullRowHeight;
    for (const student of displayStudents) offsets.push(offsets[offsets.length - 1] + (rowHeightModel.exceptions[student.enrollmentId] ?? baseline));
    return offsets;
  }, [displayStudents, rowHeightModel, fullRowHeight]);
  useEffect(() => () => {
    if (rowHeightFrameRef.current != null && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(rowHeightFrameRef.current);
  }, []);
  rowOffsetsRef.current = rowOffsets;
  const scoreInputRefs = useRef(new Map<string, any>());
  const studentByEnrollmentId = useMemo(() => new Map(props.allStudents.map((student) => [student.enrollmentId, student])), [props.allStudents]);
  const visibleAssessmentIds = useMemo(() => visibleColumns.flatMap((column) => column.kind === 'assessment' && column.assessment ? [column.assessment.id] : []), [visibleColumns]);
  const visibleAssessmentIndexById = useMemo(() => new Map(visibleAssessmentIds.map((id, index) => [id, index])), [visibleAssessmentIds]);
  const navigateScoreInput = useCallback((event: any, enrollmentId: string, assessmentId: string, value: string) => {
    if (Platform.OS !== 'web') return;
    const key = event.key ?? event.nativeEvent?.key;
    let targetStudentIndex = displayStudentIndexByIdRef.current.get(enrollmentId) ?? -1;
    let targetAssessmentIndex = visibleAssessmentIndexByIdRef.current.get(assessmentId) ?? -1;
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      targetStudentIndex += key === 'ArrowUp' ? -1 : 1;
    } else if (key === 'ArrowLeft' || key === 'ArrowRight') {
      const input = event.target ?? event.currentTarget;
      const selectionStart = typeof input?.selectionStart === 'number' ? input.selectionStart : null;
      const selectionEnd = typeof input?.selectionEnd === 'number' ? input.selectionEnd : null;
      const liveValue = typeof input?.value === 'string' ? input.value : value;
      const atBoundary = selectionStart == null || (key === 'ArrowLeft'
        ? selectionStart === 0 && selectionEnd === selectionStart
        : selectionEnd === liveValue.length && selectionStart === selectionEnd);
      if (!atBoundary) return;
      targetAssessmentIndex += key === 'ArrowLeft' ? -1 : 1;
    } else return;
    const targetStudent = displayStudentsRef.current[targetStudentIndex];
    const targetAssessmentId = visibleAssessmentIdsRef.current[targetAssessmentIndex];
    if (!targetStudent || !targetAssessmentId) return;
    const nextInput = scoreInputRefs.current.get(`${targetStudent.enrollmentId}:${targetAssessmentId}`);
    if (!nextInput) {
      event.preventDefault?.();
      revealAssessmentColumnRef.current(targetAssessmentId, targetStudent.enrollmentId);
      return;
    }
    event.preventDefault?.();
    nextInput.focus?.();
  }, []);
  const studentColumnOffsets = {
    classNumber: 0,
    name: showClassNumber ? classNumberWidth : 0,
    id: (showClassNumber ? classNumberWidth : 0) + (showStudentName ? studentNameWidth : 0),
    anonymous: (showClassNumber ? classNumberWidth : 0) + (showStudentName ? studentNameWidth : 0) + (showStudentId ? studentIdWidth : 0),
  };
  const scoreMapping = bulkScoreAssessment ? valueMappingForType(gradingSystem, bulkScoreAssessment.gradingTypeId ?? bulkScoreAssessment.component) : null;
  const bulkScoreError = bulkScoreValue.trim() ? validateAssessmentValue(bulkScoreValue, bulkScoreAssessment?.maximumScore ?? 0, scoreMapping ?? undefined) : undefined;
  const filterOperators = filterTarget?.kind === 'number'
    ? [{ label: 'Equals', value: 'equals' }, { label: 'Does not equal', value: 'not_equals' }, { label: 'Greater than', value: 'greater_than' }, { label: 'Greater than or equal to', value: 'greater_than_or_equal' }, { label: 'Less than', value: 'less_than' }, { label: 'Less than or equal to', value: 'less_than_or_equal' }, { label: 'Is empty', value: 'is_empty' }, { label: 'Is not empty', value: 'is_not_empty' }]
    : filterTarget?.kind === 'category'
      ? [{ label: 'Is', value: 'equals' }, { label: 'Is not', value: 'is_not' }, { label: 'Is empty', value: 'is_empty' }, { label: 'Is not empty', value: 'is_not_empty' }]
      : [{ label: 'Contains', value: 'contains' }, { label: 'Equals', value: 'equals' }, { label: 'Does not equal', value: 'not_equals' }, { label: 'Is empty', value: 'is_empty' }, { label: 'Is not empty', value: 'is_not_empty' }];
  const openFilter = (target: GradebookFilterTarget) => {
    const existing = rowFilters[target.key];
    setFilterTarget(target);
    setFilterOperator(existing?.operator ?? (target.kind === 'text' ? 'contains' : 'equals'));
    setFilterValue(existing?.value ?? '');
  };
  const sortFilterActions = (target: GradebookFilterTarget): GradebookContextAction[] => [
    { label: `Sort ${target.label} ascending`, onSelect: () => { setHeaderSort({ key: target.key, label: target.label, direction: 'asc' }); props.onPageChange(() => 1); } },
    { label: `Sort ${target.label} descending`, onSelect: () => { setHeaderSort({ key: target.key, label: target.label, direction: 'desc' }); props.onPageChange(() => 1); } },
    { label: `Filter ${target.label}…`, onSelect: () => openFilter(target) },
    ...(rowFilters[target.key] ? [{ label: `Clear ${target.label} filter`, onSelect: () => setRowFilters((current) => { const next = { ...current }; delete next[target.key]; props.onPageChange(() => 1); return next; }) }] : []),
  ];
  const cycleHeaderSort = (target: GradebookFilterTarget) => {
    setHeaderSort((current) => current?.key !== target.key
      ? { key: target.key, label: target.label, direction: 'asc' }
      : current.direction === 'asc' ? { ...current, direction: 'desc' } : null);
    props.onPageChange(() => 1);
  };
  const renderHeaderIndicators = (target: GradebookFilterTarget) => {
    const isSorted = headerSort?.key === target.key;
    const isFiltered = !!rowFilters[target.key];
    const targetColumn = columnsById.get(target.key);
    const hasConditionalFormatting = !!conditionalFormattingRulesByColumn.get(target.key)?.length;
    if (!isSorted && !isFiltered && !hasConditionalFormatting) return null;
    const stop = (event: any) => { event?.stopPropagation?.(); event?.preventDefault?.(); };
    return <View style={styles.fullHeaderIndicators}>
      {isSorted ? <Pressable accessibilityRole="button" accessibilityLabel={`${target.label} sort: ${headerSort?.direction === 'asc' ? 'ascending' : 'descending'}. Click to change sorting.`} onPress={(event: any) => { stop(event); cycleHeaderSort(target); }} {...({ onContextMenu: stop } as any)} style={styles.fullHeaderIndicator}><AppIcon name={headerSort?.direction === 'asc' ? 'sortAscending' : 'sortDescending'} size={12} color={colors.brand} /></Pressable> : null}
      {isFiltered ? <Pressable accessibilityRole="button" accessibilityLabel={`Edit ${target.label} filter`} onPress={(event: any) => { stop(event); openFilter(target); }} {...({ onContextMenu: stop } as any)} style={styles.fullHeaderIndicator}><AppIcon name="filter" size={12} color={colors.brand} /></Pressable> : null}
      {hasConditionalFormatting && targetColumn ? <Pressable accessibilityRole="button" accessibilityLabel={`Conditional formatting for ${target.label}`} onPress={(event: any) => { stop(event); openConditionalFormatting(targetColumn); }} {...({ onContextMenu: stop } as any)} style={styles.fullHeaderIndicator}><AppIcon name="format" size={12} color={colors.brand} /></Pressable> : null}
    </View>;
  };
  const clearSortAndFilters = () => {
    setHeaderSort(null); setRowFilters({});
    props.onStudentQuery(''); props.onStudentFilter('all'); props.onStudentSort('class_number'); props.onPageChange(() => 1);
  };
  const saveCurrentView = () => {
    const name = savedViewName.trim();
    if (!name) return;
    const view: SavedGradebookView = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name,
      studentQuery: props.studentQuery, studentFilter: props.studentFilter, studentSort: props.studentSort, columnHeaderQuery,
      hideComponentGrades, hideAssessmentInstanceColumns, hideNonFinalCalculatedGrades, hideFinalGradeColumns,
      showHierarchyLabels, hideSingleChildComponentGrades, calculatedCellDisplay,
      hiddenHeaderLevels: [...hiddenHeaderLevels], sectionStates, rowFilters, headerSort,
    };
    setSavedViews((current) => [...current, view]);
    setSelectedSavedViewId(view.id);
    setSavedViewName('');
  };
  const applySavedView = () => {
    const view = savedViews.find((item) => item.id === selectedSavedViewId);
    if (!view) return;
    props.onStudentQuery(view.studentQuery);
    props.onStudentFilter(view.studentFilter);
    props.onStudentSort(view.studentSort);
    setColumnHeaderQuery(view.columnHeaderQuery);
    setHideComponentGrades(view.hideComponentGrades);
    setHideAssessmentInstanceColumns(view.hideAssessmentInstanceColumns);
    setHideNonFinalCalculatedGrades(view.hideNonFinalCalculatedGrades);
    setHideFinalGradeColumns(view.hideFinalGradeColumns);
    setShowHierarchyLabels(view.showHierarchyLabels);
    setHideSingleChildComponentGrades(view.hideSingleChildComponentGrades);
    setCalculatedCellDisplay(view.calculatedCellDisplay);
    setHiddenHeaderLevels(new Set(view.hiddenHeaderLevels));
    setSectionStates(view.sectionStates);
    setRowFilters(view.rowFilters);
    setHeaderSort(view.headerSort);
    props.onPageChange(() => 1);
  };
  const hierarchyRows = useMemo(() => fullAssessmentHeaderRows(visibleColumns).filter((row) => !hiddenHeaderLevels.has(row.level)), [visibleColumns, hiddenHeaderLevels]);
  const importAssessmentColumns = useMemo(() => {
    const seen = new Map<string, number>();
    return columns.filter((column) => column.kind === 'assessment' && column.assessment).map((column) => {
      const assessment = column.assessment!;
      const base = [column.period.label, column.group.label, ...column.componentPath.map((item) => item.name), `${assessment.title} · ${assessment.maximumScore} · ${assessment.assessmentDate}`].filter(Boolean).join(' | ');
      const count = (seen.get(base) ?? 0) + 1;
      seen.set(base, count);
      return { column, header: count === 1 ? base : `${base} (${count})` };
    });
  }, [columns]);
  const downloadScoreImportTemplate = async () => {
    const sheetRows = [
      ['Student ID', 'Student name', ...importAssessmentColumns.map((item) => item.header)],
      ...workspace.students.map((student) => [student.institutionalId, student.name, ...importAssessmentColumns.map(() => '')]),
    ];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(sheetRows), 'Scores');
    if (Platform.OS === 'web') {
      const output = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
      const url = URL.createObjectURL(new Blob([output], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'gradebook-score-import-template.xlsx'; anchor.click(); URL.revokeObjectURL(url);
    } else {
      const output = XLSX.write(workbook, { bookType: 'xlsx', type: 'base64' });
      const uri = `${FileSystem.cacheDirectory}gradebook-score-import-template.xlsx`;
      await FileSystem.writeAsStringAsync(uri, output, { encoding: FileSystem.EncodingType.Base64 });
      await Sharing.shareAsync(uri, { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', dialogTitle: 'Gradebook score import template' });
    }
  };
  const chooseScoreImportFile = async () => {
    setScoreImporting(true);
    try {
      const picked = await DocumentPicker.getDocumentAsync({ type: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel', 'text/csv', 'text/comma-separated-values'], copyToCacheDirectory: true });
      if (picked.canceled) return;
      const asset = picked.assets[0];
      const response = await fetch(asset.uri);
      const workbook = XLSX.read(await response.arrayBuffer(), { type: 'array', cellDates: false });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = sheet ? XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: '' }) : [];
      const headers = (rows[0] ?? []).map((value) => String(value ?? '').trim());
      const studentIdIndex = headers.findIndex((header) => /^(student\s*id|institutional\s*id)$/i.test(header));
      if (studentIdIndex < 0) throw new Error('The first sheet needs a “Student ID” column. Use the gradebook import template.');
      const assessmentIndexByColumn = new Map<number, typeof importAssessmentColumns[number]>();
      headers.forEach((header, index) => {
        const match = importAssessmentColumns.find((item) => item.header.toLocaleLowerCase() === header.toLocaleLowerCase());
        if (match) assessmentIndexByColumn.set(index, match);
      });
      if (!assessmentIndexByColumn.size) throw new Error('No assessment columns matched. Use the template for this class and keep its assessment headers unchanged.');
      const studentById = new Map(workspace.students.map((student) => [student.institutionalId.trim().toLocaleLowerCase(), student]));
      const seenStudentIds = new Set<string>();
      const previewRows = rows.slice(1).flatMap((cells) => {
        const values = cells as unknown[];
        const rawId = String(values[studentIdIndex] ?? '').trim();
        if (!rawId) return [];
        const normalizedId = rawId.toLocaleLowerCase();
        const student = studentById.get(normalizedId);
        const errors: string[] = [];
        if (!student) errors.push(`Student ID “${rawId}” is not in this class.`);
        if (seenStudentIds.has(normalizedId)) errors.push('Student ID appears more than once in the file.');
        seenStudentIds.add(normalizedId);
        const updates: Record<string, string> = {};
        for (const [columnIndex, target] of assessmentIndexByColumn) {
          const rawValue = String(values[columnIndex] ?? '').trim();
          if (!rawValue) continue;
          const assessment = target.column.assessment!;
          const mapping = valueMappingForType(gradingSystem, assessment.gradingTypeId ?? assessment.component);
          const error = validateAssessmentValue(rawValue, assessment.maximumScore, mapping);
          if (error) errors.push(`${assessment.title}: ${error}`);
          else if (student) updates[`${student.enrollmentId}:${assessment.id}`] = rawValue;
        }
        if (!Object.keys(updates).length && !errors.length) return [];
        return [{ enrollmentId: student?.enrollmentId ?? null, studentLabel: student?.name ?? rawId, updates, errors }];
      });
      const inputCount = previewRows.reduce((sum, row) => sum + Object.keys(row.updates).length, 0);
      setScoreImportPreview({ fileName: asset.name, rows: previewRows, inputCount });
    } catch (cause) {
      props.onToast(getErrorMessage(cause, 'The score file could not be read.'));
    } finally { setScoreImporting(false); }
  };
  const applyScoreImport = () => {
    if (!scoreImportPreview) return;
    const updates = Object.assign({}, ...scoreImportPreview.rows.filter((row) => row.enrollmentId && !row.errors.length).map((row) => row.updates));
    const importedCount = Object.keys(updates).length;
    if (!importedCount) return;
    props.onChangeMany(updates);
    const skipped = scoreImportPreview.rows.filter((row) => row.errors.length).length;
    props.onToast(`Imported ${importedCount} score${importedCount === 1 ? '' : 's'} into the grid${skipped ? `; skipped ${skipped} row${skipped === 1 ? '' : 's'} with issues` : ''}. Review and save the changes.`);
    setScoreImportPreview(null);
    setScoreImportOpen(false);
  };
  const exportFullViewExcel = async () => {
    setExportingExcel(true);
    try {
      const identityColumns: { label: string; width: number; value: (student: RosterStudent) => string }[] = [
        ...(showClassNumber ? [{ label: 'Class #', width: 10, value: (student: RosterStudent) => String(student.classNumber ?? '') }] : []),
        ...(showStudentName ? [{ label: 'Student', width: 24, value: (student: RosterStudent) => student.name ?? '' }] : []),
        ...(showStudentId ? [{ label: 'Student ID', width: 16, value: (student: RosterStudent) => student.institutionalId ?? '' }] : []),
        ...(showAnonymousId ? [{ label: 'Anonymous ID', width: 16, value: (student: RosterStudent) => anonymizedIds.get(student.enrollmentId) ?? '' }] : []),
      ];
      const exportColumns = columns;
      const visibleColumnIds = new Set(visibleColumns.map((column) => column.id));
      const hierarchyHeaderRows = fullAssessmentHeaderRows(exportColumns).filter((row) => !hiddenHeaderLevels.has(row.level));
      const columnHeaders = hierarchyHeaderRows.map((row) => {
        const cells: any[] = Array(identityColumns.length + exportColumns.length).fill('');
        for (const cell of row.cells) cells[identityColumns.length + cell.columnStart] = cell.label;
        return cells;
      });
      identityColumns.forEach((column, index) => { if (columnHeaders[0]) columnHeaders[0][index] = column.label; });
      const rows: any[][] = [...columnHeaders];
      const headerStartRow = 0;
      const merges: any[] = [];
      if (hierarchyHeaderRows.length > 1) identityColumns.forEach((_, index) => merges.push({ s: { r: headerStartRow, c: index }, e: { r: headerStartRow + hierarchyHeaderRows.length - 1, c: index } }));
      const verticallyMergedHeaderKeys = new Set<string>();
      const verticalMergeRanges: { startRow: number; endRow: number; startColumn: number; endColumn: number }[] = [];
      const finalHeaderRowIndex = hierarchyHeaderRows.length - 1;
      const finalHeaderRow = hierarchyHeaderRows[finalHeaderRowIndex];
      if (finalHeaderRow?.level === 'ASSESSMENT / RESULT') {
        for (const cell of finalHeaderRow.cells) {
          if (!cell.label) continue;
          let topRow = finalHeaderRowIndex;
          while (topRow > 0) {
            const priorRow = hierarchyHeaderRows[topRow - 1];
            const priorCellsAreBlank = Array.from({ length: cell.columnEnd - cell.columnStart + 1 }, (_, offset) => {
              const columnIndex = cell.columnStart + offset;
              return priorRow.cells.find((candidate) => candidate.columnStart <= columnIndex && candidate.columnEnd >= columnIndex)?.label === '';
            }).every(Boolean);
            if (!priorCellsAreBlank) break;
            topRow -= 1;
          }
          if (topRow === finalHeaderRowIndex) continue;
          const startColumn = identityColumns.length + cell.columnStart;
          const endColumn = identityColumns.length + cell.columnEnd;
          columnHeaders[topRow][startColumn] = cell.label;
          columnHeaders[finalHeaderRowIndex][startColumn] = '';
          merges.push({ s: { r: topRow, c: startColumn }, e: { r: finalHeaderRowIndex, c: endColumn } });
          verticallyMergedHeaderKeys.add(cell.mergeKey);
          verticalMergeRanges.push({ startRow: topRow, endRow: finalHeaderRowIndex, startColumn, endColumn });
        }
      }
      hierarchyHeaderRows.forEach((row, rowIndex) => row.cells.forEach((cell) => {
        const startColumn = identityColumns.length + cell.columnStart;
        const endColumn = identityColumns.length + cell.columnEnd;
        const overlapsVerticalMerge = verticalMergeRanges.some((range) => rowIndex >= range.startRow && rowIndex <= range.endRow && startColumn <= range.endColumn && endColumn >= range.startColumn);
        if (cell.columnEnd > cell.columnStart && !overlapsVerticalMerge && !(rowIndex === finalHeaderRowIndex && verticallyMergedHeaderKeys.has(cell.mergeKey))) merges.push({ s: { r: headerStartRow + rowIndex, c: startColumn }, e: { r: headerStartRow + rowIndex, c: endColumn } });
      }));
      const componentScopeKey = (componentId: string, scope: { periodId?: string; groupId?: string; nonPeriodOnly?: boolean }) => JSON.stringify([componentId, scope.periodId ?? null, scope.groupId ?? null, Boolean(scope.nonPeriodOnly)]);
      const componentById = new Map<string, any>((gradingSystem.components ?? []).map((component: any) => [component.id, component]));
      const visibleComponentIndexes = new Map<string, number>();
      if (calculatedCellDisplay === 'grade') exportColumns.forEach((column, index) => {
        if (column.kind === 'component' && column.targetId) visibleComponentIndexes.set(componentScopeKey(column.targetId, { periodId: column.periodId, groupId: column.groupId, nonPeriodOnly: column.nonPeriodScope }), index);
      });
      const componentHelpers: { componentId: string; scope: { periodId?: string; groupId?: string; nonPeriodOnly?: boolean }; key: string; label: string }[] = [];
      const traversedComponentScopes = new Set<string>();
      const addComponentHelper = (componentId: string, scope: { periodId?: string; groupId?: string; nonPeriodOnly?: boolean }, stack = new Set<string>()) => {
        const key = componentScopeKey(componentId, scope);
        if (traversedComponentScopes.has(key)) return;
        const component = componentById.get(componentId);
        if (!component || stack.has(componentId)) return;
        traversedComponentScopes.add(key);
        if (!visibleComponentIndexes.has(key)) {
          componentHelpers.push({ componentId, scope, key, label: `${component.name ?? componentId} · ${scope.periodId ?? 'all periods'} · ${scope.groupId ?? (scope.nonPeriodOnly ? 'non-period' : 'all groups')}` });
        }
        if (component.assessmentDefinition) return;
        const refs = [
          ...(component.calculation?.components ?? []),
          ...(component.calculation?.rules ?? []).flatMap((rule: any) => rule.override?.components ?? []),
        ];
        const nextStack = new Set(stack).add(componentId);
        refs.forEach((ref: any) => addComponentHelper(ref.componentId, { ...scope, periodId: ref.periodId ?? scope.periodId }, nextStack));
      };
      exportColumns.forEach((column) => {
        if (column.kind === 'component' && column.targetId) addComponentHelper(column.targetId, { periodId: column.periodId, groupId: column.groupId, nonPeriodOnly: column.nonPeriodScope });
        if (column.kind === 'group' && column.targetId) {
          const root = componentById.get(gradingSystem.calculationRootComponentId);
          const refs = [
            ...(root?.calculation?.components ?? []),
            ...(root?.calculation?.rules ?? []).flatMap((rule: any) => rule.override?.components ?? []),
          ];
          refs.forEach((ref: any) => addComponentHelper(ref.componentId, { periodId: ref.periodId ?? column.periodId, groupId: column.targetId }));
        }
        if (column.kind === 'period' && column.targetId) addComponentHelper(gradingSystem.calculationRootComponentId, { periodId: column.targetId });
        if (column.kind === 'non_period') addComponentHelper(gradingSystem.finalResult?.componentId ?? gradingSystem.calculationRootComponentId, { nonPeriodOnly: true });
      });
      (gradingSystem.periods ?? []).forEach((period: any) => addComponentHelper(gradingSystem.calculationRootComponentId, { periodId: period.id }));
      addComponentHelper(gradingSystem.finalResult?.componentId ?? gradingSystem.calculationRootComponentId, {});
      const componentHelperIndexes = new Map(componentHelpers.map((helper, index) => [helper.key, identityColumns.length + exportColumns.length + index]));
      columnHeaders.forEach((header) => header.push(...componentHelpers.map((helper) => helper.label)));
      const formulaBuilder = createGradingExcelFormulaBuilder(gradingSystem, orderedAssessments, (assessmentId, studentRow) => {
        const columnIndex = exportColumns.findIndex((column) => column.kind === 'assessment' && column.assessment?.id === assessmentId);
        return columnIndex < 0 ? '""' : XLSX.utils.encode_cell({ r: studentRow, c: identityColumns.length + columnIndex });
      }, (componentId, scope, studentRow) => {
        // Visible calculated cells are stored as Excel percentages (fractions
        // such as 0.6 for a 60% grade); schema formulas operate in percentage
        // points (60). Convert visible references back to points before they
        // participate in a parent calculation. Hidden component helpers remain
        // in percentage points and therefore need no conversion.
        const visibleColumnIndex = visibleComponentIndexes.get(componentScopeKey(componentId, scope));
        if (visibleColumnIndex != null) {
          const reference = XLSX.utils.encode_cell({ r: studentRow, c: identityColumns.length + visibleColumnIndex });
          return `IF(${reference}="","",${reference}*100)`;
        }
        if (calculatedCellDisplay === 'grade' && componentId === gradingSystem.calculationRootComponentId && scope.groupId && !scope.periodId) {
          const groupColumnIndex = exportColumns.findIndex((column) => column.kind === 'group' && column.targetId === scope.groupId);
          if (groupColumnIndex >= 0) {
            const reference = XLSX.utils.encode_cell({ r: studentRow, c: identityColumns.length + groupColumnIndex });
            return `IF(${reference}="","",${reference}*100)`;
          }
        }
        const columnIndex = componentHelperIndexes.get(componentScopeKey(componentId, scope));
        return columnIndex == null ? null : XLSX.utils.encode_cell({ r: studentRow, c: columnIndex });
      });
      const componentWeight = (weight: any) => typeof weight === 'number' ? weight : typeof weight?.value === 'number' ? weight.value : weight?.numerator != null && weight?.denominator ? weight.numerator / weight.denominator : 0;
      const componentWeightFormula = (weight: any) => typeof weight === 'number' ? String(weight) : typeof weight?.value === 'number' ? String(weight.value) : weight?.numerator != null && weight?.denominator ? `(${Number(weight.numerator)}/${Number(weight.denominator)})` : '0';
      const directContributionFormula = (column: FullViewColumn, expression: string) => {
        const components = gradingSystem.components ?? [];
        const refsWeight = (refs: any[], mode: string | undefined, match: (ref: any) => boolean) => {
          const ref = refs.find(match);
          if (!ref) return null;
          const denominator = mode === 'absolute' ? '1' : `(${refs.map((item) => componentWeightFormula(item.weight)).join('+')})`;
          return mode === 'absolute' || refs.reduce((sum, item) => sum + componentWeight(item.weight), 0) > 0
            ? `IF(${expression}="","",(${expression})*${componentWeightFormula(ref.weight)}/${denominator})`
            : null;
        };
        if (column.kind === 'component' && column.targetId) {
          const path = column.componentPath;
          const parentId = path.length > 1 ? path[path.length - 2].id : gradingSystem.calculationRootComponentId;
          const parent = components.find((item: any) => item.id === parentId);
          if (parent && parent.id !== column.targetId) {
            const formula = refsWeight(parent.calculation?.components ?? [], parent.calculation?.weightMode, (ref) => ref.componentId === column.targetId && (column.periodId == null || ref.periodId == null || ref.periodId === column.periodId));
            if (formula) return formula;
          }
        }
        if (column.kind === 'period' && column.targetId) {
          const root = components.find((item: any) => item.id === gradingSystem.calculationRootComponentId);
          const formula = refsWeight(root?.calculation?.components ?? [], root?.calculation?.weightMode, (ref) => ref.source === 'period_component' && ref.periodId === column.targetId);
          if (formula) return formula;
        }
        if (column.kind === 'group' && column.targetId) {
          const groups = (gradingSystem.groups ?? []).filter((group: any) => !column.periodId || group.periodIds?.includes?.(column.periodId) || gradingSystem.periods?.find((period: any) => period.id === column.periodId)?.groupIds?.includes(group.id));
          const group = groups.find((item: any) => item.id === column.targetId);
          if (group) {
            const denominator = groups.reduce((sum: number, item: any) => sum + componentWeight(item.weight), 0);
            const denominatorFormula = `(${groups.map((item: any) => componentWeightFormula(item.weight)).join('+')})`;
            if (denominator > 0) return `IF(${expression}="","",(${expression})*${componentWeightFormula(group.weight)}/${denominatorFormula})`;
          }
        }
        return expression;
      };
      const formulaForColumn = (column: FullViewColumn, row: number, periodFormulas: Map<string, string>) => {
        if (column.kind === 'component' && column.targetId) return formulaBuilder.component(column.targetId, { periodId: column.periodId, groupId: column.groupId, nonPeriodOnly: column.nonPeriodScope }, row);
        if (column.kind === 'group' && column.targetId) return formulaBuilder.component(gradingSystem.calculationRootComponentId, { periodId: column.periodId, groupId: column.targetId }, row);
        if (column.kind === 'period' && column.targetId) return periodFormulas.get(column.targetId) ?? '""';
        if (column.kind === 'non_period') return formulaBuilder.component(gradingSystem.finalResult?.componentId ?? gradingSystem.calculationRootComponentId, { nonPeriodOnly: true }, row);
        if (column.kind === 'final') return formulaBuilder.rawFinal(row);
        if (column.kind === 'final_equivalent') return formulaBuilder.equivalent(row);
        return null;
      };
      const formulaCells: { address: string; formula: string; output: unknown; kind: FullViewColumn['kind']; rowLabel: number; columnLabel: string; sourceRow: number; sheetName?: string }[] = [];
      const helperFormulaCells: { address: string; formula: string; output: unknown; sourceRow: number }[] = [];
      for (const student of orderedStudents) {
        const result = gradeResults.get(student.enrollmentId) ?? calculateFullViewGrades(workspace, student.enrollmentId, gradingSystem, props.values, missingScoreHandling);
        const data: any[] = identityColumns.map((column) => column.value(student));
        const outputValues: unknown[] = [];
        const studentRow = rows.length;
        const periodFormulas = formulaBuilder.periods(studentRow);
        for (const column of exportColumns) {
          const value = displayedFullViewColumnValue(column, student.enrollmentId, result, workspace, props.values, gradingSystem, calculatedCellDisplay);
          outputValues.push(value);
          if (column.kind !== 'assessment' && typeof value === 'number') data.push(Number((value / 100).toFixed(6)));
          else if (column.kind === 'assessment' && typeof value === 'string' && value.trim() && /^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(value.trim())) data.push(Number(value));
          else data.push(value ?? '');
        }
        for (const helper of componentHelpers) {
          const values = helper.scope.groupId
            ? result.groupComponents[helper.scope.groupId]
            : helper.scope.periodId
              ? result.periodComponents[helper.scope.periodId]
              : helper.scope.nonPeriodOnly
                ? result.nonPeriodComponents
                : result.components;
          const value = values?.[helper.componentId];
          data.push(typeof value === 'number' ? Number(value.toFixed(8)) : '');
        }
        rows.push(data);
        exportColumns.forEach((column, columnIndex) => {
          if (column.kind === 'assessment') return;
          let expression = formulaForColumn(column, studentRow, periodFormulas);
          if (!expression) return;
          if (calculatedCellDisplay === 'contribution' && column.kind !== 'final' && column.kind !== 'final_equivalent') expression = directContributionFormula(column, expression);
          const address = XLSX.utils.encode_cell({ r: studentRow, c: identityColumns.length + columnIndex });
          const formula = column.kind === 'final_equivalent' ? expression : `IFERROR((${expression})/100,"")`;
          if (formula.length > 8192) {
            console.warn('[Gradebook Excel export] Formula exceeds Excel limit', {
              gradingSystem: gradingSystem.name,
              studentRow: studentRow - hierarchyHeaderRows.length + 1,
              column: [column.period.label, column.group.label, ...column.componentPath.map((item) => item.name), column.leafLabel].filter(Boolean).join(' · '),
              formulaLength: formula.length,
              formula,
            });
            throw new Error(`The ${column.leafLabel} formula expands to ${formula.length.toLocaleString()} characters. See the browser console for the full formula.`);
          }
          formulaCells.push({
            address,
            formula,
            output: outputValues[columnIndex],
            kind: column.kind,
            rowLabel: studentRow - hierarchyHeaderRows.length + 1,
            columnLabel: [column.period.label, column.group.label, ...column.componentPath.map((item) => item.name), column.leafLabel].filter(Boolean).join(' · '),
            sourceRow: studentRow,
          });
        });
        componentHelpers.forEach((helper, helperIndex) => {
          const helperFormula = formulaBuilder.component(helper.componentId, helper.scope, studentRow);
          const formula = `IFERROR(${helperFormula},"")`;
          if (formula.length > 8192) throw new Error(`A helper formula for ${helper.label} exceeds Excel's 8,192-character limit.`);
          helperFormulaCells.push({
            address: XLSX.utils.encode_cell({ r: studentRow, c: identityColumns.length + exportColumns.length + helperIndex }),
            formula,
            output: data[identityColumns.length + exportColumns.length + helperIndex],
            sourceRow: studentRow,
          });
        });
      }
      let worksheet: any = XLSX.utils.aoa_to_sheet(rows);
      worksheet['!merges'] = merges;
      worksheet['!cols'] = [
        ...identityColumns.map((column) => ({ wch: column.width })),
        ...exportColumns.map((column) => ({ wch: Math.max(8, Math.min(24, Math.round(column.width / 7))), hidden: !visibleColumnIds.has(column.id) })),
        ...componentHelpers.map(() => ({ wch: 12, hidden: true })),
      ];
      for (const item of formulaCells) {
        const cell: any = { f: item.formula, v: item.kind === 'final_equivalent' ? String(item.output ?? '—') : typeof item.output === 'number' ? Number((item.output / 100).toFixed(8)) : '', t: item.kind === 'final_equivalent' || typeof item.output !== 'number' ? 'str' : 'n' };
        if (item.kind !== 'final_equivalent' && typeof item.output === 'number') cell.z = '0.0%';
        worksheet[item.address] = cell;
      }
      for (const item of helperFormulaCells) worksheet[item.address] = { f: item.formula, v: typeof item.output === 'number' ? item.output : '', t: 'n', z: '0.0' };
      worksheet['!rows'] = hierarchyHeaderRows.map(() => ({ hpt: 20 }));
      const border = {
        top: { style: 'thin', color: { rgb: 'CBD5E1' } },
        bottom: { style: 'thin', color: { rgb: 'CBD5E1' } },
        left: { style: 'thin', color: { rgb: 'CBD5E1' } },
        right: { style: 'thin', color: { rgb: 'CBD5E1' } },
      };
      const lastRow = rows.length - 1;
      const lastColumn = identityColumns.length + exportColumns.length + componentHelpers.length - 1;
      const lastVisibleColumn = identityColumns.length + exportColumns.length - 1;
      for (let rowIndex = 0; rowIndex <= lastRow; rowIndex += 1) {
        for (let columnIndex = 0; columnIndex <= lastVisibleColumn; columnIndex += 1) {
          const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
          const cell = worksheet[address] ?? (worksheet[address] = { t: 's', v: '' });
          cell.s = {
            border,
            alignment: rowIndex < hierarchyHeaderRows.length
              ? { horizontal: 'center', vertical: 'center', wrapText: true }
              : { vertical: 'center' },
          };
        }
      }
      for (let rowIndex = headerStartRow + hierarchyHeaderRows.length; rowIndex < rows.length; rowIndex += 1) {
        for (let columnIndex = identityColumns.length; columnIndex < identityColumns.length + exportColumns.length; columnIndex += 1) {
          const column = exportColumns[columnIndex - identityColumns.length];
          if (column.kind !== 'assessment' && typeof rows[rowIndex][columnIndex] === 'number') {
            const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
            if (worksheet[address]) worksheet[address].z = '0.0%';
          }
        }
      }
      // Split large exports across worksheet tabs so the XLSX writer never has to
      // build one oversized worksheet XML string. Every page repeats the headers.
      const headerRowCount = hierarchyHeaderRows.length;
      const maxDataRowsPerSheet = 5000;
      const dataRowCount = Math.max(0, rows.length - headerRowCount);
      const gradebookPageCount = Math.max(1, Math.ceil(dataRowCount / maxDataRowsPerSheet));
      const gradebookSheets: { name: string; sheet: any }[] = [];
      const formulasByPage = new Map<number, typeof formulaCells>();
      for (const item of formulaCells) {
        const pageIndex = Math.floor((item.sourceRow - headerRowCount) / maxDataRowsPerSheet);
        const pageItems = formulasByPage.get(pageIndex) ?? [];
        pageItems.push(item);
        formulasByPage.set(pageIndex, pageItems);
      }
      for (let pageIndex = 0; pageIndex < gradebookPageCount; pageIndex += 1) {
        const pageSourceStart = headerRowCount + pageIndex * maxDataRowsPerSheet;
        const pageSourceEnd = Math.min(rows.length, pageSourceStart + maxDataRowsPerSheet);
        const pageRows = [...rows.slice(0, headerRowCount), ...rows.slice(pageSourceStart, pageSourceEnd)];
        const pageSheet: any = XLSX.utils.aoa_to_sheet(pageRows);
        pageSheet['!cols'] = worksheet['!cols'];
        pageSheet['!rows'] = worksheet['!rows'];
        pageSheet['!merges'] = merges;
        for (let pageRow = 0; pageRow < pageRows.length; pageRow += 1) {
          const sourceRow = pageRow < headerRowCount ? pageRow : pageSourceStart + pageRow - headerRowCount;
          for (let columnIndex = 0; columnIndex <= lastColumn; columnIndex += 1) {
            const sourceAddress = XLSX.utils.encode_cell({ r: sourceRow, c: columnIndex });
            const targetAddress = XLSX.utils.encode_cell({ r: pageRow, c: columnIndex });
            const sourceCell = worksheet[sourceAddress];
            if (sourceCell) {
              const targetCell = { ...sourceCell };
              if (typeof targetCell.f === 'string' && sourceRow >= headerRowCount) {
                const oldExcelRow = sourceRow + 1;
                const newExcelRow = pageRow + 1;
                targetCell.f = targetCell.f.replace(new RegExp(`(?<![\"A-Z0-9_])(\\$?[A-Z]{1,3}\\$?)${oldExcelRow}(?![\\d\"])`, 'g'), `$1${newExcelRow}`);
              }
              pageSheet[targetAddress] = targetCell;
            }
          }
        }
        const pageName = pageIndex === 0 ? 'Full Gradebook' : `Full Gradebook ${pageIndex + 1}`;
        for (const item of formulasByPage.get(pageIndex) ?? []) {
          const localRow = headerRowCount + item.sourceRow - pageSourceStart;
          const oldExcelRow = item.sourceRow + 1;
          const newExcelRow = localRow + 1;
          item.formula = item.formula.replace(new RegExp(`(?<![\"A-Z0-9_])(\\$?[A-Z]{1,3}\\$?)${oldExcelRow}(?![\\d\"])`, 'g'), `$1${newExcelRow}`);
          item.address = XLSX.utils.encode_cell({ r: localRow, c: XLSX.utils.decode_cell(item.address).c });
          item.sheetName = pageName;
          const pageCell = pageSheet[item.address];
          if (pageCell?.f) pageCell.f = item.formula;
        }
        gradebookSheets.push({ name: pageName, sheet: pageSheet });
      }
      worksheet = null;
      rows.length = 0;
      const workbook = XLSX.utils.book_new();
      (workbook as any).Workbook = { CalcPr: { calcMode: 'auto', fullCalcOnLoad: true, forceFullCalc: true } };
      const auditDataStart = 7;
      const auditLastRow = auditDataStart + Math.max(0, formulaCells.length - 1);
      const auditRows: any[][] = [
        ['Formula verification'],
        ['Calculated cells checked', { f: `COUNTA(E${auditDataStart + 1}:E${auditLastRow + 1})`, v: formulaCells.length }],
        ['Passed', { f: `COUNTIF(E${auditDataStart + 1}:E${auditLastRow + 1},"PASS")`, v: formulaCells.length }],
        ['Failed', { f: `COUNTIF(E${auditDataStart + 1}:E${auditLastRow + 1},"FAIL")`, v: 0 }],
        ['Overall', { f: `IF(B4=0,"PASS","FAIL")`, v: 'PASS' }],
        [],
        ['Gradebook row', 'Calculated column', 'Expected APMS value', 'Excel formula value', 'Status'],
      ];
      for (const item of formulaCells) {
        const auditRow = auditRows.length + 1;
        const escapedSheetName = `'${(item.sheetName ?? 'Full Gradebook').replace(/'/g, "''")}'`;
        const actualFormula = `${escapedSheetName}!${item.address}`;
        const expected = item.kind === 'final_equivalent' ? String(item.output ?? '—') : typeof item.output === 'number' ? Number((item.output / 100).toFixed(8)) : '';
        const statusFormula = item.kind === 'final_equivalent'
          ? `IF(EXACT(D${auditRow},C${auditRow}),"PASS","FAIL")`
          : `IF(AND(C${auditRow}="",D${auditRow}=""),"PASS",IFERROR(IF(ABS(D${auditRow}-C${auditRow})<0.000001,"PASS","FAIL"),"FAIL"))`;
        auditRows.push([
          item.rowLabel,
          item.columnLabel,
          expected,
          { f: actualFormula, v: expected, t: item.kind === 'final_equivalent' || typeof item.output !== 'number' ? 'str' : 'n' },
          { f: statusFormula, v: 'PASS' },
        ]);
      }
      const auditBorder = { top: { style: 'thin', color: { rgb: 'CBD5E1' } }, bottom: { style: 'thin', color: { rgb: 'CBD5E1' } }, left: { style: 'thin', color: { rgb: 'CBD5E1' } }, right: { style: 'thin', color: { rgb: 'CBD5E1' } } };
      const auditPageSize = 5000;
      const auditDetails = auditRows.slice(7);
      const auditPageCount = Math.max(1, Math.ceil(auditDetails.length / auditPageSize));
      const auditSheets: { name: string; sheet: any; statusRange: string }[] = [];
      for (let pageIndex = 0; pageIndex < auditPageCount; pageIndex += 1) {
        const offset = pageIndex * auditPageSize;
        const details = auditDetails.slice(offset, offset + auditPageSize);
        const pageRows = pageIndex === 0 ? [...auditRows.slice(0, 7), ...details] : [auditRows[6], ...details];
        const pageName = pageIndex === 0 ? 'Formula verification' : `Formula checks ${pageIndex + 1}`;
        const auditSheet: any = XLSX.utils.aoa_to_sheet(pageRows);
        auditSheet['!cols'] = [{ wch: 14 }, { wch: 52 }, { wch: 22 }, { wch: 22 }, { wch: 12 }];
        for (let row = pageIndex === 0 ? 6 : 0; row < pageRows.length; row += 1) for (let col = 0; col < 5; col += 1) {
          const address = XLSX.utils.encode_cell({ r: row, c: col });
          const cell: any = auditSheet[address] ?? (auditSheet[address] = { t: 's', v: '' });
          cell.s = { border: auditBorder, alignment: row === (pageIndex === 0 ? 6 : 0) ? { horizontal: 'center', vertical: 'center', wrapText: true } : { vertical: 'center' } };
        }
        const firstStatusRow = pageIndex === 0 ? 8 : 2;
        auditSheets.push({ name: pageName, sheet: auditSheet, statusRange: `'${pageName}'!E${firstStatusRow}:E${firstStatusRow + Math.max(0, details.length - 1)}` });
      }
      const statusRanges = auditSheets.map((entry) => entry.statusRange);
      const countArgs = statusRanges.join(',');
      (auditSheets[0].sheet as any)['B2'] = { f: `COUNTA(${countArgs})`, v: formulaCells.length };
      (auditSheets[0].sheet as any)['B3'] = { f: statusRanges.map((range) => `COUNTIF(${range},"PASS")`).join('+') || '0', v: formulaCells.length };
      (auditSheets[0].sheet as any)['B4'] = { f: statusRanges.map((range) => `COUNTIF(${range},"FAIL")`).join('+') || '0', v: 0 };
      (auditSheets[0].sheet as any)['B5'] = { f: 'IF(B4=0,"PASS","FAIL")', v: 'PASS' };
      for (const entry of auditSheets) XLSX.utils.book_append_sheet(workbook, entry.sheet, entry.name);
      for (const page of gradebookSheets) XLSX.utils.book_append_sheet(workbook, page.sheet, page.name);
      const firstGradebookSheet = gradebookSheets[0]?.sheet;
      console.info('[Gradebook Excel export] Formula verification sample', {
        assessmentInputs: exportColumns.flatMap((column, index) => column.kind === 'assessment' ? [{
          column: column.leafLabel,
          cell: XLSX.utils.encode_cell({ r: headerRowCount, c: identityColumns.length + index }),
          value: firstGradebookSheet?.[XLSX.utils.encode_cell({ r: headerRowCount, c: identityColumns.length + index })]?.v,
          type: firstGradebookSheet?.[XLSX.utils.encode_cell({ r: headerRowCount, c: identityColumns.length + index })]?.t,
        }] : []),
        formulas: formulaCells.filter((item) => item.rowLabel === 1).slice(0, 12).map((item) => ({
          column: item.columnLabel,
          expected: item.output,
          cell: item.address,
          formula: item.formula,
          cachedValue: firstGradebookSheet?.[item.address]?.v,
        })),
      });
      (workbook as any).Workbook = {
        ...(workbook as any).Workbook,
        Views: [{ activeTab: 0, firstSheet: 0, tabSelected: [true, ...Array(auditSheets.length + gradebookSheets.length - 1).fill(false)] }],
      };
      const timestamp = new Date().toISOString().replace(/:/g, '-');
      const fileName = `apms-full-gradebook-${timestamp}.xlsx`;
      // SheetJS' shared-string writer calls `.match()` on each string cell
      // value. A malformed/legacy cell can be marked as a string while still
      // holding a number or object, which otherwise fails late with the opaque
      // `a.t.match is not a function` error.
      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName] as Record<string, any>;
        for (const [address, cell] of Object.entries(sheet)) {
          if (address.startsWith('!') || !cell || ['n', 'd', 'b', 'e', 'z'].includes(cell.t) || cell.v == null || typeof cell.v === 'string') continue;
          console.warn('[Gradebook Excel export] Normalizing non-string shared-string cell', {
            sheet: sheetName,
            address,
            valueType: typeof cell.v,
          });
          cell.v = cell.v == null ? '' : typeof cell.v === 'object' ? JSON.stringify(cell.v) : String(cell.v);
        }
      }
      if (Platform.OS === 'web') {
        const output = XLSX.write(workbook, { bookType: 'xlsx', type: 'array', bookSST: true, compression: true });
        const url = URL.createObjectURL(new Blob([output], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = fileName;
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else {
        if (!await Sharing.isAvailableAsync()) throw new Error('Excel file sharing is unavailable on this device.');
        const output = XLSX.write(workbook, { bookType: 'xlsx', type: 'base64', bookSST: true, compression: true });
        const directory = FileSystem.cacheDirectory ?? FileSystem.documentDirectory;
        if (!directory) throw new Error('A temporary folder is unavailable for the Excel export.');
        const uri = `${directory}${fileName}`;
        await FileSystem.writeAsStringAsync(uri, output, { encoding: FileSystem.EncodingType.Base64 });
        await Sharing.shareAsync(uri, { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', dialogTitle: 'Export full gradebook', UTI: 'org.openxmlformats.spreadsheetml.sheet' });
      }
      props.onToast('Full gradebook exported to Excel.');
    } catch (cause) {
      console.error('[Gradebook Excel export] failed', cause);
      props.onToast(getErrorMessage(cause, 'The full gradebook could not be exported.'));
    } finally { setExportingExcel(false); }
  };
  const trackOuterGridScroll = (event: any) => {
    const offset = event?.nativeEvent?.contentOffset;
    if (offset && Platform.OS === 'web') {
      const scrollView = gridScrollElementRef.current;
      const element = event.currentTarget ?? scrollView?.getScrollableNode?.() ?? scrollView;
      element?.style?.setProperty?.('--gradebook-scroll-x', `${offset.x ?? 0}px`);
    }
    if (offset) setGridHasScrolled((current) => {
      const x = (offset.x ?? 0) > 0.5;
      const y = Platform.OS === 'web' ? (offset.y ?? 0) > 0.5 : current.y;
      return current.x === x && current.y === y ? current : { x, y };
    });
    if (Platform.OS === 'web') {
      const nextScrollLeft = offset?.x ?? event?.currentTarget?.scrollLeft ?? horizontalScrollLeftRef.current;
      if (Math.abs(nextScrollLeft - horizontalScrollLeftRef.current) > 0.5) {
        horizontalScrollLeftRef.current = nextScrollLeft;
        horizontalRangeUpdaterRef.current(nextScrollLeft, gridViewportWidthRef.current);
      }
    }
    if (!props.paginationEnabled && Platform.OS === 'web') updateVirtualStartIndex(offset?.y ?? event?.currentTarget?.scrollTop ?? 0);
  };
  // Navigation indexes the complete sorted list. The rendered page/window is only a
  // viewport, so an arrow key can target a student that is currently unmounted.
  displayStudentsRef.current = orderedStudents;
  displayStudentIndexByIdRef.current = orderedStudentIndexById;
  visibleAssessmentIdsRef.current = visibleAssessmentIds;
  visibleAssessmentIndexByIdRef.current = visibleAssessmentIndexById;
  const trackInnerGridScroll = (event: any) => {
    const offset = event?.nativeEvent?.contentOffset;
    if (offset) setGridHasScrolled((current) => {
      const y = (offset.y ?? 0) > 0.5;
      return current.y === y ? current : { ...current, y };
    });
    if (!props.paginationEnabled && Platform.OS !== 'web') updateVirtualStartIndex(offset?.y ?? 0);
  };
  const updateVirtualStartIndex = (scrollTop: number) => {
    const offsets = rowOffsetsRef.current;
    const target = Math.max(0, scrollTop - headerHeightRef.current);
    let low = 0;
    let high = Math.max(0, offsets.length - 2);
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (offsets[middle + 1] <= target) low = middle + 1;
      else high = middle;
    }
    const firstVisibleRow = low;
    const nextStart = Math.max(0, Math.floor(firstVisibleRow / 10) * 10 - virtualOverscanRows);
    setVirtualStartIndex((current) => current === nextStart ? current : nextStart);
  };
  const renderViewToggle = (label: string, checked: boolean, onPress: () => void) => <Pressable accessibilityRole="checkbox" accessibilityState={{ checked }} onPress={onPress} style={styles.fullGradeToggle}>
    <View style={[styles.fullGradeToggleBox, checked && styles.fullGradeToggleBoxSelected]}><Text style={styles.fullGradeToggleMark}>{checked ? '✓' : ''}</Text></View>
    <Text style={styles.fullGradeToggleLabel}>{label}</Text>
  </Pressable>;
  const estimateHeaderLines = (label: string, width: number) => {
    const maxChars = Math.max(1, Math.floor((width - 8) / 5.7));
    let lines = 1;
    let lineChars = 0;
    for (const word of label.split(/\s+/).filter(Boolean)) {
      const wordLines = Math.max(1, Math.ceil(word.length / maxChars));
      if (lineChars && lineChars + 1 + Math.min(word.length, maxChars) > maxChars) {
        lines += wordLines;
        lineChars = word.length % maxChars || maxChars;
      } else {
        lines += wordLines - 1;
        lineChars = lineChars ? lineChars + 1 + Math.min(word.length, maxChars) : word.length % maxChars || maxChars;
      }
    }
    return Math.max(1, lines);
  };
  const headerRowHeights = useMemo(() => hierarchyRows.map((row) => Math.max(20, ...row.cells.map((cell) => {
    const column = columns[cell.columnStart];
    const lines = row.level === 'ASSESSMENT / RESULT' && column?.kind === 'assessment' && column.assessment
      ? estimateHeaderLines(column.assessment.title, cell.width) + 1
      : estimateHeaderLines(cell.label, cell.width);
    return lines * 15;
  }))), [hierarchyRows, columns]);
  const headerRowOffsets = useMemo(() => {
    const offsets = [0];
    for (const height of headerRowHeights) offsets.push(offsets[offsets.length - 1] + height);
    return offsets;
  }, [headerRowHeights]);
  headerHeightRef.current = headerRowOffsets.at(-1) ?? 0;
  const visibleColumnOffsets = useMemo(() => {
    const offsets = new Map<string, number>();
    let nextOffset = 0;
    for (const column of visibleColumns) {
      offsets.set(column.id, nextOffset);
      nextOffset += column.width;
    }
    return offsets;
  }, [visibleColumns]);
  const horizontalWindowFor = (scrollLeft: number, viewportWidth: number) => {
    const visibleWidth = Math.max(240, viewportWidth - frozenStudentWidth);
    let first = 0;
    while (first < visibleColumns.length) {
      const column = visibleColumns[first];
      if ((visibleColumnOffsets.get(column.id) ?? 0) + column.width > scrollLeft) break;
      first += 1;
    }
    let end = first;
    const rightEdge = scrollLeft + visibleWidth;
    while (end < visibleColumns.length && (visibleColumnOffsets.get(visibleColumns[end].id) ?? 0) < rightEdge) end += 1;
    const overscan = 2;
    const start = Math.max(0, first - overscan);
    return { start, end: Math.min(visibleColumns.length, Math.max(start + 1, end + overscan)) };
  };
  horizontalRangeUpdaterRef.current = (scrollLeft, viewportWidth) => {
    const next = horizontalWindowFor(scrollLeft, viewportWidth);
    const current = horizontalColumnRangeRef.current;
    if (current.start === next.start && current.end === next.end) return;
    horizontalColumnRangeRef.current = next;
    setHorizontalColumnRange(next);
  };
  gridViewportWidthRef.current = gridViewportWidth;
  revealAssessmentColumnRef.current = (assessmentId, enrollmentId) => {
    const columnId = `assessment:${assessmentId}`;
    const targetOffset = visibleColumnOffsets.get(columnId);
    const targetStudentIndex = displayStudentIndexByIdRef.current.get(enrollmentId);
    if (targetOffset == null || targetStudentIndex == null) return;
    pendingFocusKeyRef.current = `${enrollmentId}:${assessmentId}`;
    horizontalScrollLeftRef.current = targetOffset;
    horizontalRangeUpdaterRef.current(targetOffset, gridViewportWidthRef.current);
    if (props.paginationEnabled) {
      props.onPageChange(() => Math.floor(targetStudentIndex / 10) + 1);
      const scrollNode = gridScrollElementRef.current?.getScrollableNode?.() ?? gridScrollElementRef.current;
      gridScrollElementRef.current?.scrollTo?.({ x: targetOffset, y: scrollNode?.scrollTop ?? 0, animated: false });
    } else {
      const nextStart = Math.max(0, Math.floor(targetStudentIndex / 10) * 10 - virtualOverscanRows);
      setVirtualStartIndex(nextStart);
      const rowTop = rowOffsetsRef.current[targetStudentIndex] ?? targetStudentIndex * fullRowHeight;
      const targetY = Math.max(0, headerHeightRef.current + rowTop - estimatedRowHeight * virtualOverscanRows);
      gridScrollElementRef.current?.scrollTo?.({ x: targetOffset, y: targetY, animated: false });
    }
  };
  revealCellRef.current = (columnId, enrollmentId) => {
    const targetOffset = visibleColumnOffsets.get(columnId);
    const targetStudentIndex = displayStudentIndexByIdRef.current.get(enrollmentId);
    if (targetOffset == null || targetStudentIndex == null) return;
    horizontalScrollLeftRef.current = targetOffset;
    horizontalRangeUpdaterRef.current(targetOffset, gridViewportWidthRef.current);
    if (props.paginationEnabled) {
      props.onPageChange(() => Math.floor(targetStudentIndex / 10) + 1);
      gridScrollElementRef.current?.scrollTo?.({ x: targetOffset, y: 0, animated: false });
    } else {
      const nextStart = Math.max(0, Math.floor(targetStudentIndex / 10) * 10 - virtualOverscanRows);
      setVirtualStartIndex(nextStart);
      const rowTop = rowOffsetsRef.current[targetStudentIndex] ?? targetStudentIndex * fullRowHeight;
      const targetY = Math.max(0, headerHeightRef.current + rowTop - estimatedRowHeight * virtualOverscanRows);
      gridScrollElementRef.current?.scrollTo?.({ x: targetOffset, y: targetY, animated: false });
    }
  };
  useEffect(() => {
    const target = historyPreviewOverlays[0];
    if (!target) return;
    const frame = requestAnimationFrame(() => revealCellRef.current(target.columnId, target.enrollmentId));
    return () => cancelAnimationFrame(frame);
  }, [historyPreviewOverlays, visibleColumns, orderedStudents]);
  const renderedDataColumns = useMemo(() => visibleColumns.slice(horizontalColumnRange.start, horizontalColumnRange.end), [visibleColumns, horizontalColumnRange.start, horizontalColumnRange.end]);
  const leftDataSpacerWidth = useMemo(() => renderedDataColumns.length ? visibleColumnOffsets.get(renderedDataColumns[0].id) ?? 0 : 0, [renderedDataColumns, visibleColumnOffsets]);
  const renderedDataWidth = useMemo(() => renderedDataColumns.reduce((total, column) => total + column.width, 0), [renderedDataColumns]);
  const rightDataSpacerWidth = Math.max(0, tableWidth - frozenStudentWidth - leftDataSpacerWidth - renderedDataWidth);
  useEffect(() => {
    horizontalRangeUpdaterRef.current(horizontalScrollLeftRef.current, gridViewportWidth);
  }, [gridViewportWidth, visibleColumns, frozenStudentWidth]);
  useEffect(() => {
    const key = pendingFocusKeyRef.current;
    if (!key) return;
    const input = scoreInputRefs.current.get(key);
    if (!input) return;
    pendingFocusKeyRef.current = null;
    requestAnimationFrame(() => input.focus?.());
  }, [horizontalColumnRange, virtualStartIndex, props.page]);
  const safeVirtualStartIndex = Math.min(virtualStartIndex, Math.max(0, displayStudents.length - virtualWindowSize));
  const virtualEndIndex = Math.min(displayStudents.length, safeVirtualStartIndex + virtualWindowSize);
  const renderedStudents = props.paginationEnabled ? displayStudents : displayStudents.slice(safeVirtualStartIndex, virtualEndIndex);
  useEffect(() => { setVirtualStartIndex(0); }, [props.paginationEnabled, props.page, props.studentFilter, props.studentQuery, props.studentSort, props.allStudents.length, headerSort, rowFilters, randomizeRows]);
  const handleGridCellContextMenu = (event: any) => {
    const target = event.target ?? event.nativeEvent?.target;
    const cell = target?.closest?.('[data-gradebook-student]');
    if (!cell) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    const enrollmentId = cell.getAttribute('data-gradebook-student');
    const columnId = cell.getAttribute('data-gradebook-column-id');
    const student = studentByEnrollmentId.get(enrollmentId);
    if (!student || !columnId) return;
    let actions: GradebookContextAction[] = [];
    if (columnId === 'student_class_number') {
      actions = [{ label: 'Copy class number', onSelect: () => void copyText(String(student.classNumber ?? '')) }];
    } else if (columnId === 'student_name') {
      actions = [{ label: 'Copy student name', onSelect: () => void copyText(student.name) }, { label: 'Filter to this student', onSelect: () => props.onStudentQuery(student.name) }];
    } else if (columnId === 'student_id') {
      actions = [{ label: 'Copy student ID', onSelect: () => void copyText(student.institutionalId) }];
    } else if (columnId === 'student_anonymous_id') {
      actions = [{ label: 'Copy anonymized identifier', onSelect: () => void copyText(anonymizedIds.get(student.enrollmentId) ?? '') }];
    } else {
      const column = columns.find((item) => item.id === columnId);
      if (!column) return;
      if (column.kind === 'assessment' && column.assessment) {
        const assessment = column.assessment;
        const key = `${student.enrollmentId}:${assessment.id}`;
        const mapping = valueMappingForType(gradingSystem, assessment.gradingTypeId ?? assessment.component);
        const stored = storedAssessmentValue(workspace, student.enrollmentId, assessment.id);
        const value = props.values[key] ?? (stored == null ? '' : String(stored));
        actions = [
          { label: 'Conditional formatting…', onSelect: () => openConditionalFormatting(column) },
          { label: 'Copy score', onSelect: () => void copyText(value) },
          { label: 'View score history', onSelect: () => {
            setScoreHistoryTarget({ assessment, student });
            setScoreHistory([]);
            setScoreHistoryLoading(true);
            void props.onLoadScoreHistory(assessment.id, student.enrollmentId).then(setScoreHistory).catch((cause) => props.onToast(getErrorMessage(cause, 'Score history could not be loaded.'))).finally(() => setScoreHistoryLoading(false));
          } },
          { label: 'Paste score', onSelect: async () => { const pasted = (await pasteText()).trim(); const pasteError = pasted ? validateAssessmentValue(pasted, assessment.maximumScore, mapping) : undefined; if (!pasted) return props.onToast('Clipboard has no score to paste.'); if (pasteError) return props.onToast(pasteError); props.onChange(key, pasted); } },
          { label: 'Clear score', destructive: true, onSelect: () => props.onChange(key, '') },
        ];
      } else {
        const gradeResult = gradeResults.get(student.enrollmentId) ?? calculateFullViewGrades(workspace, student.enrollmentId, gradingSystem, props.values, missingScoreHandling);
        const computed = displayedFullViewColumnValue(column, student.enrollmentId, gradeResult, workspace, props.values, gradingSystem, calculatedCellDisplay);
        const finalNumber = typeof computed === 'number' ? computed : null;
        const finalDetail = column.kind === 'final' ? gradePercent(finalNumber, gradeDecimalPlaces, showGradePercentSign) : column.kind === 'final_equivalent' ? `${gradeResult.pointGrade == null ? '—' : gradeResult.pointGrade.toFixed(gradeDecimalPlaces)}${gradeResult.letterGrade ? ` / ${gradeResult.letterGrade}` : ''}` : column.kind === 'final_status' ? String(computed ?? 'Incomplete') : gradePercent(finalNumber, gradeDecimalPlaces, showGradePercentSign);
        actions = [{ label: 'Conditional formatting…', onSelect: () => openConditionalFormatting(column) }, { label: 'Explain this grade', onSelect: () => setGradeExplanationTarget({ column, student }) }, { label: 'Copy computed value', onSelect: () => void copyText(finalDetail) }, { label: `Copy ${column.leafLabel}`, onSelect: () => void copyText(`${column.leafLabel}\t${finalDetail}`) }];
      }
    }
    showContextMenu(event, actions);
  };
  const handleGridKeyDownCapture = (event: any) => {
    if (Platform.OS !== 'web') return;
    const target = event.target ?? event.nativeEvent?.target;
    const cell = target?.closest?.('[data-gradebook-student][data-gradebook-column-id]');
    const enrollmentId = cell?.getAttribute?.('data-gradebook-student');
    const columnId = cell?.getAttribute?.('data-gradebook-column-id');
    if (!enrollmentId || !columnId?.startsWith('assessment:')) return;
    const key = event.key ?? event.nativeEvent?.key;
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) return;
    // Capture at the grid first so virtual navigation can decide whether the key
    // should move cells or remain native caret movement inside the input.
    navigateScoreInput(event, enrollmentId, columnId.slice('assessment:'.length), String(target?.value ?? ''));
    if (event.defaultPrevented) event.stopPropagation?.();
  };
  const columnHeaderTextStyle = { fontSize: 11, lineHeight: 15 } as const;
  const gridShadowSuppressed = { shadowOpacity: 0, shadowRadius: 0, shadowOffset: { width: 0, height: 0 }, elevation: 0, ...(Platform.OS === 'web' ? { boxShadow: 'none' } : {}) } as any;
  const historyDates = [...new Set(gradebookHistory.map((entry) => {
    const date = new Date(entry.createdAt);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }))].sort((a, b) => b.localeCompare(a));
  const signedInUserName = `${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim();
  const historyActors = [...new Map(gradebookHistory.map((entry) => [entry.actorId ?? 'unknown', {
    value: entry.actorId ?? 'unknown',
    label: entry.actorName || (entry.actorId === user?.id ? signedInUserName : '') || 'Unknown user',
  }])).values()].sort((a, b) => a.label.localeCompare(b.label));
  const conditionalRuleEntries = conditionalFormattingTarget ? conditionalRules.flatMap((rule, index) => {
    const applies = rule.columnIds?.length ? rule.columnIds.includes(conditionalFormattingTarget.id) : !rule.columnKinds?.length || rule.columnKinds.includes(conditionalFormattingTarget.kind);
    return applies ? [{ rule, index }] : [];
  }) : [];
  const conditionalRuleSummary = (rule: GradebookConditionalFormattingRule) => {
    const condition = conditionalOperatorOptions.find((option) => option.value === rule.operator)?.label ?? 'Condition';
    const value = rule.values?.join(', ') ?? (rule.value == null ? '' : String(rule.value));
    const format = rule.colorScale ? `${rule.colorScale.mode} color scale` : rule.badge ? `badge “${rule.badge.label}”` : 'cell highlight';
    return `${condition}${value ? ` ${value}${rule.valueTo == null ? '' : ` – ${rule.valueTo}`}` : ''} · ${rule.applyTo === 'row' ? 'row' : 'cell'} · ${format}`;
  };
  return (
    <>
      <View {...contextProps([
        { label: 'Show all hidden columns', onSelect: () => setSectionStates({}) },
        { label: 'Show all hidden header levels', onSelect: () => setHiddenHeaderLevels(new Set()) },
      ])} style={styles.assessmentContext}>
        <View style={styles.flex}>
          <Text style={styles.assessmentTitle}>Full gradebook</Text>
          <Text style={styles.help}>View and update every assessment in one table. Scroll horizontally to see all assessment columns.</Text>
        </View>
      </View>
      <View style={styles.gradeToolbar}>
        <Field label="Find student" value={props.studentQuery} placeholder="Name or student ID" onChangeText={props.onStudentQuery} containerStyle={styles.studentSearch} />
        <Field label="Find column" value={columnHeaderQuery} placeholder="Period, component, assessment…" onChangeText={setColumnHeaderQuery} containerStyle={styles.studentSearch} />
        <SelectField label="Show" value={props.studentFilter} options={[{ label: 'All students', value: 'all' }, { label: 'Missing any score', value: 'missing' }, { label: 'At-risk students', value: 'at_risk' }, { label: 'Passing students', value: 'passing' }]} onChange={props.onStudentFilter} containerStyle={styles.studentFilter} />
        <SelectField label="Sort" value={props.studentSort} options={[{ label: 'Class number (ascending)', value: 'class_number' }, { label: 'Name (A–Z)', value: 'name' }, { label: 'Highest risk first', value: 'risk' }, { label: 'Lowest standing first', value: 'standing' }]} onChange={props.onStudentSort} containerStyle={styles.studentSort} />
        <Text style={styles.resultCount}>{props.paginationEnabled ? `${orderedStudents.length} students · Page ${props.page} of ${localPageCount}` : `${orderedStudents.length} students · Showing all`}</Text>
      </View>
      <View style={styles.fullViewOptionsBar}>
        <Button label="Import scores" variant="secondary" onPress={() => { setScoreImportPreview(null); setScoreImportOpen(true); }} />
        <Button label={exportingExcel ? 'Exporting…' : 'Export Excel'} variant="secondary" disabled={exportingExcel} onPress={() => void exportFullViewExcel()} />
        {props.overlayControl ? <Button label={props.overlayControl.active ? `Hide ${props.overlayControl.label}` : props.overlayControl.label} variant="secondary" onPress={props.overlayControl.onToggle} /> : null}
        {historyPreviewOverlays.length ? <Button label={`Previous values · Clear (${historyPreviewOverlays.length})`} variant="secondary" onPress={() => {
          setHistoryPreviewOverlays([]);
          const pageCountWithoutPreview = Math.max(1, Math.ceil(sortedStudents.length / 10));
          props.onPageChange((current) => Math.min(current, pageCountWithoutPreview));
        }} /> : null}
        <Button label="Version history" variant="secondary" onPress={() => {
          setGradebookHistoryOpen(true);
          setGradebookHistoryQuery('');
          setGradebookHistoryAction('all');
          setGradebookHistoryActor('all');
          setGradebookHistoryDate(null);
          setRestoreMenuVersionId(null);
          setGradebookHistory([]);
          setGradebookHistoryCursor(null);
          setGradebookHistoryHasMore(false);
          setGradebookHistoryVisibleLimit(100);
          setGradebookHistoryScanning(false);
          void loadGradebookHistoryPage(null, false);
        }} />
        <Button label="View options" variant="secondary" onPress={() => setViewOptionsOpen(true)} />
        <Button label="Save all scores" loading={props.saving} disabled={!props.dirtyCount || !!props.invalidCount} onPress={props.onSave} />
      </View>
      {!assessments.length ? <PageState kind="empty" title="No assessments yet" message="Create an assessment to start using the full gradebook." /> : (
        <View {...({ dataSet: { gradebookGrid: 'true', gradebookVisibleColumns: String(visibleColumns.length), gradebookStudentCount: String(displayStudents.length), gradebookColumnWindowStart: String(horizontalColumnRange.start), gradebookColumnWindowEnd: String(horizontalColumnRange.end) }, onMouseLeave: clearColumnHover, onContextMenu: handleGridCellContextMenu, onKeyDownCapture: handleGridKeyDownCapture } as any)} style={styles.fullGridScrollFrame}>
        <ScrollView {...({ dataSet: { gradebookScrollViewport: 'true' } } as any)} ref={gridScrollElementRef} horizontal={Platform.OS !== 'web'} showsHorizontalScrollIndicator onLayout={(event: any) => {
          const width = Number(event?.nativeEvent?.layout?.width);
          if (!Number.isFinite(width) || width <= 0 || Math.abs(width - gridViewportWidthRef.current) < 1) return;
          gridViewportWidthRef.current = width;
          setGridViewportWidth(width);
          horizontalRangeUpdaterRef.current(horizontalScrollLeftRef.current, width);
        }} onScroll={trackOuterGridScroll} scrollEventThrottle={16} style={Platform.OS === 'web' ? ({ height: 560, width: '100%', overflowX: 'auto', overflowY: 'auto', scrollBehavior: 'auto', overscrollBehavior: 'auto', scrollbarGutter: 'stable' } as any) : undefined}>
          <View style={{ width: tableWidth }}>
            <ScrollView onScroll={trackInnerGridScroll} scrollEventThrottle={16} style={Platform.OS === 'web' ? ({ height: 'auto', overflow: 'visible' } as any) : styles.fullGridVerticalScroll} contentContainerStyle={{ width: tableWidth }} nestedScrollEnabled stickyHeaderIndices={[0]}>
              <View style={styles.fullGridFrozenHeader}>
            {hierarchyRows.map((row, rowIndex) => {
              const canHideLevel = row.level === 'PERIOD' || row.level === 'GROUP' || row.level === 'COMPONENT' || row.level.startsWith('SUBCOMPONENT');
              const levelActions = canHideLevel ? [{ label: `Hide ${row.level.toLowerCase()} header level`, onSelect: () => setHiddenHeaderLevels((current) => new Set([...current, row.level])) }, ...(hiddenHeaderLevels.size ? [{ label: 'Show all hidden header levels', onSelect: () => setHiddenHeaderLevels(new Set()) }] : [])] : [];
              return <View key={row.level} {...({
                onContextMenuCapture: (event: any) => event.preventDefault?.(),
                onMouseDownCapture: (event: any) => { if (event.button === 0) event.preventDefault?.(); },
              } as any)} style={[styles.fullHeaderRow, { height: headerRowHeights[rowIndex] ?? 20, minHeight: 20 }]}>
                {row.level === 'ASSESSMENT / RESULT' ? <>
                  {showClassNumber ? <View {...({ dataSet: { gradebookCol: columnCssKey('student_class_number') } } as any)} {...columnHoverProps(['student_class_number'])} {...clickContextProps(sortFilterActions({ key: 'student_class_number', label: 'Class #', kind: 'number' }))} style={[styles.fullClassNumberHeader, { width: classNumberWidth, height: headerRowHeights[rowIndex] ?? 20 }, noHeaderSelection, Platform.OS === 'web' ? { position: 'sticky', left: studentColumnOffsets.classNumber, zIndex: 1003 } as any : null]}><Text style={[styles.fullHeaderLevel, columnHeaderTextStyle]}>#</Text>{renderHeaderIndicators({ key: 'student_class_number', label: 'Class #', kind: 'number' })}</View> : null}
                  {showStudentName ? <View {...({ dataSet: { gradebookCol: columnCssKey('student_name') } } as any)} {...columnHoverProps(['student_name'])} {...clickContextProps(sortFilterActions({ key: 'student_name', label: 'Student', kind: 'text' }))} style={[styles.fullStudentHeader, { width: studentNameWidth, height: headerRowHeights[rowIndex] ?? 20 }, noHeaderSelection, Platform.OS === 'web' ? { position: 'sticky', left: studentColumnOffsets.name, zIndex: 1002 } as any : null]}><Text style={[styles.fullHeaderLevel, columnHeaderTextStyle]}>STUDENT</Text>{renderHeaderIndicators({ key: 'student_name', label: 'Student', kind: 'text' })}</View> : null}
                  {showStudentId ? <View {...({ dataSet: { gradebookCol: columnCssKey('student_id') } } as any)} {...columnHoverProps(['student_id'])} {...clickContextProps(sortFilterActions({ key: 'student_id', label: 'Student ID', kind: 'text' }))} style={[styles.fullStudentHeader, { width: studentIdWidth, height: headerRowHeights[rowIndex] ?? 20 }, noHeaderSelection, Platform.OS === 'web' ? { position: 'sticky', left: studentColumnOffsets.id, zIndex: 1001 } as any : null]}><Text style={[styles.fullHeaderLevel, columnHeaderTextStyle]}>STUDENT ID</Text>{renderHeaderIndicators({ key: 'student_id', label: 'Student ID', kind: 'text' })}</View> : null}
                  {showAnonymousId ? <View {...({ dataSet: { gradebookCol: columnCssKey('student_anonymous_id') } } as any)} {...columnHoverProps(['student_anonymous_id'])} style={[styles.fullStudentHeader, { width: anonymousIdWidth, height: headerRowHeights[rowIndex] ?? 20 }, noHeaderSelection, Platform.OS === 'web' ? { position: 'sticky', left: studentColumnOffsets.anonymous, zIndex: 1000 } as any : null]}><Text style={[styles.fullHeaderLevel, columnHeaderTextStyle]}>ANON ID</Text></View> : null}
                </> : <View {...(levelActions.length ? clickContextProps(levelActions) : {})} style={[styles.fullHierarchyLabelColumn, { width: frozenStudentWidth, height: headerRowHeights[rowIndex] ?? 20 }, noHeaderSelection, Platform.OS === 'web' ? { position: 'sticky', left: 0, zIndex: 10000, backgroundColor: colors.surfaceMuted } as any : null]}>{showHierarchyLabels ? <Text style={[styles.fullHeaderLevel, columnHeaderTextStyle]}>{row.level}</Text> : null}</View>}
                {row.cells.map((cell, index) => {
                  const range = visibleColumns.slice(cell.columnStart, cell.columnEnd + 1);
                  const headingPath = [range[0]?.period.label, range[0]?.group.label, ...range[0]?.componentPath.map((item) => item.name) ?? [], range[0]?.leafLabel].filter(Boolean).join(' › ');
                  const copyRange = async () => {
                    const lines = [`Student\t${range.map((column) => column.leafLabel).join('\t')}`];
                    for (const student of workspace.students) {
                      const result = gradeResults.get(student.enrollmentId) ?? calculateFullViewGrades(workspace, student.enrollmentId, gradingSystem, props.values, missingScoreHandling);
                      lines.push([student.name, ...range.map((column) => displayedFullViewColumnValue(column, student.enrollmentId, result, workspace, props.values, gradingSystem, calculatedCellDisplay))].join('\t'));
                    }
                    await copyText(lines.join('\n'));
                    props.onToast('Header range copied to clipboard.');
                  };
                  const sectionKey = `${row.level}:${cell.mergeKey}`;
                  const currentSection = sectionStates[sectionKey];
                  const componentDepth = row.componentDepth ?? 0;
                  const activeComponentId = range[0]?.componentPath[componentDepth]?.id;
                  const keepColumnIds = range.filter((column) => row.level === 'PERIOD' ? column.kind === 'period' || column.kind === 'non_period' || column.kind === 'final' : row.level === 'GROUP' ? column.kind === 'group' || column.kind === 'non_period' : row.level === 'COMPONENT' || row.level.startsWith('SUBCOMPONENT') ? column.kind === 'component' && column.componentPath.length === componentDepth + 1 && column.componentPath.at(-1)?.id === activeComponentId : false).map((column) => column.id);
                  const sectionActions: GradebookContextAction[] = currentSection?.mode === 'collapsed' ? [{ label: 'Expand this section', onSelect: () => setSectionStates((current) => { const next = { ...current }; delete next[sectionKey]; return next; }) }] : [];
                  if (!currentSection || currentSection.mode !== 'hidden') sectionActions.push({ label: 'Collapse this header section', onSelect: () => setSectionStates((current) => ({ ...current, [sectionKey]: { mode: 'collapsed', columnIds: range.map((column) => column.id), keepColumnIds } })) });
                  sectionActions.push({ label: 'Hide this header and its columns', onSelect: () => setSectionStates((current) => ({ ...current, [sectionKey]: { mode: 'hidden', columnIds: range.map((column) => column.id), keepColumnIds: [] } })) });
                  const columnActions: GradebookContextAction[] = [];
                  let sortableColumnTarget: GradebookFilterTarget | undefined;
                  if (row.level === 'ASSESSMENT / RESULT' && range.length === 1) {
                    const column = range[0];
                    const mapping = column.assessment ? valueMappingForType(gradingSystem, column.assessment.gradingTypeId ?? column.assessment.component) : null;
                    sortableColumnTarget = { key: column.id, label: column.leafLabel || column.kind, kind: mapping ? 'category' : 'number', options: mapping?.map((item) => ({ label: `${item.value} · ${item.percentage}%`, value: item.value })) };
                    columnActions.push(...sortFilterActions(sortableColumnTarget));
                    columnActions.push({ label: 'Conditional formatting…', onSelect: () => openConditionalFormatting(column) });
                  }
                  if (row.level === 'ASSESSMENT / RESULT' && range.length === 1 && range[0].kind === 'assessment' && range[0].assessment) {
                    const assessment = range[0].assessment;
                    const mapping = valueMappingForType(gradingSystem, assessment.gradingTypeId ?? assessment.component);
                    const applyColumnValue = (value: string) => props.onChangeMany(Object.fromEntries(filteredStudents.map((student) => [`${student.enrollmentId}:${assessment.id}`, value])));
                    columnActions.push(
                      { label: 'Edit assessment', onSelect: () => props.onEditAssessment(assessment) },
                      { label: `Clear values for ${filteredStudents.length} matching students`, destructive: true, onSelect: () => { applyColumnValue(''); props.onToast(`Cleared ${filteredStudents.length} scores for ${assessment.title}.`); } },
                      { label: `Set all ${filteredStudents.length} matching scores to…`, onSelect: () => { setBulkScoreAssessment(assessment); setBulkScoreValue(''); } },
                      { label: 'Paste values into this column…', onSelect: async () => { const raw = await pasteText(); if (!raw.trim()) return props.onToast('Clipboard has no values to paste.'); const lines = raw.replace(/\r/g, '').split('\n'); if (lines.at(-1) === '') lines.pop(); const values = lines.map((line) => (line.split('\t').at(-1) ?? '').trim()); if (values.length !== filteredStudents.length) return props.onToast(`Paste exactly ${filteredStudents.length} values for the matching rows.`); const invalid = values.findIndex((value) => value && validateAssessmentValue(value, assessment.maximumScore, mapping)); if (invalid >= 0) return props.onToast(`Value ${invalid + 1} is invalid: ${validateAssessmentValue(values[invalid], assessment.maximumScore, mapping)}`); props.onChangeMany(Object.fromEntries(values.map((value, studentIndex) => [`${filteredStudents[studentIndex].enrollmentId}:${assessment.id}`, value]))); props.onToast(`Pasted values into ${assessment.title}.`); } },
                    );
                  }
                  const nextRow = hierarchyRows[rowIndex + 1];
                  const continuesVertically = cell.label === '' && !!nextRow && nextRow.cells
                    .filter((nextCell) => nextCell.columnStart <= cell.columnEnd && nextCell.columnEnd >= cell.columnStart)
                    .every((nextCell) => nextCell.label === '');
                  let blankRowsAbove = 0;
                  if (row.level === 'ASSESSMENT / RESULT') {
                    for (let previousRowIndex = rowIndex - 1; previousRowIndex >= 0; previousRowIndex -= 1) {
                      const previousCell = hierarchyRows[previousRowIndex].cells.find((candidate) => candidate.columnStart <= cell.columnStart && candidate.columnEnd >= cell.columnStart);
                      if (previousCell?.label !== '') break;
                      blankRowsAbove += 1;
                    }
                  }
                  const verticalMergeTopRow = rowIndex - blankRowsAbove;
                  const verticalMergeHeight = (headerRowOffsets[rowIndex + 1] ?? 0) - (headerRowOffsets[verticalMergeTopRow] ?? 0);
                  const verticalMergeOffset = (headerRowOffsets[rowIndex] ?? 0) - (headerRowOffsets[verticalMergeTopRow] ?? 0);
                  const verticalMergeStyle = blankRowsAbove ? { height: verticalMergeHeight, marginTop: -verticalMergeOffset, position: 'relative', zIndex: 0 } as any : null;
                  const firstVisibleColumn = range.find((column) => visibleColumnOffsets.has(column.id));
                  const dataColumnOffset = firstVisibleColumn ? visibleColumnOffsets.get(firstVisibleColumn.id) ?? 0 : 0;
                  const verticalMergeClip = blankRowsAbove && Platform.OS === 'web'
                    ? { clipPath: `inset(0 0 0 max(0px, calc(var(--gradebook-scroll-x, 0px) - ${dataColumnOffset}px)))` } as any
                    : null;
                  const headerActions = [{ label: `Copy ${row.level.toLowerCase()} label`, onSelect: () => void copyText(cell.label) }, { label: 'Copy header path', onSelect: () => void copyText(headingPath) }, { label: 'Copy values in this range', onSelect: () => void copyRange() }, ...columnActions, ...sectionActions];
                  const headerColumnIds = range.map((column) => column.id);
                  const mergedHoverKeys = headerColumnIds.map(columnCssKey).join(' ');
                  const assessmentHeader = row.level === 'ASSESSMENT / RESULT' && range.length === 1 ? range[0].assessment : undefined;
                  return <View key={`${row.level}-${index}-${cell.label}`} accessible accessibilityRole="button" accessibilityLabel={`${row.level}: ${headingPath || cell.label || 'empty merged header'}. Header actions available.`} {...({ dataSet: { gradebookCols: mergedHoverKeys } } as any)} {...columnHoverProps(headerColumnIds)} {...clickContextProps(headerActions)} style={[styles.fullMergedHeader, { width: cell.width, height: headerRowHeights[rowIndex] ?? 20, minHeight: 20, paddingVertical: 0 }, noHeaderSelection, continuesVertically ? styles.fullMergedHeaderVerticalContinue : null, verticalMergeStyle, verticalMergeClip]}>{assessmentHeader ? <><Text style={[styles.fullMergedHeaderText, columnHeaderTextStyle]}>{assessmentHeader.title}</Text><Text style={[styles.fullAssessmentMaximumText, columnHeaderTextStyle]}>{assessmentHeader.maximumScore}</Text></> : <Text style={[styles.fullMergedHeaderText, columnHeaderTextStyle]}>{cell.label}</Text>}{sortableColumnTarget ? renderHeaderIndicators(sortableColumnTarget) : null}</View>;
                })}
              </View>
            })}
              </View>
            {!props.paginationEnabled && safeVirtualStartIndex > 0 ? <View style={{ width: tableWidth, height: rowOffsets[safeVirtualStartIndex] ?? safeVirtualStartIndex * fullRowHeight }} /> : null}
            {renderedStudents.map((student) => <FullGradebookRow
              key={student.enrollmentId}
              student={student}
              gradeResult={gradeResults.get(student.enrollmentId) ?? calculateFullViewGrades(workspace, student.enrollmentId, gradingSystem, props.values, missingScoreHandling)}
              cellOverlays={cellOverlayByKey}
              cellOverlayEdges={cellOverlayEdges}
              conditionalFormattingRules={conditionalRules}
              conditionalFormattingRulesByColumn={conditionalFormattingRulesByColumn}
              conditionalFormattingRowColumnsByRule={conditionalFormattingRowColumnsByRule}
              conditionalFormattingStats={conditionalFormattingStats}
              columns={renderedDataColumns}
              offsets={visibleColumnOffsets}
              workspace={workspace}
              gradingSystem={gradingSystem}
              valueMappings={valueMappings}
              values={rowValuesByStudent.get(student.enrollmentId) ?? EMPTY_GRADEBOOK_VALUES}
              displayMode={calculatedCellDisplay}
              decimalPlaces={gradeDecimalPlaces}
              showPercent={showGradePercentSign}
              passingGradePercentage={passingGradePercentage}
              deemphasizeGroupGrades={hideAssessmentInstanceColumns && hideComponentGrades && !hideNonFinalCalculatedGrades}
              showClassNumber={showClassNumber}
              showStudentName={showStudentName}
              showStudentId={showStudentId}
              showAnonymousId={showAnonymousId}
              anonymousId={anonymizedIds.get(student.enrollmentId) ?? '—'}
              classNumberWidth={classNumberWidth}
              studentNameWidth={studentNameWidth}
              studentIdWidth={studentIdWidth}
              anonymousIdWidth={anonymousIdWidth}
              leftSpacerWidth={leftDataSpacerWidth}
              rightSpacerWidth={rightDataSpacerWidth}
              studentColumnOffsets={studentColumnOffsets}
              scoreInputRefs={scoreInputRefs}
              columnCssKey={columnCssKey}
              columnHoverProps={columnHoverProps}
              navigateScoreInput={navigateScoreInput}
              onChange={props.onChange}
              onRowMeasured={queueRowMeasurement}
            />)}
            {!props.paginationEnabled && virtualEndIndex < displayStudents.length ? <View style={{ width: tableWidth, height: Math.max(0, rowOffsets[displayStudents.length] - (rowOffsets[virtualEndIndex] ?? virtualEndIndex * fullRowHeight)) }} /> : null}
            </ScrollView>
          </View>
        </ScrollView>
        {gridHasScrolled.x ? <View {...({ dataSet: { gradebookFrozenShadow: 'columns' } } as any)} pointerEvents="none" style={[styles.fullGridVerticalShadow, { left: frozenStudentWidth - 1 }, visibleColumns.length > 50 ? gridShadowSuppressed : null]} /> : null}
        {gridHasScrolled.y ? <View {...({ dataSet: { gradebookFrozenShadow: 'rows' } } as any)} pointerEvents="none" style={[styles.fullGridHorizontalShadow, { top: hierarchyRows.length * 22 - 1 }, props.allStudents.length > 50 ? gridShadowSuppressed : null]} /> : null}
        </View>
      )}
      {props.paginationEnabled && orderedStudents.length > 10 ? <View style={styles.pagination}><Button label="Previous" variant="secondary" disabled={props.page <= 1} onPress={() => props.onPageChange((current) => Math.max(1, current - 1))} /><Text style={styles.paginationText}>Page {props.page} of {localPageCount} · {orderedStudents.length} students</Text><Button label="Next" variant="secondary" disabled={props.page >= localPageCount} onPress={() => props.onPageChange((current) => Math.min(localPageCount, current + 1))} /></View> : null}
      <View style={styles.saveBar}>
        <View style={styles.flex}><Text style={styles.saveState}>{props.dirtyCount ? `${props.dirtyCount} unsaved change${props.dirtyCount === 1 ? '' : 's'}` : 'All scores saved'}</Text><Text style={styles.help}>{props.invalidCount ? `${props.invalidCount} score${props.invalidCount === 1 ? '' : 's'} need correction before saving.` : props.autosaveEnabled ? 'Changes save automatically. Scores remain provisional monitoring data until recorded in SWU SIS.' : 'Scores remain provisional monitoring data until recorded in SWU SIS.'}</Text></View>
      </View>
      <Modal transparent visible={!!conditionalFormattingTarget} animationType="fade" onRequestClose={() => setConditionalFormattingTarget(null)}>
        <View style={styles.viewOptionsOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setConditionalFormattingTarget(null)} />
          <ScrollView style={{ width: '94%', maxWidth: 520, maxHeight: '88%', borderRadius: 12, backgroundColor: colors.surface, padding: 18 }} contentContainerStyle={{ gap: 12 }} keyboardShouldPersistTaps="handled">
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <View style={{ flex: 1 }}><Text style={styles.viewOptionsTitle}>Conditional formatting</Text><Text style={styles.help} numberOfLines={2}>{conditionalFormattingTarget?.leafLabel} · applies to this column</Text></View>
              <Pressable accessibilityLabel="Close conditional formatting" onPress={() => setConditionalFormattingTarget(null)}><Text style={styles.viewOptionsClose}>×</Text></Pressable>
            </View>
            <View style={{ gap: 6, padding: 9, borderWidth: 1, borderColor: colors.border, borderRadius: 8 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}><Text style={{ color: colors.text, fontSize: 12, fontWeight: '700' }}>Rules · first matching rule wins</Text><Text style={styles.help}>Drag to reorder</Text></View>
              {conditionalRuleEntries.map(({ rule, index }) => <View key={rule.id ?? `rule-${index}`} {...(Platform.OS === 'web' ? { draggable: true, onDragStart: (event: any) => { setDraggedConditionalRuleIndex(index); event.dataTransfer?.setData?.('text/plain', String(index)); }, onDragOver: (event: any) => event.preventDefault?.(), onDrop: (event: any) => { event.preventDefault?.(); const from = draggedConditionalRuleIndex ?? Number(event.dataTransfer?.getData?.('text/plain')); reorderConditionalFormattingRules(from, index); setDraggedConditionalRuleIndex(null); }, onDragEnd: () => setDraggedConditionalRuleIndex(null) } as any : null)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, padding: 6, borderRadius: 6, backgroundColor: draggedConditionalRuleIndex === index ? '#E8EEF8' : colors.surfaceMuted }}>
                <Pressable accessibilityLabel={`Edit rule ${index + 1}`} onPress={() => editConditionalFormattingRule(index)} style={{ flex: 1 }}><Text numberOfLines={2} style={{ color: colors.text, fontSize: 11 }}>{conditionalRuleSummary(rule)}</Text></Pressable>
                <Pressable accessibilityLabel={`Move rule ${index + 1} up`} disabled={index === conditionalRuleEntries[0]?.index} onPress={() => { const position = conditionalRuleEntries.findIndex((entry) => entry.index === index); if (position > 0) reorderConditionalFormattingRules(index, conditionalRuleEntries[position - 1].index); }}><Text style={{ color: colors.brand, fontSize: 14, paddingHorizontal: 4 }}>↑</Text></Pressable>
                <Pressable accessibilityLabel={`Move rule ${index + 1} down`} disabled={index === conditionalRuleEntries.at(-1)?.index} onPress={() => { const position = conditionalRuleEntries.findIndex((entry) => entry.index === index); if (position >= 0 && position < conditionalRuleEntries.length - 1) reorderConditionalFormattingRules(index, conditionalRuleEntries[position + 1].index); }}><Text style={{ color: colors.brand, fontSize: 14, paddingHorizontal: 4 }}>↓</Text></Pressable>
                <Pressable accessibilityLabel={`Delete rule ${index + 1}`} onPress={() => setConditionalRules((current) => { const next = current.filter((_, itemIndex) => itemIndex !== index); props.onConditionalFormattingRulesChange?.(next); return next; })}><Text style={{ color: colors.danger, fontSize: 14, paddingHorizontal: 4 }}>×</Text></Pressable>
              </View>)}
              {!conditionalRuleEntries.length ? <Text style={styles.help}>No rules yet.</Text> : null}
            </View>
            <SelectField label="Apply format to" value={conditionalApplyTo} options={[{ label: 'Matching cell', value: 'cell' }, { label: 'Entire row when matched', value: 'row' }]} onChange={(value) => setConditionalApplyTo(value as 'cell' | 'row')} />
            <SelectField label="Condition" value={conditionalOperator} options={conditionalOperatorOptions} onChange={(value) => setConditionalOperator(value as GradebookConditionalFormattingOperator)} searchable disabled={conditionalFormatMode === 'discrete_scale' || conditionalFormatMode === 'continuous_scale'} />
            {conditionalFormatMode === 'discrete_scale' || conditionalFormatMode === 'continuous_scale' ? <Text style={styles.help}>Color scales apply to all numeric values in this column.</Text> : null}
            {conditionalValueOperators.has(conditionalOperator) && conditionalFormatMode !== 'discrete_scale' && conditionalFormatMode !== 'continuous_scale' ? <Field label={conditionalListOperators.has(conditionalOperator) ? 'Values (comma separated)' : conditionalOperator.startsWith('date_') ? 'Date or first value' : 'Value'} value={conditionalValue} onChangeText={setConditionalValue} placeholder={conditionalListOperators.has(conditionalOperator) ? 'e.g. A, P' : 'Enter a value'} inputType={conditionalOperator.startsWith('date_') ? 'date' : 'text'} /> : null}
            {conditionalBetweenOperators.has(conditionalOperator) ? <Field label="Second value" value={conditionalValueTo} onChangeText={setConditionalValueTo} placeholder={conditionalOperator.startsWith('date_') ? 'YYYY-MM-DD' : 'Enter the upper value'} inputType={conditionalOperator.startsWith('date_') ? 'date' : 'text'} /> : null}
            {conditionalGlobalOperators.has(conditionalOperator) && conditionalOperator.startsWith('std_deviations_') ? <Text style={styles.help}>Enter N in the value field; leave it blank to use 1 standard deviation.</Text> : null}
            <SelectField label="Format" value={conditionalFormatMode} options={[{ label: 'Cell highlight', value: 'highlight' }, { label: 'Discrete color scale', value: 'discrete_scale' }, { label: 'Continuous color scale', value: 'continuous_scale' }, { label: 'Badge', value: 'badge' }]} onChange={(value) => setConditionalFormatMode(value as typeof conditionalFormatMode)} />
            {conditionalFormatMode === 'highlight' || conditionalFormatMode === 'badge' ? <Field label={conditionalFormatMode === 'badge' ? 'Badge color' : 'Highlight color'} value={conditionalColor} onChangeText={setConditionalColor} inputType="color" /> : null}
            {conditionalFormatMode === 'badge' ? <Field label="Badge text" value={conditionalBadgeLabel} onChangeText={setConditionalBadgeLabel} placeholder="e.g. Needs review" /> : null}
            {conditionalFormatMode === 'discrete_scale' || conditionalFormatMode === 'continuous_scale' ? <>
              <Text style={styles.help}>Choose the color at each point in the scale. These positions also set the color order from low values to high values.</Text>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {(['Low values', 'Middle values', 'High values'] as const).map((label, index) => <Field key={label} label={label} value={conditionalScaleColors[index]} onChangeText={(value) => setConditionalScaleColors((current) => current.map((color, colorIndex) => colorIndex === index ? value : color))} inputType="color" containerStyle={{ flex: 1 }} />)}
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
                {conditionalScaleColors.map((color, index) => <View key={`${color}-${index}`} style={{ flex: 1, height: 14, backgroundColor: color, borderRadius: 4 }} />)}
              </View>
            </> : null}
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginTop: 4 }}>
              <Button label="Clear column rules" variant="secondary" onPress={clearConditionalFormatting} />
              <View style={{ flexDirection: 'row', gap: 8 }}><Button label="Cancel" variant="secondary" onPress={() => setConditionalFormattingTarget(null)} /><Button label={conditionalEditingRuleId ? 'Update rule' : 'Add rule'} onPress={saveConditionalFormatting} /></View>
            </View>
          </ScrollView>
        </View>
      </Modal>
      <GradebookContextMenu menu={contextMenu} onClose={() => setContextMenu(null)} onSelect={(action) => { setContextMenu(null); action.onSelect?.(); }} />
      <Modal transparent visible={viewOptionsOpen} animationType="fade" onRequestClose={() => setViewOptionsOpen(false)}>
        <View style={styles.viewOptionsOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setViewOptionsOpen(false)} />
          <ScrollView style={styles.viewOptionsPopover} contentContainerStyle={styles.viewOptionsPopoverContent} showsVerticalScrollIndicator keyboardShouldPersistTaps="handled">
            <View style={styles.viewOptionsHeading}>
              <Text style={styles.viewOptionsTitle}>View options</Text>
              <Pressable accessibilityLabel="Close view options" onPress={() => setViewOptionsOpen(false)}><Text style={styles.viewOptionsClose}>×</Text></Pressable>
            </View>
            <Text style={styles.viewOptionsTitle}>Saved views</Text>
            <SelectField label="Saved view" value={selectedSavedViewId} options={[{ label: savedViewsLoaded ? 'Choose a saved view' : 'Loading saved views…', value: '' }, ...savedViews.map((view) => ({ label: view.name, value: view.id }))]} onChange={setSelectedSavedViewId} />
            <View style={styles.actions}>
              <Button label="Apply" variant="secondary" disabled={!savedViews.some((view) => view.id === selectedSavedViewId)} onPress={applySavedView} />
              <Button label="Delete" variant="secondary" disabled={!savedViews.some((view) => view.id === selectedSavedViewId)} onPress={() => { setSavedViews((current) => current.filter((view) => view.id !== selectedSavedViewId)); setSelectedSavedViewId(''); }} />
            </View>
            <Field label="Save current settings as" value={savedViewName} placeholder="For example, Missing scores" onChangeText={setSavedViewName} />
            <Button label="Save view" variant="secondary" disabled={!savedViewName.trim() || !savedViewsLoaded} onPress={saveCurrentView} />
            {renderViewToggle('Show hierarchy labels', showHierarchyLabels, () => setShowHierarchyLabels((current) => !current))}
            {renderViewToggle('Hide assessment instance columns', hideAssessmentInstanceColumns, () => setHideAssessmentInstanceColumns((current) => !current))}
            <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: hideSingleChildComponentGrades }} onPress={() => setHideSingleChildComponentGrades((current) => !current)} style={styles.fullGradeToggle}>
              <View style={[styles.fullGradeToggleBox, hideSingleChildComponentGrades && styles.fullGradeToggleBoxSelected]}><Text style={styles.fullGradeToggleMark}>{hideSingleChildComponentGrades ? '✓' : ''}</Text></View>
              <Text style={styles.fullGradeToggleLabel}>Hide a component grade when it is the only subcomponent under its parent</Text>
            </Pressable>
            {renderViewToggle('Hide component grades', hideComponentGrades, () => setHideComponentGrades((current) => !current))}
            {renderViewToggle('Hide all calculated grades except final percentage and point grade', hideNonFinalCalculatedGrades, () => setHideNonFinalCalculatedGrades((current) => !current))}
            {renderViewToggle('Hide final percentage and point grade', hideFinalGradeColumns, () => setHideFinalGradeColumns((current) => !current))}
            <Text style={styles.viewOptionsTitle}>Calculated cells</Text>
            <SelectField label="Display" value={calculatedCellDisplay} options={[{ label: 'Current grades', value: 'grade' }, { label: 'Direct contributions', value: 'contribution' }]} onChange={(value) => setCalculatedCellDisplay(value as 'grade' | 'contribution')} />
            <SelectField label="Missing assessment results" value={missingScoreHandling} options={[{ label: 'Treat as — (ignore)', value: 'ignore' }, { label: 'Treat as 0', value: 'zero' }, { label: 'Treat as 100', value: 'full' }]} onChange={(value) => setMissingScoreHandling(value as 'ignore' | 'zero' | 'full')} />
            <Field label="Decimal places" accessibilityLabel="Calculated grade decimal places" value={gradeDecimalPlacesInput} keyboardType="number-pad" onChangeText={(value) => { if (/^\d*$/.test(value)) setGradeDecimalPlacesInput(value); }} />
            {renderViewToggle('Show percent character', showGradePercentSign, () => setShowGradePercentSign((current) => !current))}
            <Text style={styles.viewOptionsTitle}>Student columns</Text>
            {renderViewToggle('Show class number', showClassNumber, () => setShowClassNumber((current) => !current))}
            {renderViewToggle('Show student name', showStudentName, () => setShowStudentName((current) => !current))}
            {renderViewToggle('Show student number', showStudentId, () => setShowStudentId((current) => !current))}
            {renderViewToggle('Show anonymized row identifier', showAnonymousId, () => setShowAnonymousId((current) => !current))}
            <Text style={styles.viewOptionsTitle}>Row order</Text>
            {renderViewToggle('Randomize row order', randomizeRows, () => { setRandomOrderSeed(Math.random()); setRandomizeRows((current) => !current); props.onPageChange(() => 1); })}
            <Button label="Clear sort and filters" variant="secondary" onPress={clearSortAndFilters} />
            {headerSort || Object.keys(rowFilters).length ? <Text style={styles.viewOptionsHelp}>{headerSort ? `Sorted by ${headerSort.label} (${headerSort.direction === 'asc' ? 'ascending' : 'descending'}). ` : ''}{Object.keys(rowFilters).length ? `${Object.keys(rowFilters).length} column filter${Object.keys(rowFilters).length === 1 ? '' : 's'} active.` : ''}</Text> : null}
            {hiddenSectionCount || collapsedSectionCount || hiddenHeaderLevelCount ? <View style={styles.fullGridRestoreActions}>
              {hiddenSectionCount ? <Button label={`Unhide ${hiddenSectionCount} hidden section${hiddenSectionCount === 1 ? '' : 's'}`} variant="secondary" onPress={() => setSectionStates((current) => Object.fromEntries(Object.entries(current).filter(([, section]) => section.mode !== 'hidden')))} /> : null}
              {collapsedSectionCount ? <Button label={`Expand ${collapsedSectionCount} collapsed section${collapsedSectionCount === 1 ? '' : 's'}`} variant="secondary" onPress={() => setSectionStates((current) => Object.fromEntries(Object.entries(current).filter(([, section]) => section.mode !== 'collapsed')))} /> : null}
              {hiddenHeaderLevelCount ? <Button label={`Unhide ${hiddenHeaderLevelCount} header level${hiddenHeaderLevelCount === 1 ? '' : 's'}`} variant="secondary" onPress={() => setHiddenHeaderLevels(new Set())} /> : null}
            </View> : <Text style={styles.viewOptionsHelp}>Hide or collapse columns from a merged header’s context menu. Restore controls appear here when needed.</Text>}
          </ScrollView>
        </View>
      </Modal>
      <Modal transparent visible={!!bulkScoreAssessment} animationType="fade" onRequestClose={() => setBulkScoreAssessment(null)}>
        <View style={styles.gradebookActionOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setBulkScoreAssessment(null)} />
          <View style={styles.gradebookActionDialog}>
            <Text style={styles.viewOptionsTitle}>Set matching scores</Text>
            <Text style={styles.viewOptionsHelp}>Set {filteredStudents.length} matching students to the same score for {bulkScoreAssessment?.title}.</Text>
            {scoreMapping
              ? <SelectField label="Score category" value={bulkScoreValue} error={bulkScoreValue.trim() ? bulkScoreError : undefined} options={[{ label: 'Choose a category', value: '' }, ...scoreMapping.map((option) => ({ label: `${option.value} · ${option.percentage}%`, value: option.value }))]} onChange={setBulkScoreValue} />
              : <Field label={`Score (0–${bulkScoreAssessment?.maximumScore ?? ''})`} value={bulkScoreValue} error={bulkScoreValue.trim() ? bulkScoreError : undefined} placeholder="Enter a score" keyboardType="decimal-pad" onChangeText={setBulkScoreValue} />}
            {!bulkScoreValue.trim() ? <Text style={styles.validationError}>Enter a score to continue.</Text> : null}
            <View style={styles.gradebookActionButtons}>
              <Button label="Cancel" variant="secondary" onPress={() => setBulkScoreAssessment(null)} />
              <Button label={`Set ${filteredStudents.length} scores`} disabled={!bulkScoreValue.trim() || !!bulkScoreError} onPress={() => {
                if (!bulkScoreAssessment || !bulkScoreValue.trim()) return;
                const error = validateAssessmentValue(bulkScoreValue, bulkScoreAssessment.maximumScore, scoreMapping ?? undefined);
                if (error) return;
                props.onChangeMany(Object.fromEntries(filteredStudents.map((student) => [`${student.enrollmentId}:${bulkScoreAssessment.id}`, bulkScoreValue.trim()])));
                props.onToast(`Set ${filteredStudents.length} scores for ${bulkScoreAssessment.title}.`);
                setBulkScoreAssessment(null);
              }} />
            </View>
          </View>
        </View>
      </Modal>
      <Modal transparent visible={!!filterTarget} animationType="fade" onRequestClose={() => setFilterTarget(null)}>
        <View style={styles.gradebookActionOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setFilterTarget(null)} />
          <View style={styles.gradebookActionDialog}>
            <Text style={styles.viewOptionsTitle}>Filter {filterTarget?.label}</Text>
            <SelectField label="Condition" value={filterOperator} options={filterOperators} onChange={(value) => { setFilterOperator(value); if (value === 'is_empty' || value === 'is_not_empty') setFilterValue(''); }} />
            {filterOperator !== 'is_empty' && filterOperator !== 'is_not_empty'
              ? filterTarget?.kind === 'category'
                ? <SelectField label="Value" value={filterValue} options={[{ label: 'Select a value', value: '' }, ...(filterTarget.options ?? [])]} onChange={setFilterValue} />
                : <Field label="Value" value={filterValue} placeholder={filterTarget?.kind === 'number' ? 'Enter a number' : 'Enter text'} keyboardType={filterTarget?.kind === 'number' ? 'decimal-pad' : undefined} onChangeText={setFilterValue} />
              : null}
            {filterTarget?.kind === 'number' && filterOperator !== 'is_empty' && filterOperator !== 'is_not_empty' && filterValue.trim() && !Number.isFinite(Number(filterValue)) ? <Text style={styles.validationError}>Enter a valid number.</Text> : null}
            <View style={styles.gradebookActionButtons}>
              {filterTarget && rowFilters[filterTarget.key] ? <Button label="Clear filter" variant="secondary" onPress={() => {
                const targetKey = filterTarget.key;
                setRowFilters((current) => { const next = { ...current }; delete next[targetKey]; return next; });
                props.onPageChange(() => 1);
                setFilterTarget(null);
              }} /> : null}
              <Button label="Cancel" variant="secondary" onPress={() => setFilterTarget(null)} />
              <Button label="Apply filter" disabled={(filterOperator !== 'is_empty' && filterOperator !== 'is_not_empty' && !filterValue.trim()) || (filterTarget?.kind === 'number' && filterOperator !== 'is_empty' && filterOperator !== 'is_not_empty' && !Number.isFinite(Number(filterValue)))} onPress={() => {
                if (!filterTarget) return;
                setRowFilters((current) => ({ ...current, [filterTarget.key]: { operator: filterOperator, value: filterValue.trim() } }));
                props.onPageChange(() => 1);
                setFilterTarget(null);
              }} />
            </View>
          </View>
        </View>
      </Modal>
      <Modal transparent visible={gradebookHistoryOpen} animationType="fade" onRequestClose={() => setGradebookHistoryOpen(false)}>
        <View style={styles.gradebookActionOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setGradebookHistoryOpen(false)} />
          <View style={[styles.gradebookActionDialog, { width: 820, height: '92%', maxHeight: '92%', minHeight: 280, overflow: 'hidden' }]}>
            <View style={styles.viewOptionsHeading}>
              <Text style={styles.viewOptionsTitle}>Gradebook version history</Text>
              <Pressable accessibilityLabel="Close version history" onPress={() => setGradebookHistoryOpen(false)}><Text style={styles.viewOptionsClose}>×</Text></Pressable>
            </View>
            <Text style={styles.viewOptionsHelp}>Every recorded score change for this class. Restore any entry to put that exact saved score back; the restore itself is recorded as a new change.</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', gap: 10 }}>
              <Field label="Search versions and changes" value={gradebookHistoryQuery} placeholder="Version name, assessment, period, group, student, date, or user" onChangeText={(value) => { setGradebookHistoryQuery(value); setGradebookHistoryVisibleLimit(100); }} containerStyle={{ flex: 1, minWidth: 220 }} />
              <SelectField label="Change type" value={gradebookHistoryAction} options={[{ label: 'All changes', value: 'all' }, { label: 'Bulk edit', value: 'bulk' }, { label: 'Score added', value: 'created' }, { label: 'Score changed', value: 'updated' }, { label: 'Score cleared', value: 'deleted' }, { label: 'Score restored', value: 'restored' }, { label: 'Assessment added', value: 'assessment_created' }, { label: 'Assessment modified', value: 'assessment_updated' }, { label: 'Assessment archived', value: 'assessment_archived' }, { label: 'Assessment removed', value: 'assessment_deleted' }]} onChange={(value) => { setGradebookHistoryAction(value); setGradebookHistoryVisibleLimit(100); }} containerStyle={{ width: 170 }} />
              <SelectField label="Date" value={gradebookHistoryDate ?? 'all'} options={[{ label: 'All dates', value: 'all' }, ...historyDates.map((date) => ({ label: new Date(`${date}T12:00:00`).toLocaleDateString(), value: date }))]} onChange={(value) => { setGradebookHistoryDate(value === 'all' ? null : value); setGradebookHistoryVisibleLimit(100); }} containerStyle={{ width: 150 }} />
              <SelectField label="User" value={gradebookHistoryActor} options={[{ label: 'All users', value: 'all' }, ...historyActors]} onChange={(value) => { setGradebookHistoryActor(value); setGradebookHistoryVisibleLimit(100); }} containerStyle={{ width: 170 }} />
            </View>
            {(() => {
              const query = gradebookHistoryQuery.trim().toLocaleLowerCase();
              const allRows = gradebookHistory.map((entry) => {
                const assessment = assessments.find((item) => item.id === entry.assessmentId) ?? workspace.assessments.find((item) => item.id === entry.assessmentId);
                const student = workspace.students.find((item) => item.enrollmentId === entry.enrollmentId);
                const snapshot = entry.after ?? entry.before ?? {};
                const typeId = assessment?.gradingTypeId ?? assessment?.component ?? snapshot.grading_type_id ?? snapshot.component_key ?? '';
                const componentPath = assessment ? assessmentComponentPath(gradingSystem, typeId).map((part) => part.name).join(' · ') : '';
                const periodName = assessment ? assessmentPeriodLabel(assessment, gradingSystem.periods ?? []) : '';
                const groupId = assessment?.gradingGroupId ?? (assessment?.moduleNumber == null ? undefined : `m${assessment.moduleNumber}`);
                const groupName = (gradingSystem.groups ?? []).find((group: any) => group.id === groupId)?.name ?? (groupId ? groupId : 'No group');
                const signedInName = `${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim();
                const actor = entry.actorName || (entry.actorId === user?.id ? signedInName : '') || 'Unknown user';
                const date = new Date(entry.createdAt);
                const dateText = `${date.toLocaleString()} by ${actor}`;
                const mapping = assessment ? valueMappingForType(gradingSystem, typeId) : null;
                const formatValue = (snapshot: any) => {
                  const raw = snapshot?.categorical_value ?? snapshot?.score;
                  if (raw == null || raw === '') return 'No score';
                  const mapped = mapping?.find((option) => String(option.value) === String(raw));
                  if (mapped) return `${String(raw)} · ${mapped.percentage}%`;
                  const numeric = Number(raw);
                  if (Number.isFinite(numeric) && assessment && assessment.maximumScore > 0) return `${numeric}/${assessment.maximumScore} · ${(numeric / assessment.maximumScore * 100).toFixed(gradeDecimalPlaces)}%`;
                  return String(raw);
                };
                const actionKey = entry.eventType === 'score'
                  ? entry.action
                  : entry.action.endsWith('.insert') ? 'assessment_created'
                    : entry.action.endsWith('.delete') ? 'assessment_deleted'
                      : snapshot.status === 'archived' && entry.before?.status !== 'archived' ? 'assessment_archived' : 'assessment_updated';
                const action = actionKey === 'created' ? 'Score added' : actionKey === 'updated' ? 'Score changed' : actionKey === 'deleted' ? 'Score cleared' : actionKey === 'restored' ? 'Score restored' : actionKey === 'assessment_created' ? 'Assessment added' : actionKey === 'assessment_deleted' ? 'Assessment removed' : actionKey === 'assessment_archived' ? 'Assessment archived' : actionKey === 'assessment_updated' ? 'Assessment modified' : actionKey.replaceAll('_', ' ');
                const assessmentFieldLabels: Record<string, string> = { title: 'Title', type: 'Assessment type', component_key: 'Component', module_number: 'Module', maximum_score: 'Maximum points', assessment_date: 'Date', grading_period: 'Period', source: 'Source', grading_type_id: 'Grading type', grading_group_id: 'Group', grading_period_id: 'Period', grading_instance_weight: 'Weight', due_at: 'Due date', status: 'Status', optional: 'Optional' };
                const assessmentValue = (field: string, value: any) => {
                  if (value == null || value === '') return '—';
                  if (field === 'optional') return value ? 'Yes' : 'No';
                  if (field === 'status' || field === 'source') return String(value).replaceAll('_', ' ');
                  return String(value);
                };
                const assessmentChanges = entry.eventType === 'assessment' && entry.before && entry.after
                  ? Object.entries(assessmentFieldLabels).flatMap(([field, label]) => String(entry.before[field] ?? '') === String(entry.after[field] ?? '') ? [] : [{ label, before: assessmentValue(field, entry.before[field]), after: assessmentValue(field, entry.after[field]) }])
                  : [];
                const oldValue = entry.eventType === 'score' ? formatValue(entry.before) : '';
                const newValue = entry.eventType === 'score' ? formatValue(entry.after) : '';
                const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
                const assessmentTitle = assessment?.title ?? entry.after?.title ?? entry.before?.title ?? 'Assessment';
                const searchText = [entry.versionName, assessmentTitle, periodName, groupName, componentPath, student?.name, student?.institutionalId, student?.studentId, actor, entry.actorId, action, dateText].filter(Boolean).join(' ').toLocaleLowerCase();
                return { entry, assessment, assessmentTitle, student, periodName, groupName, componentPath, actor, dateText, dateKey, action, actionKey, oldValue, newValue, assessmentChanges, matches: !query || searchText.includes(query) };
              });
              const dateCounts = new Map<string, number>();
              allRows.forEach((row) => dateCounts.set(row.dateKey, (dateCounts.get(row.dateKey) ?? 0) + 1));
              const batchCounts = new Map<string, number>();
              allRows.forEach((row) => { if (row.entry.eventType === 'score' && row.entry.batchId) batchCounts.set(row.entry.batchId, (batchCounts.get(row.entry.batchId) ?? 0) + 1); });
              const dates = [...dateCounts.keys()].sort((a, b) => b.localeCompare(a));
              const matchingRows = allRows.filter((row) => row.matches && (gradebookHistoryAction === 'all' || (gradebookHistoryAction === 'bulk' ? !!row.entry.batchId && (batchCounts.get(row.entry.batchId) ?? 0) > 1 : row.actionKey === gradebookHistoryAction)) && (!gradebookHistoryDate || row.dateKey === gradebookHistoryDate) && (gradebookHistoryActor === 'all' || (row.entry.actorId ?? 'unknown') === gradebookHistoryActor));
              const groupedRows = new Map<string, typeof matchingRows>();
              for (const row of matchingRows) {
                const groupKey = row.entry.eventType === 'score' && row.entry.batchId ? `batch:${row.entry.batchId}` : `${row.entry.eventType}:${row.entry.id}`;
                groupedRows.set(groupKey, [...(groupedRows.get(groupKey) ?? []), row]);
              }
              const rows = [...groupedRows.values()].map((entries) => ({ ...entries[0], batchEntries: entries, isBulk: entries.length > 1 }));
              return <>
                {gradebookHistoryLoading ? <Text style={styles.help}>{gradebookHistoryScanning ? `Searching all changes… ${gradebookHistory.length} loaded` : gradebookHistory.length ? 'Loading older changes…' : 'Loading gradebook history…'}</Text> : null}
                <Text style={styles.help}>{query ? `${rows.length} matching change${rows.length === 1 ? '' : 's'} in ${gradebookHistory.length} loaded score changes${gradebookHistoryHasMore ? ' · more history is available' : ''}` : `${gradebookHistory.length} changes loaded${gradebookHistoryHasMore ? ' · more available' : ''}`}</Text>
                <View style={{ flex: 1, minHeight: 0, flexDirection: 'row', gap: 12 }}>
                  <ScrollView style={{ width: 132, flexGrow: 0, minHeight: 0, borderRightWidth: 1, borderColor: colors.border }} keyboardShouldPersistTaps="handled">
                    <Text style={[styles.help, { paddingVertical: 8, fontWeight: '700' }]}>DATES</Text>
                    {[{ key: null as string | null, label: 'All dates', count: allRows.length }, ...dates.map((date) => ({ key: date, label: new Date(`${date}T12:00:00`).toLocaleDateString(), count: dateCounts.get(date) ?? 0 }))].map((item) => <Pressable key={item.key ?? 'all'} onPress={() => { setGradebookHistoryDate(item.key); setGradebookHistoryVisibleLimit(100); }} style={{ paddingVertical: 8, paddingHorizontal: 6, marginRight: 8, borderRadius: 6, backgroundColor: gradebookHistoryDate === item.key ? colors.surfaceMuted : 'transparent' }}>
                      <Text style={{ color: colors.text, fontSize: 12, fontWeight: gradebookHistoryDate === item.key ? '700' : '400' }}>{item.label}</Text>
                      <Text style={styles.help}>{item.count} change{item.count === 1 ? '' : 's'}</Text>
                    </Pressable>)}
                    {gradebookHistoryHasMore ? <Text style={[styles.help, { padding: 6 }]}>Load older changes to add older dates.</Text> : null}
                  </ScrollView>
                  <ScrollView style={{ flex: 1, minHeight: 0 }} keyboardShouldPersistTaps="handled">
                  {rows.slice(0, gradebookHistoryVisibleLimit).map(({ entry, assessment, assessmentTitle, student, periodName, groupName, componentPath, actor, dateText, action, oldValue, newValue, assessmentChanges, batchEntries, isBulk }) => <View key={`${entry.eventType}:${entry.batchId ?? entry.id}`} style={{ gap: 7, paddingVertical: 12, borderBottomWidth: 1, borderColor: colors.border }}>
                    <View style={styles.viewOptionsHeading}>
                      <View style={{ flex: 1, gap: 4 }}>
                        {entry.versionName ? <Text style={[styles.gradebookContextActionText, { color: colors.brand, fontWeight: '700' }]}>{entry.versionName}</Text> : null}
                        <Text style={styles.gradebookContextActionText}>{isBulk ? `Bulk score edit · ${batchEntries.length} scores` : action} · {assessmentTitle}{isBulk && new Set(batchEntries.map((item) => item.assessmentTitle)).size > 1 ? ` + ${new Set(batchEntries.map((item) => item.assessmentTitle)).size - 1} assessments` : ''}</Text>
                      </View>
                      <Badge tone={entry.eventType === 'score' && entry.action === 'deleted' ? 'warning' : 'neutral'}>{entry.eventType === 'assessment' ? 'Assessment change' : isBulk ? 'Atomic bulk change' : entry.action === 'deleted' ? 'Cleared' : 'Saved version'}</Badge>
                    </View>
                    {entry.eventType === 'score' && !isBulk ? <Text style={styles.help}>{student?.name ?? 'Student'}{student?.institutionalId ? ` · ${student.institutionalId}` : ''} · {periodName || 'No period'} · {groupName}</Text> : null}
                    {isBulk ? <Pressable accessibilityRole="button" accessibilityState={{ expanded: expandedBulkHistoryIds.has(entry.batchId ?? '') }} onPress={() => setExpandedBulkHistoryIds((current) => { const next = new Set(current); const key = entry.batchId ?? ''; if (next.has(key)) next.delete(key); else next.add(key); return next; })} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 6, paddingHorizontal: 8, borderRadius: 6, backgroundColor: colors.surfaceMuted }}><Text style={styles.help}>{new Set(batchEntries.map((item) => item.entry.enrollmentId)).size} students · {new Set(batchEntries.map((item) => item.assessmentTitle)).size} assessment instances · {batchEntries.length} changes</Text><Text style={styles.help}>{expandedBulkHistoryIds.has(entry.batchId ?? '') ? 'Hide details ▲' : 'Show details ▼'}</Text></Pressable> : null}
                    {entry.eventType === 'score' && !isBulk && componentPath ? <Text style={styles.help}>{componentPath}</Text> : null}
                    {entry.eventType === 'score' && !isBulk ? <Text style={styles.gradebookContextActionText}>{oldValue}  →  {newValue}</Text> : isBulk && expandedBulkHistoryIds.has(entry.batchId ?? '') ? <ScrollView nestedScrollEnabled style={{ maxHeight: 190 }} contentContainerStyle={{ gap: 4, padding: 8 }}>{batchEntries.map((item) => <Text key={item.entry.id} style={styles.help}>{item.student?.name ?? 'Student'} · {item.assessmentTitle}: {item.oldValue} → {item.newValue}</Text>)}</ScrollView> : !isBulk && assessmentChanges.length === 1 ? <Text style={styles.gradebookContextActionText}>{assessmentChanges[0].label}: {assessmentChanges[0].before}  →  {assessmentChanges[0].after}</Text> : !isBulk && assessmentChanges.length > 1 ? <View style={{ gap: 3 }}>{assessmentChanges.map((change) => <Text key={change.label} style={styles.help}>{change.label}: {change.before}  →  {change.after}</Text>)}</View> : null}
                    <Text style={styles.help}>{dateText}</Text>
                    {entry.eventType === 'score' ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 0 }}>
                      <Pressable onPress={() => {
                        const changes = isBulk ? batchEntries.map((item) => ({ entry: item.entry, oldValue: item.oldValue })) : [{ entry, oldValue }];
                        const overlays = changes.map(({ entry: changedEntry, oldValue: previousValue }) => ({
                          enrollmentId: changedEntry.enrollmentId,
                          columnId: `assessment:${changedEntry.assessmentId}`,
                          mode: 'value-highlight' as const,
                          value: previousValue,
                          label: previousValue || 'No score',
                        }));
                        setHistoryPreviewOverlays(overlays);
                        setGradebookHistoryOpen(false);
                        props.onToast(`Previewing the previous value in ${changes.length} changed cell${changes.length === 1 ? '' : 's'}.`);
                      }} style={{ marginRight: 8, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 6, borderWidth: 1, borderColor: colors.border }}><Text style={{ color: colors.text, fontSize: 13 }}>Preview change</Text></Pressable>
                      <Pressable disabled={!assessment || !student} onPress={() => setScoreVersionToRestore({ id: entry.id, snapshot: entry.after, assessmentId: entry.assessmentId, enrollmentId: entry.enrollmentId, assessmentTitle: assessment?.title ?? 'Assessment', studentName: student?.name ?? 'Student', batchId: entry.batchId, restoreBatch: isBulk })} style={{ backgroundColor: colors.surfaceMuted, borderWidth: 1, borderColor: colors.border, borderTopLeftRadius: 7, borderBottomLeftRadius: 7, paddingHorizontal: 12, paddingVertical: 9, opacity: !assessment || !student ? 0.5 : 1 }}>
                        <Text style={{ color: colors.text, fontSize: 13, fontWeight: '600' }}>{entry.batchId ? 'Restore this change' : 'Restore to this point'}</Text>
                      </Pressable>
                      <Pressable accessibilityLabel="Choose restore scope" onPress={() => setRestoreMenuVersionId((current) => current === entry.id ? null : entry.id)} style={{ backgroundColor: colors.surfaceMuted, borderWidth: 1, borderLeftWidth: 0, borderColor: colors.border, borderTopRightRadius: 7, borderBottomRightRadius: 7, paddingHorizontal: 11, paddingVertical: 9 }}>
                        <Text style={{ color: colors.text, fontSize: 13 }}>▾</Text>
                      </Pressable>
                      <Pressable onPress={() => { setGradebookVersionNameInput(entry.versionName ?? ''); setGradebookVersionToName({ id: entry.id, name: entry.versionName ?? '' }); }} style={{ marginLeft: 10, paddingHorizontal: 10, paddingVertical: 8 }}><Text style={{ color: colors.brand, fontSize: 13 }}>{entry.versionName ? 'Rename version' : 'Name version'}</Text></Pressable>
                    </View> : <View style={{ flexDirection: 'row', alignItems: 'center', gap: 0 }}>
                      <Pressable disabled={!entry.before && !entry.after} onPress={() => setAssessmentVersionToRestore({ id: entry.id, assessmentTitle, action })} style={{ backgroundColor: colors.surfaceMuted, borderWidth: 1, borderColor: colors.border, borderTopLeftRadius: 7, borderBottomLeftRadius: 7, paddingHorizontal: 12, paddingVertical: 9, opacity: !entry.before && !entry.after ? 0.5 : 1 }}>
                        <Text style={{ color: colors.text, fontSize: 13, fontWeight: '600' }}>Restore this version</Text>
                      </Pressable>
                      <Pressable accessibilityLabel="Choose restore scope" onPress={() => setRestoreMenuVersionId((current) => current === entry.id ? null : entry.id)} style={{ backgroundColor: colors.surfaceMuted, borderWidth: 1, borderLeftWidth: 0, borderColor: colors.border, borderTopRightRadius: 7, borderBottomRightRadius: 7, paddingHorizontal: 11, paddingVertical: 9 }}>
                        <Text style={{ color: colors.text, fontSize: 13 }}>▾</Text>
                      </Pressable>
                      <Pressable onPress={() => { setGradebookVersionNameInput(entry.versionName ?? ''); setGradebookVersionToName({ id: entry.id, name: entry.versionName ?? '' }); }} style={{ marginLeft: 10, paddingHorizontal: 10, paddingVertical: 8 }}><Text style={{ color: colors.brand, fontSize: 13 }}>{entry.versionName ? 'Rename version' : 'Name version'}</Text></Pressable>
                    </View>}
                    {restoreMenuVersionId === entry.id ? <View style={{ alignSelf: 'flex-start', borderWidth: 1, borderColor: colors.border, borderRadius: 7, backgroundColor: colors.surfaceMuted, padding: 4, gap: 2 }}>
                      {entry.eventType === 'score' ? <Pressable disabled={!assessment || !student} onPress={() => { setRestoreMenuVersionId(null); setScoreVersionToRestore({ id: entry.id, snapshot: entry.after, assessmentId: entry.assessmentId, enrollmentId: entry.enrollmentId, assessmentTitle: assessment?.title ?? 'Assessment', studentName: student?.name ?? 'Student', batchId: entry.batchId, restoreBatch: (batchCounts.get(entry.batchId ?? '') ?? 0) > 1 }); }} style={{ paddingHorizontal: 10, paddingVertical: 8 }}><Text style={{ color: colors.text, fontSize: 13 }}>{(batchCounts.get(entry.batchId ?? '') ?? 0) > 1 ? 'Restore this bulk change' : 'Restore this score only'}</Text></Pressable> : null}
                      <Pressable onPress={() => { setRestoreMenuVersionId(null); setGradebookVersionToRestore({ id: entry.id, createdAt: entry.createdAt, assessmentTitle, studentName: student?.name ?? 'Student' }); }} style={{ paddingHorizontal: 10, paddingVertical: 8 }}><Text style={{ color: colors.danger, fontSize: 13 }}>Restore entire gradebook to this point</Text></Pressable>
                    </View> : null}
                  </View>)}
                  {!rows.length && !gradebookHistoryLoading ? <Text style={styles.help}>{gradebookHistory.length ? 'No changes match that search.' : 'No score changes have been recorded for this class.'}</Text> : null}
                </ScrollView>
                </View>
                {rows.length > gradebookHistoryVisibleLimit ? <Button label={`Show ${Math.min(100, rows.length - gradebookHistoryVisibleLimit)} more matching changes`} variant="secondary" onPress={() => setGradebookHistoryVisibleLimit((current) => current + 100)} /> : null}
                {gradebookHistoryHasMore ? <Button label={query ? 'Search all history' : 'Load older changes'} variant="secondary" disabled={gradebookHistoryLoading || !gradebookHistoryCursor} onPress={() => query ? void searchAllGradebookHistory() : void loadGradebookHistoryPage(gradebookHistoryCursor, true)} /> : null}
              </>;
            })()}
            <View style={styles.gradebookActionButtons}><Button label="Close" variant="secondary" onPress={() => setGradebookHistoryOpen(false)} /></View>
          </View>
        </View>
      </Modal>
      <Modal transparent visible={!!gradebookVersionToName} animationType="fade" onRequestClose={() => setGradebookVersionToName(null)}>
        <View style={styles.gradebookActionOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setGradebookVersionToName(null)} />
          <View style={styles.gradebookActionDialog}>
            <Text style={styles.viewOptionsTitle}>{gradebookVersionToName?.name ? 'Rename version' : 'Name this version'}</Text>
            <Text style={styles.viewOptionsHelp}>Use a label you can search later, such as “Midterm grades submitted.” Leave it blank to remove the name.</Text>
            <Field label="Version name" value={gradebookVersionNameInput} onChangeText={setGradebookVersionNameInput} maxLength={120} placeholder="Enter a name" />
            <View style={styles.gradebookActionButtons}>
              <Button label="Cancel" variant="secondary" onPress={() => setGradebookVersionToName(null)} />
              <Button label="Save name" onPress={() => {
                const target = gradebookVersionToName;
                if (!target) return;
                void props.onNameGradebookVersion(target.id, gradebookVersionNameInput).then(() => {
                  const normalizedName = gradebookVersionNameInput.trim() || null;
                  setGradebookHistory((current) => current.map((entry) => entry.id === target.id ? { ...entry, versionName: normalizedName } : entry));
                  setGradebookVersionToName(null);
                  props.onToast(normalizedName ? 'Version name saved.' : 'Version name removed.');
                }).catch((cause) => props.onToast(getErrorMessage(cause, 'The version name could not be saved.')));
              }} />
            </View>
          </View>
        </View>
      </Modal>
      <Modal transparent visible={!!scoreHistoryTarget} animationType="fade" onRequestClose={() => setScoreHistoryTarget(null)}>
        <View style={styles.gradebookActionOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setScoreHistoryTarget(null)} />
          <View style={styles.gradebookActionDialog}>
            <Text style={styles.viewOptionsTitle}>Score history</Text>
            {scoreHistoryTarget ? <Text style={styles.viewOptionsHelp}>{scoreHistoryTarget.student.name} · {scoreHistoryTarget.assessment.title}</Text> : null}
            {scoreHistoryLoading ? <Text style={styles.help}>Loading score history…</Text> : scoreHistory.length ? <ScrollView style={{ maxHeight: 360 }}>
              {scoreHistory.map((entry) => {
                const historyAssessment = scoreHistoryTarget?.assessment;
                const mapping = historyAssessment ? valueMappingForType(gradingSystem, historyAssessment.gradingTypeId ?? historyAssessment.component) : null;
                const formatVersionValue = (snapshot: any) => {
                  const raw = snapshot?.categorical_value ?? snapshot?.score;
                  if (raw == null || raw === '') return 'No score';
                  const mapped = mapping?.find((option) => String(option.value) === String(raw));
                  if (mapped) return `${String(raw)} · ${mapped.percentage}%`;
                  const numeric = Number(raw);
                  const maximum = historyAssessment?.maximumScore;
                  if (Number.isFinite(numeric) && maximum != null && maximum > 0) return `${numeric}/${maximum} · ${(numeric / maximum * 100).toFixed(gradeDecimalPlaces)}%`;
                  return String(raw);
                };
                const oldValue = formatVersionValue(entry.before);
                const newValue = formatVersionValue(entry.after);
                const date = new Date(entry.createdAt);
                const actionLabel = entry.action === 'created' ? 'Score added' : entry.action === 'updated' ? 'Score changed' : entry.action === 'deleted' ? 'Score cleared' : entry.action === 'restored' ? 'Score restored' : entry.action.replaceAll('_', ' ');
                const signedInName = `${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim();
                const actorLabel = entry.actorName || (entry.actorId === user?.id ? signedInName : '') || 'Unknown user';
                return <View key={entry.id} style={{ gap: 6, paddingVertical: 10, borderBottomWidth: 1, borderColor: colors.border }}>
                  <View style={styles.viewOptionsHeading}>
                    <Text style={styles.gradebookContextActionText}>{actionLabel}</Text>
                  </View>
                  <Text style={styles.gradebookContextActionText}>{oldValue}  →  {newValue}</Text>
                  <Text style={styles.help}>{date.toLocaleString()} by {actorLabel}</Text>
                  {entry.restoredFromVersionId ? <Text style={styles.help}>Restored from an earlier change</Text> : null}
                  <Button label="Restore this version" variant="secondary" onPress={() => setScoreVersionToRestore({ id: entry.id, snapshot: entry.after, assessmentId: scoreHistoryTarget!.assessment.id, enrollmentId: scoreHistoryTarget!.student.enrollmentId, assessmentTitle: scoreHistoryTarget!.assessment.title, studentName: scoreHistoryTarget!.student.name, batchId: entry.batchId })} />
                </View>;
              })}
            </ScrollView> : <Text style={styles.help}>No score changes were found for this student and assessment.</Text>}
            <View style={styles.gradebookActionButtons}><Button label="Close" variant="secondary" onPress={() => setScoreHistoryTarget(null)} /></View>
          </View>
        </View>
      </Modal>
      <Modal transparent visible={!!assessmentVersionToRestore} animationType="fade" onRequestClose={() => !restoringScoreVersion && setAssessmentVersionToRestore(null)}>
        <View style={styles.gradebookActionOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => !restoringScoreVersion && setAssessmentVersionToRestore(null)} />
          <View style={styles.gradebookActionDialog}>
            <Text style={styles.viewOptionsTitle}>Restore this assessment version?</Text>
            <Text style={styles.viewOptionsHelp}>{assessmentVersionToRestore?.assessmentTitle} · {assessmentVersionToRestore?.action}</Text>
            <Text style={styles.viewOptionsHelp}>The saved assessment settings will be restored. This restoration will be recorded as a new assessment change.</Text>
            <View style={styles.gradebookActionButtons}>
              <Button label="Cancel" variant="secondary" disabled={restoringScoreVersion} onPress={() => setAssessmentVersionToRestore(null)} />
              <Button label="Restore assessment" variant="danger" loading={restoringScoreVersion} onPress={() => {
                const version = assessmentVersionToRestore;
                if (!version) return;
                setRestoringScoreVersion(true);
                void props.onRestoreAssessmentVersion(version.id).then(() => {
                  props.onToast('Assessment version restored. The restore was added to history.');
                  setAssessmentVersionToRestore(null);
                  setGradebookHistoryVisibleLimit(100);
                  void loadGradebookHistoryPage(null, false, true);
                }).catch((cause) => props.onToast(getErrorMessage(cause, 'The assessment version could not be restored.'))).finally(() => setRestoringScoreVersion(false));
              }} />
            </View>
          </View>
        </View>
      </Modal>
      <Modal transparent visible={!!scoreVersionToRestore} animationType="fade" onRequestClose={() => setScoreVersionToRestore(null)}>
        <View style={styles.gradebookActionOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setScoreVersionToRestore(null)} />
          <View style={styles.gradebookActionDialog}>
            <Text style={styles.viewOptionsTitle}>Restore this version?</Text>
            <Text style={styles.viewOptionsHelp}>{scoreVersionToRestore?.studentName} · {scoreVersionToRestore?.assessmentTitle}</Text>
            <Text style={styles.viewOptionsHelp}>{scoreVersionToRestore?.restoreBatch ? 'The entire bulk edit will be restored atomically.' : `This will restore ${scoreVersionToRestore?.snapshot?.categorical_value ?? scoreVersionToRestore?.snapshot?.score ?? 'No score'}.`} The current value will remain in history as a new change.</Text>
            <View style={styles.gradebookActionButtons}>
              <Button label="Cancel" variant="secondary" disabled={restoringScoreVersion} onPress={() => setScoreVersionToRestore(null)} />
              <Button label={scoreVersionToRestore?.restoreBatch ? 'Restore bulk change' : 'Restore score'} variant="danger" loading={restoringScoreVersion} onPress={() => {
                const entry = scoreVersionToRestore;
                if (!entry) return;
                setRestoringScoreVersion(true);
                void props.onRestoreScoreVersion(entry.id, entry.assessmentId, entry.enrollmentId, false, !!entry.restoreBatch).then(() => {
                  props.onToast('Selected version restored. The restore was added to history.');
                  setScoreVersionToRestore(null);
                  if (scoreHistoryTarget) setScoreHistoryTarget(null);
                  if (gradebookHistoryOpen) {
                    setGradebookHistoryVisibleLimit(100);
                    void loadGradebookHistoryPage(null, false, true);
                  }
                }).catch((cause) => props.onToast(getErrorMessage(cause, 'The score could not be restored.'))).finally(() => setRestoringScoreVersion(false));
              }} />
            </View>
          </View>
        </View>
      </Modal>
      <Modal transparent visible={!!gradebookVersionToRestore} animationType="fade" onRequestClose={() => setGradebookVersionToRestore(null)}>
        <View style={styles.gradebookActionOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => !restoringScoreVersion && setGradebookVersionToRestore(null)} />
          <View style={styles.gradebookActionDialog}>
            <Text style={styles.viewOptionsTitle}>Restore entire gradebook?</Text>
            <Text style={styles.viewOptionsHelp}>This restores all student assessment scores in this class to the state recorded at {gradebookVersionToRestore ? new Date(gradebookVersionToRestore.createdAt).toLocaleString() : ''}.</Text>
            <Text style={styles.viewOptionsHelp}>Later score changes will be replaced, but remain in history. The whole-gradebook restore will be recorded as new history entries. You can use those entries to restore individual scores if needed.</Text>
            <Text style={styles.help}>Selected history entry: {gradebookVersionToRestore?.studentName} · {gradebookVersionToRestore?.assessmentTitle}</Text>
            <View style={styles.gradebookActionButtons}>
              <Button label="Cancel" variant="secondary" disabled={restoringScoreVersion} onPress={() => setGradebookVersionToRestore(null)} />
              <Button label="Restore entire gradebook" variant="danger" loading={restoringScoreVersion} onPress={() => {
                const version = gradebookVersionToRestore;
                if (!version) return;
                setRestoringScoreVersion(true);
                void props.onRestoreGradebookVersion(version.id).then((affected) => {
                  props.onToast(`Gradebook restored. ${affected} score${affected === 1 ? '' : 's'} changed; the restore is in history.`);
                  setGradebookVersionToRestore(null);
                  void loadGradebookHistoryPage(null, false);
                }).catch((cause) => props.onToast(getErrorMessage(cause, 'The gradebook could not be restored.'))).finally(() => setRestoringScoreVersion(false));
              }} />
            </View>
          </View>
        </View>
      </Modal>
      <Modal transparent visible={!!gradeExplanationTarget} animationType="fade" onRequestClose={() => setGradeExplanationTarget(null)}>
        <View style={styles.gradebookActionOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setGradeExplanationTarget(null)} />
          <View style={[styles.gradebookActionDialog, { width: 760, height: '90%', maxHeight: '90%', overflow: 'hidden' }]}>
            <Text style={styles.viewOptionsTitle}>Grade explanation</Text>
            {gradeExplanationTarget ? (() => {
              const { column, student } = gradeExplanationTarget;
              const result = gradeResults.get(student.enrollmentId) ?? calculateFullViewGrades(workspace, student.enrollmentId, gradingSystem, props.values, missingScoreHandling);
              const computed = displayedFullViewColumnValue(column, student.enrollmentId, result, workspace, props.values, gradingSystem, calculatedCellDisplay);
              const value = column.kind === 'final_equivalent'
                ? `${result.pointGrade == null ? '—' : result.pointGrade.toFixed(gradeDecimalPlaces)}${result.letterGrade ? ` / ${result.letterGrade}` : ''}`
                : column.kind === 'final_status' ? ((result as any).gradebookStatus ?? (result.remarks === 'passing' ? 'Pass' : result.remarks === 'failing' ? 'Fail' : 'Incomplete'))
                : gradePercent(typeof computed === 'number' ? computed : null, gradeDecimalPlaces, showGradePercentSign);
              const periodValue = column.kind === 'period' ? result.periods?.[column.targetId ?? ''] : null;
              const component = column.targetId ? (gradingSystem.components ?? []).find((item: any) => item.id === column.targetId) : null;
              const root = (gradingSystem.components ?? []).find((item: any) => item.id === gradingSystem.calculationRootComponentId);
              const calculationNode = column.kind === 'group' ? root : component;
              const references = calculationNode?.calculation?.components ?? [];
              const matchingAssessments = workspace.assessments.filter((assessment) => {
                if (column.periodId && assessment.gradingPeriodId !== column.periodId) return false;
                const assessmentGroupId = assessment.gradingGroupId ?? (assessment.moduleNumber == null ? undefined : `m${assessment.moduleNumber}`);
                if (column.groupId && assessmentGroupId !== column.groupId) return false;
                if (column.kind === 'component' && column.targetId && !assessmentComponentPath(gradingSystem, assessment.gradingTypeId ?? assessment.component).some((item) => item.id === column.targetId)) return false;
                if (column.kind === 'non_period' && assessment.gradingPeriodId) return false;
                return true;
              });
              const periodRule = (gradingSystem.periodCalculation?.rules ?? []).find((rule: any) => rule.periodId === column.targetId);
              const sourceLabel = column.kind === 'final' ? `Final result uses ${gradingSystem.finalResult?.source ?? 'the configured result'}${gradingSystem.finalResult?.periodId ? ` for ${(gradingSystem.periods ?? []).find((item: any) => item.id === gradingSystem.finalResult.periodId)?.name ?? gradingSystem.finalResult.periodId}` : ''}${gradingSystem.finalResult?.componentId ? ` (${(gradingSystem.components ?? []).find((item: any) => item.id === gradingSystem.finalResult.componentId)?.name ?? gradingSystem.finalResult.componentId})` : ''}.`
                : column.kind === 'period' ? `Period strategy: ${gradingSystem.periodCalculation?.mode ?? 'default'}${periodRule ? `; rule: ${periodRule.source ?? periodRule.mode ?? 'configured period calculation'}` : ''}.`
                : column.kind === 'final_equivalent' ? `Point/letter grade conversion: ${gradingSystem.finalGradeConversion?.type ?? gradingSystem.finalGradeConversion?.mode ?? 'configured conversion'}; passing threshold ${gradingSystem.finalGradeConversion?.passingPercentage ?? 'not set'}%.`
                : column.kind === 'final_status' ? 'Pass and fail follow the grading system threshold. Missing required assessment results stay incomplete while the term is ongoing, become incomplete final after the term ends, and become fail if even full marks on the missing work cannot reach passing.'
                : column.kind === 'non_period' ? 'Non-period assessment instances under the grading system’s configured calculation root.'
                : component?.assessmentDefinition ? `${component.name}: ${component.assessmentDefinition.scoring?.mode ?? 'configured scoring'} scoring; ${component.calculation?.mode ?? 'configured aggregation'} aggregation.`
                : component?.name ?? column.leafLabel;
              const scopedComponentValue = (componentId: string, periodId?: string) => column.kind === 'group'
                ? result.groupComponents?.[column.groupId ?? column.targetId ?? '']?.[componentId]
                : column.kind === 'period' || periodId
                  ? result.periodComponents?.[periodId ?? column.periodId ?? column.targetId ?? '']?.[componentId]
                  : column.kind === 'non_period' ? result.nonPeriodComponents?.[componentId] : result.components?.[componentId];
              const weightNumber = (weight: any) => typeof weight === 'number' ? weight : weight?.value ?? (weight?.denominator ? weight.numerator / weight.denominator : null);
              const weightedTerms = references.map((reference: any) => {
                const child = (gradingSystem.components ?? []).find((item: any) => item.id === reference.componentId);
                const childValue = scopedComponentValue(reference.componentId, reference.periodId);
                const weight = weightNumber(reference.weight);
                return { key: `${reference.componentId}-${reference.periodId ?? ''}`, name: child?.name ?? reference.componentId, childValue, weight, contribution: typeof childValue === 'number' && typeof weight === 'number' ? childValue * weight : null };
              });
              const aggregationMode = component?.assessmentDefinition?.aggregation?.mode ?? calculationNode?.calculation?.weightMode ?? 'equal';
              const denominator = calculationNode?.calculation?.weightMode === 'absolute' ? 1 : weightedTerms.reduce((sum: number, term: any) => sum + (term.contribution == null ? 0 : term.weight ?? 0), 0);
              const sectionStyle = { gap: 8, padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 9, backgroundColor: colors.surfaceMuted } as const;
              const sectionTitleStyle = { color: colors.text, fontSize: 13, fontWeight: '700' as const };
              const gradeStatus = (result as any).gradebookStatus ?? (result.remarks === 'passing' ? 'Pass' : result.remarks === 'failing' ? 'Fail' : 'Incomplete');
              const gradeStatusTone = gradeStatus === 'Pass' ? 'success' : gradeStatus === 'Fail' ? 'danger' : gradeStatus.includes('ongoing') ? 'info' : 'warning';
              return <View style={{ flex: 1, minHeight: 0, gap: 12 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, borderRadius: 10, backgroundColor: colors.surfaceMuted }}>
                  <View style={{ flex: 1, gap: 4 }}>
                    <Text style={styles.viewOptionsTitle}>{column.leafLabel}</Text>
                    <Text style={styles.help}>{student.name}</Text>
                  </View>
                  <Text style={{ color: colors.text, fontSize: 23, lineHeight: 29, fontWeight: '700' }}>{value}</Text>
                  <Badge tone={gradeStatusTone}>{gradeStatus}</Badge>
                </View>
                <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ gap: 10, paddingBottom: 4 }}>
                  <View style={sectionStyle}>
                    <Text style={sectionTitleStyle}>Calculation</Text>
                    <Text style={styles.help}>{sourceLabel}</Text>
                    {column.kind === 'final' ? <Text style={styles.help}>Percentage: {result.rawFinal == null ? 'not available' : `${result.rawFinal.toFixed(gradeDecimalPlaces)}%`} · Passing threshold: {gradingSystem.finalGradeConversion?.passingPercentage ?? 'not configured'}%</Text> : null}
                    {column.kind === 'final_equivalent' ? <Text style={styles.help}>Converted from {result.rawFinal == null ? 'no percentage grade' : `${result.rawFinal.toFixed(gradeDecimalPlaces)}%`} using the configured passing/failing scale.</Text> : null}
                    {column.kind === 'period' ? <Text style={styles.help}>Period grade: {periodValue == null ? 'not available' : `${periodValue.toFixed(gradeDecimalPlaces)}%`}</Text> : null}
                  </View>
                  {weightedTerms.length ? <View style={sectionStyle}>
                    <Text style={sectionTitleStyle}>Weighted inputs</Text>
                    <Text style={styles.help}>{calculationNode?.calculation?.weightMode ?? 'Relative'} weights · {calculationNode?.calculation?.rules?.length ? 'Conditional rules may replace the default inputs.' : 'Each value is multiplied by its configured weight.'}</Text>
                    {weightedTerms.map((term: any) => <View key={term.key} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, paddingVertical: 5, borderBottomWidth: 1, borderColor: colors.border }}>
                      <View style={{ flex: 1 }}><Text style={styles.gradebookContextActionText}>{term.name}</Text><Text style={styles.help}>{gradePercent(typeof term.childValue === 'number' ? term.childValue : null, gradeDecimalPlaces, showGradePercentSign)}{term.weight == null ? '' : ` × ${term.weight}`}</Text></View>
                      <Text style={styles.help}>{term.contribution == null ? 'Not included' : `${term.contribution.toFixed(gradeDecimalPlaces)} contribution points`}</Text>
                    </View>)}
                    {denominator > 0 ? <Text style={styles.help}>Weighted total ÷ {calculationNode?.calculation?.weightMode === 'absolute' ? '1' : denominator.toFixed(4)}.</Text> : null}
                  </View> : null}
                  {component?.assessmentDefinition ? <View style={sectionStyle}>
                    <Text style={sectionTitleStyle}>Assessment rules</Text>
                    <Text style={styles.help}>{aggregationMode} aggregation · {component.assessmentDefinition.scoring?.mode?.replaceAll('_', ' ') ?? 'numeric scores'}</Text>
                    {component.assessmentDefinition.scoring?.mode === 'value_mapping' ? <Text style={styles.help}>Categories map to percentages; unmapped values are excluded.</Text> : component.assessmentDefinition.scoring?.mode === 'numeric_mapping' ? <Text style={styles.help}>Uses the highest mapping threshold at or below the score.</Text> : null}
                    <Text style={styles.help}>Missing results: {missingScoreHandling === 'ignore' ? 'ignored' : missingScoreHandling === 'zero' ? 'counted as 0%' : 'counted as 100%'}.</Text>
                  </View> : null}
                  <View style={sectionStyle}>
                    <Text style={sectionTitleStyle}>Assessment results</Text>
                    {matchingAssessments.map((assessment) => {
                      const raw = props.values[`${student.enrollmentId}:${assessment.id}`] ?? storedAssessmentValue(workspace, student.enrollmentId, assessment.id);
                      const mapping = valueMappingForType(gradingSystem, assessment.gradingTypeId ?? assessment.component);
                      const mapped = mapping?.find((option) => String(option.value) === String(raw));
                      const numeric = raw == null || raw === '' ? null : Number(raw);
                      const percent = mapped?.percentage ?? (Number.isFinite(numeric) && assessment.maximumScore > 0 ? numeric! / assessment.maximumScore * 100 : null);
                      const periodName = (gradingSystem.periods ?? []).find((item: any) => item.id === assessment.gradingPeriodId)?.name;
                      return <View key={assessment.id} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, paddingVertical: 6, borderBottomWidth: 1, borderColor: colors.border }}>
                        <View style={{ flex: 1 }}><Text style={styles.gradebookContextActionText}>{assessment.title}</Text><Text style={styles.help}>{[periodName, assessmentGroupLabel(assessment, gradingSystem.groups ?? [])].filter(Boolean).join(' · ')}</Text></View>
                        <Text style={styles.gradebookContextActionText}>{raw == null || raw === '' ? 'Unscored' : `${String(raw)}${percent == null ? '' : ` → ${percent.toFixed(gradeDecimalPlaces)}%`}`}</Text>
                      </View>;
                    })}
                    {!matchingAssessments.length ? <Text style={styles.help}>No matching assessment instances.</Text> : null}
                  </View>
                </ScrollView>
              </View>;
            })() : null}
            <View style={styles.gradebookActionButtons}><Button label="Close" variant="secondary" onPress={() => setGradeExplanationTarget(null)} /></View>
          </View>
        </View>
      </Modal>
      <Modal transparent visible={scoreImportOpen} animationType="fade" onRequestClose={() => setScoreImportOpen(false)}>
        <View style={styles.gradebookActionOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setScoreImportOpen(false)} />
          <View style={[styles.gradebookActionDialog, { maxHeight: '90%' }]}>
            <Text style={styles.viewOptionsTitle}>Import assessment scores</Text>
            <Text style={styles.viewOptionsHelp}>Use the template so student IDs and assessment headers match this class. Blank cells are ignored. Invalid rows are skipped.</Text>
            <View style={styles.actions}>
              <Button label="Download template" variant="secondary" onPress={() => void downloadScoreImportTemplate().catch((cause) => props.onToast(getErrorMessage(cause, 'The template could not be created.')))} />
              <Button label={scoreImporting ? 'Reading…' : 'Choose Excel or CSV'} disabled={scoreImporting} onPress={() => void chooseScoreImportFile()} />
            </View>
            {scoreImportPreview ? <>
              <Text style={styles.help}>{scoreImportPreview.fileName} · {scoreImportPreview.inputCount} score values in {scoreImportPreview.rows.filter((row) => !row.errors.length).length} valid rows · {scoreImportPreview.rows.filter((row) => row.errors.length).length} rows with issues</Text>
              <ScrollView style={{ maxHeight: 340 }}>
                {scoreImportPreview.rows.slice(0, 50).map((row, index) => <View key={`${row.studentLabel}-${index}`} style={styles.gradebookContextAction}>
                  <View style={styles.flex}>
                    <Text style={styles.gradebookContextActionText}>{row.studentLabel} · {Object.keys(row.updates).length} score{Object.keys(row.updates).length === 1 ? '' : 's'}</Text>
                    {Object.entries(row.updates).map(([key, value]) => {
                      const assessmentId = key.slice(key.indexOf(':') + 1);
                      const assessment = assessments.find((item) => item.id === assessmentId);
                      return <Text key={key} style={styles.help}>{assessment?.title ?? 'Assessment'}: {value}</Text>;
                    })}
                    {row.errors.length ? <Text style={styles.validationError}>{row.errors.join(' ')}</Text> : null}
                  </View>
                </View>)}
                {scoreImportPreview.rows.length > 50 ? <Text style={styles.help}>Showing the first 50 of {scoreImportPreview.rows.length} rows.</Text> : null}
                {!scoreImportPreview.rows.length ? <Text style={styles.help}>No nonblank score values were found.</Text> : null}
              </ScrollView>
              <View style={styles.gradebookActionButtons}>
                <Button label="Cancel" variant="secondary" onPress={() => { setScoreImportOpen(false); setScoreImportPreview(null); }} />
                <Button label={`Import ${scoreImportPreview.inputCount} valid scores`} disabled={!scoreImportPreview.inputCount || !scoreImportPreview.rows.some((row) => row.enrollmentId && !row.errors.length && Object.keys(row.updates).length)} onPress={applyScoreImport} />
              </View>
            </> : null}
          </View>
        </View>
      </Modal>
    </>
  );
}

function GradebookContextMenu({ menu, onClose, onSelect }: { menu: GradebookContextMenuState; onClose: () => void; onSelect: (action: GradebookContextAction) => void }) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [activeSubmenu, setActiveSubmenu] = useState<string | null>(null);
  useEffect(() => { setActiveSubmenu(null); setHoveredIndex(null); }, [menu?.x, menu?.y]);
  useEffect(() => {
    if (!menu || Platform.OS !== 'web' || typeof document === 'undefined') return;
    const isInsideMenu = (event: any) => !!event.target?.closest?.('[data-gradebook-context-menu="true"]');
    const handleContextMenu = (event: any) => {
      event.preventDefault?.();
      if (isInsideMenu(event)) {
        event.stopPropagation?.();
        return;
      }
      onClose();
    };
    const handleOutsidePointer = (event: any) => { if (!isInsideMenu(event)) onClose(); };
    document.addEventListener('contextmenu', handleContextMenu, true);
    document.addEventListener('mousedown', handleOutsidePointer, true);
    return () => {
      document.removeEventListener('contextmenu', handleContextMenu, true);
      document.removeEventListener('mousedown', handleOutsidePointer, true);
    };
  }, [menu, onClose]);
  const activeGroup = menu?.actions.find((action) => action.label === activeSubmenu && action.children);
  const actions = activeGroup?.children ?? menu?.actions ?? [];
  const viewportWidth = typeof window === 'undefined' ? 1024 : window.innerWidth;
  const viewportHeight = typeof window === 'undefined' ? 768 : window.innerHeight;
  const menuWidth = 232;
  const menuHeight = Math.min(360, Math.max(42, actions.length * 30 + 12 + (activeGroup ? 28 : 0)));
  const left = menu ? Math.max(4, Math.min(menu.x, viewportWidth - menuWidth - 4)) : 0;
  const top = menu ? Math.max(4, Math.min(menu.y, viewportHeight - menuHeight - 4)) : 0;
  return <Modal transparent visible={!!menu} animationType="fade" onRequestClose={onClose}>
    <View pointerEvents="box-none" style={styles.gradebookContextOverlay}>
      {menu ? <View {...({ dataSet: { gradebookContextMenu: 'true' } } as any)} style={[styles.gradebookContextMenu, { left, top, width: menuWidth, maxHeight: Math.max(42, viewportHeight - top - 4) }]}>
        {activeGroup ? <Pressable onPress={() => setActiveSubmenu(null)} style={[styles.gradebookContextAction, styles.gradebookContextBack]}><Text style={styles.gradebookContextBackArrow}>‹</Text><Text style={styles.gradebookContextActionText}>{activeGroup.label}</Text></Pressable> : null}
        <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={actions.length > 10}>
        {actions.map((action, index) => <Pressable key={`${action.label}-${index}`} {...({ onContextMenu: (event: any) => event.preventDefault?.(), onMouseEnter: () => setHoveredIndex(index), onMouseLeave: () => setHoveredIndex(null) } as any)} onPress={() => action.children ? setActiveSubmenu(action.label) : onSelect(action)} style={[styles.gradebookContextAction, hoveredIndex === index ? styles.gradebookHoverTint : null]}>
          <AppIcon name={gradebookContextIcon(action.label)} size={13} color={action.destructive ? colors.danger : colors.textMuted} />
          <Text style={[styles.gradebookContextActionText, action.destructive && styles.dangerText]}>{action.label}</Text>
          {action.children ? <Text style={styles.gradebookContextSubmenuArrow}>›</Text> : null}
        </Pressable>)}
        </ScrollView>
      </View> : null}
    </View>
  </Modal>;
}

