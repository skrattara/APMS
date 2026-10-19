import { getErrorMessage } from '@/services/errors';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Modal, Platform, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/auth/AuthProvider';
import { AppIcon } from '@/components/Icon';
import { supabase } from '@/services/supabase';
import { Badge, Button, Card, ConfirmDialog, DataTable, DateField, Field, HelpTooltip, MetricCard, PageState, RangeSlider, RefreshIndicator, SelectField, useToast } from '@/components/ui';
import { useAnalyticsFilters } from '@/components/charts/AnalyticsFilters';
import { ReportComposer, type ReportRecord } from '@/components/reports/ReportComposer';
import { VisualizationPanel } from '@/components/charts/VisualizationPanel';
import {
  academicReportCsv, createAcademicAdminClass, loadAcademicWorkspace, loadClassCreationReferences, loadDepartmentClassRequests, loadDepartmentSubjects, loadSubjectRequests,
  applyDepartmentEvaluationCriteriaToClasses, applyPersonalEvaluationCriteriaToClasses, deleteDepartmentEvaluationCriteria, deletePersonalEvaluationCriteria, manageSubject, reviewSubjectRequest, saveDepartmentEvaluationCriteria, savePersonalEvaluationSystem, type AcademicSubject, type AcademicSubjectRequest, type AcademicWorkspace, type SavedEvaluationSystem,
  rejectAcademicAdminClassRequest, type ClassRequestReview, type DepartmentFacultyMember,
} from '@/services/academic';
import { applyGradingSystemToClasses, calculateEnrollmentGrade, deleteGradingSystem, saveGradingSystem, summarizeEnrollmentStanding, type ClassWorkspace } from '@/services/faculty';
import { calculateGradingSystem, calculateTrend, extractValidatedSavedAiFactorValues, IT_GLOBAL_GRADING_SYSTEM, validateGradingSystem, type GradingDefinition } from '@apms/domain';
import { createGradingDefinitionId, GradingSystemBuilderForm } from '@/components/GradingSystemBuilderForm';
import { EvaluationSystemBuilderForm } from '@/components/EvaluationSystemBuilderForm';
import { DEFAULT_EVALUATION_SYSTEM, evaluateStudentPerformanceDetailed, validateEvaluationSystem, type EvaluationDefinition } from '@apms/domain';
import { evaluationRiskOptions, evaluationRiskValue } from '@/services/evaluationRiskOptions';
import { deleteYearLevel, loadYearLevels, saveYearLevel, type YearLevelRecord } from '@/services/admin';
import { Settings as AccountSettings } from '@/screens/AppPortalScreen';
import { colors } from '@/theme/tokens';

function standing(workspace: ClassWorkspace, enrollmentId: string) {
  const summary = summarizeEnrollmentStanding(workspace, enrollmentId);
  return summary.finalGrade ?? summary.p3 ?? summary.effortfulLearning ?? summary.mastery;
}

function attendance(workspace: ClassWorkspace, enrollmentId: string) {
  const values = workspace.attendanceSessions.flatMap((session) => {
    const value = workspace.attendance[`${session.id}:${enrollmentId}`];
    return value ? [value === 'present' || value === 'excused' ? 1 : value === 'late' ? 0.5 : 0] : [];
  });
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length * 100 : null;
}

function gradeFactorValues(workspace: ClassWorkspace, enrollmentId: string) {
  const grading = workspace.criteria?.gradingSystemDefinition ?? workspace.defaultGradingSystem ?? IT_GLOBAL_GRADING_SYSTEM;
  const assessments = workspace.assessments.map((item) => ({ id: item.id, typeId: item.gradingTypeId ?? item.component, score: workspace.categoricalScores[`${enrollmentId}:${item.id}`] ?? workspace.scores[`${enrollmentId}:${item.id}`] ?? null, maximumScore: item.maximumScore, weight: item.instanceWeight ?? undefined, periodId: item.gradingPeriodId, groupId: item.gradingGroupId ?? (item.moduleNumber == null ? null : `m${item.moduleNumber}`) }));
  const calculated = calculateGradingSystem(grading, assessments);
  const values: Record<string, number | null> = {};
  const aggregate = (scores: number[], mode: 'average' | 'highest' | 'lowest') => !scores.length ? null : mode === 'highest' ? Math.max(...scores) : mode === 'lowest' ? Math.min(...scores) : scores.reduce((sum, score) => sum + score, 0) / scores.length;
  const modes = ['average', 'highest', 'lowest'] as const;
  const aliases: Record<string, string> = { start_of_class: 'soc', lets_practice: 'lp', reflection: 'tb', wrap_up_quiz: 'wuq', project_checkin: 'cig', final_project: 'fo' };
  const percentage = (assessment: typeof assessments[number], component: any) => {
    if (assessment.score == null || !(assessment.maximumScore > 0)) return null;
    const scoring = component.assessmentDefinition?.scoring;
    if (scoring?.mode === 'value_mapping') return scoring.mapping.find((item: any) => String(item.value) === String(assessment.score))?.percentage ?? null;
    const score = Number(assessment.score); if (!Number.isFinite(score)) return null;
    let result = score / assessment.maximumScore * 100;
    if (scoring?.mode === 'numeric_mapping') { const mapped = [...scoring.mapping].sort((a: any, b: any) => a.value - b.value).filter((item: any) => score >= item.value).at(-1); if (mapped) result = mapped.percentage; }
    return result;
  };
  for (const component of grading.components) {
    let scores: number[] = [];
    if (component.assessmentDefinition) {
      const typeId = component.assessmentDefinition.typeId;
      scores = assessments.filter((item) => item.typeId === typeId || aliases[item.typeId] === typeId).flatMap((item) => { const value = percentage(item, component); return value == null ? [] : [value]; });
    } else if (component.calculation?.components?.length) {
      scores = component.calculation.components.flatMap((item: any) => { const value = calculated.components[item.componentId]; return value == null ? [] : [value]; });
    } else if (calculated.components[component.id] != null) scores = [calculated.components[component.id]!];
    for (const mode of modes) values[`grading_component:${component.id}:${mode}`] = aggregate(scores, mode);
  }
  for (const group of grading.groups ?? []) {
    const included = new Set<string>([group.id]);
    let changed = true;
    while (changed) { changed = false; for (const child of grading.groups ?? []) if (child.parentGroupId && included.has(child.parentGroupId) && !included.has(child.id)) { included.add(child.id); changed = true; } }
    const rows = assessments.filter((item) => item.groupId && included.has(item.groupId) && item.score != null && item.maximumScore > 0);
    const scores = rows.flatMap((item) => { const value = Number(item.score) / item.maximumScore * 100; return Number.isFinite(value) ? [value] : []; });
    for (const mode of modes) values[`grading_group:${group.id}:${mode}`] = aggregate(scores, mode);
  }
  return values;
}

