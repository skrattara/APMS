import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import type { Paragraph, Table } from 'docx';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { aggregateRows, drilldownRows, filterRows, groupRows, pivotRows, sortRows, type Aggregation } from '@apms/domain';
import { Button, Card } from '@/components/ui';
import { colors } from '@/theme/tokens';
import ReportPdfPreview from './ReportPdfPreview';
import { formatStudentId } from '@/utils/studentId';

export type ReportRecord = Record<string, any>;
export type ReportScopeOption = { label: string; value: string; loadRows: () => Promise<ReportRecord[]> };
type ReportTemplate = 'Executive summary' | 'Detailed analysis' | 'Data table';
type Visualization = 'Bar chart' | 'Pass rate comparison' | 'Donut chart' | 'Risk distribution' | 'Trend line' | 'Assessment score range' | 'Current standing by period' | 'Score distribution' | 'Score spread by group' | 'KPI summary' | 'Attendance watchlist' | 'Missed assessment watchlist';
type ReportQuestion = 'Recommended overview' | 'Compare groups' | 'Assessment scores over time' | 'Current standing over time' | 'Risk distribution' | 'Attendance rates' | 'Missing assessments' | 'Score distribution';
type AssessmentBreakdown = 'Overall' | 'Period' | 'Component' | 'Group' | 'Assessment type';
const labelize = (value: string) => value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
const filename = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'apms-report';
const accentColors: Record<string, string> = { Burgundy: '6B2C1F', Ocean: '246899', Evergreen: '28724F' };
const criticalWords = /high|medium|critical|elevated|failing|at.?risk|overdue|error|failed/i;

function toBase64(bytes: Uint8Array) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]; const b = bytes[index + 1]; const c = bytes[index + 2];
    output += alphabet[a >> 2] + alphabet[((a & 3) << 4) | ((b ?? 0) >> 4)] + (b === undefined ? '=' : alphabet[((b & 15) << 2) | ((c ?? 0) >> 6)]) + (c === undefined ? '=' : alphabet[c & 63]);
  }
  return output;
}

async function download(blob: Blob, name: string) {
  if (Platform.OS === 'web') {
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
    anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); return;
  }
  const directory = FileSystem.cacheDirectory ?? FileSystem.documentDirectory;
  if (!directory) throw new Error('A local document folder is unavailable on this device.');
  const uri = `${directory}${name}`;
  await FileSystem.writeAsStringAsync(uri, toBase64(new Uint8Array(await blob.arrayBuffer())), { encoding: FileSystem.EncodingType.Base64 });
  if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri, { dialogTitle: 'Share APMS report' });
  else throw new Error('Document sharing is unavailable on this device.');
}

function recommendedField(fields: string[], rows: ReportRecord[], mode: 'group' | 'value') {
  const numeric = (field: string) => rows.some((row) => typeof row[field] === 'number');
  if (mode === 'value') {
    const numericFields = fields.filter(numeric);
    const priorities = [/current.?standing/i, /final.?grade/i, /mapped.*percent|percentage/i, /^score$/i, /grade|mark/i, /attendance.*rate|attendance.*percent/i];
    return priorities.flatMap((pattern) => numericFields.filter((field) => pattern.test(field)))[0] ?? numericFields.find((field) => !/(^id$|student.?id|enrollment.?id|probability|confidence)/i.test(field)) ?? '';
  }
  const candidates = fields.filter((field) => {
    if (/(^id$|.*id$|uuid|token)/i.test(field)) return false;
    const values = rows.map((row) => row[field]).filter((item) => item !== null && item !== undefined);
    if (values.some((item) => typeof item === 'object' || typeof item === 'function')) return false;
    const cardinality = new Set(values.map(String)).size;
    const knownDimension = /class|course|section|subject|program|department|year.?level|grade.?level|semester|term|risk|classification|status|campus/i.test(field);
    if (numeric(field)) return /year.?level|grade.?level|semester|term/i.test(field) && values.every((item) => typeof item === 'number' && Number.isInteger(item)) && cardinality > 1 && cardinality <= 30;
    return cardinality > 1 && (knownDimension || cardinality <= 30);
  });
  const priority = [/class|classname|section|subject|program/i, /year.?level|grade.?level/i, /risk(level|label|category)?/i, /classification|status|severity/i, /category|type|role/i];
  return priority.flatMap((pattern) => candidates.filter((field) => pattern.test(field))).at(0) ?? candidates[0] ?? '';
}

