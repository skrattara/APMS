import { getErrorMessage } from '@/services/errors';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Modal, Platform, Pressable, Share, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/auth/AuthProvider';
import { supabase } from '@/services/supabase';
import { Badge, Button, Card, ConfirmDialog, DataTable, Field, HelpTooltip, MetricCard, PageState, RefreshIndicator, SelectField, useToast } from '@/components/ui';
import { useAnalyticsFilters } from '@/components/charts/AnalyticsFilters';
import { VisualizationPanel } from '@/components/charts/VisualizationPanel';
import {
  academicReportCsv, loadAcademicWorkspace, loadDepartmentSubjects, loadSubjectRequests,
  applyDepartmentEvaluationCriteriaToClasses, applyPersonalEvaluationCriteriaToClasses, deleteDepartmentEvaluationCriteria, deletePersonalEvaluationCriteria, manageSubject, reviewSubjectRequest, saveDepartmentEvaluationCriteria, savePersonalEvaluationSystem, type AcademicSubject, type AcademicSubjectRequest, type AcademicWorkspace, type SavedEvaluationSystem,
} from '@/services/academic';
import { applyGradingSystemToClasses, deleteGradingSystem, saveGradingSystem, summarizeEnrollmentStanding, type ClassWorkspace } from '@/services/faculty';
import { calculateGradingSystem, calculateTrend, IT_GLOBAL_GRADING_SYSTEM, validateGradingSystem, type GradingDefinition } from '@apms/domain';
import { createGradingDefinitionId, GradingSystemBuilderForm } from '@/components/GradingSystemBuilderForm';
import { EvaluationSystemBuilderForm } from '@/components/EvaluationSystemBuilderForm';
import { DEFAULT_EVALUATION_SYSTEM, evaluateStudentPerformanceDetailed, validateEvaluationSystem, type EvaluationDefinition } from '@apms/domain';
import { evaluationRiskOptions, evaluationRiskValue } from '@/services/evaluationRiskOptions';
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

function riskResult(workspace: ClassWorkspace, enrollmentId: string, definition: EvaluationDefinition = DEFAULT_EVALUATION_SYSTEM) {
  const saved = workspace.evaluations[enrollmentId];
  const summary = summarizeEnrollmentStanding(workspace, enrollmentId);
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
  const values = {
    ...gradeFactorValues(workspace, enrollmentId),
    current_standing: summary.finalGrade ?? summary.p3 ?? null, mastery: summary.mastery, attendance: attendance(workspace, enrollmentId),
    attendance_rate: attendance(workspace, enrollmentId), recent_scores: recentScores,
    recent_score_average: averageScores.length ? averageScores.reduce((sum, value) => sum + value, 0) / averageScores.length : null,
    recent_trend: recentTrend, trend, missing_assessment_count: workspace.assessments.filter((assessment) => workspace.scores[`${enrollmentId}:${assessment.id}`] == null && workspace.categoricalScores[`${enrollmentId}:${assessment.id}`] == null).length,
    predicted_standing: saved?.predictedStanding ?? null, risk_probability: saved?.riskProbability ?? null, model_confidence: saved?.riskProbability ?? null,
    ai_risk_level: saved?.riskLevel && saved.riskLevel !== 'unknown' ? saved.riskLevel : null,
    prediction_available: saved?.predictedStanding != null,
    prediction_age_hours: saved?.predictionGeneratedAt ? Math.max(0, (Date.now() - new Date(saved.predictionGeneratedAt).getTime()) / 3_600_000) : null,
    ai_factor_count: saved?.factors.length ?? null, data_basis: saved?.dataBasis ?? null,
  };
  return evaluateStudentPerformanceDetailed(definition, values);
}
function risk(workspace: ClassWorkspace, enrollmentId: string, definition: EvaluationDefinition = DEFAULT_EVALUATION_SYSTEM) { return riskResult(workspace, enrollmentId, definition).severity; }
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
    {screen === 'analytics' ? <Analytics {...props} /> : null}
    {screen === 'settings' ? <Info title="Academic Admin settings" message="Your monitoring authority is limited to the assigned department. Account security and notifications remain available through the account menu." /> : null}
  </View>;
}