function riskResult(workspace: ClassWorkspace, enrollmentId: string, definition: EvaluationDefinition = DEFAULT_EVALUATION_SYSTEM, standingSummary = summarizeEnrollmentStanding(workspace, enrollmentId)) {
  const saved = workspace.evaluations[enrollmentId];
  const summary = standingSummary;
  const grading = workspace.criteria?.gradingSystemDefinition ?? workspace.defaultGradingSystem ?? IT_GLOBAL_GRADING_SYSTEM;
  const scoreHistory = workspace.assessments.flatMap((assessment) => {
    const key = `${enrollmentId}:${assessment.id}`;
    const category = workspace.categoricalScores[key];
    if (category != null) {
      const typeId = assessment.gradingTypeId ?? assessment.component;
      const definition = grading.components.find((component: any) => component.assessmentDefinition?.typeId === typeId)?.assessmentDefinition;
      const percentage = definition?.scoring?.mode === 'value_mapping' ? definition.scoring.mapping.find((item: any) => String(item.value) === category)?.percentage : undefined;
      return percentage == null ? [] : [percentage];
    }
    const score = workspace.scores[key];
    return Number.isFinite(score) && assessment.maximumScore > 0 ? [score / assessment.maximumScore * 100] : [];
  });
  const windowFor = (source: EvaluationDefinition['factors'][number]['source']) => definition.factors.find((factor) => factor.source === source)?.windowSize ?? 5;
  const recentScores = scoreHistory.slice(-windowFor('recent_scores'));
  const averageScores = scoreHistory.slice(-windowFor('recent_score_average'));
  const trendScores = scoreHistory.slice(-windowFor('recent_trend'));
  const trend = saved?.trend && saved.trend !== 'unknown' ? saved.trend : null;
  const recentTrend = trendScores.length > 1 ? calculateTrend(trendScores) : null;
  const savedAiFactors = extractValidatedSavedAiFactorValues(definition, saved?.evaluationScores);
  const values = {
    ...gradeFactorValues(workspace, enrollmentId),
    current_standing: summary.finalGrade ?? summary.p3 ?? null, mastery: summary.mastery, attendance: attendance(workspace, enrollmentId),
    attendance_rate: attendance(workspace, enrollmentId), recent_scores: recentScores,
    recent_score_average: averageScores.length ? averageScores.reduce((sum, value) => sum + value, 0) / averageScores.length : null,
    recent_trend: recentTrend, trend, missing_assessment_count: workspace.assessments.filter((assessment) => workspace.scores[`${enrollmentId}:${assessment.id}`] == null && workspace.categoricalScores[`${enrollmentId}:${assessment.id}`] == null).length,
    predicted_standing: saved?.predictedStanding ?? null, risk_probability: saved?.riskProbability ?? null, model_confidence: null,
    ai_risk_level: null,
    prediction_available: saved?.predictedStanding != null,
    prediction_age_hours: saved?.predictionGeneratedAt ? Math.max(0, (Date.now() - new Date(saved.predictionGeneratedAt).getTime()) / 3_600_000) : null,
    ai_factor_count: saved?.factors.length ?? null, data_basis: saved?.dataBasis ?? null,
    ...savedAiFactors,
  };
  return evaluateStudentPerformanceDetailed(definition, values);
}
function risk(workspace: ClassWorkspace, enrollmentId: string, definition: EvaluationDefinition = DEFAULT_EVALUATION_SYSTEM) { return riskResult(workspace, enrollmentId, definition).severity; }
const ADD_SUBJECT_OPTION_ID = '__add_subject__';
const DRAFT_SUBJECT_OPTION_ID = '__draft_subject__';
function useWorkspace(userId: string) {
  const [data, setData] = useState<AcademicWorkspace | null>(null); const [loading, setLoading] = useState(true); const [refreshing, setRefreshing] = useState(false); const [error, setError] = useState(''); const [version, setVersion] = useState(0);
  const hasLoadedWorkspace = useRef(false);
  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  useEffect(() => { let active = true; if (hasLoadedWorkspace.current) setRefreshing(true); else setLoading(true); loadAcademicWorkspace(userId).then((value) => { if (!active) return; setData(value); setError(''); hasLoadedWorkspace.current = true; }).catch((cause) => { if (active && !hasLoadedWorkspace.current) setError(getErrorMessage(cause, 'Unable to load academic records.')); }).finally(() => { if (active) { setLoading(false); setRefreshing(false); } }); return () => { active = false; }; }, [userId, version]);
  useEffect(() => {
    const client = supabase;
    if (!userId || !client) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleRefresh = () => { if (timer) clearTimeout(timer); timer = setTimeout(refresh, 300); };
    const channel = client.channel(`academic-workspace-${userId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    for (const table of ['class_records', 'enrollments', 'assessment_results', 'attendance_records', 'performance_evaluations']) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, scheduleRefresh);
    }
    channel.subscribe();
    const poll = setInterval(refresh, 60_000);
    return () => { clearInterval(poll); if (timer) clearTimeout(timer); void client.removeChannel(channel); };
  }, [refresh, userId]);
  return { data, loading, refreshing, error, refresh };
}

export function AcademicAdminPortalContent({ screen }: { screen: string }) {
  const { user } = useAuth(); const state = useWorkspace(user?.id ?? ''); const toast = useToast();
  if (!user) return <PageState kind="error" title="Session required" message="Sign in again to continue." />;
  if (state.loading) return <PageState kind="loading" title="Loading Academic Admin workspace" message="Retrieving department-scoped monitoring records." />;
  if (state.error || !state.data) return <PageState kind="error" title="Academic data unavailable" message={state.error || 'No department scope is assigned.'} action={<Button label="Retry" onPress={state.refresh} />} />;
  const props = { data: state.data, refresh: state.refresh, userId: user.id, toast };
  return <View style={styles.screen}>
    <RefreshIndicator visible={state.refreshing} />
    {screen === 'overview' ? <Overview {...props} /> : null}
    {screen === 'units' ? <Units {...props} /> : null}
    {screen === 'subjects' ? <Subjects {...props} /> : null}
    {screen === 'classes' ? <Classes {...props} /> : null}
    {screen === 'students' ? <Students {...props} /> : null}
    {screen === 'risk' ? <Risk {...props} /> : null}
    {screen === 'criteria' ? <Criteria {...props} /> : null}
    {screen === 'deadlines' ? <GradeDeadlineRequests {...props} /> : null}
    {screen === 'analytics' ? <Analytics {...props} /> : null}
    {screen === 'settings' ? <AccountSettings role="academic_admin" screen="settings" onMessage={(message) => toast.show(message)} /> : null}
  </View>;
}

type Props = { data: AcademicWorkspace; refresh: () => void; userId: string; toast: ReturnType<typeof useToast> };
function Heading({ title, subtitle, action }: { title: string; subtitle: string; action?: React.ReactNode }) { return <View style={styles.heading}><View style={styles.flex}><Text accessibilityRole="header" style={styles.title}>{title}</Text><Text style={styles.subtitle}>{subtitle}</Text></View>{action}</View>; }
function allStudents(data: AcademicWorkspace) { return data.classes.flatMap((item) => item.workspace.students.map((student) => {
  const definition = item.workspace.evaluationSystem ?? data.evaluationSystem ?? DEFAULT_EVALUATION_SYSTEM;
  const summary = summarizeEnrollmentStanding(item.workspace, student.enrollmentId);
  const evaluation = riskResult(item.workspace, student.enrollmentId, definition, summary);
  const level = definition.levels.find((candidate) => candidate.id === evaluation.matchedLevelId);
  return { item, student, summary, score: summary.finalGrade ?? summary.p3 ?? summary.effortfulLearning ?? summary.mastery, rate: attendance(item.workspace, student.enrollmentId), risk: evaluation.severity, riskValue: evaluationRiskValue(definition, evaluation), riskLevelName: level?.name ?? (evaluation.severity === 'unavailable' ? 'Unavailable' : 'No matching level'), riskLevelColor: level?.color, riskDefinition: definition, evaluationResult: evaluation };
})); }

function Overview({ data }: Props) {
  const rows = allStudents(data); const unique = new Set(rows.map(({ student }) => student.studentId)); const alertRows = rows.filter((row) => row.risk === 'medium' || row.risk === 'high'); const scores = rows.flatMap((row) => row.score == null ? [] : [row.score]);
  const riskDefinitions = [...new Map(data.classes.map((item) => { const definition = item.workspace.evaluationSystem ?? data.evaluationSystem ?? DEFAULT_EVALUATION_SYSTEM; return [definition.id, definition] as const; })).values()];
  const riskOptions = evaluationRiskOptions(riskDefinitions, 'All risks');
  const chartRecords = rows.flatMap((row) => row.score == null ? [] : [{ id: row.student.enrollmentId, label: row.student.name, score: row.score, risk: row.riskValue, classification: summarizeEnrollmentStanding(row.item.workspace, row.student.enrollmentId).remarks, category: `${row.item.code} · ${row.item.section}`, timestamp: row.item.workspace.assessments.at(-1)?.assessmentDate }]);
  const filters = useAnalyticsFilters(chartRecords, riskOptions);
  const visibleIds = new Set(filters.filtered.map((record) => record.id));
  const scoreByClass = data.classes.flatMap((item) => {
    const values = filters.filtered.filter((record) => record.category === `${item.code} · ${item.section}`).map((record) => record.score);
    return values.length ? [{ label: `${item.code} ${item.section}`, value: values.reduce((sum, value) => sum + value, 0) / values.length }] : [];
  });
  const riskCounts = riskOptions.slice(1).map((option) => ({ label: option.label, value: filters.filtered.filter((row) => row.risk === option.value).length }));
  const filteredAlerts = alertRows.filter((row) => visibleIds.has(row.student.enrollmentId));
  const priorityRows = filteredAlerts.slice(0, 15);
  return <><Heading title="Academic Administration Dashboard" subtitle={`Live, department-scoped monitoring for ${data.department?.name ?? 'your assigned academic unit'}. Official grades remain in SWU SIS.`} /><View style={styles.metrics}><MetricCard label="Active classes" value={String(data.classes.length)} /><MetricCard label="Students monitored" value={String(unique.size)} tone="info" /><MetricCard label="At-risk class records" value={String(alertRows.length)} tone={alertRows.length ? 'danger' : 'success'} /><MetricCard label="Average current standing" value={scores.length ? `${(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)}%` : '—'} tone="success" /></View>{filters.controls}<View style={styles.analyticsCharts}><VisualizationPanel title="Average score by class" description="Current provisional standing by department class for matching student records." data={scoreByClass} type="bar" suffix="%" /><VisualizationPanel title="Risk distribution" description="Applied evaluation criteria and their configured risk levels for each class." data={riskCounts} type="pie" /></View><Card><Text style={styles.cardTitle}>Priority monitoring</Text>{priorityRows.length ? <DataTable columns={['Student', 'Class', 'Current', 'Attendance', 'Risk']} rows={priorityRows.map((row) => [row.student.name, `${row.item.code} · ${row.item.section}`, row.score == null ? 'Missing' : `${row.score.toFixed(1)}%`, row.rate == null ? 'No data' : `${row.rate.toFixed(0)}%`, <Badge key={`${row.student.enrollmentId}-risk`} color={row.risk === 'unavailable' ? '#94A3B8' : row.riskLevelColor ?? colors.textMuted}>{row.riskLevelName}</Badge>])} highlightCell={(tableRow, columnIndex) => columnIndex === 2 && priorityRows.find((row) => row.student.name === tableRow[0] && `${row.item.code} · ${row.item.section}` === tableRow[1])?.summary.remarks === 'failing'} /> : <PageState kind="empty" title="No active alerts" message="Alerts appear when department records indicate performance or attendance concern." />}</Card></>;
}

const gradeDeadlinePeriods = [{ key: 'overall', label: 'Overall encoding' }, { key: 'p1', label: 'Period 1' }, { key: 'p2', label: 'Period 2' }, { key: 'p3', label: 'Period 3' }];
function GradeDeadlineRequests({ data, userId, toast }: Props) {
  const [scopeType, setScopeType] = useState<'program' | 'year_level'>('program');
  const [programId, setProgramId] = useState(data.programs[0]?.id ?? '');
  const [yearLevel, setYearLevel] = useState('1');
  const [deadlines, setDeadlines] = useState<Record<string, string>>({ overall: '', p1: '', p2: '', p3: '' });
  const [rationale, setRationale] = useState('');
  const [requests, setRequests] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    if (!supabase) return;
    const [globalResult, requestResult] = await Promise.all([
      supabase.from('grade_encoding_deadlines').select('period_key,deadline_at').eq('scope_type', 'system'),
      supabase.from('grade_encoding_deadline_requests').select('id,scope_type,program_id,year_level,requested_deadlines,rationale,status,review_note,created_at').eq('requested_by', userId).order('created_at', { ascending: false }).limit(100),
    ]);
    const error = globalResult.error ?? requestResult.error;
    if (error) throw error;
    setRequests(requestResult.data ?? []);
    return globalResult.data ?? [];
  }, [userId]);
  const [globalDeadlines, setGlobalDeadlines] = useState<Record<string, string>>({});
  useEffect(() => { void load().then((rows) => { if (rows) setGlobalDeadlines(Object.fromEntries(rows.map((row) => [row.period_key, String(row.deadline_at).slice(0, 10)]))); }).catch((cause) => toast.show(getErrorMessage(cause, 'Grade deadline information could not be loaded.'))); }, [load, toast]);
  const submit = async () => {
    if (!supabase || !data.department) return toast.show('Your department scope is unavailable.');
    const requested = Object.fromEntries(gradeDeadlinePeriods.flatMap(({ key }) => deadlines[key] ? [[key, `${deadlines[key]}T23:59:59+08:00`]] : []));
    if (!Object.keys(requested).length) return toast.show('Enter at least one deadline to request.');
    if (rationale.trim().length < 10) return toast.show('Explain why the deadline change is needed (at least 10 characters).');
    setBusy(true);
    try {
      const { error } = await supabase.from('grade_encoding_deadline_requests').insert({
        department_id: data.department.id,
        requested_by: userId,
        scope_type: scopeType,
        program_id: scopeType === 'program' ? programId : null,
        year_level: scopeType === 'year_level' ? Number(yearLevel) : null,
        requested_deadlines: requested,
        rationale: rationale.trim(),
      });
      if (error) throw error;
      toast.show('Grade deadline request sent for System Admin review.');
      setDeadlines({ overall: '', p1: '', p2: '', p3: '' }); setRationale('');
      await load();
    } catch (cause) { toast.show(getErrorMessage(cause, 'The deadline request could not be submitted.')); }
    finally { setBusy(false); }
  };
  const displayDeadline = (value: unknown) => {
    if (typeof value !== 'string' || !value) return 'Not set';
    const date = value.slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T12:00:00`).toLocaleDateString() : 'Not set';
  };
  return <>
    <Heading title="Grade encoding deadlines" subtitle="Request department-scoped deadline changes. Approved requests override the system-wide deadline for the selected program or year level." />
    <Card style={styles.form}>
      <Text style={styles.cardTitle}>Current system-wide deadlines</Text>
      <View style={styles.deadlineSummaryGrid}>{gradeDeadlinePeriods.map(({ key, label }) => <View key={key} style={styles.deadlineSummaryItem}><Text style={styles.deadlineSummaryLabel}>{label}</Text><Text style={styles.deadlineSummaryValue}>{displayDeadline(globalDeadlines[key])}</Text></View>)}</View>
    </Card>
    <Card style={styles.form}>
      <Text style={styles.cardTitle}>Request a deadline change</Text>
      <Text style={styles.help}>Deadlines are enforced when scores are saved. After an approved deadline passes, scores in that scope cannot be added, edited, cleared, or restored.</Text>
      <View style={styles.formGrid}>
        <SelectField label="Request scope" value={scopeType} options={[{ label: 'Program', value: 'program' }, { label: 'Year level across my department', value: 'year_level' }]} onChange={(value) => setScopeType(value as 'program' | 'year_level')} containerStyle={{ flex: 1, minWidth: 220 }} />
        {scopeType === 'program' ? <SelectField label="Program" value={programId} options={data.programs.map((program) => ({ label: `${program.code} · ${program.name}`, value: program.id }))} onChange={setProgramId} containerStyle={{ flex: 1, minWidth: 220 }} /> : <SelectField label="Year level" value={yearLevel} options={Array.from({ length: 8 }, (_, index) => ({ label: `Year ${index + 1}`, value: String(index + 1) }))} onChange={setYearLevel} containerStyle={{ flex: 1, minWidth: 220 }} />}
      </View>
      <View style={styles.formGrid}>{[...gradeDeadlinePeriods.filter(({ key }) => key !== 'overall'), ...gradeDeadlinePeriods.filter(({ key }) => key === 'overall')].map(({ key, label }) => <DateField key={key} label={`${key === 'overall' ? 'Overall' : label} deadline`} value={deadlines[key]} onChange={(value) => setDeadlines((current) => ({ ...current, [key]: value }))} containerStyle={styles.deadlineDateField} />)}</View>
      <View style={styles.requestReasonField}><Field label="Reason for request" value={rationale} onChangeText={setRationale} multiline numberOfLines={3} maxLength={1000} placeholder="Explain the circumstances and requested change." /></View>
      <View style={[styles.subjectFormActions, styles.deadlineSubmitActions]}><Button label="Submit for review" loading={busy} disabled={busy || (scopeType === 'program' && !programId)} onPress={() => void submit()} /></View>
    </Card>
    <Card style={styles.form}>
      <Text style={styles.cardTitle}>Your requests</Text>
      {requests.length ? <View style={{ gap: 8 }}>{requests.map((request) => {
        const program = data.programs.find((item) => item.id === request.program_id);
        const statusTone = request.status === 'approved' ? 'success' : request.status === 'rejected' ? 'danger' : 'warning';
        return <View key={request.id} style={[styles.savedSystemRow, styles.deadlineRequestRow]}><View style={styles.flex}><View style={styles.deadlineRequestHeader}><Text style={styles.bulkClassName}>{request.scope_type === 'program' ? `${program?.code ?? 'Program'} · ${program?.name ?? ''}` : `Year ${request.year_level} · All programs`}</Text><Badge tone={statusTone}>{request.status}</Badge></View><Text style={styles.help}>Requested {new Date(request.created_at).toLocaleString()}</Text><View style={styles.requestedDeadlinesGrid}>{gradeDeadlinePeriods.map(({ key, label }) => request.requested_deadlines?.[key] ? <View key={key} style={styles.requestedDeadlineItem}><Text style={styles.deadlineSummaryLabel}>{label}</Text><Text style={styles.deadlineSummaryValue}>{displayDeadline(request.requested_deadlines[key])}</Text></View> : null)}</View><View style={styles.requestReasonBox}><Text style={styles.requestReasonLabel}>Reason for request</Text><Text style={styles.help}>{request.rationale}</Text></View>{request.review_note ? <Text style={[styles.help, styles.reviewNote]}>Review note: {request.review_note}</Text> : null}</View></View>;
      })}</View> : <PageState kind="empty" title="No requests yet" message="Submitted deadline changes will appear here for review." />}
    </Card>
  </>;
}

function Units({ data }: Props) {
  const toast = useToast();
  const [programId, setProgramId] = useState(data.programs[0]?.id ?? '');
  const [rows, setRows] = useState<YearLevelRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<YearLevelRecord | null>(null);
  const [level, setLevel] = useState('');
  const [label, setLabel] = useState('');
  const [deleting, setDeleting] = useState<YearLevelRecord | null>(null);
  const selectedProgram = data.programs.find((program) => program.id === programId);
  const refresh = async () => {
    if (!programId) { setRows([]); return; }
    setLoading(true);
    try { setRows(await loadYearLevels(programId)); }
    catch (cause) { toast.show(getErrorMessage(cause, 'Program year levels could not be loaded.')); }
    finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); }, [programId]);
  const open = (row?: YearLevelRecord) => { setEditing(row ?? null); setLevel(row ? String(row.level) : ''); setLabel(row?.label ?? ''); setDialogOpen(true); };
  const save = async () => {
    const numericLevel = Number(level);
    if (!programId || !Number.isInteger(numericLevel) || numericLevel < 1 || numericLevel > 8 || !label.trim()) return;
    setSaving(true);
    try { await saveYearLevel({ programId, level: numericLevel, label: label.trim(), sortOrder: numericLevel }); toast.show('Program year level saved.'); setDialogOpen(false); await refresh(); }
    catch (cause) { toast.show(getErrorMessage(cause, 'Program year level could not be saved.')); }
    finally { setSaving(false); }
  };
  const remove = async () => {
    if (!deleting) return;
    setSaving(true);
    try { await deleteYearLevel(programId, deleting.level); toast.show(`${deleting.label} removed from this program.`); setDeleting(null); await refresh(); }
    catch (cause) { toast.show(getErrorMessage(cause, 'Program year level could not be deleted.')); }
    finally { setSaving(false); }
  };
  const availableLevels = Array.from({ length: 8 }, (_, index) => index + 1).filter((value) => editing ? value === editing.level : !rows.some((row) => row.level === value));
  return <>
    <Heading title="Academic Units" subtitle="View your authorized department and manage year levels for each program." />
    <Card><DataTable columns={['Department', 'Code', 'Access']} rows={data.department ? [[data.department.name, data.department.code, 'Authorized']] : []} /></Card>
    <Card><Text style={styles.cardTitle}>Programs</Text>{data.programs.length ? <DataTable columns={['Program', 'Code', 'Status']} rows={data.programs.map((program) => [program.name, program.code, 'Active'])} /> : <PageState kind="empty" title="No active programs" message="No program records are available in this department." />}</Card>
    <Card>
      <View style={styles.heading}><View style={styles.flex}><Text style={styles.cardTitle}>Program year levels</Text><Text style={styles.help}>Each program has its own year-level options. New programs start with four levels; existing student records are not changed when an option is removed.</Text></View><Button label="Add year level" disabled={!programId || !availableLevels.length} onPress={() => open()} /></View>
      <SelectField label="Program" value={programId} options={data.programs.map((program) => ({ label: `${program.code} · ${program.name}`, value: program.id }))} onChange={setProgramId} />
      {loading ? <PageState kind="loading" title="Loading year levels" message="Retrieving options for the selected program." /> : rows.length ? <DataTable columns={['Level', 'Display label', 'Manage']} rows={rows.map((row) => [String(row.level), row.label, <View key={row.level} style={{ flexDirection: 'row', gap: 8 }}><Button label="Edit" variant="secondary" onPress={() => open(row)} /><Button label="Delete" variant="danger" onPress={() => setDeleting(row)} /></View>])} /> : <PageState kind="empty" title="No year levels configured" message={`Add year levels for ${selectedProgram?.code ?? 'this program'}.`} />}
    </Card>
    <Dialog visible={dialogOpen} title={editing ? 'Edit program year level' : 'Add program year level'} onClose={() => setDialogOpen(false)}>
      <SelectField label="Year level number" value={level} options={availableLevels.map((value) => ({ label: `Year ${value}`, value: String(value) }))} onChange={setLevel} />
      <Field label="Display label" value={label} onChangeText={setLabel} placeholder="e.g. First year" maxLength={80} />
      <Button label={editing ? 'Save year level' : 'Add year level'} loading={saving} disabled={!level || !label.trim()} onPress={() => void save()} />
    </Dialog>
    <ConfirmDialog visible={deleting !== null} title="Delete program year level?" message={`${deleting?.label ?? 'This level'} will no longer appear in this program's new student forms. Existing records remain unchanged.`} confirmLabel="Delete year level" danger pending={saving} onClose={() => { if (!saving) setDeleting(null); }} onConfirm={() => void remove()} />
  </>;
}
function Classes({ data, refresh, toast }: Props) {
  const [references, setReferences] = useState<{ subjects: { id: string; label: string; lectureUnits: number; laboratoryUnits: number }[]; terms: { id: string; label: string }[]; faculty: DepartmentFacultyMember[] }>({ subjects: [], terms: [], faculty: [] });
  const [requests, setRequests] = useState<ClassRequestReview[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedRequest, setSelectedRequest] = useState<ClassRequestReview | null>(null);
  const [subjectId, setSubjectId] = useState('');
  const [pendingSubject, setPendingSubject] = useState<{ code: string; title: string; lectureUnits: number; laboratoryUnits: number } | null>(null);
  const [showAddSubject, setShowAddSubject] = useState(false);
  const [newSubjectCode, setNewSubjectCode] = useState('');
  const [newSubjectTitle, setNewSubjectTitle] = useState('');
  const [newSubjectLectureUnits, setNewSubjectLectureUnits] = useState(3);
  const [newSubjectLaboratoryUnits, setNewSubjectLaboratoryUnits] = useState(0);
  const [termId, setTermId] = useState('');
  const [section, setSection] = useState('');
  const [facultyIds, setFacultyIds] = useState<string[]>([]);
  const [reviewNote, setReviewNote] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try { setRequests(await loadDepartmentClassRequests()); }
    catch (cause) { toast.show(getErrorMessage(cause, 'Could not load class requests.')); }
  }, [toast]);
  useEffect(() => {
    let active = true;
    Promise.all([loadClassCreationReferences(), loadDepartmentClassRequests()]).then(([nextReferences, nextRequests]) => {
      if (!active) return;
      setReferences(nextReferences);
      setRequests(nextRequests);
      setSubjectId(nextReferences.subjects[0]?.id ?? '');
      setTermId(nextReferences.terms[0]?.id ?? '');
    }).catch((cause) => { if (active) toast.show(getErrorMessage(cause, 'Could not load class management data.')); });
    return () => { active = false; };
  }, [toast]);

  const toggleFaculty = (userId: string, selected: string[], update: (value: string[]) => void) => update(selected.includes(userId) ? selected.filter((id) => id !== userId) : [...selected, userId]);
  const addSubject = () => {
    if (newSubjectCode.trim().length < 2 || newSubjectTitle.trim().length < 3) {
      toast.show('Enter a valid subject code and title.');
      return;
    }
    const draft = { code: newSubjectCode.trim().toUpperCase(), title: newSubjectTitle.trim(), lectureUnits: newSubjectLectureUnits, laboratoryUnits: newSubjectLaboratoryUnits };
    setPendingSubject(draft);
    setSubjectId(DRAFT_SUBJECT_OPTION_ID);
    setShowAddSubject(false);
    setNewSubjectCode('');
    setNewSubjectTitle('');
    setNewSubjectLectureUnits(3);
    setNewSubjectLaboratoryUnits(0);
    toast.show('Subject added to this class draft. It will be saved when you create the class.');
  };
  const cancelAddSubject = () => {
    setShowAddSubject(false);
    setNewSubjectCode('');
    setNewSubjectTitle('');
    setNewSubjectLectureUnits(3);
    setNewSubjectLaboratoryUnits(0);
  };
  const createClass = async (request?: ClassRequestReview) => {
    let targetSubject = request?.subjectId ?? subjectId;
    const targetTerm = request?.academicTermId ?? termId;
    const targetSection = request?.section ?? section;
    if (!targetSubject || (targetSubject === DRAFT_SUBJECT_OPTION_ID && !pendingSubject) || !targetTerm || !targetSection.trim() || !facultyIds.length) {
      toast.show('Choose a subject, term, section, and at least one Faculty member.');
      return;
    }
    setBusy(true);
    let newlyCreatedSubjectId: string | null = null;
    try {
      if (!request && targetSubject === DRAFT_SUBJECT_OPTION_ID && pendingSubject) {
        newlyCreatedSubjectId = await manageSubject({ departmentId: data.department!.id, code: pendingSubject.code, title: pendingSubject.title, units: Math.max(1, pendingSubject.lectureUnits + pendingSubject.laboratoryUnits), lectureUnits: pendingSubject.lectureUnits, laboratoryUnits: pendingSubject.laboratoryUnits, status: 'active' });
        targetSubject = newlyCreatedSubjectId;
      }
      await createAcademicAdminClass({ subjectId: targetSubject, termId: targetTerm, section: targetSection, facultyUserIds: facultyIds, requestId: request?.id });
      toast.show(request ? 'Class request approved. The class is created and assigned.' : 'Class created and assigned.');
      setShowCreate(false);
      setSelectedRequest(null);
      setFacultyIds([]);
      setSection('');
      if (newlyCreatedSubjectId) {
        setSubjectId(newlyCreatedSubjectId);
        setPendingSubject(null);
      }
      await Promise.all([reload(), refresh()]);
      if (newlyCreatedSubjectId) void loadClassCreationReferences().then(setReferences).catch(() => undefined);
    } catch (cause) {
      if (newlyCreatedSubjectId) {
        setSubjectId(newlyCreatedSubjectId);
        setPendingSubject(null);
        void loadClassCreationReferences().then(setReferences).catch(() => undefined);
        toast.show(`Subject saved, but the class could not be created: ${getErrorMessage(cause, 'Please try again.')}`);
      } else toast.show(getErrorMessage(cause, 'Class could not be created.'));
    }
    finally { setBusy(false); }
  };
  const rejectRequest = async () => {
    if (!selectedRequest || reviewNote.trim().length < 3) return;
    setBusy(true);
    try {
      await rejectAcademicAdminClassRequest(selectedRequest.id, reviewNote);
      toast.show('Class request rejected.');
      setSelectedRequest(null);
      setReviewNote('');
      await reload();
    } catch (cause) { toast.show(getErrorMessage(cause, 'Class request could not be rejected.')); }
    finally { setBusy(false); }
  };
  const beginReview = (request: ClassRequestReview) => {
    setSelectedRequest(request);
    setReviewNote('');
    setFacultyIds(references.faculty.some((member) => member.userId === request.requestedBy) ? [request.requestedBy] : []);
  };
  const requestRows = requests.filter((request) => request.status === 'pending');
  const reviewedRows = requests.filter((request) => request.status !== 'pending');
  const departmentClassRows = useMemo(() => data.classes.map((item) => {
    const rows = item.workspace.students;
    const values = rows.flatMap((student) => { const value = standing(item.workspace, student.enrollmentId); return value == null ? [] : [value]; });
    return [`${item.code} · ${item.title}`, item.section, item.term, String(item.lectureUnits), String(item.laboratoryUnits), String(rows.length), values.length ? `${(values.reduce((a, b) => a + b, 0) / values.length).toFixed(1)}%` : '—', String(rows.filter((student) => risk(item.workspace, student.enrollmentId) !== 'low').length)];
  }), [data.classes]);
  const facultyPicker = (selected: string[], update: (value: string[]) => void) => (
    <View style={{ gap: 6 }}>
      <Text style={styles.cardTitle}>Assign Faculty (at least one)</Text>
      {references.faculty.length ? references.faculty.map((member) => <Pressable key={member.userId} accessibilityRole="checkbox" accessibilityState={{ checked: selected.includes(member.userId) }} onPress={() => toggleFaculty(member.userId, selected, update)} style={styles.bulkClassRow}>
        <AppIcon name={selected.includes(member.userId) ? 'checkboxChecked' : 'checkbox'} size={20} color={selected.includes(member.userId) ? colors.brand : colors.textMuted} /><View style={styles.flex}><Text style={styles.bulkClassName}>{member.name}</Text><Text style={styles.help}>{member.employeeId}</Text></View>
      </Pressable>) : <Text style={styles.help}>No active Faculty members are available in this department.</Text>}
    </View>
  );

  return <>
    <Heading title="Classes" subtitle="Create department classes, assign at least one Faculty member, and review Faculty class requests." action={<Button label="Create class" disabled={!references.terms.length || !references.faculty.length} onPress={() => { setFacultyIds([]); setShowCreate(true); }} />} />
    <Card style={styles.form}>
      <Text style={styles.cardTitle}>Pending class requests</Text>
      {requestRows.length ? requestRows.map((request) => <View key={request.id} style={styles.savedSystemRow}>
        <View style={{ flex: 1, minWidth: 220 }}><Text style={styles.bulkClassName}>{request.subject} · {request.section}</Text><Text style={styles.help}>{request.term} · Lecture {request.lectureUnits} / Lab {request.laboratoryUnits} units · Requested by {request.requesterName}</Text><Text style={styles.help}>{request.rationale}</Text></View>
        <Button label="Review and assign" variant="secondary" onPress={() => beginReview(request)} />
      </View>) : <PageState kind="empty" title="No pending class requests" message="Faculty requests for new classes will appear here." />}
    </Card>
    {reviewedRows.length ? <Card style={styles.form}><Text style={styles.cardTitle}>Class request history</Text><DataTable columns={['Subject', 'Section', 'Term', 'Faculty requester', 'Status', 'Review note', 'Date']} rows={reviewedRows.map((request) => [request.subject, request.section, request.term, request.requesterName, <Badge key={request.id} tone={request.status === 'approved' ? 'success' : 'danger'}>{request.status.toUpperCase()}</Badge>, request.reviewNote ?? '—', new Date(request.createdAt).toLocaleDateString()])} /></Card> : null}
    <Card style={styles.form}>
      <Text style={styles.cardTitle}>Department classes</Text>
      {data.classes.length ? <DataTable columns={['Subject', 'Section', 'Term', 'Lecture units', 'Laboratory units', 'Students', 'Average', 'At risk']} rows={departmentClassRows} /> : <PageState kind="empty" title="No active classes" message="Create a class or approve a Faculty request to get started." />}
    </Card>
    <Dialog visible={showCreate} title="Create Department Class" onClose={() => { if (!busy) setShowCreate(false); }}>
      <SelectField label="Subject" value={showAddSubject ? ADD_SUBJECT_OPTION_ID : subjectId} options={[...references.subjects.map((item) => ({ label: item.label, value: item.id })), ...(pendingSubject ? [{ label: `${pendingSubject.code} · ${pendingSubject.title} (new)`, value: DRAFT_SUBJECT_OPTION_ID }] : []), { label: '+ Add subject…', value: ADD_SUBJECT_OPTION_ID }]} onChange={(value) => { if (value === ADD_SUBJECT_OPTION_ID) setShowAddSubject(true); else { setShowAddSubject(false); setSubjectId(value); } }} />
      {showAddSubject ? <View style={styles.inlineSubjectForm}>
        <Text style={styles.cardTitle}>New subject</Text>
        <View style={styles.formGrid}>
          <Field containerStyle={styles.newSubjectField} label="Subject code" value={newSubjectCode} onChangeText={setNewSubjectCode} placeholder="e.g. IT 301" maxLength={30} autoCapitalize="characters" />
          <Field containerStyle={styles.newSubjectField} label="Subject title" value={newSubjectTitle} onChangeText={setNewSubjectTitle} placeholder="e.g. Systems Administration" maxLength={160} />
        </View>
        <View style={styles.unitsSliderRow}>
          <View style={styles.unitsSliderCell}><RangeSlider label="Lecture units" value={newSubjectLectureUnits} onChange={setNewSubjectLectureUnits} /></View>
          <View style={styles.unitsSliderCell}><RangeSlider label="Laboratory units" value={newSubjectLaboratoryUnits} onChange={setNewSubjectLaboratoryUnits} /></View>
        </View>
        <View style={styles.subjectFormActions}>
          <Button label="Add subject to class" variant="secondary" disabled={newSubjectCode.trim().length < 2 || newSubjectTitle.trim().length < 3} onPress={addSubject} />
          <Button label="Cancel" variant="ghost" disabled={busy} onPress={cancelAddSubject} />
        </View>
      </View> : null}
      {subjectId === DRAFT_SUBJECT_OPTION_ID && pendingSubject ? <Text style={styles.help}>New subject · Lecture {pendingSubject.lectureUnits} · Laboratory {pendingSubject.laboratoryUnits} units. This subject is saved when the class is created.</Text> : subjectId ? <Text style={styles.help}>Lecture {references.subjects.find((item) => item.id === subjectId)?.lectureUnits ?? 3} · Laboratory {references.subjects.find((item) => item.id === subjectId)?.laboratoryUnits ?? 0} units (set on the subject)</Text> : null}
      <SelectField label="Academic term" value={termId} options={references.terms.map((item) => ({ label: item.label, value: item.id }))} onChange={setTermId} />
      <Field label="Section" value={section} onChangeText={setSection} placeholder="e.g. BSIT-3B" maxLength={80} />
      {facultyPicker(facultyIds, setFacultyIds)}
      <Button label="Create and assign class" loading={busy} disabled={showAddSubject || !subjectId || !termId || !section.trim() || !facultyIds.length} onPress={() => void createClass()} />
    </Dialog>
    <Dialog visible={selectedRequest !== null} title="Review Class Request" onClose={() => { if (!busy) setSelectedRequest(null); }}>
      {selectedRequest ? <View style={{ gap: 10 }}>
        <Text style={styles.bulkClassName}>{selectedRequest.subject} · {selectedRequest.section}</Text>
        <Text style={styles.help}>{selectedRequest.term} · Lecture {selectedRequest.lectureUnits} / Lab {selectedRequest.laboratoryUnits} units</Text>
        <Text style={styles.help}>Requested by {selectedRequest.requesterName}: {selectedRequest.rationale}</Text>
        {facultyPicker(facultyIds, setFacultyIds)}
        <Button label="Approve, create, and assign" loading={busy} disabled={!facultyIds.length} onPress={() => void createClass(selectedRequest)} />
        <Field label="Rejection note" value={reviewNote} onChangeText={setReviewNote} multiline numberOfLines={2} placeholder="Required to reject this request" />
        <Button label="Reject request" variant="danger" loading={busy} disabled={reviewNote.trim().length < 3} onPress={() => void rejectRequest()} />
      </View> : null}
    </Dialog>
  </>;
}
function Students({ data }: Props) { const rows = allStudents(data); return <><Heading title="Student Monitoring" subtitle="Aggregated SWUNEXT provisional standing, mastery, attendance, and risk across authorized classes." /><Card>{rows.length ? <DataTable columns={['Student ID', 'Student', 'Program', 'Class', 'Current', 'Mastery', 'Attendance', 'Risk']} rows={rows.map((row) => { const summary = summarizeEnrollmentStanding(row.item.workspace, row.student.enrollmentId); return [row.student.institutionalId, row.student.name, row.student.program, `${row.item.code} · ${row.item.section}`, row.score == null ? 'Missing' : `${row.score.toFixed(1)}%`, summary.mastery == null ? 'Missing' : `${summary.mastery.toFixed(1)}%`, row.rate == null ? 'No data' : `${row.rate.toFixed(0)}%`, `${row.riskLevelName} (${row.risk})`]; })} /> : <PageState kind="empty" title="No students to monitor" message="Faculty can add students manually or by CSV to populate department monitoring." />}</Card></>; }
function Risk({ data }: Props) { const rows = allStudents(data).filter((row) => row.risk === 'medium' || row.risk === 'high'); return <><Heading title="At-Risk Overview" subtitle="Decision support from SWUNEXT APMS records and saved AI-assisted evaluations; not an official SIS grade determination." /><Card>{rows.length ? <DataTable columns={['Student', 'Class', 'Current', 'Mastery', 'Estimated standing', 'Attendance', 'Trend', 'Risk']} rows={rows.map((row) => { const evaluation = row.item.workspace.evaluations[row.student.enrollmentId]; const summary = summarizeEnrollmentStanding(row.item.workspace, row.student.enrollmentId); return [row.student.name, `${row.item.code} · ${row.item.section}`, row.score == null ? 'Missing' : `${row.score.toFixed(1)}%`, summary.mastery == null ? 'Missing' : `${summary.mastery.toFixed(1)}%`, evaluation?.predictedStanding == null ? 'Unavailable' : `${evaluation.predictedStanding.toFixed(1)}%`, row.rate == null ? 'No data' : `${row.rate.toFixed(0)}%`, evaluation?.trend ?? 'unknown', `${row.riskLevelName} (${row.risk})`]; })} /> : <PageState kind="empty" title="No at-risk records" message="No authorized student records currently meet the configured warning thresholds." />}</Card></>; }
function GradingCriteria({ data, userId, refresh, toast }: Props) {
  const [definition, setDefinition] = useState<GradingDefinition>(IT_GLOBAL_GRADING_SYSTEM);
  const [definitionText, setDefinitionText] = useState(JSON.stringify(IT_GLOBAL_GRADING_SYSTEM, null, 2));
  const [systems, setSystems] = useState<GradingDefinition[]>([IT_GLOBAL_GRADING_SYSTEM]);
  const [systemUpdatedAt, setSystemUpdatedAt] = useState<Record<string, string>>({});
  const [selectedClasses, setSelectedClasses] = useState<string[]>([]);
  const [applySystemId, setApplySystemId] = useState(IT_GLOBAL_GRADING_SYSTEM.id);
  const [busy, setBusy] = useState(false);
  const [validation, setValidation] = useState<string[]>([]);
  const [showJson, setShowJson] = useState(false);
  const [showBulk, setShowBulk] = useState(false);
  const [showBuilder, setShowBuilder] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  useEffect(() => { let active = true; if (!supabase) return; void supabase.from('grading_systems').select('definition,updated_at').order('updated_at', { ascending: false }).then(({ data: rows }) => { if (active && rows) { const saved = rows.map((row: any) => row.definition as GradingDefinition).filter((system) => !!system?.id); setSystemUpdatedAt(Object.fromEntries(rows.flatMap((row: any) => row.definition?.id && row.updated_at ? [[row.definition.id, row.updated_at]] : []))); const globalName = IT_GLOBAL_GRADING_SYSTEM.name.trim().toLocaleLowerCase(); const savedGlobal = saved.find((system) => system.id === IT_GLOBAL_GRADING_SYSTEM.id || system.name?.trim().toLocaleLowerCase() === globalName); const unique = new Map<string, GradingDefinition>(); if (savedGlobal) unique.set(savedGlobal.id, savedGlobal); else unique.set(IT_GLOBAL_GRADING_SYSTEM.id, IT_GLOBAL_GRADING_SYSTEM); for (const system of saved) { const isGlobal = system.id === IT_GLOBAL_GRADING_SYSTEM.id || system.name?.trim().toLocaleLowerCase() === globalName; if (!isGlobal && !unique.has(system.id)) unique.set(system.id, system); } setSystems([...unique.values()].sort((a, b) => a.name.localeCompare(b.name))); } }); return () => { active = false; }; }, []);
  const setEditedDefinition = (value: GradingDefinition) => { setDefinition(value); setDefinitionText(JSON.stringify(value, null, 2)); setValidation([]); };
  const parseDefinition = (): GradingDefinition | null => {
    try {
      const value = JSON.parse(definitionText) as GradingDefinition;
      const checked = validateGradingSystem(value);
      setValidation(checked.errors);
      return checked.valid ? value : null;
    } catch (cause) { setValidation([getErrorMessage(cause, 'Definition must be valid JSON.')]); return null; }
  };
  const editSystem = (system: GradingDefinition) => { const editable = system.id === IT_GLOBAL_GRADING_SYSTEM.id ? copyWithFreshIds(system) : system; if (system.id === IT_GLOBAL_GRADING_SYSTEM.id) editable.name = `${system.name} (Custom)`; setEditedDefinition(editable); setShowJson(false); setShowBuilder(true); };
  const newCustomCopy = () => { const copy = copyWithFreshIds(IT_GLOBAL_GRADING_SYSTEM); copy.name = `${IT_GLOBAL_GRADING_SYSTEM.name} (Custom)`; setEditedDefinition(copy); setShowJson(false); setShowBuilder(true); };
  const openApply = (id: string) => { setApplySystemId(id); setSelectedClasses([]); setShowBulk(true); };
  const save = async () => { const definition = parseDefinition(); if (!definition) return; const normalizedName = definition.name.trim().toLocaleLowerCase(); const duplicate = systems.find((item) => item.id !== definition.id && item.name.trim().toLocaleLowerCase() === normalizedName); if (duplicate) { setValidation([`A grading system named “${duplicate.name}” already exists. Edit that system to create a new version.`]); return; } setBusy(true); try { await saveGradingSystem(userId, definition); setSystems((old) => [...old.filter((item) => item.id !== definition.id), definition].sort((a, b) => a.name.localeCompare(b.name))); setSystemUpdatedAt((old) => ({ ...old, [definition.id]: new Date().toISOString() })); toast.show('Grading system saved.'); setShowBuilder(false); setShowJson(false); } catch (cause) { toast.show(getErrorMessage(cause, 'Could not save grading system.')); } finally { setBusy(false); } };
  const validate = () => { const parsed = parseDefinition(); if (parsed) toast.show('Grading system is valid.'); };
  const apply = async () => { const selectedDefinition = systems.find((item) => item.id === applySystemId); if (!selectedDefinition || !selectedClasses.length) return; setBusy(true); try { const result = await applyGradingSystemToClasses(selectedClasses, userId, selectedDefinition); if (result.failures.length) { const described = result.failures.map((failure) => `${data.classes.find((item) => item.id === failure.classId)?.code ?? failure.classId}: ${failure.message}`); setValidation(described); toast.show(`Applied to ${result.applied.length} of ${selectedClasses.length}. ${described[0]}`); } else { setValidation([]); toast.show(`${selectedDefinition.name} applied to ${result.applied.length} classes.`); setShowBulk(false); } refresh(); } catch (cause) { toast.show(getErrorMessage(cause, 'Could not apply grading system.')); } finally { setBusy(false); } };
  const confirmDelete = async (system: GradingDefinition) => { setBusy(true); try { await deleteGradingSystem(userId, system.id); setSystems((current) => current.filter((item) => item.id !== system.id)); setPendingDeleteId(null); toast.show(`${system.name} deleted.`); } catch (cause) { toast.show(getErrorMessage(cause, 'Could not delete grading system.')); } finally { setBusy(false); } };
  const toggleClass = (id: string) => setSelectedClasses((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const handleJsonChange = (value: string) => { setDefinitionText(value); setValidation([]); try { const parsed = JSON.parse(value); if (validateGradingSystem(parsed).valid) setDefinition(parsed); } catch { /* partial JSON stays editable until validation */ } };
  const appliedRows = data.classes.map((item) => [
    `${item.code} · ${item.section}`,
    item.title,
    item.term || '—',
    item.workspace.criteria?.gradingSystemDefinition?.name ?? item.workspace.defaultGradingSystem?.name ?? IT_GLOBAL_GRADING_SYSTEM.name,
    `${item.workspace.criteria ? `v${item.workspace.criteria.version}` : 'Default'}${systemUpdatedAt[item.workspace.criteria?.gradingSystemId ?? item.workspace.defaultGradingSystem?.id ?? IT_GLOBAL_GRADING_SYSTEM.id] ? ` · Updated ${new Date(systemUpdatedAt[item.workspace.criteria?.gradingSystemId ?? item.workspace.defaultGradingSystem?.id ?? IT_GLOBAL_GRADING_SYSTEM.id]).toLocaleDateString()}` : ''}`,
  ]);
  return <><Heading title="Evaluation Criteria" subtitle="Manage saved grading systems and see which one is active for each class." />
    {!showBuilder ? <>
      <Card style={styles.form}>
        <View style={styles.savedSystemHeader}><View style={{ flex: 1 }}><Text style={styles.cardTitle}>Saved grading systems</Text><Text style={styles.help}>IT Global (SWUNEXT) is the default. Create a custom system or edit a saved one to open the builder.</Text></View><Button label="Create grading system" onPress={newCustomCopy} /></View>
        {systems.length ? systems.map((system) => { const builtIn = system.id === IT_GLOBAL_GRADING_SYSTEM.id; const inUse = data.classes.some((item) => item.workspace.criteria?.gradingSystemId === system.id); const confirming = pendingDeleteId === system.id; const updatedAt = systemUpdatedAt[system.id]; return <View key={system.id} style={styles.savedSystemRow}><View style={{ flex: 1, minWidth: 180 }}><Text style={styles.bulkClassName}>{system.name}</Text><Text style={styles.help}>{builtIn ? 'Built-in default' : `${system.components?.length ?? 0} grading components`}{inUse ? ' · Applied to one or more classes' : ''}{updatedAt ? ` · Updated ${new Date(updatedAt).toLocaleDateString()}` : ''}</Text></View><View style={styles.bulkClassActions}>{confirming ? <><Text style={styles.help}>Delete permanently?</Text><Button label="Confirm delete" variant="danger" loading={busy} onPress={() => void confirmDelete(system)} /><Button label="Cancel" variant="ghost" onPress={() => setPendingDeleteId(null)} /></> : <><Button label="Edit" variant="secondary" onPress={() => editSystem(system)} /><Button label="Apply to classes" variant="secondary" onPress={() => openApply(system.id)} />{!builtIn ? <Button label={inUse ? 'In use' : 'Delete'} variant="danger" disabled={inUse || busy} onPress={() => setPendingDeleteId(system.id)} /> : null}</>}</View></View>; }) : <PageState kind="empty" title="No grading systems saved" message="Create a grading system to get started." action={<Button label="Create grading system" onPress={newCustomCopy} />} />}
      </Card>
      <Card style={styles.form}>
        <Text style={styles.cardTitle}>Grading system by class</Text><Text style={styles.help}>The active grading system and criteria version for classes in your department.</Text>
        {data.classes.length ? <DataTable columns={['Class', 'Subject', 'Term', 'Grading system', 'Version']} rows={appliedRows} /> : <PageState kind="empty" title="No classes available" message="Classes will appear here when they are available in your department." />}
      </Card>
      {showBulk ? <Card style={styles.form}>
        <View style={styles.savedSystemHeader}><View style={{ flex: 1 }}><Text style={styles.cardTitle}>Apply grading system</Text><Text style={styles.help}>Select classes for {systems.find((item) => item.id === applySystemId)?.name ?? 'the selected grading system'}. Applying creates a new criteria version for each class.</Text></View><Button label="Cancel" variant="ghost" onPress={() => setShowBulk(false)} /></View>
        <SelectField label="Grading system to apply" value={applySystemId} options={systems.map((item) => ({ label: item.name, value: item.id }))} onChange={setApplySystemId} />
        <View style={styles.bulkClassActions}><Button label="Select all" variant="secondary" onPress={() => setSelectedClasses(data.classes.map((item) => item.id))} /><Button label="Clear" variant="ghost" onPress={() => setSelectedClasses([])} /></View>
        {data.classes.map((item) => <Pressable key={item.id} accessibilityRole="checkbox" accessibilityState={{ checked: selectedClasses.includes(item.id) }} onPress={() => toggleClass(item.id)} style={styles.bulkClassRow}><AppIcon name={selectedClasses.includes(item.id) ? 'checkboxChecked' : 'checkbox'} size={20} color={selectedClasses.includes(item.id) ? colors.brand : colors.textMuted} /><View style={{ flex: 1 }}><Text style={styles.bulkClassName}>{item.code} · {item.section} · {item.term || 'Term not set'}</Text><Text style={styles.help}>{item.title} · Currently: {item.workspace.criteria?.gradingSystemDefinition?.name ?? item.workspace.defaultGradingSystem?.name ?? IT_GLOBAL_GRADING_SYSTEM.name}</Text></View></Pressable>)}
        {validation.map((message, index) => <Text key={`error-${index}`} style={{ color: colors.danger }}>{message}</Text>)}
        <Button label={`Apply to ${selectedClasses.length} selected classes`} loading={busy} disabled={!selectedClasses.length} onPress={() => void apply()} />
      </Card> : null}
    </> : <>
      <Card style={styles.form}>
        <View style={styles.savedSystemHeader}><View style={{ flex: 1 }}><Text style={styles.cardTitle}>{systems.some((item) => item.id === definition.id) ? 'Edit grading system' : 'New grading system'}</Text><Text style={styles.help}>Configure the system, validate it, then save it to the list.</Text></View><Button label="Back to saved systems" variant="ghost" onPress={() => { setShowBuilder(false); setValidation([]); }} /></View>
        <GradingSystemBuilderForm definition={definition} onChange={setEditedDefinition} onValidate={validate} errors={validation} />
        <View style={styles.bulkClassActions}><Button label="Save grading system" loading={busy} onPress={() => void save()} /><Button label={showJson ? 'Hide JSON editor' : 'Show JSON editor'} variant="secondary" onPress={() => setShowJson((value) => !value)} /></View>
        {showJson ? <Field label="Grading system JSON (Draft 2020-12 schema)" value={definitionText} onChangeText={handleJsonChange} multiline numberOfLines={18} autoCapitalize="none" autoCorrect={false} style={{ minHeight: 340, fontFamily: Platform.OS === 'web' ? 'monospace' : undefined, textAlignVertical: 'top' }} /> : null}
        {validation.map((message, index) => <Text key={`error-${index}`} style={{ color: colors.danger }}>{message}</Text>)}
      </Card>
    </>}
  </>;
}

function Criteria(props: Props) {
  const [section, setSection] = useState<'grading' | 'student'>('grading');
  return <><View style={styles.bulkClassActions}><Button label="Grading systems" variant={section === 'grading' ? 'primary' : 'secondary'} onPress={() => setSection('grading')} /><Button label="Student performance evaluation" variant={section === 'student' ? 'primary' : 'secondary'} onPress={() => setSection('student')} /></View>{section === 'grading' ? <GradingCriteria {...props} /> : <StudentEvaluationCriteria {...props} />}</>;
}

function StudentEvaluationCriteria({ data, userId, refresh, toast }: Props) {
  const [definition, setDefinition] = useState<EvaluationDefinition>(data.evaluationSystem ?? DEFAULT_EVALUATION_SYSTEM);
  const [definitionText, setDefinitionText] = useState(JSON.stringify(data.evaluationSystem ?? DEFAULT_EVALUATION_SYSTEM, null, 2));
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [showJson, setShowJson] = useState(false);
  const [showBuilder, setShowBuilder] = useState(false);
  const [showApply, setShowApply] = useState(false);
  const [applyScope, setApplyScope] = useState<'department' | 'user'>('department');
  const [availability, setAvailability] = useState<'department' | 'user'>('department');
  const [systems, setSystems] = useState<SavedEvaluationSystem[]>(data.evaluationSystems);
  const [applySystemId, setApplySystemId] = useState(data.evaluationSystems[0]?.id ?? '');
  const [selectedClasses, setSelectedClasses] = useState<string[]>([]);
  const [personalDefinition, setPersonalDefinition] = useState<EvaluationDefinition | null>(data.personalEvaluationSystem);
  const [personalMetadata, setPersonalMetadata] = useState(data.personalEvaluationSystemMetadata);
  const [pendingDeleteTarget, setPendingDeleteTarget] = useState<{ scope: 'department'; id: string; name: string } | { scope: 'user'; name: string } | null>(null);
  const [deletingCriteria, setDeletingCriteria] = useState(false);
  useEffect(() => { setPersonalDefinition(data.personalEvaluationSystem); setPersonalMetadata(data.personalEvaluationSystemMetadata); setSystems(data.evaluationSystems); }, [data.personalEvaluationSystem, data.personalEvaluationSystemMetadata, data.evaluationSystems]);
  const updateDefinition = (value: EvaluationDefinition) => { setDefinition(value); setDefinitionText(JSON.stringify(value, null, 2)); setErrors([]); };
  const openBuilder = (value: EvaluationDefinition, scope: 'department' | 'user' = 'department') => { setAvailability(scope); updateDefinition(value); setShowJson(false); setShowApply(false); setShowBuilder(true); };
  const createEvaluationId = () => globalThis.crypto?.randomUUID?.() ?? 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => { const value = Math.floor(Math.random() * 16); return (char === 'x' ? value : (value & 3) | 8).toString(16); });
  const parse = () => { try { const value = JSON.parse(definitionText) as EvaluationDefinition; const validation = validateEvaluationSystem(value); setErrors(validation.errors); return validation.valid ? value : null; } catch (cause) { setErrors([getErrorMessage(cause, 'Definition must be valid JSON.')]); return null; } };
  const changeJson = (value: string) => {
    setDefinitionText(value);
    try {
      const parsed = JSON.parse(value);
      const validation = validateEvaluationSystem(parsed);
      setErrors(validation.errors);
      if (validation.valid) setDefinition(parsed);
    } catch (cause) {
      setErrors([getErrorMessage(cause, 'JSON is incomplete or invalid. Check the definition syntax and try again.')]);
    }
  };
  const save = async () => {
    const value = parse(); if (!value || !data.department) return;
    setSaving(true);
    try {
      if (availability === 'user') {
        const versioned = { ...value, schemaVersion: 2, definitionVersion: Math.max(value.definitionVersion ?? 0, personalDefinition?.definitionVersion ?? 0) + 1 };
        await savePersonalEvaluationSystem(userId, data.department.id, versioned);
        setPersonalDefinition(versioned); setPersonalMetadata({ updatedAt: new Date().toISOString(), updatedBy: 'You' }); updateDefinition(versioned);
        toast.show(`Personal evaluation criteria v${versioned.definitionVersion} saved for you only.`);
      } else {
        const prior = systems.find((system) => system.id === value.id);
        const name = value.name.trim().toLocaleLowerCase();
        const duplicate = systems.find((system) => system.id !== value.id && system.name.trim().toLocaleLowerCase() === name);
        if (duplicate) { setErrors([`An evaluation criteria system named “${duplicate.name}” already exists. Edit that system to create a new version.`]); return; }
        const nextVersion = (prior?.version ?? 0) + 1;
        const versioned = { ...value, schemaVersion: 2, definitionVersion: Math.max(value.definitionVersion ?? 0, nextVersion) };
        const updatedBy = await saveDepartmentEvaluationCriteria(userId, data.department.id, versioned, nextVersion);
        const saved: SavedEvaluationSystem = { id: versioned.id, name: versioned.name, description: versioned.description, definition: versioned, version: nextVersion, updatedAt: new Date().toISOString(), updatedBy };
        setSystems((current) => [...current.filter((system) => system.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name)));
        updateDefinition(versioned);
        toast.show(`Evaluation criteria v${nextVersion} saved. Apply it to selected classes when ready.`);
      }
      setShowBuilder(false); refresh();
    } catch (cause) { toast.show(getErrorMessage(cause, 'Could not save evaluation system.')); }
    finally { setSaving(false); }
  };
  const openApply = (systemId: string) => { setApplyScope('department'); setApplySystemId(systemId); setSelectedClasses([]); setShowApply(true); };
  const openPersonalApply = () => { setApplyScope('user'); setSelectedClasses([]); setShowApply(true); };
  const saveDefaultAndApply = async () => {
    if (!data.department) return;
    setSaving(true);
    try {
      const definition = data.evaluationSystem;
      const version = Math.max(definition.definitionVersion ?? 1, 1);
      const updatedBy = await saveDepartmentEvaluationCriteria(userId, data.department.id, definition, version);
      const saved: SavedEvaluationSystem = { id: definition.id, name: definition.name, description: definition.description, definition, version, updatedAt: new Date().toISOString(), updatedBy };
      setSystems([saved]);
      setApplySystemId(saved.id);
      setSelectedClasses([]);
      setShowApply(true);
    } catch (cause) {
      toast.show(getErrorMessage(cause, 'Could not prepare the default evaluation criteria for class assignment.'));
    } finally { setSaving(false); }
  };
  const toggleClass = (classId: string) => setSelectedClasses((current) => current.includes(classId) ? current.filter((id) => id !== classId) : [...current, classId]);
  const applyToClasses = async () => {
    if (!data.department || !selectedClasses.length || (applyScope === 'department' && !applySystemId) || (applyScope === 'user' && !personalDefinition)) return;
    setSaving(true);
    try {
      const result = applyScope === 'user'
        ? await applyPersonalEvaluationCriteriaToClasses(selectedClasses, userId, data.department.id, personalDefinition!)
        : await applyDepartmentEvaluationCriteriaToClasses(selectedClasses, userId, data.department.id, applySystemId);
      if (result.failures.length) {
        const messages = result.failures.map((failure) => `${data.classes.find((item) => item.id === failure.classId)?.code ?? failure.classId}: ${failure.message}`);
        setErrors(messages); toast.show(`Applied to ${result.applied.length} of ${selectedClasses.length} classes. ${messages[0]}`);
      } else { setErrors([]); setShowApply(false); toast.show(`Evaluation criteria applied to ${result.applied.length} classes.`); }
      refresh();
    } catch (cause) { toast.show(getErrorMessage(cause, 'Could not apply evaluation criteria.')); }
    finally { setSaving(false); }
  };
  const confirmDeleteCriteria = async () => {
    if (!pendingDeleteTarget || !data.department) return;
    setDeletingCriteria(true);
    try {
      if (pendingDeleteTarget.scope === 'user') {
        await deletePersonalEvaluationCriteria(userId, data.department.id);
        setPersonalDefinition(null);
        setPersonalMetadata({ updatedAt: null, updatedBy: null });
        setShowApply(false);
        toast.show('Your private evaluation criteria and its class assignments were deleted.');
      } else {
        await deleteDepartmentEvaluationCriteria(userId, data.department.id, pendingDeleteTarget.id);
        setSystems((current) => current.filter((system) => system.id !== pendingDeleteTarget.id));
        toast.show('Department evaluation criteria deleted.');
      }
      setPendingDeleteTarget(null);
      refresh();
    } catch (cause) {
      toast.show(getErrorMessage(cause, 'Could not delete evaluation criteria.'));
    } finally { setDeletingCriteria(false); }
  };
  const classRows = data.classes.map((item) => {
    const active = item.workspace.evaluationSystem ?? data.evaluationSystem;
    const saved = item.workspace.hasPersonalClassEvaluationSystem ? undefined : systems.find((system) => system.id === active.id);
    const updatedAt = saved?.updatedAt ?? (item.workspace.hasPersonalClassEvaluationSystem && active.id === personalDefinition?.id ? personalMetadata.updatedAt : active.id === data.evaluationSystem.id ? data.evaluationSystemMetadata.updatedAt : null);
    const updatedBy = saved?.updatedBy ?? (item.workspace.hasPersonalClassEvaluationSystem && active.id === personalDefinition?.id ? personalMetadata.updatedBy : active.id === data.evaluationSystem.id ? data.evaluationSystemMetadata.updatedBy : null);
    const updateDetails = [
      updatedAt ? `Last updated: ${new Date(updatedAt).toLocaleString()}` : 'Last updated: Not available',
      updatedBy ? `Updated by: ${updatedBy}` : 'Updated by: Not available',
    ].join('\n');
    return [
      `${item.code} · ${item.section}`,
      item.title,
      item.term || '—',
      <View key={`evaluation-version-${item.id}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Text style={{ color: colors.text }}>{active.name} · v{saved?.version ?? active.definitionVersion ?? 1}</Text>
        <HelpTooltip title="Evaluation criteria update" text={updateDetails} />
      </View>,
      item.workspace.hasPersonalClassEvaluationSystem ? 'Private to you' : item.workspace.hasClassEvaluationSystem ? 'Assigned to class' : 'Department default',
    ];
  });
  return <>
    <Heading title="Student Performance Evaluation" subtitle="Review saved evaluation criteria and the criteria currently used by each class." />
    {!showBuilder ? <>
      <Card style={styles.form}>
        <View style={styles.savedSystemHeader}>
          <View style={{ flex: 1 }}>
            <Text style={styles.cardTitle}>Saved evaluation criteria</Text>
            <Text style={styles.help}>Create criteria for the department or keep a private version for your own use.</Text>
          </View>
          <Button label="Create evaluation criteria" onPress={() => openBuilder({ ...DEFAULT_EVALUATION_SYSTEM, id: createEvaluationId(), name: 'New evaluation criteria', definitionVersion: 1 })} />
        </View>
        {systems.map((system) => {
          const inUse = data.evaluationSystem.id === system.id || data.classes.some((item) => item.workspace.hasClassEvaluationSystem && item.workspace.evaluationSystem?.id === system.id);
          return <View key={system.id} style={styles.savedSystemRow}>
            <View style={{ flex: 1, minWidth: 180 }}><Text style={styles.bulkClassName}>{system.name}</Text><Text style={styles.help}>v{system.version}{system.updatedAt ? ` · Updated ${new Date(system.updatedAt).toLocaleDateString()}` : ''}{system.updatedBy ? ` · By ${system.updatedBy}` : ''}</Text></View>
            <View style={styles.bulkClassActions}><Button label="Edit" variant="secondary" onPress={() => openBuilder(system.definition)} /><Button label="Apply to classes" variant="secondary" onPress={() => openApply(system.id)} /><Button label={inUse ? 'In use' : 'Delete'} variant="danger" disabled={inUse || deletingCriteria} onPress={() => setPendingDeleteTarget({ scope: 'department', id: system.id, name: system.name })} /></View>
          </View>;
        })}
        {!systems.length ? <View style={styles.savedSystemRow}><View style={{ flex: 1 }}><Text style={styles.bulkClassName}>{data.evaluationSystem.name}</Text><Text style={styles.help}>Department default · Built-in</Text></View><View style={styles.bulkClassActions}><Button label="Edit" variant="secondary" onPress={() => openBuilder(data.evaluationSystem)} /><Button label="Apply to classes" variant="secondary" loading={saving} onPress={() => void saveDefaultAndApply()} /></View></View> : null}
        {personalDefinition ? <View style={styles.savedSystemRow}>
          <View style={{ flex: 1, minWidth: 180 }}>
            <Text style={styles.bulkClassName}>{personalDefinition.name}</Text>
            <Text style={styles.help}>v{personalDefinition.definitionVersion ?? 1} · Only available to you{personalMetadata.updatedAt ? ` · Updated ${new Date(personalMetadata.updatedAt).toLocaleDateString()}` : ''}{personalMetadata.updatedBy ? ` · By ${personalMetadata.updatedBy}` : ''}</Text>
          </View>
          <View style={styles.bulkClassActions}><Button label="Edit" variant="secondary" onPress={() => openBuilder(personalDefinition, 'user')} /><Button label="Apply to classes" variant="secondary" onPress={openPersonalApply} /><Button label="Delete" variant="danger" disabled={deletingCriteria} onPress={() => setPendingDeleteTarget({ scope: 'user', name: personalDefinition.name })} /></View>
        </View> : null}
      </Card>
      {showApply ? <Card style={styles.form}>
        <View style={styles.savedSystemHeader}>
          <View style={{ flex: 1 }}>
            <Text style={styles.cardTitle}>Apply {applyScope === 'user' ? 'personal ' : ''}evaluation criteria to classes</Text>
            <Text style={styles.help}>{applyScope === 'user' ? `Select classes for ${personalDefinition?.name ?? 'your personal evaluation criteria'}. These assignments affect your Academic Admin view only.` : `Select classes for ${systems.find((system) => system.id === applySystemId)?.name ?? 'the selected evaluation criteria'}. Applying creates a class-level evaluation criteria assignment for each selected class.`}</Text>
          </View>
          <Button label="Cancel" variant="ghost" onPress={() => setShowApply(false)} />
        </View>
        {applyScope === 'department' ? <SelectField label="Evaluation criteria to apply" value={applySystemId} options={systems.map((system) => ({ label: `${system.name} · v${system.version}`, value: system.id }))} onChange={setApplySystemId} /> : null}
        <View style={styles.bulkClassActions}><Button label="Select all" variant="secondary" onPress={() => setSelectedClasses(data.classes.map((item) => item.id))} /><Button label="Clear" variant="ghost" onPress={() => setSelectedClasses([])} /></View>
        {data.classes.length ? data.classes.map((item) => <Pressable key={item.id} accessibilityRole="checkbox" accessibilityState={{ checked: selectedClasses.includes(item.id) }} onPress={() => toggleClass(item.id)} style={styles.bulkClassRow}><AppIcon name={selectedClasses.includes(item.id) ? 'checkboxChecked' : 'checkbox'} size={20} color={selectedClasses.includes(item.id) ? colors.brand : colors.textMuted} /><View style={{ flex: 1 }}><Text style={styles.bulkClassName}>{item.code} · {item.section} · {item.term || 'Term not set'}</Text><Text style={styles.help}>{item.title} · Currently: {item.workspace.evaluationSystem?.name ?? data.evaluationSystem.name}</Text></View></Pressable>) : <PageState kind="empty" title="No classes available" message="There are no department classes to apply criteria to." />}
        {errors.map((message, index) => <Text key={`apply-error-${index}`} style={{ color: colors.danger }}>{message}</Text>)}
        <Button label={`Apply to ${selectedClasses.length} selected classes`} loading={saving} disabled={!selectedClasses.length || (applyScope === 'department' && !applySystemId) || (applyScope === 'user' && !personalDefinition)} onPress={() => void applyToClasses()} />
      </Card> : null}
      <Card style={styles.form}>
        <Text style={styles.cardTitle}>Evaluation criteria by class</Text>
        <Text style={styles.help}>Class assignments override the department default. Classes without an explicit assignment continue to use the department criteria.</Text>
        {data.classes.length ? <DataTable columns={['Class', 'Subject', 'Term', 'Evaluation criteria · Version', 'Scope']} rows={classRows} /> : <PageState kind="empty" title="No classes available" message="Classes will appear here when they are available in your department." />}
      </Card>
    </> : <Card style={styles.form}>
      <View style={styles.savedSystemHeader}>
        <View style={{ flex: 1 }}>
          <Text style={styles.cardTitle}>Evaluation criteria builder</Text>
          <Text style={styles.help}>{availability === 'department' ? 'Save this criteria in the department library, then apply it to selected classes.' : 'Save this private definition, then apply it to classes for your Academic Admin view. Faculty and other admins continue to use their own criteria.'}</Text>
        </View>
        <Button label="Back to saved criteria" variant="ghost" onPress={() => { setShowBuilder(false); setErrors([]); }} />
      </View>
      <Text style={styles.help}>The defaults classify students as high risk when any factor is below 70%, or medium risk when any factor is below 80%. AI risk probability is a heuristic; predictions remain advisory and may be unavailable.</Text>
      <SelectField label="Availability" value={availability} options={[{ label: 'Entire department', value: 'department', helpText: 'Shared criteria can be applied by Academic Admins to department classes.' }, { label: 'Only me', value: 'user', helpText: 'Apply private criteria to classes for your Academic Admin view only.' }]} onChange={(value) => { const scope = value as 'department' | 'user'; setAvailability(scope); updateDefinition(scope === 'user' ? personalDefinition ?? DEFAULT_EVALUATION_SYSTEM : data.evaluationSystem); setShowApply(false); }} helpText="Choose who can use this evaluation criteria. Availability is stored separately from the evaluation schema." />
      <EvaluationSystemBuilderForm definition={definition} onChange={updateDefinition} gradingSystems={data.classes.map((item) => item.workspace.criteria?.gradingSystemDefinition ?? item.workspace.defaultGradingSystem ?? IT_GLOBAL_GRADING_SYSTEM)} />
      <View style={styles.bulkClassActions}>
        <Button label={availability === 'department' ? 'Save evaluation criteria' : 'Save for me only'} loading={saving} onPress={() => void save()} />
        <Button label={showJson ? 'Hide JSON editor' : 'Edit JSON schema'} variant="secondary" onPress={() => setShowJson((value) => !value)} />
      </View>
      {showJson ? <Field label="Evaluation system JSON (Draft 2020-12 schema)" value={definitionText} onChangeText={changeJson} multiline numberOfLines={16} autoCapitalize="none" autoCorrect={false} style={{ minHeight: 300, fontFamily: Platform.OS === 'web' ? 'monospace' : undefined, textAlignVertical: 'top' }} /> : null}
      {errors.map((message, index) => <Text key={`evaluation-error-${index}`} style={{ color: colors.danger }}>{message}</Text>)}
    </Card>}
    <ConfirmDialog
      visible={pendingDeleteTarget != null}
      title={`Delete ${pendingDeleteTarget?.scope === 'user' ? 'private' : 'department'} evaluation criteria?`}
      message={pendingDeleteTarget?.scope === 'user'
        ? `Delete “${pendingDeleteTarget.name}” and remove its private assignments from all of your classes? Faculty and other admins will continue to use their own criteria.`
        : `Delete “${pendingDeleteTarget?.name}”? Criteria assigned to classes or set as the department default must be unassigned before deletion.`}
      confirmLabel="Delete criteria"
      danger
      pending={deletingCriteria}
      onClose={() => { if (!deletingCriteria) setPendingDeleteTarget(null); }}
      onConfirm={() => void confirmDeleteCriteria()}
    />
  </>;
}

function copyWithFreshIds(source: GradingDefinition): GradingDefinition {
  const copy = JSON.parse(JSON.stringify(source)) as GradingDefinition;
  const systemId = createGradingDefinitionId();
  const typeIds = new Map((copy.assessmentTypes ?? []).map((item: any) => [item.id, createGradingDefinitionId()]));
  const periodIds = new Map((copy.periods ?? []).map((item: any) => [item.id, createGradingDefinitionId()]));
  const groupTypeIds = new Map((copy.groupTypes ?? []).map((item: any) => [item.id, createGradingDefinitionId()]));
  const groupIds = new Map((copy.groups ?? []).map((item: any) => [item.id, createGradingDefinitionId()]));
  const componentIds = new Map(copy.components.map((item: any) => [item.id, createGradingDefinitionId()]));
  for (const item of copy.assessmentTypes ?? []) item.id = typeIds.get(item.id);
  for (const item of copy.periods ?? []) { item.id = periodIds.get(item.id); item.groupIds = (item.groupIds ?? []).map((id: string) => groupIds.get(id)); }
  for (const item of copy.groupTypes ?? []) item.id = groupTypeIds.get(item.id);
  for (const item of copy.groups ?? []) { item.id = groupIds.get(item.id); item.typeId = groupTypeIds.get(item.typeId); if (item.parentGroupId) item.parentGroupId = groupIds.get(item.parentGroupId); }
  for (const component of copy.components as any[]) {
    const oldComponentId = component.id;
    component.id = componentIds.get(oldComponentId);
    if (component.assessmentDefinition) component.assessmentDefinition.typeId = typeIds.get(component.assessmentDefinition.typeId);
    if (component.assessmentDefinition?.count?.scope?.groupTypeId) component.assessmentDefinition.count.scope.groupTypeId = groupTypeIds.get(component.assessmentDefinition.count.scope.groupTypeId);
    const calculation = component.calculation;
    for (const ref of calculation?.components ?? []) { ref.componentId = componentIds.get(ref.componentId); if (ref.periodId) ref.periodId = periodIds.get(ref.periodId); }
    for (const rule of calculation?.rules ?? []) {
      if (rule.when?.componentId) rule.when.componentId = componentIds.get(rule.when.componentId);
      for (const ref of rule.override?.components ?? []) { ref.componentId = componentIds.get(ref.componentId); if (ref.periodId) ref.periodId = periodIds.get(ref.periodId); }
    }
  }
  copy.id = systemId;
  copy.calculationRootComponentId = componentIds.get(copy.calculationRootComponentId) as string;
  if (copy.periodCalculation?.groupTypeId) copy.periodCalculation.groupTypeId = groupTypeIds.get(copy.periodCalculation.groupTypeId);
  if (copy.periodCalculation?.finalPeriodId) copy.periodCalculation.finalPeriodId = periodIds.get(copy.periodCalculation.finalPeriodId);
  for (const formula of copy.periodCalculation?.periods ?? []) {
    formula.periodId = periodIds.get(formula.periodId) as string;
    for (const ref of formula.components) if (ref.periodId) ref.periodId = periodIds.get(ref.periodId) as string;
  }
  if (copy.finalResult.source === 'component') copy.finalResult.componentId = componentIds.get(copy.finalResult.componentId) as string;
  else copy.finalResult.periodId = periodIds.get(copy.finalResult.periodId) as string;
  return copy;
}

function Analytics({ data, toast }: Props) {
  const rows = useMemo(() => allStudents(data), [data]);
  const riskDefinitions = [...new Map(data.classes.map((item) => { const definition = item.workspace.evaluationSystem ?? data.evaluationSystem ?? DEFAULT_EVALUATION_SYSTEM; return [definition.id, definition] as const; })).values()];
  const riskOptions = evaluationRiskOptions(riskDefinitions, 'All risks');
  const records = useMemo(() => rows.flatMap((row) => {
    const summary = row.summary;
    const score = row.score;
    if (score == null) return [];
    const workspace = row.item.workspace;
    const enrollmentId = row.student.enrollmentId;
    const gradingSystem = workspace.criteria?.gradingSystemDefinition ?? workspace.defaultGradingSystem ?? IT_GLOBAL_GRADING_SYSTEM;
    const evaluationDefinition = workspace.evaluationSystem ?? data.evaluationSystem ?? DEFAULT_EVALUATION_SYSTEM;
    const calculated = calculateEnrollmentGrade(workspace, enrollmentId);
    const prediction = workspace.evaluations[enrollmentId] ?? null;
    const assessmentResults = workspace.assessments.map((assessment) => {
      const typeId = assessment.gradingTypeId ?? assessment.component;
      const rawScore = workspace.scores[`${enrollmentId}:${assessment.id}`] ?? workspace.categoricalScores[`${enrollmentId}:${assessment.id}`] ?? null;
      const scoring = gradingSystem.components.find((component: any) => component.assessmentDefinition?.typeId === typeId)?.assessmentDefinition?.scoring;
      let mappedPercentage: number | null = null;
      if (rawScore != null && scoring?.mode === 'value_mapping') mappedPercentage = scoring.mapping.find((entry: any) => String(entry.value) === String(rawScore))?.percentage ?? null;
      else if (rawScore != null && assessment.maximumScore > 0) {
        const numeric = Number(rawScore);
        if (Number.isFinite(numeric)) {
          mappedPercentage = numeric / assessment.maximumScore * 100;
          if (scoring?.mode === 'numeric_mapping') {
            const mapped = [...scoring.mapping].sort((left: any, right: any) => left.value - right.value).filter((entry: any) => numeric >= entry.value).at(-1);
            if (mapped) mappedPercentage = mapped.percentage;
          }
        }
      }
      return { id: assessment.id, name: assessment.title, date: assessment.assessmentDate, gradingTypeId: typeId, gradingPeriodId: assessment.gradingPeriodId ?? null, gradingGroupId: assessment.gradingGroupId ?? null, rawScore, maximumScore: assessment.maximumScore, mappedPercentage };
    });
    const classLabel = `${row.item.code} · ${row.item.section}`;
    return [{ id: enrollmentId, label: row.student.name, student: row.student.name, studentId: row.student.institutionalId, score: calculated.finalGrade ?? score, currentStanding: calculated.finalGrade ?? score, finalGrade: calculated.finalGrade, pointGrade: calculated.pointGrade, risk: row.riskValue, riskLevel: row.riskLevelName, classification: summary.remarks, category: classLabel, class: classLabel, classId: row.item.id, subject: row.item.title, term: row.item.term, yearLevel: row.student.yearLevel, program: row.student.program, timestamp: workspace.assessments.at(-1)?.assessmentDate, gradingSystemSchema: gradingSystem, appliedGradingSystem: workspace.criteria ?? null, assessmentResults, calculatedGrade: calculated, evaluationCriteriaSchema: evaluationDefinition, evaluationResult: row.evaluationResult, performancePrediction: prediction, predictedStanding: prediction?.predictedStanding ?? null, riskProbability: prediction?.riskProbability ?? null, ...Object.fromEntries(Object.entries(calculated.periods ?? {}).map(([key, value]) => [`gradingPeriod_${key}`, value])), ...Object.fromEntries(Object.entries(calculated.components ?? {}).map(([key, value]) => [`gradingComponent_${key}`, value])), ...Object.fromEntries(Object.entries(calculated.groups ?? {}).map(([key, value]) => [`gradingGroup_${key}`, value])) }];
  }), [data, rows]);
  const filters = useAnalyticsFilters(records, riskOptions);
  const visible = filters.filtered;
  const reportRowsForItems = useCallback((items: ReportRecord[]) => {
    const sources = new Map(rows.map((row) => [row.student.enrollmentId, row] as const));
    return items.map((item) => {
    const source = sources.get(item.id);
    const workspace = source?.item.workspace;
    const enrollmentId = source?.student.enrollmentId;
    const missingAssessments = workspace && enrollmentId ? workspace.assessments.filter((assessment) => workspace.scores[`${enrollmentId}:${assessment.id}`] == null && workspace.categoricalScores[`${enrollmentId}:${assessment.id}`] == null).length : null;
    const riskLevel = source?.riskLevelName ?? 'Unavailable';
    return { ...item, student: item.label, risk: riskLevel, riskLevel, attendanceRate: source?.rate ?? null, missingAssessments };
    });
  }, [rows]);
  const reportRecords = useMemo(() => reportRowsForItems(records), [records, reportRowsForItems]);
  const exportCsv = async () => { const csv = academicReportCsv(data); if (Platform.OS === 'web') { const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'apms-academic-monitoring-report.csv'; anchor.click(); URL.revokeObjectURL(url); } else await Share.share({ message: csv }); toast.show('Department monitoring report exported.'); };
  const medium = visible.filter((row) => row.risk === 'medium').length;
  const high = visible.filter((row) => row.risk === 'high').length;
  const riskDistribution = riskOptions.slice(1).map((option) => ({ label: option.label, value: visible.filter((row) => row.risk === option.value).length }));
  const passing = visible.filter((row) => row.classification === 'passing').length;
  const failing = visible.filter((row) => row.classification === 'failing').length;
  const scoreByClass = data.classes.map((item) => {
    const classLabel = `${item.code} · ${item.section}`;
    const scores = visible.filter((row) => row.category === classLabel).map((row) => row.score);
    return scores.length ? { label: `${item.code} ${item.section}`, value: scores.reduce((sum, score) => sum + score, 0) / scores.length } : null;
  }).filter((item): item is { label: string; value: number } => item !== null);
  const passFail = [{ label: 'Meets rule', value: passing }, { label: 'Below or incomplete', value: visible.length - passing }];
  const scoreDistribution = visible.map((item) => ({ label: item.label, value: item.score, kind: 'continuous' as const }));
  return <><Heading title="Analytics & Reports" subtitle="Department-level analytics and provisional SWUNEXT passing-rule comparisons from authorized APMS data." action={<Button label="Export CSV" onPress={() => void exportCsv()} />} />{filters.controls}<View style={styles.metrics}><MetricCard label="Passing rule met" value={String(passing)} tone="success" /><MetricCard label="Below rule" value={String(failing)} tone="warning" /><MetricCard label="Medium risk" value={String(medium)} tone="warning" /><MetricCard label="High risk" value={String(high)} tone="danger" /></View><View style={styles.analyticsCharts}><VisualizationPanel title="Average score by class" description="Mean current SWUNEXT standing by class for records matching these filters." data={scoreByClass} type="bar" suffix="%" /><VisualizationPanel title="Student score histogram" description="Filtered continuous scores grouped into score bands." data={scoreDistribution} type="histogram" suffix="%" /><VisualizationPanel title="Risk distribution" description="Configured risk levels from the criteria applied to each class." data={riskDistribution} type="pie" /><VisualizationPanel title="Passing rule status" description="Binary pass and not yet passing classification." data={passFail} type="pie" /></View><Card><Text style={styles.cardTitle}>Class and subject comparison</Text>{data.classes.length ? <DataTable columns={['Subject / class', 'Recorded standings', 'Passing rule met', 'Below rule', 'Risk alerts']} rows={data.classes.map((item) => { const classRows = allStudents({ ...data, classes: [item] }); const classSummaries = classRows.map((row) => summarizeEnrollmentStanding(row.item.workspace, row.student.enrollmentId)); const classRecorded = classSummaries.filter((summary) => summary.finalGrade != null || summary.p3 != null || summary.mastery != null); return [`${item.code} · ${item.section}`, String(classRecorded.length), String(classSummaries.filter((summary) => summary.remarks === 'passing').length), String(classSummaries.filter((summary) => summary.remarks === 'failing').length), String(classRows.filter((row) => row.risk !== 'low').length)]; })} /> : <PageState kind="empty" title="No comparison data" message="Class comparisons appear after monitoring classes are created." />}<Text style={styles.help}>Passing requires both 80% final grade and 80% mastery. P1/P2 remain running views. These are provisional APMS indicators, not official SIS pass/fail grades. Filters apply to KPI and chart summaries; the CSV includes all authorized department rows.</Text></Card><ReportComposer title="Academic Department Monitoring Report" scopeLabel="Authorized department" description="Department-level provisional standing, passing-rule, and configured risk summaries. These are monitoring indicators, not official SIS grades." rows={reportRecords} /></>;
}
function Subjects({ data, toast, refresh }: Props) {
  const [subjects, setSubjects] = useState<AcademicSubject[]>([]);
  const [requests, setRequests] = useState<AcademicSubjectRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [editingSubject, setEditingSubject] = useState<AcademicSubject | null>(null);
  const [selectedRequest, setSelectedRequest] = useState<AcademicSubjectRequest | null>(null);
  const [code, setCode] = useState('');
  const [title, setTitle] = useState('');
  const [lectureUnits, setLectureUnits] = useState(3);
  const [laboratoryUnits, setLaboratoryUnits] = useState(0);
  const [status, setStatus] = useState<'active' | 'inactive'>('active');
  const [reviewDecision, setReviewDecision] = useState<'approved' | 'rejected'>('approved');
  const [reviewNote, setReviewNote] = useState('');
  const [saving, setSaving] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [subs, reqs] = await Promise.all([
        loadDepartmentSubjects(),
        loadSubjectRequests(),
      ]);
      setSubjects(subs);
      setRequests(reqs);
    } catch (err) {
      toast.show(getErrorMessage(err, 'Unable to load subjects'));
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const openCreate = () => {
    setEditingSubject(null);
    setCode('');
    setTitle('');
    setLectureUnits(3);
    setLaboratoryUnits(0);
    setStatus('active');
    setOpen(true);
  };

  const openEdit = (sub: AcademicSubject) => {
    setEditingSubject(sub);
    setCode(sub.code);
    setTitle(sub.title);
    setLectureUnits(sub.lectureUnits);
    setLaboratoryUnits(sub.laboratoryUnits);
    setStatus(sub.status);
    setOpen(true);
  };

  const openReviewModal = (req: AcademicSubjectRequest) => {
    setSelectedRequest(req);
    setReviewDecision('approved');
    setReviewNote('');
    setReviewOpen(true);
  };

  const saveSubject = async () => {
    if (!data.department?.id) return;
    if (!code.trim() || !title.trim()) {
      toast.show('Code and title are required.');
      return;
    }
    setSaving(true);
    try {
      await manageSubject({
        subjectId: editingSubject?.id,
        departmentId: data.department.id,
        code: code.trim(),
        title: title.trim(),
        units: Math.max(1, lectureUnits + laboratoryUnits),
        lectureUnits,
        laboratoryUnits,
        status,
      });
      setOpen(false);
      toast.show(editingSubject ? 'Subject updated.' : 'Subject created.');
      await loadData();
      refresh();
    } catch (cause) {
      toast.show(getErrorMessage(cause, 'Failed to save subject.'));
    } finally {
      setSaving(false);
    }
  };

  const submitReview = async () => {
    if (!selectedRequest) return;
    if (reviewDecision === 'rejected' && !reviewNote.trim()) {
      toast.show('A review note is required when rejecting a request.');
      return;
    }
    setSaving(true);
    try {
      await reviewSubjectRequest(selectedRequest.id, reviewDecision, reviewNote);
      setReviewOpen(false);
      toast.show(`Subject request ${reviewDecision}.`);
      await loadData();
      refresh();
    } catch (cause) {
      toast.show(getErrorMessage(cause, 'Failed to review request.'));
    } finally {
      setSaving(false);
    }
  };

  const pendingRequests = requests.filter((r) => r.status === 'pending');
  const pastRequests = requests.filter((r) => r.status !== 'pending');

  return (
    <>
      <Heading
        title="Department Subjects & Requests"
        subtitle={`Manage active subjects and review faculty subject requests for ${data.department?.name ?? 'your department'}.`}
        action={<Button label="Create subject" onPress={openCreate} />}
      />

      <View style={styles.metrics}>
        <MetricCard label="Total subjects" value={String(subjects.length)} />
        <MetricCard label="Active subjects" value={String(subjects.filter((s) => s.status === 'active').length)} tone="success" />
        <MetricCard label="Pending requests" value={String(pendingRequests.length)} tone={pendingRequests.length ? 'warning' : 'info'} />
      </View>

      <Card>
        <Text style={styles.cardTitle}>Department Subjects</Text>
        {subjects.length ? (
          <DataTable
            columns={['Code', 'Title', 'Lecture units', 'Laboratory units', 'Status', 'Actions']}
            rows={subjects.map((sub) => [
              sub.code,
              sub.title,
              String(sub.lectureUnits),
              String(sub.laboratoryUnits),
              <Badge key={`badge-${sub.id}`} tone={sub.status === 'active' ? 'success' : 'neutral'}>
                {sub.status === 'active' ? 'Active' : 'Inactive'}
              </Badge>,
              <Button key={`edit-${sub.id}`} label="Edit" variant="secondary" onPress={() => openEdit(sub)} />,
            ])}
          />
        ) : (
          <PageState kind="empty" title="No subjects found" message="Create subjects or approve faculty requests to make them available for classes." />
        )}
      </Card>

      <Card>
        <Text style={styles.cardTitle}>Pending Faculty Subject Requests</Text>
        {pendingRequests.length ? (
          <DataTable
            columns={['Code', 'Title', 'Units', 'Requested By', 'Rationale', 'Action']}
            rows={pendingRequests.map((req) => [
              req.code,
              req.title,
              `${req.units} units`,
              req.requesterName,
              req.rationale.length > 50 ? `${req.rationale.slice(0, 50)}...` : req.rationale,
              <Button key={`review-${req.id}`} label="Review" onPress={() => openReviewModal(req)} />,
            ])}
          />
        ) : (
          <PageState kind="empty" title="No pending requests" message="Faculty subject requests submitted from the portal will appear here for review." />
        )}
      </Card>

      {pastRequests.length ? (
        <Card>
          <Text style={styles.cardTitle}>Request History</Text>
          <DataTable
            columns={['Code', 'Title', 'Status', 'Reviewer Note', 'Date']}
            rows={pastRequests.slice(0, 10).map((req) => [
              req.code,
              req.title,
              <Badge key={`past-${req.id}`} tone={req.status === 'approved' ? 'success' : 'danger'}>
                {req.status.toUpperCase()}
              </Badge>,
              req.reviewNote || '—',
              new Date(req.createdAt).toLocaleDateString(),
            ])}
          />
        </Card>
      ) : null}

      <Dialog
        visible={open}
        title={editingSubject ? `Edit Subject: ${editingSubject.code}` : 'Create Department Subject'}
        onClose={() => setOpen(false)}
      >
        <Field label="Subject Code" value={code} onChangeText={setCode} placeholder="e.g. IT311" />
        <Field label="Subject Title" value={title} onChangeText={setTitle} placeholder="e.g. Mobile Application Development" />
        <View style={styles.unitsSliderRow}>
          <View style={styles.unitsSliderCell}><RangeSlider label="Lecture units" value={lectureUnits} onChange={setLectureUnits} /></View>
          <View style={styles.unitsSliderCell}><RangeSlider label="Laboratory units" value={laboratoryUnits} onChange={setLaboratoryUnits} /></View>
        </View>
        <SelectField
          label="Status"
          value={status}
          options={[
            { label: 'Active (available for class creation)', value: 'active' },
            { label: 'Inactive (hidden from faculty)', value: 'inactive' },
          ]}
          onChange={(val) => setStatus(val as 'active' | 'inactive')}
        />
        <Button
          label={editingSubject ? 'Save Changes' : 'Create Subject'}
          loading={saving}
          disabled={!code.trim() || !title.trim()}
          onPress={() => void saveSubject()}
        />
      </Dialog>

      <Dialog
        visible={reviewOpen}
        title={`Review Subject Request: ${selectedRequest?.code ?? ''}`}
        onClose={() => setReviewOpen(false)}
      >
        {selectedRequest ? (
          <View style={styles.dialogContent}>
            <Text style={styles.dialogHeader}>{selectedRequest.title} ({selectedRequest.units} units)</Text>
            <Text style={styles.help}>Requested by: {selectedRequest.requesterName}</Text>
            <Card style={styles.rationaleCard}>
              <Text style={styles.cardTitle}>Faculty Rationale</Text>
              <Text style={styles.help}>{selectedRequest.rationale}</Text>
            </Card>
            <SelectField
              label="Decision"
              value={reviewDecision}
              options={[
                { label: 'Approve (creates/activates subject for faculty)', value: 'approved' },
                { label: 'Reject (declines request)', value: 'rejected' },
              ]}
              onChange={(val) => setReviewDecision(val as 'approved' | 'rejected')}
            />
            {reviewDecision === 'rejected' ? (
              <Field
                label="Review Note (Required for rejection)"
                value={reviewNote}
                onChangeText={setReviewNote}
                multiline
                numberOfLines={3}
                placeholder="Explain why this subject request was not approved..."
              />
            ) : null}
            <Button
              label={reviewDecision === 'approved' ? 'Approve & Activate Subject' : 'Reject Request'}
              variant={reviewDecision === 'approved' ? 'primary' : 'danger'}
              loading={saving}
              disabled={reviewDecision === 'rejected' && !reviewNote.trim()}
              onPress={() => void submitReview()}
            />
          </View>
        ) : null}
      </Dialog>
    </>
  );
}

function Dialog({ visible, title, onClose, children }: { visible: boolean; title: string; onClose: () => void; children: ReactNode }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Card style={styles.dialog}>
          <View style={styles.heading}>
            <Text accessibilityRole="header" style={styles.dialogTitle}>{title}</Text>
            <Pressable accessibilityLabel="Close dialog" onPress={onClose}>
              <Text style={styles.close}>×</Text>
            </Pressable>
          </View>
          <ScrollView style={styles.dialogBody} contentContainerStyle={{ gap: 14 }} keyboardShouldPersistTaps="handled">{children}</ScrollView>
        </Card>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { gap: 16 },
  heading: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  flex: { flex: 1 },
  title: { color: colors.text, fontSize: 22, lineHeight: 30, fontWeight: '700' },
  subtitle: { color: colors.textMuted, fontSize: 13, lineHeight: 19, marginTop: 3 },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  cardTitle: { color: colors.text, fontSize: 15, fontWeight: '700', marginBottom: 12 },
  form: { gap: 14, maxWidth: 920 },
  savedSystemHeader: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 12 },
  savedSystemRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#E3E7EE' },
  bulkClassActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  bulkClassRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: 12, borderWidth: 1, borderColor: '#E3E7EE', borderRadius: 10 },
  bulkClassName: { color: colors.text, fontSize: 13, fontWeight: '700' },
  formGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  deadlineDateField: { flex: 1, flexBasis: 180, minWidth: 180 },
  deadlineSummaryGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  deadlineSummaryItem: { flex: 1, flexBasis: 150, minWidth: 130, gap: 3, padding: 10, borderRadius: 8, backgroundColor: colors.canvas },
  deadlineSummaryLabel: { color: colors.textMuted, fontSize: 11 },
  deadlineSummaryValue: { color: colors.text, fontSize: 13, fontWeight: '700' },
  requestedDeadlinesGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 5 },
  requestedDeadlineItem: { flex: 1, flexBasis: 130, minWidth: 115, gap: 3, padding: 9, borderRadius: 8, backgroundColor: colors.canvas },
  requestReasonField: { paddingTop: 6 },
  deadlineSubmitActions: { marginTop: 5 },
  deadlineRequestRow: { alignItems: 'flex-start' },
  deadlineRequestHeader: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  requestReasonBox: { gap: 4, paddingHorizontal: 10, paddingTop: 14, paddingBottom: 10, marginTop: 7, borderRadius: 8, backgroundColor: colors.canvas },
  requestReasonLabel: { color: colors.text, fontSize: 12, fontWeight: '700' },
  reviewNote: { marginTop: 6 },
  inlineSubjectForm: { gap: 10, borderWidth: 1, borderColor: '#E3E7EE', borderRadius: 10, padding: 12, backgroundColor: '#F8FAFC' },
  subjectFormActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  newSubjectField: { flexGrow: 1, flexBasis: 210 },
  unitsSliderRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 16 },
  unitsSliderCell: { flex: 1, flexBasis: 240, minWidth: 200 },
  help: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  overlay: { flex: 1, backgroundColor: '#00000066', alignItems: 'center', justifyContent: 'center', padding: 24 },
  dialog: { width: '100%', maxWidth: 760, maxHeight: '90%', padding: 22 },
  dialogTitle: { fontSize: 19, fontWeight: '700', color: colors.text },
  dialogBody: { marginTop: 16 },
  dialogContent: { gap: 12 },
  dialogHeader: { fontSize: 16, fontWeight: '600', color: colors.text },
  rationaleCard: { backgroundColor: '#F8FAFC', padding: 12 },
  analyticsCharts: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  close: { fontSize: 28, color: colors.textMuted },
});