function semanticInsights(rows: ReportRecord[], fields: string[]) {
  if (!rows.length) return [];
  const studentField = fields.find((field) => /^(student|studentname|label|name)$/i.test(field));
  const classField = fields.find((field) => /^(class|classname|section|category)$/i.test(field));
  const riskField = fields.find((field) => /^(risklevel|risklabel|riskcategory)$/i.test(field)) ?? fields.find((field) => /^(classification|severity|risk)$/i.test(field));
  const missingField = fields.find((field) => /missing.*assessment|assessment.*missing/i.test(field));
  const attendanceField = fields.find((field) => /attendance(rate|percent|percentage)?$/i.test(field));
  const standingField = fields.find((field) => /^(currentstanding|finalgrade|standing)$/i.test(field)) ?? fields.find((field) => /^score$/i.test(field));
  const predictionField = fields.find((field) => /^predictedstanding$/i.test(field) && rows.some((row) => typeof row[field] === 'number'));
  const nameFor = (row: ReportRecord) => String(studentField ? row[studentField] ?? 'Unknown student' : row.label ?? row.student ?? 'Unknown student');
  const topNames = (names: string[]) => `${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} others` : ''}`;
  const insights: string[] = [];
  if (riskField) {
    const counts = new Map<string, number>();
    for (const row of rows) { const level = String(row[riskField] ?? 'Unclassified'); counts.set(level, (counts.get(level) ?? 0) + 1); }
    insights.push(`Risk profile — ${[...counts].sort((a, b) => b[1] - a[1]).map(([level, count]) => `${level}: ${count} (${Math.round(count * 100 / rows.length)}%)`).join(' · ')}. Percentages use ${rows.length} included student records.`);
  }
  if (missingField) {
    const ranked = rows.filter((row) => row[missingField] != null).map((row) => ({ name: nameFor(row), count: Number(row[missingField]) })).filter((row) => Number.isFinite(row.count)).sort((a, b) => b.count - a.count);
    if (ranked.length && ranked[0].count > 0) {
      const highest = ranked.filter((row) => row.count === ranked[0].count).map((row) => row.name);
      insights.push(`Most missed assessments — ${topNames(highest)}: ${ranked[0].count}. Tied students are shown together.`);
    }
  }
  if (attendanceField) {
    const ranked = rows.filter((row) => row[attendanceField] != null).map((row) => ({ name: nameFor(row), rate: Number(row[attendanceField]) })).filter((row) => Number.isFinite(row.rate)).sort((a, b) => a.rate - b.rate);
    if (ranked.length) {
      const lowest = ranked.filter((row) => row.rate === ranked[0].rate).map((row) => row.name);
      insights.push(`Attendance follow-up — ${topNames(lowest)} have the lowest recorded rate (${ranked[0].rate.toFixed(1)}%). Unrecorded sessions are excluded.`);
    }
  }
  if (classField && standingField) {
    const byClass = new Map<string, number[]>();
    for (const row of rows) { if (row[standingField] == null || row[standingField] === '') continue; const score = Number(row[standingField]); const name = String(row[classField] ?? 'Unspecified'); if (Number.isFinite(score)) { const scores = byClass.get(name) ?? []; scores.push(score); byClass.set(name, scores); } }
    const averages = [...byClass].map(([name, scores]) => ({ name, average: scores.reduce((sum, score) => sum + score, 0) / scores.length, count: scores.length })).sort((a, b) => b.average - a.average);
    if (averages.length > 1) {
      insights.push(`Class comparison — highest average current standing is ${averages[0].name} at ${averages[0].average.toFixed(1)}% (${averages[0].count} student${averages[0].count === 1 ? '' : 's'} with a recorded standing).`);
      insights.push(`Lowest average current standing is ${averages[averages.length - 1].name} at ${averages[averages.length - 1].average.toFixed(1)}%. This comparison uses recorded standings only.`);
    } else if (averages.length === 1) {
      insights.push(`Current standing in ${averages[0].name} averages ${averages[0].average.toFixed(1)}% across ${averages[0].count} student${averages[0].count === 1 ? '' : 's'} with a recorded standing; there is only one class in scope.`);
    }
  }
  if (predictionField) {
    const predicted = rows.filter((row) => row[predictionField] != null).map((row) => Number(row[predictionField])).filter(Number.isFinite);
    if (predicted.length) insights.push(`Performance outlook — predictions are available for ${predicted.length} of ${rows.length} students; mean predicted standing is ${(predicted.reduce((sum, value) => sum + value, 0) / predicted.length).toFixed(1)}%. Predictions are advisory, not official grades.`);
  } else if (fields.includes('performancePrediction')) {
    const predicted = rows.map((row) => row.performancePrediction?.predictedStanding).filter((item: unknown): item is number => typeof item === 'number' && Number.isFinite(item));
    if (predicted.length) insights.push(`Performance outlook — predictions are available for ${predicted.length} of ${rows.length} students; mean predicted standing is ${(predicted.reduce((sum, value) => sum + value, 0) / predicted.length).toFixed(1)}%. Predictions are advisory, not official grades.`);
  }
  return insights;
}

function uniqueAppliedSchemas(rows: ReportRecord[]) {
  const schemas = new Map<string, { className: string; gradingSystem: unknown; appliedGradingSystem: unknown; evaluationCriteria: unknown }>();
  for (const row of rows) {
    const className = String(row.class ?? row.category ?? 'Class');
    if (!schemas.has(className)) schemas.set(className, { className, gradingSystem: row.gradingSystemSchema ?? null, appliedGradingSystem: row.appliedGradingSystem ?? null, evaluationCriteria: row.evaluationCriteriaSchema ?? null });
  }
  return [...schemas.values()];
}

function compactReportRecords(rows: ReportRecord[]) {
  return rows.map((row) => Object.fromEntries(Object.entries(row).filter(([field]) => !['gradingSystemSchema', 'appliedGradingSystem', 'evaluationCriteriaSchema'].includes(field))));
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

type ChartItem = { label: string; count: number; amount: number; minimum?: number; lowerQuartile?: number; median?: number; upperQuartile?: number; maximum?: number; series?: string; dateKey?: string };

function quantile(sortedValues: number[], fraction: number) {
  if (!sortedValues.length) return 0;
  const position = (sortedValues.length - 1) * fraction;
  const lower = Math.floor(position); const upper = Math.ceil(position);
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (position - lower);
}

function gradingLabel(schema: ReportRecord | null | undefined, kind: AssessmentBreakdown, item: ReportRecord): string {
  if (kind === 'Overall') return 'Overall';
  const id = kind === 'Period' ? item?.gradingPeriodId : kind === 'Group' ? item?.gradingGroupId : item?.gradingTypeId;
  if (kind === 'Assessment type') return String(item?.assessmentTypeName ?? item?.typeName ?? item?.type ?? (id ? findSchemaName(schema?.assessmentTypes, id) : '') ?? 'Unclassified type');
  if (kind === 'Period') return String((id ? findSchemaName(schema?.periods, id) : '') || 'Unspecified period');
  if (kind === 'Group') return String((id ? findSchemaName(schema?.groups, id) : '') || 'Unspecified group');
  const component = (Array.isArray(schema?.components) ? schema.components : []).find((entry: ReportRecord) => String(entry?.assessmentDefinition?.typeId ?? entry?.assessmentTypeId ?? entry?.typeId ?? '') === String(id ?? ''));
  return String(component?.name ?? component?.label ?? (id ? findSchemaName(schema?.assessmentTypes, id) : '') ?? 'Unmapped component');
}

function findSchemaName(collection: unknown, id: unknown): string {
  if (!Array.isArray(collection)) return '';
  const entry = collection.find((candidate: ReportRecord) => String(candidate?.id ?? candidate?.key ?? '') === String(id));
  return String(entry?.name ?? entry?.label ?? '');
}

function assessmentScoreSeries(rows: ReportRecord[], breakdown: AssessmentBreakdown): ChartItem[] {
  const byPeriod = new Map<string, { series: string; date: string; scores: number[] }>();
  for (const row of rows) {
    const assessments = Array.isArray(row.assessmentResults) ? row.assessmentResults : [];
    for (const item of assessments) {
      const score = Number(item?.mappedPercentage);
      const date = String(item?.date ?? '');
      if (!date || !Number.isFinite(new Date(date).getTime()) || !Number.isFinite(score)) continue;
      const dateKey = new Date(date).toISOString().slice(0, 10);
      const series = gradingLabel(row.gradingSystemSchema, breakdown, item);
      const key = `${dateKey}:${series}`;
      const values = byPeriod.get(key) ?? { series, date: dateKey, scores: [] };
      values.scores.push(score);
      byPeriod.set(key, values);
    }
  }
  const seriesCounts = new Map<string, number>();
  for (const point of byPeriod.values()) seriesCounts.set(point.series, (seriesCounts.get(point.series) ?? 0) + point.scores.length);
  const retainedSeries = new Set([...seriesCounts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 6).map(([series]) => series));
  const grouped = new Map<string, { series: string; date: string; scores: number[] }>();
  for (const point of byPeriod.values()) {
    const series = retainedSeries.has(point.series) ? point.series : 'Other categories';
    const key = `${point.date}:${series}`;
    const values = grouped.get(key) ?? { series, date: point.date, scores: [] };
    values.scores.push(...point.scores);
    grouped.set(key, values);
  }
  return [...grouped.values()].sort((left, right) => left.series.localeCompare(right.series) || left.date.localeCompare(right.date)).map(({ series, date, scores }) => ({
    label: new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    dateKey: date,
    series,
    count: scores.length,
    amount: scores.reduce((sum, score) => sum + score, 0) / scores.length,
    minimum: scores.reduce((minimum, score) => Math.min(minimum, score), Infinity),
    maximum: scores.reduce((maximum, score) => Math.max(maximum, score), -Infinity),
  }));
}

function standingPeriodSeries(rows: ReportRecord[], fields: string[]): ChartItem[] {
  const periodFields = fields.filter((field) => /^gradingPeriod_/i.test(field));
  const labels = new Map<string, string>();
  for (const row of rows) {
    const periods = Array.isArray(row.gradingSystemSchema?.periods) ? row.gradingSystemSchema.periods : [];
    for (const period of periods) labels.set(`gradingPeriod_${period.id}`, String(period.name ?? period.label ?? 'Grading period'));
  }
  return periodFields.map((field, index) => {
    const values = rows.map((row) => row[field]).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    return { label: labels.get(field) ?? labelize(field.replace(/^gradingPeriod_/i, 'Period ')), dateKey: String(index).padStart(4, '0'), count: values.length, amount: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0, minimum: values.length ? Math.min(...values) : 0, maximum: values.length ? Math.max(...values) : 0 };
  }).filter((item) => item.count > 0);
}

export function ReportComposer({ title: initialTitle, rows: initialRows, scopeLabel, description, scopeOptions = [] }: { title: string; rows: ReportRecord[]; scopeLabel: string; description: string; scopeOptions?: ReportScopeOption[] }) {
  const [reportScope, setReportScope] = useState('current');
  const [loadedScopeRows, setLoadedScopeRows] = useState<Record<string, ReportRecord[]>>({});
  const [loadingScope, setLoadingScope] = useState('');
  const scopeRequestId = useRef(0);
  const [scopeError, setScopeError] = useState('');
  const activeScopeOption = scopeOptions.find((option) => option.value === reportScope);
  const rawRows = reportScope === 'current' ? initialRows : loadedScopeRows[reportScope] ?? [];
  const activeScopeLabel = activeScopeOption?.label ?? scopeLabel;
  const chooseReportScope = async (value: string) => {
    const requestId = ++scopeRequestId.current;
    setReportScope(value);
    setScopeError('');
    if (value === 'current' || loadedScopeRows[value]) { setLoadingScope(''); return; }
    const option = scopeOptions.find((candidate) => candidate.value === value);
    if (!option) return;
    setLoadingScope(value);
    try {
      const nextRows = await option.loadRows();
      if (scopeRequestId.current === requestId) setLoadedScopeRows((current) => ({ ...current, [value]: nextRows }));
    } catch (cause) {
      if (scopeRequestId.current === requestId) { setScopeError(cause instanceof Error ? cause.message : 'This report scope could not be loaded.'); setReportScope('current'); }
    } finally {
      if (scopeRequestId.current === requestId) setLoadingScope('');
    }
  };
  const fields = useMemo(() => Object.keys(rawRows[0] ?? {}), [rawRows]);
  const [title, setTitle] = useState(initialTitle);
  const [template, setTemplate] = useState<ReportTemplate>('Executive summary');
  const [layout, setLayout] = useState<'Portrait' | 'Landscape'>('Portrait');
  const [accent, setAccent] = useState('Burgundy');
  const [groupField, setGroupField] = useState('');
  const [groupSort, setGroupSort] = useState<'highest average' | 'lowest average' | 'most students' | 'name'>('highest average');
  const [drilldownValue, setDrilldownValue] = useState('');
  const [pivotField, setPivotField] = useState('');
  const [questions, setQuestions] = useState<ReportQuestion[]>(['Recommended overview']);
  const [assessmentBreakdown, setAssessmentBreakdown] = useState<AssessmentBreakdown>(() => initialRows.some((row) => Array.isArray(row.assessmentResults) && row.assessmentResults.some((item: ReportRecord) => item?.gradingTypeId)) ? 'Assessment type' : 'Overall');
  const [reportFilters, setReportFilters] = useState<Array<{ field: string; value: string }>>([]);
  const [thresholdMode, setThresholdMode] = useState('');
  const [standingThreshold, setStandingThreshold] = useState('70');
  const [showAdvancedBreakdown, setShowAdvancedBreakdown] = useState(false);
  const [includeSummaryTable, setIncludeSummaryTable] = useState(false);
  const [includeGradingContext, setIncludeGradingContext] = useState(true);
  const [includeFullSchemaDefinitions, setIncludeFullSchemaDefinitions] = useState(false);
  const [includeInterpretations, setIncludeInterpretations] = useState(true);
  const [autoInsights, setAutoInsights] = useState(true);
  const [concise, setConcise] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pdfUrl, setPdfUrl] = useState('');
  const [previewRequested, setPreviewRequested] = useState(false);
  const [previewGenerating, setPreviewGenerating] = useState(false);
  const [showSourceData, setShowSourceData] = useState(false);
  const previewVersion = useRef(0);
  const categoricalFields = useMemo(() => fields.filter((field) => {
    if (/(^id$|.*id$|uuid|token)/i.test(field)) return false;
    const values = rawRows.map((row) => row[field]).filter((item) => item !== null && item !== undefined);
    if (!values.length || values.some((item) => typeof item === 'object' || typeof item === 'function')) return false;
    const cardinality = new Set(values.map(String)).size;
    const numericField = rawRows.some((row) => typeof row[field] === 'number');
    const discreteAcademicLevel = /year.?level|grade.?level|semester|term/i.test(field) && values.every((item) => typeof item === 'number' && Number.isInteger(item));
    const knownDimension = /class|course|section|subject|program|department|year.?level|grade.?level|semester|term|risk|classification|status|campus/i.test(field);
    return (discreteAcademicLevel || !numericField) && cardinality > 1 && (knownDimension || cardinality <= 30);
  }), [fields, rawRows]);
  const filterFieldOptions = useMemo(() => categoricalFields.filter((field) => !/^(student|studentname|label|name)$/i.test(field)), [categoricalFields]);
  const activeFilters = useMemo(() => reportFilters.filter((filter) => filter.field && filter.value && filterFieldOptions.includes(filter.field)), [filterFieldOptions, reportFilters]);
  const rows = useMemo(() => filterRows(rawRows, activeFilters.map((filter) => ({ field: filter.field, operator: 'equals' as const, value: filter.value }))), [activeFilters, rawRows]);
  const filterOptionsByIndex = useMemo(() => reportFilters.map((filter, index) => {
    const otherFilters = reportFilters.filter((item, otherIndex) => otherIndex !== index && item.field && item.value && filterFieldOptions.includes(item.field));
    const availableRows = filterRows(rawRows, otherFilters.map((item) => ({ field: item.field, operator: 'equals' as const, value: item.value })));
    const availableFields = filterFieldOptions.filter((field) => field === filter.field || !reportFilters.some((item, otherIndex) => otherIndex !== index && item.field === field));
    const values = filter.field ? [...new Set(availableRows.map((row) => String(row[filter.field] ?? '')).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) : [];
    return { fields: availableFields, values };
  }), [filterFieldOptions, rawRows, reportFilters]);
  const automaticGroupField = recommendedField(fields, rows, 'group');
  const automaticValueField = recommendedField(fields, rows, 'value');
  const groupFieldOptions = useMemo(() => categoricalFields.filter((field) => new Set(rows.map((row) => String(row[field] ?? '')).filter(Boolean)).size > 1), [categoricalFields, rows]);
  const groupBy = groupFieldOptions.includes(groupField) ? groupField : automaticGroupField;
  const pivotFieldOptions = useMemo(() => categoricalFields.filter((field) => field !== groupBy && new Set(rows.map((row) => String(row[field] ?? '')).filter(Boolean)).size <= 12), [categoricalFields, groupBy, rows]);
  const value = automaticValueField;
  const pivotBy = pivotFieldOptions.includes(pivotField) ? pivotField : '';
  const inferredAggregation: Aggregation = !value ? 'count' : /count|total|enrollment|credits|hours/i.test(value) && !/rate|percent|percentage|average|mean/i.test(value) ? 'sum' : 'average';
  const effectiveAggregation = inferredAggregation;
  const dateFieldOptions = useMemo(() => fields.filter((field) => /date|time|updated|created|timestamp/i.test(field) && rows.some((row) => row[field] != null && Number.isFinite(new Date(String(row[field])).getTime()))), [fields, rows]);
  const dateField = dateFieldOptions[0] ?? '';
  const groupCardinality = useMemo(() => groupBy ? new Set(rows.map((row) => String(row[groupBy] ?? '')).filter(Boolean)).size : 0, [groupBy, rows]);
  const visualizationCardinality = drilldownValue ? 1 : groupCardinality;
  const studentNameField = fields.find((field) => /^(student|studentname|label|name)$/i.test(field));
  const attendanceField = fields.find((field) => /attendance(rate|percent|percentage)?$/i.test(field));
  const missedField = fields.find((field) => /missing.*assessment|assessment.*missing/i.test(field));
  const classLabelField = fields.find((field) => /^(class|classname|section|category)$/i.test(field));
  const currentStandingField = fields.find((field) => /^(currentstanding|finalgrade|standing)$/i.test(field)) ?? fields.find((field) => /^score$/i.test(field));
  const riskGroupField = fields.find((field) => /^(risklevel|risklabel|riskcategory)$/i.test(field)) ?? fields.find((field) => /^(risk|classification|severity)$/i.test(field));
  const hasAssessmentResults = rows.some((row) => Array.isArray(row.assessmentResults) && row.assessmentResults.some((result: ReportRecord) => result?.date && typeof result?.mappedPercentage === 'number'));
  const hasStandingPeriods = fields.some((field) => /^gradingPeriod_/i.test(field) && rows.some((row) => typeof row[field] === 'number' && Number.isFinite(row[field])));
  const assessmentBreakdownOptions = useMemo<AssessmentBreakdown[]>(() => {
    const options: AssessmentBreakdown[] = ['Overall'];
    for (const dimension of ['Period', 'Component', 'Group', 'Assessment type'] as const) {
      const labels = new Set<string>();
      for (const row of rows) for (const item of Array.isArray(row.assessmentResults) ? row.assessmentResults : []) {
        if (!item?.date || typeof item?.mappedPercentage !== 'number') continue;
        const label = gradingLabel(row.gradingSystemSchema, dimension, item);
        if (!/^Unspecified|^Unmapped|^Unclassified/.test(label)) labels.add(label);
      }
      if (labels.size) options.push(dimension);
    }
    return options;
  }, [rows]);
  const availableVisualizations = useMemo<Visualization[]>(() => {
    const options: Visualization[] = ['KPI summary'];
    if (groupBy && visualizationCardinality > 1) options.push('Bar chart');
    if (groupBy && visualizationCardinality > 1 && currentStandingField) options.push('Score spread by group');
    if (groupBy && visualizationCardinality > 1 && fields.some((field) => /^(classification|remarks|passstatus)$/i.test(field))) options.push('Pass rate comparison');
    // Avoid a full ring for one category and unreadable slices for many categories.
    if (groupBy && visualizationCardinality > 1 && visualizationCardinality <= 8) options.push('Donut chart');
    if (riskGroupField && rows.length) options.push('Risk distribution');
    if (dateField && value) options.push('Trend line');
    if (hasAssessmentResults) options.push('Assessment score range');
    if (hasStandingPeriods) options.push('Current standing by period');
    if (value && /score|grade|mark|rating|percent/i.test(value)) options.push('Score distribution');
    if (studentNameField && attendanceField && rows.some((row) => typeof row[attendanceField] === 'number')) options.push('Attendance watchlist');
    if (studentNameField && missedField && rows.some((row) => typeof row[missedField] === 'number')) options.push('Missed assessment watchlist');
    return options;
  }, [attendanceField, dateField, fields, groupBy, hasAssessmentResults, hasStandingPeriods, missedField, riskGroupField, rows, studentNameField, value, visualizationCardinality]);
  const questionOptions: ReportQuestion[] = [
    'Recommended overview',
    ...(groupFieldOptions.some((field) => new Set(rows.map((row) => String(row[field] ?? '')).filter(Boolean)).size > 1) ? ['Compare groups' as const] : []),
    ...(hasAssessmentResults ? ['Assessment scores over time' as const] : []),
    ...(hasStandingPeriods ? ['Current standing over time' as const] : []),
    ...(riskGroupField ? ['Risk distribution' as const] : []),
    ...(attendanceField && studentNameField ? ['Attendance rates' as const] : []),
    ...(missedField && studentNameField ? ['Missing assessments' as const] : []),
    ...(value && /score|grade|mark|rating|percent/i.test(value) ? ['Score distribution' as const] : []),
  ];
  const activeQuestions = useMemo(() => {
    const valid = questions.filter((item) => questionOptions.includes(item));
    return valid.length ? valid : ['Recommended overview' as const];
  }, [questionOptions.join('|'), questions]);
  const activeQuestionKey = activeQuestions.join('|');
  const compareSelected = activeQuestions.includes('Compare groups');
  const defaultVisualizations = useMemo<Visualization[]>(() => {
    const groupChart = groupBy && visualizationCardinality > 1
      ? /risk|status|classification|severity/i.test(groupBy) && visualizationCardinality <= 8 ? 'Donut chart' as const : 'Bar chart' as const
      : null;
    const defaults: Visualization[] = template === 'Data table' ? [] : ['KPI summary'];
    if (riskGroupField && template === 'Detailed analysis') defaults.push('Risk distribution');
    if (groupChart) defaults.push(groupChart);
    if (attendanceField && studentNameField && defaults.length < (template === 'Detailed analysis' ? 6 : 4)) defaults.push('Attendance watchlist');
    if (missedField && studentNameField && defaults.length < (template === 'Detailed analysis' ? 6 : 4)) defaults.push('Missed assessment watchlist');
    if (template === 'Detailed analysis' && hasAssessmentResults) defaults.push('Assessment score range');
    else if (template === 'Detailed analysis' && dateField && value) defaults.push('Trend line');
    if (template === 'Detailed analysis' && value && /score|grade|mark|percent|standing/i.test(value)) defaults.push('Score distribution');
    return defaults.filter((item) => availableVisualizations.includes(item));
  }, [attendanceField, availableVisualizations, dateField, groupBy, hasAssessmentResults, missedField, riskGroupField, studentNameField, template, value, visualizationCardinality]);
  const visualizationGroupField = activeQuestions.includes('Risk distribution') && riskGroupField ? riskGroupField : groupBy;
  const activeVisualizations = useMemo<Visualization[]>(() => {
    if (activeQuestions.includes('Recommended overview')) return defaultVisualizations.filter((item) => availableVisualizations.includes(item));
    const selected: Visualization[] = ['KPI summary'];
    if (activeQuestions.includes('Compare groups')) selected.push('Bar chart', ...(availableVisualizations.includes('Pass rate comparison') ? ['Pass rate comparison' as const] : []), ...(availableVisualizations.includes('Score spread by group') ? ['Score spread by group' as const] : []));
    if (activeQuestions.includes('Assessment scores over time')) selected.push('Assessment score range');
    if (activeQuestions.includes('Current standing over time')) selected.push('Current standing by period');
    if (activeQuestions.includes('Risk distribution')) selected.push('Risk distribution');
    if (activeQuestions.includes('Attendance rates')) selected.push('Attendance watchlist');
    if (activeQuestions.includes('Missing assessments')) selected.push('Missed assessment watchlist');
    if (activeQuestions.includes('Score distribution')) selected.push('Score distribution');
    return [...new Set(selected)].filter((item) => availableVisualizations.includes(item));
  }, [activeQuestionKey, attendanceField, availableVisualizations, defaultVisualizations, missedField]);
  const visualizationTitle = (kind: Visualization) => kind === 'Donut chart' ? `${labelize(visualizationGroupField)} distribution` : kind === 'Risk distribution' ? 'Students by risk level' : kind === 'Pass rate comparison' ? `Passing rate by ${labelize(groupBy)}` : kind === 'Bar chart' ? `Average ${labelize(value || 'records')} by ${labelize(groupBy)}` : kind === 'Score spread by group' ? `Score range by ${labelize(groupBy)}` : kind === 'Assessment score range' ? 'Assessment scores over time' : kind === 'Current standing by period' ? 'Current standing by grading period' : kind === 'Score distribution' ? `${labelize(value)} distribution` : kind === 'Attendance watchlist' ? 'Lowest attendance' : kind === 'Missed assessment watchlist' ? 'Most missed assessments' : kind;
  const visualizationDescription = (kind: Visualization) => {
    if (kind === 'Donut chart') return `Each segment shows the share of included records in a ${labelize(visualizationGroupField).toLowerCase()} category. The legend reports count and percentage.`;
    if (kind === 'Risk distribution') return 'Counts and percentages of students in each applied risk level, based on the selected report scope.';
    if (kind === 'Pass rate comparison') return `Share of recorded students meeting the applied passing rule in each ${labelize(groupBy).toLowerCase()} group. Groups with no recorded status are excluded.`;
    if (kind === 'Score spread by group') return `Each range shows the middle half of recorded ${labelize(currentStandingField ?? 'standing').toLowerCase()} values, with whiskers for the minimum and maximum. The center mark is the median.`;
    if (kind === 'Bar chart') return `Top ${Math.min(8, selectedGroups.length)} ${labelize(groupBy).toLowerCase()} groups are ranked by ${effectiveAggregation} ${labelize(value || 'record count')}.`;
    if (kind === 'Assessment score range') return `Scores are mapped through each assessment's applied grading rule. The line shows average mapped percentage over time; whiskers show the lowest and highest recorded percentages. Series are grouped by ${assessmentBreakdown.toLowerCase()}.`;
    if (kind === 'Current standing by period') return 'Each point is the average calculated period result for included students, using the applied grading system. Whiskers show the lowest and highest recorded period results; students without that period result are excluded.';
    if (kind === 'Score distribution') return currentStandingField === value ? `Current standing is calculated using the class grading rules and mapped to percentages before placing students in these bands.` : `Scores use equal-width bands based on the observed range of ${labelize(value)}; records without a numeric value are excluded.`;
    if (kind === 'Trend line') return `${labelize(value)} is averaged by ${labelize(dateField || 'date')} to show change over time. This is descriptive, not a forecast.`;
    if (kind === 'Attendance watchlist') return 'Students with the lowest recorded attendance are shown first. Missing attendance records are excluded.';
    if (kind === 'Missed assessment watchlist') return 'Students with the most missing assessment results are shown first; this counts missing results, not excused absences.';
    return 'A quick view of included records and available academic indicators.';
  };
  const drilledRows = useMemo(() => groupBy && drilldownValue ? drilldownRows(rows, groupBy, drilldownValue) : rows, [drilldownValue, groupBy, rows]);
  const thresholdNumber = Number(standingThreshold);
  const thresholdActive = compareSelected && Boolean(groupBy && /class|section|category/i.test(groupBy)) && (thresholdMode === 'below' || thresholdMode === 'above') && standingThreshold.trim() !== '' && Number.isFinite(thresholdNumber);
  const qualifyingGroupKeys = useMemo(() => {
    if (!thresholdActive || !groupBy || !currentStandingField) return null;
    return new Set([...groupRows(drilledRows, groupBy)].filter(([, items]) => {
      const scores = items.map((row) => row[currentStandingField]).filter((item): item is number => typeof item === 'number' && Number.isFinite(item));
      if (!scores.length) return false;
      const average = scores.reduce((sum, score) => sum + score, 0) / scores.length;
      return thresholdMode === 'below' ? average < thresholdNumber : average >= thresholdNumber;
    }).map(([key]) => key));
  }, [currentStandingField, drilledRows, groupBy, thresholdActive, thresholdMode, thresholdNumber]);
  const reportRows = useMemo(() => qualifyingGroupKeys ? drilledRows.filter((row) => qualifyingGroupKeys.has(String(row[groupBy ?? ''] ?? 'Unspecified'))) : drilledRows, [drilledRows, groupBy, qualifyingGroupKeys]);
  const groups = useMemo(() => groupBy ? [...groupRows(rows, groupBy)] : [], [groupBy, rows]);
  const selectedGroups = useMemo(() => {
    if (!groupBy) return [];
    const grouped = [...groupRows(reportRows, groupBy)];
    const summaries = grouped.map(([key, items]) => ({ key, amount: value ? aggregateRows(items, 'average', value) : items.length, count: items.length }));
    const sorted = groupSort === 'name'
      ? summaries.sort((left, right) => left.key.localeCompare(right.key, undefined, { numeric: true }))
      : sortRows(summaries, groupSort === 'most students' ? 'count' : 'amount', groupSort === 'lowest average' ? 'ascending' : 'descending');
    return sorted.map(({ key }) => [key, grouped.find(([candidate]) => candidate === key)?.[1] ?? []] as [string, ReportRecord[]]);
  }, [groupBy, groupSort, reportRows, value]);
  const pivot = useMemo(() => showAdvancedBreakdown && groupBy && pivotBy ? pivotRows(reportRows, groupBy, pivotBy, effectiveAggregation, value, { maxRows: 12, maxColumns: 12 }) : [], [effectiveAggregation, groupBy, pivotBy, reportRows, showAdvancedBreakdown, value]);
  const numericValues = useMemo(() => reportRows.map((row) => row[value]).filter((item): item is number => typeof item === 'number' && Number.isFinite(item)), [reportRows, value]);
  const assessmentSeries = useMemo(() => assessmentScoreSeries(reportRows, assessmentBreakdown), [assessmentBreakdown, reportRows]);
  const standingSeries = useMemo(() => standingPeriodSeries(reportRows, fields), [fields, reportRows]);
  const criticalField = riskGroupField ?? fields.find((field) => /risk|classification|status|severity/i.test(field));
  const criticalRows = useMemo(() => criticalField ? reportRows.filter((row) => criticalWords.test(String(row[criticalField] ?? ''))) : [], [criticalField, reportRows]);
  const completeness = useMemo(() => reportRows.length && fields.length ? Math.round(reportRows.reduce((count, row) => count + fields.filter((field) => row[field] !== null && row[field] !== undefined && row[field] !== '').length, 0) * 100 / (reportRows.length * fields.length)) : 0, [fields, reportRows]);
  const insightItems = useMemo(() => {
    if (!autoInsights || !reportRows.length) return [];
    const actionableInsights = semanticInsights(reportRows, fields);
    const result = [...actionableInsights, `${reportRows.length.toLocaleString()} ${activeScopeLabel.toLowerCase()} records are in this report.`];
    if (numericValues.length) {
      const avg = aggregateRows(reportRows, 'average', value); const mid = median(numericValues);
      result.push(`${labelize(value)} averages ${avg.toFixed(1)}; the median is ${mid.toFixed(1)} across ${numericValues.length.toLocaleString()} numeric values.`);
      const range = Math.max(...numericValues) - Math.min(...numericValues);
      if (range > 0) result.push(`${labelize(value)} ranges from ${Math.min(...numericValues).toFixed(1)} to ${Math.max(...numericValues).toFixed(1)} (spread ${range.toFixed(1)}).`);
    }
    if (selectedGroups.length) {
      const bySize = [...selectedGroups].sort((a, b) => b[1].length - a[1].length);
      if (bySize.length > 1) result.push(`Largest ${labelize(groupBy).toLowerCase()} group — ${bySize[0][0]} has ${bySize[0][1].length.toLocaleString()} records (${Math.round(bySize[0][1].length * 100 / reportRows.length)}% of this report).`);
      if (value && /standing|grade|score|mark|percent|attendance/i.test(value) && selectedGroups.length > 1) {
        const ranked = selectedGroups.map(([key, items]) => ({ key, amount: aggregateRows(items, 'average', value), count: items.filter((row) => typeof row[value] === 'number' && Number.isFinite(row[value])).length })).filter((row) => row.count).sort((a, b) => b.amount - a.amount);
        if (ranked.length > 1) result.push(`Highest average ${labelize(value).toLowerCase()} — ${ranked[0].key}: ${ranked[0].amount.toFixed(1)} (${ranked[0].count} recorded values).`);
        if (ranked.length > 1) result.push(`Lowest average ${labelize(value).toLowerCase()} — ${ranked[ranked.length - 1].key}: ${ranked[ranked.length - 1].amount.toFixed(1)} (${ranked[ranked.length - 1].count} recorded values).`);
      }
    }
    if (criticalField) result.push(`${criticalRows.length.toLocaleString()} records (${reportRows.length ? Math.round(criticalRows.length * 100 / reportRows.length) : 0}%) match the configured ${labelize(criticalField).toLowerCase()} concern indicators.`);
    if (completeness < 80) result.push(`Data coverage note — ${completeness}% of available report fields are populated; interpret comparisons with that limitation in mind.`);
    if (dateField) {
      const dated = reportRows.map((row) => ({ date: new Date(String(row[dateField] ?? '')).getTime(), score: typeof row[value] === 'number' ? row[value] : null })).filter((row): row is { date: number; score: number | null } => Number.isFinite(row.date)).sort((a, b) => a.date - b.date);
      if (dated.length > 1) result.push(`Coverage spans ${new Date(dated[0].date).toLocaleDateString()} to ${new Date(dated[dated.length - 1].date).toLocaleDateString()}.`);
      if (dated.length > 1 && dated[0].score !== null && dated[dated.length - 1].score !== null) {
        const change = dated[dated.length - 1].score! - dated[0].score!;
        result.push(`${labelize(value)} ${change >= 0 ? 'increased' : 'decreased'} by ${Math.abs(change).toFixed(1)} from the earliest to latest record.`);
      }
    }
    if (pivot.length) result.push(`The ${labelize(groupBy).toLowerCase()} comparison spans ${pivot.length} groups and ${new Set(reportRows.map((row) => String(row[pivotBy] ?? 'Unspecified'))).size} ${labelize(pivotBy).toLowerCase()} categories.`);
    const prioritized = result;
    return concise ? prioritized.slice(0, Math.max(3, actionableInsights.length)) : prioritized;
  }, [effectiveAggregation, activeScopeLabel, autoInsights, completeness, concise, criticalField, criticalRows.length, dateField, fields, groupBy, pivot.length, pivotBy, reportRows, selectedGroups, template, value, numericValues]);
  const chartData = useMemo(() => {
    const result: Partial<Record<Visualization, ChartItem[]>> = {};
    if (activeVisualizations.includes('Assessment score range')) result['Assessment score range'] = assessmentSeries;
    if (activeVisualizations.includes('Current standing by period')) result['Current standing by period'] = standingSeries;
    if (activeVisualizations.includes('Risk distribution') && riskGroupField) {
      result['Risk distribution'] = [...groupRows(reportRows, riskGroupField)].map(([label, items]) => ({ label, count: items.length, amount: items.length })).sort((a, b) => b.count - a.count);
    }
    if (activeVisualizations.includes('Pass rate comparison') && groupBy) {
      const statusField = fields.find((field) => /^(classification|remarks|passstatus)$/i.test(field));
      if (statusField) result['Pass rate comparison'] = selectedGroups.map(([label, items]) => {
        const scored = items.filter((row) => row[statusField] != null);
        const passing = scored.filter((row) => /pass|met/i.test(String(row[statusField])) && !/fail|not met/i.test(String(row[statusField]))).length;
        return { label, count: scored.length, amount: scored.length ? passing * 100 / scored.length : 0 };
      }).sort((a, b) => b.amount - a.amount).slice(0, 12);
    }
    if (activeVisualizations.includes('Score spread by group') && currentStandingField) {
      result['Score spread by group'] = selectedGroups.flatMap(([label, items]) => {
        const scores = items.map((row) => row[currentStandingField]).filter((score): score is number => typeof score === 'number' && Number.isFinite(score)).sort((a, b) => a - b);
        return scores.length ? [{ label, count: scores.length, amount: quantile(scores, 0.5), minimum: scores[0], lowerQuartile: quantile(scores, 0.25), median: quantile(scores, 0.5), upperQuartile: quantile(scores, 0.75), maximum: scores[scores.length - 1] }] : [];
      }).slice(0, 8);
    }
    if (activeVisualizations.includes('Score distribution') && numericValues.length) {
      const gradeBands = currentStandingField === value && numericValues.every((score) => score >= 0 && score <= 100)
        ? [{ label: '0–59', min: -Infinity, max: 60 }, { label: '60–69', min: 60, max: 70 }, { label: '70–79', min: 70, max: 80 }, { label: '80–89', min: 80, max: 90 }, { label: '90–100', min: 90, max: Infinity }]
        : null;
      const { minimum, maximum } = numericValues.reduce((bounds, score) => ({ minimum: Math.min(bounds.minimum, score), maximum: Math.max(bounds.maximum, score) }), { minimum: Infinity, maximum: -Infinity });
      const width = (maximum - minimum) / 5 || 1;
      const bands = gradeBands ?? Array.from({ length: 5 }, (_, index) => ({ label: `${(minimum + width * index).toFixed(1)}–${(index === 4 ? maximum : minimum + width * (index + 1)).toFixed(1)}`, min: minimum + width * index, max: index === 4 ? Infinity : minimum + width * (index + 1) }));
      result['Score distribution'] = bands.map((band) => { const count = numericValues.filter((score) => score >= band.min && score < band.max).length; return { label: band.label, count, amount: count }; });
    }
    const watchlistLabel = (row: ReportRecord) => `${String(row[studentNameField ?? 'label'] ?? 'Unknown student')}${classLabelField ? ` · ${String(row[classLabelField] ?? 'Unassigned class')}` : ''}`;
    if (activeVisualizations.includes('Attendance watchlist') && attendanceField && studentNameField) {
      result['Attendance watchlist'] = reportRows.filter((row) => typeof row[attendanceField] === 'number' && Number.isFinite(row[attendanceField])).map((row) => ({ label: watchlistLabel(row), count: 1, amount: Number(row[attendanceField]) })).sort((a, b) => a.amount - b.amount).slice(0, 8);
    }
    if (activeVisualizations.includes('Missed assessment watchlist') && missedField && studentNameField) {
      result['Missed assessment watchlist'] = reportRows.filter((row) => typeof row[missedField] === 'number' && Number.isFinite(row[missedField]) && row[missedField] > 0).map((row) => ({ label: watchlistLabel(row), count: 1, amount: Number(row[missedField]) })).sort((a, b) => b.amount - a.amount).slice(0, 8);
    }
    if (activeVisualizations.includes('Trend line') && dateField) {
        const trend = new Map<string, number[]>();
        for (const row of reportRows) { const timestamp = new Date(String(row[dateField] ?? '')).getTime(); if (!Number.isFinite(timestamp)) continue; const date = new Date(timestamp); const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`; const values = trend.get(monthKey) ?? []; if (typeof row[value] === 'number') values.push(row[value]); trend.set(monthKey, values); }
        result['Trend line'] = [...trend].sort(([left], [right]) => left.localeCompare(right)).map(([key, values]) => ({ label: new Date(`${key}-01T00:00:00`).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }), count: values.length, amount: values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0 })).slice(-12);
    }
    const grouped = selectedGroups.map(([label, items]) => ({ label, count: items.length, amount: value ? aggregateRows(items, effectiveAggregation, value) : items.length })).sort((a, b) => b.amount - a.amount).slice(0, 8);
    if (activeVisualizations.includes('Bar chart')) result['Bar chart'] = grouped;
    if (activeVisualizations.includes('Donut chart')) {
      const categories = selectedGroups.map(([label, items]) => ({ label, count: items.length, amount: items.length })).sort((a, b) => b.count - a.count);
      result['Donut chart'] = categories.length <= 8 ? categories : [...categories.slice(0, 7), { label: 'Other groups', count: categories.slice(7).reduce((sum, item) => sum + item.count, 0), amount: categories.slice(7).reduce((sum, item) => sum + item.amount, 0) }];
    }
    return result;
  }, [activeVisualizations, assessmentSeries, attendanceField, classLabelField, currentStandingField, dateField, effectiveAggregation, fields, groupBy, missedField, riskGroupField, selectedGroups, numericValues, reportRows, standingSeries, studentNameField, value]);
  const rawTable = template === 'Data table';
  const summaryTable = (includeSummaryTable || compareSelected) && !rawTable && selectedGroups.length > 0
    ? [['Group', 'Records', `${labelize(effectiveAggregation)} ${labelize(value)}`], ...selectedGroups.map(([key, items]) => [key, String(items.length), `${aggregateRows(items, effectiveAggregation, value).toFixed(1)}${/rate|percent|percentage|standing|grade|score/i.test(value) ? '%' : ''}`])]
    : [];
  const tableData = rawTable ? [fields.map(labelize), ...reportRows.map((row) => fields.map((field) => { const value = row[field]; if (value == null) return '—'; if (/^(student.?id|institutional.?id)$/i.test(field) && typeof value === 'string') return formatStudentId(value); return typeof value === 'object' ? JSON.stringify(value) : String(value); }))] : summaryTable;
  const accessedDataText = useMemo(() => showSourceData ? JSON.stringify({
    report: { title: title || initialTitle, scope: activeScopeLabel, template, layout, generatedAt: new Date().toISOString() },
    analysis: { questions: activeQuestions, includedRecordCount: reportRows.length, groupBy, filters: activeFilters.map(({ field, value }) => ({ field, equals: value })), standingThreshold: thresholdActive ? { mode: thresholdMode, percent: thresholdNumber } : null, drilldownValue: drilldownValue || null, pivotBy: pivotBy || null, metric: value || null, aggregation: effectiveAggregation, visualizations: activeVisualizations },
    sourceFields: fields,
    appliedSchemas: uniqueAppliedSchemas(rows),
    sourceRecords: compactReportRecords(rows),
    recordsIncludedAfterDrilldown: compactReportRecords(reportRows),
    insights: insightItems,
    groupedSummaries: selectedGroups.map(([group, items]) => ({ group, records: items.length, aggregate: aggregateRows(items, effectiveAggregation, value) })),
    pivotResults: pivot,
    visualizationData: chartData,
  }, null, 2) : '', [activeQuestionKey, activeScopeLabel, activeVisualizations, activeFilters, chartData, drilldownValue, effectiveAggregation, fields, groupBy, initialTitle, insightItems, layout, pivot, pivotBy, reportRows, rows, scopeLabel, selectedGroups, showSourceData, template, thresholdActive, thresholdMode, thresholdNumber, title, value]);

  const exportReport = async (format: 'docx' | 'pdf', previewOnly = false, version?: number) => {
    if (!previewOnly) setBusy(true);
    setError('');
    try {
      const analysisContext = [
        `Analysis: ${activeQuestions.map(labelize).join(', ')}.`,
        ...activeFilters.map(({ field, value: filterValue }) => `Filter: ${labelize(field)} is ${filterValue}.`),
        ...(thresholdActive ? [`Class average current standing is ${thresholdMode === 'below' ? 'below' : 'at or above'} ${thresholdNumber}%.`] : []),
        ...(drilldownValue ? [`Drilldown: ${labelize(groupBy)} is ${drilldownValue}.`] : []),
        ...(!reportRows.length ? ['No records matched these report settings. Adjust the filter or threshold and regenerate the report.'] : []),
      ];
      const narrative = [...analysisContext, ...(includeInterpretations ? [description] : []), ...insightItems];
      const schemaByLabel = new Map<string, { label: string; schema: unknown }>();
      for (const row of reportRows) {
        const className = String(row.class ?? row.category ?? 'Class');
        if (row.gradingSystemSchema) schemaByLabel.set(`${className} · Applied grading system`, { label: `${className} · Applied grading system`, schema: row.gradingSystemSchema });
        if (row.appliedGradingSystem) schemaByLabel.set(`${className} · Class grading configuration`, { label: `${className} · Class grading configuration`, schema: row.appliedGradingSystem });
        if (row.evaluationCriteriaSchema) schemaByLabel.set(`${className} · Evaluation criteria`, { label: `${className} · Evaluation criteria`, schema: row.evaluationCriteriaSchema });
      }
      const appliedSchemas = [...schemaByLabel.values()];
      const assessmentOutcomes = new Map<string, { className: string; name: string; scores: number[]; mapped: number[]; records: number }>();
      for (const row of reportRows) {
        const className = String(row.class ?? row.category ?? 'Class');
        const assessments = Array.isArray(row.assessmentResults) ? row.assessmentResults : [];
        for (const entry of assessments) {
          if (!entry || typeof entry !== 'object') continue;
          const assessment = entry as Record<string, unknown>;
          const key = `${className}:${String(assessment.id ?? assessment.name ?? '')}`;
          const outcome = assessmentOutcomes.get(key) ?? { className, name: String(assessment.name ?? assessment.id ?? 'Assessment'), scores: [], mapped: [], records: 0 };
          if (assessment.rawScore !== null && assessment.rawScore !== undefined) {
            outcome.records += 1;
            const raw = Number(assessment.rawScore);
            if (Number.isFinite(raw)) outcome.scores.push(raw);
          }
          const mapped = Number(assessment.mappedPercentage);
          if (assessment.mappedPercentage != null && Number.isFinite(mapped)) outcome.mapped.push(mapped);
          assessmentOutcomes.set(key, outcome);
        }
      }
      const assessmentOutcomeRows = [...assessmentOutcomes.values()];
      const assessmentRowsForOutput = concise
        ? [...assessmentOutcomeRows].sort((left, right) => {
          const leftMean = left.mapped.length ? left.mapped.reduce((sum, item) => sum + item, 0) / left.mapped.length : Infinity;
          const rightMean = right.mapped.length ? right.mapped.reduce((sum, item) => sum + item, 0) / right.mapped.length : Infinity;
          return leftMean - rightMean;
        }).slice(0, 8)
        : assessmentOutcomeRows;
      const schemaSummaryByClass = new Map<string, { grading: string[]; criteria: string[] }>();
      const describeSchema = (schema: unknown) => {
        const definition = schema && typeof schema === 'object' ? schema as Record<string, unknown> : {};
        const name = typeof definition.name === 'string' ? definition.name : 'Applied definition';
        const version = definition.version ?? definition.definitionVersion ?? definition.schemaVersion;
        return `${name}${version == null ? '' : ` (v${String(version)})`}`;
      };
      for (const { label, schema } of appliedSchemas) {
        const match = label.match(/^(.*) · (Applied grading system|Class grading configuration|Evaluation criteria)$/);
        if (!match) continue;
        const [, className, schemaType] = match;
        const summary = schemaSummaryByClass.get(className) ?? { grading: [], criteria: [] };
        const description = describeSchema(schema);
        if (schemaType === 'Evaluation criteria') summary.criteria.push(description);
        else summary.grading.push(`${schemaType === 'Class grading configuration' ? 'Class configuration: ' : ''}${description}`);
        schemaSummaryByClass.set(className, summary);
      }
      const schemaSummaryRows = [...schemaSummaryByClass].map(([className, summary]) => {
        const uniqueGrading = [...new Set(summary.grading)];
        return [className, uniqueGrading.length ? uniqueGrading.join('; ') : '—', summary.criteria.length ? [...new Set(summary.criteria)].join('; ') : '—'];
      });
      const gradingFieldLabels = new Map<string, string>();
      const collectGradingLabels = (definition: unknown) => {
        if (!definition || typeof definition !== 'object') return;
        if (Array.isArray(definition)) { definition.forEach(collectGradingLabels); return; }
        const entry = definition as Record<string, unknown>;
        if (typeof entry.id === 'string') {
          const name = entry.name ?? entry.label ?? entry.title;
          if (typeof name === 'string' && name.trim()) gradingFieldLabels.set(entry.id, name.trim());
        }
        Object.values(entry).forEach(collectGradingLabels);
      };
      for (const row of reportRows) { collectGradingLabels(row.gradingSystemSchema); collectGradingLabels(row.appliedGradingSystem); }
      const calculatedFieldRows = [...new Set(reportRows.flatMap((row) => Object.keys(row).filter((field) => /^(gradingPeriod|gradingComponent|gradingGroup)_/.test(field))))].flatMap((field) => {
        const suffix = field.replace(/^grading(?:Period|Component|Group)_/, '');
        const mappedLabel = gradingFieldLabels.get(suffix);
        const looksLikeId = /^[0-9a-f]{8}[-\s][0-9a-f]{4}[-\s][0-9a-f]{4}[-\s][0-9a-f]{4}[-\s][0-9a-f]{12}$/i.test(suffix);
        const values = reportRows.map((row) => row[field]).filter((item): item is number => typeof item === 'number' && Number.isFinite(item));
        if (!values.length || (looksLikeId && !mappedLabel)) return [];
        return [{ field: mappedLabel ?? labelize(suffix), type: field.startsWith('gradingPeriod_') ? 'Period' : field.startsWith('gradingComponent_') ? 'Component' : 'Group', count: values.length, mean: values.reduce((sum, item) => sum + item, 0) / values.length }];
      });
      const priorityCalculatedFields = calculatedFieldRows.filter((row) => row.type === 'Period' || /semester grade|final grade|mastery|effortful learning|point grade/i.test(row.field));
      const calculatedFieldsForOutput = concise
        ? (priorityCalculatedFields.length ? priorityCalculatedFields : calculatedFieldRows).slice(0, 10)
        : calculatedFieldRows;
      const standingValues = currentStandingField ? reportRows.map((row) => row[currentStandingField]).filter((item): item is number => typeof item === 'number' && Number.isFinite(item)) : [];
      const attendanceValues = attendanceField ? reportRows.map((row) => row[attendanceField]).filter((item): item is number => typeof item === 'number' && Number.isFinite(item)) : [];
      if (format === 'docx') {
        const { AlignmentType, Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } = await import('docx');
        const makeDocxTable = (matrix: string[][]) => new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: matrix.map((row, rowIndex) => new TableRow({
            tableHeader: rowIndex === 0,
            children: row.map((cell) => new TableCell({
              shading: rowIndex === 0 ? { fill: accentColors[accent] } : undefined,
              margins: { top: 70, bottom: 70, left: 100, right: 100 },
              verticalAlign: 'center',
              children: [new Paragraph({ children: [new TextRun({ text: cell, bold: rowIndex === 0, color: rowIndex === 0 ? 'FFFFFF' : undefined })] })],
            })),
          })),
        });
        const docxVisualizations: (Paragraph | Table)[] = activeVisualizations.flatMap((kind) => {
          const items = chartData[kind] ?? [];
          const heading = new Paragraph({ text: visualizationTitle(kind), heading: HeadingLevel.HEADING_1 });
          const explanation = includeInterpretations ? [new Paragraph({ text: visualizationDescription(kind) })] : [];
          if (kind === 'KPI summary') return [heading, ...explanation, new Paragraph({ text: `Students / records ${reportRows.length} · Average current standing ${standingValues.length ? `${(standingValues.reduce((sum, item) => sum + item, 0) / standingValues.length).toFixed(1)}%` : '—'} · Flagged for follow-up ${criticalRows.length} · Average attendance ${attendanceValues.length ? `${(attendanceValues.reduce((sum, item) => sum + item, 0) / attendanceValues.length).toFixed(1)}%` : '—'}` })];
          if (!items.length) {
            const message = kind === 'Missed assessment watchlist' ? 'No students with missing assessment results were found in this scope.' : kind === 'Attendance watchlist' ? 'No attendance values are available in this scope.' : 'No records are available for this visualization in the selected scope.';
            return [heading, ...explanation, new Paragraph({ text: message })];
          }
          const maximum = Math.max(1, ...items.map((item) => item.amount));
          const rowsForTable = kind === 'Assessment score range'
            ? [['Date', 'Series', 'Lowest mapped %', 'Average mapped %', 'Highest mapped %', 'Scored students'], ...items.map((item) => [item.label, item.series ?? 'Overall', `${(item.minimum ?? item.amount).toFixed(1)}%`, `${item.amount.toFixed(1)}%`, `${(item.maximum ?? item.amount).toFixed(1)}%`, String(item.count)])]
            : kind === 'Current standing by period'
              ? [['Grading period', 'Lowest standing %', 'Average standing %', 'Highest standing %', 'Students with results'], ...items.map((item) => [item.label, `${(item.minimum ?? item.amount).toFixed(1)}%`, `${item.amount.toFixed(1)}%`, `${(item.maximum ?? item.amount).toFixed(1)}%`, String(item.count)])]
            : kind === 'Score spread by group'
              ? [['Group', 'Students', 'Minimum', '25th percentile', 'Median', '75th percentile', 'Maximum'], ...items.map((item) => [item.label, String(item.count), item.minimum?.toFixed(1) ?? '—', item.lowerQuartile?.toFixed(1) ?? '—', item.median?.toFixed(1) ?? '—', item.upperQuartile?.toFixed(1) ?? '—', item.maximum?.toFixed(1) ?? '—'])]
            : [
            ['Category', 'Relative value', 'Count / value'],
            ...items.map((item) => {
              const bar = '█'.repeat(Math.max(1, Math.round(item.amount / maximum * 18)));
              const valueLabel = kind === 'Donut chart' || kind === 'Risk distribution' ? `${item.count} (${reportRows.length ? Math.round(item.count * 100 / reportRows.length) : 0}%)` : kind === 'Pass rate comparison' ? `${item.amount.toFixed(1)}% (${item.count} classified)` : kind === 'Attendance watchlist' ? `${item.amount.toFixed(1)}%` : kind === 'Missed assessment watchlist' ? `${item.amount} missing` : kind === 'Score distribution' ? `${item.count} students` : item.amount.toFixed(1);
              return [item.label, bar, valueLabel];
            }),
          ];
          return [heading, ...explanation, makeDocxTable(rowsForTable)];
        });
        const children: (Paragraph | Table)[] = [
          new Paragraph({ children: [new TextRun({ text: title || initialTitle, bold: true, size: 36, color: accentColors[accent] })], heading: HeadingLevel.TITLE, alignment: AlignmentType.LEFT }),
          new Paragraph({ text: `${activeScopeLabel} · ${new Date().toLocaleDateString()} · ${template}`, style: 'Subtitle' }),
          ...(narrative.length ? [new Paragraph({ text: template === 'Detailed analysis' ? 'Analysis and findings' : 'Overview', heading: HeadingLevel.HEADING_1 }), ...narrative.map((line) => new Paragraph({ text: line, bullet: { level: 0 } }))] : []),
          ...docxVisualizations,
          ...(includeGradingContext && schemaSummaryRows.length ? [new Paragraph({ text: 'Applied grading context', heading: HeadingLevel.HEADING_1 }), makeDocxTable([['Class context', 'Grading system / configuration', 'Evaluation criteria'], ...schemaSummaryRows])] : []),
          ...(includeGradingContext && includeFullSchemaDefinitions && appliedSchemas.length ? [new Paragraph({ text: 'Full grading schema definitions', heading: HeadingLevel.HEADING_1 }), ...appliedSchemas.flatMap(({ label, schema }) => [new Paragraph({ text: label, heading: HeadingLevel.HEADING_2 }), new Paragraph({ text: JSON.stringify(schema, null, 2) })])] : []),
          ...(includeGradingContext && assessmentRowsForOutput.length ? [new Paragraph({ text: 'Assessment results by instance', heading: HeadingLevel.HEADING_1 }), ...(concise && assessmentOutcomeRows.length > assessmentRowsForOutput.length ? [new Paragraph({ text: `Showing ${assessmentRowsForOutput.length} assessment instances with the lowest mapped averages, from ${assessmentOutcomeRows.length} total.` })] : []), makeDocxTable([['Class', 'Assessment', 'Scored records', 'Mean raw score', 'Mean mapped %'], ...assessmentRowsForOutput.map((row) => [row.className, row.name, String(row.records), row.scores.length ? (row.scores.reduce((a, b) => a + b, 0) / row.scores.length).toFixed(1) : '—', row.mapped.length ? `${(row.mapped.reduce((a, b) => a + b, 0) / row.mapped.length).toFixed(1)}%` : '—'])])] : []),
          ...(includeGradingContext && calculatedFieldsForOutput.length ? [new Paragraph({ text: 'Calculated grading fields', heading: HeadingLevel.HEADING_1 }), ...(concise && calculatedFieldRows.length > calculatedFieldsForOutput.length ? [new Paragraph({ text: `Showing key period and semester fields (${calculatedFieldsForOutput.length} of ${calculatedFieldRows.length}); turn off concise mode for all calculated fields.` })] : []), makeDocxTable([['Field', 'Level', 'Records', 'Mean'], ...calculatedFieldsForOutput.map((row) => [row.field, row.type, String(row.count), row.mean == null ? '—' : row.mean.toFixed(1)])])] : []),
          ...(pivot.length ? [new Paragraph({ text: `${labelize(groupBy)} × ${labelize(pivotBy)} pivot`, heading: HeadingLevel.HEADING_1 }), new Paragraph({ text: pivot.map((row) => `${row.label}: ${Object.entries(row.values).map(([key, amount]) => `${key} ${Number(amount).toFixed(1)}`).join(', ')}`).join('\n') })] : []),
          ...(tableData.length ? [new Paragraph({ text: rawTable ? 'Full data table' : 'Summary table', heading: HeadingLevel.HEADING_1 }), makeDocxTable(tableData)] : []),
        ];
        const blob = await Packer.toBlob(new Document({ sections: [{ properties: { page: { size: layout === 'Landscape' ? { orientation: 'landscape' } : undefined } }, children }] }));
        await download(blob, `${filename(title)}.docx`);
      } else {
        const [{ jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf/dist/jspdf.es.min.js'), import('jspdf-autotable')]);
        const pdf = new jsPDF({ orientation: layout.toLowerCase() as 'portrait' | 'landscape' }); const pageWidth = pdf.internal.pageSize.getWidth(); const pageHeight = pdf.internal.pageSize.getHeight();
        const hex = accentColors[accent]; pdf.setTextColor(parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)); pdf.setFontSize(20);
        const titleLines = pdf.splitTextToSize(title || initialTitle, pageWidth - 28); pdf.text(titleLines, 14, 20); pdf.setTextColor(30, 41, 59);
        pdf.setFontSize(9); const metadata = pdf.splitTextToSize(`${activeScopeLabel} · ${new Date().toLocaleDateString()} · ${template}`, pageWidth - 28); const metadataY = 22 + titleLines.length * 8; pdf.text(metadata, 14, metadataY);
        let y = metadataY + metadata.length * 4 + 2;
        const ensureSpace = (height: number) => { if (y + height > pageHeight - 14) { pdf.addPage(); y = 18; } };
        const narrative = includeInterpretations ? [description, ...insightItems] : insightItems;
        for (const line of narrative) { const wrapped = pdf.splitTextToSize(line, pageWidth - 28); const linesPerPage = Math.max(1, Math.floor((pageHeight - 36) / 5)); for (let start = 0; start < wrapped.length; start += linesPerPage) { const chunk = wrapped.slice(start, start + linesPerPage); const blockHeight = chunk.length * 5 + 2; ensureSpace(blockHeight); pdf.text(chunk, 14, y); y += blockHeight; } }
        if (pivot.length) { ensureSpace(14); pdf.setFontSize(12); pdf.text(`${labelize(groupBy)} × ${labelize(pivotBy)} pivot`, 14, y); y += 8; pdf.setFontSize(8); for (const row of pivot) { ensureSpace(6); pdf.text(`${row.label}: ${Object.entries(row.values).map(([key, amount]) => `${key} ${Number(amount).toFixed(1)}`).join(' | ')}`.slice(0, 180), 14, y); y += 5; } }
        for (const visualization of activeVisualizations) {
          const chartGroups = chartData[visualization] ?? [];
          const maxChartValue = Math.max(1, ...chartGroups.map((item) => item.amount));
          const explanationLines = includeInterpretations ? pdf.splitTextToSize(visualizationDescription(visualization), pageWidth - 28).length : 0;
          const visualHeight = (chartGroups.length === 0 ? 20 : visualization === 'Donut chart' || visualization === 'Risk distribution' ? 96 + chartGroups.length * 7 : visualization === 'KPI summary' ? 42 : visualization === 'Assessment score range' ? 111 + new Set(chartGroups.map((item) => item.series ?? 'Overall')).size * 4 : visualization === 'Current standing by period' || visualization === 'Score distribution' ? 88 : visualization === 'Score spread by group' ? 34 + chartGroups.length * 14 : 18 + chartGroups.length * 14) + explanationLines * 4 + 12;
          const minimumSpace = visualHeight;
          ensureSpace(minimumSpace); y += 4; pdf.setFontSize(14); pdf.text(visualizationTitle(visualization), 14, y); y += 7;
          if (includeInterpretations) { pdf.setFontSize(8); pdf.setTextColor(71, 85, 105); const explanation = pdf.splitTextToSize(visualizationDescription(visualization), pageWidth - 28); pdf.text(explanation, 14, y); y += explanation.length * 4 + 2; pdf.setTextColor(30, 41, 59); }
          if (!chartGroups.length && visualization !== 'KPI summary') {
            const message = visualization === 'Missed assessment watchlist' ? 'No students with missing assessment results were found in this scope.' : visualization === 'Attendance watchlist' ? 'No attendance values are available in this scope.' : 'No records are available for this visualization in the selected scope.';
            pdf.setFontSize(9); pdf.setTextColor(71, 85, 105); pdf.text(pdf.splitTextToSize(message, pageWidth - 28), 14, y); y += 10; pdf.setTextColor(30, 41, 59); continue;
          }
          const rgb = [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
          if (visualization === 'Donut chart' || visualization === 'Risk distribution') {
            const palette: [number, number, number][] = [rgb as [number, number, number], [46, 134, 171], [83, 167, 123], [230, 162, 60], [139, 115, 181], [214, 107, 107], [100, 116, 139], [194, 135, 86]];
            const donutGroups = chartGroups.map((item) => ({ ...item, count: Number.isFinite(Number(item.count)) ? Math.max(0, Number(item.count)) : 0 }));
            const total = donutGroups.reduce((sum, item) => sum + item.count, 0);
            const cx = pageWidth / 2; const cy = y + 38; const radius = 31; let start = -Math.PI / 2;
            if (total > 0) donutGroups.forEach((item, index) => {
              if (item.count <= 0) return;
              const end = start + 2 * Math.PI * item.count / total; pdf.setFillColor(...palette[index % palette.length]);
              const steps = Math.max(2, Math.ceil((end - start) / (Math.PI / 36)));
              let previousAngle = start;
              for (let step = 1; step <= steps; step++) {
                const angle = start + (end - start) * step / steps;
                const x1 = cx + radius * Math.cos(previousAngle); const y1 = cy + radius * Math.sin(previousAngle);
                const x2 = cx + radius * Math.cos(angle); const y2 = cy + radius * Math.sin(angle);
                if ([cx, cy, x1, y1, x2, y2].every(Number.isFinite)) pdf.triangle(cx, cy, x1, y1, x2, y2, 'F');
                previousAngle = angle;
              }
              start = end;
            });
            pdf.setFillColor(255, 255, 255); pdf.circle(cx, cy, 18, 'F'); pdf.setTextColor(71, 85, 105); pdf.setFontSize(8); pdf.text(`${total} records`, cx, cy + 1, { align: 'center' });
            y = cy + radius + 10; pdf.setFontSize(9);
            donutGroups.forEach((item, index) => { pdf.setFillColor(...palette[index % palette.length]); pdf.rect(14, y - 3, 3, 3, 'F'); pdf.setTextColor(30, 41, 59); pdf.text(`${item.label}: ${total ? Math.round(item.count * 100 / total) : 0}% (${item.count})`, 20, y); y += 7; });
          } else if (visualization === 'KPI summary') {
            const standingValues = currentStandingField ? reportRows.map((row) => row[currentStandingField]).filter((item): item is number => typeof item === 'number' && Number.isFinite(item)) : numericValues;
            const attendanceValues = attendanceField ? reportRows.map((row) => row[attendanceField]).filter((item): item is number => typeof item === 'number' && Number.isFinite(item)) : [];
            const kpis = [
              ['Students / records', reportRows.length.toLocaleString()],
              ['Average current standing', standingValues.length ? `${(standingValues.reduce((sum, item) => sum + item, 0) / standingValues.length).toFixed(1)}%` : '—'],
              ['Flagged for follow-up', String(criticalRows.length)],
              ['Average attendance', attendanceValues.length ? `${(attendanceValues.reduce((sum, item) => sum + item, 0) / attendanceValues.length).toFixed(1)}%` : '—'],
            ].filter(([, result]) => result !== '—');
            const gap = 5; const cardWidth = (pageWidth - 28 - gap * (kpis.length - 1)) / kpis.length;
            kpis.forEach(([label, result], index) => {
              const x = 14 + index * (cardWidth + gap); pdf.setFillColor(246, 247, 249); pdf.roundedRect(x, y, cardWidth, 28, 2, 2, 'F');
              pdf.setTextColor(rgb[0], rgb[1], rgb[2]); pdf.setFontSize(16); pdf.text(result, x + 4, y + 11);
              pdf.setTextColor(71, 85, 105); pdf.setFontSize(8); pdf.text(pdf.splitTextToSize(label, cardWidth - 8), x + 4, y + 20);
            });
            y += 34;
          } else if ((visualization === 'Assessment score range' || visualization === 'Current standing by period') && chartGroups.length) {
            const left = 28; const right = pageWidth - 14; const top = y + 8; const bottom = y + 56; const plotHeight = bottom - top; const plotWidth = right - left;
            const dates = [...new Set(chartGroups.map((item) => item.dateKey ?? item.label))].sort((a, b) => a.localeCompare(b));
            const seriesNames = [...new Set(chartGroups.map((item) => item.series ?? 'Overall'))];
            const palette: [number, number, number][] = [rgb as [number, number, number], [46, 134, 171], [83, 145, 103], [230, 162, 60], [139, 115, 181], [214, 107, 107], [100, 116, 139]];
            const observed = chartGroups.flatMap((item) => [item.minimum ?? item.amount, item.maximum ?? item.amount, item.amount]);
            const dataMin = Math.min(...observed); const dataMax = Math.max(...observed); const padding = Math.max(2, (dataMax - dataMin) * 0.12);
            const domainMin = Math.floor(Math.max(0, dataMin - padding) / 5) * 5; const domainMax = Math.max(domainMin + 5, Math.ceil(Math.min(100, dataMax + padding) / 5) * 5);
            const pointX = (index: number) => dates.length <= 1 ? left + plotWidth / 2 : left + index * plotWidth / (dates.length - 1);
            const pointY = (score: number) => bottom - plotHeight * (score - domainMin) / (domainMax - domainMin);
            for (let tick = 0; tick <= 4; tick++) { const score = domainMin + (domainMax - domainMin) * tick / 4; const tickY = pointY(score); pdf.setDrawColor(229, 234, 239); pdf.line(left, tickY, right, tickY); pdf.setFontSize(6); pdf.setTextColor(100, 116, 139); pdf.text(`${score.toFixed(0)}%`, left - 2, tickY + 2, { align: 'right' }); }
            seriesNames.forEach((series, seriesIndex) => {
              const color = palette[seriesIndex % palette.length]; const seriesPoints = chartGroups.filter((item) => (item.series ?? 'Overall') === series).sort((a, b) => (a.dateKey ?? a.label).localeCompare(b.dateKey ?? b.label));
              seriesPoints.forEach((item, index) => {
                const x = pointX(dates.indexOf(item.dateKey ?? item.label)); const averageY = pointY(item.amount); const lowY = pointY(item.minimum ?? item.amount); const highY = pointY(item.maximum ?? item.amount);
                pdf.setDrawColor(color[0], color[1], color[2]); pdf.line(x, highY, x, lowY); pdf.line(x - 1.2, highY, x + 1.2, highY); pdf.line(x - 1.2, lowY, x + 1.2, lowY);
                if (index) { const previous = seriesPoints[index - 1]; pdf.line(pointX(dates.indexOf(previous.dateKey ?? previous.label)), pointY(previous.amount), x, averageY); }
                pdf.setFillColor(color[0], color[1], color[2]); pdf.circle(x, averageY, 1.5, 'F');
              });
            });
            dates.forEach((dateKey, index) => { if (dates.length <= 8 || index % 2 === 0) { const label = visualization === 'Current standing by period' ? chartGroups.find((item) => item.dateKey === dateKey)?.label ?? dateKey : new Date(`${dateKey}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); pdf.setFontSize(6); pdf.setTextColor(71, 85, 105); pdf.text(label.slice(0, 18), pointX(index), bottom + 5, { align: 'center', maxWidth: Math.max(16, plotWidth / Math.min(dates.length, 6)) }); } });
            let legendX = left; let legendY = bottom + 13; pdf.setFontSize(6);
            seriesNames.forEach((series, index) => { const color = palette[index % palette.length]; pdf.setFillColor(color[0], color[1], color[2]); pdf.circle(legendX + 1, legendY - 1, 1.2, 'F'); pdf.setTextColor(71, 85, 105); pdf.text(series.slice(0, 28), legendX + 4, legendY, { maxWidth: 54 }); legendX += 58; if (legendX > right - 45) { legendX = left; legendY += 4; } });
            pdf.setTextColor(100, 116, 139); pdf.text(`Whiskers: min–max · Data scale ${domainMin}–${domainMax}%`, left, legendY + 4); y = legendY + 10;
          } else if (visualization === 'Score distribution' && chartGroups.length) {
            const left = 28; const right = pageWidth - 14; const top = y + 6; const bottom = y + 58; const plotWidth = right - left; const plotHeight = bottom - top;
            const maxCount = Math.max(1, ...chartGroups.map((item) => item.count));
            pdf.setDrawColor(220, 226, 232); pdf.line(left, bottom, right, bottom);
            chartGroups.forEach((item, index) => {
              const slot = plotWidth / chartGroups.length; const barWidth = slot * 0.62; const barHeight = plotHeight * item.count / maxCount; const x = left + index * slot + (slot - barWidth) / 2;
              pdf.setFillColor(rgb[0], rgb[1], rgb[2]); pdf.rect(x, bottom - barHeight, barWidth, barHeight, 'F');
              pdf.setFontSize(7); pdf.setTextColor(30, 41, 59); pdf.text(String(item.count), x + barWidth / 2, Math.max(top - 1, bottom - barHeight - 2), { align: 'center' });
              pdf.setFontSize(6); pdf.setTextColor(71, 85, 105); pdf.text(item.label, x + barWidth / 2, bottom + 5, { align: 'center', maxWidth: slot });
            });
            y = bottom + 14;
          } else if (visualization === 'Score spread by group' && chartGroups.length) {
            const labelWidth = Math.min(65, pageWidth * 0.2); const left = 14 + labelWidth; const right = pageWidth - 14; const plotWidth = right - left;
            const observedMaximum = Math.max(1, ...chartGroups.map((item) => item.maximum ?? item.amount)); const scaleMaximum = observedMaximum <= 100 ? 100 : Math.ceil(observedMaximum / 10) * 10;
            const xFor = (score: number) => left + plotWidth * Math.max(0, Math.min(scaleMaximum, score)) / scaleMaximum;
            const rowHeight = 14; const top = y + 7; const bottom = top + chartGroups.length * rowHeight;
            for (let tick = 0; tick <= 4; tick++) { const score = scaleMaximum * tick / 4; const x = xFor(score); pdf.setDrawColor(230, 234, 239); pdf.line(x, top - 3, x, bottom - 4); pdf.setFontSize(6); pdf.setTextColor(100, 116, 139); pdf.text(score.toFixed(scaleMaximum <= 10 ? 1 : 0), x, top - 5, { align: 'center' }); }
            chartGroups.forEach((item, index) => {
              const rowY = top + index * rowHeight + 3; const minX = xFor(item.minimum ?? item.amount); const q1X = xFor(item.lowerQuartile ?? item.amount); const medianX = xFor(item.median ?? item.amount); const q3X = xFor(item.upperQuartile ?? item.amount); const maxX = xFor(item.maximum ?? item.amount);
              pdf.setFontSize(7); pdf.setTextColor(51, 65, 85); pdf.text(item.label.slice(0, 16), 14, rowY + 2, { maxWidth: labelWidth - 4 });
              pdf.setDrawColor(100, 116, 139); pdf.line(minX, rowY, maxX, rowY); pdf.line(minX, rowY - 2, minX, rowY + 2); pdf.line(maxX, rowY - 2, maxX, rowY + 2);
              pdf.setFillColor(rgb[0], rgb[1], rgb[2]); pdf.rect(q1X, rowY - 3, Math.max(1, q3X - q1X), 6, 'F'); pdf.setDrawColor(255, 255, 255); pdf.line(medianX, rowY - 3, medianX, rowY + 3);
            });
            y = bottom + 3; pdf.setFontSize(7); pdf.setTextColor(71, 85, 105); pdf.text('Box: middle 50% · center: median · whiskers: minimum to maximum', left, y); y += 5;
          } else for (const item of chartGroups) {
            ensureSpace(10);
            pdf.setTextColor(30, 41, 59); pdf.setFontSize(9);
            const valueLabel = `${item.label}: ${item.amount.toFixed(1)}${visualization === 'Attendance watchlist' || visualization === 'Pass rate comparison' ? '%' : ''}${visualization === 'Pass rate comparison' ? ` (${item.count} classified)` : ''}`;
            const labelLines = pdf.splitTextToSize(valueLabel, 82); pdf.text(labelLines, 14, y);
            const barY = y + Math.max(0, labelLines.length - 1) * 4;
            const width = Math.max(2, 90 * item.amount / maxChartValue); pdf.setFillColor(rgb[0], rgb[1], rgb[2]);
            if (visualization === 'Trend line' && chartGroups.length > 1) { const index = chartGroups.indexOf(item); const graphStart = 100; const graphWidth = Math.max(20, pageWidth - graphStart - 14); const graphX = (pointIndex: number) => graphStart + pointIndex * graphWidth / (chartGroups.length - 1); if (index > 0) { const previous = chartGroups[index - 1]; pdf.line(graphX(index - 1), barY - 2 - 20 * previous.amount / maxChartValue, graphX(index), barY - 2 - 20 * item.amount / maxChartValue); } pdf.circle(graphX(index), barY - 2 - 20 * item.amount / maxChartValue, 1.5, 'F'); }
            else pdf.rect(100, barY - 4, Math.max(2, Math.min(pageWidth - 114, width)), 4, 'F');
            y += Math.max(9, labelLines.length * 4 + 3);
          }
        }
        if (includeGradingContext && schemaSummaryRows.length) {
          ensureSpace(24); pdf.setFontSize(12); pdf.text('Applied grading context', 14, y); y += 6;
          autoTable(pdf, { startY: y, head: [['Class context', 'Grading system / configuration', 'Evaluation criteria']], body: schemaSummaryRows, styles: { fontSize: 7, cellPadding: 2 }, margin: { left: 14, right: 14 }, theme: 'striped' });
          y = (pdf as any).lastAutoTable.finalY + 5;
        }
        if (includeGradingContext && includeFullSchemaDefinitions && appliedSchemas.length) {
          ensureSpace(14); pdf.setFontSize(12); pdf.text('Full grading schema definitions', 14, y); y += 7; pdf.setFontSize(7);
          for (const { label, schema } of appliedSchemas) { const wrapped = pdf.splitTextToSize(`${label}: ${JSON.stringify(schema, null, 2)}`, pageWidth - 28); for (const line of wrapped) { ensureSpace(5); pdf.text(line, 14, y); y += 4; } }
        }
        if (includeGradingContext && assessmentRowsForOutput.length) {
          ensureSpace(20); pdf.setFontSize(12); pdf.text('Assessment results by instance', 14, y); y += 5;
          if (concise && assessmentOutcomeRows.length > assessmentRowsForOutput.length) { pdf.setFontSize(8); pdf.text(`Showing ${assessmentRowsForOutput.length} instances with the lowest mapped averages, from ${assessmentOutcomeRows.length} total.`, 14, y); y += 5; }
          autoTable(pdf, { startY: y, head: [['Class', 'Assessment', 'Scored', 'Mean raw', 'Mean mapped %']], body: assessmentRowsForOutput.map((row) => [row.className, row.name, String(row.records), row.scores.length ? (row.scores.reduce((a, b) => a + b, 0) / row.scores.length).toFixed(1) : '—', row.mapped.length ? `${(row.mapped.reduce((a, b) => a + b, 0) / row.mapped.length).toFixed(1)}%` : '—']), styles: { fontSize: 7, cellPadding: 2 }, margin: { left: 14, right: 14 } });
          y = (pdf as any).lastAutoTable.finalY + 5;
        }
        if (includeGradingContext && calculatedFieldsForOutput.length) {
          ensureSpace(18); pdf.setFontSize(12); pdf.text('Calculated grading fields', 14, y); y += 5;
          if (concise && calculatedFieldRows.length > calculatedFieldsForOutput.length) { pdf.setFontSize(8); pdf.text(`Showing key period and semester fields (${calculatedFieldsForOutput.length} of ${calculatedFieldRows.length}); turn off concise mode for all fields.`, 14, y); y += 5; }
          autoTable(pdf, { startY: y, head: [['Field', 'Level', 'Records', 'Mean']], body: calculatedFieldsForOutput.map((row) => [row.field, row.type, String(row.count), row.mean == null ? '—' : row.mean.toFixed(1)]), styles: { fontSize: 7, cellPadding: 2 }, margin: { left: 14, right: 14 } });
          y = (pdf as any).lastAutoTable.finalY + 5;
        }
        if (tableData.length) { ensureSpace(16); pdf.setFontSize(14); pdf.text(rawTable ? 'Full data table' : 'Summary table', 14, y); autoTable(pdf, { head: [tableData[0]], body: tableData.slice(1), startY: y + 6, styles: { fontSize: rawTable ? 7 : 8 }, headStyles: { fillColor: [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)] }, theme: template === 'Executive summary' ? 'striped' : 'grid' }); }
        const totalPages = pdf.getNumberOfPages();
        for (let page = 1; page <= totalPages; page += 1) {
          pdf.setPage(page); pdf.setDrawColor(220, 226, 232); pdf.line(14, pageHeight - 12, pageWidth - 14, pageHeight - 12);
          pdf.setFontSize(7); pdf.setTextColor(100, 116, 139); pdf.text((title || initialTitle).slice(0, 90), 14, pageHeight - 7);
          pdf.text(`Page ${page} of ${totalPages}`, pageWidth - 14, pageHeight - 7, { align: 'right' });
        }
        const pdfBlob = pdf.output('blob');
        if (previewOnly && version === previewVersion.current) setPdfUrl(Platform.OS === 'web' ? URL.createObjectURL(pdfBlob) : `data:application/pdf;base64,${toBase64(new Uint8Array(await pdfBlob.arrayBuffer()))}`); else if (!previewOnly) await download(pdfBlob, `${filename(title)}.pdf`);
      }
    } catch (cause) { if (!previewOnly || version === previewVersion.current) setError(cause instanceof Error ? cause.message : 'The report could not be created.'); }
    finally {
      if (!previewOnly) setBusy(false);
      else if (version === previewVersion.current) setPreviewGenerating(false);
    }
  };

  useEffect(() => {
    if (!previewRequested) return;
    const version = ++previewVersion.current;
    const timer = setTimeout(() => { setPreviewGenerating(true); void exportReport('pdf', true, version); }, 300);
    return () => clearTimeout(timer);
  }, [previewRequested, title, template, layout, accent, activeScopeLabel, activeQuestionKey, groupBy, drilldownValue, pivotBy, value, effectiveAggregation, activeVisualizations.join(','), includeSummaryTable, includeGradingContext, includeFullSchemaDefinitions, includeInterpretations, autoInsights, concise, reportRows, insightItems, chartData, pivot, activeFilters, thresholdMode, thresholdNumber, groupSort]);
  useEffect(() => () => { if (Platform.OS === 'web' && pdfUrl) URL.revokeObjectURL(pdfUrl); }, [pdfUrl]);

  return <View style={styles.container}>
      <Card style={styles.card}>
      <Text accessibilityRole="header" style={styles.heading}>Report builder</Text>
      <Text style={styles.copy}>Create a formatted report from {activeScopeLabel.toUpperCase()} data. Select several questions to combine useful insights in one report. Only the Data table template includes every matching record.</Text>
      <Text style={styles.label}>Report title</Text><TextInput accessibilityLabel="Report title" value={title} onChangeText={setTitle} style={styles.input} />
      <Text style={styles.sectionHeading}>Report format</Text>
      <View style={styles.options}>
        {scopeOptions.length ? <Option label="Report scope" value={reportScope} options={['current', ...scopeOptions.map((option) => option.value)]} displayOptions={['This class', ...scopeOptions.map((option) => option.label)]} onChange={(next) => { void chooseReportScope(next); }} /> : null}
        <Option label="Template" value={template} options={['Executive summary', 'Detailed analysis', 'Data table']} onChange={(next) => setTemplate(next as ReportTemplate)} />
        <Option label="Page size" value={layout} options={['Portrait', 'Landscape']} displayOptions={['Standard page', 'Wide page']} onChange={(next) => setLayout(next as typeof layout)} />
        <Option label="Accent style" value={accent} options={Object.keys(accentColors)} onChange={setAccent} />
      </View>
      <Text style={styles.sectionHeading}>What should this report cover?</Text>
      <Text style={styles.copy}>Choose any combination. Templates control report structure; these choices control the analysis and can add several matching visuals.</Text>
      <View style={styles.options}>
        <MultiOption label="Analysis questions" values={activeQuestions} options={questionOptions} onChange={(next) => { setQuestions(next); setDrilldownValue(''); }} />
        {activeQuestions.includes('Assessment scores over time') && assessmentBreakdownOptions.length > 1 ? <Option label="Assessment trend grouped by" value={assessmentBreakdown} options={assessmentBreakdownOptions} onChange={(next) => setAssessmentBreakdown(next as AssessmentBreakdown)} /> : null}
      </View>
      <Text style={styles.sectionHeading}>Refine the results</Text>
      <Text style={styles.copy}>Filters combine together. Available dimensions reflect the records in this report scope; choose an all-classes scope to compare classes.</Text>
      <View style={styles.options}>
        {reportFilters.map((filter, index) => <View key={`filter-${index}`} style={styles.filterRow}>
          <Option label="Filter field" value={filter.field} options={['', ...filterOptionsByIndex[index].fields]} emptyLabel="Choose a field" searchable onChange={(next) => { setReportFilters((current) => current.map((item, itemIndex) => itemIndex === index ? { field: next, value: '' } : item)); setDrilldownValue(''); }} />
          {filter.field ? <Option label={`Match ${labelize(filter.field)}`} value={filter.value} options={['', ...filterOptionsByIndex[index].values]} emptyLabel="Choose a value" searchable onChange={(next) => { setReportFilters((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, value: next } : item)); setDrilldownValue(''); }} /> : null}
          <Pressable accessibilityRole="button" onPress={() => setReportFilters((current) => current.filter((_, itemIndex) => itemIndex !== index))} style={styles.removeFilter}><Text style={styles.removeFilterText}>Remove</Text></Pressable>
        </View>)}
        {filterFieldOptions.length > reportFilters.length ? <Button label="Add filter" variant="secondary" onPress={() => { const used = new Set(reportFilters.map((filter) => filter.field)); const nextField = filterFieldOptions.find((field) => !used.has(field)) ?? ''; setReportFilters((current) => [...current, { field: nextField, value: '' }]); }} /> : null}
        {compareSelected ? <Option label="Compare by" value={groupBy} options={groupFieldOptions} searchable onChange={(next) => { setGroupField(next); setDrilldownValue(''); }} /> : null}
        {compareSelected && groupBy ? <Option label="Drill into one group" value={drilldownValue} options={['', ...groups.map(([key]) => key)]} searchable onChange={setDrilldownValue} /> : null}
      </View>
      {compareSelected && currentStandingField && groupBy && /class|section|category/i.test(groupBy) ? <View style={styles.options}>
        <Option label="Standing filter" value={thresholdMode} options={['', 'below', 'above']} displayOptions={['No threshold', 'Below threshold', 'At or above threshold']} onChange={setThresholdMode} />
        {thresholdMode ? <View style={styles.option}><Text style={styles.label}>Average standing (%)</Text><TextInput accessibilityLabel="Average standing threshold" value={standingThreshold} onChangeText={setStandingThreshold} keyboardType="decimal-pad" style={styles.input} /></View> : null}
      </View> : null}
      {compareSelected && groupBy && pivotFieldOptions.length ? <View style={styles.toggles}>
        <Toggle label="Add a secondary breakdown" value={showAdvancedBreakdown} onChange={setShowAdvancedBreakdown} />
        {showAdvancedBreakdown ? <View style={styles.option}><Option label="Break down each group by" value={pivotField} options={['', ...pivotFieldOptions]} onChange={setPivotField} /></View> : null}
        {showAdvancedBreakdown && pivotBy ? <Text style={styles.copy}>The pivot keeps the 12 largest groups and 12 most common categories so the report stays readable.</Text> : null}
      </View> : null}
      {compareSelected && groupBy ? <View style={styles.options}><Option label="Order groups by" value={groupSort} options={['highest average', 'lowest average', 'most students', 'name']} onChange={(next) => setGroupSort(next as typeof groupSort)} /></View> : null}
      {thresholdActive ? <Text style={styles.copy}>Only groups whose average current standing is {thresholdMode === 'below' ? 'below' : 'at or above'} {thresholdNumber}% are included. Students with no recorded standing are excluded from each class average.</Text> : null}
      {loadingScope ? <Text style={styles.copy}>Loading {activeScopeLabel.toLowerCase()}…</Text> : null}
      {scopeError ? <Text accessibilityRole="alert" style={styles.error}>{scopeError}</Text> : null}
      <Text style={styles.sectionHeading}>Included content</Text>
      <View style={styles.toggles}>
        {!rawTable ? <Toggle label="Include grouped summary table" value={includeSummaryTable} onChange={setIncludeSummaryTable} /> : <Text style={styles.dumpNote}>Data table template includes all {reportRows.length.toLocaleString()} matching records.</Text>}
        <Toggle label="Include grading summary and assessment results" value={includeGradingContext} onChange={setIncludeGradingContext} />
        {includeGradingContext ? <Toggle label="Include full schema definitions (technical appendix)" value={includeFullSchemaDefinitions} onChange={setIncludeFullSchemaDefinitions} /> : null}
        <Toggle label="Identify key information and insights" value={autoInsights} onChange={setAutoInsights} />
        <Toggle label="Add descriptions and interpretations" value={includeInterpretations} onChange={setIncludeInterpretations} />
        <Toggle label="Keep it concise" value={concise} onChange={setConcise} />
      </View>
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      <View style={styles.actions}><Button label={busy ? 'Preparing…' : 'Export DOCX'} variant="secondary" loading={busy || Boolean(loadingScope)} onPress={() => void exportReport('docx')} /><Button label={busy ? 'Preparing…' : 'Export PDF'} loading={busy || Boolean(loadingScope)} onPress={() => void exportReport('pdf')} /></View>
    </Card>

    <Card style={styles.preview}>
      {autoInsights && insightItems.length ? <View style={styles.insightPanel}>
        <Text style={styles.insightHeading}>Key findings in this report</Text>
        {insightItems.slice(0, concise ? 5 : 10).map((item, index) => <Text key={`${index}-${item}`} style={styles.insightItem}>• {item}</Text>)}
      </View> : null}
      <View style={styles.previewHeader}><View><Text style={styles.previewKicker}>PDF PREVIEW</Text><Text style={styles.copy}>{activeScopeLabel} · {new Date().toLocaleDateString()} · {template}</Text></View><Text style={styles.previewBadge}>{reportRows.length.toLocaleString()} records</Text></View>
      {previewGenerating && pdfUrl ? <Text accessibilityLiveRegion="polite" style={styles.previewUpdating}>Updating PDF preview…</Text> : null}
      {!previewRequested ? <><Text style={styles.copy}>Generate the PDF preview when you’re ready. It will update when report settings change.</Text><Button label="Generate PDF preview" onPress={() => setPreviewRequested(true)} /></> : pdfUrl ? <ReportPdfPreview uri={pdfUrl} style={styles.pdfFrame} /> : <Text style={styles.copy}>Preparing PDF preview…</Text>}
    </Card>

    <Card style={styles.sourceDataCard}>
      <Text style={styles.heading}>Source data used (temporary)</Text>
      <Text style={styles.copy}>View the source records, applied schemas, analysis settings, and insights used for this report. This temporary data is not added to the PDF or DOCX.</Text>
      <Button label={showSourceData ? 'Hide source data' : 'Show source data'} variant="secondary" onPress={() => setShowSourceData((visible) => !visible)} />
      {showSourceData ? <TextInput accessibilityLabel="Source data used for this report" multiline editable={false} selectTextOnFocus scrollEnabled value={accessedDataText} style={styles.sourceDataBox} /> : null}
    </Card>
  </View>;
}

