import { getErrorMessage } from '@/services/errors';
import { forecastError, formatForecastError } from '@/services/predictionErrors';
import { planPredictionRequestBatches, predictionBatchItemLimit } from '@/services/predictionBatching';
import { buildRecordedAssessmentColumns, formatRecordedAssessmentScore, isForecastOutputEnabled } from '@/services/forecastGradeColumns';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Modal, Platform, Pressable, ScrollView, Share, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';

import { useAuth } from '@/auth/AuthProvider';
import { AppIcon } from '@/components/Icon';
import { supabase } from '@/services/supabase';
import { Badge, Button, Card, ConfirmDialog, DataTable, DateField, Field, HelpTooltip, MetricCard, PageState, RangeSlider, RefreshIndicator, SearchFilter, SelectField, Tabs, useToast } from '@/components/ui';
import { useAnalyticsFilters } from '@/components/charts/AnalyticsFilters';
import { ReportComposer, type ReportRecord } from '@/components/reports/ReportComposer';
import { VisualizationPanel } from '@/components/charts/VisualizationPanel';
import {
  academicReportCsv, createAcademicAdminClass, updateAcademicAdminClassFaculty, loadAcademicWorkspace, loadAcademicClassWorkspace, loadClassCreationReferences, loadDepartmentClassRequests, loadDepartmentSubjects, loadSubjectRequests,
  applyDepartmentEvaluationCriteriaToClasses, applyPersonalEvaluationCriteriaToClasses, deleteDepartmentEvaluationCriteria, deletePersonalEvaluationCriteria, manageSubject, reviewSubjectRequest, saveDepartmentEvaluationCriteria, savePersonalEvaluationSystem, type AcademicSubject, type AcademicSubjectRequest, type AcademicWorkspace, type SavedEvaluationSystem,
  rejectAcademicAdminClassRequest, type ClassRequestReview, type DepartmentFacultyMember,
} from '@/services/academic';
import { addStudentToClass, applyGradingSystemToClasses, calculateEnrollmentGrade, deleteGradingSystem, encodePredictionInput, importRosterCsv, importRosterExcel, loadGradebookScoreHistory, previewRosterCsv, previewRosterExcel, removeStudentsFromClass, runAiPredictions, saveGradingSystem, summarizeEnrollmentStanding, updateStudentDetails, type ClassWorkspace, type GradebookHistoryCursor, type RosterStudent } from '@/services/faculty';
import { calculateGradingSystem, calculateTrend, extractValidatedSavedAiFactorValues, IT_GLOBAL_GRADING_SYSTEM, validateGradingSystem, type GradingDefinition } from '@apms/domain';
import { createGradingDefinitionId, GradingSystemBuilderForm } from '@/components/GradingSystemBuilderForm';
import { EvaluationSystemBuilderForm } from '@/components/EvaluationSystemBuilderForm';
import { DEFAULT_EVALUATION_SYSTEM, evaluateStudentPerformanceDetailed, validateEvaluationSystem, type EvaluationDefinition } from '@apms/domain';
import { evaluationRiskOptions, evaluationRiskValue } from '@/services/evaluationRiskOptions';
import { addProgramSections, deleteProgramSection, deleteYearLevel, loadInstitutionCode, loadProgramRequests, loadProgramSections, loadYearLevels, saveProgramSection, saveYearLevel, submitProgramRequest, type ProgramRequestRecord, type ProgramSectionRecord, type YearLevelRecord } from '@/services/admin';
import { Settings as AccountSettings } from '@/screens/AppPortalScreen';
import { buildClassAssessmentConstraints, buildClassPredictionInputs, StudentDetail } from '@/screens/FacultyLivePortalContent';
import { colors } from '@/theme/tokens';
import { FullAssessmentView } from '@/components/gradebook/FullAssessmentView';
import { styles as facultyGradebookStyles } from '@/screens/FacultyLivePortalContent.styles';
import { isValidStudentId, normalizeStudentId } from '@/utils/studentId';
import { useStudentIdValidation, useYearLevels } from '@/hooks/useAcademicOptions';
import { formatStudentName } from '@/utils/studentName';
import { resolveInstitutionalSectionName } from '@/utils/academicSections';
import { AcademicAdminUsersScreen } from '@/screens/AcademicAdminUsersScreen';

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
  return { ...evaluateStudentPerformanceDetailed(definition, values), inputValues: values };
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
    for (const table of ['class_records', 'enrollments', 'assessment_results', 'attendance_records', 'performance_evaluations', 'class_evaluation_criteria', 'evaluation_criteria_systems', 'evaluation_systems', 'academic_admin_class_evaluation_systems']) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, scheduleRefresh);
    }
    channel.subscribe();
    const poll = setInterval(refresh, 60_000);
    return () => { clearInterval(poll); if (timer) clearTimeout(timer); void client.removeChannel(channel); };
  }, [refresh, userId]);
  return { data, loading, refreshing, error, refresh };
}

export function AcademicAdminPortalContent({ screen }: { screen: string }) {
  const params = useLocalSearchParams<{ tab?: string }>();
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
    {screen === 'classes' ? <Classes {...props} initialTab={params.tab === 'requests' ? 'Class requests' : 'Department classes'} /> : null}
    {screen === 'users' ? <AcademicAdminUsersScreen departmentId={state.data.department!.id} toast={toast} /> : null}
    {screen === 'risk' ? <Risk {...props} /> : null}
    {screen === 'criteria' ? <Criteria {...props} /> : null}
    {screen === 'deadlines' ? <GradeDeadlineRequests {...props} /> : null}
    {screen === 'analytics' ? <Analytics {...props} /> : null}
    {screen === 'settings' ? <AccountSettings role="academic_admin" screen="settings" onMessage={(message) => toast.show(message)} /> : null}
  </View>;
}

