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
type Visualization = 'Bar chart' | 'Pass rate comparison' | 'Donut chart' | 'Risk distribution' | 'Trend line' | 'Assessment score range' | 'Current standing by period' | 'Score distribution' | 'Score spread by group' | 'KPI summary' | 'Attendance watchlist' | 'Attendance by group' | 'Missed assessment watchlist' | 'Assessment performance by type' | 'Assessment ranking';
type ReportQuestion = 'Recommended overview' | 'Compare groups' | 'Assessment scores over time' | 'Current standing over time' | 'Risk distribution' | 'Attendance rates' | 'Missing assessments' | 'Score distribution' | 'Assessment performance by type' | 'Highest and lowest assessment scores';
type AssessmentBreakdown = 'Overall' | 'Period' | 'Component' | 'Group' | 'Assessment type' | `By:${string}`;
type AssessmentInterval = 'day' | 'week' | 'group' | 'assessment instance (logical order)' | 'assessment instance (chronological order)';
const labelize = (value: string) => value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
const filename = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'apms-report';
const accentColors: Record<string, string> = { Burgundy: '6B2C1F', Ocean: '246899', Evergreen: '28724F' };
const criticalWords = /high|medium|critical|elevated|failing|at.?risk|overdue|error|failed/i;

function findingSegments(text: string) {
  const spans: { start: number; end: number }[] = [];
  const addMatches = (pattern: RegExp, capture = 0) => {
    for (const match of text.matchAll(pattern)) {
      const value = match[capture];
      if (!value) continue;
      const start = match.index! + (capture ? match[0].indexOf(value) : 0);
      spans.push({ start, end: start + value.length });
    }
  };
  addMatches(/\(?\d[\d,]*(?:\.\d+)?%\)?/g);
  addMatches(/\b(?:highest|lowest|high|critical)\b/gi);
  addMatches(/^\d+(?= of \d+ students)/gi);
  addMatches(/\bfor\s+([^();]+?)(?=\s*\(|;|\.|,|\s+and\s+(?:lowest|highest)\b)/gi, 1);
  addMatches(/\b(?:highest|lowest)\s+in\s+([^();]+?)(?=\s*\(|;|\.|,|\s+and\s+(?:lowest|highest)\b)/gi, 1);
  addMatches(/^(.+?)(?=\s+had the (?:most missing assessments|lowest recorded attendance)\b)/gi, 1);
  const boundaries = new Set([0, text.length]);
  for (const span of spans) { boundaries.add(span.start); boundaries.add(span.end); }
  const sorted = [...boundaries].sort((a, b) => a - b);
  return sorted.slice(0, -1).map((start, index) => {
    const end = sorted[index + 1];
    const segment = text.slice(start, end);
    return { text: segment, bold: spans.some((span) => start >= span.start && end <= span.end) };
  }).filter((segment) => segment.text.length > 0);
}

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

type ChartItem = { label: string; count: number; amount: number; minimum?: number; lowerQuartile?: number; median?: number; upperQuartile?: number; maximum?: number; series?: string; dateKey?: string; dateLabel?: string; sortKey?: string; rangeSuppressed?: boolean };

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
  if (kind === 'Group') return String((id ? findSchemaName(schema?.groups, id) : '') || (item?.moduleNumber != null ? `Group ${item.moduleNumber}` : 'Unspecified group'));
  const component = (Array.isArray(schema?.components) ? schema.components : []).find((entry: ReportRecord) => String(entry?.assessmentDefinition?.typeId ?? entry?.assessmentTypeId ?? entry?.typeId ?? '') === String(id ?? ''));
  return String(component?.name ?? component?.label ?? (id ? findSchemaName(schema?.assessmentTypes, id) : '') ?? 'Unmapped component');
}

function findSchemaName(collection: unknown, id: unknown): string {
  if (!Array.isArray(collection)) return '';
  const entry = collection.find((candidate: ReportRecord) => String(candidate?.id ?? candidate?.key ?? '') === String(id));
  return String(entry?.name ?? entry?.label ?? '');
}

function assessmentScoreSeries(rows: ReportRecord[], breakdown: AssessmentBreakdown, interval: AssessmentInterval): ChartItem[] {
  const rawValuesByInstance = new Map<string, Set<string>>();
  for (const row of rows) for (const item of Array.isArray(row.assessmentResults) ? row.assessmentResults : []) {
    const instanceId = String(item?.assessmentId ?? item?.assessmentInstanceId ?? item?.id ?? item?.name ?? 'Assessment');
    if (item?.rawScore == null) continue;
    const values = rawValuesByInstance.get(instanceId) ?? new Set<string>();
    values.add(String(item.rawScore));
    rawValuesByInstance.set(instanceId, values);
  }
  const byPeriod = new Map<string, { series: string; dateKey: string; label: string; dateLabel: string; sortKey: string; rangeSuppressed: boolean; scores: number[] }>();
  for (const row of rows) {
    const assessments = Array.isArray(row.assessmentResults) ? row.assessmentResults : [];
    for (const item of assessments) {
      if (item?.mappedPercentage == null) continue;
      const score = Number(item.mappedPercentage);
      const date = String(item?.date ?? '');
      if (!date || !Number.isFinite(new Date(date).getTime()) || !Number.isFinite(score)) continue;
      const day = new Date(date).toISOString().slice(0, 10);
      const instanceId = String(item?.assessmentId ?? item?.assessmentInstanceId ?? item?.id ?? item?.name ?? 'Assessment');
      const typeId = item?.gradingTypeId ?? item?.typeId ?? item?.component;
      const component = (Array.isArray(row.gradingSystemSchema?.components) ? row.gradingSystemSchema.components : []).find((entry: ReportRecord) => String(entry?.assessmentDefinition?.typeId ?? entry?.assessmentTypeId ?? entry?.typeId ?? '') === String(typeId ?? ''));
      const scoring = component?.assessmentDefinition?.scoring;
      const categoryCount = rawValuesByInstance.get(instanceId)?.size ?? 0;
      const rangeSuppressed = Number(item?.maximumScore) === 1
        || (scoring?.mode === 'value_mapping' && Array.isArray(scoring.mapping) && scoring.mapping.length <= 2)
        || (typeof item?.rawScore === 'string' && categoryCount > 0 && categoryCount <= 2);
      const series = breakdown.startsWith('By:')
        ? String(row[breakdown.slice(3)] ?? 'Unspecified')
        : gradingLabel(row.gradingSystemSchema, breakdown, item);
      const assessmentName = String(item?.name ?? item?.title ?? 'Assessment');
      let dateKey = day;
      let label = new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
      let dateLabel = label;
      let bucketIdentity = day;
      let sortKey = day;
      if (interval === 'week') {
        const monday = new Date(`${day}T00:00:00Z`);
        monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
        dateKey = monday.toISOString().slice(0, 10);
        label = `Week of ${new Date(`${dateKey}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })}`;
        dateLabel = label;
        bucketIdentity = dateKey;
      } else if (interval === 'group') {
        const groupName = gradingLabel(row.gradingSystemSchema, 'Group', item);
        const groupKey = groupName.toLowerCase();
        dateKey = `group:${groupKey}`;
        label = groupName;
        dateLabel = label;
        sortKey = groupName;
        bucketIdentity = dateKey;
      } else if (interval.startsWith('assessment instance')) {
        const instanceId = String(item?.assessmentId ?? item?.assessmentInstanceId ?? item?.id ?? assessmentName);
        dateKey = `${day}:assessment:${instanceId}`;
        label = `${assessmentName} · ${dateLabel}`;
        dateLabel = label;
        const periodName = gradingLabel(row.gradingSystemSchema, 'Period', item);
        const groupName = gradingLabel(row.gradingSystemSchema, 'Group', item);
        const periodOrder = periodName.match(/\d+/)?.[0] ?? assessmentName.match(/\bP\s*(\d+)\b/i)?.[1] ?? '99';
        const instanceOrder = String(item?.instanceNumber ?? item?.sequenceNumber ?? item?.assessmentNumber ?? assessmentName.match(/\b(?:instance|assessment|quiz|test|exam)\s*#?\s*(\d+)\b/i)?.[1] ?? assessmentName.match(/(?:^|[\s#-])(\d+)\s*$/)?.[1] ?? '99');
        const dimensions = `P${periodOrder}:Group ${groupName}:Instance ${instanceOrder}`;
        sortKey = interval === 'assessment instance (logical order)' ? `${dimensions}:${day}:${assessmentName}` : `${day}:${dimensions}:${assessmentName}`;
        bucketIdentity = dateKey;
      }
      const key = `${bucketIdentity}:${series}`;
      const values = byPeriod.get(key) ?? { series, dateKey, label, dateLabel, sortKey, rangeSuppressed, scores: [] };
      if ((interval === 'day' || interval === 'week') && day.localeCompare(values.sortKey) < 0) values.sortKey = day;
      values.rangeSuppressed = values.rangeSuppressed && rangeSuppressed;
      values.scores.push(score);
      byPeriod.set(key, values);
    }
  }
  const seriesCounts = new Map<string, number>();
  for (const point of byPeriod.values()) seriesCounts.set(point.series, (seriesCounts.get(point.series) ?? 0) + point.scores.length);
  const retainedSeries = new Set([...seriesCounts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 6).map(([series]) => series));
  const grouped = new Map<string, { series: string; dateKey: string; label: string; dateLabel: string; sortKey: string; rangeSuppressed: boolean; scores: number[] }>();
  for (const point of byPeriod.values()) {
    const series = retainedSeries.has(point.series) ? point.series : 'Other categories';
    const key = `${point.dateKey}:${series}`;
    const values = grouped.get(key) ?? { series, dateKey: point.dateKey, label: point.label, dateLabel: point.dateLabel, sortKey: point.sortKey, rangeSuppressed: point.rangeSuppressed, scores: [] };
    if (point.sortKey.localeCompare(values.sortKey) < 0) values.sortKey = point.sortKey;
    values.rangeSuppressed = values.rangeSuppressed && point.rangeSuppressed;
    values.scores.push(...point.scores);
    grouped.set(key, values);
  }
  return [...grouped.values()].sort((left, right) => left.sortKey.localeCompare(right.sortKey, undefined, { numeric: true, sensitivity: 'base' }) || left.label.localeCompare(right.label, undefined, { numeric: true, sensitivity: 'base' }) || left.series.localeCompare(right.series)).map(({ series, dateKey, label, dateLabel, sortKey, rangeSuppressed, scores }) => {
    const sortedScores = [...scores].sort((left, right) => left - right);
    return {
      label,
      dateLabel,
      dateKey,
      series,
      count: scores.length,
      sortKey,
      rangeSuppressed,
      amount: scores.reduce((sum, score) => sum + score, 0) / scores.length,
      minimum: sortedScores[0],
      lowerQuartile: quantile(sortedScores, 0.25),
      median: quantile(sortedScores, 0.5),
      upperQuartile: quantile(sortedScores, 0.75),
      maximum: sortedScores[sortedScores.length - 1],
    };
  });
}

function renderAssessmentSeriesPanels({ pdf, items, seriesNames, pageWidth, pageHeight, startY, interval, showMinMax, showIqr }: { pdf: any; items: ChartItem[]; seriesNames: string[]; pageWidth: number; pageHeight: number; startY: number; interval: AssessmentInterval; showMinMax: boolean; showIqr: boolean }) {
  const left = 28; const right = pageWidth - 14; const plotWidth = right - left;
  const dates = [...new Set(items.map((item) => item.dateKey ?? item.label))].sort((a, b) => {
    const aOrder = items.find((item) => (item.dateKey ?? item.label) === a)?.sortKey ?? a;
    const bOrder = items.find((item) => (item.dateKey ?? item.label) === b)?.sortKey ?? b;
    return aOrder.localeCompare(bOrder, undefined, { numeric: true, sensitivity: 'base' }) || a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  });
  const palette: [number, number, number][] = [[107, 44, 31], [46, 134, 171], [83, 145, 103], [230, 162, 60], [139, 115, 181], [214, 107, 107], [100, 116, 139]];
  const observed = items.flatMap((item) => [item.minimum ?? item.amount, item.maximum ?? item.amount, item.amount]);
  const dataMin = Math.min(...observed); const dataMax = Math.max(...observed); const padding = Math.max(2, (dataMax - dataMin) * 0.12);
  const domainMin = Math.floor(Math.max(0, dataMin - padding) / 5) * 5; const domainMax = Math.max(domainMin + 5, Math.ceil(Math.min(100, dataMax + padding) / 5) * 5);
  const instanceAxis = interval.startsWith('assessment instance');
  const labelFontSize = Math.max(4, Math.min(5.5, 70 / Math.max(1, dates.length))); const labelSlotWidth = Math.max(4, plotWidth / Math.max(1, dates.length) - 1);
  let maxLabelLines = 1;
  if (instanceAxis) {
    pdf.setFontSize(labelFontSize);
    maxLabelLines = Math.max(1, ...items.map((item) => {
      return pdf.splitTextToSize(item.dateLabel ?? item.dateKey ?? item.label, labelSlotWidth).length;
    }));
  }
  const axisHeight = instanceAxis ? 8 + maxLabelLines * 2 : 12;
  let y = startY;
  seriesNames.forEach((series, seriesIndex) => {
    const panelHeight = 38 + axisHeight + 8;
    if (y + panelHeight > pageHeight - 16) { pdf.addPage(); y = 16; }
    const panelY = y; const top = panelY + 6; const bottom = top + 22; const plotHeight = bottom - top;
    const color = palette[seriesIndex % palette.length];
    pdf.setTextColor(color[0], color[1], color[2]); pdf.setFontSize(8); pdf.text(series, 14, panelY + 3, { maxWidth: pageWidth - 28 });
    const pointX = (index: number) => dates.length <= 1 ? left + plotWidth / 2 : left + index * plotWidth / (dates.length - 1);
    const pointY = (score: number) => bottom - plotHeight * (score - domainMin) / (domainMax - domainMin);
    for (let tick = 0; tick <= 2; tick += 1) {
      const score = domainMin + (domainMax - domainMin) * tick / 2; const tickY = pointY(score);
      pdf.setDrawColor(229, 234, 239); pdf.line(left, tickY, right, tickY); pdf.setFontSize(6); pdf.setTextColor(100, 116, 139); pdf.text(`${score.toFixed(0)}%`, left - 2, tickY + 2, { align: 'right' });
    }
    const points = items.filter((item) => (item.series ?? 'Overall') === series).sort((a, b) => (a.sortKey ?? a.dateKey ?? a.label).localeCompare(b.sortKey ?? b.dateKey ?? b.label, undefined, { numeric: true, sensitivity: 'base' }) || (a.dateKey ?? a.label).localeCompare(b.dateKey ?? b.label, undefined, { numeric: true, sensitivity: 'base' }));
    const relevantIndexes = [...new Set(points.map((item) => dates.indexOf(item.dateKey ?? item.label)).filter((index) => index >= 0))].sort((a, b) => a - b);
    const labelStep = Math.max(1, Math.ceil(relevantIndexes.length / 8));
    const visibleIndexes = relevantIndexes.filter((index, relevantIndex) => instanceAxis || relevantIndex % labelStep === 0 || relevantIndex === relevantIndexes.length - 1);
    points.forEach((item, index) => {
      const x = pointX(dates.indexOf(item.dateKey ?? item.label)); const meanY = pointY(item.amount); const suppressed = item.rangeSuppressed === true;
      if (index) { const previous = points[index - 1]; pdf.setDrawColor(color[0], color[1], color[2]); pdf.line(pointX(dates.indexOf(previous.dateKey ?? previous.label)), pointY(previous.amount), x, meanY); }
      if (!suppressed && showMinMax) { const minY = pointY(item.minimum ?? item.amount); const maxY = pointY(item.maximum ?? item.amount); pdf.setDrawColor(color[0], color[1], color[2]); pdf.line(x, maxY, x, minY); pdf.line(x - 1.2, maxY, x + 1.2, maxY); pdf.line(x - 1.2, minY, x + 1.2, minY); }
      if (!suppressed && showIqr) { const q1Y = pointY(item.lowerQuartile ?? item.amount); const medianY = pointY(item.median ?? item.amount); const q3Y = pointY(item.upperQuartile ?? item.amount); const boxWidth = Math.max(2.4, Math.min(4, plotWidth / Math.max(1, dates.length) * 0.55)); const lightColor = color.map((channel) => Math.round(channel * 0.28 + 255 * 0.72)); pdf.setFillColor(lightColor[0], lightColor[1], lightColor[2]); pdf.setDrawColor(color[0], color[1], color[2]); pdf.rect(x - boxWidth / 2, q3Y, boxWidth, Math.max(0.8, q1Y - q3Y), 'FD'); pdf.line(x - boxWidth / 2, medianY, x + boxWidth / 2, medianY); }
      if (suppressed) { const medianY = pointY(item.median ?? item.amount); pdf.setDrawColor(color[0], color[1], color[2]); pdf.line(x - 1.8, medianY, x + 1.8, medianY); }
      pdf.setFillColor(color[0], color[1], color[2]); pdf.circle(x, meanY, 1, 'F');
    });
    let usedLabelLines = 0;
    visibleIndexes.forEach((index) => {
      const dateKey = dates[index]; const point = points.find((item) => (item.dateKey ?? item.label) === dateKey); const label = point?.dateLabel ?? dateKey;
      pdf.setTextColor(71, 85, 105);
      if (instanceAxis) { pdf.setFontSize(labelFontSize); const lines = pdf.splitTextToSize(label, labelSlotWidth); usedLabelLines = Math.max(usedLabelLines, lines.length); pdf.text(lines, pointX(index), bottom + 5, { align: 'center', maxWidth: labelSlotWidth }); }
      else { const shortLabel = label.length > 18 ? `${label.slice(0, 17)}…` : label; pdf.setFontSize(6); pdf.text(shortLabel, pointX(index), bottom + 5, { align: 'center', maxWidth: Math.max(16, plotWidth / visibleIndexes.length - 2) }); }
    });
    const binaryNote = items.some((item) => item.rangeSuppressed) ? 'Binary assessments show median only' : ''; const note = [binaryNote].filter(Boolean).join(' · ');
    pdf.setTextColor(100, 116, 139); pdf.setFontSize(6); pdf.text(`${note ? `${note} · ` : ''}Data scale ${domainMin}–${domainMax}%`, left, bottom + 8 + (instanceAxis ? usedLabelLines * 2 : 12));
    y = bottom + 12 + (instanceAxis ? usedLabelLines * 2 : 12);
  });
  return y;
}

function assessmentTrendSvg(items: ChartItem[], series: string, interval: AssessmentInterval, color: string, domainMin: number, domainMax: number, showMinMax: boolean, showIqr: boolean) {
  const points = items.filter((item) => (item.series ?? 'Overall') === series).sort((a, b) => (a.sortKey ?? a.dateKey ?? a.label).localeCompare(b.sortKey ?? b.dateKey ?? b.label, undefined, { numeric: true, sensitivity: 'base' }));
  const width = 900; const height = interval.startsWith('assessment instance') ? 360 : 300;
  const left = 58; const right = width - 18; const top = 16; const bottom = 238; const plotWidth = right - left; const plotHeight = bottom - top;
  const x = (index: number) => points.length <= 1 ? left + plotWidth / 2 : left + index * plotWidth / (points.length - 1);
  const y = (value: number) => bottom - (value - domainMin) * plotHeight / Math.max(1, domainMax - domainMin);
  const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const instanceAxis = interval.startsWith('assessment instance');
  const labelIndexes = instanceAxis ? points.map((_, index) => index) : points.map((_, index) => index).filter((index) => points.length <= 10 || index % Math.ceil(points.length / 10) === 0 || index === points.length - 1);
  const labels = labelIndexes.map((index) => {
    const label = points[index].dateLabel ?? points[index].label;
    const chunks = label.split(' · ').flatMap((part) => {
      const words = part.split(/\s+/); const lines: string[] = []; let line = '';
      for (const word of words) { const next = line ? `${line} ${word}` : word; if (next.length > 17 && line) { lines.push(line); line = word; } else line = next; }
      if (line) lines.push(line);
      return lines;
    }).slice(0, 4);
    return `<text x="${x(index)}" y="${bottom + 17}" text-anchor="middle" font-size="${instanceAxis ? 9 : 10}" fill="#475569">${chunks.map((line, lineIndex) => `<tspan x="${x(index)}" dy="${lineIndex ? 11 : 0}">${escape(line)}</tspan>`).join('')}</text>`;
  }).join('');
  const grid = Array.from({ length: 5 }, (_, index) => {
    const value = domainMin + (domainMax - domainMin) * index / 4; const yy = y(value);
    return `<line x1="${left}" y1="${yy}" x2="${right}" y2="${yy}" stroke="#E5EAF0"/><text x="${left - 8}" y="${yy + 4}" text-anchor="end" font-size="11" fill="#64748B">${Math.round(value)}%</text>`;
  }).join('');
  const paths = points.slice(1).map((point, index) => `<line x1="${x(index)}" y1="${y(points[index].amount)}" x2="${x(index + 1)}" y2="${y(point.amount)}" stroke="#${color}" stroke-width="2"/>`).join('');
  const marks = points.map((point, index) => {
    const xx = x(index); const suppressed = point.rangeSuppressed === true; const parts: string[] = [];
    if (!suppressed && showMinMax) { const low = y(point.minimum ?? point.amount); const high = y(point.maximum ?? point.amount); parts.push(`<line x1="${xx}" y1="${high}" x2="${xx}" y2="${low}" stroke="#${color}"/><line x1="${xx - 4}" y1="${high}" x2="${xx + 4}" y2="${high}" stroke="#${color}"/><line x1="${xx - 4}" y1="${low}" x2="${xx + 4}" y2="${low}" stroke="#${color}"/>`); }
    if (!suppressed && showIqr) { const q1 = y(point.lowerQuartile ?? point.amount); const median = y(point.median ?? point.amount); const q3 = y(point.upperQuartile ?? point.amount); parts.push(`<rect x="${xx - 5}" y="${q3}" width="10" height="${Math.max(1, q1 - q3)}" fill="#${color}" fill-opacity=".18" stroke="#${color}"/><line x1="${xx - 5}" y1="${median}" x2="${xx + 5}" y2="${median}" stroke="#${color}" stroke-width="2"/>`); }
    if (suppressed) { const median = y(point.median ?? point.amount); parts.push(`<line x1="${xx - 4}" y1="${median}" x2="${xx + 4}" y2="${median}" stroke="#${color}" stroke-width="2"/>`); }
    parts.push(`<circle cx="${xx}" cy="${y(point.amount)}" r="3" fill="#${color}"/>`);
    return parts.join('');
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#FFFFFF"/>${grid}${paths}${marks}${labels}</svg>`;
}

async function rasterizeChart(svg: string, width: number, height: number): Promise<Uint8Array> {
  if (Platform.OS !== 'web' || typeof document === 'undefined') throw new Error('Chart image conversion is unavailable on this device.');
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Chart image conversion is unavailable in this browser.');
  const objectUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('The assessment chart could not be prepared for DOCX.')); image.src = objectUrl; });
    context.drawImage(image, 0, 0, width, height);
    const base64 = canvas.toDataURL('image/png').split(',')[1] ?? '';
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'; const bytes = new Uint8Array(Math.floor(base64.length * 3 / 4)); let outputIndex = 0;
    for (let index = 0; index < base64.length; index += 4) { const a = alphabet.indexOf(base64[index]); const b = alphabet.indexOf(base64[index + 1]); const c = base64[index + 2] === '=' ? 0 : alphabet.indexOf(base64[index + 2]); const d = base64[index + 3] === '=' ? 0 : alphabet.indexOf(base64[index + 3]); bytes[outputIndex++] = (a << 2) | (b >> 4); if (base64[index + 2] !== '=') bytes[outputIndex++] = ((b & 15) << 4) | (c >> 2); if (base64[index + 3] !== '=') bytes[outputIndex++] = ((c & 3) << 6) | d; }
    return bytes.slice(0, outputIndex);
  } finally { URL.revokeObjectURL(objectUrl); }
}