function MultiOption({ label, values, options, onChange }: { label: string; values: ReportQuestion[]; options: ReportQuestion[]; onChange: (values: ReportQuestion[]) => void }) {
  const [open, setOpen] = useState(false);
  const selected = values.includes('Recommended overview') ? 'Recommended overview' : `${values.length} selected`;
  const toggle = (option: ReportQuestion) => {
    if (option === 'Recommended overview') { onChange(['Recommended overview']); return; }
    const next = values.includes(option) ? values.filter((item) => item !== option && item !== 'Recommended overview') : [...values.filter((item) => item !== 'Recommended overview'), option];
    onChange(next.length ? next : ['Recommended overview']);
  };
  return <View style={styles.option}><Text style={styles.label}>{label}</Text><Pressable accessibilityRole="button" accessibilityLabel={`${label}: ${selected}`} onPress={() => setOpen(true)} style={styles.dropdown}><Text style={styles.dropdownValue}>{selected}</Text><Text style={styles.dropdownChevron}>▾</Text></Pressable><Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}><Pressable style={styles.dropdownBackdrop} onPress={() => setOpen(false)}><View style={styles.dropdownMenu}><Text style={styles.dropdownTitle}>{label}</Text><Text style={styles.copy}>Select multiple analysis goals. “Recommended overview” is a standalone automatic selection.</Text><ScrollView>{options.map((option) => <Pressable key={option} accessibilityRole="checkbox" accessibilityState={{ checked: values.includes(option) }} onPress={() => toggle(option)} style={styles.dropdownItem}><Text style={styles.dropdownItemText}>{labelize(option)}</Text>{values.includes(option) ? <Text style={styles.dropdownCheck}>✓</Text> : null}</Pressable>)}</ScrollView><Button label="Done" onPress={() => setOpen(false)} /></View></Pressable></Modal></View>;
}
function Option({ label, value, options, onChange, displayOptions, emptyLabel = 'Automatic', searchable = false }: { label: string; value: string; options: string[]; onChange: (value: string) => void; displayOptions?: string[]; emptyLabel?: string; searchable?: boolean }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const index = options.indexOf(value);
  const optionLabel = (option: string, optionIndex: number) => displayOptions?.[optionIndex] ?? (option ? labelize(option) : emptyLabel);
  const selected = index < 0 ? emptyLabel : optionLabel(value, index);
  const visibleOptions = options.map((option, optionIndex) => ({ option, optionIndex })).filter(({ option, optionIndex }) => !searchable || !search || optionLabel(option, optionIndex).toLowerCase().includes(search.toLowerCase()));
  return <View style={styles.option}><Text style={styles.label}>{label}</Text><Pressable accessibilityRole="button" accessibilityLabel={`${label}: ${selected}`} onPress={() => { setSearch(''); setOpen(true); }} style={styles.dropdown}><Text style={styles.dropdownValue}>{selected}</Text><Text style={styles.dropdownChevron}>▾</Text></Pressable><Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}><Pressable style={styles.dropdownBackdrop} onPress={() => setOpen(false)}><View style={styles.dropdownMenu}><Text style={styles.dropdownTitle}>{label}</Text>{searchable ? <TextInput accessibilityLabel={`Search ${label}`} placeholder="Search options" value={search} onChangeText={setSearch} style={styles.input} /> : null}<ScrollView>{visibleOptions.map(({ option, optionIndex }) => <Pressable key={option || `empty-${optionIndex}`} onPress={() => { onChange(option); setOpen(false); }} style={styles.dropdownItem}><Text style={styles.dropdownItemText}>{optionLabel(option, optionIndex)}</Text>{option === value ? <Text style={styles.dropdownCheck}>✓</Text> : null}</Pressable>)}</ScrollView></View></Pressable></Modal></View>;
}
function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) { return <View style={styles.toggleRow}><Text style={styles.toggleLabel}>{label}</Text><Switch accessibilityLabel={label} value={value} onValueChange={onChange} trackColor={{ false: '#D0D5DD', true: colors.brand }} thumbColor="#FFFFFF" /></View>; }