type Props = { data: AcademicWorkspace; refresh: () => void; userId: string; toast: ReturnType<typeof useToast> };
function Heading({ title, subtitle, action }: { title: string; subtitle: string; action?: React.ReactNode }) { return <View style={styles.heading}><View style={styles.headingCopy}><Text accessibilityRole="header" style={styles.title}>{title}</Text><Text style={styles.subtitle}>{subtitle}</Text></View>{action}</View>; }
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
  const [scopeType, setScopeType] = useState<'program' | 'year_level' | 'class'>('program');
  const [requestFormOpen, setRequestFormOpen] = useState(false);
  const [programId, setProgramId] = useState(data.programs[0]?.id ?? '');
  const [classId, setClassId] = useState(data.classes[0]?.id ?? '');
  const [yearLevel, setYearLevel] = useState('1');
  const [deadlines, setDeadlines] = useState<Record<string, string>>({ overall: '', p1: '', p2: '', p3: '' });
  const [rationale, setRationale] = useState('');
  const [requests, setRequests] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [requesterNames, setRequesterNames] = useState<Record<string, string>>({});
  const [reviewingFacultyRequest, setReviewingFacultyRequest] = useState<any | null>(null);
  const [facultyDeadlines, setFacultyDeadlines] = useState<Record<string, string>>({});
  const [facultyForwardReason, setFacultyForwardReason] = useState('');
  const [facultyRejectionReason, setFacultyRejectionReason] = useState('');
  const [facultyReviewMode, setFacultyReviewMode] = useState<'forward' | 'reject'>('forward');
  const load = useCallback(async () => {
    if (!supabase) return;
    const [globalResult, requestResult] = await Promise.all([
      supabase.from('grade_encoding_deadlines').select('period_key,deadline_at').eq('scope_type', 'system'),
      supabase.from('grade_encoding_deadline_requests').select('id,department_id,requested_by,scope_type,program_id,year_level,class_record_id,requested_periods,class_record_ids,requested_deadlines,rationale,academic_admin_reason,academic_admin_reviewed_by,status,review_note,created_at,reviewed_at').order('created_at', { ascending: true }),
    ]);
    const error = globalResult.error ?? requestResult.error;
    if (error) throw error;
    const loadedRequests = requestResult.data ?? [];
    setRequests([...loadedRequests].sort((a, b) => {
      const isPending = (status: string) => status === 'pending' || status === 'pending_academic_admin' || status === 'pending_system_admin';
      const pendingOrder = Number(isPending(b.status)) - Number(isPending(a.status));
      if (pendingOrder) return pendingOrder;
      if (isPending(a.status)) return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      return new Date(b.reviewed_at ?? b.created_at).getTime() - new Date(a.reviewed_at ?? a.created_at).getTime();
    }));
    const facultyRequesterIds = [...new Set(loadedRequests.filter((request) => request.scope_type === 'faculty').map((request) => request.requested_by))];
    if (facultyRequesterIds.length) {
      const { data: profiles, error: profileError } = await supabase.from('profiles').select('id,first_name,last_name').in('id', facultyRequesterIds);
      if (profileError) throw profileError;
      setRequesterNames(Object.fromEntries((profiles ?? []).map((profile) => [profile.id, `${profile.first_name ?? ''} ${profile.last_name ?? ''}`.trim() || 'Faculty member'])));
    } else setRequesterNames({});
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
        class_record_id: scopeType === 'class' ? classId : null,
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
  const openFacultyReview = (request: any) => {
    setReviewingFacultyRequest(request);
    setFacultyDeadlines(Object.fromEntries((request.requested_periods ?? []).map((key: string) => [key, ''])));
    setFacultyForwardReason('');
    setFacultyRejectionReason('');
    setFacultyReviewMode('forward');
  };
  const reviewFacultyRequest = async (action: 'forward' | 'reject') => {
    if (!supabase || !reviewingFacultyRequest) return;
    if (action === 'forward') {
      if ((reviewingFacultyRequest.requested_periods ?? []).some((key: string) => !facultyDeadlines[key])) return toast.show('Set a deadline for every period the Faculty selected.');
      if (facultyForwardReason.trim().length < 10) return toast.show('Add a reason for forwarding (at least 10 characters).');
    }
    setBusy(true);
    try {
      const { error } = await supabase.rpc('review_faculty_grade_deadline_request', {
        p_request_id: reviewingFacultyRequest.id,
        p_action: action,
        p_deadlines: action === 'forward' ? Object.fromEntries(Object.entries(facultyDeadlines).map(([key, date]) => [key, `${date}T23:59:59+08:00`])) : {},
        p_academic_admin_reason: action === 'forward' ? facultyForwardReason.trim() : null,
        p_rejection_reason: action === 'reject' ? facultyRejectionReason.trim() || null : null,
      });
      if (error) throw error;
      toast.show(action === 'forward' ? 'Deadline request forwarded to the System Admin.' : 'Faculty deadline request rejected.');
      setReviewingFacultyRequest(null);
      await load();
    } catch (cause) { toast.show(getErrorMessage(cause, 'The Faculty deadline request could not be reviewed.')); }
    finally { setBusy(false); }
  };
  const displayDeadline = (value: unknown) => {
    if (typeof value !== 'string' || !value) return 'Not set';
    const date = value.slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T12:00:00`).toLocaleDateString() : 'Not set';
  };
  return <>
    <Heading title="Grade encoding deadlines" subtitle="Request deadline changes for your department, a program, year level, or individual class." />
    <Dialog visible={!!reviewingFacultyRequest} title="Review Faculty deadline request" onClose={() => { if (!busy) setReviewingFacultyRequest(null); }} wide>
      {reviewingFacultyRequest ? <>
        <Text style={styles.help}>{requesterNames[reviewingFacultyRequest.requested_by] ?? 'Faculty member'} requested a change for {(reviewingFacultyRequest.class_record_ids ?? []).length} selected classes: {(reviewingFacultyRequest.class_record_ids ?? []).map((id: string) => data.classes.find((item) => item.id === id)).filter(Boolean).map((item: any) => `${item.code} · ${item.section}`).join(', ') || 'class details unavailable'}.</Text>
        <Text style={styles.help}>Faculty reason: {reviewingFacultyRequest.rationale}</Text>
        {facultyReviewMode === 'forward' ? <>
          <Text style={[styles.cardTitle, styles.deadlineCardTitle]}>Set the proposed deadlines</Text>
          <View style={styles.formGrid}>{gradeDeadlinePeriods.filter(({ key }) => (reviewingFacultyRequest.requested_periods ?? []).includes(key)).map(({ key, label }) => <DateField key={key} label={`${label} deadline`} value={facultyDeadlines[key] ?? ''} onChange={(value) => setFacultyDeadlines((current) => ({ ...current, [key]: value }))} containerStyle={styles.deadlineDateField} />)}</View>
          <Field label="Reason for forwarding to System Admin" value={facultyForwardReason} onChangeText={setFacultyForwardReason} multiline numberOfLines={3} maxLength={1000} placeholder="Explain why these changed deadlines are being requested." />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}><Button label="Reject…" variant="secondary" disabled={busy} onPress={() => setFacultyReviewMode('reject')} /><View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8 }}><Button label="Cancel" variant="secondary" disabled={busy} onPress={() => setReviewingFacultyRequest(null)} /><Button label="Forward to System Admin" loading={busy} disabled={busy || facultyForwardReason.trim().length < 10 || (reviewingFacultyRequest.requested_periods ?? []).some((key: string) => !facultyDeadlines[key])} onPress={() => void reviewFacultyRequest('forward')} /></View></View>
        </> : <>
          <Text style={styles.help}>Reject this request? It will be closed immediately and the Faculty member will be notified.</Text>
          <Field label="Optional rejection reason" value={facultyRejectionReason} onChangeText={setFacultyRejectionReason} multiline numberOfLines={3} maxLength={1000} placeholder="Leave blank to reject without a note." />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8 }}><Button label="Back" variant="secondary" disabled={busy} onPress={() => setFacultyReviewMode('forward')} /><Button label="Cancel" variant="secondary" disabled={busy} onPress={() => setReviewingFacultyRequest(null)} /><Button label="Confirm rejection" variant="danger" loading={busy} disabled={busy} onPress={() => void reviewFacultyRequest('reject')} /></View>
        </>}
      </> : null}
    </Dialog>
    <Card style={[styles.form, styles.deadlineCard]}>
      <View style={styles.deadlineCardHeader}><Text style={[styles.cardTitle, styles.deadlineCardTitle]}>Current system-wide deadlines</Text><Button compact label={requestFormOpen ? 'Close request form' : 'Request deadline change'} variant={requestFormOpen ? 'secondary' : 'primary'} onPress={() => setRequestFormOpen((open) => !open)} /></View>
      <View style={styles.deadlineSummaryGrid}>{gradeDeadlinePeriods.map(({ key, label }) => <View key={key} style={styles.deadlineSummaryItem}><Text style={styles.deadlineSummaryLabel}>{label}</Text><Text style={styles.deadlineSummaryValue}>{displayDeadline(globalDeadlines[key])}</Text></View>)}</View>
    </Card>
    {requestFormOpen ? <Card style={[styles.form, styles.deadlineCard]}>
      <Text style={[styles.cardTitle, styles.deadlineCardTitle]}>Request a deadline change</Text>
      <Text style={styles.help}>Deadlines are enforced when scores are saved. After an approved deadline passes, scores in that scope cannot be added, edited, cleared, or restored.</Text>
      <View style={styles.formGrid}>
        <SelectField label="Request scope" value={scopeType} options={[{ label: 'Program', value: 'program' }, { label: 'Year level across my department', value: 'year_level' }, { label: 'Specific class', value: 'class' }]} onChange={(value) => setScopeType(value as 'program' | 'year_level' | 'class')} containerStyle={{ flex: 1, minWidth: 220 }} />
        {scopeType === 'program' ? <SelectField label="Program" value={programId} options={data.programs.map((program) => ({ label: `${program.code} · ${program.name}`, value: program.id }))} onChange={setProgramId} containerStyle={{ flex: 1, minWidth: 220 }} /> : scopeType === 'class' ? <SelectField label="Class" value={classId} options={data.classes.map((item) => ({ label: `${item.code} · ${item.section}${item.term ? ` · ${item.term}` : ''}`, value: item.id }))} onChange={setClassId} containerStyle={{ flex: 1, minWidth: 220 }} /> : <SelectField label="Year level" value={yearLevel} options={Array.from({ length: 8 }, (_, index) => ({ label: `Year ${index + 1}`, value: String(index + 1) }))} onChange={setYearLevel} containerStyle={{ flex: 1, minWidth: 220 }} />}
      </View>
      <View style={styles.formGrid}>{[...gradeDeadlinePeriods.filter(({ key }) => key !== 'overall'), ...gradeDeadlinePeriods.filter(({ key }) => key === 'overall')].map(({ key, label }) => <DateField key={key} label={`${key === 'overall' ? 'Overall' : label} deadline`} value={deadlines[key]} onChange={(value) => setDeadlines((current) => ({ ...current, [key]: value }))} containerStyle={styles.deadlineDateField} />)}</View>
      <View style={styles.requestReasonField}><Field label="Reason for request" value={rationale} onChangeText={setRationale} multiline numberOfLines={3} maxLength={1000} placeholder="Explain the circumstances and requested change." /></View>
      <View style={[styles.subjectFormActions, styles.deadlineSubmitActions]}><Button label="Submit for review" loading={busy} disabled={busy || (scopeType === 'program' && !programId) || (scopeType === 'class' && !classId)} onPress={() => void submit()} /></View>
    </Card> : null}
    <Card style={[styles.form, styles.deadlineCard]}>
      <Text style={[styles.cardTitle, styles.deadlineCardTitle]}>Requests</Text>
      <Text style={[styles.cardTitle, styles.deadlineCardTitle, { fontSize: 13, marginTop: 2 }]}>Faculty requests</Text>
      <Text style={styles.help}>Review requests from Faculty members in your department. Set the proposed deadline dates before forwarding to the System Admin.</Text>
      {requests.filter((request) => request.scope_type === 'faculty').length ? <View style={{ gap: 8 }}>{requests.filter((request) => request.scope_type === 'faculty').map((request) => {
        const pending = request.status === 'pending_academic_admin';
        const statusTone = request.status === 'approved' ? 'success' : request.status === 'rejected' ? 'danger' : 'warning';
        const selectedClassLabels = (request.class_record_ids ?? []).map((id: string) => data.classes.find((item) => item.id === id)).filter(Boolean).map((item: any) => `${item.code} · ${item.section}`);
        return <View key={request.id} style={[styles.savedSystemRow, styles.deadlineRequestRow]}>
          <View style={styles.flex}>
            <View style={styles.deadlineRequestHeader}><Text style={styles.bulkClassName}>{requesterNames[request.requested_by] ?? 'Faculty member'} · {request.class_record_ids?.length ?? 0} selected classes</Text><Badge tone={statusTone}>{request.status === 'pending_academic_admin' ? 'Needs review' : request.status === 'pending_system_admin' ? 'Forwarded to System Admin' : request.status.charAt(0).toUpperCase() + request.status.slice(1)}</Badge></View>
            <Text style={styles.help}>Requested {new Date(request.created_at).toLocaleString()} · {(request.requested_periods ?? []).map((key: string) => gradeDeadlinePeriods.find((item) => item.key === key)?.label ?? key).join(', ')}</Text>
            <Text style={styles.help}>Classes: {selectedClassLabels.join(', ') || `${request.class_record_ids?.length ?? 0} selected`}</Text>
            {Object.keys(request.requested_deadlines ?? {}).length ? <View style={styles.requestedDeadlinesGrid}>{gradeDeadlinePeriods.filter(({ key }) => request.requested_deadlines?.[key]).map(({ key, label }) => <View key={key} style={styles.requestedDeadlineItem}><Text style={styles.deadlineSummaryLabel}>{label}</Text><Text style={styles.deadlineSummaryValue}>{displayDeadline(request.requested_deadlines[key])}</Text></View>)}</View> : null}
            <View style={styles.requestNotesGrid}>
              <View style={[styles.requestReasonBox, !request.academic_admin_reason && !request.review_note && styles.requestNoteFullWidth]}><Text style={styles.requestReasonLabel}>Faculty reason</Text><Text style={styles.help}>{request.rationale}</Text></View>
              {request.academic_admin_reason ? <View style={styles.requestReasonBox}><Text style={styles.requestReasonLabel}>Forwarded reason</Text><Text style={styles.help}>{request.academic_admin_reason}</Text></View> : null}
              {request.review_note ? <View style={styles.requestReasonBox}><Text style={styles.requestReasonLabel}>Rejection reason</Text><Text style={styles.help}>{request.review_note}</Text></View> : null}
            </View>
          </View>
          {pending ? <Button compact label="Review" variant="secondary" disabled={busy} onPress={() => openFacultyReview(request)} /> : null}
        </View>;
      })}</View> : <PageState kind="empty" title="No Faculty requests" message="Faculty deadline requests for your department will appear here." />}
      <Text style={[styles.cardTitle, styles.deadlineCardTitle, { fontSize: 13, marginTop: 8 }]}>Your requests</Text>
      {requests.filter((request) => request.scope_type !== 'faculty').length ? <View style={{ gap: 8 }}>{requests.filter((request) => request.scope_type !== 'faculty').map((request) => {
        const program = data.programs.find((item) => item.id === request.program_id);
        const requestClass = data.classes.find((item) => item.id === request.class_record_id);
        const statusTone = request.status === 'approved' ? 'success' : request.status === 'rejected' ? 'danger' : 'warning';
        return <View key={request.id} style={[styles.savedSystemRow, styles.deadlineRequestRow]}><View style={styles.flex}><View style={styles.deadlineRequestHeader}><Text style={styles.bulkClassName}>{request.scope_type === 'program' ? `${program?.code ?? 'Program'} · ${program?.name ?? ''}` : request.scope_type === 'class' ? `${requestClass?.code ?? 'Subject'} · ${requestClass?.title ?? 'Untitled subject'} — ${requestClass?.section ?? 'Class'}` : `Year ${request.year_level} · All programs`}</Text><Badge tone={statusTone}>{request.status.charAt(0).toUpperCase() + request.status.slice(1)}</Badge></View><Text style={styles.help}>Requested {new Date(request.created_at).toLocaleString()}</Text><View style={styles.requestedDeadlinesGrid}>{gradeDeadlinePeriods.map(({ key, label }) => request.requested_deadlines?.[key] ? <View key={key} style={styles.requestedDeadlineItem}><Text style={styles.deadlineSummaryLabel}>{label}</Text><Text style={styles.deadlineSummaryValue}>{displayDeadline(request.requested_deadlines[key])}</Text></View> : null)}</View><View style={styles.requestNotesGrid}><View style={[styles.requestReasonBox, !request.review_note && styles.requestNoteFullWidth]}><Text style={styles.requestReasonLabel}>Reason for request</Text><Text style={styles.help}>{request.rationale}</Text></View>{request.review_note ? <View style={styles.requestReasonBox}><Text style={styles.requestReasonLabel}>{request.status === 'rejected' ? 'Reason for rejection' : 'Review note'}</Text><Text style={styles.help}>{request.review_note}</Text></View> : null}</View></View></View>;
      })}</View> : <PageState kind="empty" title="No requests yet" message="Submitted deadline changes will appear here for review." />}
    </Card>
  </>;
}

function Units({ data, userId }: Props) {
  const toast = useToast();
  const [unitsTab, setUnitsTab] = useState('Programs');
  const [programId, setProgramId] = useState(data.programs[0]?.id ?? '');
  const [rows, setRows] = useState<YearLevelRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<YearLevelRecord | null>(null);
  const [level, setLevel] = useState('');
  const [label, setLabel] = useState('');
  const [deleting, setDeleting] = useState<YearLevelRecord | null>(null);
  const [sectionYearLevel, setSectionYearLevel] = useState('');
  const [sections, setSections] = useState<ProgramSectionRecord[]>([]);
  const [sectionsLoading, setSectionsLoading] = useState(false);
  const [sectionDialogOpen, setSectionDialogOpen] = useState(false);
  const [editingSection, setEditingSection] = useState<ProgramSectionRecord | null>(null);
  const [sectionNumber, setSectionNumber] = useState('');
  const [deletingSection, setDeletingSection] = useState<ProgramSectionRecord | null>(null);
  const [sectionSaving, setSectionSaving] = useState(false);
  const [addSectionsYearLevel, setAddSectionsYearLevel] = useState<YearLevelRecord | null>(null);
  const [addSectionsCount, setAddSectionsCount] = useState('1');
  const [institutionCode, setInstitutionCode] = useState('SWU');
  const [programRequests, setProgramRequests] = useState<ProgramRequestRecord[]>([]);
  const [requestProgramOpen, setRequestProgramOpen] = useState(false);
  const [programRequestCode, setProgramRequestCode] = useState('');
  const [programRequestName, setProgramRequestName] = useState('');
  const [programRequestReason, setProgramRequestReason] = useState('');
  const [programRequestSaving, setProgramRequestSaving] = useState(false);
  const selectedProgram = data.programs.find((program) => program.id === programId);
  useEffect(() => {
    let active = true;
    void loadInstitutionCode().then((code) => { if (active) setInstitutionCode(code); })
      .catch((cause) => { if (active) toast.show(getErrorMessage(cause, 'Institution code could not be loaded; using SWU.')); });
    return () => { active = false; };
  }, [toast]);
  useEffect(() => {
    let active = true;
    void loadProgramRequests().then((loaded) => { if (active) setProgramRequests(loaded); })
      .catch((cause) => { if (active) toast.show(getErrorMessage(cause, 'Program requests could not be loaded.')); });
    return () => { active = false; };
  }, [toast]);
  const submitNewProgramRequest = async () => {
    if (!data.department || !programRequestCode.trim() || !programRequestName.trim()) return;
    const code = programRequestCode.trim().toUpperCase();
    if (data.programs.some((item) => item.code.toUpperCase() === code)) return toast.show('A program with this code already exists in your department.');
    if (programRequests.some((item) => item.status === 'pending' && item.code.toUpperCase() === code)) return toast.show('A request for this program code is already pending.');
    setProgramRequestSaving(true);
    try {
      await submitProgramRequest({ departmentId: data.department.id, code, name: programRequestName, rationale: programRequestReason });
      toast.show('Program request sent to the System Admin.');
      setRequestProgramOpen(false); setProgramRequestCode(''); setProgramRequestName(''); setProgramRequestReason('');
      setProgramRequests(await loadProgramRequests());
    } catch (cause) {
      const code = typeof cause === 'object' && cause !== null && 'code' in cause ? String((cause as { code: unknown }).code) : '';
      if (code === '23505') toast.show('A program with this code already exists or has a pending request.');
      else toast.show(getErrorMessage(cause, 'Program request could not be sent.'));
    } finally { setProgramRequestSaving(false); }
  };
  const refresh = async () => {
    if (!programId) { setRows([]); return; }
    setLoading(true);
    try {
      const loadedRows = await loadYearLevels(programId);
      setRows(loadedRows);
      setSectionYearLevel((current) => loadedRows.some((row) => String(row.level) === current) ? current : String(loadedRows[0]?.level ?? ''));
    }
    catch (cause) { toast.show(getErrorMessage(cause, 'Program year levels could not be loaded.')); }
    finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); }, [programId]);
  useEffect(() => {
    let active = true;
    if (!programId) { setSections([]); return; }
    setSectionsLoading(true);
    void loadProgramSections(programId)
      .then((loaded) => { if (active) setSections(loaded); })
      .catch((cause) => { if (active) toast.show(getErrorMessage(cause, 'Program sections could not be loaded.')); })
      .finally(() => { if (active) setSectionsLoading(false); });
    return () => { active = false; };
  }, [programId, toast]);
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
  const openSection = (row?: ProgramSectionRecord) => {
    setEditingSection(row ?? null);
    setSectionYearLevel(String(row?.yearLevel ?? (sectionYearLevel || rows[0]?.level || '')));
    setSectionNumber(row ? String(row.sectionNumber) : '');
    setSectionDialogOpen(true);
  };
  const sectionLetter = (value: number) => String.fromCharCode(64 + value);
  const sectionLabel = (row: ProgramSectionRecord) => `${sectionLetter(row.yearLevel)}${row.sectionNumber}`;
  const firstNewSectionNumber = addSectionsYearLevel
    ? Math.max(0, ...sections.filter((section) => section.yearLevel === addSectionsYearLevel.level).map((section) => section.sectionNumber)) + 1
    : 0;
  const addSectionsForYearLevel = async () => {
    const count = Number(addSectionsCount);
    if (!programId || !addSectionsYearLevel || !Number.isInteger(count) || count < 1 || firstNewSectionNumber + count - 1 > 99) return;
    setSectionSaving(true);
    try {
      await addProgramSections({ programId, yearLevel: addSectionsYearLevel.level, firstSectionNumber: firstNewSectionNumber, count, userId });
      setSections(await loadProgramSections(programId));
      toast.show(`${count} section${count === 1 ? '' : 's'} added to ${addSectionsYearLevel.label}.`);
      setAddSectionsYearLevel(null);
    } catch (cause) {
      const errorCode = typeof cause === 'object' && cause !== null && 'code' in cause ? String((cause as { code: unknown }).code) : '';
      if (errorCode === '23505') toast.show('One or more of those section numbers already exist. Refresh the list and try again.');
      else toast.show(getErrorMessage(cause, 'Sections could not be added.'));
    } finally { setSectionSaving(false); }
  };
  const saveSection = async () => {
    const numericYear = Number(sectionYearLevel);
    const numericNumber = Number(sectionNumber);
    if (!programId || !Number.isInteger(numericYear) || !Number.isInteger(numericNumber) || numericNumber < 1 || numericNumber > 99) return;
    const duplicate = sections.some((row) => row.id !== editingSection?.id && row.yearLevel === numericYear && row.sectionNumber === numericNumber);
    if (duplicate) return toast.show('A section for this program and year level with that section number already exists.');
    setSectionSaving(true);
    try {
      await saveProgramSection({ id: editingSection?.id, programId, yearLevel: numericYear, sectionNumber: numericNumber, userId });
      toast.show(`Section ${sectionLetter(numericYear)}${numericNumber} saved.`);
      setSectionDialogOpen(false);
      const loaded = await loadProgramSections(programId);
      setSectionYearLevel(String(numericYear));
      setSections(loaded);
    } catch (cause) {
      const errorCode = typeof cause === 'object' && cause !== null && 'code' in cause ? String((cause as { code: unknown }).code) : '';
      const errorMessage = cause instanceof Error ? cause.message : typeof cause === 'object' && cause !== null && 'message' in cause ? String((cause as { message: unknown }).message) : '';
      if (errorCode === '23505' || errorMessage.includes('program_sections_program_year_number_key')) toast.show('A section for this program and year level with that section number already exists.');
      else toast.show(getErrorMessage(cause, 'Section could not be saved.'));
    }
    finally { setSectionSaving(false); }
  };
  const removeSection = async () => {
    if (!deletingSection) return;
    setSectionSaving(true);
    try {
      await deleteProgramSection(deletingSection.id);
      toast.show(`Section ${sectionLabel(deletingSection)} removed.`);
      setDeletingSection(null);
      setSections(await loadProgramSections(programId));
    } catch (cause) { toast.show(getErrorMessage(cause, 'Section could not be removed.')); }
    finally { setSectionSaving(false); }
  };
  return <>
    <Heading title="Academic Units" subtitle="View your authorized department and manage year levels for each program." />
    <Tabs values={['Programs', 'Year Levels and Sections']} selected={unitsTab} onSelect={setUnitsTab} />
    {unitsTab === 'Programs' ? <>
    {data.department ? <DataTable compact columns={['Department', 'Code', 'Access']} rows={[[data.department.name, data.department.code, 'Authorized']]} columnWidths={[300, 120, 140]} columnFlex={[1, 0, 0]} widthMode="container" /> : null}
    <View style={styles.unitSection}>
      <View style={styles.heading}><Text style={styles.unitSectionTitle}>Programs</Text><Button label="Request program" variant="secondary" disabled={!data.department} onPress={() => setRequestProgramOpen(true)} /></View>
      {data.programs.length ? <DataTable columns={['Program', 'Code', 'Status']} rows={data.programs.map((program) => [program.name, program.code, 'Active'])} columnFlex={[1, 0, 0]} /> : <PageState kind="empty" title="No active programs" message="No program records are available in this department." />}
      <Text style={styles.unitSectionTitle}>My program requests</Text>
      {programRequests.length ? <DataTable columns={['Program', 'Code', 'Request reason', 'Status', 'Submitted', 'Rejection reason']} rows={programRequests.map((request) => [request.name, request.code, request.rationale ?? '—', <Badge key={request.id} tone={request.status === 'approved' ? 'success' : request.status === 'rejected' ? 'danger' : 'warning'}>{request.status[0].toUpperCase() + request.status.slice(1)}</Badge>, new Date(request.createdAt).toLocaleDateString(), request.rejectionReason ?? '—'])} columnFlex={[1, 0, 1, 0, 0, 1]} /> : <Text style={styles.help}>Requests you submit will appear here.</Text>}
    </View>
    </> : null}
    {unitsTab === 'Year Levels and Sections' ? <>
    <SelectField label="Program" value={programId} options={data.programs.map((program) => ({ label: `${program.code} · ${program.name}`, value: program.id }))} onChange={setProgramId} />
    <View style={styles.unitSection}>
      <View style={styles.heading}><View style={styles.flex}><Text style={styles.unitSectionTitle}>Program year levels</Text><Text style={styles.help}>Each program has its own year-level options. New programs start with four levels; existing student records are not changed when an option is removed.</Text></View><Button label="Add year level" disabled={!programId || !availableLevels.length} onPress={() => open()} /></View>
      {loading ? <PageState kind="loading" title="Loading year levels" message="Retrieving options for the selected program." /> : rows.length ? <DataTable columns={['Level', 'Display label', 'Actions']} columnWidths={[72, 170, 300]} columnFlex={[0, 1, 0]} widthMode="container" rows={rows.map((row) => [String(row.level), row.label, <View key={row.level} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}><Button compact label="Add sections" variant="secondary" onPress={() => { setAddSectionsYearLevel(row); setAddSectionsCount('1'); }} /><Button compact label="Edit" variant="secondary" onPress={() => open(row)} /><Button compact label="Delete" variant="danger" onPress={() => setDeleting(row)} /></View>])} /> : <PageState kind="empty" title="No year levels configured" message={`Add year levels for ${selectedProgram?.code ?? 'this program'}.`} />}
    </View>
    <View style={styles.unitSection}>
      <View style={styles.heading}>
        <View style={styles.flex}>
          <Text style={styles.unitSectionTitle}>Program sections</Text>
          <Text style={styles.help}>Manage sections across all year levels in this program. Names use the year-level letter and section number, with {institutionCode} as the institution prefix.</Text>
        </View>
        <Button label="Add section" disabled={!programId || !rows.length} onPress={() => openSection()} />
      </View>
      {sectionsLoading ? <PageState kind="loading" title="Loading sections" message="Retrieving sections for this program." /> : sections.length ? <DataTable
        columns={['Section', 'Year level', 'Short Code', 'Manage']}
        columnWidths={[310, 180, 130, 180]}
        columnFlex={[1, 0, 0, 0]}
        widthMode="container"
        rows={sections.map((row) => [`${institutionCode}-${selectedProgram?.code ?? 'PROGRAM'}${row.yearLevel}-${sectionLabel(row)}`, `${rows.find((level) => level.level === row.yearLevel)?.label ?? `Year ${row.yearLevel}`} · Year ${row.yearLevel}`, sectionLabel(row), <View key={row.id} style={{ flexDirection: 'row', gap: 6 }}><Button compact label="Edit" variant="secondary" onPress={() => openSection(row)} /><Button compact label="Delete" variant="danger" onPress={() => setDeletingSection(row)} /></View>])}
      /> : <PageState kind="empty" title="No sections configured" message={`Add the first section${selectedProgram ? ` for ${selectedProgram.code}` : ''}.`} />}
    </View>
    </> : null}
    <Dialog visible={dialogOpen} title={editing ? 'Edit program year level' : 'Add program year level'} onClose={() => setDialogOpen(false)}>
      <SelectField label="Year level number" value={level} options={availableLevels.map((value) => ({ label: `Year ${value}`, value: String(value) }))} onChange={setLevel} />
      <Field label="Display label" value={label} onChangeText={setLabel} placeholder="e.g. First year" maxLength={80} />
      <Button label={editing ? 'Save year level' : 'Add year level'} loading={saving} disabled={!level || !label.trim()} onPress={() => void save()} />
    </Dialog>
    <ConfirmDialog visible={deleting !== null} title="Delete program year level?" message={`${deleting?.label ?? 'This level'} will no longer appear in this program's new student forms. Existing records remain unchanged.`} confirmLabel="Delete year level" danger pending={saving} onClose={() => { if (!saving) setDeleting(null); }} onConfirm={() => void remove()} />
    <Dialog visible={sectionDialogOpen} title={editingSection ? 'Edit program section' : 'Add program section'} onClose={() => { if (!sectionSaving) setSectionDialogOpen(false); }}>
      <SelectField label="Year level" value={sectionYearLevel} options={rows.map((row) => ({ label: `${row.label} · Year ${row.level}`, value: String(row.level) }))} onChange={setSectionYearLevel} />
      <Field label="Section number" value={sectionNumber} onChangeText={(value) => setSectionNumber(value.replace(/\D/g, '').slice(0, 2))} inputType="text" keyboardType="number-pad" placeholder="e.g. 2" />
      {sectionYearLevel && sectionNumber && Number(sectionYearLevel) <= 26 ? <View style={{ gap: 4, backgroundColor: colors.canvas, borderRadius: 8, padding: 10 }}>
        <Text style={{ color: colors.text, fontSize: 12, fontWeight: '600' }}>Section name preview</Text>
        <Text style={styles.help}>{sectionLetter(Number(sectionYearLevel))}{sectionNumber} · {selectedProgram?.code ?? 'PROGRAM'}-{sectionLetter(Number(sectionYearLevel))}{sectionNumber}</Text>
        <Text style={styles.help}>Institution-wide: {institutionCode}-{selectedProgram?.code ?? 'PROGRAM'}{sectionYearLevel}-{sectionLetter(Number(sectionYearLevel))}{sectionNumber}</Text>
      </View> : null}
      <Button label={editingSection ? 'Save section' : 'Add section'} loading={sectionSaving} disabled={!sectionYearLevel || !sectionNumber || Number(sectionNumber) < 1 || Number(sectionNumber) > 99} onPress={() => void saveSection()} />
    </Dialog>
    <Dialog visible={addSectionsYearLevel !== null} title={`Add sections · ${addSectionsYearLevel?.label ?? 'Year level'}`} onClose={() => { if (!sectionSaving) setAddSectionsYearLevel(null); }}>
      <Text style={styles.help}>Choose how many sections to create for {selectedProgram?.code ?? 'this program'} · Year {addSectionsYearLevel?.level ?? ''}. Section numbers continue after the highest existing number.</Text>
      <Field label="Number of sections" value={addSectionsCount} onChangeText={(value) => setAddSectionsCount(value.replace(/\D/g, '').slice(0, 2))} inputType="text" keyboardType="number-pad" placeholder="e.g. 3" />
      {addSectionsYearLevel && Number(addSectionsCount) > 0 ? <View style={{ gap: 4, backgroundColor: colors.canvas, borderRadius: 8, padding: 10 }}>
        <Text style={{ color: colors.text, fontSize: 12, fontWeight: '600' }}>Sections to add</Text>
        {firstNewSectionNumber + Number(addSectionsCount) - 1 <= 99
          ? <Text style={styles.help}>{sectionLetter(addSectionsYearLevel.level)}{firstNewSectionNumber}–{sectionLetter(addSectionsYearLevel.level)}{firstNewSectionNumber + Number(addSectionsCount) - 1}</Text>
          : <Text style={[styles.help, { color: colors.danger }]}>Section numbers can only go up to 99.</Text>}
      </View> : null}
      <Button label="Add sections" loading={sectionSaving} disabled={!addSectionsYearLevel || !Number(addSectionsCount) || firstNewSectionNumber + Number(addSectionsCount) - 1 > 99} onPress={() => void addSectionsForYearLevel()} />
    </Dialog>
    <Dialog visible={requestProgramOpen} title="Request a program" onClose={() => { if (!programRequestSaving) setRequestProgramOpen(false); }}>
      <Text style={styles.help}>Request a new program for {data.department?.name ?? 'your department'}. The System Admin will review the request. A reason is optional.</Text>
      <Field label="Program code" value={programRequestCode} onChangeText={(value) => setProgramRequestCode(value.toUpperCase())} placeholder="e.g. BSIT" maxLength={30} autoCapitalize="characters" />
      <Field label="Program name" value={programRequestName} onChangeText={setProgramRequestName} placeholder="e.g. Bachelor of Science in Information Technology" maxLength={160} />
      <Field label="Request reason (optional)" value={programRequestReason} onChangeText={setProgramRequestReason} multiline numberOfLines={3} maxLength={1000} placeholder="Add context for the System Admin, if helpful." />
      <Button label="Send program request" loading={programRequestSaving} disabled={!programRequestCode.trim() || !programRequestName.trim()} onPress={() => void submitNewProgramRequest()} />
    </Dialog>
    <ConfirmDialog visible={deletingSection !== null} title="Remove program section?" message={`${deletingSection ? sectionLabel(deletingSection) : 'This section'} will no longer be available in this program/year section list.`} confirmLabel="Remove section" danger pending={sectionSaving} onClose={() => { if (!sectionSaving) setDeletingSection(null); }} onConfirm={() => void removeSection()} />
  </>;
}
function AcademicAdminReadOnlyGradebook({ item, onClose }: { item: AcademicWorkspace['classes'][number]; onClose: () => void }) {
  const workspace = item.workspace;
  const toast = useToast();
  const [studentQuery, setStudentQuery] = useState('');
  const [studentFilter, setStudentFilter] = useState('all');
  const [studentSort, setStudentSort] = useState('class_number');
  const [page, setPage] = useState(1);
  const [paginationEnabled, setPaginationEnabled] = useState(true);
  const visibleStudents = useMemo(() => {
    const query = studentQuery.trim();
    const queryId = normalizeStudentId(query);
    const filtered = workspace.students.filter((student) => {
      const matchesQuery = !query || student.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()) || normalizeStudentId(student.institutionalId).includes(queryId);
      if (!matchesQuery) return false;
      if (studentFilter === 'missing') return workspace.assessments.some((assessment) => workspace.scores[`${student.enrollmentId}:${assessment.id}`] == null && workspace.categoricalScores[`${student.enrollmentId}:${assessment.id}`] == null);
      if (studentFilter === 'at_risk') return risk(workspace, student.enrollmentId, workspace.evaluationSystem ?? DEFAULT_EVALUATION_SYSTEM) !== 'low';
      if (studentFilter === 'passing') return summarizeEnrollmentStanding(workspace, student.enrollmentId).remarks === 'passing';
      return true;
    });
    const originalOrder = new Map(workspace.students.map((student, index) => [student.enrollmentId, index]));
    return filtered.sort((left, right) => {
      if (studentSort === 'name') return left.name.localeCompare(right.name);
      if (studentSort === 'risk') {
        const order = { high: 0, medium: 1, low: 2, unavailable: 3 } as const;
        const leftRisk = risk(workspace, left.enrollmentId, workspace.evaluationSystem ?? DEFAULT_EVALUATION_SYSTEM) as keyof typeof order;
        const rightRisk = risk(workspace, right.enrollmentId, workspace.evaluationSystem ?? DEFAULT_EVALUATION_SYSTEM) as keyof typeof order;
        return (order[leftRisk] ?? 3) - (order[rightRisk] ?? 3);
      }
      if (studentSort === 'standing') return (calculateEnrollmentGrade(workspace, right.enrollmentId).finalGrade ?? -1) - (calculateEnrollmentGrade(workspace, left.enrollmentId).finalGrade ?? -1);
      const classNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && value.trim() && Number.isFinite(Number(value)) ? Number(value) : null;
      const leftNumber = classNumber(left.classNumber);
      const rightNumber = classNumber(right.classNumber);
      if (leftNumber != null && rightNumber != null && leftNumber !== rightNumber) return leftNumber - rightNumber;
      return (originalOrder.get(left.enrollmentId) ?? 0) - (originalOrder.get(right.enrollmentId) ?? 0);
    });
  }, [workspace, studentQuery, studentFilter, studentSort]);
  useEffect(() => { setPage(1); }, [studentQuery, studentFilter, studentSort, workspace.students.length]);
  return <Modal visible animationType="fade" onRequestClose={onClose}>
    <View style={{ flex: 1, backgroundColor: '#F5F6F8', padding: 18, gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ flex: 1 }}>
          <Text accessibilityRole="header" style={styles.title}>Gradebook · {item.code} · {item.section}</Text>
          <Text style={styles.subtitle}>{item.title} · {item.term} · Read-only full view</Text>
        </View>
        <Pressable accessibilityRole="switch" accessibilityState={{ checked: paginationEnabled }} onPress={() => { setPaginationEnabled((current) => !current); setPage(1); }} style={facultyGradebookStyles.paginationToggle}>
          <Text style={facultyGradebookStyles.paginationToggleLabel}>Pagination</Text>
          <View style={[facultyGradebookStyles.paginationSwitch, paginationEnabled && facultyGradebookStyles.paginationSwitchOn]}><View style={[facultyGradebookStyles.paginationSwitchThumb, paginationEnabled && facultyGradebookStyles.paginationSwitchThumbOn]} /></View>
          <Text style={facultyGradebookStyles.paginationToggleState}>{paginationEnabled ? 'On' : 'Off'}</Text>
        </Pressable>
        <Button label="Close" variant="secondary" onPress={onClose} />
      </View>
      <View style={{ flex: 1, minHeight: 0 }}>
        <Card style={{ flex: 1, minHeight: 0, width: '100%' }}>
        <FullAssessmentView
          readOnly
          classId={item.id}
          assessments={workspace.assessments}
          students={visibleStudents}
          allStudents={visibleStudents}
          workspace={workspace}
          gradingSystem={workspace.criteria?.gradingSystemDefinition ?? workspace.defaultGradingSystem ?? IT_GLOBAL_GRADING_SYSTEM}
          values={{}}
          onChange={() => undefined}
          onChangeMany={() => undefined}
          dirtyCount={0}
          invalidCount={0}
          saving={false}
          onSave={() => undefined}
          autosaveEnabled={false}
          studentQuery={studentQuery}
          onStudentQuery={(value) => { setStudentQuery(value); setPage(1); }}
          studentFilter={studentFilter}
          onStudentFilter={(value) => { setStudentFilter(value); setPage(1); }}
          studentSort={(studentSort as 'class_number' | 'name' | 'risk' | 'standing')}
          onStudentSort={(value) => { setStudentSort(value); setPage(1); }}
          visibleCount={visibleStudents.length}
          page={page}
          pageCount={Math.max(1, Math.ceil(visibleStudents.length / 10))}
          paginationEnabled={paginationEnabled}
          onPageChange={(update) => setPage(update)}
          onToast={(message) => toast.show(message)}
          onEditAssessment={() => undefined}
          onLoadScoreHistory={async (assessmentId, enrollmentId) => {
            const history = await loadGradebookScoreHistory(item.id, null, 200);
            return history.entries.filter((entry) => entry.eventType === 'score' && entry.assessmentId === assessmentId && entry.enrollmentId === enrollmentId).map(({ id, actorId, actorName, action, createdAt, before, after, restoredFromVersionId, batchId }) => ({ id, actorId, actorName, action, createdAt, before, after, restoredFromVersionId, batchId }));
          }}
          onLoadGradebookHistory={(classId, cursor?: GradebookHistoryCursor | null) => loadGradebookScoreHistory(classId, cursor)}
          onRestoreScoreVersion={async () => {}}
          onRestoreGradebookVersion={async () => 0}
          onRestoreAssessmentVersion={async () => {}}
          onNameGradebookVersion={async () => {}}
        />
        </Card>
      </View>
    </View>
  </Modal>;
}

function Classes({ data, refresh, toast, initialTab = 'Department classes' }: Props & { initialTab?: string }) {
  const [classesTab, setClassesTab] = useState(initialTab);
  const [references, setReferences] = useState<{ subjects: { id: string; label: string; lectureUnits: number; laboratoryUnits: number }[]; terms: { id: string; label: string }[]; faculty: DepartmentFacultyMember[]; institutionCode: string; sections: { value: string; label: string; programCode: string; yearLevel: number; sectionNumber: number }[] }>({ subjects: [], terms: [], faculty: [], institutionCode: 'SWU', sections: [] });
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
  const [confirmRejectRequest, setConfirmRejectRequest] = useState(false);
  const [requestReviewTab, setRequestReviewTab] = useState('Assign');
  const [manageFacultyClass, setManageFacultyClass] = useState<AcademicWorkspace['classes'][number] | null>(null);
  const [viewGradebookClass, setViewGradebookClass] = useState<AcademicWorkspace['classes'][number] | null>(null);
  const [rosterClassId, setRosterClassId] = useState<string | null>(null);
  const [manageFacultyIds, setManageFacultyIds] = useState<string[]>([]);
  const [savingFaculty, setSavingFaculty] = useState(false);
  const [busy, setBusy] = useState(false);
  const displaySection = (value: string) => resolveInstitutionalSectionName(value, references.sections, references.institutionCode);

  const reload = useCallback(async () => {
    try { setRequests(await loadDepartmentClassRequests()); }
    catch (cause) { toast.show(getErrorMessage(cause, 'Could not load class requests.')); }
  }, [toast]);
  useEffect(() => {
    let active = true;
    Promise.all([loadClassCreationReferences(data.department?.id), loadDepartmentClassRequests()]).then(([nextReferences, nextRequests]) => {
      if (!active) return;
      setReferences(nextReferences);
      setRequests(nextRequests);
      setSubjectId(nextReferences.subjects[0]?.id ?? '');
      setTermId(nextReferences.terms[0]?.id ?? '');
    }).catch((cause) => { if (active) toast.show(getErrorMessage(cause, 'Could not load class management data.')); });
    return () => { active = false; };
  }, [data.department?.id, toast]);

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
    const targetSection = displaySection(request?.section ?? section);
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
      if (newlyCreatedSubjectId) void loadClassCreationReferences(data.department?.id).then(setReferences).catch(() => undefined);
    } catch (cause) {
      if (newlyCreatedSubjectId) {
        setSubjectId(newlyCreatedSubjectId);
        setPendingSubject(null);
        void loadClassCreationReferences(data.department?.id).then(setReferences).catch(() => undefined);
        toast.show(`Subject saved, but the class could not be created: ${getErrorMessage(cause, 'Please try again.')}`);
      } else toast.show(getErrorMessage(cause, 'Class could not be created.'));
    }
    finally { setBusy(false); }
  };
  const rejectRequest = async () => {
    if (!selectedRequest) return;
    setBusy(true);
    try {
      await rejectAcademicAdminClassRequest(selectedRequest.id, reviewNote);
      toast.show('Class request rejected.');
      setSelectedRequest(null);
      setReviewNote('');
      setConfirmRejectRequest(false);
      await reload();
    } catch (cause) { toast.show(getErrorMessage(cause, 'Class request could not be rejected.')); }
    finally { setBusy(false); }
  };
  const saveClassFaculty = async () => {
    if (!manageFacultyClass || !manageFacultyIds.length) return;
    setSavingFaculty(true);
    try {
      await updateAcademicAdminClassFaculty(manageFacultyClass.id, manageFacultyIds);
      toast.show('Faculty assignments updated.');
      setManageFacultyClass(null);
      setManageFacultyIds([]);
      await refresh();
    } catch (cause) {
      toast.show(getErrorMessage(cause, 'Faculty assignments could not be updated.'));
    } finally {
      setSavingFaculty(false);
    }
  };
  const beginReview = (request: ClassRequestReview) => {
    setSelectedRequest(request);
    setReviewNote('');
    setRequestReviewTab('Assign');
    setFacultyIds(references.faculty.some((member) => member.userId === request.requestedBy) ? [request.requestedBy] : []);
  };
  const requestRows = requests.filter((request) => request.status === 'pending');
  const reviewedRows = requests.filter((request) => request.status !== 'pending');
  const departmentClassRows = useMemo(() => data.classes.map((item) => {
    const rows = item.workspace.students;
    const values = rows.flatMap((student) => { const value = standing(item.workspace, student.enrollmentId); return value == null ? [] : [value]; });
    return [`${item.code} · ${item.title}`, displaySection(item.section), item.term, item.assignedFaculty.map((member) => member.name).join(', ') || 'Unassigned', String(item.lectureUnits), String(item.laboratoryUnits), String(rows.length), values.length ? `${(values.reduce((a, b) => a + b, 0) / values.length).toFixed(1)}%` : '—', String(rows.filter((student) => risk(item.workspace, student.enrollmentId) !== 'low').length), <ClassActionsMenu key={`class-actions-${item.id}`} classLabel={`${item.code} · ${displaySection(item.section)}`} onManageRoster={() => setRosterClassId(item.id)} onViewGradebook={() => setViewGradebookClass(item)} onManageOptions={() => { setManageFacultyClass(item); setManageFacultyIds(item.assignedFaculty.map((member) => member.userId)); }} />];
  }), [data.classes, references.sections, references.institutionCode]);
  const rosterClass = rosterClassId ? data.classes.find((item) => item.id === rosterClassId) ?? null : null;
  const facultyPicker = (selected: string[], update: (value: string[]) => void) => (
    <View style={{ gap: 6 }}>
      <Text style={styles.cardTitle}>Assign Faculty (at least one)</Text>
      {references.faculty.length ? references.faculty.map((member) => <Pressable key={member.userId} accessibilityRole="checkbox" accessibilityState={{ checked: selected.includes(member.userId) }} onPress={() => toggleFaculty(member.userId, selected, update)} style={[styles.bulkClassRow, styles.facultyAssignRow]}>
        <AppIcon name={selected.includes(member.userId) ? 'checkboxChecked' : 'checkbox'} size={20} color={selected.includes(member.userId) ? colors.brand : colors.textMuted} /><View style={styles.flex}><Text style={styles.bulkClassName}>{member.name}</Text><Text style={styles.help}>{member.employeeId}</Text></View>
      </Pressable>) : <Text style={styles.help}>No active Faculty members are available in this department.</Text>}
    </View>
  );

  return <>
    <Heading title="Classes" subtitle="Create department classes, assign at least one Faculty member, and review Faculty class requests." action={<Button label="Create class" disabled={!references.terms.length || !references.faculty.length || !references.sections.length} onPress={() => { setFacultyIds([]); setShowCreate(true); }} />} />
    <Tabs values={['Department classes', 'Class requests']} selected={classesTab} onSelect={setClassesTab} />
    {classesTab === 'Class requests' ? <>
      <Card style={styles.form}>
        <Text style={styles.cardTitle}>Pending class requests</Text>
        {requestRows.length ? requestRows.map((request) => <View key={request.id} style={styles.savedSystemRow}>
          <View style={{ flex: 1, minWidth: 220 }}><Text style={styles.bulkClassName}>{request.subject} · {displaySection(request.section)}</Text><Text style={styles.help}>{request.term} · Lecture {request.lectureUnits} / Lab {request.laboratoryUnits} units · Requested by {request.requesterName}</Text><Text style={styles.help}>{request.rationale}</Text></View>
          <Button label="Review and assign" variant="secondary" onPress={() => beginReview(request)} />
        </View>) : <PageState kind="empty" title="No pending class requests" message="Faculty requests for new classes will appear here." />}
      </Card>
      <Card style={styles.form}>
        <Text style={styles.cardTitle}>Class request history</Text>
        {reviewedRows.length ? <DataTable columns={['Subject', 'Section', 'Term', 'Faculty requester', 'Status', 'Date', 'Review note']} rows={reviewedRows.map((request) => [request.subject, displaySection(request.section), request.term, request.requesterName, <Badge key={request.id} tone={request.status === 'approved' ? 'success' : 'danger'}>{request.status.charAt(0).toUpperCase() + request.status.slice(1)}</Badge>, new Date(request.createdAt).toLocaleDateString(), request.reviewNote ?? '—'])} /> : <PageState kind="empty" title="No class request history" message="Approved and rejected class requests will appear here." />}
      </Card>
    </> : <>
      {data.classes.length ? <DataTable columns={['Subject', 'Section', 'Term', 'Assigned faculty', 'Lecture units', 'Laboratory units', 'Students', 'Average', 'At risk', 'Actions']} columnWidths={[230, 100, 110, 210, 90, 110, 75, 90, 75, 72]} columnFlex={[2, 0, 0, 2, 0, 0, 0, 0, 0, 0]} widthMode="container" rows={departmentClassRows} /> : <PageState kind="empty" title="No active classes" message="Create a class or approve a Faculty request to get started." />}
    </>}
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
      <SelectField label="Section" value={section} options={references.sections} onChange={setSection} placeholder={references.sections.length ? 'Select a section' : 'No sections configured'} />
      {facultyPicker(facultyIds, setFacultyIds)}
      <Button label="Create and assign class" loading={busy} disabled={showAddSubject || !subjectId || !termId || !section.trim() || !facultyIds.length} onPress={() => void createClass()} />
    </Dialog>
    <Dialog visible={selectedRequest !== null} title="Review Class Request" onClose={() => { if (!busy) setSelectedRequest(null); }}>
      {selectedRequest ? <View style={{ gap: 10 }}>
        <Text style={styles.bulkClassName}>{selectedRequest.subject} · {displaySection(selectedRequest.section)}</Text>
        <Text style={styles.help}>{selectedRequest.term} · Lecture {selectedRequest.lectureUnits} / Lab {selectedRequest.laboratoryUnits} units</Text>
        <Text style={styles.help}>Requested by {selectedRequest.requesterName}: {selectedRequest.rationale}</Text>
        <Tabs values={['Assign', 'Reject request']} selected={requestReviewTab} onSelect={setRequestReviewTab} />
        {requestReviewTab === 'Assign' ? <>
          {facultyPicker(facultyIds, setFacultyIds)}
          <Button label="Approve, create, and assign" loading={busy} disabled={!facultyIds.length} onPress={() => void createClass(selectedRequest)} />
        </> : <View style={styles.rejectRequestSection}>
          <Field label="Rejection note (optional)" value={reviewNote} onChangeText={setReviewNote} multiline numberOfLines={3} placeholder="Add context for the Faculty member, if helpful." style={styles.rejectionReasonInput} />
          <Button label="Reject request…" variant="danger" disabled={busy} onPress={() => setConfirmRejectRequest(true)} />
        </View>}
      </View> : null}
    </Dialog>
    <Dialog visible={manageFacultyClass !== null} title="Manage class options" onClose={() => { if (!savingFaculty) setManageFacultyClass(null); }}>
      {manageFacultyClass ? <View style={{ gap: 10 }}>
        <Text style={styles.bulkClassName}>{manageFacultyClass.code} · {manageFacultyClass.title} · {manageFacultyClass.section}</Text>
        <Text style={styles.help}>{manageFacultyClass.term}</Text>
        {facultyPicker(manageFacultyIds, setManageFacultyIds)}
        <View style={styles.subjectFormActions}>
          <Button label="Save assignments" loading={savingFaculty} disabled={!manageFacultyIds.length} onPress={() => void saveClassFaculty()} />
          <Button label="Cancel" variant="secondary" disabled={savingFaculty} onPress={() => setManageFacultyClass(null)} />
        </View>
      </View> : null}
    </Dialog>
    {rosterClass ? <AcademicAdminClassRosterDialog item={rosterClass} programs={data.programs} toast={toast} onClose={() => setRosterClassId(null)} onChanged={refresh} /> : null}
    {viewGradebookClass ? <AcademicAdminReadOnlyGradebook item={viewGradebookClass} onClose={() => setViewGradebookClass(null)} /> : null}
    <ConfirmDialog
      visible={confirmRejectRequest}
      title="Reject this class request?"
      message={selectedRequest ? `Reject ${selectedRequest.subject} · ${selectedRequest.section}? The Faculty member will be notified. This request will not create a class.` : ''}
      confirmLabel="Confirm rejection"
      cancelLabel="Go back"
      danger
      pending={busy}
      onClose={() => { if (!busy) setConfirmRejectRequest(false); }}
      onConfirm={() => void rejectRequest()}
    />
  </>;
}