type Props = { data: AcademicWorkspace; refresh: () => void; userId: string; toast: ReturnType<typeof useToast> };
function Heading({ title, subtitle, action }: { title: string; subtitle: string; action?: React.ReactNode }) { return <View style={styles.heading}><View style={styles.flex}><Text accessibilityRole="header" style={styles.title}>{title}</Text><Text style={styles.subtitle}>{subtitle}</Text></View>{action}</View>; }
function allStudents(data: AcademicWorkspace) { return data.classes.flatMap((item) => item.workspace.students.map((student) => {
  const definition = item.workspace.evaluationSystem ?? data.evaluationSystem ?? DEFAULT_EVALUATION_SYSTEM;
  const evaluation = riskResult(item.workspace, student.enrollmentId, definition);
  const level = definition.levels.find((candidate) => candidate.id === evaluation.matchedLevelId);
  return { item, student, score: standing(item.workspace, student.enrollmentId), rate: attendance(item.workspace, student.enrollmentId), risk: evaluation.severity, riskValue: evaluationRiskValue(definition, evaluation), riskLevelName: level?.name ?? (evaluation.severity === 'unavailable' ? 'Unavailable' : 'No matching level'), riskLevelColor: level?.color, riskDefinition: definition };
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
  return <><Heading title="Academic Administration Dashboard" subtitle={`Live, department-scoped monitoring for ${data.department?.name ?? 'your assigned academic unit'}. Official grades remain in SWU SIS.`} /><View style={styles.metrics}><MetricCard label="Active classes" value={String(data.classes.length)} /><MetricCard label="Students monitored" value={String(unique.size)} tone="info" /><MetricCard label="At-risk class records" value={String(alertRows.length)} tone={alertRows.length ? 'danger' : 'success'} /><MetricCard label="Average current standing" value={scores.length ? `${(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)}%` : '—'} tone="success" /></View>{filters.controls}<View style={styles.analyticsCharts}><VisualizationPanel title="Average score by class" description="Current provisional standing by department class for matching student records." data={scoreByClass} type="bar" suffix="%" /><VisualizationPanel title="Risk distribution" description="Applied evaluation criteria and their configured risk levels for each class." data={riskCounts} type="pie" /></View><Card><Text style={styles.cardTitle}>Priority monitoring</Text>{filteredAlerts.length ? <DataTable columns={['Student', 'Class', 'Current', 'Attendance', 'Risk']} rows={filteredAlerts.slice(0, 15).map((row) => [row.student.name, `${row.item.code} · ${row.item.section}`, row.score == null ? 'Missing' : `${row.score.toFixed(1)}%`, row.rate == null ? 'No data' : `${row.rate.toFixed(0)}%`, `${row.riskLevelName} (${row.risk})`])} /> : <PageState kind="empty" title="No active alerts" message="Alerts appear when department records indicate performance or attendance concern." />}</Card></>;
}
function Units({ data }: Props) { return <><Heading title="Academic Units" subtitle="Authorized department and program scope for this Academic Admin account." /><Card><DataTable columns={['Department', 'Code', 'Access']} rows={data.department ? [[data.department.name, data.department.code, 'Authorized']] : []} /></Card><Card><Text style={styles.cardTitle}>Programs</Text>{data.programs.length ? <DataTable columns={['Program', 'Code', 'Status']} rows={data.programs.map((program) => [program.name, program.code, 'Active'])} /> : <PageState kind="empty" title="No active programs" message="No program records are available in this department." />}</Card></>; }
function Classes({ data }: Props) { return <><Heading title="Classes Overview" subtitle="Read-only operational oversight of classes in your authorized department." /><Card>{data.classes.length ? <DataTable columns={['Subject', 'Section', 'Term', 'Students', 'Average', 'At risk']} rows={data.classes.map((item) => { const rows = item.workspace.students; const values = rows.flatMap((student) => { const value = standing(item.workspace, student.enrollmentId); return value == null ? [] : [value]; }); return [`${item.code} · ${item.title}`, item.section, item.term, String(rows.length), values.length ? `${(values.reduce((a, b) => a + b, 0) / values.length).toFixed(1)}%` : '—', String(rows.filter((student) => risk(item.workspace, student.enrollmentId) !== 'low').length)]; })} /> : <PageState kind="empty" title="No active classes" message="Faculty-created monitoring classes in this department will appear here." />}</Card></>; }
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
        {data.classes.map((item) => <Pressable key={item.id} accessibilityRole="checkbox" accessibilityState={{ checked: selectedClasses.includes(item.id) }} onPress={() => toggleClass(item.id)} style={styles.bulkClassRow}><Text style={styles.bulkClassCheck}>{selectedClasses.includes(item.id) ? '☑' : '☐'}</Text><View style={{ flex: 1 }}><Text style={styles.bulkClassName}>{item.code} · {item.section} · {item.term || 'Term not set'}</Text><Text style={styles.help}>{item.title} · Currently: {item.workspace.criteria?.gradingSystemDefinition?.name ?? item.workspace.defaultGradingSystem?.name ?? IT_GLOBAL_GRADING_SYSTEM.name}</Text></View></Pressable>)}
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
        {data.classes.length ? data.classes.map((item) => <Pressable key={item.id} accessibilityRole="checkbox" accessibilityState={{ checked: selectedClasses.includes(item.id) }} onPress={() => toggleClass(item.id)} style={styles.bulkClassRow}><Text style={styles.bulkClassCheck}>{selectedClasses.includes(item.id) ? '☑' : '☐'}</Text><View style={{ flex: 1 }}><Text style={styles.bulkClassName}>{item.code} · {item.section} · {item.term || 'Term not set'}</Text><Text style={styles.help}>{item.title} · Currently: {item.workspace.evaluationSystem?.name ?? data.evaluationSystem.name}</Text></View></Pressable>) : <PageState kind="empty" title="No classes available" message="There are no department classes to apply criteria to." />}
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
  const rows = allStudents(data);
  const riskDefinitions = [...new Map(data.classes.map((item) => { const definition = item.workspace.evaluationSystem ?? data.evaluationSystem ?? DEFAULT_EVALUATION_SYSTEM; return [definition.id, definition] as const; })).values()];
  const riskOptions = evaluationRiskOptions(riskDefinitions, 'All risks');
  const records = rows.flatMap((row) => {
    const summary = summarizeEnrollmentStanding(row.item.workspace, row.student.enrollmentId);
    const score = row.score;
    return score == null ? [] : [{ id: row.student.enrollmentId, label: row.student.name, score, risk: row.riskValue, classification: summary.remarks, category: `${row.item.code} · ${row.item.section}`, timestamp: row.item.workspace.assessments.at(-1)?.assessmentDate }];
  });
  const filters = useAnalyticsFilters(records, riskOptions);
  const visible = filters.filtered;
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
  return <><Heading title="Analytics & Reports" subtitle="Department-level analytics and provisional SWUNEXT passing-rule comparisons from authorized APMS data." action={<Button label="Export CSV" onPress={() => void exportCsv()} />} />{filters.controls}<View style={styles.metrics}><MetricCard label="Passing rule met" value={String(passing)} tone="success" /><MetricCard label="Below rule" value={String(failing)} tone="warning" /><MetricCard label="Medium risk" value={String(medium)} tone="warning" /><MetricCard label="High risk" value={String(high)} tone="danger" /></View><View style={styles.analyticsCharts}><VisualizationPanel title="Average score by class" description="Mean current SWUNEXT standing by class for records matching these filters." data={scoreByClass} type="bar" suffix="%" /><VisualizationPanel title="Student score histogram" description="Filtered continuous scores grouped into score bands." data={scoreDistribution} type="histogram" suffix="%" /><VisualizationPanel title="Risk distribution" description="Configured risk levels from the criteria applied to each class." data={riskDistribution} type="pie" /><VisualizationPanel title="Passing rule status" description="Binary pass and not yet passing classification." data={passFail} type="pie" /></View><Card><Text style={styles.cardTitle}>Class and subject comparison</Text>{data.classes.length ? <DataTable columns={['Subject / class', 'Recorded standings', 'Passing rule met', 'Below rule', 'Risk alerts']} rows={data.classes.map((item) => { const classRows = allStudents({ ...data, classes: [item] }); const classSummaries = classRows.map((row) => summarizeEnrollmentStanding(row.item.workspace, row.student.enrollmentId)); const classRecorded = classSummaries.filter((summary) => summary.finalGrade != null || summary.p3 != null || summary.mastery != null); return [`${item.code} · ${item.section}`, String(classRecorded.length), String(classSummaries.filter((summary) => summary.remarks === 'passing').length), String(classSummaries.filter((summary) => summary.remarks === 'failing').length), String(classRows.filter((row) => row.risk !== 'low').length)]; })} /> : <PageState kind="empty" title="No comparison data" message="Class comparisons appear after monitoring classes are created." />}<Text style={styles.help}>Passing requires both 80% final grade and 80% mastery. P1/P2 remain running views. These are provisional APMS indicators, not official SIS pass/fail grades. Filters apply to KPI and chart summaries; the CSV includes all authorized department rows.</Text></Card></>;
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
  const [units, setUnits] = useState('3');
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
    setUnits('3');
    setStatus('active');
    setOpen(true);
  };

  const openEdit = (sub: AcademicSubject) => {
    setEditingSubject(sub);
    setCode(sub.code);
    setTitle(sub.title);
    setUnits(String(sub.units));
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
    if (!code.trim() || !title.trim() || !Number(units)) {
      toast.show('Code, title, and valid units are required.');
      return;
    }
    setSaving(true);
    try {
      await manageSubject({
        subjectId: editingSubject?.id,
        departmentId: data.department.id,
        code: code.trim(),
        title: title.trim(),
        units: Number(units),
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
            columns={['Code', 'Title', 'Units', 'Status', 'Actions']}
            rows={subjects.map((sub) => [
              sub.code,
              sub.title,
              `${sub.units} units`,
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
        <Field label="Units" value={units} onChangeText={setUnits} keyboardType="numeric" placeholder="3" />
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
          disabled={!code.trim() || !title.trim() || !Number(units)}
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
          <View style={styles.dialogBody}>{children}</View>
        </Card>
      </View>
    </Modal>
  );
}

function Info({ title, message }: { title: string; message: string }) { return <><Heading title={title} subtitle="Connected Academic Admin workspace" /><Card><Text style={styles.help}>{message}</Text></Card></>; }

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
  bulkClassCheck: { color: colors.brand, fontSize: 20, width: 26 },
  bulkClassName: { color: colors.text, fontSize: 13, fontWeight: '700' },
  formGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  help: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  overlay: { flex: 1, backgroundColor: '#00000066', alignItems: 'center', justifyContent: 'center', padding: 24 },
  dialog: { width: '100%', maxWidth: 760, maxHeight: '90%', padding: 22 },
  dialogTitle: { fontSize: 19, fontWeight: '700', color: colors.text },
  dialogBody: { gap: 14, marginTop: 16 },
  dialogContent: { gap: 12 },
  dialogHeader: { fontSize: 16, fontWeight: '600', color: colors.text },
  rationaleCard: { backgroundColor: '#F8FAFC', padding: 12 },
  analyticsCharts: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  close: { fontSize: 28, color: colors.textMuted },
});