function summarizeAssessmentResults(rows: ReportRecord[], by: 'type' | 'assessment'): ChartItem[] {
  const groups = new Map<string, { scores: number[]; series: string }>();
  for (const row of rows) {
    const results = Array.isArray(row.assessmentResults) ? row.assessmentResults : [];
    for (const assessment of results) {
      if (assessment?.mappedPercentage == null || !Number.isFinite(Number(assessment.mappedPercentage))) continue;
      const type = gradingLabel(row.gradingSystemSchema, 'Assessment type', assessment);
      const assessmentName = String(assessment.name ?? assessment.id ?? 'Assessment');
      const className = String(row.class ?? row.category ?? row.subject ?? 'Class');
      const label = by === 'type' ? type : `${assessmentName} · ${className}`;
      const key = by === 'type' ? label : `${className}:${assessment.id ?? assessmentName}`;
      const entry = groups.get(key) ?? { scores: [], series: label };
      entry.scores.push(Number(assessment.mappedPercentage));
      groups.set(key, entry);
    }
  }
  return [...groups.values()].map(({ scores, series }) => ({
    label: series,
    count: scores.length,
    amount: scores.reduce((sum, score) => sum + score, 0) / scores.length,
    minimum: Math.min(...scores),
    maximum: Math.max(...scores),
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
  });
}

export function ReportComposer({ title: initialTitle, rows: initialRows, scopeLabel, description, scopeOptions = [], insightScope = 'other' }: { title: string; rows: ReportRecord[]; scopeLabel: string; description: string; scopeOptions?: ReportScopeOption[]; insightScope?: 'department' | 'class' | 'faculty' | 'other' }) {
  const [reportScope, setReportScope] = useState('current');
  const [loadedScopeRows, setLoadedScopeRows] = useState<Record<string, ReportRecord[]>>({});
  const [loadingScope, setLoadingScope] = useState('');
  const scopeRequestId = useRef(0);
  const [scopeError, setScopeError] = useState('');
  const activeScopeOption = scopeOptions.find((option) => option.value === reportScope);
  const rawRows = reportScope === 'current' ? initialRows : loadedScopeRows[reportScope] ?? [];
  const activeScopeLabel = activeScopeOption?.label ?? scopeLabel;
  const reportInsightScope = insightScope === 'class' && /all classes/i.test(activeScopeLabel) ? 'faculty' : insightScope;
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
  const [assessmentInterval, setAssessmentInterval] = useState<AssessmentInterval>('day');
  const [showAssessmentIqr, setShowAssessmentIqr] = useState(false);
  const [showAssessmentMinMax, setShowAssessmentMinMax] = useState(true);
  const [separateAssessmentTrends, setSeparateAssessmentTrends] = useState(false);
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
  const hasAssessmentScores = rows.some((row) => Array.isArray(row.assessmentResults) && row.assessmentResults.some((result: ReportRecord) => result?.mappedPercentage != null && Number.isFinite(Number(result.mappedPercentage))));
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
    for (const field of categoricalFields.filter((candidate) => /department|program|subject|year.?level|grade.?level|section|class|course/i.test(candidate))) {
      if (new Set(rows.map((row) => String(row[field] ?? '')).filter(Boolean)).size > 1) options.push(`By:${field}`);
    }
    return options;
  }, [categoricalFields, rows]);
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
    if (hasAssessmentScores) options.push('Assessment performance by type', 'Assessment ranking');
    if (hasStandingPeriods) options.push('Current standing by period');
    if (value && /score|grade|mark|rating|percent/i.test(value)) options.push('Score distribution');
    if (studentNameField && attendanceField && rows.some((row) => typeof row[attendanceField] === 'number')) options.push('Attendance watchlist');
    if (groupBy && visualizationCardinality > 1 && attendanceField) options.push('Attendance by group');
    if (studentNameField && missedField && rows.some((row) => typeof row[missedField] === 'number')) options.push('Missed assessment watchlist');
    return options;
  }, [attendanceField, dateField, fields, groupBy, hasAssessmentResults, hasAssessmentScores, hasStandingPeriods, missedField, riskGroupField, rows, studentNameField, value, visualizationCardinality]);
  const questionOptions: ReportQuestion[] = [
    'Recommended overview',
    ...(groupFieldOptions.some((field) => new Set(rows.map((row) => String(row[field] ?? '')).filter(Boolean)).size > 1) ? ['Compare groups' as const] : []),
    ...(hasAssessmentResults ? ['Assessment scores over time' as const] : []),
    ...(hasAssessmentScores ? ['Assessment performance by type' as const, 'Highest and lowest assessment scores' as const] : []),
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
    if (template === 'Detailed analysis' && hasAssessmentScores) defaults.push('Assessment performance by type', 'Assessment ranking');
    else if (template === 'Detailed analysis' && dateField && value) defaults.push('Trend line');
    if (template === 'Detailed analysis' && value && /score|grade|mark|percent|standing/i.test(value)) defaults.push('Score distribution');
    return defaults.filter((item) => availableVisualizations.includes(item));
  }, [attendanceField, availableVisualizations, dateField, groupBy, hasAssessmentResults, hasAssessmentScores, missedField, riskGroupField, studentNameField, template, value, visualizationCardinality]);
  const visualizationGroupField = activeQuestions.includes('Risk distribution') && riskGroupField ? riskGroupField : groupBy;
  const assessmentBreakdownLabel = assessmentBreakdown.startsWith('By:') ? `by ${labelize(assessmentBreakdown.slice(3))}` : assessmentBreakdown.toLowerCase();
  const activeVisualizations = useMemo<Visualization[]>(() => {
    if (activeQuestions.includes('Recommended overview')) return defaultVisualizations.filter((item) => availableVisualizations.includes(item));
    const selected: Visualization[] = ['KPI summary'];
    if (activeQuestions.includes('Compare groups')) selected.push('Bar chart', ...(availableVisualizations.includes('Pass rate comparison') ? ['Pass rate comparison' as const] : []), ...(availableVisualizations.includes('Score spread by group') ? ['Score spread by group' as const] : []));
    if (activeQuestions.includes('Assessment scores over time')) selected.push('Assessment score range');
    if (activeQuestions.includes('Assessment performance by type')) selected.push('Assessment performance by type');
    if (activeQuestions.includes('Highest and lowest assessment scores')) selected.push('Assessment ranking');
    if (activeQuestions.includes('Current standing over time')) selected.push('Current standing by period');
    if (activeQuestions.includes('Risk distribution')) selected.push('Risk distribution');
    if (activeQuestions.includes('Attendance rates')) {
      if (compareSelected && groupBy && availableVisualizations.includes('Attendance by group')) selected.push('Attendance by group');
      else selected.push('Attendance watchlist');
    }
    if (activeQuestions.includes('Missing assessments')) selected.push('Missed assessment watchlist');
    if (activeQuestions.includes('Score distribution')) selected.push('Score distribution');
    return [...new Set(selected)].filter((item) => availableVisualizations.includes(item));
  }, [activeQuestionKey, attendanceField, availableVisualizations, compareSelected, defaultVisualizations, groupBy, missedField]);
  const visualizationTitle = (kind: Visualization) => kind === 'Donut chart' ? `${labelize(visualizationGroupField)} distribution` : kind === 'Risk distribution' ? 'Students by risk level' : kind === 'Pass rate comparison' ? `Passing rate by ${labelize(groupBy)}` : kind === 'Bar chart' ? `Average ${labelize(value || 'records')} by ${labelize(groupBy)}` : kind === 'Score spread by group' ? `Score range by ${labelize(groupBy)}` : kind === 'Assessment score range' ? 'Assessment scores over time' : kind === 'Current standing by period' ? 'Current standing by grading period' : kind === 'Score distribution' ? `${labelize(value)} distribution` : kind === 'Attendance watchlist' ? 'Lowest student attendance' : kind === 'Attendance by group' ? `Average attendance by ${labelize(groupBy)}` : kind === 'Missed assessment watchlist' ? 'Most missed assessments' : kind === 'Assessment performance by type' ? 'Average score by assessment type' : kind === 'Assessment ranking' ? 'Highest and lowest scoring assessments' : kind;
  const visualizationDescription = (kind: Visualization) => {
    if (kind === 'Donut chart') return `Each segment shows the share of included records in a ${labelize(visualizationGroupField).toLowerCase()} category. The legend reports count and percentage.`;
    if (kind === 'Risk distribution') return 'Counts and percentages of students in each applied risk level, based on the selected report scope.';
    if (kind === 'Pass rate comparison') return `Share of students meeting the applied passing rule in each ${labelize(groupBy).toLowerCase()} group. Groups with no recorded status are excluded.`;
    if (kind === 'Score spread by group') return `Each range shows the middle half of recorded ${labelize(currentStandingField ?? 'standing').toLowerCase()} values, with whiskers for the minimum and maximum. The center mark is the median.`;
    if (kind === 'Bar chart') return `Top ${Math.min(8, selectedGroups.length)} ${labelize(groupBy).toLowerCase()} groups are ranked by ${effectiveAggregation} ${labelize(value || 'record count')}.`;
    if (kind === 'Assessment score range') return `Scores are mapped through each assessment's applied grading rule. The line shows average mapped percentage by ${assessmentInterval}.${showAssessmentMinMax ? ' Whiskers show the lowest and highest recorded percentages where applicable.' : ''}${showAssessmentIqr ? ' Boxes span the middle 50% (Q1–Q3), with the median marked inside.' : ''} Series are grouped ${assessmentBreakdownLabel}${separateAssessmentTrends && assessmentBreakdown !== 'Overall' ? '; each group has a separate graph' : ''}.`;
    if (kind === 'Assessment performance by type') return 'Average mapped assessment scores grouped by the assessment types in the applied grading system. Only submitted, mappable scores are included.';
    if (kind === 'Assessment ranking') return 'Assessments are ranked by average mapped score. The report shows the lowest and highest assessment averages so both support needs and strengths are visible.';
    if (kind === 'Current standing by period') return 'Each point is the average calculated period result for included students, using the applied grading system. Whiskers show the lowest and highest recorded period results; students without that period result are excluded.';
    if (kind === 'Score distribution') return currentStandingField === value ? `Current standing is calculated using the class grading rules and mapped to percentages before placing students in these bands.` : `Scores use equal-width bands based on the observed range of ${labelize(value)}; records without a numeric value are excluded.`;
    if (kind === 'Trend line') return `${labelize(value)} is averaged by ${labelize(dateField || 'date')} to show change over time. This is descriptive, not a forecast.`;
    if (kind === 'Attendance watchlist') return 'Students with the lowest recorded attendance are shown first. Missing attendance records are excluded.';
    if (kind === 'Attendance by group') return `Groups are ranked from lowest to highest average attendance by ${labelize(groupBy).toLowerCase()}. Students without recorded attendance are excluded from each average.`;
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
  const comparisonGroups = useMemo(() => {
    if (!showAdvancedBreakdown || !groupBy || !pivotBy) return selectedGroups;
    const counts = new Map<string, number>();
    for (const row of reportRows) {
      const label = String(row[pivotBy] ?? 'Unspecified');
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const secondaryValues = [...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 12).map(([label]) => label);
    return selectedGroups.slice(0, 12).flatMap(([group, items]) => secondaryValues.flatMap((secondary) => {
      const matching = items.filter((row) => String(row[pivotBy] ?? 'Unspecified') === secondary);
      return matching.length ? [[`${group} · ${secondary}`, matching] as [string, ReportRecord[]]] : [];
    }));
  }, [groupBy, pivotBy, reportRows, selectedGroups, showAdvancedBreakdown]);
  const comparisonTable = useMemo(() => {
    if (!comparisonGroups.length) return [] as string[][];
    const statusField = fields.find((field) => /^(classification|remarks|passstatus)$/i.test(field));
    const riskField = fields.find((field) => /^(risk|risklevel|risklabel|riskcategory|riskseverity)$/i.test(field));
    const metricRows = comparisonGroups.map(([group, items]) => {
      const uniqueStudents = new Set(items.map((row) => String(row.studentId ?? row.student ?? row.id ?? '')).filter(Boolean));
      const scores = currentStandingField ? items.map((row) => row[currentStandingField]).filter((score): score is number => typeof score === 'number' && Number.isFinite(score)).sort((a, b) => a - b) : [];
      const attendance = attendanceField ? items.map((row) => row[attendanceField]).filter((rate): rate is number => typeof rate === 'number' && Number.isFinite(rate)) : [];
      const assessments = items.flatMap((row) => Array.isArray(row.assessmentResults) ? row.assessmentResults : []);
      const submitted = assessments.filter((assessment) => (assessment?.rawScore != null && String(assessment.rawScore).trim() !== '') || (assessment?.mappedPercentage != null && Number.isFinite(Number(assessment.mappedPercentage)))).length;
      const statuses = statusField ? items.map((row) => String(row[statusField] ?? '').trim()).filter(Boolean) : [];
      const passing = statuses.filter((status) => /pass|met/i.test(status) && !/fail|not met/i.test(status)).length;
      const atRisk = riskField ? items.filter((row) => /high|medium|moderate|critical|elevated|at.?risk/i.test(String(row[riskField] ?? ''))).length : 0;
      return {
        group,
        studentCount: uniqueStudents.size || items.length,
        averageScore: scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null,
        medianScore: scores.length ? median(scores) : null,
        averageAttendance: attendance.length ? attendance.reduce((sum, rate) => sum + rate, 0) / attendance.length : null,
        submissionRate: assessments.length ? submitted * 100 / assessments.length : null,
        passingCount: statusField ? passing : null,
        atRiskCount: riskField ? atRisk : null,
      };
    });
    const comparisonDimension = showAdvancedBreakdown && pivotBy ? `${labelize(groupBy || 'Group')} / ${labelize(pivotBy)}` : labelize(groupBy || 'Group');
    const headers = [comparisonDimension, 'Students'];
    if (currentStandingField) headers.push('Average standing', 'Median standing');
    if (attendanceField) headers.push('Average attendance');
    if (reportRows.some((row) => Array.isArray(row.assessmentResults) && row.assessmentResults.length > 0)) headers.push('Submission rate');
    if (statusField) headers.push('Passing count');
    if (riskField) headers.push('At-risk count');
    const body = metricRows.map((row) => {
      const values = [row.group, String(row.studentCount)];
      if (currentStandingField) values.push(row.averageScore == null ? '—' : `${row.averageScore.toFixed(1)}%`, row.medianScore == null ? '—' : `${row.medianScore.toFixed(1)}%`);
      if (attendanceField) values.push(row.averageAttendance == null ? '—' : `${row.averageAttendance.toFixed(1)}%`);
      if (headers.includes('Submission rate')) values.push(row.submissionRate == null ? '—' : `${row.submissionRate.toFixed(1)}%`);
      if (statusField) values.push(String(row.passingCount ?? 0));
      if (riskField) values.push(String(row.atRiskCount ?? 0));
      return values;
    });
    return [headers, ...body];
  }, [attendanceField, comparisonGroups, currentStandingField, fields, groupBy, pivotBy, reportRows, showAdvancedBreakdown]);
  const pivot = useMemo(() => showAdvancedBreakdown && groupBy && pivotBy ? pivotRows(reportRows, groupBy, pivotBy, effectiveAggregation, value, { maxRows: 12, maxColumns: 12 }) : [], [effectiveAggregation, groupBy, pivotBy, reportRows, showAdvancedBreakdown, value]);
  const numericValues = useMemo(() => reportRows.map((row) => row[value]).filter((item): item is number => typeof item === 'number' && Number.isFinite(item)), [reportRows, value]);
  const assessmentSeries = useMemo(() => assessmentScoreSeries(reportRows, assessmentBreakdown, assessmentInterval), [assessmentBreakdown, assessmentInterval, reportRows]);
  const assessmentTypePerformance = useMemo(() => summarizeAssessmentResults(reportRows, 'type').sort((left, right) => right.amount - left.amount), [reportRows]);
  const assessmentRankings = useMemo(() => {
    const ranked = summarizeAssessmentResults(reportRows, 'assessment').sort((left, right) => left.amount - right.amount);
    if (ranked.length <= 8) return ranked;
    return [...ranked.slice(0, 4), ...ranked.slice(-4)];
  }, [reportRows]);
  const standingSeries = useMemo(() => standingPeriodSeries(reportRows, fields), [fields, reportRows]);
  const criticalField = riskGroupField ?? fields.find((field) => /risk|classification|status|severity/i.test(field));
  const criticalRows = useMemo(() => criticalField ? reportRows.filter((row) => criticalWords.test(String(row[criticalField] ?? ''))) : [], [criticalField, reportRows]);
  const completeness = useMemo(() => reportRows.length && fields.length ? Math.round(reportRows.reduce((count, row) => count + fields.filter((field) => row[field] !== null && row[field] !== undefined && row[field] !== '').length, 0) * 100 / (reportRows.length * fields.length)) : 0, [fields, reportRows]);
  const insightItems = useMemo(() => {
    if (!autoInsights || !reportRows.length) return [];
    const typeScores = summarizeAssessmentResults(reportRows, 'type').sort((left, right) => right.amount - left.amount);
    const assessmentScores = summarizeAssessmentResults(reportRows, 'assessment').sort((left, right) => left.amount - right.amount);
    const result: string[] = [];
    if (typeScores.length > 1) result.push(`Average scores were highest for ${typeScores[0].label} (${typeScores[0].amount.toFixed(1)}%) and lowest for ${typeScores[typeScores.length - 1].label} (${typeScores[typeScores.length - 1].amount.toFixed(1)}%).`);
    if (assessmentScores.length > 1) result.push(`Among the assessments shown, the lowest average was ${assessmentScores[0].amount.toFixed(1)}% for ${assessmentScores[0].label}; the highest was ${assessmentScores[assessmentScores.length - 1].amount.toFixed(1)}% for ${assessmentScores[assessmentScores.length - 1].label}.`);
    const riskField = riskGroupField ?? fields.find((field) => /^(risk|risklevel|risklabel|riskcategory|riskseverity)$/i.test(field));
    if (riskField) {
      const riskGroups = [...groupRows(reportRows, riskField)].sort((a, b) => b[1].length - a[1].length);
      const highRisk = riskGroups.filter(([label]) => /high|critical|elevated/i.test(label)).reduce((sum, [, items]) => sum + items.length, 0);
      const hasHigh = riskGroups.some(([label]) => /high/i.test(label));
      const hasCritical = riskGroups.some(([label]) => /critical|elevated/i.test(label));
      if (highRisk) {
        const riskDescription = hasHigh && hasCritical ? 'high or critical risk' : hasCritical ? 'critical risk' : 'high risk';
        result.push(`${highRisk} of ${reportRows.length} students (${Math.round(highRisk * 100 / reportRows.length)}%) are classified as having a ${riskDescription} of failure.`);
      } else if (riskGroups.length) result.push(`The largest recorded risk group is ${riskGroups[0][0]} (${riskGroups[0][1].length} of ${reportRows.length} students).`);
    }
    const programField = fields.find((field) => /^program(name)?$/i.test(field));
    const yearLevelField = fields.find((field) => /^year.?level(label|name)$/i.test(field)) ?? fields.find((field) => /^year.?level$/i.test(field));
    if ((reportInsightScope === 'department' || reportInsightScope === 'faculty') && currentStandingField && (programField || yearLevelField)) {
      const departmentStandings = reportInsightScope === 'department' ? reportRows.map((row) => row[currentStandingField]).filter((score): score is number => typeof score === 'number' && Number.isFinite(score)) : [];
      if (departmentStandings.length) {
        const average = departmentStandings.reduce((sum, score) => sum + score, 0) / departmentStandings.length;
        result.push(`Across the department, current standing averaged ${average.toFixed(1)}% across ${departmentStandings.length} class results.`);
      }
      const summarizeByDimension = (field: string | undefined, dimension: string) => {
        if (!field) return;
        const ranked = [...groupRows(reportRows, field)].map(([rawName, items]) => {
          const name = dimension === 'year level' && /^\d+$/.test(rawName) ? `Year ${rawName}` : rawName;
          const values = items.map((row) => row[currentStandingField]).filter((score): score is number => typeof score === 'number' && Number.isFinite(score));
          return { name, count: values.length, average: values.length ? values.reduce((sum, score) => sum + score, 0) / values.length : null };
        }).filter((item): item is { name: string; count: number; average: number } => item.average !== null).sort((a, b) => b.average - a.average);
        if (ranked.length > 1) {
          const highest = ranked[0]; const lowest = ranked[ranked.length - 1];
          result.push(`By ${dimension}, current standing averaged highest in ${highest.name} (${highest.average.toFixed(1)}%, ${highest.count} results) and lowest in ${lowest.name} (${lowest.average.toFixed(1)}%, ${lowest.count} results).`);
        } else if (ranked.length === 1) {
          result.push(`In ${ranked[0].name}, average current standing was ${ranked[0].average.toFixed(1)}% across ${ranked[0].count} recorded results.`);
        }
      };
      summarizeByDimension(programField, 'program');
      summarizeByDimension(yearLevelField, 'year level');
    }
    if (missedField && studentNameField) {
      const missed = reportRows.filter((row) => typeof row[missedField] === 'number' && Number.isFinite(row[missedField])).sort((a, b) => Number(b[missedField]) - Number(a[missedField]));
      if (missed.length && Number(missed[0][missedField]) > 0) {
        const highest = Number(missed[0][missedField]);
        const names = missed.filter((row) => Number(row[missedField]) === highest).map((row) => String(row[studentNameField] ?? 'Student'));
        result.push(`${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} others` : ''} had the most missing assessments (${highest}).`);
      }
    }
    if (attendanceField) {
      const rates = reportRows.map((row) => row[attendanceField]).filter((rate): rate is number => typeof rate === 'number' && Number.isFinite(rate));
      if (rates.length) {
        const lowest = Math.min(...rates);
        if (lowest < 99.95 && studentNameField) {
          const names = reportRows.filter((row) => row[attendanceField] === lowest).map((row) => String(row[studentNameField] ?? 'Student'));
          result.push(`${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} others` : ''} had the lowest recorded attendance (${lowest.toFixed(1)}%).`);
        } else if (lowest >= 99.95) result.push(`All ${rates.length} recorded attendance rates are 100%.`);
      }
    }
    if (numericValues.length) {
      const avg = aggregateRows(reportRows, 'average', value); const mid = median(numericValues);
      result.push(`The average ${labelize(value)} is ${avg.toFixed(1)}%, while the median is ${mid.toFixed(1)}%.`);
      const range = Math.max(...numericValues) - Math.min(...numericValues);
      // if (range > 0) result.push(`${labelize(value)} ranges from ${Math.min(...numericValues).toFixed(1)} to ${Math.max(...numericValues).toFixed(1)} (spread ${range.toFixed(1)}).`);
    }
    if (selectedGroups.length) {
      const bySize = [...selectedGroups].sort((a, b) => b[1].length - a[1].length);
      if (bySize.length > 1 && !/classification/i.test(groupBy)) result.push(`Largest ${labelize(groupBy).toLowerCase()} group — ${bySize[0][0]} has ${bySize[0][1].length.toLocaleString()} records (${Math.round(bySize[0][1].length * 100 / reportRows.length)}% of this report).`);
      if (value && /standing|grade|score|mark|percent|attendance/i.test(value) && selectedGroups.length > 1) {
        const ranked = selectedGroups.map(([key, items]) => ({ key, amount: aggregateRows(items, 'average', value), count: items.filter((row) => typeof row[value] === 'number' && Number.isFinite(row[value])).length })).filter((row) => row.count).sort((a, b) => b.amount - a.amount);
        if (ranked.length > 1) result.push(`Highest average ${labelize(value).toLowerCase()} is ${ranked[0].key}: ${ranked[0].amount.toFixed(1)} (${ranked[0].count} recorded values).`);
        if (ranked.length > 1) result.push(`Lowest average ${labelize(value).toLowerCase()} is ${ranked[ranked.length - 1].key}: ${ranked[ranked.length - 1].amount.toFixed(1)} (${ranked[ranked.length - 1].count} recorded values).`);
      }
      if (selectedGroups.length > 1 && attendanceField) {
        const rankedAttendance = selectedGroups.map(([key, items]) => ({ key, values: items.map((row) => row[attendanceField]).filter((rate): rate is number => typeof rate === 'number' && Number.isFinite(rate)) })).filter((item) => item.values.length).map((item) => ({ key: item.key, average: item.values.reduce((sum, rate) => sum + rate, 0) / item.values.length, count: item.values.length })).sort((a, b) => b.average - a.average);
        if (rankedAttendance.length > 1) result.push(`Attendance ranges from ${rankedAttendance[rankedAttendance.length - 1].key} (${rankedAttendance[rankedAttendance.length - 1].average.toFixed(1)}%) to ${rankedAttendance[0].key} (${rankedAttendance[0].average.toFixed(1)}%) across the compared ${labelize(groupBy).toLowerCase()} groups.`);
      }
      const statusField = fields.find((field) => /^(classification|remarks|passstatus)$/i.test(field));
      if (selectedGroups.length > 1 && statusField) {
        const passedGroups = selectedGroups.map(([key, items]) => ({ key, count: items.filter((row) => /pass|met/i.test(String(row[statusField] ?? '')) && !/fail|not met/i.test(String(row[statusField] ?? ''))).length })).sort((a, b) => b.count - a.count);
        if (passedGroups.some((group) => group.count > 0)) result.push(`Most students meeting the recorded passing rule — ${passedGroups[0].key}: ${passedGroups[0].count}.`);
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
    if (!concise) return prioritized;
    const scopeInsights = prioritized.filter((line) => /Across the department|By program|By year level/.test(line));
    const otherInsights = prioritized.filter((line) => !scopeInsights.includes(line));
    return [...scopeInsights, ...otherInsights.slice(0, Math.max(0, 7 - scopeInsights.length))];
  }, [effectiveAggregation, activeScopeLabel, attendanceField, autoInsights, completeness, concise, criticalField, criticalRows.length, dateField, fields, groupBy, reportInsightScope, pivot.length, pivotBy, reportRows, selectedGroups, template, value, numericValues]);
  const chartData = useMemo(() => {
    const result: Partial<Record<Visualization, ChartItem[]>> = {};
    if (activeVisualizations.includes('Assessment score range')) result['Assessment score range'] = assessmentSeries;
    if (activeVisualizations.includes('Assessment performance by type')) result['Assessment performance by type'] = assessmentTypePerformance;
    if (activeVisualizations.includes('Assessment ranking')) result['Assessment ranking'] = assessmentRankings;
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
    if (activeVisualizations.includes('Attendance by group') && attendanceField && groupBy) {
      result['Attendance by group'] = selectedGroups.map(([label, items]) => {
        const rates = items.map((row) => row[attendanceField]).filter((rate): rate is number => typeof rate === 'number' && Number.isFinite(rate));
        return rates.length ? { label, count: rates.length, amount: rates.reduce((sum, rate) => sum + rate, 0) / rates.length } : null;
      }).filter((item): item is ChartItem => item !== null).sort((left, right) => left.amount - right.amount).slice(0, 12);
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
  }, [activeVisualizations, assessmentRankings, assessmentSeries, assessmentTypePerformance, attendanceField, classLabelField, currentStandingField, dateField, effectiveAggregation, fields, groupBy, missedField, riskGroupField, selectedGroups, numericValues, reportRows, standingSeries, studentNameField, value]);
  const rawTable = template === 'Data table';
  const summaryTable = (includeSummaryTable || compareSelected) && !rawTable && selectedGroups.length > 0
    ? comparisonTable
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
      const studentCount = new Set(reportRows.map((row) => String(row.studentId ?? row.enrollmentId ?? row.student ?? row.label ?? '')).filter(Boolean)).size;
      const departmentRow = reportRows.find((row) => row.departmentName || row.department);
      const departmentValue = departmentRow?.departmentName ?? departmentRow?.department;
      const departmentFromRows = departmentValue && typeof departmentValue === 'object' ? departmentValue.name ?? departmentValue.label ?? departmentValue.code : departmentValue;
      const reportScopeName = /authorized department/i.test(activeScopeLabel) ? String(departmentFromRows || 'your academic department') : activeScopeLabel;
      const terms = [...new Set(reportRows.map((row) => String(row.academicTerm ?? row.term ?? row.academicYear ?? '').trim()).filter((term) => term && term !== 'undefined' && term !== 'null'))];
      const termPhrase = terms.length === 1 ? ` during ${terms[0]}` : terms.length > 1 ? ` across ${terms.length} academic terms` : '';
      const subjectPhrase = studentCount ? `${studentCount.toLocaleString()} students` : `${reportRows.length.toLocaleString()} records`;
      const reportOverview = [
        reportRows.length
          ? `This report presents performance trends, class comparisons, and key insights into the academic performance of ${subjectPhrase} in ${reportScopeName}${termPhrase}.`
          : `No student records matched the selected filters for ${reportScopeName}. Widen the filters and generate the report again.`,
        ...(activeFilters.length ? [`Included: ${activeFilters.map(({ field, value: filterValue }) => `${labelize(field)} is ${filterValue}`).join('; ')}.`] : []),
        ...(thresholdActive ? [`Class standing filter: ${thresholdMode === 'below' ? 'below' : 'at or above'} ${thresholdNumber}%.`] : []),
        ...(drilldownValue ? [`Showing ${labelize(groupBy).toLowerCase()}: ${drilldownValue}.`] : []),
      ];
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
        ? (() => {
          const ranked = [...assessmentOutcomeRows].sort((left, right) => {
          const leftMean = left.mapped.length ? left.mapped.reduce((sum, item) => sum + item, 0) / left.mapped.length : Infinity;
          const rightMean = right.mapped.length ? right.mapped.reduce((sum, item) => sum + item, 0) / right.mapped.length : Infinity;
          return leftMean - rightMean;
          });
          return ranked.length <= 8 ? ranked : [...ranked.slice(0, 4), ...ranked.slice(-4)];
        })()
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
        const { AlignmentType, Document, HeadingLevel, ImageRun, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } = await import('docx');
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
        const makeFindingCard = (text: string) => new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [new TableRow({ children: [new TableCell({
            shading: { fill: 'F8F5F3' },
            margins: { top: 110, bottom: 45, left: 150, right: 150 },
            children: [new Paragraph({ children: findingSegments(text).map((segment) => new TextRun({ text: segment.text, bold: segment.bold, color: segment.bold ? accentColors[accent] : '263238' })) })],
          })] })],
        });
        const docxVisualizationSections = activeVisualizations.map(async (kind) => {
          const items = chartData[kind] ?? [];
          const heading = new Paragraph({ text: kind === 'KPI summary' ? 'At a glance' : visualizationTitle(kind), heading: HeadingLevel.HEADING_2, spacing: { before: 180, after: 80 } });
          const explanation = includeInterpretations ? [new Paragraph({ text: visualizationDescription(kind) })] : [];
          if (kind === 'KPI summary') return [heading, ...explanation, makeDocxTable([
            ['Measure', 'Result'],
            ['Students or records included', reportRows.length.toLocaleString()],
            ['Average current standing', standingValues.length ? `${(standingValues.reduce((sum, item) => sum + item, 0) / standingValues.length).toFixed(1)}%` : 'Not available'],
            ['Students flagged for follow-up', criticalRows.length.toLocaleString()],
            ['Average recorded attendance', attendanceValues.length ? `${(attendanceValues.reduce((sum, item) => sum + item, 0) / attendanceValues.length).toFixed(1)}%` : 'Not available'],
          ])];
          if (!items.length) {
            const message = kind === 'Missed assessment watchlist' ? 'No students with missing assessment results were found in this scope.' : kind === 'Attendance watchlist' ? 'No attendance values are available in this scope.' : 'No records are available for this visualization in the selected scope.';
            return [heading, ...explanation, new Paragraph({ text: message })];
          }
          const maximum = Math.max(1, ...items.map((item) => item.amount));
          const rowsForTable = kind === 'Assessment score range'
            ? (() => {
              const header = ['Interval / assessment', 'Series', ...(showAssessmentMinMax ? ['Lowest mapped %'] : []), ...(showAssessmentIqr ? ['Q1 %'] : []), 'Median %', 'Average mapped %', ...(showAssessmentIqr ? ['Q3 %'] : []), ...(showAssessmentMinMax ? ['Highest mapped %'] : []), 'Scored students'];
              const percent = (value: number | undefined) => value == null ? '—' : `${value.toFixed(1)}%`;
              return [header, ...items.map((item) => [item.label, item.series ?? 'Overall', ...(showAssessmentMinMax ? [item.rangeSuppressed ? '—' : percent(item.minimum)] : []), ...(showAssessmentIqr ? [item.rangeSuppressed ? '—' : percent(item.lowerQuartile)] : []), percent(item.median), `${item.amount.toFixed(1)}%`, ...(showAssessmentIqr ? [item.rangeSuppressed ? '—' : percent(item.upperQuartile)] : []), ...(showAssessmentMinMax ? [item.rangeSuppressed ? '—' : percent(item.maximum)] : []), String(item.count)])];
            })()
            : kind === 'Current standing by period'
              ? [['Grading period', 'Lowest standing %', 'Average standing %', 'Highest standing %', 'Students with results'], ...items.map((item) => [item.label, `${(item.minimum ?? item.amount).toFixed(1)}%`, `${item.amount.toFixed(1)}%`, `${(item.maximum ?? item.amount).toFixed(1)}%`, String(item.count)])]
            : kind === 'Score spread by group'
              ? [['Group', 'Students', 'Minimum', '25th percentile', 'Median', '75th percentile', 'Maximum'], ...items.map((item) => [item.label, String(item.count), item.minimum?.toFixed(1) ?? '—', item.lowerQuartile?.toFixed(1) ?? '—', item.median?.toFixed(1) ?? '—', item.upperQuartile?.toFixed(1) ?? '—', item.maximum?.toFixed(1) ?? '—'])]
            : kind === 'Attendance by group'
              ? [[labelize(groupBy || 'Group'), 'Students with attendance records', 'Average attendance'], ...items.map((item) => [item.label, String(item.count), `${item.amount.toFixed(1)}%`])]
            : kind === 'Assessment performance by type' || kind === 'Assessment ranking'
              ? [[kind === 'Assessment performance by type' ? 'Assessment type' : 'Assessment', 'Scored results', 'Average mapped %', 'Lowest mapped %', 'Highest mapped %'], ...items.map((item) => [item.label, String(item.count), `${item.amount.toFixed(1)}%`, `${(item.minimum ?? item.amount).toFixed(1)}%`, `${(item.maximum ?? item.amount).toFixed(1)}%`])]
            : [
            ['Category', 'Relative value', 'Count / value'],
            ...items.map((item) => {
              const bar = '█'.repeat(Math.max(1, Math.round(item.amount / maximum * 18)));
              const valueLabel = kind === 'Donut chart' || kind === 'Risk distribution' ? `${item.count} (${reportRows.length ? Math.round(item.count * 100 / reportRows.length) : 0}%)` : kind === 'Pass rate comparison' ? `${item.amount.toFixed(1)}% (${item.count} classified)` : kind === 'Attendance watchlist' ? `${item.amount.toFixed(1)}%` : kind === 'Missed assessment watchlist' ? `${Math.round(item.amount).toLocaleString()} missing` : kind === 'Score distribution' ? `${item.count} students` : item.amount.toFixed(1);
              return [item.label, bar, valueLabel];
            }),
          ];
          if (kind === 'Assessment score range' && separateAssessmentTrends && items.length) {
            const overall = assessmentScoreSeries(reportRows, 'Overall', assessmentInterval).map((item) => ({ ...item, series: 'Overall' }));
            const separatedItems = [...overall, ...items];
            const seriesNames = [...new Set(separatedItems.map((item) => item.series ?? 'Overall'))];
            const observed = separatedItems.flatMap((item) => [item.minimum ?? item.amount, item.maximum ?? item.amount, item.amount]);
            const minimum = Math.min(...observed); const maximum = Math.max(...observed); const padding = Math.max(2, (maximum - minimum) * 0.12);
            const domainMin = Math.floor(Math.max(0, minimum - padding) / 5) * 5; const domainMax = Math.max(domainMin + 5, Math.ceil(Math.min(100, maximum + padding) / 5) * 5);
            const baseColor = accentColors[accent];
            const colorsBySeries = [baseColor, '2E86AB', '539167', 'E6A23C', '8B73B5', 'D66B6B', '64748B'];
            const chartWidth = layout === 'Landscape' ? 800 : 600;
            const chartImages = await Promise.all(seriesNames.map(async (series, index) => {
              const svg = assessmentTrendSvg(separatedItems, series, assessmentInterval, colorsBySeries[index % colorsBySeries.length], domainMin, domainMax, showAssessmentMinMax, showAssessmentIqr);
              const chartHeight = assessmentInterval.startsWith('assessment instance') ? 360 : 300;
              const transformation = { width: chartWidth, height: Math.round(chartHeight * chartWidth / 900) };
              let chartImage;
              if (Platform.OS === 'web') {
                chartImage = new ImageRun({ data: await rasterizeChart(svg, 900, chartHeight), type: 'png', transformation });
              } else {
                chartImage = new ImageRun({ data: `data:image/svg+xml;base64,${toBase64(new TextEncoder().encode(svg))}`, type: 'svg', fallback: { data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nm5kAAAAASUVORK5CYII=', type: 'png' }, transformation });
              }
              return [new Paragraph({ text: series, heading: HeadingLevel.HEADING_3, spacing: { before: 120, after: 60 } }), new Paragraph({ children: [chartImage], spacing: { after: 120 } })];
            }));
            return [heading, ...explanation, ...chartImages.flat()];
          }
          return [heading, ...explanation, makeDocxTable(rowsForTable)];
        });
        const docxVisualizations = (await Promise.all(docxVisualizationSections)).flat();
        const children: (Paragraph | Table)[] = [
          new Paragraph({ children: [new TextRun({ text: title || initialTitle, bold: true, size: 36, color: accentColors[accent] })], heading: HeadingLevel.TITLE, alignment: AlignmentType.LEFT }),
          new Paragraph({ text: `${reportScopeName} · Prepared ${new Date().toLocaleDateString()}`, style: 'Subtitle' }),
          new Paragraph({ text: 'Executive summary', heading: HeadingLevel.HEADING_1, spacing: { before: 180, after: 100 } }),
          ...reportOverview.map((line) => new Paragraph({ text: line })),
          ...(insightItems.length ? [new Paragraph({ text: 'Key findings', heading: HeadingLevel.HEADING_1, spacing: { before: 200, after: 100 } }), ...insightItems.flatMap((line) => [makeFindingCard(line), new Paragraph({ text: '', spacing: { after: 100 } })])] : []),
          ...(docxVisualizations.length ? [new Paragraph({ text: 'Analysis and visualizations', heading: HeadingLevel.HEADING_1, spacing: { before: 220, after: 100 } }), ...docxVisualizations] : []),
          ...(includeGradingContext && schemaSummaryRows.length ? [new Paragraph({ text: 'Applied grading context', heading: HeadingLevel.HEADING_1 }), makeDocxTable([['Class context', 'Grading system / configuration', 'Evaluation criteria'], ...schemaSummaryRows])] : []),
          ...(includeGradingContext && includeFullSchemaDefinitions && appliedSchemas.length ? [new Paragraph({ text: 'Full grading schema definitions', heading: HeadingLevel.HEADING_1 }), ...appliedSchemas.flatMap(({ label, schema }) => [new Paragraph({ text: label, heading: HeadingLevel.HEADING_2 }), new Paragraph({ text: JSON.stringify(schema, null, 2) })])] : []),
          ...(includeGradingContext && assessmentRowsForOutput.length ? [new Paragraph({ text: 'Assessment results by instance', heading: HeadingLevel.HEADING_1 }), ...(concise && assessmentOutcomeRows.length > assessmentRowsForOutput.length ? [new Paragraph({ text: `Showing the four lowest and four highest assessment averages (${assessmentRowsForOutput.length} of ${assessmentOutcomeRows.length} total).` })] : []), makeDocxTable([['Class', 'Assessment', 'Scored records', 'Mean raw score', 'Mean mapped %'], ...assessmentRowsForOutput.map((row) => [row.className, row.name, String(row.records), row.scores.length ? (row.scores.reduce((a, b) => a + b, 0) / row.scores.length).toFixed(1) : '—', row.mapped.length ? `${(row.mapped.reduce((a, b) => a + b, 0) / row.mapped.length).toFixed(1)}%` : '—'])])] : []),
          ...(includeGradingContext && calculatedFieldsForOutput.length ? [new Paragraph({ text: 'Calculated grading components', heading: HeadingLevel.HEADING_1 }), ...(concise && calculatedFieldRows.length > calculatedFieldsForOutput.length ? [new Paragraph({ text: `Showing key period and semester components (${calculatedFieldsForOutput.length} of ${calculatedFieldRows.length})` })] : []), makeDocxTable([['Field', 'Level', 'Records', 'Mean'], ...calculatedFieldsForOutput.map((row) => [row.field, row.type, String(row.count), row.mean == null ? '—' : row.mean.toFixed(1)])])] : []),
          ...(pivot.length && !includeSummaryTable && !compareSelected ? [new Paragraph({ text: `${labelize(groupBy)} × ${labelize(pivotBy)} pivot`, heading: HeadingLevel.HEADING_1 }), new Paragraph({ text: pivot.map((row) => `${row.label}: ${Object.entries(row.values).map(([key, amount]) => `${key} ${Number(amount).toFixed(1)}`).join(', ')}`).join('\n') })] : []),
          ...(tableData.length ? [new Paragraph({ text: rawTable ? 'Full data table' : compareSelected ? 'Group comparison by available measures' : 'Summary table', heading: HeadingLevel.HEADING_1 }), makeDocxTable(tableData)] : []),
        ];
        const blob = await Packer.toBlob(new Document({ sections: [{ properties: { page: { size: layout === 'Landscape' ? { orientation: 'landscape' } : undefined } }, children }] }));
        await download(blob, `${filename(title)}.docx`);
      } else {
        const [{ jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf/dist/jspdf.es.min.js'), import('jspdf-autotable')]);
        const pdf = new jsPDF({ orientation: layout.toLowerCase() as 'portrait' | 'landscape' }); const pageWidth = pdf.internal.pageSize.getWidth(); const pageHeight = pdf.internal.pageSize.getHeight();
        const hex = accentColors[accent]; pdf.setTextColor(parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)); pdf.setFontSize(20);
        const titleLines = pdf.splitTextToSize(title || initialTitle, pageWidth - 28); pdf.text(titleLines, 14, 20); pdf.setTextColor(30, 41, 59);
        pdf.setFontSize(9); const metadata = pdf.splitTextToSize(`${reportScopeName} · Prepared ${new Date().toLocaleDateString()}`, pageWidth - 28); const metadataY = 22 + titleLines.length * 8; pdf.text(metadata, 14, metadataY);
        let y = metadataY + metadata.length * 4 + 2;
        const ensureSpace = (height: number) => { if (y + height > pageHeight - 14) { pdf.addPage(); y = 18; } };
        const writeSectionHeading = (label: string) => { y += 4; ensureSpace(15); pdf.setFontSize(12); pdf.setTextColor(parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)); pdf.text(label, 14, y); y += 8; pdf.setTextColor(30, 41, 59); };
        const writeParagraph = (line: string, bullet = false) => { const wrapped = pdf.splitTextToSize(`${bullet ? '• ' : ''}${line}`, pageWidth - 28); const linesPerPage = Math.max(1, Math.floor((pageHeight - 36) / 5)); for (let start = 0; start < wrapped.length; start += linesPerPage) { const chunk = wrapped.slice(start, start + linesPerPage); const blockHeight = chunk.length * 5 + 2; ensureSpace(blockHeight); pdf.setFontSize(9); pdf.text(chunk, 14, y); y += blockHeight; } };
        const writeFindingCard = (text: string) => {
          const lineWidth = pageWidth - 42;
          const lines: { text: string; bold: boolean; x: number }[][] = [[]];
          let used = 0;
          pdf.setFontSize(9);
          for (const segment of findingSegments(text)) {
            pdf.setFont('helvetica', segment.bold ? 'bold' : 'normal');
            const tokens = segment.text.match(/\s+|\S+/g) ?? [segment.text];
            for (const token of tokens) {
              if (/^\s+$/.test(token)) {
                if (used > 0) used += pdf.getTextWidth(' ') * token.length;
                continue;
              }
              let width = pdf.getTextWidth(token);
              if (used > 0 && used + width > lineWidth) { lines.push([]); used = 0; }
              lines[lines.length - 1].push({ text: token, bold: segment.bold, x: used });
              used += width;
            }
          }
          const cardHeight = lines.length * 5 + 5;
          ensureSpace(cardHeight + 3);
          const cardY = y - 3;
          pdf.setFillColor(249, 247, 245); pdf.roundedRect(14, cardY, pageWidth - 28, cardHeight, 1.5, 1.5, 'F');
          pdf.setFillColor(parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)); pdf.rect(14, cardY, 1.5, cardHeight, 'F');
          lines.forEach((line, lineIndex) => {
            for (const part of line) {
              pdf.setFont('helvetica', part.bold ? 'bold' : 'normal'); pdf.setFontSize(9); pdf.setTextColor(38, 50, 56);
              pdf.text(part.text, 19 + part.x, cardY + 5 + lineIndex * 5);
            }
          });
          y = cardY + cardHeight + 7;
          pdf.setTextColor(30, 41, 59); pdf.setFont('helvetica', 'normal');
        };
        writeSectionHeading('Executive summary');
        for (const line of reportOverview) writeParagraph(line);
        if (insightItems.length) { writeSectionHeading('Key findings'); for (const line of insightItems) writeFindingCard(line); }
        if (activeVisualizations.length) writeSectionHeading('Analysis and visualizations');
        if (pivot.length && !includeSummaryTable && !compareSelected) { writeSectionHeading(`${labelize(groupBy)} × ${labelize(pivotBy)} breakdown`); pdf.setFontSize(8); for (const row of pivot) { ensureSpace(6); pdf.text(`${row.label}: ${Object.entries(row.values).map(([key, amount]) => `${key} ${Number(amount).toFixed(1)}`).join(' | ')}`.slice(0, 180), 14, y); y += 5; } }
        for (const visualization of activeVisualizations) {
          const chartGroups = chartData[visualization] ?? [];
          const maxChartValue = Math.max(1, ...chartGroups.map((item) => item.amount));
          const explanationLines = includeInterpretations ? pdf.splitTextToSize(visualizationDescription(visualization), pageWidth - 28).length : 0;
          const visualHeight = (chartGroups.length === 0 ? 20 : visualization === 'Donut chart' || visualization === 'Risk distribution' ? 96 + chartGroups.length * 7 : visualization === 'KPI summary' ? 42 : visualization === 'Assessment score range' ? (assessmentInterval.startsWith('assessment instance') ? 155 : 111) + new Set(chartGroups.map((item) => item.series ?? 'Overall')).size * 4 : visualization === 'Current standing by period' || visualization === 'Score distribution' ? 88 : visualization === 'Score spread by group' ? 34 + chartGroups.length * 14 : 18 + chartGroups.length * 14) + explanationLines * 4 + 12;
          const minimumSpace = visualHeight;
          ensureSpace(minimumSpace); y += 4; pdf.setFontSize(14); pdf.text(visualization === 'KPI summary' ? 'At a glance' : visualizationTitle(visualization), 14, y); y += 7;
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
            const separateSeries = visualization === 'Assessment score range' && separateAssessmentTrends
              ? [...new Set(chartGroups.map((item) => item.series ?? 'Overall'))]
              : [];
            if (separateSeries.length > 0) {
              const overall = assessmentScoreSeries(reportRows, 'Overall', assessmentInterval).map((item) => ({ ...item, series: 'Overall' }));
              const separatedItems = [...overall, ...chartGroups];
              y = renderAssessmentSeriesPanels({ pdf, items: separatedItems, seriesNames: ['Overall', ...separateSeries], pageWidth, pageHeight, startY: y, interval: assessmentInterval, showMinMax: showAssessmentMinMax, showIqr: showAssessmentIqr });
            } else {
            const left = 28; const right = pageWidth - 14; const top = y + 8; const bottom = y + 56; const plotHeight = bottom - top; const plotWidth = right - left;
            const dates = [...new Set(chartGroups.map((item) => item.dateKey ?? item.label))].sort((a, b) => {
              const aOrder = chartGroups.find((item) => (item.dateKey ?? item.label) === a)?.sortKey ?? a;
              const bOrder = chartGroups.find((item) => (item.dateKey ?? item.label) === b)?.sortKey ?? b;
              return aOrder.localeCompare(bOrder, undefined, { numeric: true, sensitivity: 'base' }) || a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
            });
            const seriesNames = [...new Set(chartGroups.map((item) => item.series ?? 'Overall'))];
            const palette: [number, number, number][] = [rgb as [number, number, number], [46, 134, 171], [83, 145, 103], [230, 162, 60], [139, 115, 181], [214, 107, 107], [100, 116, 139]];
            const observed = chartGroups.flatMap((item) => [item.minimum ?? item.amount, item.maximum ?? item.amount, item.amount]);
            const dataMin = Math.min(...observed); const dataMax = Math.max(...observed); const padding = Math.max(2, (dataMax - dataMin) * 0.12);
            const domainMin = Math.floor(Math.max(0, dataMin - padding) / 5) * 5; const domainMax = Math.max(domainMin + 5, Math.ceil(Math.min(100, dataMax + padding) / 5) * 5);
            const pointX = (index: number) => dates.length <= 1 ? left + plotWidth / 2 : left + index * plotWidth / (dates.length - 1);
            const pointY = (score: number) => bottom - plotHeight * (score - domainMin) / (domainMax - domainMin);
            for (let tick = 0; tick <= 4; tick++) { const score = domainMin + (domainMax - domainMin) * tick / 4; const tickY = pointY(score); pdf.setDrawColor(229, 234, 239); pdf.line(left, tickY, right, tickY); pdf.setFontSize(6); pdf.setTextColor(100, 116, 139); pdf.text(`${score.toFixed(0)}%`, left - 2, tickY + 2, { align: 'right' }); }
            seriesNames.forEach((series, seriesIndex) => {
              const color = palette[seriesIndex % palette.length]; const seriesPoints = chartGroups.filter((item) => (item.series ?? 'Overall') === series).sort((a, b) => (a.sortKey ?? a.dateKey ?? a.label).localeCompare(b.sortKey ?? b.dateKey ?? b.label, undefined, { numeric: true, sensitivity: 'base' }) || (a.dateKey ?? a.label).localeCompare(b.dateKey ?? b.label, undefined, { numeric: true, sensitivity: 'base' }));
              seriesPoints.forEach((item, index) => {
                const x = pointX(dates.indexOf(item.dateKey ?? item.label)); const averageY = pointY(item.amount); const lowY = pointY(item.minimum ?? item.amount); const highY = pointY(item.maximum ?? item.amount);
                pdf.setDrawColor(color[0], color[1], color[2]);
                const suppressRange = visualization === 'Assessment score range' && item.rangeSuppressed === true;
                if (!suppressRange && (visualization !== 'Assessment score range' || showAssessmentMinMax)) { pdf.line(x, highY, x, lowY); pdf.line(x - 1.2, highY, x + 1.2, highY); pdf.line(x - 1.2, lowY, x + 1.2, lowY); }
                if (showAssessmentIqr && visualization === 'Assessment score range' && !suppressRange) {
                  const q1Y = pointY(item.lowerQuartile ?? item.amount); const medianY = pointY(item.median ?? item.amount); const q3Y = pointY(item.upperQuartile ?? item.amount);
                  const boxWidth = Math.max(2.4, Math.min(4, plotWidth / Math.max(1, dates.length) * 0.55));
                  const lightColor = color.map((channel) => Math.round(channel * 0.28 + 255 * 0.72));
                  pdf.setFillColor(lightColor[0], lightColor[1], lightColor[2]); pdf.setDrawColor(color[0], color[1], color[2]);
                  pdf.rect(x - boxWidth / 2, q3Y, boxWidth, Math.max(0.8, q1Y - q3Y), 'FD');
                  pdf.setDrawColor(color[0], color[1], color[2]); pdf.line(x - boxWidth / 2, medianY, x + boxWidth / 2, medianY);
                }
                if (suppressRange) { const medianY = pointY(item.median ?? item.amount); pdf.setDrawColor(color[0], color[1], color[2]); pdf.line(x - 1.8, medianY, x + 1.8, medianY); }
                if (index) { const previous = seriesPoints[index - 1]; pdf.line(pointX(dates.indexOf(previous.dateKey ?? previous.label)), pointY(previous.amount), x, averageY); }
                pdf.setFillColor(color[0], color[1], color[2]); pdf.circle(x, averageY, 1, 'F');
              });
            });
            const instanceAxis = visualization === 'Assessment score range' && assessmentInterval.startsWith('assessment instance');
            const labelStep = Math.max(1, Math.ceil(dates.length / 8));
            let instanceLabelLines = 0;
            dates.forEach((dateKey, index) => { if (instanceAxis || index % labelStep === 0 || index === dates.length - 1) { const point = chartGroups.find((item) => item.dateKey === dateKey); const rawLabel = visualization === 'Current standing by period' ? point?.label ?? dateKey : point?.dateLabel ?? new Date(`${dateKey.slice(0, 10)}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }); pdf.setTextColor(71, 85, 105); if (instanceAxis) { const fontSize = Math.max(4, Math.min(5.5, 70 / dates.length)); const slotWidth = Math.max(4, plotWidth / dates.length - 1); pdf.setFontSize(fontSize); const lines = pdf.splitTextToSize(rawLabel, slotWidth); instanceLabelLines = Math.max(instanceLabelLines, lines.length); pdf.text(lines, pointX(index), bottom + 5, { align: 'center', maxWidth: slotWidth }); } else { const label = rawLabel.length > 18 ? `${rawLabel.slice(0, 17)}…` : rawLabel; const visibleLabels = Math.ceil(dates.length / labelStep); pdf.setFontSize(6); pdf.text(label, pointX(index), bottom + 5, { align: 'center', maxWidth: Math.max(16, plotWidth / visibleLabels - 2) }); } } });
            let legendX = left; let legendY = instanceAxis ? bottom + 8 + instanceLabelLines * 2 : bottom + 13; pdf.setFontSize(6);
            seriesNames.forEach((series, index) => { const color = palette[index % palette.length]; pdf.setFillColor(color[0], color[1], color[2]); pdf.circle(legendX + 1, legendY - 1, 1.2, 'F'); pdf.setTextColor(71, 85, 105); pdf.text(series.slice(0, 28), legendX + 4, legendY, { maxWidth: 54 }); legendX += 58; if (legendX > right - 45) { legendX = left; legendY += 4; } });
            const binaryNote = visualization === 'Assessment score range' && chartGroups.some((item) => item.rangeSuppressed) ? 'Binary assessments show median only' : '';
            const statNote = [binaryNote].filter(Boolean).join(' · ');
            pdf.setTextColor(100, 116, 139); pdf.text(`${statNote ? `${statNote} · ` : ''}Data scale ${domainMin}–${domainMax}%`, left, legendY + 4); y = legendY + 10;
            }
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
            const valueLabel = visualization === 'Missed assessment watchlist' ? `${Math.round(item.amount).toLocaleString()} missing` : `${item.amount.toFixed(1)}${visualization === 'Attendance watchlist' || visualization === 'Attendance by group' || visualization === 'Pass rate comparison' || visualization === 'Assessment performance by type' || visualization === 'Assessment ranking' ? '%' : ''}${visualization === 'Pass rate comparison' ? ` · ${item.count} classified` : visualization === 'Attendance by group' ? ` · ${item.count} recorded` : visualization === 'Assessment performance by type' || visualization === 'Assessment ranking' ? ` · ${item.count} scored` : ''}`;
            const categoryLabel = visualization === 'Trend line' ? `${item.label}: ${valueLabel}` : item.label;
            const labelLines = pdf.splitTextToSize(categoryLabel, 82); pdf.text(labelLines, 14, y);
            const barY = y + Math.max(0, labelLines.length - 1) * 4;
            const barStart = 100; const valueColumnWidth = 34; const maxBarWidth = Math.max(18, pageWidth - barStart - valueColumnWidth - 18); const width = Math.max(2, maxBarWidth * item.amount / maxChartValue); pdf.setFillColor(rgb[0], rgb[1], rgb[2]);
            if (visualization === 'Trend line' && chartGroups.length > 1) { const index = chartGroups.indexOf(item); const graphStart = 100; const graphWidth = Math.max(20, pageWidth - graphStart - 14); const graphX = (pointIndex: number) => graphStart + pointIndex * graphWidth / (chartGroups.length - 1); if (index > 0) { const previous = chartGroups[index - 1]; pdf.line(graphX(index - 1), barY - 2 - 20 * previous.amount / maxChartValue, graphX(index), barY - 2 - 20 * item.amount / maxChartValue); } pdf.circle(graphX(index), barY - 2 - 20 * item.amount / maxChartValue, 1.5, 'F'); }
            else { pdf.rect(barStart, barY - 4, Math.max(2, Math.min(maxBarWidth, width)), 4, 'F'); pdf.setTextColor(51, 65, 85); pdf.setFontSize(8); pdf.text(valueLabel, barStart + Math.min(maxBarWidth, width) + 3, barY, { maxWidth: valueColumnWidth }); }
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
          if (concise && assessmentOutcomeRows.length > assessmentRowsForOutput.length) { pdf.setFontSize(8); pdf.text(`Showing four lowest and four highest mapped averages (${assessmentRowsForOutput.length} of ${assessmentOutcomeRows.length} instances).`, 14, y); y += 5; }
          autoTable(pdf, { startY: y, head: [['Class', 'Assessment', 'Scored', 'Mean raw', 'Mean mapped %']], body: assessmentRowsForOutput.map((row) => [row.className, row.name, String(row.records), row.scores.length ? (row.scores.reduce((a, b) => a + b, 0) / row.scores.length).toFixed(1) : '—', row.mapped.length ? `${(row.mapped.reduce((a, b) => a + b, 0) / row.mapped.length).toFixed(1)}%` : '—']), styles: { fontSize: 7, cellPadding: 2 }, margin: { left: 14, right: 14 } });
          y = (pdf as any).lastAutoTable.finalY + 5;
        }
        if (includeGradingContext && calculatedFieldsForOutput.length) {
          ensureSpace(18); pdf.setFontSize(12); pdf.text('Calculated grading components', 14, y); y += 5;
          if (concise && calculatedFieldRows.length > calculatedFieldsForOutput.length) { pdf.setFontSize(8); pdf.text(`Showing key period and semester components (${calculatedFieldsForOutput.length} of ${calculatedFieldRows.length})`, 14, y); y += 5; }
          autoTable(pdf, { startY: y, head: [['Field', 'Level', 'Records', 'Mean']], body: calculatedFieldsForOutput.map((row) => [row.field, row.type, String(row.count), row.mean == null ? '—' : row.mean.toFixed(1)]), styles: { fontSize: 7, cellPadding: 2 }, margin: { left: 14, right: 14 } });
          y = (pdf as any).lastAutoTable.finalY + 5;
        }
        if (tableData.length) { ensureSpace(16); pdf.setFontSize(14); pdf.text(rawTable ? 'Full data table' : compareSelected ? 'Group comparison by available measures' : 'Summary table', 14, y); autoTable(pdf, { head: [tableData[0]], body: tableData.slice(1), startY: y + 6, styles: { fontSize: rawTable ? 7 : 8 }, headStyles: { fillColor: [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)] }, theme: template === 'Executive summary' ? 'striped' : 'grid' }); }
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
      <Text style={styles.copy}>Create a formatted report from {activeScopeLabel.toUpperCase()} data. Select several questions to combine useful insights. Exports are organized into an overview, key findings, visual analysis, and supporting detail. Only the Data table template includes every matching record.</Text>
      <Text style={styles.label}>Report title</Text><TextInput accessibilityLabel="Report title" value={title} onChangeText={setTitle} style={styles.input} />
      <Text style={styles.sectionHeading}>1. Set up the report</Text>
      <View style={styles.options}>
        {scopeOptions.length ? <Option label="Report scope" value={reportScope} options={['current', ...scopeOptions.map((option) => option.value)]} displayOptions={['This class', ...scopeOptions.map((option) => option.label)]} onChange={(next) => { void chooseReportScope(next); }} /> : null}
        <Option label="Template" value={template} options={['Executive summary', 'Detailed analysis', 'Data table']} onChange={(next) => setTemplate(next as ReportTemplate)} />
        <Option label="Page size" value={layout} options={['Portrait', 'Landscape']} displayOptions={['Standard page', 'Wide page']} onChange={(next) => setLayout(next as typeof layout)} />
        <Option label="Accent style" value={accent} options={Object.keys(accentColors)} onChange={setAccent} />
      </View>
      <Text style={styles.sectionHeading}>2. Choose what to analyze</Text>
      <Text style={styles.copy}>Choose any combination. Templates control report structure; these choices control the analysis and can add several matching visuals.</Text>
      <View style={styles.options}>
        <MultiOption label="Analysis questions" values={activeQuestions} options={questionOptions} onChange={(next) => { setQuestions(next); setDrilldownValue(''); }} />
        {activeQuestions.includes('Assessment scores over time') ? <Option label="Assessment time interval" value={assessmentInterval} options={['day', 'week', 'group', 'assessment instance (logical order)', 'assessment instance (chronological order)']} displayOptions={['Day', 'Week', 'Grading group', 'Assessment instance (logical order)', 'Assessment instance (chronological order)']} onChange={(next) => setAssessmentInterval(next as AssessmentInterval)} /> : null}
        {activeQuestions.includes('Assessment scores over time') && assessmentBreakdownOptions.length > 1 ? <Option label="Assessment trend grouped by" value={assessmentBreakdown} options={assessmentBreakdownOptions} displayOptions={assessmentBreakdownOptions.map((option) => option.startsWith('By:') ? `By ${labelize(option.slice(3))}` : option)} onChange={(next) => setAssessmentBreakdown(next as AssessmentBreakdown)} /> : null}
        {activeQuestions.includes('Assessment scores over time') && assessmentBreakdown !== 'Overall' ? <Toggle label={`Separate one graph per ${assessmentBreakdownLabel}`} value={separateAssessmentTrends} onChange={setSeparateAssessmentTrends} /> : null}
      </View>
      <Text style={styles.sectionHeading}>3. Filter and compare</Text>
      <Text style={styles.copy}>Filters combine together. Available dimensions come from this report’s data. Compare by program, year level, subject, section, or class when available; add a second breakdown or use filters to narrow further.</Text>
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
      {compareSelected ? <Text style={styles.copy}>When included, the comparison table reports each available measure: student count, average and median standing, attendance, submission rate, passing count, and at-risk count.</Text> : null}
      {thresholdActive ? <Text style={styles.copy}>Only groups whose average current standing is {thresholdMode === 'below' ? 'below' : 'at or above'} {thresholdNumber}% are included. Students with no recorded standing are excluded from each class average.</Text> : null}
      {loadingScope ? <Text style={styles.copy}>Loading {activeScopeLabel.toLowerCase()}…</Text> : null}
      {scopeError ? <Text accessibilityRole="alert" style={styles.error}>{scopeError}</Text> : null}
      <Text style={styles.sectionHeading}>4. Choose report content</Text>
      <View style={styles.toggles}>
        {!rawTable ? compareSelected ? <Text style={styles.copy}>The multi-measure comparison table is included for this analysis.</Text> : <Toggle label="Include grouped summary table" value={includeSummaryTable} onChange={setIncludeSummaryTable} /> : <Text style={styles.dumpNote}>Data table template includes all {reportRows.length.toLocaleString()} matching records.</Text>}
        <Toggle label="Include grading summary and assessment results" value={includeGradingContext} onChange={setIncludeGradingContext} />
        {includeGradingContext ? <Toggle label="Include full schema definitions (technical appendix)" value={includeFullSchemaDefinitions} onChange={setIncludeFullSchemaDefinitions} /> : null}
        {activeQuestions.includes('Assessment scores over time') ? <Toggle label="Show minimum and maximum score range" value={showAssessmentMinMax} onChange={setShowAssessmentMinMax} /> : null}
        {activeQuestions.includes('Assessment scores over time') ? <Toggle label="Show interquartile range box (middle 50% of scores)" value={showAssessmentIqr} onChange={setShowAssessmentIqr} /> : null}
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

    {/* <Card style={styles.sourceDataCard}>
      <Text style={styles.heading}>Source data used (temporary)</Text>
      <Text style={styles.copy}>View the source records, applied schemas, analysis settings, and insights used for this report. This temporary data is not added to the PDF or DOCX.</Text>
      <Button label={showSourceData ? 'Hide source data' : 'Show source data'} variant="secondary" onPress={() => setShowSourceData((visible) => !visible)} />
      {showSourceData ? <TextInput accessibilityLabel="Source data used for this report" multiline editable={false} selectTextOnFocus scrollEnabled value={accessedDataText} style={styles.sourceDataBox} /> : null}
    </Card> */}
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