function ClassActionsMenu({ classLabel, onManageRoster, onViewGradebook, onManageOptions }: { classLabel: string; onManageRoster: () => void; onViewGradebook: () => void; onManageOptions: () => void }) {
  const triggerRef = useRef<View>(null);
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const [open, setOpen] = useState(false);
  const showMenu = () => triggerRef.current?.measureInWindow((x, y, width, height) => {
    setPosition({ left: Math.max(8, Math.min(screenWidth - 248, x + width - 240)), top: Math.max(8, Math.min(screenHeight - 168, y + height + 4)) });
    setOpen(true);
  });
  const actions = [
    { label: 'Manage class roster', icon: 'students' as const, onPress: onManageRoster },
    { label: 'View gradebook', icon: 'grades' as const, onPress: onViewGradebook },
    { label: 'Manage class options', icon: 'settings' as const, onPress: onManageOptions },
  ];
  return <>
    <Pressable ref={triggerRef} accessibilityRole="button" accessibilityLabel={`More actions for ${classLabel}`} accessibilityHint="Open class actions" onPress={showMenu} style={rosterStyles.classActionsTrigger}>
      <AppIcon name="more" size={18} color={colors.text} />
    </Pressable>
    <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
      <View style={rosterStyles.actionMenuOverlay}>
        <Pressable accessibilityRole="button" accessibilityLabel="Close class actions" onPress={() => setOpen(false)} style={StyleSheet.absoluteFill} />
        <View style={[rosterStyles.classActionMenu, position]}>
          {actions.map((action) => <Pressable key={action.label} accessibilityRole="button" onPress={() => { setOpen(false); action.onPress(); }} style={({ pressed }) => [rosterStyles.classActionMenuItem, pressed && rosterStyles.classActionMenuItemPressed]}>
            <AppIcon name={action.icon} size={16} color={colors.brand} />
            <Text style={rosterStyles.classActionMenuText}>{action.label}</Text>
          </Pressable>)}
        </View>
      </View>
    </Modal>
  </>;
}