const styles = StyleSheet.create({
  container: { gap: 12, marginTop: 16 }, card: {}, heading: { color: colors.text, fontSize: 18, fontWeight: '700', marginBottom: 5 }, sectionHeading: { color: colors.text, fontSize: 14, fontWeight: '700', marginTop: 8 }, copy: { color: colors.textMuted, fontSize: 12, lineHeight: 18, marginBottom: 8 }, label: { color: colors.textMuted, fontSize: 11, fontWeight: '700', marginBottom: 5 }, input: { borderColor: colors.border, borderWidth: 1, borderRadius: 8, color: colors.text, paddingHorizontal: 10, paddingVertical: 9, marginBottom: 12 }, options: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 }, option: { minWidth: 190, flexGrow: 1 }, filterRow: { width: '100%', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', gap: 8, borderBottomWidth: 1, borderBottomColor: colors.border, paddingBottom: 8, marginBottom: 4 }, removeFilter: { minHeight: 40, justifyContent: 'center', paddingHorizontal: 10 }, removeFilterText: { color: colors.danger, fontSize: 12, fontWeight: '600' }, dropdown: { minHeight: 40, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 10, backgroundColor: '#FFF' }, dropdownValue: { color: colors.text, fontSize: 12 }, dropdownChevron: { color: colors.textMuted, fontSize: 16 }, dropdownBackdrop: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(15,23,42,0.35)', padding: 24 }, dropdownMenu: { width: '100%', maxWidth: 420, maxHeight: '75%', backgroundColor: '#FFF', borderRadius: 12, padding: 12 }, dropdownTitle: { fontSize: 14, fontWeight: '700', color: colors.text, padding: 10 }, dropdownItem: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, borderTopWidth: 1, borderTopColor: colors.border }, dropdownItemText: { color: colors.text, fontSize: 13 }, dropdownCheck: { color: colors.brand, fontWeight: '700' }, toggles: { gap: 4, marginTop: 12 }, toggleRow: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16, borderBottomWidth: 1, borderColor: colors.border }, toggleLabel: { flex: 1, color: colors.text, fontSize: 12 }, actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }, error: { color: colors.danger, fontSize: 12, marginTop: 8 }, dumpNote: { color: colors.warning, fontSize: 12, alignSelf: 'center' }, previewUpdating: { color: colors.textMuted, fontSize: 11, marginTop: 6 },
  preview: { borderWidth: 1, borderColor: colors.border, backgroundColor: '#FFF', padding: 12 }, insightPanel: { backgroundColor: '#F8FAFC', borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 12, marginBottom: 12, gap: 5 }, insightHeading: { color: colors.text, fontSize: 13, fontWeight: '700', marginBottom: 3 }, insightItem: { color: colors.text, fontSize: 12, lineHeight: 18 }, previewHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }, previewKicker: { color: colors.textMuted, fontSize: 9, fontWeight: '800', letterSpacing: 1.2 }, previewBadge: { color: colors.brand, fontSize: 11, fontWeight: '700', backgroundColor: '#F8ECE9', borderRadius: 20, paddingHorizontal: 10, paddingVertical: 6 }, pdfFrame: { width: '100%', height: 900, backgroundColor: '#E7E9ED', marginTop: 8 }, sourceDataCard: { borderWidth: 1, borderColor: colors.border, padding: 12 }, sourceDataBox: { height: 280, borderColor: colors.border, borderWidth: 1, borderRadius: 8, padding: 10, color: colors.text, backgroundColor: '#F8FAFC', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 10, textAlignVertical: 'top' },
});