type RosterImportFile = { name: string; kind: 'csv' | 'excel'; text?: string; data?: ArrayBuffer };
type RosterImportPreview = ReturnType<typeof previewRosterCsv>;

function AcademicAdminClassRosterDialog({ item, programs, toast, onClose, onChanged }: {
  item: AcademicWorkspace['classes'][number];
  programs: AcademicWorkspace['programs'];
  toast: ReturnType<typeof useToast>;
  onClose: () => void;
  onChanged: () => void;
}) {
  const validateStudentId = useStudentIdValidation();
  const [childDialog, setChildDialog] = useState<'add' | 'edit' | 'import' | null>(null);
  const [editingStudent, setEditingStudent] = useState<RosterStudent | null>(null);
  const [selectedEnrollmentIds, setSelectedEnrollmentIds] = useState<string[]>([]);
  const [deleteSelectedOpen, setDeleteSelectedOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [programId, setProgramId] = useState(item.workspace.students[0]?.programId ?? programs[0]?.id ?? '');
  const [configuredSections, setConfiguredSections] = useState<ProgramSectionRecord[]>([]);
  const [institutionCode, setInstitutionCode] = useState('SWU');
  const [institutionalId, setInstitutionalId] = useState('');
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [middleName, setMiddleName] = useState('');
  const [lastName, setLastName] = useState('');
  const [suffix, setSuffix] = useState('');
  const [yearLevel, setYearLevel] = useState('1');
  const [rosterFile, setRosterFile] = useState<RosterImportFile | null>(null);
  const [saving, setSaving] = useState(false);
  const yearLevels = useYearLevels(programId);
  useEffect(() => {
    let active = true;
    if (!programId) { setConfiguredSections([]); return; }
    void Promise.all([loadProgramSections(programId), loadInstitutionCode()]).then(([loaded, code]) => {
      if (!active) return;
      setConfiguredSections(loaded);
      setInstitutionCode(code);
    }).catch((cause) => { if (active) toast.show(getErrorMessage(cause, 'Could not load configured sections.')); });
    return () => { active = false; };
  }, [programId, toast]);
  const importSectionOptions = useMemo(() => {
    const programCode = programs.find((program) => program.id === programId)?.code;
    return programCode ? configuredSections.map((entry) => ({ programCode, yearLevel: entry.yearLevel, sectionNumber: entry.sectionNumber, institutionCode })) : [];
  }, [configuredSections, institutionCode, programId, programs]);
  const studentIdError = validateStudentId && institutionalId.trim() && !isValidStudentId(institutionalId) ? 'Use a 12-digit number or 05-XXXX-XXXXXX.' : undefined;
  const preview: RosterImportPreview = useMemo(() => {
    if (!rosterFile) return [];
    try { return rosterFile.kind === 'excel' ? previewRosterExcel(rosterFile.data!, importSectionOptions) : previewRosterCsv(rosterFile.text ?? '', importSectionOptions); }
    catch (cause) { return [{ rowNumber: 0, raw: {}, errors: [getErrorMessage(cause, 'Unable to read this file.')], duplicate: false, value: undefined }]; }
  }, [rosterFile, importSectionOptions]);
  const filteredStudents = useMemo(() => item.workspace.students.filter((student) => `${student.name} ${student.institutionalId} ${student.email}`.toLowerCase().includes(query.trim().toLowerCase())), [item.workspace.students, query]);
  const toggleStudentSelection = (enrollmentId: string) => setSelectedEnrollmentIds((current) => current.includes(enrollmentId) ? current.filter((id) => id !== enrollmentId) : [...current, enrollmentId]);
  const visibleSelection = filteredStudents.length > 0 && filteredStudents.every((student) => selectedEnrollmentIds.includes(student.enrollmentId));
  const toggleVisibleSelection = () => setSelectedEnrollmentIds((current) => visibleSelection
    ? current.filter((id) => !filteredStudents.some((student) => student.enrollmentId === id))
    : Array.from(new Set([...current, ...filteredStudents.map((student) => student.enrollmentId)])));
  const openAddDialog = () => {
    setEditingStudent(null);
    setProgramId(item.workspace.students[0]?.programId ?? programs[0]?.id ?? '');
    setInstitutionalId(''); setEmail(''); setFirstName(''); setMiddleName(''); setLastName(''); setSuffix(''); setYearLevel('1');
    setChildDialog('add');
  };
  const openEditDialog = (student: RosterStudent) => {
    setEditingStudent(student);
    setProgramId(student.programId);
    setInstitutionalId(student.institutionalId); setEmail(student.email); setFirstName(student.firstName); setMiddleName(student.middleName); setLastName(student.lastName); setSuffix(student.suffix);
    setYearLevel(String(student.yearLevel));
    setChildDialog('edit');
  };
  useEffect(() => {
    setProgramId(item.workspace.students[0]?.programId ?? programs[0]?.id ?? '');
    setSelectedEnrollmentIds([]);
    setQuery('');
    setChildDialog(null);
  }, [item.id, item.section]);

  const chooseRosterFile = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: ['text/csv', 'text/comma-separated-values', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel'], copyToCacheDirectory: true });
      if (result.canceled) return;
      const asset = result.assets[0];
      const response = await fetch(asset.uri);
      if (/\.(xlsx|xls)$/i.test(asset.name)) setRosterFile({ name: asset.name, kind: 'excel', data: await response.arrayBuffer() });
      else setRosterFile({ name: asset.name, kind: 'csv', text: await response.text() });
    } catch (cause) { toast.show(getErrorMessage(cause, 'Could not open the roster file.')); }
  };
  const downloadTemplate = async () => {
    const templateContent = 'institutional_id,first_name,middle_name,last_name,suffix,email,year_level,section\n2024-0001,Juan,,Dela Cruz,,juan.delacruz@example.edu,3,' + item.section;
    if (Platform.OS === 'web') {
      const XLSX = await import('xlsx-js-style');
      const workbook = XLSX.utils.book_new();
      const worksheet = XLSX.utils.aoa_to_sheet([['institutional_id', 'first_name', 'middle_name', 'last_name', 'suffix', 'email', 'year_level', 'section'], ['2024-0001', 'Juan', '', 'Dela Cruz', '', 'juan.delacruz@example.edu', 3, item.section]]);
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Roster');
      const output = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
      const url = URL.createObjectURL(new Blob([output], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'apms-roster-template.xlsx'; anchor.click(); URL.revokeObjectURL(url);
    } else await Share.share({ message: templateContent });
    toast.show('Excel roster template downloaded.');
  };
  const addStudent = async () => {
    if (!programId || studentIdError || !firstName.trim() || !lastName.trim()) return;
    setSaving(true);
    try {
      await addStudentToClass({ classId: item.id, programId, institutionalId, email, firstName, middleName, lastName, suffix, yearLevel: Number(yearLevel), section: item.section });
      toast.show('Student added to the class roster.');
      setChildDialog(null); onChanged();
    } catch (cause) { toast.show(getErrorMessage(cause, 'Student could not be added.')); }
    finally { setSaving(false); }
  };
  const editStudent = async () => {
    if (!editingStudent || !programId || studentIdError || !firstName.trim() || !lastName.trim()) return;
    setSaving(true);
    try {
      await updateStudentDetails(editingStudent.studentId, { programId, institutionalId, email, firstName, middleName, lastName, suffix, yearLevel: Number(yearLevel), section: item.section });
      toast.show('Student details updated.');
      setChildDialog(null); setEditingStudent(null); onChanged();
    } catch (cause) { toast.show(getErrorMessage(cause, 'Student details could not be updated.')); }
    finally { setSaving(false); }
  };
  const removeSelected = async () => {
    if (!selectedEnrollmentIds.length) return;
    setSaving(true);
    try {
      await removeStudentsFromClass(item.id, selectedEnrollmentIds);
      toast.show(`${selectedEnrollmentIds.length} student${selectedEnrollmentIds.length === 1 ? '' : 's'} removed from this class.`);
      setSelectedEnrollmentIds([]); setDeleteSelectedOpen(false); onChanged();
    } catch (cause) { toast.show(getErrorMessage(cause, 'Selected students could not be removed.')); }
    finally { setSaving(false); }
  };
  const importRoster = async () => {
    if (!rosterFile || !programId) return;
    setSaving(true);
    try {
      const result = rosterFile.kind === 'excel'
        ? await importRosterExcel(item.id, programId, rosterFile.name, rosterFile.data!, importSectionOptions)
        : await importRosterCsv(item.id, programId, rosterFile.name, rosterFile.text!, importSectionOptions);
      toast.show(`Roster import complete: ${result.success} imported, ${result.failures} rejected.`);
      setRosterFile(null); setChildDialog(null); onChanged();
    } catch (cause) { toast.show(getErrorMessage(cause, 'Roster import failed.')); }
    finally { setSaving(false); }
  };
  const studentRows = filteredStudents.map((student: RosterStudent) => [
    <Pressable key={`select-${student.enrollmentId}`} accessibilityRole="checkbox" accessibilityState={{ checked: selectedEnrollmentIds.includes(student.enrollmentId) }} accessibilityLabel={`Select ${student.name}`} onPress={() => toggleStudentSelection(student.enrollmentId)} style={[rosterStyles.rosterCheckbox, selectedEnrollmentIds.includes(student.enrollmentId) && rosterStyles.rosterCheckboxSelected]}><Text style={rosterStyles.rosterCheckboxMark}>{selectedEnrollmentIds.includes(student.enrollmentId) ? '✓' : ''}</Text></Pressable>,
    student.institutionalId, [student.lastName, student.suffix].filter(Boolean).join(' ') || '—', student.firstName, student.middleName || '—', student.email || '—', String(student.yearLevel),
    <Button key={`edit-${student.enrollmentId}`} label="Edit" variant="secondary" onPress={() => openEditDialog(student)} />,
  ]);
  return <>
    <Dialog wide visible title={`Manage class roster · ${item.code} · ${item.section}`} onClose={onClose}>
      <Text style={styles.help}>{item.title} · {item.term} · {item.workspace.students.length} students</Text>
      <View style={rosterStyles.rosterToolbar}>
        <SearchFilter value={query} onChange={setQuery} placeholder="Search students by name or ID" accessibilityLabel="Search class roster" containerStyle={rosterStyles.rosterSearch} inputStyle={rosterStyles.rosterSearchInput} />
        <View style={[rosterStyles.rosterActions, rosterStyles.rosterToolbarButtons]}>
          <Button label="Import roster" variant="secondary" containerStyle={rosterStyles.rosterToolbarButton} onPress={() => { setRosterFile(null); setChildDialog('import'); }} />
          <Button label="Add student" containerStyle={rosterStyles.rosterToolbarButton} onPress={openAddDialog} />
          {selectedEnrollmentIds.length ? <Button label={`Remove selected (${selectedEnrollmentIds.length})`} variant="danger" containerStyle={rosterStyles.rosterToolbarButton} onPress={() => setDeleteSelectedOpen(true)} /> : null}
        </View>
      </View>
      {studentRows.length ? <DataTable columns={['Select', 'Student ID', 'Last Name', 'First name', 'Middle name', 'Email', 'Year', 'Actions']} rows={studentRows} columnWidths={[52, 145, 185, 190, 125, 220, 70, 90]} columnFlex={[0, 0, 1, 1.4, 0.8, 1.4, 0, 0]} columnHeaderContent={[<Pressable key="select-all" accessibilityRole="checkbox" accessibilityLabel="Select all matching students" accessibilityState={{ checked: visibleSelection }} onPress={toggleVisibleSelection} style={[rosterStyles.rosterCheckbox, visibleSelection && rosterStyles.rosterCheckboxSelected]}><Text style={rosterStyles.rosterCheckboxMark}>{visibleSelection ? '✓' : ''}</Text></Pressable>]} widthMode="container" /> : <PageState kind="empty" title={query ? 'No matching students' : 'No students in this class'} message={query ? 'Try another name, ID, or email.' : 'Add a student or import a roster to get started.'} />}
    </Dialog>
    <Dialog visible={childDialog === 'add'} title="Add student to class" onClose={() => { if (!saving) setChildDialog(null); }}>
      <SelectField label="Program" value={programId} options={programs.map((program) => ({ label: `${program.code} · ${program.name}`, value: program.id }))} onChange={setProgramId} />
      <View style={styles.formGrid}>
        <View style={{ width: '100%', flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
          <Field label="First name" value={firstName} containerStyle={{ flex: 1, flexBasis: 120, minWidth: 100 }} onChangeText={setFirstName} />
          <Field label="Middle name (optional)" value={middleName} containerStyle={{ flex: 1, flexBasis: 120, minWidth: 100 }} onChangeText={setMiddleName} />
          <Field label="Last name" value={lastName} containerStyle={{ flex: 1, flexBasis: 120, minWidth: 100 }} onChangeText={setLastName} />
          <Field label="Suffix (optional)" value={suffix} containerStyle={{ flex: 1, flexBasis: 120, minWidth: 100 }} onChangeText={setSuffix} />
        </View>
        <View style={{ width: '100%', flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
          <Field label="Student ID" value={institutionalId} error={studentIdError} containerStyle={{ flex: 1, flexBasis: 220, minWidth: 180 }} onChangeText={setInstitutionalId} />
          <Field label="Email" value={email} keyboardType="email-address" containerStyle={{ flex: 1, flexBasis: 220, minWidth: 180 }} onChangeText={setEmail} />
        </View>
        <SelectField label="Year level" value={yearLevel} options={yearLevels.map((level) => ({ label: level.label, value: String(level.level) }))} onChange={setYearLevel} />
      </View>
      <Button label="Add to class roster" loading={saving} disabled={!programId || !institutionalId.trim() || !firstName.trim() || !lastName.trim() || Boolean(studentIdError)} onPress={() => void addStudent()} />
    </Dialog>
    <Dialog visible={childDialog === 'edit'} title="Edit student details" onClose={() => { if (!saving) { setChildDialog(null); setEditingStudent(null); } }}>
      <SelectField label="Program" value={programId} options={programs.map((program) => ({ label: `${program.code} · ${program.name}`, value: program.id }))} onChange={setProgramId} />
      <View style={styles.formGrid}>
        <View style={{ width: '100%', flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
          <Field label="First name" value={firstName} containerStyle={{ flex: 1, flexBasis: 120, minWidth: 100 }} onChangeText={setFirstName} />
          <Field label="Middle name (optional)" value={middleName} containerStyle={{ flex: 1, flexBasis: 120, minWidth: 100 }} onChangeText={setMiddleName} />
          <Field label="Last name" value={lastName} containerStyle={{ flex: 1, flexBasis: 120, minWidth: 100 }} onChangeText={setLastName} />
          <Field label="Suffix (optional)" value={suffix} containerStyle={{ flex: 1, flexBasis: 120, minWidth: 100 }} onChangeText={setSuffix} />
        </View>
        <View style={{ width: '100%', flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
          <Field label="Student ID" value={institutionalId} error={studentIdError} containerStyle={{ flex: 1, flexBasis: 220, minWidth: 180 }} onChangeText={setInstitutionalId} />
          <Field label="Email" value={email} keyboardType="email-address" containerStyle={{ flex: 1, flexBasis: 220, minWidth: 180 }} onChangeText={setEmail} />
        </View>
        <SelectField label="Year level" value={yearLevel} options={yearLevels.map((level) => ({ label: level.label, value: String(level.level) }))} onChange={setYearLevel} />
      </View>
      <Button label="Save student details" loading={saving} disabled={!programId || !institutionalId.trim() || !firstName.trim() || !lastName.trim() || Boolean(studentIdError)} onPress={() => void editStudent()} />
    </Dialog>
    <Dialog visible={childDialog === 'import'} title="Import class roster" onClose={() => { if (!saving) setChildDialog(null); }}>
      <SelectField label="Program for imported students" value={programId} options={programs.map((program) => ({ label: `${program.code} · ${program.name}`, value: program.id }))} onChange={setProgramId} />
      <Text style={styles.help}>Choose an Excel or CSV roster. APMS validates sections against the selected program, converts recognized short or institution-wide names to the program format, and reports invalid or duplicate records before import.</Text>
      <View style={rosterStyles.rosterActions}><Button label="Choose Excel or CSV" variant="secondary" onPress={() => void chooseRosterFile()} /><Button label="Download Excel template" variant="ghost" onPress={() => void downloadTemplate()} /></View>
      {rosterFile ? <>
        <Text style={styles.cardTitle}>{rosterFile.name}</Text>
        <Text style={styles.help}>{preview.length} rows found · {preview.filter((row) => !row.errors.length).length} valid · {preview.filter((row) => row.errors.length).length} invalid</Text>
        {preview.length ? <DataTable columns={['Row', 'Student ID', 'Name', 'Validation']} rows={preview.map((row) => [String(row.rowNumber), row.raw.institutional_id ?? '—', formatStudentName({ firstName: row.raw.first_name, middleName: row.raw.middle_name, lastName: row.raw.last_name, suffix: row.raw.suffix }), row.errors.join('; ') || 'Valid'])} /> : null}
        <Button label="Import valid rows" loading={saving} disabled={!programId || !preview.some((row) => row.value && !row.errors.length && !row.duplicate)} onPress={() => void importRoster()} />
      </> : null}
    </Dialog>
    <ConfirmDialog visible={deleteSelectedOpen} title="Remove selected students?" message={`Remove ${selectedEnrollmentIds.length} selected student${selectedEnrollmentIds.length === 1 ? '' : 's'} from this class? Their scores, attendance, and monitoring records for this class will also be removed. Student identities remain available for other classes.`} confirmLabel="Remove students" cancelLabel="Keep students" danger pending={saving} onClose={() => { if (!saving) setDeleteSelectedOpen(false); }} onConfirm={() => void removeSelected()} />
  </>;
}

function Risk({ data, refresh, userId, toast }: Props) {
  const [query, setQuery] = useState('');
  const [classFilter, setClassFilter] = useState('all');
  const [riskFilter, setRiskFilter] = useState('all');
  const [trendFilter, setTrendFilter] = useState<'all' | 'declining' | 'stable' | 'improving'>('all');
  const [concernFilter, setConcernFilter] = useState('all');
  const [showPredictionMetadata, setShowPredictionMetadata] = useState(false);
  const [gradeColumnView, setGradeColumnView] = useState<'summary' | 'recorded'>('summary');
  const [predictionRunning, setPredictionRunning] = useState(false);
  const [predictionRunError, setPredictionRunError] = useState<string | null>(null);
  const [selectedStudentRow, setSelectedStudentRow] = useState<any>(null);
  const runLock = useRef(false);
  const definitions = [...new Map(data.classes.map((item) => {
    const definition = item.workspace.evaluationSystem ?? data.evaluationSystem ?? DEFAULT_EVALUATION_SYSTEM;
    return [definition.id, definition] as const;
  })).values()];
  const rows = useMemo(() => allStudents(data).map((row) => {
    const workspace = row.item.workspace;
    const enrollmentId = row.student.enrollmentId;
    const evaluation = workspace.evaluations[enrollmentId];
    const result = row.evaluationResult;
    const definition = row.riskDefinition;
    const level = definition.levels.find((item) => item.id === result.matchedLevelId);
    const factorById = new Map(definition.factors.map((factor) => [factor.id, factor]));
    const matchedFactors = result.matchedRuleIds.flatMap((ruleId) => {
      const index = Number(ruleId.slice(ruleId.lastIndexOf(':') + 1));
      const factor = level ? factorById.get(level.rules[index]?.factorId) : undefined;
      return factor ? [factor] : [];
    });
    const assessmentCount = workspace.assessments.length;
    const missing = workspace.assessments.filter((assessment) => workspace.scores[`${enrollmentId}:${assessment.id}`] == null && workspace.categoricalScores[`${enrollmentId}:${assessment.id}`] == null).length;
    const scoreHistory = workspace.assessments.flatMap((assessment) => {
      const key = `${enrollmentId}:${assessment.id}`;
      const category = workspace.categoricalScores[key];
      if (category != null) {
        const typeId = assessment.gradingTypeId ?? assessment.component;
        const grading = workspace.criteria?.gradingSystemDefinition ?? workspace.defaultGradingSystem ?? IT_GLOBAL_GRADING_SYSTEM;
        const definition = grading.components.find((component: any) => component.assessmentDefinition?.typeId === typeId)?.assessmentDefinition;
        const percentage = definition?.scoring?.mode === 'value_mapping' ? definition.scoring.mapping.find((item: any) => String(item.value) === category)?.percentage : undefined;
        return percentage == null ? [] : [percentage];
      }
      const score = workspace.scores[key];
      return Number.isFinite(score) && assessment.maximumScore > 0 ? [score / assessment.maximumScore * 100] : [];
    });
    const trendWindow = definition.factors.find((factor) => factor.source === 'recent_trend')?.windowSize ?? 5;
    const recentTrend = scoreHistory.slice(-trendWindow);
    const trend = evaluation?.trend && evaluation.trend !== 'unknown' ? evaluation.trend : recentTrend.length > 1 ? calculateTrend(recentTrend) : 'unknown';
    const current = row.summary.finalGrade ?? row.summary.p3 ?? row.summary.effortfulLearning ?? row.summary.mastery;
    const decline = current != null && evaluation?.predictedStanding != null ? current - evaluation.predictedStanding : null;
    const reasons = level && result.matchedRuleIds.length ? result.matchedRuleIds.flatMap((ruleId) => {
      const index = Number(ruleId.slice(ruleId.lastIndexOf(':') + 1));
      const rule = level.rules[index];
      const factor = rule ? factorById.get(rule.factorId) : undefined;
      return rule && factor ? [rule.description || `${factor.name} ${rule.operator.replaceAll('_', ' ')} ${Array.isArray(rule.threshold) ? rule.threshold.join(', ') : rule.threshold}`] : [];
    }).join('; ') : result.severity === 'unavailable' ? 'Insufficient configured evaluation data' : 'No configured risk rule matched';
    return { ...row, calculated: calculateEnrollmentGrade(workspace, enrollmentId), evaluation, trend, missing, decline, current, reasons, concernIds: [...new Set(matchedFactors.map((factor) => `${definition.id}:${factor.id}`))] };
  }), [data, definitions.length]);
  const riskOptions = [
    { label: 'All students', value: 'all' },
    { label: 'Requires Attention', value: 'attention' },
    ...evaluationRiskOptions(definitions, 'All students').filter((option) => option.value.startsWith('level:')),
    { label: 'Any high-severity level', value: 'severity:high' },
    { label: 'Any medium-severity level', value: 'severity:medium' },
    { label: 'Any low-severity level', value: 'severity:low' },
    { label: 'No matching risk level', value: 'unmatched' },
    { label: 'Risk unavailable', value: 'unavailable' },
  ];
  const concernFactorOptions = new Map(definitions.flatMap((definition) => {
    const used = new Set(definition.levels.flatMap((level) => level.rules.map((rule) => rule.factorId)));
    return definition.factors.filter((factor) => used.has(factor.id)).map((factor) => [`${definition.id}:${factor.id}`, { label: `${factor.name}${definitions.length > 1 ? ` · ${definition.name}` : ''}`, value: `${definition.id}:${factor.id}` }] as const);
  }));
  const concernOptions = [{ label: 'All evaluation factors', value: 'all' }, { label: 'Missing assessments', value: 'missing' }, ...concernFactorOptions.values()];
  const classRows = useMemo(() => rows.filter((row) => classFilter === 'all' || row.item.id === classFilter), [classFilter, rows]);
  const filteredRows = useMemo(() => classRows.filter((row) => {
    const normalizedQuery = query.trim().toLowerCase();
    if (normalizedQuery && !row.student.name.toLowerCase().includes(normalizedQuery) && !row.student.institutionalId.toLowerCase().replace(/[^a-z0-9]/g, '').includes(normalizedQuery.replace(/[^a-z0-9]/g, ''))) return false;
    if (riskFilter === 'attention' && row.risk !== 'medium' && row.risk !== 'high') return false;
    if (riskFilter === 'severity:high' && row.risk !== 'high') return false;
    if (riskFilter === 'severity:medium' && row.risk !== 'medium') return false;
    if (riskFilter === 'severity:low' && row.risk !== 'low') return false;
    if (riskFilter !== 'attention' && riskFilter !== 'all' && !riskFilter.startsWith('severity:') && row.riskValue !== riskFilter) return false;
    if (trendFilter !== 'all' && row.trend !== trendFilter) return false;
    if (concernFilter === 'missing' && row.missing === 0) return false;
    if (concernFilter !== 'all' && concernFilter !== 'missing' && !row.concernIds.includes(concernFilter)) return false;
    return true;
  }).sort((a, b) => {
    const riskRank = { high: 0, medium: 1, low: 2, unavailable: 3, unknown: 3 } as const;
    const riskDelta = (riskRank[a.risk as keyof typeof riskRank] ?? 3) - (riskRank[b.risk as keyof typeof riskRank] ?? 3);
    return riskDelta || (b.decline ?? -1) - (a.decline ?? -1) || (a.rate ?? 101) - (b.rate ?? 101) || b.missing - a.missing || (a.current ?? 101) - (b.current ?? 101);
  }), [classRows, concernFilter, query, riskFilter, trendFilter]);
  const attentionCount = classRows.filter((row) => row.risk === 'medium' || row.risk === 'high').length;
  const highCount = classRows.filter((row) => row.risk === 'high').length;
  const mediumCount = classRows.filter((row) => row.risk === 'medium').length;
  const decliningCount = classRows.filter((row) => row.trend === 'declining').length;
  const missingCount = classRows.filter((row) => row.missing > 0).length;
  const selectedClass = data.classes.find((item) => item.id === classFilter) ?? null;
  const selectedGradingDefinition = selectedClass?.workspace.criteria?.gradingSystemDefinition ?? selectedClass?.workspace.defaultGradingSystem ?? IT_GLOBAL_GRADING_SYSTEM;
  const selectedEvaluationDefinition = selectedClass?.workspace.evaluationSystem ?? data.evaluationSystem ?? DEFAULT_EVALUATION_SYSTEM;
  const supportsPredictionMetadata = (selectedClass ? [selectedEvaluationDefinition] : definitions).some((definition) => definition.ai?.enabled === true
    && ['generated_at', 'model_version'].some((field) => isForecastOutputEnabled(definition, field)));
  const hasPredictedStandingOutput = selectedClass
    ? isForecastOutputEnabled(selectedEvaluationDefinition, 'predicted_standing')
    : definitions.some((definition) => isForecastOutputEnabled(definition, 'predicted_standing'));
  const recordedAssessmentColumns = selectedClass ? buildRecordedAssessmentColumns(selectedClass.workspace.assessments.map((assessment) => {
    const typeId = assessment.gradingTypeId ?? assessment.component;
    const assessmentDefinition = selectedGradingDefinition.components.find((component: any) => component.assessmentDefinition?.typeId === typeId)?.assessmentDefinition;
    return {
      id: assessment.id,
      title: assessment.title,
      assessmentDate: assessment.assessmentDate,
      maximumScore: assessment.maximumScore,
      categorical: assessmentDefinition?.scoring?.mode === 'value_mapping',
    };
  })) : [];
  const runClassPredictions = async () => {
    if (!selectedClass || runLock.current) return;
    runLock.current = true;
    setPredictionRunning(true);
    setPredictionRunError(null);
    let completed = 0;
    let requested = 0;
    try {
      // Refresh the selected class's applied schemas immediately before inference.
      const predictionWorkspace = await loadAcademicClassWorkspace(userId, data.department!.id, selectedClass.id);
      const gradingDefinition = predictionWorkspace.criteria?.gradingSystemDefinition ?? predictionWorkspace.defaultGradingSystem ?? IT_GLOBAL_GRADING_SYSTEM;
      const evaluationDefinition = predictionWorkspace.evaluationSystem ?? data.evaluationSystem ?? DEFAULT_EVALUATION_SYSTEM;
      if (!validateGradingSystem(gradingDefinition).valid) throw forecastError('invalid_grading');
      if (!validateEvaluationSystem(evaluationDefinition).valid) throw forecastError('invalid_criteria');
      const inputs = buildClassPredictionInputs(predictionWorkspace, evaluationDefinition);
      requested = inputs.length;
      if (!requested) throw forecastError('no_eligible_students');
      const assessmentInstances = buildClassAssessmentConstraints(predictionWorkspace);
      const request = { class_id: selectedClass.id, grading_system: gradingDefinition, evaluation_criteria: evaluationDefinition };
      const batches = planPredictionRequestBatches(request, inputs, {
        maxBytes: 900_000,
        maxItems: predictionBatchItemLimit(evaluationDefinition.ai?.provider),
        encodeItem: (input) => encodePredictionInput(input, evaluationDefinition),
      });
      for (const batch of batches) {
        const result = await runAiPredictions(selectedClass.id, gradingDefinition, evaluationDefinition, batch.items, assessmentInstances);
        completed += result.predictions.length;
      }
      toast.show(`Saved advisory forecasts for ${completed} eligible students in ${selectedClass.code} · ${selectedClass.section}.`);
      refresh();
    } catch (cause) {
      const message = completed
        ? `Saved forecasts for ${completed} of ${requested} eligible students. The remaining batch did not complete. ${formatForecastError(cause)}`
        : formatForecastError(cause);
      setPredictionRunError(message);
      toast.show(message);
      if (completed) refresh();
    } finally {
      runLock.current = false;
      setPredictionRunning(false);
    }
  };
  const clearFilters = () => { setQuery(''); setRiskFilter('all'); setTrendFilter('all'); setConcernFilter('all'); };
  const gradeDetailCount = gradeColumnView === 'recorded' && selectedClass ? recordedAssessmentColumns.length : 3;
  const tableColumns = ['Student', 'Class', ...(gradeColumnView === 'recorded' && selectedClass ? recordedAssessmentColumns.map((column) => column.label) : ['Period 1', 'Period 2', 'Period 3']), 'Final percentage', 'Point / letter grade', 'Risk level', 'Matched evaluation rules', ...(hasPredictedStandingOutput ? ['Predicted standing'] : []), 'AI risk probability', 'Attendance', 'Trend', ...(showPredictionMetadata ? ['Prediction generated', 'AI provider', 'AI model', 'Model version'] : [])];
  const tableColumnWidths = [220, 190, ...(gradeColumnView === 'recorded' && selectedClass ? recordedAssessmentColumns.map(() => 150) : [100, 100, 100]), 110, 130, 150, 300, ...(hasPredictedStandingOutput ? [130] : []), 140, 100, 100, ...(showPredictionMetadata ? [175, 130, 180, 130] : [])];
  const tableRows = filteredRows.map((row) => [
    `${row.student.name} · ${row.student.institutionalId}`,
    `${row.item.code} · ${row.item.section}`,
    ...(gradeColumnView === 'recorded' && selectedClass ? recordedAssessmentColumns.map((column) => formatRecordedAssessmentScore(selectedClass.workspace.scores[`${row.student.enrollmentId}:${column.key}`] ?? selectedClass.workspace.categoricalScores[`${row.student.enrollmentId}:${column.key}`], column.maximumScore, column.categorical)) : [row.summary.p1, row.summary.p2, row.summary.p3].map((value) => value == null ? '—' : `${value.toFixed(1)}%`)),
    row.current == null ? 'Missing' : `${row.current.toFixed(1)}%`,
    row.calculated.pointGrade == null ? '—' : `${row.calculated.pointGrade.toFixed(2)}${row.calculated.letterGrade ? ` / ${row.calculated.letterGrade}` : ''}`,
    <Badge key={`${row.student.enrollmentId}-risk`} color={row.risk === 'unavailable' ? '#64748B' : row.riskLevelColor ?? '#64748B'}>{row.riskLevelName}</Badge>,
    row.reasons,
    ...(hasPredictedStandingOutput ? [row.evaluation?.predictedStanding == null ? 'Unavailable' : `${row.evaluation.predictedStanding.toFixed(1)}%`] : []),
    row.evaluation?.riskProbability == null ? 'Unavailable' : `${(row.evaluation.riskProbability * 100).toFixed(1)}%`,
    row.rate == null ? 'No data' : `${row.rate.toFixed(0)}%`,
    row.trend,
    ...(showPredictionMetadata ? [
      row.evaluation?.predictionGeneratedAt ? new Date(row.evaluation.predictionGeneratedAt).toLocaleString() : 'Not recorded',
      row.evaluation?.modelProvider ?? '—', row.evaluation?.modelName ?? '—', row.evaluation?.modelVersion ?? '—',
    ] : []),
  ]);
  return <>
    <Heading title="At-Risk Students" subtitle="Review criteria-based risk alongside available AI forecasts across your department. Predictions are advisory, not official grades." action={<View style={styles.bulkClassActions}>{supportsPredictionMetadata ? <Button compact label={showPredictionMetadata ? 'Hide model details' : 'Show model details'} variant="secondary" onPress={() => setShowPredictionMetadata((visible) => !visible)} /> : null}<Button label={selectedClass ? 'Run AI predictions' : 'Select a class to run predictions'} loading={predictionRunning} disabled={!selectedClass || predictionRunning} onPress={() => void runClassPredictions()} /></View>} />
    {predictionRunError ? <Card><Text style={styles.help}>{predictionRunError}</Text></Card> : null}
    {predictionRunning ? <Card><Text style={styles.help}>Saving forecasts for the selected class roster. Larger classes may take longer.</Text></Card> : null}
    <View style={styles.riskMetrics}>
      <Pressable style={styles.riskMetric} onPress={() => setRiskFilter('attention')}><Text style={styles.riskMetricValue}>{attentionCount}</Text><Text style={styles.riskMetricLabel}>Require attention</Text></Pressable>
      <Pressable style={styles.riskMetric} onPress={() => setRiskFilter('severity:high')}><Text style={[styles.riskMetricValue, styles.riskDangerText]}>{highCount}</Text><Text style={styles.riskMetricLabel}>High risk</Text></Pressable>
      <Pressable style={styles.riskMetric} onPress={() => setRiskFilter('severity:medium')}><Text style={[styles.riskMetricValue, styles.riskWarningText]}>{mediumCount}</Text><Text style={styles.riskMetricLabel}>Medium risk</Text></Pressable>
      <Pressable style={styles.riskMetric} onPress={() => setTrendFilter('declining')}><Text style={styles.riskMetricValue}>{decliningCount}</Text><Text style={styles.riskMetricLabel}>Declining</Text></Pressable>
      <Pressable style={styles.riskMetric} onPress={() => setConcernFilter('missing')}><Text style={styles.riskMetricValue}>{missingCount}</Text><Text style={styles.riskMetricLabel}>Missing work</Text></Pressable>
    </View>
    <Card>
      <View style={styles.riskToolbar}>
        <SearchFilter value={query} onChange={setQuery} placeholder="Search students..." accessibilityLabel="Search students" containerStyle={styles.riskSearch} />
        <SelectField label="Class" value={classFilter} options={[{ label: 'All department classes', value: 'all' }, ...data.classes.map((item) => ({ label: `${item.code} · ${item.section}`, value: item.id }))]} onChange={(value) => { setClassFilter(value); setGradeColumnView('summary'); setShowPredictionMetadata(false); setPredictionRunError(null); }} containerStyle={styles.riskFilter} />
        <SelectField label="Risk" value={riskFilter} options={riskOptions} onChange={setRiskFilter} containerStyle={styles.riskFilter} />
        <SelectField label="Trend" value={trendFilter} options={[{ label: 'All Trends', value: 'all' }, { label: 'Declining', value: 'declining' }, { label: 'Stable', value: 'stable' }, { label: 'Improving', value: 'improving' }]} onChange={(value) => setTrendFilter(value as typeof trendFilter)} containerStyle={styles.riskFilter} />
        <SelectField label="Concern" value={concernFilter} options={concernOptions} onChange={setConcernFilter} containerStyle={styles.riskFilter} />
        <SelectField label="Grade columns" value={gradeColumnView} options={[{ label: 'Summary', value: 'summary' }, { label: 'Recorded details', value: 'recorded' }]} onChange={(value) => setGradeColumnView(value as typeof gradeColumnView)} disabled={!selectedClass} containerStyle={styles.riskFilter} />
      </View>
      <Text style={styles.help}>{selectedClass ? `Grades use ${selectedGradingDefinition.name}; risk levels and matched rules use ${selectedEvaluationDefinition.name}.` : 'Risk levels and matched rules use the evaluation criteria applied to each class. Select a class to view recorded assessment details or run AI predictions.'}</Text>
      {filteredRows.length ? <DataTable columns={tableColumns} rows={tableRows} onRowPress={(tableRow) => { setSelectedStudentRow(filteredRows.find((row) => `${row.student.name} · ${row.student.institutionalId}` === String(tableRow[0])) ?? null); }} columnWidths={tableColumnWidths} highlightCell={(tableRow, columnIndex) => columnIndex === 2 + gradeDetailCount && filteredRows.find((row) => `${row.student.name} · ${row.student.institutionalId}` === String(tableRow[0]))?.summary.remarks === 'failing'} /> : <PageState kind="empty" title={riskFilter === 'attention' && !attentionCount ? 'No students currently require attention' : 'No students match the selected filters'} message={riskFilter === 'attention' && !attentionCount ? 'Based on the applied evaluation criteria and available records, no students in this department currently meet the attention criteria.' : 'Try clearing one or more filters.'} action={<Button label={riskFilter === 'attention' && !attentionCount ? 'View all students' : 'Clear filters'} variant="secondary" onPress={() => riskFilter === 'attention' && !attentionCount ? setRiskFilter('all') : clearFilters()} />} />}
      <Text style={styles.riskCount}>{filteredRows.length} student record{filteredRows.length === 1 ? '' : 's'} shown · sorted by risk and urgency</Text>
    </Card>
    {selectedStudentRow ? <StudentDetail student={selectedStudentRow.student} workspace={selectedStudentRow.item.workspace} onClose={() => setSelectedStudentRow(null)} /> : null}
  </>;
}
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
            columns={['Code', 'Title', 'Lecture units', 'Laboratory units', 'Requested By', 'Rationale', 'Action']}
            rows={pendingRequests.map((req) => [
              req.code,
              req.title,
              String(req.lectureUnits),
              String(req.laboratoryUnits),
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
            columns={['Code', 'Title', 'Lecture units', 'Laboratory units', 'Status', 'Date', 'Review note']}
            rows={pastRequests.slice(0, 10).map((req) => [
              req.code,
              req.title,
              String(req.lectureUnits),
              String(req.laboratoryUnits),
              <Badge key={`past-${req.id}`} tone={req.status === 'approved' ? 'success' : 'danger'}>
                {req.status.charAt(0).toUpperCase() + req.status.slice(1)}
              </Badge>,
              new Date(req.createdAt).toLocaleDateString(),
              req.reviewNote || '—',
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
            <Text style={styles.dialogHeader}>{selectedRequest.title}</Text>
            <Text style={styles.help}>Lecture units: {selectedRequest.lectureUnits} · Laboratory units: {selectedRequest.laboratoryUnits}</Text>
            <Text style={styles.help}>Requested by: {selectedRequest.requesterName}</Text>
            <View style={styles.rationaleSummary}>
              <Text style={styles.rationaleLabel}>Request Reason</Text>
              <Text style={styles.rationaleText}>{selectedRequest.rationale}</Text>
            </View>
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
                label="Review Note (optional)"
                value={reviewNote}
                onChangeText={setReviewNote}
                multiline
                numberOfLines={3}
                placeholder="Add context for the Faculty member, if helpful."
              />
            ) : null}
            <Button
              label={reviewDecision === 'approved' ? 'Approve & Activate Subject' : 'Reject Request'}
              variant={reviewDecision === 'approved' ? 'primary' : 'danger'}
              loading={saving}
              onPress={() => void submitReview()}
            />
          </View>
        ) : null}
      </Dialog>
    </>
  );
}

function Dialog({ visible, title, onClose, children, wide = false }: { visible: boolean; title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Card style={[styles.dialog, wide && styles.wideDialog]}>
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
  screen: { width: '100%', alignSelf: 'stretch', gap: 14 },
  unitSection: { gap: 12, marginTop: 8 },
  unitSectionTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  heading: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  headingCopy: { flex: 1, minWidth: 240 },
  flex: { flex: 1 },
  title: { color: colors.text, fontSize: 22, lineHeight: 30, fontWeight: '700' },
  subtitle: { color: colors.textMuted, fontSize: 13, lineHeight: 19, marginTop: 3 },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  riskMetrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  riskMetric: { flexGrow: 1, flexBasis: 140, minWidth: 130, padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 10, backgroundColor: colors.surface },
  riskMetricValue: { color: colors.text, fontSize: 20, lineHeight: 26, fontWeight: '700' },
  riskMetricLabel: { color: colors.textMuted, fontSize: 12 },
  riskDangerText: { color: colors.danger },
  riskWarningText: { color: colors.warning },
  riskToolbar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', gap: 10, marginBottom: 8 },
  riskSearch: { flex: 1, flexBasis: 220, minWidth: 220, maxWidth: 420 },
  riskFilter: { flexGrow: 1, flexBasis: 160, minWidth: 150 },
  riskCount: { marginTop: 10, color: colors.textMuted, fontSize: 12 },
  studentRiskDetails: { gap: 10 },
  studentRiskDetailGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  studentRiskDetail: { flexGrow: 1, flexBasis: 140, minWidth: 130, gap: 3, padding: 10, borderRadius: 8, backgroundColor: colors.canvas },
  cardTitle: { color: colors.text, fontSize: 15, fontWeight: '700', marginBottom: 12 },
  form: { width: '100%', alignSelf: 'stretch', gap: 12 },
  deadlineCard: { gap: 8, width: '100%', maxWidth: '100%', alignSelf: 'stretch' },
  deadlineCardTitle: { marginBottom: 0 },
  deadlineCardHeader: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  savedSystemHeader: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 12 },
  savedSystemRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#E3E7EE' },
  bulkClassActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  bulkClassRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: 12, borderWidth: 1, borderColor: '#E3E7EE', borderRadius: 10 },
  facultyAssignRow: { gap: 8, paddingVertical: 8, paddingHorizontal: 10 },
  rejectRequestSection: { gap: 8, marginTop: 2, padding: 12, borderWidth: 1, borderColor: '#F2C7C4', borderRadius: 10, backgroundColor: '#FFF8F7' },
  rejectionReasonInput: { paddingTop: 14, textAlignVertical: 'top' },
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
  requestReasonBox: { flex: 1, flexBasis: 240, minWidth: 220, gap: 4, paddingHorizontal: 10, paddingTop: 14, paddingBottom: 10, marginTop: 0, borderRadius: 8, backgroundColor: colors.canvas },
  requestNotesGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 5 },
  requestNoteFullWidth: { flexBasis: '100%' },
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
  wideDialog: { maxWidth: 1240, maxHeight: '94%' },
  dialogTitle: { fontSize: 19, fontWeight: '700', color: colors.text },
  dialogBody: { marginTop: 16 },
  dialogContent: { gap: 12 },
  dialogHeader: { fontSize: 16, fontWeight: '600', color: colors.text },
  rationaleSummary: { gap: 3, paddingVertical: 4 },
  rationaleLabel: { color: colors.textMuted, fontSize: 12, fontWeight: '600' },
  rationaleText: { color: colors.textMuted, fontSize: 13, lineHeight: 18 },
  analyticsCharts: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  close: { fontSize: 28, color: colors.textMuted },
});

const rosterStyles = StyleSheet.create({
  rosterToolbar: { width: '100%', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  rosterSearch: { flex: 1, flexBasis: 300, minWidth: 240, width: 'auto', height: 36, paddingHorizontal: 8, paddingVertical: 0 },
  rosterSearchInput: { fontSize: 15, paddingHorizontal: 4 },
  rosterToolbarButtons: { justifyContent: 'flex-end' },
  rosterToolbarButton: { height: 36, minHeight: 36 },
  classActionsTrigger: { width: 36, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 7, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  actionMenuOverlay: { flex: 1, backgroundColor: 'rgba(15, 23, 42, 0.08)' },
  classActionMenu: { position: 'absolute', width: 240, paddingVertical: 5, borderRadius: 9, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, shadowColor: '#101828', shadowOpacity: 0.16, shadowRadius: 12, shadowOffset: { width: 0, height: 5 }, elevation: 20 },
  classActionMenuItem: { minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12 },
  classActionMenuItemPressed: { backgroundColor: colors.surfaceMuted },
  classActionMenuText: { color: colors.text, fontSize: 12, fontWeight: '600' },
  rosterActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  rosterCheckbox: { width: 22, height: 22, borderWidth: 1, borderColor: colors.border, borderRadius: 5, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  rosterCheckboxSelected: { borderColor: colors.brand, backgroundColor: colors.brand },
  rosterCheckboxMark: { color: '#FFFFFF', fontSize: 14, lineHeight: 17, fontWeight: '700' },
});
