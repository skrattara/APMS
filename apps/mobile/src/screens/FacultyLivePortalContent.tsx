import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Modal, Platform, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as XLSX from 'xlsx-js-style';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

import { useAuth } from '@/auth/AuthProvider';
import { supabase } from '@/services/supabase';
import { Badge, Button, Card, ConfirmDialog, DataTable, Field, MetricCard, PageState, SearchFilter, SelectField, useToast } from '@/components/ui';
import { useAnalyticsFilters } from '@/components/charts/AnalyticsFilters';
import { VisualizationPanel } from '@/components/charts/VisualizationPanel';
import { AppIcon, type AppIconName } from '@/components/Icon';
import {
  addStudentToClass, applyFacultyEvaluationSystemToClasses, createAssessment, createAttendanceSession, createFacultyClass, deleteFacultyClassEvaluationSystem, exportClassCsv,
  importRosterCsv, importRosterExcel, loadClassWorkspace, loadFacultyClasses, loadFacultyEvaluationCriteriaLibrary, loadFacultyReferenceData, loadMySubjectRequests, removeStudentsFromClass,
  previewRosterCsv, previewRosterExcel, runAiPredictions, saveAttendance, saveFeedbackDraft, saveScores,
  submitSubjectRequest, calculateEnrollmentGrade, summarizeEnrollmentStanding, updateAssessment,
  updateStudentDetails, type ClassWorkspace, type FacultyAssessment, type FacultyClass, type FacultyReferenceData, type RosterStudent,
  type SubjectRequest,
} from '@/services/faculty';
import { EvaluationSystemBuilderForm } from '@/components/EvaluationSystemBuilderForm';
import { colors, shadow } from '@/theme/tokens';
import { calculateGradingSystem, calculateTrend, DEFAULT_EVALUATION_SYSTEM, evaluateStudentPerformance, IT_GLOBAL_GRADING_SYSTEM, swunextAssessmentComponents, validateEvaluationSystem, type EvaluationDefinition, type SwunextAssessmentComponent } from '@apms/domain';
import { createGradingExcelFormulaBuilder } from '@/services/gradingExcelFormulaBuilder';

const emptyWorkspace: ClassWorkspace = { students: [], assessments: [], scores: {}, categoricalScores: {}, criteria: null, attendanceSessions: [], attendance: {}, evaluations: {}, feedback: {} };
type StudentFormState = { institutionalId: string; email: string; firstName: string; lastName: string; yearLevel: string; section: string };
const emptyStudentForm: StudentFormState = { institutionalId: '', email: '', firstName: '', lastName: '', yearLevel: '1', section: '' };
type AssessmentFormState = { title: string; component: SwunextAssessmentComponent; gradingTypeId: string; gradingGroupId: string; gradingPeriodId: string; instanceWeight: string; maximumScore: string; moduleNumber: string; date: string; gradingPeriod: string; source: 'manual' | 'csv' };
const emptyAssessmentForm: AssessmentFormState = { title: '', component: 'wrap_up_quiz', gradingTypeId: 'wuq', gradingGroupId: '', gradingPeriodId: 'p1', instanceWeight: '', maximumScore: '100', moduleNumber: '', date: new Date().toISOString().slice(0, 10), gradingPeriod: 'P1', source: 'manual' };

function valueMappingForType(system: any, typeId: string) {
  const definition = (system.components ?? []).map((item: any) => item.assessmentDefinition).find((item: any) => item?.typeId === typeId && item.scoring?.mode === 'value_mapping');
  return definition?.scoring?.mapping as { value: string; percentage: number }[] | undefined;
}

function assessmentTypeScope(system: any, typeId: string) {
  const definition = (system.components ?? []).map((item: any) => item.assessmentDefinition).find((item: any) => item?.typeId === typeId);
  const scope = definition?.count?.scope?.type;
  return { requiresGroup: scope === 'per_group', requiresPeriod: scope === 'per_period', overall: scope === 'overall' };
}

function assessmentAggregationMode(system: any, typeId: string) {
  return (system.components ?? []).map((item: any) => item.assessmentDefinition).find((item: any) => item?.typeId === typeId)?.aggregation?.mode;
}

function highestCategory(mapping?: { value: string; percentage: number }[]) {
  return mapping?.reduce<{ value: string; percentage: number } | undefined>((highest, item) => !highest || item.percentage > highest.percentage ? item : highest, undefined)?.value ?? '';
}

function storedAssessmentValue(workspace: ClassWorkspace, enrollmentId: string, assessmentId: string) {
  const key = `${enrollmentId}:${assessmentId}`;
  return workspace.categoricalScores[key] ?? workspace.scores[key] ?? null;
}

function hasStoredAssessmentValue(workspace: ClassWorkspace, enrollmentId: string, assessmentId: string) {
  return storedAssessmentValue(workspace, enrollmentId, assessmentId) != null;
}

function assessmentPercentForWorkspace(workspace: ClassWorkspace, enrollmentId: string, assessment: FacultyAssessment) {
  const raw = storedAssessmentValue(workspace, enrollmentId, assessment.id);
  if (raw == null) return null;
  const grading = workspace.criteria?.gradingSystemDefinition ?? workspace.defaultGradingSystem ?? IT_GLOBAL_GRADING_SYSTEM;
  const typeId = assessment.gradingTypeId ?? assessment.component;
  const definition = (grading.components ?? []).map((item: any) => item.assessmentDefinition).find((item: any) => item?.typeId === typeId);
  if (definition?.scoring?.mode === 'value_mapping') return definition.scoring.mapping.find((item: any) => String(item.value) === String(raw))?.percentage ?? null;
  return typeof raw === 'number' && assessment.maximumScore > 0 ? Number(((raw / assessment.maximumScore) * 100).toFixed(2)) : null;
}

function assessmentTypeDefaults(system: any, typeId: string) {
  const definitions = (system.components ?? []).map((item: any) => item.assessmentDefinition).filter((item: any) => item?.typeId === typeId);
  const componentDefault = definitions.find((item: any) => Number(item.maxScore) > 0)?.maxScore;
  const legacyDefault = swunextAssessmentComponents.find((item) => item.key === typeId)?.defaultMaximumScore;
  const weightRequired = definitions.some((item: any) => item.aggregation?.mode === 'weighted');
  return {
    maximumScore: String(componentDefault ?? legacyDefault ?? 100),
    instanceWeight: weightRequired ? '1' : '',
  };
}

function hasExplicitAssessmentMaximum(system: any, typeId: string) {
  return (system.components ?? []).some((item: any) => item.assessmentDefinition?.typeId === typeId && Number(item.assessmentDefinition.maxScore) > 0);
}

function buildAssessmentTrend(workspace: ClassWorkspace, visibleIds: Set<string | undefined>) {
  const points = workspace.assessments.flatMap((assessment) => {
    const values = workspace.students.filter((student) => visibleIds.has(student.enrollmentId)).flatMap((student) => {
      const percentage = assessmentPercentForWorkspace(workspace, student.enrollmentId, assessment);
      return percentage == null ? [] : [percentage];
    });
    return values.length ? [{
      label: assessment.assessmentDate.slice(5),
      value: values.reduce((sum, value) => sum + value, 0) / values.length,
      kind: 'timeseries' as const,
      timestamp: assessment.assessmentDate,
      assessmentTitle: assessment.title,
    }] : [];
  });
  const labelCounts = new Map<string, number>();
  for (const point of points) labelCounts.set(point.label, (labelCounts.get(point.label) ?? 0) + 1);
  return points.map(({ assessmentTitle, ...point }) => ({
    ...point,
    label: (labelCounts.get(point.label) ?? 0) > 1
      ? `${point.label} · ${assessmentTitle.length > 14 ? `${assessmentTitle.slice(0, 12)}…` : assessmentTitle}`
      : point.label,
    category: assessmentTitle,
  }));
}

function useFacultyWorkspace() {
  const { user } = useAuth();
  const [classes, setClasses] = useState<FacultyClass[]>([]);
  const [references, setReferences] = useState<FacultyReferenceData>({ subjects: [], terms: [], programs: [] });
  const [selectedClassId, setSelectedClassId] = useState('');
  const [workspace, setWorkspace] = useState<ClassWorkspace>(emptyWorkspace);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(null);
    Promise.all([loadFacultyClasses(), loadFacultyReferenceData()])
      .then(async ([nextClasses, nextReferences]) => {
        if (!active) return;
        setClasses(nextClasses); setReferences(nextReferences);
        const nextId = nextClasses.some((item) => item.id === selectedClassId) ? selectedClassId : nextClasses[0]?.id ?? '';
        setSelectedClassId(nextId);
        setWorkspace(nextId ? await loadClassWorkspace(nextId, undefined, user?.id) : emptyWorkspace);
      })
      .catch((cause) => active && setError(cause instanceof Error ? cause.message : 'Unable to load Faculty records.'))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [version, selectedClassId, user?.id]);
  useEffect(() => {
    const client = supabase;
    if (!user || !client) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleRefresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, 300);
    };
    const channel = client.channel(`faculty-workspace-${user.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    for (const table of ['enrollments', 'assessment_results', 'attendance_records', 'attendance_sessions', 'performance_evaluations', 'performance_predictions', 'faculty_class_evaluation_systems']) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, scheduleRefresh);
    }
    channel.subscribe();
    const poll = setInterval(refresh, 60_000);
    return () => { clearInterval(poll); if (timer) clearTimeout(timer); void client.removeChannel(channel); };
  }, [refresh, user]);
  return { classes, references, selectedClassId, setSelectedClassId, workspace, loading, error, refresh, userId: user?.id ?? '' };
}

export function FacultyLivePortalContent({ screen }: { screen: string }) {
  const state = useFacultyWorkspace();
  const toast = useToast();
  if (state.loading) return <PageState kind="loading" title="Loading Faculty workspace" message="Retrieving your assigned classes and monitoring records." />;
  if (state.error) return <PageState kind="error" title="Faculty data unavailable" message={state.error} action={<Button label="Retry" onPress={state.refresh} />} />;
  const props = { ...state, toast };
  return (
    <View style={styles.screen}>
      {screen === 'overview' ? <Overview {...props} /> : null}
      {screen === 'classes' ? <Classes {...props} /> : null}
      {screen === 'students' ? <Students {...props} /> : null}
      {screen === 'gradebook' || screen === 'records' ? <Gradebook {...props} /> : null}
      {screen === 'attendance' ? <Attendance {...props} /> : null}
      {screen === 'criteria' ? <Criteria {...props} /> : null}
      {screen === 'risk' || screen === 'evaluation' ? <Risk {...props} prediction={screen === 'evaluation'} /> : null}
      {screen === 'analytics' ? <Analytics {...props} /> : null}
      {screen === 'feedback' ? <Feedback {...props} /> : null}
    </View>
  );
}

type StateProps = ReturnType<typeof useFacultyWorkspace> & { toast: ReturnType<typeof useToast> };

function Heading({ title, subtitle, action }: { title: string; subtitle: string; action?: ReactNode }) {
  return <View style={styles.heading}><View style={styles.flex}><Text accessibilityRole="header" style={styles.title}>{title}</Text><Text style={styles.subtitle}>{subtitle}</Text></View>{action}</View>;
}

function ClassSelect({ classes, selectedClassId, setSelectedClassId }: Pick<StateProps, 'classes' | 'selectedClassId' | 'setSelectedClassId'>) {
  return <SelectField label="Class" value={selectedClassId} options={classes.map((item) => ({ label: `${item.code} · ${item.section}`, value: item.id }))} onChange={setSelectedClassId} containerStyle={styles.classSelect} />;
}

function currentStanding(workspace: ClassWorkspace, enrollmentId: string) {
  const summary = summarizeEnrollmentStanding(workspace, enrollmentId);
  return summary.finalGrade ?? summary.p3 ?? summary.effortfulLearning ?? summary.mastery;
}

function attendanceRate(workspace: ClassWorkspace, enrollmentId: string) {
  const values = workspace.attendanceSessions.flatMap((session) => {
    const status = workspace.attendance[`${session.id}:${enrollmentId}`];
    return status ? [status === 'present' || status === 'excused' ? 1 : status === 'late' ? 0.5 : 0] : [];
  });
  return values.length ? (values.reduce((sum, value) => sum + value, 0) / values.length) * 100 : null;
}

function recentScorePercentages(workspace: ClassWorkspace, enrollmentId: string) {
  return workspace.assessments.flatMap((assessment) => {
    const value = assessmentPercentForWorkspace(workspace, enrollmentId, assessment);
    return value == null ? [] : [value];
  });
}

function missingAssessments(workspace: ClassWorkspace, enrollmentId: string) {
  return workspace.assessments.filter((assessment) => !hasStoredAssessmentValue(workspace, enrollmentId, assessment.id)).length;
}

function gradeFactorValues(workspace: ClassWorkspace, enrollmentId: string) {
  const grading = workspace.criteria?.gradingSystemDefinition ?? workspace.defaultGradingSystem ?? IT_GLOBAL_GRADING_SYSTEM;
  const assessments = workspace.assessments.map((item) => ({ id: item.id, typeId: item.gradingTypeId ?? item.component, score: storedAssessmentValue(workspace, enrollmentId, item.id), maximumScore: item.maximumScore, weight: item.instanceWeight ?? undefined, periodId: item.gradingPeriodId, groupId: item.gradingGroupId ?? (item.moduleNumber == null ? null : `m${item.moduleNumber}`) }));
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
    const rows = assessments.filter((item) => item.groupId && included.has(item.groupId) && item.score != null);
    const scores = rows.flatMap((item) => { const component = grading.components.find((candidate: any) => candidate.assessmentDefinition?.typeId === item.typeId); const mapped = component?.assessmentDefinition?.scoring?.mode === 'value_mapping' ? component.assessmentDefinition.scoring.mapping.find((entry: any) => String(entry.value) === String(item.score))?.percentage : undefined; const value = mapped ?? (typeof item.score === 'number' ? item.score / item.maximumScore * 100 : NaN); return Number.isFinite(value) ? [value] : []; });
    for (const mode of modes) values[`grading_group:${group.id}:${mode}`] = aggregate(scores, mode);
  }
  return values;
}

function riskFor(workspace: ClassWorkspace, enrollmentId: string) {
  const saved = workspace.evaluations[enrollmentId];
  const summary = summarizeEnrollmentStanding(workspace, enrollmentId);
  const score = summary.finalGrade ?? summary.p3 ?? null;
  const attendance = attendanceRate(workspace, enrollmentId);
  const scoreHistory = workspace.assessments.flatMap((assessment) => {
    const result = assessmentPercentForWorkspace(workspace, enrollmentId, assessment);
    return result == null ? [] : [result];
  });
  const definition = workspace.evaluationSystem ?? DEFAULT_EVALUATION_SYSTEM;
  const windowFor = (source: string) => definition.factors.find((factor) => factor.source === source)?.windowSize ?? 5;
  const recentScores = scoreHistory.slice(-windowFor('recent_scores'));
  const averageScores = scoreHistory.slice(-windowFor('recent_score_average'));
  const trendScores = scoreHistory.slice(-windowFor('recent_trend'));
  const trend = saved?.trend && saved.trend !== 'unknown' ? saved.trend : null;
  const recentTrend = trendScores.length > 1 ? calculateTrend(trendScores) : null;
  return evaluateStudentPerformance(definition, {
    ...gradeFactorValues(workspace, enrollmentId),
    current_standing: score, mastery: summary.mastery, attendance, attendance_rate: attendance, recent_scores: recentScores,
    recent_score_average: averageScores.length ? averageScores.reduce((sum, value) => sum + value, 0) / averageScores.length : null,
    recent_trend: recentTrend, trend,
    missing_assessment_count: workspace.assessments.filter((assessment) => !hasStoredAssessmentValue(workspace, enrollmentId, assessment.id)).length,
    predicted_standing: saved?.predictedStanding ?? null, risk_probability: saved?.riskProbability ?? null, model_confidence: saved?.riskProbability ?? null,
    ai_risk_level: saved?.riskLevel && saved.riskLevel !== 'unknown' ? saved.riskLevel : null,
    prediction_available: saved?.predictedStanding != null,
    prediction_age_hours: saved?.predictionGeneratedAt ? Math.max(0, (Date.now() - new Date(saved.predictionGeneratedAt).getTime()) / 3_600_000) : null,
    ai_factor_count: saved?.factors.length ?? null, data_basis: saved?.dataBasis ?? null,
  });
}

function Overview(props: StateProps) {
  const overviewRecords = props.workspace.students.flatMap((student) => {
    const value = currentStanding(props.workspace, student.enrollmentId);
    return value == null ? [] : [{ id: student.enrollmentId, label: student.name, score: value, risk: riskFor(props.workspace, student.enrollmentId), classification: summarizeEnrollmentStanding(props.workspace, student.enrollmentId).remarks, category: student.section || 'Class', timestamp: props.workspace.assessments.at(-1)?.assessmentDate }];
  });
  const filters = useAnalyticsFilters(overviewRecords);
  const visibleIds = new Set(filters.filtered.map((item) => item.id));
  const atRisk = props.workspace.students.filter((student) => visibleIds.has(student.enrollmentId) && riskFor(props.workspace, student.enrollmentId) !== 'low');
  const standings = filters.filtered.map((item) => item.score);
  const average = standings.length ? standings.reduce((sum, value) => sum + value, 0) / standings.length : 0;
  const riskCounts = ['low', 'medium', 'high', 'unavailable'].map((risk) => ({ label: `${risk[0].toUpperCase()}${risk.slice(1)}`, value: filters.filtered.filter((student) => student.risk === risk).length }));
  const trend = buildAssessmentTrend(props.workspace, visibleIds);
  return <>
    <Heading title="Faculty Dashboard" subtitle="Live records from your Supabase-assigned classes. Values are provisional monitoring data, not official SIS grades." />
    <View style={styles.metrics}>
      <MetricCard label="Active classes" value={String(props.classes.length)} />
      <MetricCard label="Students monitored" value={String(filters.filtered.length)} tone="info" />
      <MetricCard label="Requiring attention" value={String(atRisk.length)} tone={atRisk.length ? 'danger' : 'success'} />
      <MetricCard label="Provisional average" value={standings.length ? `${average.toFixed(1)}%` : '—'} tone="success" />
    </View>
    <ClassSelect {...props} />
    {filters.controls}
    <View style={styles.analyticsCharts}><VisualizationPanel title="Class score trend" description="Average assessment percentage in the selected class." data={trend} type="line" suffix="%" /><VisualizationPanel title="Risk distribution" description="Current advisory risk across the class roster." data={riskCounts} type="pie" /></View>
    <Card><Text style={styles.cardTitle}>Students Requiring Attention</Text>{atRisk.length ? <DataTable columns={['Student', 'P3 Effort', 'Mastery', 'Final', 'Attendance', 'Risk', 'Reason']} rows={atRisk.map((student) => {
      const summary = summarizeEnrollmentStanding(props.workspace, student.enrollmentId); const attendance = attendanceRate(props.workspace, student.enrollmentId); const risk = riskFor(props.workspace, student.enrollmentId);
      return [student.name, summary.p3 == null ? 'Missing' : `${summary.p3.toFixed(1)}%`, summary.mastery == null ? 'Missing' : `${summary.mastery.toFixed(1)}%`, summary.finalGrade == null ? 'Incomplete' : `${summary.finalGrade.toFixed(1)}%`, attendance == null ? 'No sessions' : `${attendance.toFixed(0)}%`, `${risk[0].toUpperCase()}${risk.slice(1)} Risk`, summary.remarks === 'failing' ? 'Below SWUNEXT passing rule' : attendance != null && attendance < 80 ? 'Attendance pattern' : 'Missing assessments'];
    })} /> : <PageState kind="empty" title="No current alerts" message="Students will appear here when scores, missing work, attendance, or AI indicators require attention." />}</Card>
  </>;
}

function Classes(props: StateProps) {
  const [open, setOpen] = useState(false);
  const [reqOpen, setReqOpen] = useState(false);
  const [subject, setSubject] = useState('');
  const [term, setTerm] = useState('');
  const [section, setSection] = useState('');
  const [saving, setSaving] = useState(false);
  const [requests, setRequests] = useState<SubjectRequest[]>([]);
  const [loadingReqs, setLoadingReqs] = useState(false);

  // Subject Request Form
  const [reqCode, setReqCode] = useState('');
  const [reqTitle, setReqTitle] = useState('');
  const [reqUnits, setReqUnits] = useState('3');
  const [reqRationale, setReqRationale] = useState('');

  const loadRequests = useCallback(async () => {
    setLoadingReqs(true);
    try {
      const data = await loadMySubjectRequests();
      setRequests(data);
    } catch {
      // Non-blocking
    } finally {
      setLoadingReqs(false);
    }
  }, []);

  useEffect(() => {
    void loadRequests();
  }, [loadRequests]);

  const submit = async () => {
    if (!subject || !term || !section.trim()) {
      return props.toast.show('Subject, term, and section are required.');
    }
    setSaving(true);
    try {
      await createFacultyClass(subject, term, section);
      setOpen(false);
      setSection('');
      props.toast.show('Class created and assigned to your Faculty account with SWUNEXT grading criteria.');
      props.refresh();
    } catch (cause) {
      props.toast.show(cause instanceof Error ? cause.message : 'Class creation failed.');
    } finally {
      setSaving(false);
    }
  };

  const submitRequest = async () => {
    if (!reqCode.trim() || !reqTitle.trim() || !Number(reqUnits) || reqRationale.trim().length < 10) {
      return props.toast.show('Code, title, units, and a rationale (10+ characters) are required.');
    }
    setSaving(true);
    try {
      await submitSubjectRequest({
        code: reqCode.trim(),
        title: reqTitle.trim(),
        units: Number(reqUnits),
        rationale: reqRationale.trim(),
      });
      setReqOpen(false);
      setReqCode('');
      setReqTitle('');
      setReqRationale('');
      props.toast.show('Subject request submitted to your Academic Admin for review.');
      await loadRequests();
    } catch (cause) {
      props.toast.show(cause instanceof Error ? cause.message : 'Subject request failed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Heading
        title="My Classes"
        subtitle="Create and manage local APMS monitoring classes independent of SWU SIS."
        action={
          <View style={styles.actions}>
            <Button label="Request Subject" variant="secondary" onPress={() => setReqOpen(true)} />
            <Button label="Create Class" onPress={() => setOpen(true)} />
          </View>
        }
      />

      <Card>
        {props.classes.length ? (
          <DataTable
            columns={['Subject', 'Title', 'Section', 'Term', 'Students', 'Status']}
            rows={props.classes.map((item) => [
              item.code,
              item.title,
              item.section,
              item.term,
              String(item.studentCount),
              'Active',
            ])}
          />
        ) : (
          <PageState
            kind="empty"
            title="No assigned classes"
            message="Create your first monitoring class to add students, assessments, and attendance."
            action={<Button label="Create Class" onPress={() => setOpen(true)} />}
          />
        )}
      </Card>

      {requests.length ? (
        <Card>
          <Text style={styles.cardTitle}>My Subject Requests</Text>
          <DataTable
            columns={['Code', 'Title', 'Units', 'Status', 'Reviewer Note', 'Submitted']}
            rows={requests.map((req) => [
              req.code,
              req.title,
              `${req.units} units`,
              <Badge
                key={`req-${req.id}`}
                tone={req.status === 'approved' ? 'success' : req.status === 'rejected' ? 'danger' : 'warning'}
              >
                {req.status.toUpperCase()}
              </Badge>,
              req.reviewNote || '—',
              new Date(req.createdAt).toLocaleDateString(),
            ])}
          />
        </Card>
      ) : null}

      <Dialog visible={open} title="Create Monitoring Class" onClose={() => setOpen(false)}>
        {props.references.subjects.length === 0 ? (
          <View style={styles.dialogContent}>
            <Text style={styles.help}>No active subjects are currently assigned to your department.</Text>
            <Button label="Submit Subject Request" onPress={() => { setOpen(false); setReqOpen(true); }} />
          </View>
        ) : (
          <>
            <SelectField
              label="Subject"
              value={subject}
              options={props.references.subjects.map((item) => ({
                label: `${item.code} · ${item.title}`,
                value: item.id,
              }))}
              onChange={setSubject}
            />
            <SelectField
              label="Academic Term"
              value={term}
              options={props.references.terms.map((item) => ({
                label: `${item.label} (${item.status})`,
                value: item.id,
              }))}
              onChange={setTerm}
            />
            <Field label="Section" value={section} onChangeText={setSection} placeholder="e.g. BSIT-3B" />
            <Text style={styles.help}>
              Classes are auto-provisioned with standard SWUNEXT grading criteria upon creation.
            </Text>
            <Button label="Create and assign class" loading={saving} onPress={() => void submit()} />
          </>
        )}
      </Dialog>

      <Dialog visible={reqOpen} title="Request New Subject" onClose={() => setReqOpen(false)}>
        <Field label="Subject Code" value={reqCode} onChangeText={setReqCode} placeholder="e.g. IT311" />
        <Field label="Subject Title" value={reqTitle} onChangeText={setReqTitle} placeholder="e.g. Advanced Web Development" />
        <Field label="Units" value={reqUnits} onChangeText={setReqUnits} keyboardType="numeric" placeholder="3" />
        <Field
          label="Rationale (Min 10 characters)"
          value={reqRationale}
          onChangeText={setReqRationale}
          multiline
          numberOfLines={3}
          placeholder="Explain why this subject is needed for your department..."
        />
        <Button
          label="Submit Subject Request"
          loading={saving}
          disabled={!reqCode.trim() || !reqTitle.trim() || !Number(reqUnits) || reqRationale.trim().length < 10}
          onPress={() => void submitRequest()}
        />
      </Dialog>
    </>
  );
}

function Students(props: StateProps) {
  const [query, setQuery] = useState('');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [open, setOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [csvOpen, setCsvOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [programId, setProgramId] = useState(props.references.programs[0]?.id ?? '');
  const [form, setForm] = useState<StudentFormState>(emptyStudentForm);
  const [editingStudent, setEditingStudent] = useState<RosterStudent | null>(null);
  const [selectedEnrollmentIds, setSelectedEnrollmentIds] = useState<string[]>([]);
  const [deleteSelectedOpen, setDeleteSelectedOpen] = useState(false);
  const [aiPromptOpen, setAiPromptOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [rosterFile, setRosterFile] = useState<{ name: string; kind: 'csv' | 'excel'; text?: string; data?: ArrayBuffer } | null>(null);
  const preview = useMemo(() => {
    if (!rosterFile) return [];
    try { return rosterFile.kind === 'excel' ? previewRosterExcel(rosterFile.data!) : previewRosterCsv(rosterFile.text ?? ''); }
    catch (cause) { return [{ rowNumber: 0, raw: {}, errors: [cause instanceof Error ? cause.message : 'Unable to read this file.'], duplicate: false, value: undefined }]; }
  }, [rosterFile]);

  const filtered = useMemo(() => {
    const normalizedQuery = query.toLowerCase();
    const direction = sortOrder === 'asc' ? 1 : -1;
    const lastName = (student: RosterStudent) => {
      const parts = student.name.trim().split(/\s+/);
      return (parts[parts.length - 1] ?? '').toLowerCase();
    };
    return props.workspace.students
      .filter((student) => `${student.institutionalId} ${student.name}`.toLowerCase().includes(normalizedQuery))
      .sort((left, right) => {
        const lastNameCompare = lastName(left).localeCompare(lastName(right));
        if (lastNameCompare !== 0) return lastNameCompare * direction;
        return left.name.localeCompare(right.name) * direction;
      });
  }, [props.workspace.students, query, sortOrder]);
  const pageSize = 10;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageStudents = filtered.slice((page - 1) * pageSize, page * pageSize);
  useEffect(() => { setPage(1); }, [query, sortOrder, props.selectedClassId, props.workspace.students.length]);

  const resetForm = () => {
    setForm(emptyStudentForm);
    setProgramId(props.references.programs[0]?.id ?? '');
    setEditingStudent(null);
  };
  const openAdd = () => {
    resetForm();
    setOpen(true);
  };
  const openEdit = (student: RosterStudent) => {
    const [firstName, ...rest] = student.name.split(' ');
    setEditingStudent(student);
    setProgramId(student.programId);
    setForm({
      institutionalId: student.institutionalId,
      email: student.email,
      firstName: firstName ?? '',
      lastName: rest.join(' '),
      yearLevel: String(student.yearLevel),
      section: student.section,
    });
    setEditOpen(true);
  };

  const add = async () => {
    if (!props.selectedClassId) return props.toast.show('Create or select a class first.');
    setSaving(true);
    try {
      await addStudentToClass({ classId: props.selectedClassId, programId, ...form, yearLevel: Number(form.yearLevel) });
      setOpen(false);
      resetForm();
      props.toast.show('Student added to the selected class roster.');
      props.refresh();
    } catch (cause) {
      props.toast.show(cause instanceof Error ? cause.message : 'Student could not be added.');
    } finally {
      setSaving(false);
    }
  };

  const saveEdit = async () => {
    if (!editingStudent) return;
    setSaving(true);
    try {
      await updateStudentDetails(editingStudent.studentId, { programId, ...form, yearLevel: Number(form.yearLevel) });
      setEditOpen(false);
      resetForm();
      props.toast.show('Student details updated.');
      props.refresh();
    } catch (cause) {
      props.toast.show(cause instanceof Error ? cause.message : 'Student details could not be updated.');
    } finally {
      setSaving(false);
    }
  };

  const toggleStudentSelection = (enrollmentId: string) => setSelectedEnrollmentIds((current) => current.includes(enrollmentId) ? current.filter((id) => id !== enrollmentId) : [...current, enrollmentId]);
  const selectVisibleStudents = () => setSelectedEnrollmentIds((current) => {
    const visibleIds = pageStudents.map((student) => student.enrollmentId);
    return visibleIds.every((id) => current.includes(id)) ? current.filter((id) => !visibleIds.includes(id)) : Array.from(new Set([...current, ...visibleIds]));
  });
  const deleteSelected = async () => {
    if (!props.selectedClassId || !selectedEnrollmentIds.length) return;
    setSaving(true);
    try {
      await removeStudentsFromClass(props.selectedClassId, selectedEnrollmentIds);
      props.toast.show(`${selectedEnrollmentIds.length} student${selectedEnrollmentIds.length === 1 ? '' : 's'} removed from this class.`);
      setSelectedEnrollmentIds([]);
      setDeleteSelectedOpen(false);
      props.refresh();
    } catch (cause) {
      props.toast.show(cause instanceof Error ? cause.message : 'Selected students could not be removed.');
    } finally { setSaving(false); }
  };

  const downloadRosterTemplate = async () => {
    const templateContent = 'institutional_id,first_name,last_name,email,year_level,section\n2024-0001,Juan,Dela Cruz,juan.delacruz@phinmaed.com,3,BSIT-3A\n2024-0002,Maria,Santos,maria.santos@phinmaed.com,3,BSIT-3A';
    if (Platform.OS === 'web') {
      const workbook = XLSX.utils.book_new();
      const worksheet = XLSX.utils.aoa_to_sheet([
        ['institutional_id', 'first_name', 'last_name', 'email', 'year_level', 'section'],
        ['2024-0001', 'Juan', 'Dela Cruz', 'juan.delacruz@phinmaed.com', 3, 'BSIT-3A'],
        ['2024-0002', 'Maria', 'Santos', 'maria.santos@phinmaed.com', 3, 'BSIT-3A'],
      ]);
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Roster');
      const output = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
      const url = URL.createObjectURL(new Blob([output], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'apms-roster-template.xlsx';
      anchor.click();
      URL.revokeObjectURL(url);
    } else {
      await Share.share({ message: templateContent });
    }
    props.toast.show('Excel roster template downloaded.');
  };

  const chooseRosterFile = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: ['text/csv', 'text/comma-separated-values', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel'],
      copyToCacheDirectory: true,
    });
    if (!result.canceled) {
      const asset = result.assets[0];
      const response = await fetch(asset.uri);
      if (/\.(xlsx|xls)$/i.test(asset.name)) setRosterFile({ name: asset.name, kind: 'excel', data: await response.arrayBuffer() });
      else setRosterFile({ name: asset.name, kind: 'csv', text: await response.text() });
    }
  };

  const importRoster = async () => {
    if (!rosterFile || !props.selectedClassId) return;
    setSaving(true);
    try {
      const result = rosterFile.kind === 'excel'
        ? await importRosterExcel(props.selectedClassId, programId, rosterFile.name, rosterFile.data!)
        : await importRosterCsv(props.selectedClassId, programId, rosterFile.name, rosterFile.text!);
      props.toast.show(`Roster import complete: ${result.success} imported, ${result.failures} rejected.`);
      setCsvOpen(false);
      setRosterFile(null);
      props.refresh();
    } catch (cause) {
      props.toast.show(cause instanceof Error ? cause.message : 'Roster import failed.');
    } finally {
      setSaving(false);
    }
  };

  const selectedClass = props.classes.find((item) => item.id === props.selectedClassId);
  const aiRosterPrompt = `You are helping me format a class roster for import into APMS.

I have attached my current class roster and the APMS Excel roster template. Reformat the current roster to match the template exactly and return a completed .xlsx workbook.

Target APMS class context:
- Subject: ${selectedClass?.code ?? '[use the selected APMS class]'}
- Section: ${selectedClass?.section ?? '[use the actual roster section]'}
- Term: ${selectedClass?.term ?? '[use the selected APMS term]'}

Requirements:
- Use the template's column names and order: institutional_id, first_name, last_name, email, year_level, section.
- Map equivalent headers such as Student Number or Student ID to institutional_id, Given Name to first_name, Surname to last_name, Email Address to email, Year or Grade Level to year_level, and Class to section.
- Split full names into first_name and last_name when necessary.
- Normalize email addresses to lowercase and remove unnecessary spaces.
- Use each student's actual section and year level from the current roster. Do not copy the template's example section or year level. If the roster does not contain a student's year level or section, leave it blank and put that row in Needs Review.
- Preserve every student and do not silently discard any row.
- Do not invent, guess, or modify official student numbers.
- Put rows with missing student numbers, duplicate IDs, invalid emails, or unclear names in a separate Needs Review sheet.
- Keep the original roster unchanged in a separate Original Data sheet.
- Report how many rows were processed, formatted successfully, and placed in Needs Review.`;
  const copyAiRosterPrompt = async () => {
    if (Platform.OS === 'web' && globalThis.navigator?.clipboard) {
      await globalThis.navigator.clipboard.writeText(aiRosterPrompt);
      props.toast.show('AI formatting prompt copied to the clipboard.');
    } else {
      await Share.share({ message: aiRosterPrompt });
    }
    setAiPromptOpen(false);
  };

  return (
    <>
      <Heading
        title="Students and Class Roster"
        subtitle="Students are entered here manually or imported from an Excel workbook, then enrolled in the selected APMS class."
        action={
          <View style={styles.actions}>
            <Button label="Download Excel template" variant="ghost" onPress={() => void downloadRosterTemplate()} />
            <Button label="Import roster" variant="secondary" onPress={() => setCsvOpen(true)} />
            <Button label={pageStudents.length && pageStudents.every((student) => selectedEnrollmentIds.includes(student.enrollmentId)) ? 'Clear page' : 'Select page'} variant="ghost" disabled={!pageStudents.length} onPress={selectVisibleStudents} />
            <Button label={selectedEnrollmentIds.length ? `Remove selected (${selectedEnrollmentIds.length})` : 'Remove selected'} variant="danger" disabled={!selectedEnrollmentIds.length} onPress={() => setDeleteSelectedOpen(true)} />
            <Button label="Add student" onPress={openAdd} />
          </View>
        }
      />
      <ClassSelect {...props} />
      <View style={styles.filterRow}>
        <SearchFilter value={query} onChange={setQuery} placeholder="Search student ID or name" />
        <SelectField
          label="Sort by last name"
          value={sortOrder}
          options={[{ label: 'A to Z', value: 'asc' }, { label: 'Z to A', value: 'desc' }]}
          onChange={(value) => setSortOrder(value as 'asc' | 'desc')}
          containerStyle={styles.sortField}
        />
      </View>
      <Card>
        {filtered.length ? (
          <>
          <DataTable
            columns={['Select', 'Student ID', 'Name', 'Email', 'Program', 'Year', 'Edit', 'Status']}
            rows={pageStudents.map((student) => [
              <Pressable key={`select-${student.enrollmentId}`} accessibilityRole="checkbox" accessibilityState={{ checked: selectedEnrollmentIds.includes(student.enrollmentId) }} accessibilityLabel={`Select ${student.name}`} onPress={() => toggleStudentSelection(student.enrollmentId)} style={[styles.rosterCheckbox, selectedEnrollmentIds.includes(student.enrollmentId) && styles.rosterCheckboxSelected]}><Text style={styles.rosterCheckboxMark}>{selectedEnrollmentIds.includes(student.enrollmentId) ? '✓' : ''}</Text></Pressable>,
              student.institutionalId,
              student.name,
              student.email,
              student.program,
              String(student.yearLevel),
              <Button key={`edit-${student.enrollmentId}`} label="Edit" variant="secondary" onPress={() => openEdit(student)} />,
              'Active',
            ])}
          />
          {filtered.length > pageSize ? <View style={styles.pagination}><Button label="Previous" variant="secondary" disabled={page <= 1} onPress={() => setPage((current) => Math.max(1, current - 1))} /><Text style={styles.paginationText}>Page {page} of {pageCount} · {filtered.length} students</Text><Button label="Next" variant="secondary" disabled={page >= pageCount} onPress={() => setPage((current) => Math.min(pageCount, current + 1))} /></View> : null}
          </>
        ) : (
          <PageState kind="empty" title="No students in this class" message="Use Add student or Import roster to populate the selected class roster." />
        )}
      </Card>
      <Dialog visible={open} title="Add student to class" onClose={() => { setOpen(false); resetForm(); }}>
        <SelectField label="Program" value={programId} options={props.references.programs.map((item) => ({ label: `${item.code} · ${item.name}`, value: item.id }))} onChange={setProgramId} />
        <View style={styles.formGrid}>
          <Field label="Student ID" value={form.institutionalId} onChangeText={(value) => setForm({ ...form, institutionalId: value })} />
          <Field label="Email" value={form.email} onChangeText={(value) => setForm({ ...form, email: value })} />
          <Field label="First name" value={form.firstName} onChangeText={(value) => setForm({ ...form, firstName: value })} />
          <Field label="Last name" value={form.lastName} onChangeText={(value) => setForm({ ...form, lastName: value })} />
          <Field label="Year level" value={form.yearLevel} keyboardType="numeric" onChangeText={(value) => setForm({ ...form, yearLevel: value })} />
          <Field label="Section" value={form.section} onChangeText={(value) => setForm({ ...form, section: value })} />
        </View>
        <Button label="Add to roster" loading={saving} onPress={() => void add()} />
      </Dialog>
      <Dialog visible={editOpen} title="Edit student details" onClose={() => { setEditOpen(false); resetForm(); }}>
        <SelectField label="Program" value={programId} options={props.references.programs.map((item) => ({ label: `${item.code} · ${item.name}`, value: item.id }))} onChange={setProgramId} />
        <View style={styles.formGrid}>
          <Field label="Student ID" value={form.institutionalId} onChangeText={(value) => setForm({ ...form, institutionalId: value })} />
          <Field label="Email" value={form.email} onChangeText={(value) => setForm({ ...form, email: value })} />
          <Field label="First name" value={form.firstName} onChangeText={(value) => setForm({ ...form, firstName: value })} />
          <Field label="Last name" value={form.lastName} onChangeText={(value) => setForm({ ...form, lastName: value })} />
          <Field label="Year level" value={form.yearLevel} keyboardType="numeric" onChangeText={(value) => setForm({ ...form, yearLevel: value })} />
          <Field label="Section" value={form.section} onChangeText={(value) => setForm({ ...form, section: value })} />
        </View>
        <Button label="Save student details" loading={saving} onPress={() => void saveEdit()} />
      </Dialog>
      <Dialog visible={csvOpen} title="Import roster" onClose={() => setCsvOpen(false)} footer={<View style={styles.dialogFooter}><Button label="Confirm import" loading={saving} disabled={!preview.some((row) => !row.errors.length)} onPress={() => void importRoster()} /></View>}>
        <SelectField label="Program for imported rows" value={programId} options={props.references.programs.map((item) => ({ label: `${item.code} · ${item.name}`, value: item.id }))} onChange={setProgramId} />
        <Text style={styles.help}>Smart formatting recognizes common headers such as Student Number, Name, Email, Year, and Section. An official student number is still required; APMS will not invent one.</Text>
        <View style={styles.actions}>
          <Button label="Choose Excel or CSV" variant="secondary" onPress={() => void chooseRosterFile()} />
          <Button label="Download Excel template" variant="ghost" onPress={() => void downloadRosterTemplate()} />
          <Button label="Prepare with another AI" variant="ghost" onPress={() => { setCsvOpen(false); setAiPromptOpen(true); }} />
        </View>
        {rosterFile ? (
          <>
            <Text style={styles.cardTitle}>{rosterFile.name}</Text>
            <Text style={styles.help}>
              {preview.length} rows found · {preview.filter((row) => !row.errors.length).length} valid · {preview.filter((row) => row.errors.length).length} invalid
            </Text>
            <DataTable
              columns={['Row', 'Student ID', 'Name', 'Validation']}
              rows={preview.map((row) => [
                String(row.rowNumber),
                row.raw.institutional_id ?? '—',
                `${row.raw.first_name ?? ''} ${row.raw.last_name ?? ''}`.trim(),
                row.errors.join('; ') || 'Valid',
              ])}
            />
          </>
        ) : null}
      </Dialog>
      <Dialog visible={aiPromptOpen} title="Prepare roster with another AI" onClose={() => setAiPromptOpen(false)}>
        <Text style={styles.help}>Download the APMS Excel template, attach it together with your current roster to another AI assistant, then use the prompt below.</Text>
        <Text selectable style={styles.aiPrompt}>{aiRosterPrompt}</Text>
        <Button label="Copy AI formatting prompt" onPress={() => void copyAiRosterPrompt()} />
      </Dialog>
      <ConfirmDialog visible={deleteSelectedOpen} title="Remove selected students?" message={`Remove ${selectedEnrollmentIds.length} selected student${selectedEnrollmentIds.length === 1 ? '' : 's'} from this class? Their scores, attendance, and monitoring records for this class will also be removed. Student identities remain available for other classes.`} confirmLabel="Remove students" cancelLabel="Keep students" danger pending={saving} onClose={() => { if (!saving) setDeleteSelectedOpen(false); }} onConfirm={() => void deleteSelected()} />
    </>
  );
}

function Gradebook(props: StateProps) {
  const { user } = useAuth();
  const activeGradingSystem = props.workspace.criteria?.gradingSystemDefinition ?? props.workspace.defaultGradingSystem ?? IT_GLOBAL_GRADING_SYSTEM;
  const [gradebookView, setGradebookView] = useState<'assessment' | 'full'>('assessment');
  const [assessmentId, setAssessmentId] = useState(props.workspace.assessments[0]?.id ?? '');
  const [values, setValues] = useState<Record<string, string>>({});
  const [fullValues, setFullValues] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [studentQuery, setStudentQuery] = useState('');
  const [studentFilter, setStudentFilter] = useState<'all' | 'missing' | 'at_risk' | 'passing'>('all');
  const [selectedStudents, setSelectedStudents] = useState<string[]>([]);
  const [bulkScore, setBulkScore] = useState('');
  const [studentSort, setStudentSort] = useState<'class_number' | 'name' | 'risk' | 'standing'>('class_number');
  const [page, setPage] = useState(1);
  const [paginationByView, setPaginationByView] = useState({ assessment: true, full: false });
  const paginationEnabled = paginationByView[gradebookView];
  const [form, setForm] = useState<AssessmentFormState>(emptyAssessmentForm);

  useEffect(() => {
    if (!props.workspace.assessments.some((item) => item.id === assessmentId)) {
      setAssessmentId(props.workspace.assessments[0]?.id ?? '');
    }
  }, [assessmentId, props.workspace.assessments]);
  useEffect(() => { setValues({}); setFullValues({}); setSelectedStudents([]); }, [props.selectedClassId]);

  const selected = props.workspace.assessments.find((item) => item.id === assessmentId);
  const selectedCategoryMapping = selected ? valueMappingForType(activeGradingSystem, selected.gradingTypeId ?? selected.component) : undefined;
  const effectiveScore = (enrollmentId: string) => values[enrollmentId] ?? String(storedAssessmentValue(props.workspace, enrollmentId, assessmentId) ?? '');
  const fullDirtyEntries = Object.entries(fullValues).flatMap(([key, value]) => {
    const separator = key.indexOf(':');
    if (separator < 0) return [];
    const enrollmentId = key.slice(0, separator);
    const targetAssessmentId = key.slice(separator + 1);
    const assessment = props.workspace.assessments.find((item) => item.id === targetAssessmentId);
    if (!assessment) return [];
    const saved = storedAssessmentValue(props.workspace, enrollmentId, targetAssessmentId);
    if (value.trim() === (saved == null ? '' : String(saved))) return [];
    const mapping = valueMappingForType(activeGradingSystem, assessment.gradingTypeId ?? assessment.component);
    return [{ enrollmentId, assessment, value: value.trim(), error: validateAssessmentValue(value, assessment.maximumScore, mapping), mapping }];
  });
  const fullInvalidEntries = fullDirtyEntries.filter((entry) => entry.error);
  const dirtyCount = selected
    ? props.workspace.students.filter((student) => {
        const next = effectiveScore(student.enrollmentId).trim();
        const saved = storedAssessmentValue(props.workspace, student.enrollmentId, selected.id);
        return next !== (saved == null ? '' : String(saved));
      }).length
    : 0;
  const scoreErrorFor = (studentId: string) => validateAssessmentValue(effectiveScore(studentId), selected?.maximumScore ?? 0, selectedCategoryMapping);
  const invalidScoreCount = selected ? props.workspace.students.filter((student) => !!scoreErrorFor(student.enrollmentId)).length : 0;
  const hasInvalidScores = invalidScoreCount > 0;
  const visibleStudents = useMemo(() => {
    const normalizedQuery = studentQuery.trim().toLowerCase();
    const filtered = props.workspace.students.filter((student) => {
      const matchesQuery = !normalizedQuery || `${student.name} ${student.institutionalId}`.toLowerCase().includes(normalizedQuery);
      if (!matchesQuery) return false;
      if (studentFilter === 'missing') return gradebookView === 'assessment'
        ? effectiveScore(student.enrollmentId).trim() === ''
        : props.workspace.assessments.some((item) => !String(fullValues[`${student.enrollmentId}:${item.id}`] ?? storedAssessmentValue(props.workspace, student.enrollmentId, item.id) ?? '').trim());
      if (studentFilter === 'at_risk') return riskFor(props.workspace, student.enrollmentId) !== 'low';
      if (studentFilter === 'passing') return summarizeEnrollmentStanding(props.workspace, student.enrollmentId).remarks === 'passing';
      return true;
    });
    const insertionOrder = new Map(props.workspace.students.map((student, index) => [student.enrollmentId, index]));
    return filtered.sort((a, b) => {
      if (studentSort === 'class_number') {
        const classNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && value.trim() && Number.isFinite(Number(value)) ? Number(value) : null;
        const aNumber = classNumber(a.classNumber);
        const bNumber = classNumber(b.classNumber);
        if (aNumber != null && bNumber != null && aNumber !== bNumber) return aNumber - bNumber;
        if (aNumber != null && bNumber == null) return -1;
        if (aNumber == null && bNumber != null) return 1;
        return (insertionOrder.get(a.enrollmentId) ?? 0) - (insertionOrder.get(b.enrollmentId) ?? 0);
      }
      if (studentSort === 'risk') {
        const rank = { high: 0, medium: 1, low: 2, unavailable: 3 } as const;
        return (rank[riskFor(props.workspace, a.enrollmentId) as keyof typeof rank] ?? 3) - (rank[riskFor(props.workspace, b.enrollmentId) as keyof typeof rank] ?? 3);
      }
      if (studentSort === 'standing') return (currentStanding(props.workspace, b.enrollmentId) ?? -1) - (currentStanding(props.workspace, a.enrollmentId) ?? -1);
      return a.name.localeCompare(b.name);
    });
  }, [props.workspace, studentFilter, studentQuery, values, fullValues, assessmentId, studentSort, gradebookView]);
  const pageSize = 10;
  const pageCount = Math.max(1, Math.ceil(visibleStudents.length / pageSize));
  const pageStudents = paginationEnabled ? visibleStudents.slice((page - 1) * pageSize, page * pageSize) : visibleStudents;
  useEffect(() => { setPage(1); }, [assessmentId, studentFilter, studentQuery, studentSort, props.selectedClassId, props.workspace.students.length]);
  const resetForm = () => setForm(emptyAssessmentForm);
  const openCreate = () => {
    const firstType = activeGradingSystem.assessmentTypes?.[0];
    const firstPeriod = activeGradingSystem.periods?.[0];
    const scope = firstType ? assessmentTypeScope(activeGradingSystem, firstType.id) : null;
    setForm({ ...emptyAssessmentForm, ...(firstType ? assessmentTypeDefaults(activeGradingSystem, firstType.id) : {}), gradingTypeId: firstType?.id ?? '', component: swunextAssessmentComponents.some((item) => item.key === firstType?.id) ? firstType!.id as SwunextAssessmentComponent : 'other', gradingGroupId: '', moduleNumber: '', gradingPeriodId: scope?.overall ? '' : firstPeriod?.id ?? '', gradingPeriod: scope?.overall ? '' : firstPeriod?.name ?? '' });
    setOpen(true);
  };
  const openEditAssessment = (assessment: FacultyAssessment) => {
    setAssessmentId(assessment.id);
    const periods = activeGradingSystem.periods ?? [];
    const groups = activeGradingSystem.groups ?? [];
    const group = groups.find((item: { id: string }) => item.id === assessment.gradingGroupId)
      ?? groups.find((item: { id: string }) => item.id === (assessment.moduleNumber == null ? '' : `m${assessment.moduleNumber}`));
    const typeId = assessment.gradingTypeId ?? assessment.component;
    const typeScope = assessmentTypeScope(activeGradingSystem, typeId);
    const defaults = assessmentTypeDefaults(activeGradingSystem, typeId);
    const period = typeScope.overall ? undefined : periods.find((item: { id: string }) => item.id === assessment.gradingPeriodId)
      ?? periods.find((item: { name: string }) => item.name === assessment.gradingPeriod)
      ?? periods[0];
    setForm({
      title: assessment.title,
      component: assessment.component,
      gradingTypeId: typeId,
      gradingGroupId: typeScope.overall ? '' : group?.id ?? '',
      gradingPeriodId: period?.id ?? '',
      instanceWeight: ['equal', 'points'].includes(assessmentAggregationMode(activeGradingSystem, typeId)) ? '' : assessment.instanceWeight == null ? defaults.instanceWeight : String(assessment.instanceWeight),
      maximumScore: String(assessment.maximumScore),
      moduleNumber: typeScope.overall || assessment.moduleNumber == null ? '' : String(assessment.moduleNumber),
      date: assessment.assessmentDate,
      gradingPeriod: period?.name ?? '',
      source: assessment.source as 'manual' | 'csv',
    });
    setEditOpen(true);
  };
  const openEdit = () => { if (selected) openEditAssessment(selected); };

  const assessmentInput = () => ({
    ...form,
    type: form.component,
    gradingTypeId: form.gradingTypeId,
    gradingGroupId: form.gradingGroupId || null,
    gradingPeriodId: form.gradingPeriodId || null,
    instanceWeight: form.instanceWeight.trim() ? Number(form.instanceWeight) : null,
    maximumScore: Number(form.maximumScore),
    moduleNumber: form.moduleNumber.trim() ? Number(form.moduleNumber) : null,
  });

  const create = async () => {
    if (!user || !props.selectedClassId) return;
    setSaving(true);
    try {
      await createAssessment(props.selectedClassId, user.id, assessmentInput());
      setOpen(false);
      resetForm();
      props.toast.show('Assessment created.');
      props.refresh();
    } catch (cause) {
      props.toast.show(cause instanceof Error ? cause.message : 'Assessment creation failed.');
    } finally {
      setSaving(false);
    }
  };

  const saveEdit = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      await updateAssessment(selected.id, assessmentInput());
      setEditOpen(false);
      resetForm();
      props.toast.show('Assessment updated.');
      props.refresh();
    } catch (cause) {
      props.toast.show(cause instanceof Error ? cause.message : 'Assessment update failed.');
    } finally {
      setSaving(false);
    }
  };

  const focusFirstInvalidScore = () => {
    const sorted = [...props.workspace.students].sort((a, b) => a.name.localeCompare(b.name));
    const invalidIndex = sorted.findIndex((student) => !!scoreErrorFor(student.enrollmentId));
    if (invalidIndex < 0) return;
    setStudentQuery(''); setStudentFilter('all'); setStudentSort('name'); setPage(Math.floor(invalidIndex / pageSize) + 1);
  };

  const save = async () => {
    if (!user || !selected) return;
    if (hasInvalidScores) {
      const invalidStudent = props.workspace.students.find((student) => !!scoreErrorFor(student.enrollmentId));
      focusFirstInvalidScore();
      return props.toast.show(`${invalidStudent?.name ?? 'Student'}: ${invalidStudent ? scoreErrorFor(invalidStudent.enrollmentId) : 'Score is invalid.'}`);
    }
    const rows = props.workspace.students.flatMap((student): { enrollmentId: string; score?: number; categoricalValue?: string }[] => {
      const raw = values[student.enrollmentId] ?? String(storedAssessmentValue(props.workspace, student.enrollmentId, selected.id) ?? '');
      if (!raw.trim()) return Object.prototype.hasOwnProperty.call(values, student.enrollmentId) && storedAssessmentValue(props.workspace, student.enrollmentId, selected.id) != null ? [{ enrollmentId: student.enrollmentId }] : [];
      return selectedCategoryMapping
        ? [{ enrollmentId: student.enrollmentId, categoricalValue: raw }]
        : [{ enrollmentId: student.enrollmentId, score: Number(raw) }];
    });
    setSaving(true);
    try {
      await saveScores(user.id, selected.id, rows);
      props.toast.show(`${rows.length} scores saved to Supabase.`);
      props.refresh();
    } catch (cause) {
      props.toast.show(cause instanceof Error ? cause.message : 'Scores could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const saveFullView = async () => {
    if (!user || !fullDirtyEntries.length) return;
    if (fullInvalidEntries.length) {
      const firstInvalid = fullInvalidEntries[0];
      setStudentQuery(''); setStudentFilter('all'); setStudentSort('name');
      return props.toast.show(`${props.workspace.students.find((student) => student.enrollmentId === firstInvalid.enrollmentId)?.name ?? 'Student'}, ${firstInvalid.assessment.title}: ${firstInvalid.error}`);
    }
    const byAssessment = new Map<string, { enrollmentId: string; score?: number; categoricalValue?: string }[]>();
    for (const entry of fullDirtyEntries) {
      const rows = byAssessment.get(entry.assessment.id) ?? [];
      rows.push(entry.value ? entry.mapping ? { enrollmentId: entry.enrollmentId, categoricalValue: entry.value } : { enrollmentId: entry.enrollmentId, score: Number(entry.value) } : { enrollmentId: entry.enrollmentId });
      byAssessment.set(entry.assessment.id, rows);
    }
    setSaving(true);
    try {
      await Promise.all([...byAssessment].map(([id, rows]) => saveScores(user.id, id, rows)));
      props.toast.show(`${fullDirtyEntries.length} score change${fullDirtyEntries.length === 1 ? '' : 's'} saved.`);
      props.refresh();
    } catch (cause) {
      props.toast.show(cause instanceof Error ? cause.message : 'Scores could not be saved.');
    } finally { setSaving(false); }
  };

  const toggleStudent = (enrollmentId: string) => {
    setSelectedStudents((current) => current.includes(enrollmentId) ? current.filter((id) => id !== enrollmentId) : [...current, enrollmentId]);
  };

  const selectVisible = () => setSelectedStudents((current) => Array.from(new Set([...current, ...pageStudents.map((student) => student.enrollmentId)])));
  const clearSelection = () => setSelectedStudents([]);
  const clearPageSelection = () => setSelectedStudents((current) => current.filter((id) => !pageStudents.some((student) => student.enrollmentId === id)));
  const applyBulkScore = () => {
    if (!bulkScore.trim() || !selectedStudents.length) return props.toast.show('Select students and enter a score first.');
    const error = validateAssessmentValue(bulkScore, selected?.maximumScore ?? 0, selectedCategoryMapping);
    if (error) return props.toast.show(error);
    setValues((current) => Object.fromEntries([...Object.entries(current), ...selectedStudents.map((id) => [id, bulkScore.trim()])]));
    setBulkScore('');
    props.toast.show(`Applied ${bulkScore.trim()} to ${selectedStudents.length} students. Review before saving.`);
  };

  const pasteScores = async () => {
    if (Platform.OS !== 'web' || !globalThis.navigator?.clipboard) return props.toast.show('Clipboard paste is available in the web app.');
    try {
      const text = await globalThis.navigator.clipboard.readText();
      const scores = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => line.split(/\t|,/).pop()?.trim() ?? '');
      if (!scores.length) return props.toast.show('No scores found in the clipboard.');
      if (scores.length > pageStudents.length) return props.toast.show(`The clipboard has ${scores.length} scores but only ${pageStudents.length} students are visible on this page.`);
      const invalidIndex = scores.findIndex((score) => !!validateAssessmentValue(score, selected?.maximumScore ?? 0, selectedCategoryMapping));
      if (invalidIndex >= 0) return props.toast.show(selectedCategoryMapping ? `Pasted score on row ${invalidIndex + 1} is invalid. Use one of the configured categories.` : `Pasted score on row ${invalidIndex + 1} is invalid. Enter a value from 0 to ${selected?.maximumScore ?? 0}.`);
      const targets = pageStudents.slice(0, scores.length);
      setValues((current) => Object.fromEntries([...Object.entries(current), ...targets.map((student, index) => [student.enrollmentId, scores[index]])]));
      props.toast.show(`Pasted ${targets.length} scores in visible student order. Review before saving.`);
    } catch {
      props.toast.show('Clipboard access was blocked. Copy the scores, then try again.');
    }
  };

  return (
    <>
      <Heading
        title="Class Gradebook"
        subtitle={`Grades use ${activeGradingSystem.name}. Scores are provisional monitoring indicators; official records are kept in SWU SIS.`}
        action={
          <View style={styles.actions}>
            <Button label="Edit assessment" variant="secondary" disabled={!selected} onPress={openEdit} />
            <Button label="Create assessment" onPress={openCreate} />
          </View>
        }
      />
      <ClassSelect {...props} />
      <View style={styles.gradebookTabs}>
        <Button label="Assessment View" variant={gradebookView === 'assessment' ? 'primary' : 'secondary'} onPress={() => { setGradebookView('assessment'); setPage(1); }} />
        <Button label="Full View" variant={gradebookView === 'full' ? 'primary' : 'secondary'} onPress={() => { setGradebookView('full'); setPage(1); }} />
        <Pressable accessibilityRole="switch" accessibilityState={{ checked: paginationEnabled }} onPress={() => { setPaginationByView((current) => ({ ...current, [gradebookView]: !current[gradebookView] })); setPage(1); }} style={styles.paginationToggle}>
          <Text style={styles.paginationToggleLabel}>Pagination</Text>
          <View style={[styles.paginationSwitch, paginationEnabled && styles.paginationSwitchOn]}><View style={[styles.paginationSwitchThumb, paginationEnabled && styles.paginationSwitchThumbOn]} /></View>
          <Text style={styles.paginationToggleState}>{paginationEnabled ? 'On' : 'Off'}</Text>
        </Pressable>
      </View>
      {gradebookView === 'assessment' ? <SelectField
        label="Assessment"
        value={assessmentId}
        options={props.workspace.assessments.map((item) => ({
          label: assessmentOptionLabel(item, activeGradingSystem),
          value: item.id,
        }))}
        searchable
        onChange={(value) => {
          setAssessmentId(value);
          setValues({});
          setStudentQuery('');
          setStudentFilter('all');
        }}
      /> : null}
      <Card>
        {gradebookView === 'full' ? (
          <FullAssessmentView
            assessments={props.workspace.assessments}
            students={pageStudents}
            allStudents={visibleStudents}
            workspace={props.workspace}
            gradingSystem={activeGradingSystem}
            values={fullValues}
            onChange={(key, value) => setFullValues((current) => ({ ...current, [key]: value }))}
            dirtyCount={fullDirtyEntries.length}
            invalidCount={fullInvalidEntries.length}
            saving={saving}
            onSave={() => void saveFullView()}
            studentQuery={studentQuery}
            onStudentQuery={setStudentQuery}
            studentFilter={studentFilter}
            onStudentFilter={(value) => setStudentFilter(value as typeof studentFilter)}
            studentSort={studentSort}
            onStudentSort={(value) => setStudentSort(value as typeof studentSort)}
            visibleCount={visibleStudents.length}
            page={page}
            pageCount={pageCount}
            paginationEnabled={paginationEnabled}
            onPageChange={setPage}
            onToast={(message) => props.toast.show(message)}
            onEditAssessment={openEditAssessment}
          />
        ) : selected ? (
          <>
            <View style={styles.assessmentContext}>
              <View style={styles.flex}>
                <Text style={styles.assessmentTitle}>{selected.title}</Text>
                <Text style={styles.help}>{componentLabel(selected.component, selected.gradingTypeId, activeGradingSystem)} · {selected.gradingPeriod}{selected.moduleNumber == null ? '' : ` · Module ${selected.moduleNumber}`}</Text>
              </View>
              <Text style={styles.maxScore}>{selectedCategoryMapping ? `Max ${highestCategory(selectedCategoryMapping)}` : `Max ${selected.maximumScore}`}</Text>
            </View>
            <Text style={styles.help}>{selected.component === 'other' ? 'Scoring follows the rules configured for this assessment type.' : assessmentHelp(selected.component)} Blank scores are excluded from running calculations until recorded.</Text>
            <View style={styles.gradeToolbar}>
              <Field label="Find student" value={studentQuery} placeholder="Name or student ID" onChangeText={setStudentQuery} containerStyle={styles.studentSearch} />
              <SelectField
                label="Show"
                value={studentFilter}
                options={[
                  { label: 'All students', value: 'all' },
                  { label: 'Missing this score', value: 'missing' },
                  { label: 'At-risk students', value: 'at_risk' },
                  { label: 'Passing students', value: 'passing' },
                ]}
                onChange={(value) => setStudentFilter(value as typeof studentFilter)}
                containerStyle={styles.studentFilter}
              />
              <SelectField label="Sort" value={studentSort} options={[{ label: 'Class number (ascending)', value: 'class_number' }, { label: 'Name (A–Z)', value: 'name' }, { label: 'Highest risk first', value: 'risk' }, { label: 'Lowest standing first', value: 'standing' }]} onChange={(value) => setStudentSort(value as typeof studentSort)} containerStyle={styles.studentSort} />
              <Text style={styles.resultCount}>{paginationEnabled ? `${visibleStudents.length} students · Page ${page} of ${pageCount}` : `${visibleStudents.length} students · Showing all`}</Text>
            </View>
            <View style={styles.bulkBar}>
              <Button label={pageStudents.length && pageStudents.every((student) => selectedStudents.includes(student.enrollmentId)) ? 'Clear page' : 'Select page'} variant="secondary" onPress={pageStudents.length && pageStudents.every((student) => selectedStudents.includes(student.enrollmentId)) ? clearPageSelection : selectVisible} />
              {selectedCategoryMapping ? <SelectField label="Bulk score" value={bulkScore} error={bulkScore.trim() ? validateAssessmentValue(bulkScore, selected.maximumScore, selectedCategoryMapping) : undefined} options={[{ label: 'Choose a category', value: '' }, ...selectedCategoryMapping.map((item) => ({ label: `${item.value} · ${item.percentage}%`, value: item.value }))]} onChange={setBulkScore} containerStyle={styles.bulkScoreField} /> : <Field label="Bulk score" value={bulkScore} error={bulkScore.trim() ? validateScore(bulkScore, selected.maximumScore) : undefined} placeholder={`0–${selected.maximumScore}`} keyboardType="decimal-pad" onChangeText={setBulkScore} containerStyle={styles.bulkScoreField} />}
              <Button label={`Apply to ${selectedStudents.length || 'selected'}`} disabled={!selectedStudents.length || !bulkScore.trim() || !!validateAssessmentValue(bulkScore, selected.maximumScore, selectedCategoryMapping)} onPress={applyBulkScore} />
              <Button label="Paste scores" variant="secondary" onPress={() => void pasteScores()} />
              <Text style={styles.help}>Paste one score per line; values follow the visible student order.</Text>
            </View>
            <View style={styles.gradeHeader}>
              <Text style={[styles.gradeHeaderText, styles.gradeStudentColumn]}>STUDENT</Text>
              <Text style={[styles.gradeHeaderText, styles.gradeSummaryColumn]}>GRADE SUMMARY · {activeGradingSystem.name.toUpperCase()}</Text>
              <Text style={[styles.gradeHeaderText, styles.gradeScoreColumn]}>{selectedCategoryMapping ? 'CATEGORY' : `SCORE / ${selected.maximumScore}`}</Text>
            </View>
            <View style={styles.gradeRows}>
              {pageStudents.map((student) => {
                const summary = summarizeEnrollmentStanding(props.workspace, student.enrollmentId);
                const calculatedGrade = calculateEnrollmentGrade(props.workspace, student.enrollmentId);
                const standing = currentStanding(props.workspace, student.enrollmentId);
                const attendance = attendanceRate(props.workspace, student.enrollmentId);
                const risk = riskFor(props.workspace, student.enrollmentId);
                const remarksTone = summary.remarks === 'passing' ? 'success' : summary.remarks === 'incomplete' ? 'warning' : 'danger';
                const riskTone = risk === 'low' ? 'success' : risk === 'medium' ? 'warning' : 'danger';
                return (
                <View key={student.enrollmentId} style={styles.gradeRow}>
                  <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: selectedStudents.includes(student.enrollmentId) }} onPress={() => toggleStudent(student.enrollmentId)} style={[styles.studentCheck, selectedStudents.includes(student.enrollmentId) && styles.studentCheckSelected]}>
                    <Text style={styles.studentCheckText}>{selectedStudents.includes(student.enrollmentId) ? '✓' : ''}</Text>
                  </Pressable>
                  <View style={[styles.flex, styles.gradeStudentColumn]}>
                    <Text style={styles.rowTitle}>{student.name}</Text>
                    <Text style={styles.help}>{student.institutionalId}</Text>
                  </View>
                  <View style={[styles.summaryCell, styles.gradeSummaryColumn]}>
                    <View style={styles.badgeRow}>
                      <Badge tone={remarksTone}>{summary.remarks === 'passing' ? 'Passing' : summary.remarks === 'incomplete' ? 'Incomplete' : 'Below rule'}</Badge>
                      <Badge tone={riskTone} color={props.workspace.evaluationSystem?.levels.find((level) => level.severity === risk)?.color}>{risk === 'unavailable' ? 'Unavailable' : `${risk[0].toUpperCase()}${risk.slice(1)}`} risk</Badge>
                    </View>
                    <Text style={styles.help}>Final {calculatedGrade.finalGrade == null ? '—' : `${calculatedGrade.finalGrade.toFixed(1)}%`}{calculatedGrade.pointGrade == null ? '' : ` · Point ${calculatedGrade.pointGrade}`}{calculatedGrade.letterGrade == null ? '' : ` · Letter ${calculatedGrade.letterGrade}`} · Attendance {attendance == null ? '—' : `${attendance.toFixed(0)}%`} · Missing {missingAssessments(props.workspace, student.enrollmentId)}</Text>
                  </View>
                  {selectedCategoryMapping ? <SelectField label="Score" value={effectiveScore(student.enrollmentId)} error={scoreErrorFor(student.enrollmentId)} options={[{ label: 'Unscored', value: '' }, ...selectedCategoryMapping.map((item) => ({ label: `${item.value} · ${item.percentage}%`, value: item.value }))]} onChange={(value) => setValues((current) => ({ ...current, [student.enrollmentId]: value }))} containerStyle={styles.scoreField} /> : <Field label="Score" value={effectiveScore(student.enrollmentId)} error={scoreErrorFor(student.enrollmentId)} keyboardType="decimal-pad" onChangeText={(value) => setValues((current) => ({ ...current, [student.enrollmentId]: value }))} containerStyle={styles.scoreField} />}
                </View>
                );
              })}
              {!visibleStudents.length ? <PageState kind="empty" title="No matching students" message="Try a different search or filter." /> : null}
            </View>
            {paginationEnabled && visibleStudents.length > pageSize ? <View style={styles.pagination}><Button label="Previous" variant="secondary" disabled={page <= 1} onPress={() => setPage((current) => Math.max(1, current - 1))} /><Text style={styles.paginationText}>Page {page} of {pageCount} · {visibleStudents.length} students</Text><Button label="Next" variant="secondary" disabled={page >= pageCount} onPress={() => setPage((current) => Math.min(pageCount, current + 1))} /></View> : null}
            <View style={styles.saveBar}>
              <View style={styles.flex}>
                <Text style={styles.saveState}>{dirtyCount ? `${dirtyCount} unsaved change${dirtyCount === 1 ? '' : 's'}` : 'All scores saved'}</Text>
                <Text style={styles.help}>{invalidScoreCount ? `${invalidScoreCount} score${invalidScoreCount === 1 ? '' : 's'} need correction. ${selectedCategoryMapping ? 'Choose a configured category.' : `Enter numeric values from 0 to ${selected.maximumScore}.`}` : 'Scores remain provisional monitoring data until recorded in SWU SIS.'}</Text>
              </View>
              {invalidScoreCount ? <Button label={`Review ${invalidScoreCount} invalid score${invalidScoreCount === 1 ? '' : 's'}`} variant="danger" onPress={focusFirstInvalidScore} /> : null}
              <Button label="Save all scores" loading={saving} disabled={!dirtyCount || hasInvalidScores} onPress={() => void save()} />
            </View>
          </>
        ) : (
          <PageState kind="empty" title="No assessment selected" message="Create an assessment before entering scores." />
        )}
      </Card>
      <AssessmentDialog
        visible={open}
        title="Create assessment"
        form={form}
        gradingSystem={activeGradingSystem}
        gradingTypes={activeGradingSystem.assessmentTypes ?? []}
        periods={activeGradingSystem.periods ?? []}
        groups={activeGradingSystem.groups ?? []}
        saving={saving}
        onChange={setForm}
        onClose={() => { setOpen(false); resetForm(); }}
        onSubmit={create}
        submitLabel="Create assessment"
      />
      <AssessmentDialog
        visible={editOpen}
        title="Edit assessment"
        form={form}
        gradingSystem={activeGradingSystem}
        gradingTypes={activeGradingSystem.assessmentTypes ?? []}
        periods={activeGradingSystem.periods ?? []}
        groups={activeGradingSystem.groups ?? []}
        saving={saving}
        onChange={setForm}
        onClose={() => { setEditOpen(false); resetForm(); }}
        onSubmit={saveEdit}
        submitLabel="Save assessment changes"
      />
    </>
  );
}

type FullAssessmentViewProps = {
  assessments: FacultyAssessment[];
  students: RosterStudent[];
  allStudents: RosterStudent[];
  workspace: ClassWorkspace;
  gradingSystem: any;
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  dirtyCount: number;
  invalidCount: number;
  saving: boolean;
  onSave: () => void;
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
};

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

type FullViewColumn = {
  id: string;
  kind: 'assessment' | 'component' | 'group' | 'period' | 'non_period' | 'final' | 'final_equivalent';
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

function FullAssessmentView(props: FullAssessmentViewProps) {
  const { assessments, students, workspace, gradingSystem } = props;
  const columnCssKey = (key: string) => {
    let hash = 2166136261;
    for (let index = 0; index < key.length; index += 1) hash = Math.imul(hash ^ key.charCodeAt(index), 16777619);
    return String(hash >>> 0);
  };
  const [contextMenu, setContextMenu] = useState<GradebookContextMenuState>(null);
  const [internalClipboard, setInternalClipboard] = useState('');
  const [hiddenHeaderLevels, setHiddenHeaderLevels] = useState<Set<string>>(new Set());
  const [sectionStates, setSectionStates] = useState<Record<string, { mode: 'collapsed' | 'hidden'; columnIds: string[]; keepColumnIds: string[] }>>({});
  const [hideSingleChildComponentGrades, setHideSingleChildComponentGrades] = useState(false);
  const [calculatedCellDisplay, setCalculatedCellDisplay] = useState<'grade' | 'contribution'>('grade');
  const [viewOptionsOpen, setViewOptionsOpen] = useState(false);
  const [exportingExcel, setExportingExcel] = useState(false);
  const [bulkScoreAssessment, setBulkScoreAssessment] = useState<FacultyAssessment | null>(null);
  const [bulkScoreValue, setBulkScoreValue] = useState('');
  const [filterTarget, setFilterTarget] = useState<GradebookFilterTarget | null>(null);
  const [filterOperator, setFilterOperator] = useState('contains');
  const [filterValue, setFilterValue] = useState('');
  const [rowFilters, setRowFilters] = useState<Record<string, GradebookRowFilter>>({});
  const [headerSort, setHeaderSort] = useState<{ key: string; label: string; direction: 'asc' | 'desc' } | null>(null);
  const [showClassNumber, setShowClassNumber] = useState(true);
  const [showStudentName, setShowStudentName] = useState(true);
  const [showStudentId, setShowStudentId] = useState(true);
  const [showAnonymousId, setShowAnonymousId] = useState(false);
  const [randomizeRows, setRandomizeRows] = useState(false);
  const [randomOrderSeed, setRandomOrderSeed] = useState(1);
  const [gridHasScrolled, setGridHasScrolled] = useState({ x: false, y: false });
  const gridScrollElementRef = useRef<any>(null);
  const hoveredColumnNodesRef = useRef<any[]>([]);
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
  const contextProps = (actions: GradebookContextAction[]) => ({ onContextMenu: (event: any) => showContextMenu(event, actions) } as any);
  const clickContextProps = (actions: GradebookContextAction[]) => ({ onClick: (event: any) => showContextMenu(event, actions), onContextMenu: (event: any) => showContextMenu(event, actions) } as any);
  const clearColumnHover = () => {
    hoveredColumnNodesRef.current.forEach((node) => node.classList?.remove('gradebook-column-hovered', 'gradebook-column-hovered-current'));
    hoveredColumnNodesRef.current = [];
  };
  const columnHoverProps = (ids: string[]) => Platform.OS === 'web' ? ({ onMouseEnter: (event: any) => {
    const root = event.currentTarget?.closest?.('[data-gradebook-grid]');
    if (!root) return;
    clearColumnHover();
    event.currentTarget?.classList?.add('gradebook-column-hovered-current');
    const keys = ids.map(columnCssKey);
    root.querySelectorAll('[data-gradebook-col],[data-gradebook-cols]').forEach((node: any) => {
      const single = node.getAttribute('data-gradebook-col');
      const merged = node.getAttribute('data-gradebook-cols')?.split(/\s+/) ?? [];
      if ((single && keys.includes(single)) || keys.some((key) => merged.includes(key))) {
        node.classList?.add('gradebook-column-hovered');
        hoveredColumnNodesRef.current.push(node);
      }
    });
  }, onMouseLeave: (event: any) => {
    if (!event.relatedTarget?.closest?.('[data-gradebook-col],[data-gradebook-cols]')) clearColumnHover();
  } } as any) : {};
  const noHeaderSelection = Platform.OS === 'web' ? ({ userSelect: 'none', WebkitUserSelect: 'none' } as any) : null;
  const copyText = async (value: string) => {
    setInternalClipboard(value);
    try { await globalThis.navigator?.clipboard?.writeText(value); } catch { /* keep the in-app clipboard available */ }
  };
  const pasteText = async () => {
    try { return await globalThis.navigator?.clipboard?.readText() ?? internalClipboard; } catch { return internalClipboard; }
  };
  const orderedAssessments = [...assessments].sort((a, b) => {
    const periodSequence = (assessment: FacultyAssessment) => { const index = gradingSystem.periods?.findIndex((period: any) => period.id === assessment.gradingPeriodId || period.name === assessment.gradingPeriod) ?? -1; return index < 0 ? Number.MAX_SAFE_INTEGER : index; };
    const groupSequence = (assessment: FacultyAssessment) => { const groupId = assessment.gradingGroupId ?? (assessment.moduleNumber == null ? '' : `m${assessment.moduleNumber}`); const index = gradingSystem.groups?.findIndex((group: any) => group.id === groupId) ?? -1; return index < 0 ? Number.MAX_SAFE_INTEGER : index; };
      const componentSequence = (assessment: FacultyAssessment) => {
      const component = gradingSystem.components?.find((item: any) => item.assessmentDefinition?.typeId === (assessment.gradingTypeId ?? assessment.component));
      return component?.sequence ?? 9999;
    };
    return periodSequence(a) - periodSequence(b) || groupSequence(a) - groupSequence(b) || componentSequence(a) - componentSequence(b) || a.assessmentDate.localeCompare(b.assessmentDate) || a.title.localeCompare(b.title);
  });
  const columnWidths = new Map(orderedAssessments.map((assessment) => [assessment.id, fullAssessmentColumnWidth(assessment, gradingSystem, workspace, props.values)]));
  const columnWidth = (assessment: FacultyAssessment) => columnWidths.get(assessment.id) ?? 42;
  const columns = fullViewColumns(orderedAssessments, gradingSystem, columnWidth, hideSingleChildComponentGrades);
  const hoverColumnsKey = [...new Set(['student_class_number', 'student_name', 'student_id', 'student_anonymous_id', ...columns.map((column) => column.id)].map(columnCssKey))].join(',');
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    let style = document.getElementById('gradebook-hover-styles') as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement('style');
      style.id = 'gradebook-hover-styles';
      document.head.appendChild(style);
    }
    style.textContent = `[data-gradebook-grid] [data-gradebook-row]:hover [data-gradebook-hover-cell] { background-color:#F8FAFD!important; }.gradebook-column-hovered { background-color:#F6F9FE!important; }.gradebook-column-hovered-current { background-color:#EEF4FF!important; }`;
  }, [hoverColumnsKey]);
  const visibleColumns = columns.filter((column) => !Object.values(sectionStates).some((section) => section.columnIds.includes(column.id) && (section.mode === 'hidden' || !section.keepColumnIds.includes(column.id))));
  const hiddenSectionCount = Object.values(sectionStates).filter((section) => section.mode === 'hidden').length;
  const collapsedSectionCount = Object.values(sectionStates).filter((section) => section.mode === 'collapsed').length;
  const hiddenHeaderLevelCount = hiddenHeaderLevels.size;
  const tableWidth = frozenStudentWidth + visibleColumns.reduce((total, column) => total + column.width, 0);
  const studentIds = props.allStudents.map((student) => student.enrollmentId).join('|');
  const gradeResults = useMemo(() => new Map(props.allStudents.map((student) => [student.enrollmentId, calculateFullViewGrades(workspace, student.enrollmentId, gradingSystem, props.values)])), [studentIds, workspace, gradingSystem, props.values]);
  const rowValue = (student: RosterStudent, key: string) => {
    if (key === 'student_class_number') return student.classNumber ?? '';
    if (key === 'student_name') return student.name ?? '';
    if (key === 'student_id') return student.institutionalId ?? '';
    const column = columns.find((item) => item.id === key);
    if (!column) return '';
    return displayedFullViewColumnValue(column, student.enrollmentId, gradeResults.get(student.enrollmentId) ?? calculateFullViewGrades(workspace, student.enrollmentId, gradingSystem, props.values), workspace, props.values, gradingSystem, calculatedCellDisplay);
  };
  const filteredStudents = props.allStudents.filter((student) => Object.entries(rowFilters).every(([key, filter]) => {
    const raw = String(rowValue(student, key) ?? '').trim();
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
  }));
  const sortedStudents = headerSort ? [...filteredStudents].sort((a, b) => {
    const left = String(rowValue(a, headerSort.key) ?? '').trim();
    const right = String(rowValue(b, headerSort.key) ?? '').trim();
    const leftNumber = Number.parseFloat(left.replace('%', '')); const rightNumber = Number.parseFloat(right.replace('%', ''));
    const comparison = left && right && Number.isFinite(leftNumber) && Number.isFinite(rightNumber) ? leftNumber - rightNumber : left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
    return headerSort.direction === 'asc' ? comparison : -comparison;
  }) : filteredStudents;
  const localPageCount = Math.max(1, Math.ceil(sortedStudents.length / 10));
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
  const orderedStudents = randomizeRows ? [...sortedStudents].sort((a, b) => rowHash(a.enrollmentId) - rowHash(b.enrollmentId)) : sortedStudents;
  const displayStudents = props.paginationEnabled ? orderedStudents.slice((props.page - 1) * 10, props.page * 10) : orderedStudents;
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
  const clearSortAndFilters = () => {
    setHeaderSort(null); setRowFilters({});
    props.onStudentQuery(''); props.onStudentFilter('all'); props.onStudentSort('class_number'); props.onPageChange(() => 1);
  };
  const allHierarchyRows = fullAssessmentHeaderRows(columns);
  const hierarchyRows = fullAssessmentHeaderRows(visibleColumns).filter((row) => !hiddenHeaderLevels.has(row.level));
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
        const result = gradeResults.get(student.enrollmentId) ?? calculateFullViewGrades(workspace, student.enrollmentId, gradingSystem, props.values);
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
      props.onToast(cause instanceof Error ? cause.message : 'The full gradebook could not be exported.');
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
  };
  const trackInnerGridScroll = (event: any) => {
    const offset = event?.nativeEvent?.contentOffset;
    if (offset) setGridHasScrolled((current) => {
      const y = (offset.y ?? 0) > 0.5;
      return current.y === y ? current : { ...current, y };
    });
  };
  const renderViewToggle = (label: string, checked: boolean, onPress: () => void) => <Pressable accessibilityRole="checkbox" accessibilityState={{ checked }} onPress={onPress} style={styles.fullGradeToggle}>
    <View style={[styles.fullGradeToggleBox, checked && styles.fullGradeToggleBoxSelected]}><Text style={styles.fullGradeToggleMark}>{checked ? '✓' : ''}</Text></View>
    <Text style={styles.fullGradeToggleLabel}>{label}</Text>
  </Pressable>;
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
        <SelectField label="Show" value={props.studentFilter} options={[{ label: 'All students', value: 'all' }, { label: 'Missing any score', value: 'missing' }, { label: 'At-risk students', value: 'at_risk' }, { label: 'Passing students', value: 'passing' }]} onChange={props.onStudentFilter} containerStyle={styles.studentFilter} />
        <SelectField label="Sort" value={props.studentSort} options={[{ label: 'Class number (ascending)', value: 'class_number' }, { label: 'Name (A–Z)', value: 'name' }, { label: 'Highest risk first', value: 'risk' }, { label: 'Lowest standing first', value: 'standing' }]} onChange={props.onStudentSort} containerStyle={styles.studentSort} />
        <Text style={styles.resultCount}>{props.paginationEnabled ? `${sortedStudents.length} students · Page ${props.page} of ${localPageCount}` : `${sortedStudents.length} students · Showing all`}</Text>
      </View>
      <View style={styles.fullViewOptionsBar}>
        <Button label={exportingExcel ? 'Exporting…' : 'Export Excel'} variant="secondary" disabled={exportingExcel} onPress={() => void exportFullViewExcel()} />
        <Button label="View options" variant="secondary" onPress={() => setViewOptionsOpen(true)} />
      </View>
      {!assessments.length ? <PageState kind="empty" title="No assessments yet" message="Create an assessment to start using the full gradebook." /> : (
        <View {...({ dataSet: { gradebookGrid: 'true' }, onMouseLeave: clearColumnHover } as any)} style={styles.fullGridScrollFrame}>
        <ScrollView ref={gridScrollElementRef} horizontal={Platform.OS !== 'web'} showsHorizontalScrollIndicator onScroll={trackOuterGridScroll} scrollEventThrottle={16} style={Platform.OS === 'web' ? ({ height: 560, width: '100%', overflowX: 'auto', overflowY: 'auto' } as any) : undefined}>
          <View style={{ width: tableWidth }}>
            <ScrollView onScroll={trackInnerGridScroll} scrollEventThrottle={16} style={Platform.OS === 'web' ? ({ height: 'auto', overflow: 'visible' } as any) : styles.fullGridVerticalScroll} contentContainerStyle={{ width: tableWidth }} nestedScrollEnabled stickyHeaderIndices={[0]}>
              <View style={styles.fullGridFrozenHeader}>
            {hierarchyRows.map((row, rowIndex) => {
              const canHideLevel = row.level === 'PERIOD' || row.level === 'GROUP' || row.level === 'COMPONENT' || row.level.startsWith('SUBCOMPONENT');
              const levelActions = canHideLevel ? [{ label: `Hide ${row.level.toLowerCase()} header level`, onSelect: () => setHiddenHeaderLevels((current) => new Set([...current, row.level])) }, ...(hiddenHeaderLevels.size ? [{ label: 'Show all hidden header levels', onSelect: () => setHiddenHeaderLevels(new Set()) }] : [])] : [];
              return <View key={row.level} {...({
                onContextMenuCapture: (event: any) => event.preventDefault?.(),
                onMouseDownCapture: (event: any) => { if (event.button === 0) event.preventDefault?.(); },
              } as any)} style={styles.fullHeaderRow}>
                {row.level === 'ASSESSMENT / RESULT' ? <>
                  {showClassNumber ? <View {...({ dataSet: { gradebookCol: columnCssKey('student_class_number') } } as any)} {...columnHoverProps(['student_class_number'])} {...clickContextProps(sortFilterActions({ key: 'student_class_number', label: 'Class #', kind: 'number' }))} style={[styles.fullClassNumberHeader, { width: classNumberWidth }, noHeaderSelection, Platform.OS === 'web' ? { position: 'sticky', left: studentColumnOffsets.classNumber, zIndex: 1003 } as any : null]}><Text style={styles.fullHeaderLevel}>CLASS #</Text></View> : null}
                  {showStudentName ? <View {...({ dataSet: { gradebookCol: columnCssKey('student_name') } } as any)} {...columnHoverProps(['student_name'])} {...clickContextProps(sortFilterActions({ key: 'student_name', label: 'Student', kind: 'text' }))} style={[styles.fullStudentHeader, { width: studentNameWidth }, noHeaderSelection, Platform.OS === 'web' ? { position: 'sticky', left: studentColumnOffsets.name, zIndex: 1002 } as any : null]}><Text style={styles.fullHeaderLevel}>STUDENT</Text></View> : null}
                  {showStudentId ? <View {...({ dataSet: { gradebookCol: columnCssKey('student_id') } } as any)} {...columnHoverProps(['student_id'])} {...clickContextProps(sortFilterActions({ key: 'student_id', label: 'Student ID', kind: 'text' }))} style={[styles.fullStudentHeader, { width: studentIdWidth }, noHeaderSelection, Platform.OS === 'web' ? { position: 'sticky', left: studentColumnOffsets.id, zIndex: 1001 } as any : null]}><Text style={styles.fullHeaderLevel}>STUDENT ID</Text></View> : null}
                  {showAnonymousId ? <View {...({ dataSet: { gradebookCol: columnCssKey('student_anonymous_id') } } as any)} {...columnHoverProps(['student_anonymous_id'])} style={[styles.fullStudentHeader, { width: anonymousIdWidth }, noHeaderSelection, Platform.OS === 'web' ? { position: 'sticky', left: studentColumnOffsets.anonymous, zIndex: 1000 } as any : null]}><Text style={styles.fullHeaderLevel}>ANON ID</Text></View> : null}
                </> : <View {...(levelActions.length ? clickContextProps(levelActions) : {})} style={[styles.fullHierarchyLabelColumn, { width: frozenStudentWidth }, noHeaderSelection, Platform.OS === 'web' ? { position: 'sticky', left: 0, zIndex: 10000, backgroundColor: colors.surfaceMuted } as any : null]}><Text style={styles.fullHeaderLevel}>{row.level}</Text></View>}
                {row.cells.map((cell, index) => {
                  const allCell = allHierarchyRows.find((candidate) => candidate.level === row.level)?.cells.find((candidate) => candidate.mergeKey === cell.mergeKey) ?? cell;
                  const range = columns.slice(allCell.columnStart, allCell.columnEnd + 1);
                  const headingPath = [range[0]?.period.label, range[0]?.group.label, ...range[0]?.componentPath.map((item) => item.name) ?? [], range[0]?.leafLabel].filter(Boolean).join(' › ');
                  const copyRange = async () => {
                    const lines = [`Student\t${range.map((column) => column.leafLabel).join('\t')}`];
                    for (const student of workspace.students) {
                      const result = gradeResults.get(student.enrollmentId) ?? calculateFullViewGrades(workspace, student.enrollmentId, gradingSystem, props.values);
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
                  if (row.level === 'ASSESSMENT / RESULT' && range.length === 1) {
                    const column = range[0];
                    const mapping = column.assessment ? valueMappingForType(gradingSystem, column.assessment.gradingTypeId ?? column.assessment.component) : null;
                    columnActions.push(...sortFilterActions({ key: column.id, label: column.leafLabel || column.kind, kind: mapping ? 'category' : 'number', options: mapping?.map((item) => ({ label: `${item.value} · ${item.percentage}%`, value: item.value })) }));
                  }
                  if (row.level === 'ASSESSMENT / RESULT' && range.length === 1 && range[0].kind === 'assessment' && range[0].assessment) {
                    const assessment = range[0].assessment;
                    const mapping = valueMappingForType(gradingSystem, assessment.gradingTypeId ?? assessment.component);
                    const applyColumnValue = (value: string) => filteredStudents.forEach((student) => props.onChange(`${student.enrollmentId}:${assessment.id}`, value));
                    columnActions.push(
                      { label: 'Edit assessment', onSelect: () => props.onEditAssessment(assessment) },
                      { label: `Clear values for ${filteredStudents.length} matching students`, destructive: true, onSelect: () => { applyColumnValue(''); props.onToast(`Cleared ${filteredStudents.length} scores for ${assessment.title}.`); } },
                      { label: `Set all ${filteredStudents.length} matching scores to…`, onSelect: () => { setBulkScoreAssessment(assessment); setBulkScoreValue(''); } },
                      { label: 'Paste values into this column…', onSelect: async () => { const raw = await pasteText(); if (!raw.trim()) return props.onToast('Clipboard has no values to paste.'); const lines = raw.replace(/\r/g, '').split('\n'); if (lines.at(-1) === '') lines.pop(); const values = lines.map((line) => (line.split('\t').at(-1) ?? '').trim()); if (values.length !== filteredStudents.length) return props.onToast(`Paste exactly ${filteredStudents.length} values for the matching rows.`); const invalid = values.findIndex((value) => value && validateAssessmentValue(value, assessment.maximumScore, mapping)); if (invalid >= 0) return props.onToast(`Value ${invalid + 1} is invalid: ${validateAssessmentValue(values[invalid], assessment.maximumScore, mapping)}`); values.forEach((value, studentIndex) => props.onChange(`${filteredStudents[studentIndex].enrollmentId}:${assessment.id}`, value)); props.onToast(`Pasted values into ${assessment.title}.`); } },
                    );
                  }
                  const nextRow = hierarchyRows[rowIndex + 1];
                  const continuesVertically = cell.label === '' && !!nextRow && Array.from({ length: cell.columnEnd - cell.columnStart + 1 }, (_, offset) => {
                    const columnIndex = cell.columnStart + offset;
                    return nextRow.cells.find((nextCell) => nextCell.columnStart <= columnIndex && nextCell.columnEnd >= columnIndex)?.label === '';
                  }).every(Boolean);
                  let blankRowsAbove = 0;
                  if (row.level === 'ASSESSMENT / RESULT') {
                    for (let previousRowIndex = rowIndex - 1; previousRowIndex >= 0; previousRowIndex -= 1) {
                      const previousCell = hierarchyRows[previousRowIndex].cells.find((candidate) => candidate.columnStart <= cell.columnStart && candidate.columnEnd >= cell.columnStart);
                      if (previousCell?.label !== '') break;
                      blankRowsAbove += 1;
                    }
                  }
                  const verticalMergeStyle = blankRowsAbove ? { height: (blankRowsAbove + 1) * 22, marginTop: -blankRowsAbove * 22, position: 'relative', zIndex: 0 } as any : null;
                  const dataColumnOffset = visibleColumns.slice(0, cell.columnStart).reduce((total, column) => total + column.width, 0);
                  const verticalMergeClip = blankRowsAbove && Platform.OS === 'web'
                    ? { clipPath: `inset(0 0 0 max(0px, calc(var(--gradebook-scroll-x, 0px) - ${dataColumnOffset}px)))` } as any
                    : null;
                  const headerActions = [{ label: `Copy ${row.level.toLowerCase()} label`, onSelect: () => void copyText(cell.label) }, { label: 'Copy header path', onSelect: () => void copyText(headingPath) }, { label: 'Copy values in this range', onSelect: () => void copyRange() }, ...columnActions, ...sectionActions];
                  const headerColumnIds = range.map((column) => column.id);
                  const mergedHoverKeys = headerColumnIds.map(columnCssKey).join(' ');
                  return <View key={`${row.level}-${index}-${cell.label}`} {...({ dataSet: { gradebookCols: mergedHoverKeys } } as any)} {...columnHoverProps(headerColumnIds)} {...clickContextProps(headerActions)} style={[styles.fullMergedHeader, { width: cell.width }, noHeaderSelection, continuesVertically ? styles.fullMergedHeaderVerticalContinue : null, verticalMergeStyle, verticalMergeClip]}><Text style={styles.fullMergedHeaderText} numberOfLines={2}>{cell.label}</Text></View>;
                })}
              </View>
            })}
              </View>
            {displayStudents.map((student) => {
              const gradeResult = gradeResults.get(student.enrollmentId)!;
              return <View key={student.enrollmentId} {...({ dataSet: { gradebookRow: 'true' } } as any)} style={{ width: tableWidth }}>
                <View style={styles.fullTableRow}>
                  {showClassNumber ? <View {...({ dataSet: { gradebookCol: columnCssKey('student_class_number'), gradebookHoverCell: 'true' } } as any)} {...columnHoverProps(['student_class_number'])} style={[styles.fullClassNumberColumn, { width: classNumberWidth }, Platform.OS === 'web' ? { position: 'sticky', left: studentColumnOffsets.classNumber, zIndex: 63, backgroundColor: colors.surface } as any : null]}><Text style={styles.fullStudentMeta}>{student.classNumber}</Text></View> : null}
                  {showStudentName ? <View {...({ dataSet: { gradebookCol: columnCssKey('student_name'), gradebookHoverCell: 'true' } } as any)} {...columnHoverProps(['student_name'])} {...contextProps([{ label: 'Copy student name', onSelect: () => void copyText(student.name) }, { label: 'Filter to this student', onSelect: () => props.onStudentQuery(student.name) }])} style={[styles.fullStudentNameColumn, { width: studentNameWidth }, Platform.OS === 'web' ? { position: 'sticky', left: studentColumnOffsets.name, zIndex: 62, backgroundColor: colors.surface } as any : null]}><Text style={styles.fullStudentName} numberOfLines={1}>{student.name}</Text></View> : null}
                  {showStudentId ? <View {...({ dataSet: { gradebookCol: columnCssKey('student_id'), gradebookHoverCell: 'true' } } as any)} {...columnHoverProps(['student_id'])} {...contextProps([{ label: 'Copy student ID', onSelect: () => void copyText(student.institutionalId) }])} style={[styles.fullStudentIdColumn, { width: studentIdWidth }, Platform.OS === 'web' ? { position: 'sticky', left: studentColumnOffsets.id, zIndex: 61, backgroundColor: colors.surface } as any : null]}><Text style={styles.fullStudentMeta} numberOfLines={1}>{student.institutionalId}</Text></View> : null}
                  {showAnonymousId ? <View {...({ dataSet: { gradebookCol: columnCssKey('student_anonymous_id'), gradebookHoverCell: 'true' } } as any)} {...columnHoverProps(['student_anonymous_id'])} style={[styles.fullStudentIdColumn, { width: anonymousIdWidth }, Platform.OS === 'web' ? { position: 'sticky', left: studentColumnOffsets.anonymous, zIndex: 60, backgroundColor: colors.surface } as any : null]}><Text style={styles.fullStudentMeta}>{anonymizedIds.get(student.enrollmentId) ?? '—'}</Text></View> : null}
                  {visibleColumns.map((column, columnIndex) => {
                    const dataColumnOffset = visibleColumns.slice(0, columnIndex).reduce((total, visibleColumn) => total + visibleColumn.width, 0);
                    const frozenPaneClip = Platform.OS === 'web'
                      ? { clipPath: `inset(0 0 0 max(0px, calc(var(--gradebook-scroll-x, 0px) - ${dataColumnOffset}px)))` } as any
                      : null;
                    if (column.kind !== 'assessment' || !column.assessment) {
                      const computed = displayedFullViewColumnValue(column, student.enrollmentId, gradeResult, workspace, props.values, gradingSystem, calculatedCellDisplay);
                      const finalNumber = typeof computed === 'number' ? computed : null;
                      const finalDetail = column.kind === 'final' ? gradePercent(finalNumber) : column.kind === 'final_equivalent' ? `${gradeResult.pointGrade == null ? '—' : gradeResult.pointGrade.toFixed(2)}${gradeResult.letterGrade ? ` / ${gradeResult.letterGrade}` : ''}` : gradePercent(typeof computed === 'number' ? computed : null);
                      return <View key={`${student.enrollmentId}-${column.id}`} {...({ dataSet: { gradebookCol: columnCssKey(column.id), gradebookHoverCell: 'true' } } as any)} {...columnHoverProps([column.id])} {...contextProps([{ label: 'Copy computed value', onSelect: () => void copyText(finalDetail) }, { label: `Copy ${column.leafLabel}`, onSelect: () => void copyText(`${column.leafLabel}\t${finalDetail}`) }])} style={[styles.fullAssessmentColumn, styles.fullComputedCell, { width: column.width }, frozenPaneClip]}><Text style={styles.fullComputedValue} numberOfLines={1}>{finalDetail}</Text></View>;
                    }
                    const assessment = column.assessment;
                    const key = `${student.enrollmentId}:${assessment.id}`;
                    const mapping = valueMappingForType(gradingSystem, assessment.gradingTypeId ?? assessment.component);
                    const stored = storedAssessmentValue(workspace, student.enrollmentId, assessment.id);
                    const value = props.values[key] ?? (stored == null ? '' : String(stored));
                    const error = value.trim() ? validateAssessmentValue(value, assessment.maximumScore, mapping) : undefined;
                    return (
                      <View key={`${student.enrollmentId}-${assessment.id}`} {...({ dataSet: { gradebookCol: columnCssKey(column.id), gradebookHoverCell: 'true' } } as any)} {...columnHoverProps([column.id])} {...contextProps([{ label: 'Copy score', onSelect: () => void copyText(value) }, { label: 'Paste score', onSelect: async () => { const pasted = (await pasteText()).trim(); const pasteError = pasted ? validateAssessmentValue(pasted, assessment.maximumScore, mapping) : undefined; if (!pasted) return props.onToast('Clipboard has no score to paste.'); if (pasteError) return props.onToast(pasteError); props.onChange(key, pasted); }, }, { label: 'Clear score', destructive: true, onSelect: () => props.onChange(key, '') }])} style={[styles.fullAssessmentColumn, { width: column.width }, frozenPaneClip]}>
                        {mapping ? <SelectField compact label="" accessibilityLabel={`${student.name}, ${assessment.title} score`} value={value} error={error} options={[{ label: 'Unscored', value: '' }, ...mapping.map((option) => ({ label: `${option.value} · ${option.percentage}%`, value: option.value }))]} onChange={(next) => props.onChange(key, next)} containerStyle={styles.fullScoreField} /> : <Field compact label="" accessibilityLabel={`${student.name}, ${assessment.title} score`} value={value} error={error} placeholder={`0–${assessment.maximumScore}`} keyboardType="decimal-pad" onChangeText={(next) => props.onChange(key, next)} style={styles.fullNumericInput} containerStyle={[styles.fullNumericScoreField, { width: column.width - 8 }]} />}
                      </View>
                    );
                  })}
                </View>
              </View>;
            })}
            </ScrollView>
          </View>
        </ScrollView>
        {gridHasScrolled.x ? <View pointerEvents="none" style={[styles.fullGridVerticalShadow, { left: frozenStudentWidth - 1 }]} /> : null}
        {gridHasScrolled.y ? <View pointerEvents="none" style={[styles.fullGridHorizontalShadow, { top: hierarchyRows.length * 22 - 1 }]} /> : null}
        </View>
      )}
      {props.paginationEnabled && sortedStudents.length > 10 ? <View style={styles.pagination}><Button label="Previous" variant="secondary" disabled={props.page <= 1} onPress={() => props.onPageChange((current) => Math.max(1, current - 1))} /><Text style={styles.paginationText}>Page {props.page} of {localPageCount} · {sortedStudents.length} students</Text><Button label="Next" variant="secondary" disabled={props.page >= localPageCount} onPress={() => props.onPageChange((current) => Math.min(localPageCount, current + 1))} /></View> : null}
      <View style={styles.saveBar}>
        <View style={styles.flex}><Text style={styles.saveState}>{props.dirtyCount ? `${props.dirtyCount} unsaved change${props.dirtyCount === 1 ? '' : 's'}` : 'All scores saved'}</Text><Text style={styles.help}>{props.invalidCount ? `${props.invalidCount} score${props.invalidCount === 1 ? '' : 's'} need correction before saving.` : 'Scores remain provisional monitoring data until recorded in SWU SIS.'}</Text></View>
        <Button label="Save all scores" loading={props.saving} disabled={!props.dirtyCount || !!props.invalidCount} onPress={props.onSave} />
      </View>
      <GradebookContextMenu menu={contextMenu} onClose={() => setContextMenu(null)} onSelect={(action) => { setContextMenu(null); action.onSelect?.(); }} />
      <Modal transparent visible={viewOptionsOpen} animationType="fade" onRequestClose={() => setViewOptionsOpen(false)}>
        <View style={styles.viewOptionsOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setViewOptionsOpen(false)} />
          <ScrollView style={styles.viewOptionsPopover} contentContainerStyle={styles.viewOptionsPopoverContent} showsVerticalScrollIndicator keyboardShouldPersistTaps="handled">
            <View style={styles.viewOptionsHeading}>
              <Text style={styles.viewOptionsTitle}>View options</Text>
              <Pressable accessibilityLabel="Close view options" onPress={() => setViewOptionsOpen(false)}><Text style={styles.viewOptionsClose}>×</Text></Pressable>
            </View>
            <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: hideSingleChildComponentGrades }} onPress={() => setHideSingleChildComponentGrades((current) => !current)} style={styles.fullGradeToggle}>
              <View style={[styles.fullGradeToggleBox, hideSingleChildComponentGrades && styles.fullGradeToggleBoxSelected]}><Text style={styles.fullGradeToggleMark}>{hideSingleChildComponentGrades ? '✓' : ''}</Text></View>
              <Text style={styles.fullGradeToggleLabel}>Hide a component grade when it is the only subcomponent under its parent</Text>
            </Pressable>
            <Text style={styles.viewOptionsTitle}>Calculated cells</Text>
            <SelectField label="Display" value={calculatedCellDisplay} options={[{ label: 'Current grades', value: 'grade' }, { label: 'Direct contributions', value: 'contribution' }]} onChange={(value) => setCalculatedCellDisplay(value as 'grade' | 'contribution')} />
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
                filteredStudents.forEach((student) => props.onChange(`${student.enrollmentId}:${bulkScoreAssessment.id}`, bulkScoreValue.trim()));
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
    </>
  );
}

function componentLabel(component: SwunextAssessmentComponent, typeId?: string | null, gradingSystem?: any) {
  const configuredType = gradingSystem?.assessmentTypes?.find((item: any) => item.id === typeId);
  return configuredType?.name ?? swunextAssessmentComponents.find((item) => item.key === component)?.label ?? 'Assessment';
}

function assessmentGroupLabel(assessment: { gradingGroupId?: string | null; moduleNumber?: number | null }, groups: { id: string; name: string }[]) {
  const groupId = assessment.gradingGroupId ?? (assessment.moduleNumber == null ? '' : `m${assessment.moduleNumber}`);
  return groups.find((group) => group.id === groupId)?.name ?? 'No group';
}

function assessmentPeriodLabel(assessment: { gradingPeriodId?: string | null; gradingPeriod?: string | null }, periods: { id: string; name: string }[]) {
  return periods.find((period) => period.id === assessment.gradingPeriodId)?.name ?? assessment.gradingPeriod ?? '';
}

function assessmentComponentPath(system: any, typeId: string): { id: string; name: string }[] {
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

function gradingComponentPath(system: any, componentId: string) {
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

function groupHierarchyName(group: any, groups: any[]) {
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

function calculateFullViewGrades(workspace: ClassWorkspace, enrollmentId: string, gradingSystem: any, pendingValues: Record<string, string> = {}) {
  const assessments = workspace.assessments.map((assessment) => ({
    id: assessment.id,
    typeId: assessment.gradingTypeId ?? assessment.component,
    score: pendingValues[`${enrollmentId}:${assessment.id}`] ?? storedAssessmentValue(workspace, enrollmentId, assessment.id),
    maximumScore: assessment.maximumScore,
    weight: assessment.instanceWeight ?? undefined,
    periodId: assessment.gradingPeriodId,
    groupId: assessment.gradingGroupId ?? (assessment.moduleNumber == null ? undefined : `m${assessment.moduleNumber}`),
  }));
  return calculateGradingSystem(gradingSystem, assessments);
}

function gradePercent(value: number | null | undefined) {
  return value == null ? '—' : `${value.toFixed(1)}%`;
}

function fullAssessmentColumnWidth(assessment: FacultyAssessment, system: any, workspace: ClassWorkspace, values: Record<string, string>) {
  if (valueMappingForType(system, assessment.gradingTypeId ?? assessment.component)) return 108;
  const longest = workspace.students.reduce((length, student) => {
    const key = `${student.enrollmentId}:${assessment.id}`;
    const value = values[key] ?? storedAssessmentValue(workspace, student.enrollmentId, assessment.id);
    return Math.max(length, value == null ? 0 : String(value).trim().length);
  }, 3);
  return Math.max(42, longest * 9 + 6);
}

function fullViewColumns(assessments: FacultyAssessment[], system: any, columnWidth: (assessment: FacultyAssessment) => number, hideSingleChildComponentGrades: boolean): FullViewColumn[] {
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
    if (node.kind === 'component' && node.componentId && !isOverallRootRepeatedForPeriod && !(hideSingleChildComponentGrades && isOnlySubcomponent)) addComputed(node, 'component', `component:${node.key}:${node.periodId ?? ''}:${node.groupId ?? ''}`, 'Grade', 62, { targetId: node.componentId, nonPeriodScope: !node.periodId && !node.groupId });
    if (node.kind === 'group' && node.groupId) addComputed(node, 'group', `group:${node.groupId}:${node.periodId ?? ''}`, 'Group grade', 62, { targetId: node.groupId });
    if (node.kind === 'group' && !node.groupId && node.periodId === undefined) addComputed(node, 'non_period', 'non-period', 'Non-period grade', 66, { nonPeriodScope: true });
    if (node.kind === 'period' && node.periodId) addComputed(node, 'period', `period:${node.periodId}`, 'Period grade', 62, { targetId: node.periodId });
  };
  for (const root of roots) visit(root);
  columns.push({ id: 'final', kind: 'final', width: 72, period: { key: 'final-grade', label: 'Final grade' }, group: { key: 'final-grade', label: '' }, componentPath: [], leafLabel: 'Percentage grade' });
  columns.push({ id: 'final-equivalent', kind: 'final_equivalent', width: 82, period: { key: 'final-grade', label: 'Final grade' }, group: { key: 'final-grade', label: '' }, componentPath: [], leafLabel: 'Point / letter grade' });
  return columns;
}

function fullAssessmentHeaderRows(columns: FullViewColumn[]) {
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

function fullViewColumnValue(column: FullViewColumn, enrollmentId: string, result: ReturnType<typeof calculateFullViewGrades>, workspace: ClassWorkspace, pendingValues: Record<string, string>) {
  if (column.kind === 'assessment' && column.assessment) return pendingValues[`${enrollmentId}:${column.assessment.id}`] ?? storedAssessmentValue(workspace, enrollmentId, column.assessment.id) ?? '';
  if (column.kind === 'component') return column.groupId ? result.groupComponents[column.groupId]?.[column.targetId!] ?? null : column.periodId ? result.periodComponents[column.periodId]?.[column.targetId!] ?? null : column.nonPeriodScope ? result.nonPeriodComponents[column.targetId!] ?? null : result.components[column.targetId!] ?? null;
  if (column.kind === 'group') return result.groups[column.targetId!] ?? null;
  if (column.kind === 'period') return result.periods[column.targetId!] ?? null;
  if (column.kind === 'non_period') return result.nonPeriod;
  if (column.kind === 'final_equivalent') return `${result.pointGrade == null ? '—' : result.pointGrade.toFixed(2)}${result.letterGrade ? ` / ${result.letterGrade}` : ''}`;
  return result.finalGrade;
}

function displayedFullViewColumnValue(column: FullViewColumn, enrollmentId: string, result: ReturnType<typeof calculateFullViewGrades>, workspace: ClassWorkspace, pendingValues: Record<string, string>, system: any, display: 'grade' | 'contribution') {
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

function GradebookContextMenu({ menu, onClose, onSelect }: { menu: GradebookContextMenuState; onClose: () => void; onSelect: (action: GradebookContextAction) => void }) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [activeSubmenu, setActiveSubmenu] = useState<string | null>(null);
  useEffect(() => { setActiveSubmenu(null); setHoveredIndex(null); }, [menu?.x, menu?.y]);
  const activeGroup = menu?.actions.find((action) => action.label === activeSubmenu && action.children);
  const actions = activeGroup?.children ?? menu?.actions ?? [];
  const viewportWidth = typeof window === 'undefined' ? 1024 : window.innerWidth;
  const viewportHeight = typeof window === 'undefined' ? 768 : window.innerHeight;
  const menuWidth = 232;
  const menuHeight = Math.min(360, Math.max(42, actions.length * 30 + 12 + (activeGroup ? 28 : 0)));
  const left = menu ? Math.max(4, Math.min(menu.x, viewportWidth - menuWidth - 4)) : 0;
  const top = menu ? Math.max(4, Math.min(menu.y, viewportHeight - menuHeight - 4)) : 0;
  return <Modal transparent visible={!!menu} animationType="fade" onRequestClose={onClose}>
    <View {...({ onContextMenuCapture: (event: any) => event.preventDefault?.() } as any)} style={styles.gradebookContextOverlay}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      {menu ? <View style={[styles.gradebookContextMenu, { left, top, width: menuWidth, maxHeight: Math.max(42, viewportHeight - top - 4) }]}>
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

function assessmentOptionLabel(assessment: FacultyAssessment, system: any) {
  const typeName = componentLabel(assessment.component, assessment.gradingTypeId, system);
  const group = assessmentGroupLabel(assessment, system.groups ?? []);
  const period = assessmentPeriodLabel(assessment, system.periods ?? []);
  return [assessment.title, typeName, group, period || null, `${assessment.maximumScore} max`].filter(Boolean).join(' · ');
}

function assessmentHelp(component: SwunextAssessmentComponent) {
  if (component === 'start_of_class') return 'Start of Class uses binary encoding: present = 1, absent = 0.';
  if (component === 'lets_practice' || component === 'reflection') return "Use the 0-3 rubric: 0 = 0%, 1 = 60%, 2 = 80%, 3 = 100%.";
  if (component === 'project_checkin') return 'Project check-ins are percentage scores. APMS averages up to four check-ins before applying the project weight.';
  if (component === 'final_project') return 'Final project/output is entered as a percentage or raw score and contributes to mastery.';
  return 'Wrap-up quizzes and other mastery items use the raw percentage from score divided by maximum score.';
}

function validateNumericInput(value: string, label: string, minimum: number, maximum?: number) {
  if (!value.trim()) return `${label} is required.`;
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) return `Enter a valid ${label.toLowerCase()}.`;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return `Enter a valid ${label.toLowerCase()}.`;
  if (parsed < minimum) return `${label} must be at least ${minimum}.`;
  if (maximum != null && parsed > maximum) return `${label} must be no more than ${maximum}.`;
  return undefined;
}

function validateAssessmentDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'Enter a date in YYYY-MM-DD format.';
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? undefined
    : 'Enter a real calendar date.';
}

function validateScore(value: string, maximum: number) {
  if (!value.trim()) return undefined;
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) return 'Enter a valid non-negative score.';
  const score = Number(value);
  if (!Number.isFinite(score)) return 'Enter a valid score.';
  if (score > maximum) return `Score must be no more than ${maximum}.`;
  return undefined;
}

function validateAssessmentValue(value: string, maximum: number, categoryMapping?: { value: string; percentage: number }[]) {
  if (!categoryMapping) return validateScore(value, maximum);
  if (!value.trim()) return undefined;
  return categoryMapping.some((item) => item.value === value) ? undefined : 'Choose a category from the assessment type.';
}

function AssessmentDialog({ visible, title, form, saving, onChange, onClose, onSubmit, submitLabel, gradingSystem, gradingTypes, periods, groups }: { visible: boolean; title: string; form: AssessmentFormState; saving: boolean; onChange: (value: AssessmentFormState) => void; onClose: () => void; onSubmit: () => void | Promise<void>; submitLabel: string; gradingSystem: any; gradingTypes: { id: string; name: string }[]; periods: { id: string; name: string }[]; groups: { id: string; name: string }[] }) {
  const selectedComponent = swunextAssessmentComponents.find((item) => item.key === form.component);
  const titleError = form.title.trim() ? undefined : 'Assessment title is required.';
  const typeError = gradingTypes.length && !gradingTypes.some((item) => item.id === form.gradingTypeId) ? 'Choose an assessment type from the active grading system.' : undefined;
  const categoryMapping = valueMappingForType(gradingSystem, form.gradingTypeId);
  const typeScope = assessmentTypeScope(gradingSystem, form.gradingTypeId);
  const maximumScoreError = categoryMapping ? undefined : validateNumericInput(form.maximumScore, 'Maximum score', 0) ?? (Number(form.maximumScore) === 0 ? 'Maximum score must be greater than 0.' : undefined);
  const maximumCategory = highestCategory(categoryMapping);
  const aggregationMode = assessmentAggregationMode(gradingSystem, form.gradingTypeId);
  const weightReadOnly = aggregationMode === 'equal' || aggregationMode === 'points';
  const weightError = form.instanceWeight.trim() ? validateNumericInput(form.instanceWeight, 'Assessment weight', 0) ?? (Number(form.instanceWeight) === 0 ? 'Assessment weight must be greater than 0.' : undefined) : undefined;
  const dateError = validateAssessmentDate(form.date);
  const periodError = typeScope.requiresPeriod && !form.gradingPeriodId ? 'Choose a period required by this assessment type.' : form.gradingPeriodId && !periods.some((item) => item.id === form.gradingPeriodId) ? 'Choose a period from the active grading system.' : undefined;
  const groupError = typeScope.requiresGroup && !form.gradingGroupId ? 'Choose a group required by this assessment type.' : form.gradingGroupId && !groups.some((item) => item.id === form.gradingGroupId) ? 'Choose a group from the active grading system or select No group.' : undefined;
  const formErrors = [titleError, typeError, maximumScoreError, weightError, dateError, periodError, groupError];
  const valid = formErrors.every((error) => !error);
  const maximumScoreLocked = hasExplicitAssessmentMaximum(gradingSystem, form.gradingTypeId);
  const selectedTypeName = gradingTypes.find((item) => item.id === form.gradingTypeId)?.name;
  const selectedAssessmentLabel = form.component === 'other' ? selectedTypeName ?? 'Assessment' : selectedComponent?.label ?? selectedTypeName ?? 'Assessment';
  const updateType = (id: string) => { const component = swunextAssessmentComponents.some((item) => item.key === id) ? id as SwunextAssessmentComponent : 'other'; const scope = assessmentTypeScope(gradingSystem, id); const period = periods.find((item) => item.id === form.gradingPeriodId) ?? periods[0]; onChange({ ...form, ...assessmentTypeDefaults(gradingSystem, id), gradingTypeId: id, component, gradingGroupId: '', moduleNumber: '', gradingPeriodId: scope.overall ? '' : period?.id ?? '', gradingPeriod: scope.overall ? '' : period?.name ?? '' }); };
  return <Dialog visible={visible} title={title} onClose={onClose}>
    <Field label="Title" value={form.title} error={titleError} onChangeText={(value) => onChange({ ...form, title: value })} />
    <View style={styles.formGrid}>
      <SelectField label="Assessment type" value={form.gradingTypeId} options={gradingTypes.map((item) => ({ label: item.name, value: item.id }))} error={typeError} onChange={updateType} containerStyle={styles.statusField} />
      {categoryMapping ? <SelectField label="Maximum score category" value={maximumCategory} options={categoryMapping.map((item) => ({ label: `${item.value} · ${item.percentage}%`, value: item.value }))} onChange={() => {}} disabled helpText="The category with the highest mapped percentage is the maximum score." /> : <Field label="Maximum score" value={form.maximumScore} error={maximumScoreError} editable={!maximumScoreLocked} style={maximumScoreLocked ? { backgroundColor: '#F1F3F5', color: colors.textMuted } : undefined} helpText={maximumScoreLocked ? 'This maximum score is set by the active grading system.' : 'No positive maximum score is fixed by the active grading system, so you can enter one.'} keyboardType="decimal-pad" onChangeText={(value) => onChange({ ...form, maximumScore: value })} />}
      <Field label="Assessment weight (if required by system)" value={weightReadOnly ? '1' : form.instanceWeight} error={weightReadOnly ? undefined : weightError} editable={!weightReadOnly} style={weightReadOnly ? { backgroundColor: '#F1F3F5', color: colors.textMuted } : undefined} helpText={weightReadOnly ? `${aggregationMode === 'equal' ? 'Equal' : 'Points'} aggregation does not use per-assessment weights; 1 is shown as the neutral value.` : 'This aggregation mode uses each assessment’s instance weight.'} keyboardType="decimal-pad" onChangeText={(value) => onChange({ ...form, instanceWeight: value })} />
      {groups.length || form.gradingGroupId || typeScope.requiresGroup ? <SelectField label={typeScope.requiresGroup ? 'Group' : 'Group (optional)'} value={form.gradingGroupId} error={groupError} options={[{ label: typeScope.requiresGroup ? 'Choose a group' : 'No group', value: '' }, ...groups.map((item) => ({ label: item.name, value: item.id }))]} onChange={(value) => onChange({ ...form, gradingGroupId: value, moduleNumber: value.match(/^m(\d+)$/)?.[1] ?? '' })} containerStyle={styles.statusField} /> : null}
      <Field label="Assessment date" value={form.date} error={dateError} onChangeText={(value) => onChange({ ...form, date: value })} placeholder="YYYY-MM-DD" />
      {periods.length ? <SelectField label={typeScope.requiresPeriod ? 'Period' : 'Period (optional)'} value={form.gradingPeriodId} error={periodError} disabled={typeScope.overall} options={[{ label: 'No period', value: '' }, ...periods.map((value) => ({ label: value.name, value: value.id }))]} onChange={(value) => { const selectedPeriod = periods.find((period) => period.id === value); onChange({ ...form, gradingPeriodId: value, gradingPeriod: selectedPeriod?.name ?? '' }); }} containerStyle={styles.statusField} /> : null}
    </View>
    <Text style={styles.help}>{selectedAssessmentLabel}: {form.component === 'other' ? 'Scoring follows the rules configured for this assessment type.' : assessmentHelp(form.component)}</Text>
    <SelectField label="Source" value={form.source} options={[{ label: 'Manual', value: 'manual' }, { label: 'CSV', value: 'csv' }]} onChange={(value) => onChange({ ...form, source: value as 'manual' | 'csv' })} />
    <Button label={submitLabel} loading={saving} disabled={!valid || !gradingTypes.length} onPress={() => void onSubmit()} />
  </Dialog>;
}

function Attendance(props: StateProps) {
  const { user } = useAuth(); const [sessionId, setSessionId] = useState(props.workspace.attendanceSessions[0]?.id ?? ''); const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc'); const [statuses, setStatuses] = useState<Record<string, 'present' | 'absent' | 'late' | 'excused'>>({}); const [open, setOpen] = useState(false); const [date, setDate] = useState(new Date().toISOString().slice(0, 10)); const [label, setLabel] = useState('Class session'); const [saving, setSaving] = useState(false); const [page, setPage] = useState(1);
  useEffect(() => { if (!props.workspace.attendanceSessions.some((item) => item.id === sessionId)) setSessionId(props.workspace.attendanceSessions[0]?.id ?? ''); }, [props.workspace.attendanceSessions, sessionId]);
  const sortedStudents = useMemo(() => {
    const direction = sortOrder === 'asc' ? 1 : -1;
    const lastName = (student: RosterStudent) => {
      const parts = student.name.trim().split(/\s+/);
      return (parts[parts.length - 1] ?? '').toLowerCase();
    };
    return [...props.workspace.students].sort((left, right) => {
      const lastNameCompare = lastName(left).localeCompare(lastName(right));
      if (lastNameCompare !== 0) return lastNameCompare * direction;
      return left.name.localeCompare(right.name) * direction;
    });
  }, [props.workspace.students, sortOrder]);
  const pageSize = 10;
  const pageCount = Math.max(1, Math.ceil(sortedStudents.length / pageSize));
  const pageStudents = sortedStudents.slice((page - 1) * pageSize, page * pageSize);
  useEffect(() => { setPage(1); }, [sessionId, sortOrder, props.selectedClassId, props.workspace.students.length]);
  const markAll = (status: 'present' | 'absent') => setStatuses((current) => ({ ...current, ...Object.fromEntries(sortedStudents.map((student) => [student.enrollmentId, status])) }));
  const create = async () => { if (!user || !props.selectedClassId) return; setSaving(true); try { const id = await createAttendanceSession(props.selectedClassId, user.id, date, label); setSessionId(id); setOpen(false); props.toast.show('Attendance session created.'); props.refresh(); } catch (cause) { props.toast.show(cause instanceof Error ? cause.message : 'Session creation failed.'); } finally { setSaving(false); } };
  const save = async () => { if (!user || !sessionId) return; const rows = sortedStudents.map((student) => ({ enrollmentId: student.enrollmentId, status: statuses[student.enrollmentId] ?? props.workspace.attendance[`${sessionId}:${student.enrollmentId}`] ?? 'present' as const })); setSaving(true); try { await saveAttendance(user.id, sessionId, rows); props.toast.show('Attendance saved to Supabase.'); props.refresh(); } catch (cause) { props.toast.show(cause instanceof Error ? cause.message : 'Attendance could not be saved.'); } finally { setSaving(false); } };
  return <>
    <Heading title="Attendance" subtitle="Create a dated session, batch mark the roster, and save authorized attendance records." action={<Button label="Create session" onPress={() => setOpen(true)} />} /><ClassSelect {...props} /><View style={styles.filterRow}><SelectField label="Attendance session" value={sessionId} options={props.workspace.attendanceSessions.map((item) => ({ label: `${item.date} · ${item.label}`, value: item.id }))} onChange={(value) => { setSessionId(value); setStatuses({}); }} containerStyle={styles.classSelect} /><SelectField label="Sort by last name" value={sortOrder} options={[{ label: 'A to Z', value: 'asc' }, { label: 'Z to A', value: 'desc' }]} onChange={(value) => setSortOrder(value as 'asc' | 'desc')} containerStyle={styles.sortField} /></View>
    <Card>{sessionId ? <><View style={styles.attendanceToolbar}><View style={styles.flex}><Text style={styles.cardTitle}>Mark attendance</Text><Text style={styles.help}>Everyone defaults to Present. Mark exceptions, then save once.</Text></View><View style={styles.actions}><Button label="All present" variant="secondary" onPress={() => markAll('present')} /><Button label="All absent" variant="danger" onPress={() => markAll('absent')} /></View></View>{pageStudents.map((student) => <View key={student.enrollmentId} style={styles.attendanceRow}><View style={styles.flex}><Text style={styles.rowTitle}>{student.name}</Text><Text style={styles.help}>{student.institutionalId}</Text></View><SelectField label="Status" value={statuses[student.enrollmentId] ?? props.workspace.attendance[`${sessionId}:${student.enrollmentId}`] ?? 'present'} options={['present', 'absent', 'late', 'excused'].map((value) => ({ label: value[0].toUpperCase() + value.slice(1), value }))} onChange={(value) => setStatuses((current) => ({ ...current, [student.enrollmentId]: value as typeof statuses[string] }))} containerStyle={styles.attendanceStatusField} /></View>)}{sortedStudents.length > pageSize ? <View style={styles.pagination}><Button label="Previous" variant="secondary" disabled={page <= 1} onPress={() => setPage((current) => Math.max(1, current - 1))} /><Text style={styles.paginationText}>Page {page} of {pageCount} · {sortedStudents.length} students</Text><Button label="Next" variant="secondary" disabled={page >= pageCount} onPress={() => setPage((current) => Math.min(pageCount, current + 1))} /></View> : null}<Button label="Save attendance" loading={saving} onPress={() => void save()} /></> : <PageState kind="empty" title="No attendance session" message="Create a session to begin roll call." />}</Card>
    <Dialog visible={open} title="Create attendance session" onClose={() => setOpen(false)}><Field label="Date" value={date} onChangeText={setDate} placeholder="YYYY-MM-DD" /><Field label="Session label" value={label} onChangeText={setLabel} /><Button label="Create session" loading={saving} onPress={() => void create()} /></Dialog>
  </>;
}

function Criteria(props: StateProps) {
  const [section, setSection] = useState<'grading' | 'evaluation'>('grading');
  return <View style={{ gap: 12 }}>
    <View style={styles.bulkClassActions}>
      <Button label="Grading criteria" variant={section === 'grading' ? 'primary' : 'secondary'} onPress={() => setSection('grading')} />
      <Button label="My evaluation criteria" variant={section === 'evaluation' ? 'primary' : 'secondary'} onPress={() => setSection('evaluation')} />
    </View>
    {section === 'grading' ? <GradingCriteria {...props} /> : <FacultyEvaluationCriteria {...props} />}
  </View>;
}

function FacultyEvaluationCriteria(props: StateProps) {
  const [definition, setDefinition] = useState<EvaluationDefinition>(props.workspace.evaluationSystem ?? DEFAULT_EVALUATION_SYSTEM);
  const [selectedClasses, setSelectedClasses] = useState<string[]>(props.selectedClassId ? [props.selectedClassId] : []);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [showBuilder, setShowBuilder] = useState(false);
  const [pendingDeleteClassId, setPendingDeleteClassId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [departmentSystems, setDepartmentSystems] = useState<{ id: string; name: string; version: number; definition: EvaluationDefinition; updatedAt: string | null; updatedBy: string | null }[]>([]);
  const [criteriaByClass, setCriteriaByClass] = useState<Map<string, { name: string; version: number | null; source: 'private' | 'department'; definition?: EvaluationDefinition }>>(new Map());
  useEffect(() => {
    setDefinition(props.workspace.evaluationSystem ?? DEFAULT_EVALUATION_SYSTEM);
    setSelectedClasses((current) => current.length ? current : props.selectedClassId ? [props.selectedClassId] : []);
    setErrors([]);
  }, [props.selectedClassId, props.workspace.evaluationSystem]);
  useEffect(() => {
    let current = true;
    loadFacultyEvaluationCriteriaLibrary(props.classes.map((item) => item.id), props.userId)
      .then((result) => {
        if (!current) return;
        setDepartmentSystems(result.departmentSystems);
        setCriteriaByClass(new Map(result.byClass.map((item) => [item.classId, { name: item.name, version: item.version, source: item.source, definition: item.definition }])));
      })
      .catch((cause) => current && props.toast.show(cause instanceof Error ? cause.message : 'Could not load saved evaluation criteria.'));
    return () => { current = false; };
  }, [props.classes, props.userId, props.workspace.evaluationSystem, props.refresh]);
  const toggleClass = (classId: string) => setSelectedClasses((current) => current.includes(classId) ? current.filter((id) => id !== classId) : [...current, classId]);
  const apply = async () => {
    const validation = validateEvaluationSystem(definition);
    setErrors(validation.errors);
    if (!validation.valid) return;
    if (!props.userId || !selectedClasses.length) return;
    setSaving(true);
    try {
      const versioned = { ...definition, schemaVersion: 2, definitionVersion: (definition.definitionVersion ?? 0) + 1 };
      const result = await applyFacultyEvaluationSystemToClasses(selectedClasses, props.userId, versioned);
      if (result.failures.length) {
        const messages = result.failures.map((failure) => `${props.classes.find((item) => item.id === failure.classId)?.code ?? failure.classId}: ${failure.message}`);
        setErrors(messages);
        props.toast.show(`Applied to ${result.applied.length} of ${selectedClasses.length} classes. ${messages[0]}`);
      } else {
        setDefinition(versioned);
        setErrors([]);
        setShowBuilder(false);
        props.toast.show(`Your private evaluation criteria were applied to ${result.applied.length} of your classes.`);
      }
      props.refresh();
    } catch (cause) {
      props.toast.show(cause instanceof Error ? cause.message : 'Could not apply your evaluation criteria.');
    } finally { setSaving(false); }
  };

  const currentGrading = props.workspace.criteria?.gradingSystemDefinition ?? props.workspace.defaultGradingSystem ?? IT_GLOBAL_GRADING_SYSTEM;
  const freshId = () => globalThis.crypto?.randomUUID?.() ?? 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => { const value = Math.floor(Math.random() * 16); return (char === 'x' ? value : (value & 3) | 8).toString(16); });
  const createNew = () => {
    setDefinition({ ...(props.workspace.evaluationSystem ?? DEFAULT_EVALUATION_SYSTEM), id: freshId(), name: 'New evaluation criteria', definitionVersion: 1 });
    setSelectedClasses(props.selectedClassId ? [props.selectedClassId] : []);
    setErrors([]);
    setShowBuilder(true);
  };
  const makeCopy = (source: EvaluationDefinition) => {
    setDefinition({ ...JSON.parse(JSON.stringify(source)), id: freshId(), name: `Copy of ${source.name}`, definitionVersion: 1 });
    setSelectedClasses(props.selectedClassId ? [props.selectedClassId] : []);
    setErrors([]);
    setShowBuilder(true);
  };
  const editPrivate = (existing: EvaluationDefinition, classId: string) => { setDefinition(existing); setSelectedClasses([classId]); setErrors([]); setShowBuilder(true); };
  const deletePrivate = async () => {
    if (!pendingDeleteClassId || !props.userId) return;
    setDeleting(true);
    try {
      await deleteFacultyClassEvaluationSystem(pendingDeleteClassId, props.userId);
      props.toast.show('Your private evaluation criteria were removed from this class.');
      setPendingDeleteClassId(null);
      props.refresh();
    } catch (cause) {
      props.toast.show(cause instanceof Error ? cause.message : 'Could not delete private evaluation criteria.');
    } finally { setDeleting(false); }
  };
  const tableRows = props.classes.map((item) => {
    const assignment = criteriaByClass.get(item.id);
    const isSelected = item.id === props.selectedClassId;
    const name = assignment?.name ?? (isSelected ? props.workspace.evaluationSystem?.name : null) ?? 'Department default';
    const version = assignment?.version ?? (isSelected ? props.workspace.evaluationSystem?.definitionVersion : null);
    const source = assignment?.source ?? (isSelected && props.workspace.hasPrivateEvaluationSystem ? 'private' : 'department');
    return [
      `${item.code} · ${item.section}`,
      item.title,
      item.term || '—',
      `${name}${version ? ` · v${version}` : ''}`,
      source === 'private' ? 'Your private criteria' : 'Department criteria',
    ];
  });
  return <>
    {!showBuilder ? <>
      <Heading title="My Evaluation Criteria" subtitle="Review saved evaluation criteria and the criteria currently used by your classes." action={<Button label="Create evaluation criteria" onPress={createNew} />} />
      <ClassSelect {...props} />
      <Card style={{ gap: 14 }}>
        <View style={styles.savedSystemHeader}><View style={{ flex: 1 }}><Text style={styles.cardTitle}>Saved evaluation criteria</Text><Text style={styles.help}>Department criteria are read-only. Make a private copy to customize criteria for classes assigned to you.</Text></View></View>
        {departmentSystems.map((system) => <View key={system.id} style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderColor: colors.border }}>
          <View style={{ flex: 1, minWidth: 180 }}><Text style={styles.bulkClassName}>{system.name}</Text><Text style={styles.help}>Department criteria · v{system.version}{system.updatedAt ? ` · Updated ${new Date(system.updatedAt).toLocaleDateString()}` : ''}</Text></View>
          <Button label="Make a copy" variant="secondary" onPress={() => makeCopy(system.definition)} />
        </View>)}
        {[...criteriaByClass.entries()].filter(([, item]) => item.source === 'private' && item.definition).map(([classId, item]) => {
          const classInfo = props.classes.find((classItem) => classItem.id === classId);
          return <View key={`private-${classId}`} style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderColor: colors.border }}>
            <View style={{ flex: 1, minWidth: 180 }}><Text style={styles.bulkClassName}>{item.name}</Text><Text style={styles.help}>Your private criteria · {classInfo ? `${classInfo.code} · ${classInfo.section}` : 'Assigned class'}{item.version ? ` · v${item.version}` : ''}</Text></View>
            <View style={styles.bulkClassActions}><Button label="Edit" variant="secondary" onPress={() => editPrivate(item.definition!, classId)} /><Button label="Delete" variant="danger" onPress={() => setPendingDeleteClassId(classId)} /></View>
          </View>;
        })}
        {!departmentSystems.length && !props.workspace.hasPrivateEvaluationSystem && props.workspace.evaluationSystem ? <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 12, paddingVertical: 12 }}>
          <View style={{ flex: 1, minWidth: 180 }}><Text style={styles.bulkClassName}>{props.workspace.evaluationSystem.name}</Text><Text style={styles.help}>Current department criteria · Read-only</Text></View>
          <Button label="Make a copy" variant="secondary" onPress={() => makeCopy(props.workspace.evaluationSystem!)} />
        </View> : null}
        {!departmentSystems.length && ![...criteriaByClass.values()].some((item) => item.source === 'private') && !props.workspace.evaluationSystem ? <Text style={styles.help}>No saved evaluation criteria are available yet.</Text> : null}
      </Card>
      <Card style={{ gap: 12 }}>
        <Text style={styles.cardTitle}>Evaluation criteria by class</Text>
        <Text style={styles.help}>Private criteria affect only your evaluations. Department criteria remain unchanged.</Text>
        {tableRows.length ? <DataTable columns={['Class', 'Subject', 'Term', 'Evaluation criteria · Version', 'Scope']} rows={tableRows} /> : <PageState kind="empty" title="No classes available" message="Assigned classes will appear here." />}
      </Card>
    </> : <>
      <Heading title="Evaluation criteria builder" subtitle="Create or edit private criteria for classes assigned to you." action={<Button label="Back to saved criteria" variant="ghost" onPress={() => setShowBuilder(false)} />} />
      <ClassSelect {...props} />
      <Card style={{ gap: 14 }}>
        <Text style={styles.help}>Saving applies this private definition only to the selected classes. Department criteria are never changed.</Text>
        <EvaluationSystemBuilderForm definition={definition} onChange={(next) => { setDefinition(next); setErrors([]); }} gradingSystem={currentGrading} />
        <View style={styles.criteriaSection}>
          <View style={styles.savedSystemHeader}>
            <View style={{ flex: 1 }}><Text style={styles.criteriaRuleTitle}>Apply to your classes</Text><Text style={styles.help}>Only active classes assigned to your Faculty account can be selected.</Text></View>
            <View style={styles.bulkClassActions}><Button label="Select all" variant="secondary" onPress={() => setSelectedClasses(props.classes.map((item) => item.id))} /><Button label="Clear" variant="ghost" onPress={() => setSelectedClasses([])} /></View>
          </View>
          {props.classes.map((item) => <Pressable key={item.id} accessibilityRole="checkbox" accessibilityState={{ checked: selectedClasses.includes(item.id) }} onPress={() => toggleClass(item.id)} style={styles.bulkClassRow}>
            <Text style={styles.bulkClassCheck}>{selectedClasses.includes(item.id) ? '☑' : '☐'}</Text><View style={{ flex: 1 }}><Text style={styles.bulkClassName}>{item.code} · {item.section}</Text><Text style={styles.help}>{item.title} · {item.term || 'Term not set'}</Text></View>
          </Pressable>)}
        </View>
        {errors.map((message, index) => <Text key={`faculty-evaluation-error-${index}`} style={{ color: colors.danger }}>{message}</Text>)}
        <Button label={`Save and apply to ${selectedClasses.length} selected classes`} loading={saving} disabled={!selectedClasses.length} onPress={() => void apply()} />
      </Card>
    </>}
    <ConfirmDialog
      visible={pendingDeleteClassId != null}
      title="Delete your private evaluation criteria?"
      message={`This removes ${pendingDeleteClassId ? criteriaByClass.get(pendingDeleteClassId)?.name ?? 'these criteria' : 'these criteria'} from ${pendingDeleteClassId ? props.classes.find((item) => item.id === pendingDeleteClassId)?.code ?? 'this class' : 'this class'} in your Faculty account. Other classes and department criteria are not affected.`}
      confirmLabel="Delete criteria"
      danger
      pending={deleting}
      onClose={() => { if (!deleting) setPendingDeleteClassId(null); }}
      onConfirm={() => void deletePrivate()}
    />
  </>;
}

function GradingCriteria(props: StateProps) {
  const system = props.workspace.criteria?.gradingSystemDefinition ?? props.workspace.defaultGradingSystem ?? IT_GLOBAL_GRADING_SYSTEM;
  const assessmentTypes = new Map((system.assessmentTypes ?? []).map((item: any) => [item.id, item]));
  const components = [...(system.components ?? [])].sort((a: any, b: any) => (a.sequence ?? 0) - (b.sequence ?? 0));
  const componentById = new Map(components.map((component: any) => [component.id, component]));
  const weightValue = (weight: any) => typeof weight === 'number' ? weight : weight?.numerator != null && weight?.denominator ? weight.numerator / weight.denominator : null;
  const weightText = (weight: any) => {
    const value = weightValue(weight);
    return value == null ? '' : `${Number((value * 100).toFixed(2))}%`;
  };
  const hierarchyRows: { id: string; component: any; depth: number; detail: string; localShare: number | null; directShare: number | null; parentName: string | null }[] = [];
  const visitedComponents = new Set<string>();
  const collectComponent = (componentId: string, depth: number, directShare: number, localShare: number | null, parentName: string | null, ancestors = new Set<string>()) => {
    const component = componentById.get(componentId) as any;
    if (!component || visitedComponents.has(componentId) || ancestors.has(componentId)) return;
    visitedComponents.add(componentId);
    const calculation = component.calculation;
    const refs = calculation?.mode === 'weighted' ? (calculation.components ?? []) : [];
    const type = assessmentTypes.get(component.assessmentDefinition?.typeId) as any;
    const detail = component.assessmentDefinition ? `${type?.name ?? 'Assessment'}${component.description ? ` · ${component.description}` : type?.description ? ` · ${type.description}` : ''}`
      : refs.length ? (calculation.rules?.length ? 'Base contribution; conditional calculation rules may adjust the share.' : '')
      : component.description ?? 'Configured calculation';
    hierarchyRows.push({ id: component.id, component, depth, detail, localShare, directShare: depth ? directShare : null, parentName });
    const weightMode = calculation?.weightMode ?? 'relative';
    const rawWeights = refs.map((ref: any) => weightValue(ref.weight) ?? 0);
    const denominator = weightMode === 'absolute' ? 1 : rawWeights.reduce((sum: number, value: number) => sum + value, 0);
    const nextAncestors = new Set(ancestors).add(componentId);
    refs.forEach((ref: any, index: number) => {
      const childShare = denominator > 0 ? (rawWeights[index] / denominator) : 0;
      collectComponent(ref.componentId, depth + 1, directShare * childShare, childShare, component.shortCode ?? component.name, nextAncestors);
    });
  };
  if (system.calculationRootComponentId) collectComponent(system.calculationRootComponentId, 0, 1, null, null);
  const remainingComponents = components.filter((component: any) => !visitedComponents.has(component.id));
  for (const component of remainingComponents) collectComponent(component.id, 0, 1, null, null);
  const periods = [...(system.periods ?? [])].sort((a: any, b: any) => a.sequence - b.sequence);
  const groupById = new Map((system.groups ?? []).map((group: any) => [group.id, group]));
  const periodRows = periods.map((period: any) => {
    const groups = (period.groupIds ?? []).map((id: string) => groupById.get(id) as any).filter(Boolean).sort((a: any, b: any) => a.sequence - b.sequence);
    const groupSummary = groups.length ? `${groups[0].name}${groups.length > 1 ? `–${groups[groups.length - 1].name.replace(/^\D+/, '')}` : ''}` : 'No groups assigned';
    return [period.name, groupSummary];
  });
  const passingThreshold = system.finalGradeConversion?.passingPercentage ?? props.workspace.criteria?.passingThreshold ?? 80;
  const conversion = system.finalGradeConversion ?? {};
  const roundPoint = (value: number) => {
    const precision = conversion.rounding?.precision ?? 2;
    const factor = 10 ** precision;
    const rounded = conversion.rounding?.mode === 'floor' ? Math.floor(value * factor) / factor : conversion.rounding?.mode === 'ceiling' ? Math.ceil(value * factor) / factor : Math.round(value * factor) / factor;
    return rounded.toFixed(precision);
  };
  const formatPct = (value: number) => `${value.toFixed(2)}%`;
  const conversionRows = (scale: any, passing: boolean) => {
    if (!scale) return [];
    if (scale.mode === 'mapping') {
      const sorted = [...(scale.mapping ?? [])].sort((a: any, b: any) => b.minimumPercentage - a.minimumPercentage);
      return sorted.map((entry: any, index: number) => {
        const upper = sorted[index - 1]?.minimumPercentage ?? (passing ? scale.maximumPercentage ?? 100 : passingThreshold);
        const range = passing && index === 0 ? `${formatPct(entry.minimumPercentage)}–${formatPct(upper)}` : `${formatPct(entry.minimumPercentage)}–<${formatPct(upper)}`;
        return [roundPoint(Number(entry.point)), range, entry.letter ?? '—'];
      });
    }
    const lowPoint = passing ? scale.bestPoint : scale.firstFailingPoint;
    const highPoint = passing ? scale.passingPoint : scale.worstPoint;
    const interval = Math.max(Number(scale.pointInterval) || 1, Number.EPSILON);
    const steps = Math.max(1, Math.ceil(Math.abs(highPoint - lowPoint) / interval));
    const count = steps + 1;
    const pctLow = passing ? passingThreshold : scale.minimumPercentage;
    const pctHigh = passing ? scale.maximumPercentage : passingThreshold;
    return Array.from({ length: count }, (_, index) => {
      const point = lowPoint + (highPoint - lowPoint) * index / steps;
      const start = pctHigh - (pctHigh - pctLow) * (index + 1) / count;
      const end = pctHigh - (pctHigh - pctLow) * index / count;
      return [roundPoint(point), `${formatPct(start)}–${index === 0 && passing ? '' : '<'}${formatPct(end)}`, '—'];
    });
  };
  const passingRows = conversionRows(conversion.passingScale, true);
  const failingRows = conversionRows(conversion.failingScale, false);
  const hasLetterConversion = [...passingRows, ...failingRows].some((row) => row[2] && row[2] !== '—');
  const conversionColumns = hasLetterConversion ? ['Point grade', 'Percentage range', 'Letter'] : ['Point grade', 'Percentage range'];
  const visibleConversionRows = (rows: any[][]) => hasLetterConversion ? rows : rows.map((row) => row.slice(0, 2));
  return <>
    <Heading title="Grading Criteria" subtitle="Read-only summary of the active grading system for the selected class." />
    <ClassSelect {...props} />
    <Card>
      <View style={styles.criteriaIntro}>
        <View style={styles.flex}>
          <Text style={styles.criteriaNameLabel}>Active grading system</Text>
          <Text style={styles.criteriaName}>{system.name}</Text>
          {props.workspace.criteria?.version ? <Text style={styles.help}>Criteria version {props.workspace.criteria.version} · Applies to this class</Text> : <Text style={styles.help}>System-wide default · Applies unless this class has an assigned system</Text>}
        </View>
        <Badge tone="info">Read only</Badge>
      </View>
      {system.description ? <Text style={styles.criteriaNote}>{system.description}</Text> : null}
      <View style={styles.criteriaRule}><Text style={styles.criteriaRuleTitle}>Passing standard</Text><Text style={styles.help}>A final percentage of {passingThreshold}% or higher is passing.</Text></View>
      {hierarchyRows.length ? <View style={styles.criteriaSection}><Text style={styles.criteriaRuleTitle}>Nested grade hierarchy</Text><Text style={styles.help}>Contribution shows the share of the final grade; the parenthetical shows the share within the parent component.</Text>{hierarchyRows.map((row) => { const shortCode = row.component.shortCode ?? (assessmentTypes.get(row.component.assessmentDefinition?.typeId) as any)?.shortCode; const hierarchyTints = ['#F4F7FA', '#F7F9FB', '#FAFBFC', '#FCFDFE', '#FFFFFF']; return <View key={row.id} style={[styles.criteriaHierarchyNode, { paddingLeft: 9 + Math.min(row.depth, 6) * 18, backgroundColor: hierarchyTints[Math.min(row.depth, hierarchyTints.length - 1)] }]}><View style={styles.criteriaHierarchyHeading}><View style={styles.criteriaHierarchyCopy}><Text style={styles.criteriaHierarchyName}>{row.component.name}{shortCode ? ` (${shortCode})` : ''}</Text>{row.detail ? <Text style={styles.help}>{row.detail}</Text> : null}</View>{row.directShare != null ? <View style={styles.criteriaContributionGroup}><Text style={styles.criteriaContribution}>{`${Number((row.directShare * 100).toFixed(2))}%`}</Text><Text style={styles.criteriaLocalContribution}>{row.localShare != null && row.parentName ? `(${Number((row.localShare * 100).toFixed(2))}% of ${row.parentName})` : ''}</Text></View> : null}</View></View>; })}</View> : null}
      {periodRows.length ? <View style={styles.criteriaSection}><Text style={styles.criteriaRuleTitle}>Periods</Text><DataTable columns={['Period', 'Included groups']} rows={periodRows} /><Text style={styles.help}>{system.periodCalculation?.mode === 'cumulative' ? 'Period results are cumulative.' : system.periodCalculation?.mode === 'period_formula' ? 'Period results use the configured period formulas.' : 'Periods are calculated independently.'}</Text></View> : null}
      <View style={styles.criteriaSection}><Text style={styles.criteriaRuleTitle}>Grade conversion</Text><Text style={styles.help}>Point-grade ranges use the active passing threshold and rounding rules.</Text>{passingRows.length ? <><Text style={styles.criteriaScaleTitle}>Passing</Text><DataTable compact columns={conversionColumns} rows={visibleConversionRows(passingRows)} /></> : null}{failingRows.length ? <><Text style={styles.criteriaScaleTitle}>Failing</Text><DataTable compact columns={conversionColumns} rows={visibleConversionRows(failingRows)} /></> : null}</View>
    </Card>
  </>;
}

function Risk(props: StateProps & { prediction: boolean }) {
  const [selected, setSelected] = useState<RosterStudent | null>(null);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');
  const [riskFilter, setRiskFilter] = useState<'attention' | 'high' | 'medium' | 'low' | 'all'>('attention');
  const [trendFilter, setTrendFilter] = useState<'all' | 'declining' | 'stable' | 'improving'>('all');
  const [concernFilter, setConcernFilter] = useState<'all' | 'attendance' | 'missing' | 'declining' | 'grades' | 'mastery'>('all');
  const [predictionQuery, setPredictionQuery] = useState('');
  const [predictionRiskFilter, setPredictionRiskFilter] = useState<'all' | 'high' | 'medium' | 'low'>('all');
  const run = async () => {
    if (!props.selectedClassId) return;
    const inputs = props.workspace.students.flatMap((student) => {
      const standing = currentStanding(props.workspace, student.enrollmentId);
      const scores = recentScorePercentages(props.workspace, student.enrollmentId);
      if (standing == null || !scores.length) return [];
      return [{
        enrollmentId: student.enrollmentId,
        currentStanding: Number(standing.toFixed(2)),
        recentScores: scores,
        attendanceRate: Number((attendanceRate(props.workspace, student.enrollmentId) ?? 100).toFixed(2)),
        missingAssessmentCount: missingAssessments(props.workspace, student.enrollmentId),
      }];
    });
    setSaving(true);
    try {
      const result = await runAiPredictions(props.selectedClassId, inputs);
      props.toast.show(`AI prediction run saved for ${result.predictions.length} student(s).`);
      props.refresh();
    } catch (cause) {
      props.toast.show(cause instanceof Error ? cause.message : 'AI prediction could not run.');
    } finally {
      setSaving(false);
    }
  };
  const studentRows = useMemo(() => props.workspace.students.map((student) => {
    const summary = summarizeEnrollmentStanding(props.workspace, student.enrollmentId);
    const current = summary.finalGrade ?? summary.p3 ?? null;
    const attendance = attendanceRate(props.workspace, student.enrollmentId);
    const evaluation = props.workspace.evaluations[student.enrollmentId];
    const risk = riskFor(props.workspace, student.enrollmentId);
    const missing = missingAssessments(props.workspace, student.enrollmentId);
    const trend = evaluation?.trend ?? 'unknown';
    const concernKey = attendance != null && attendance < 80 ? 'attendance' : missing > 0 ? 'missing' : trend === 'declining' ? 'declining' : current != null && current < 80 ? 'grades' : summary.mastery != null && summary.mastery < 80 ? 'mastery' : null;
    const concern = evaluation?.factors[0] ?? (concernKey === 'attendance' ? 'Low attendance' : concernKey === 'missing' ? 'Missing work' : concernKey === 'declining' ? 'Declining performance' : concernKey === 'grades' ? 'Low current standing' : concernKey === 'mastery' ? 'Low mastery' : 'Monitoring review');
    const decline = current != null && evaluation?.predictedStanding != null ? current - evaluation.predictedStanding : null;
    return { student, summary, current, predicted: evaluation?.predictedStanding ?? null, attendance, risk, missing, trend, concernKey, concern, decline };
  }), [props.workspace]);
  const attentionCount = studentRows.filter((row) => row.risk === 'medium' || row.risk === 'high').length;
  const highCount = studentRows.filter((row) => row.risk === 'high').length;
  const mediumCount = studentRows.filter((row) => row.risk === 'medium').length;
  const decliningCount = studentRows.filter((row) => row.trend === 'declining').length;
  const missingCount = studentRows.filter((row) => row.missing > 0).length;
  const filteredRows = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return studentRows.filter((row) => {
      if (normalizedQuery && !`${row.student.name} ${row.student.institutionalId}`.toLowerCase().includes(normalizedQuery)) return false;
      if (riskFilter === 'attention' && row.risk !== 'medium' && row.risk !== 'high') return false;
      if (riskFilter !== 'attention' && riskFilter !== 'all' && row.risk !== riskFilter) return false;
      if (trendFilter !== 'all' && row.trend !== trendFilter) return false;
      if (concernFilter !== 'all' && row.concernKey !== concernFilter) return false;
      return true;
    }).sort((a, b) => {
      const riskRank = { high: 0, medium: 1, low: 2, unavailable: 3, unknown: 3 } as const;
      const riskDelta = (riskRank[a.risk as keyof typeof riskRank] ?? 3) - (riskRank[b.risk as keyof typeof riskRank] ?? 3);
      if (riskDelta) return riskDelta;
      return (b.decline ?? -1) - (a.decline ?? -1) || (a.attendance ?? 101) - (b.attendance ?? 101) || b.missing - a.missing || (a.current ?? 101) - (b.current ?? 101);
    });
  }, [concernFilter, query, riskFilter, studentRows, trendFilter]);
  const clearFilters = () => { setQuery(''); setRiskFilter('attention'); setTrendFilter('all'); setConcernFilter('all'); };
  const concernOptions = [{ label: 'All concerns', value: 'all' }, { label: 'Low attendance', value: 'attendance' }, { label: 'Missing work', value: 'missing' }, { label: 'Declining performance', value: 'declining' }, { label: 'Low grades', value: 'grades' }, { label: 'Low mastery', value: 'mastery' }];
  const predictionRows = useMemo(() => {
    const normalizedQuery = predictionQuery.trim().toLowerCase();
    return studentRows.filter((row) => {
      if (normalizedQuery && !`${row.student.name} ${row.student.institutionalId}`.toLowerCase().includes(normalizedQuery)) return false;
      return predictionRiskFilter === 'all' || row.risk === predictionRiskFilter;
    });
  }, [predictionQuery, predictionRiskFilter, studentRows]);
  return <>
    <Heading title={props.prediction ? 'AI-Assisted At-Risk Prediction' : 'Students Requiring Attention'} subtitle={props.prediction ? 'Stored predictions are advisory, traceable, and not institutionally validated.' : 'Identify students who may need academic intervention based on grades, attendance, missing work, mastery, and available predictions.'} action={props.prediction ? <Button label="Run AI prediction" loading={saving} onPress={() => void run()} /> : undefined} />
    <ClassSelect {...props} />
     {props.prediction ? <Card style={styles.predictionNotice}><View style={styles.predictionNoticeRow}><Badge tone="warning">Gemini AI · advisory only</Badge><Text style={styles.predictionNoticeTitle}>Use these estimates to prioritize review</Text></View><Text style={styles.help}>The system estimates likely standing from recorded indicators. It does not produce official grades or automatic decisions.</Text></Card> : null}
    {!props.prediction ? <>
      <View style={styles.attentionMetrics}>
        <Pressable style={styles.attentionMetric} onPress={() => setRiskFilter('attention')}><Text style={styles.attentionMetricValue}>{attentionCount}</Text><Text style={styles.attentionMetricLabel}>Require attention</Text></Pressable>
        <Pressable style={styles.attentionMetric} onPress={() => setRiskFilter('high')}><Text style={[styles.attentionMetricValue, styles.dangerText]}>{highCount}</Text><Text style={styles.attentionMetricLabel}>High risk</Text></Pressable>
        <Pressable style={styles.attentionMetric} onPress={() => setRiskFilter('medium')}><Text style={[styles.attentionMetricValue, styles.warningText]}>{mediumCount}</Text><Text style={styles.attentionMetricLabel}>Medium risk</Text></Pressable>
        <Pressable style={styles.attentionMetric} onPress={() => setTrendFilter('declining')}><Text style={styles.attentionMetricValue}>{decliningCount}</Text><Text style={styles.attentionMetricLabel}>Declining</Text></Pressable>
        <Pressable style={styles.attentionMetric} onPress={() => setConcernFilter('missing')}><Text style={styles.attentionMetricValue}>{missingCount}</Text><Text style={styles.attentionMetricLabel}>Missing work</Text></Pressable>
      </View>
      <Card>
        <View style={styles.attentionToolbar}>
          <SearchFilter value={query} onChange={setQuery} placeholder="Search students..." accessibilityLabel="Search students" />
          <SelectField label="Risk" value={riskFilter} options={[{ label: 'Requires Attention', value: 'attention' }, { label: 'High Risk', value: 'high' }, { label: 'Medium Risk', value: 'medium' }, { label: 'Low Risk', value: 'low' }, { label: 'All Students', value: 'all' }]} onChange={(value) => setRiskFilter(value as typeof riskFilter)} containerStyle={styles.attentionFilter} />
          <SelectField label="Trend" value={trendFilter} options={[{ label: 'All Trends', value: 'all' }, { label: 'Declining', value: 'declining' }, { label: 'Stable', value: 'stable' }, { label: 'Improving', value: 'improving' }]} onChange={(value) => setTrendFilter(value as typeof trendFilter)} containerStyle={styles.attentionFilter} />
          <SelectField label="Concern" value={concernFilter} options={concernOptions} onChange={(value) => setConcernFilter(value as typeof concernFilter)} containerStyle={styles.attentionFilter} />
        </View>
        <View style={styles.attentionTableHeader}><Text style={[styles.attentionHeaderText, styles.attentionStudent]}>STUDENT</Text><Text style={styles.attentionHeaderText}>CURRENT</Text><Text style={styles.attentionHeaderText}>PREDICTED</Text><Text style={styles.attentionHeaderText}>ATTENDANCE</Text><Text style={styles.attentionHeaderText}>RISK</Text><Text style={[styles.attentionHeaderText, styles.attentionConcern]}>PRIMARY CONCERN</Text><Text style={styles.attentionHeaderText}>ACTION</Text></View>
        {filteredRows.length ? filteredRows.map((row) => <View key={row.student.enrollmentId} style={styles.attentionRow}>
          <Pressable style={[styles.attentionCell, styles.attentionStudent]} onPress={() => setSelected(row.student)}><Text style={styles.rowTitle}>{row.student.name}</Text><Text style={styles.help}>{row.student.institutionalId}</Text></Pressable>
          <Text style={styles.attentionCell}>{row.current == null ? '—' : `${row.current.toFixed(1)}%`}</Text>
          <Text style={styles.attentionCell}>{row.predicted == null ? '—' : `${row.predicted.toFixed(1)}%${row.decline != null && row.decline >= 5 ? ' ↓' : ''}`}</Text>
          <Text style={styles.attentionCell}>{row.attendance == null ? '—' : `${row.attendance.toFixed(0)}%`}</Text>
          <View style={styles.attentionCell}><Badge tone={row.risk === 'high' ? 'danger' : row.risk === 'medium' ? 'warning' : 'success'} color={props.workspace.evaluationSystem?.levels.find((level) => level.severity === row.risk)?.color}>{row.risk === 'unavailable' ? 'Risk unavailable' : `${row.risk[0].toUpperCase()}${row.risk.slice(1)} Risk`}</Badge></View>
          <View style={[styles.attentionCell, styles.attentionConcern]}><Text style={styles.cellStrong}>{row.concern}</Text><Text style={styles.help}>{row.trend === 'declining' ? '↓ Declining' : row.trend === 'improving' ? '↑ Improving' : row.trend === 'stable' ? '→ Stable' : 'Trend unavailable'}</Text></View>
          <Pressable accessibilityRole="button" accessibilityLabel={`Review ${row.student.name}`} style={styles.reviewAction} onPress={() => setSelected(row.student)}><Text style={styles.reviewActionText}>Review →</Text></Pressable>
        </View>) : <PageState kind="empty" title={riskFilter === 'attention' && !attentionCount ? 'No students currently require attention' : 'No students match the selected filters'} message={riskFilter === 'attention' && !attentionCount ? 'Based on the available grades, attendance, mastery, missing work, and prediction data, no students in this class currently meet the attention criteria.' : 'Try clearing one or more filters.'} action={<Button label={riskFilter === 'attention' && !attentionCount ? 'View all students' : 'Clear filters'} variant="secondary" onPress={() => riskFilter === 'attention' && !attentionCount ? setRiskFilter('all') : clearFilters()} />} />}
        <Text style={styles.attentionCount}>{filteredRows.length} student{filteredRows.length === 1 ? '' : 's'} shown · sorted by risk and urgency</Text>
      </Card>
     </> : <>
       <View style={styles.predictionMetrics}>
         <View style={styles.predictionMetric}><Text style={styles.predictionMetricValue}>{studentRows.length}</Text><Text style={styles.predictionMetricLabel}>Students evaluated</Text></View>
         <View style={styles.predictionMetric}><Text style={[styles.predictionMetricValue, styles.dangerText]}>{highCount}</Text><Text style={styles.predictionMetricLabel}>High risk</Text></View>
         <View style={styles.predictionMetric}><Text style={[styles.predictionMetricValue, styles.warningText]}>{mediumCount}</Text><Text style={styles.predictionMetricLabel}>Medium risk</Text></View>
         <View style={styles.predictionMetric}><Text style={[styles.predictionMetricValue, styles.successText]}>{studentRows.filter((row) => row.risk === 'low').length}</Text><Text style={styles.predictionMetricLabel}>Low risk</Text></View>
       </View>
       <Card>
         <View style={styles.predictionToolbar}>
           <SearchFilter value={predictionQuery} onChange={setPredictionQuery} placeholder="Search students..." accessibilityLabel="Search prediction results" />
           <SelectField label="Risk" value={predictionRiskFilter} options={[{ label: 'All risk levels', value: 'all' }, { label: 'High Risk', value: 'high' }, { label: 'Medium Risk', value: 'medium' }, { label: 'Low Risk', value: 'low' }]} onChange={(value) => setPredictionRiskFilter(value as typeof predictionRiskFilter)} containerStyle={styles.predictionFilter} />
         </View>
         <Text style={styles.predictionSectionLabel}>Estimated standing by student</Text>
         <View style={styles.attentionTableHeader}><Text style={[styles.attentionHeaderText, styles.attentionStudent]}>STUDENT</Text><Text style={styles.attentionHeaderText}>CURRENT</Text><Text style={styles.attentionHeaderText}>MASTERY</Text><Text style={styles.attentionHeaderText}>ESTIMATED</Text><Text style={styles.attentionHeaderText}>RISK</Text><Text style={styles.attentionHeaderText}>TREND</Text><Text style={styles.attentionHeaderText}>ATTENDANCE</Text><Text style={[styles.attentionHeaderText, styles.attentionConcern]}>PRIMARY FACTOR</Text></View>
         {predictionRows.length ? predictionRows.map((row) => <View key={row.student.enrollmentId} style={styles.attentionRow}>
           <Pressable style={[styles.attentionCell, styles.attentionStudent]} onPress={() => setSelected(row.student)}><Text style={styles.rowTitle}>{row.student.name}</Text><Text style={styles.help}>{row.student.institutionalId}</Text></Pressable>
           <Text style={styles.attentionCell}>{row.current == null ? '—' : `${row.current.toFixed(1)}%`}</Text>
           <Text style={styles.attentionCell}>{row.summary.mastery == null ? '—' : `${row.summary.mastery.toFixed(1)}%`}</Text>
           <Text style={styles.attentionCell}>{row.predicted == null ? 'Unavailable' : `${row.predicted.toFixed(1)}%`}</Text>
           <View style={styles.attentionCell}><Badge tone={row.risk === 'high' ? 'danger' : row.risk === 'medium' ? 'warning' : 'success'} color={props.workspace.evaluationSystem?.levels.find((level) => level.severity === row.risk)?.color}>{row.risk === 'unavailable' ? 'Risk unavailable' : `${row.risk[0].toUpperCase()}${row.risk.slice(1)} Risk`}</Badge></View>
           <Text style={styles.attentionCell}>{row.trend}</Text>
           <Text style={styles.attentionCell}>{row.attendance == null ? '—' : `${row.attendance.toFixed(0)}%`}</Text>
            <View style={[styles.attentionCell, styles.attentionConcern]}><Text style={styles.cellStrong}>{row.concern}</Text><Pressable accessibilityRole="button" accessibilityLabel={`Review ${row.student.name}`} onPress={() => setSelected(row.student)}><Text style={styles.reviewActionText}>Review →</Text></Pressable></View>
         </View>) : <PageState kind="empty" title="No matching estimates" message="Try another student name or risk level." />}
         <Text style={styles.attentionCount}>{predictionRows.length} student{predictionRows.length === 1 ? '' : 's'} shown · select a student to review the underlying indicators</Text>
       </Card>
     </>}
    <StudentDetail student={selected} workspace={props.workspace} onClose={() => setSelected(null)} />
  </>;
}

function Feedback(props: StateProps) {
  const [studentId, setStudentId] = useState(props.workspace.students[0]?.enrollmentId ?? '');
  const [body, setBody] = useState('');
  const [status, setStatus] = useState<'draft' | 'ready'>('draft');
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (!props.workspace.students.some((student) => student.enrollmentId === studentId)) setStudentId(props.workspace.students[0]?.enrollmentId ?? ''); }, [props.workspace.students, studentId]);
  const student = props.workspace.students.find((item) => item.enrollmentId === studentId);
  const seed = () => {
    if (!student) return;
    const summary = summarizeEnrollmentStanding(props.workspace, student.enrollmentId);
    const standing = currentStanding(props.workspace, student.enrollmentId);
    const attendance = attendanceRate(props.workspace, student.enrollmentId);
    const evaluation = props.workspace.evaluations[student.enrollmentId];
    setBody([
      `Hello ${student.name},`,
      '',
      `Your current APMS monitoring standing is ${standing == null ? 'not yet available' : `${standing.toFixed(1)}%`}.`,
      `Your SWUNEXT mastery component is ${summary.mastery == null ? 'not yet available' : `${summary.mastery.toFixed(1)}%`}.`,
      `Your current APMS remark is ${summary.remarks}. Passing requires at least 80% final grade and at least 80% mastery.`,
      `Attendance is ${attendance == null ? 'not yet recorded' : `${attendance.toFixed(0)}%`}.`,
      `Key monitoring note: ${evaluation?.factors[0] ?? 'Continue monitoring submitted assessments and attendance.'}`,
      '',
      'This feedback is for monitoring and decision-support only and is not an official SIS grade.',
    ].join('\n'));
  };
  const save = async () => {
    if (!student) return;
    setSaving(true);
    try {
      await saveFeedbackDraft(student.enrollmentId, body, riskFor(props.workspace, student.enrollmentId), status);
      props.toast.show(status === 'ready' ? 'Feedback marked ready for faculty-confirmed delivery.' : 'Feedback draft saved.');
      setBody('');
      props.refresh();
    } catch (cause) {
      props.toast.show(cause instanceof Error ? cause.message : 'Feedback could not be saved.');
    } finally {
      setSaving(false);
    }
  };
  const history = student ? props.workspace.feedback[student.enrollmentId] ?? [] : [];
  return <><Heading title="Performance Feedback" subtitle="Draft, review, and mark feedback ready. APMS never sends sensitive feedback automatically." /><ClassSelect {...props} /><Card><InlineStudentSearch students={props.workspace.students} value={studentId} onChange={setStudentId} /><View style={styles.actions}><Button label="Generate draft" variant="secondary" disabled={!student} onPress={seed} /><SelectField label="Status" value={status} options={[{ label: 'Draft', value: 'draft' }, { label: 'Ready', value: 'ready' }]} onChange={(value) => setStatus(value as 'draft' | 'ready')} containerStyle={styles.statusField} /></View><Field label="Feedback message" value={body} onChangeText={setBody} multiline numberOfLines={7} style={styles.feedbackBox} /><Button label="Save feedback" loading={saving} disabled={!student || !body.trim()} onPress={() => void save()} /></Card><Card><Text style={styles.cardTitle}>Feedback History</Text>{history.length ? <DataTable columns={['Created', 'Status', 'Category', 'Message']} rows={history.map((item) => [new Date(item.createdAt).toLocaleDateString(), item.status, item.category, item.body.slice(0, 96)])} /> : <PageState kind="empty" title="No feedback yet" message="Saved drafts and ready feedback for the selected student appear here." />}</Card></>;
}

function InlineStudentSearch({ students, value, onChange }: { students: RosterStudent[]; value: string; onChange: (value: string) => void }) {
  const selected = students.find((student) => student.enrollmentId === value);
  const [query, setQuery] = useState(selected ? `${selected.name} · ${selected.institutionalId}` : '');
  useEffect(() => { const current = students.find((student) => student.enrollmentId === value); setQuery(current ? `${current.name} · ${current.institutionalId}` : ''); }, [students, value]);
  const normalized = query.trim().toLowerCase();
  const matches = students.filter((student) => `${student.name} ${student.institutionalId}`.toLowerCase().includes(normalized));
  return <View style={styles.inlineStudentSearch}><Field label="Student" value={query} onChangeText={setQuery} placeholder="Search student name or ID" autoCapitalize="none" /><ScrollView style={styles.inlineStudentOptions} nestedScrollEnabled keyboardShouldPersistTaps="handled">{matches.map((student) => <Pressable key={student.enrollmentId} accessibilityRole="button" accessibilityState={{ selected: student.enrollmentId === value }} onPress={() => { onChange(student.enrollmentId); setQuery(`${student.name} · ${student.institutionalId}`); }} style={[styles.inlineStudentOption, student.enrollmentId === value && styles.inlineStudentOptionSelected]}><Text style={[styles.inlineStudentOptionText, student.enrollmentId === value && styles.inlineStudentOptionTextSelected]}>{student.name}</Text><Text style={styles.help}>{student.institutionalId}</Text></Pressable>)}{!matches.length ? <Text style={styles.inlineStudentEmpty}>No matching students.</Text> : null}</ScrollView></View>;
}

function StudentDetail({ student, workspace, onClose }: { student: RosterStudent | null; workspace: ClassWorkspace; onClose: () => void }) {
  if (!student) return null;
  const summary = summarizeEnrollmentStanding(workspace, student.enrollmentId);
  const standing = currentStanding(workspace, student.enrollmentId);
  const attendance = attendanceRate(workspace, student.enrollmentId);
  const evaluation = workspace.evaluations[student.enrollmentId];
  const missing = missingAssessments(workspace, student.enrollmentId);
  return <Dialog visible={Boolean(student)} title="Student Performance Details" onClose={onClose}><Text style={styles.rowTitle}>{student.name}</Text><Text style={styles.help}>{student.institutionalId} · {student.program} · Year {student.yearLevel} · {student.section}</Text><View style={styles.metrics}><MetricCard label="Current standing" value={standing == null ? 'Missing' : `${standing.toFixed(1)}%`} tone={riskFor(workspace, student.enrollmentId) === 'high' ? 'danger' : 'info'} /><MetricCard label="Mastery" value={summary.mastery == null ? 'Missing' : `${summary.mastery.toFixed(1)}%`} tone={summary.mastery != null && summary.mastery < 80 ? 'danger' : 'success'} /><MetricCard label="Grade point" value={summary.gradePoint == null ? 'Incomplete' : summary.gradePoint.toFixed(2)} tone={summary.remarks === 'passing' ? 'success' : summary.remarks === 'failing' ? 'danger' : 'warning'} /><MetricCard label="Attendance" value={attendance == null ? 'No sessions' : `${attendance.toFixed(0)}%`} /></View><DataTable columnWidths={[170, 100, 430]} columns={['Period/Component', 'Value', 'Meaning']} rows={[
    ['P1', summary.p1 == null ? 'Missing' : `${summary.p1.toFixed(1)}%`, 'Running effortful learning, modules 1-5'],
    ['P2', summary.p2 == null ? 'Missing' : `${summary.p2.toFixed(1)}%`, 'Running effortful learning, modules 1-10'],
    ['P3', summary.p3 == null ? 'Missing' : `${summary.p3.toFixed(1)}%`, 'Cumulative effortful learning, modules 1-14'],
    ['FE', summary.mastery == null ? 'Missing' : `${summary.mastery.toFixed(1)}%`, 'Mastery from wrap-ups and project/output'],
    ['Final Grade', summary.finalGrade == null ? 'Incomplete' : `${summary.finalGrade.toFixed(1)}%`, 'P3 x 55% plus FE x 45%'],
    ['Remarks', summary.remarks.toUpperCase(), 'Passing requires final grade and mastery both at least 80%'],
  ]} /><DataTable columns={['Assessment', 'Component', 'Module', 'Score', 'Percent']} rows={workspace.assessments.map((assessment) => { const score = storedAssessmentValue(workspace, student.enrollmentId, assessment.id); const percent = assessmentPercentForWorkspace(workspace, student.enrollmentId, assessment); return [assessment.title, componentLabel(assessment.component, assessment.gradingTypeId, workspace.criteria?.gradingSystemDefinition ?? workspace.defaultGradingSystem), assessment.moduleNumber == null ? '—' : String(assessment.moduleNumber), score == null ? 'Missing' : typeof score === 'string' ? score : `${score}/${assessment.maximumScore}`, percent == null ? '—' : `${percent.toFixed(1)}%`]; })} /><Text style={styles.help}>Estimated standing: {evaluation?.predictedStanding == null ? 'Unavailable' : `${evaluation.predictedStanding.toFixed(1)}%`}. Missing work: {missing}. Key factors: {(evaluation?.factors.length ? evaluation.factors : ['Current monitoring indicators']).join('; ')}</Text></Dialog>;
}

function Analytics(props: StateProps) {
  const analyticsRecords = props.workspace.students.flatMap((student) => {
    const summary = summarizeEnrollmentStanding(props.workspace, student.enrollmentId);
    const score = summary.finalGrade ?? summary.p3 ?? summary.effortfulLearning ?? summary.mastery;
    return score == null ? [] : [{ id: student.enrollmentId, label: student.name, score, risk: riskFor(props.workspace, student.enrollmentId), classification: summary.remarks, category: student.section ?? 'Class', timestamp: props.workspace.assessments.at(-1)?.assessmentDate }];
  });
  const filters = useAnalyticsFilters(analyticsRecords);
  const visible = filters.filtered;
  const summaries = visible.map((item) => item.classification);
  const passing = summaries.filter((value) => value === 'passing').length;
  const low = visible.filter((item) => item.risk === 'low').length;
  const medium = visible.filter((item) => item.risk === 'medium').length;
  const high = visible.filter((item) => item.risk === 'high').length;
  const exportCsv = async () => { const csv = exportClassCsv(props.workspace); if (Platform.OS === 'web') { const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'apms-class-report.csv'; anchor.click(); URL.revokeObjectURL(url); } else await Share.share({ message: csv }); props.toast.show('Class report exported as CSV.'); };
  const scores = visible.map((item) => ({ label: item.label, value: item.score, kind: 'continuous' as const }));
  const visibleIds = new Set(visible.map((item) => item.id));
  const assessmentTrend = buildAssessmentTrend(props.workspace, visibleIds);
  const passFail = [{ label: 'Meets rule', value: passing }, { label: 'Below or incomplete', value: visible.length - passing }];
  return <><Heading title="Analytics and Reports" subtitle="Live class monitoring summary from SWUNEXT scores, attendance, and advisory risk data." action={<Button label="Export CSV" onPress={() => void exportCsv()} />} /><ClassSelect {...props} />{filters.controls}<View style={styles.metrics}><MetricCard label="Passing rule met" value={String(passing)} tone="success" /><MetricCard label="Below rule" value={String(visible.filter((item) => item.classification === 'failing').length)} tone="warning" /><MetricCard label="High risk" value={String(high)} tone="danger" /><MetricCard label="Assessments" value={String(props.workspace.assessments.length)} tone="info" /></View><View style={styles.analyticsCharts}><VisualizationPanel title="Student score histogram" description="Filtered continuous SWUNEXT scores grouped into score bands." data={scores} type="histogram" suffix="%" /><VisualizationPanel title="Risk distribution" description={`Low ${low} · Medium ${medium} · High ${high}`} data={[{ label: 'Low', value: low }, { label: 'Medium', value: medium }, { label: 'High', value: high }]} type="pie" /><VisualizationPanel title="Passing rule status" description="Binary pass and not yet passing classification." data={passFail} type="pie" /></View><VisualizationPanel title="Assessment trend" description="Mean assessment score over time for students matching these filters." data={assessmentTrend} type="line" suffix="%" /><Card><Text style={styles.help}>P1 and P2 are running cumulative views only. Final grade uses P3 effortful learning at 55% and FE mastery at 45%. Exports contain APMS monitoring data only and are not SIS submission files.</Text></Card></>;
}

function Dialog({ visible, title, onClose, children, footer }: { visible: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}><View style={styles.overlay}><Card style={styles.dialog}><View style={styles.heading}><Text accessibilityRole="header" style={styles.dialogTitle}>{title}</Text><Pressable accessibilityLabel="Close dialog" onPress={onClose}><Text style={styles.close}>×</Text></Pressable></View><ScrollView style={styles.dialogScroll} contentContainerStyle={styles.dialogBody} nestedScrollEnabled>{children}</ScrollView>{footer}</Card></View></Modal>;
}

const styles = StyleSheet.create({
  savedSystemHeader: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 12 },
  bulkClassActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  bulkClassRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 10 },
  bulkClassCheck: { color: colors.brand, fontSize: 20, width: 26 },
  bulkClassName: { color: colors.text, fontSize: 13, fontWeight: '700' },
  screen: { gap: 16 }, flex: { flex: 1 }, heading: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 22, lineHeight: 30, fontWeight: '700', color: colors.text }, subtitle: { fontSize: 13, lineHeight: 19, color: colors.textMuted, marginTop: 3 },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 }, cardTitle: { fontSize: 15, fontWeight: '700', color: colors.text, marginBottom: 12 },
  classSelect: { maxWidth: 460 }, actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, formGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }, sortField: { width: 220 },
  help: { fontSize: 12, lineHeight: 18, color: colors.textMuted }, rowTitle: { fontSize: 13, fontWeight: '600', color: colors.text },
  criteriaNameLabel: { fontSize: 12, fontWeight: '700', color: colors.textMuted, marginBottom: 6 }, criteriaName: { fontSize: 16, fontWeight: '700', color: colors.text, padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.surfaceMuted },
  criteriaOverview: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 }, criteriaIntro: { flexDirection: 'row', alignItems: 'flex-start', gap: 14 }, criteriaNote: { fontSize: 12, lineHeight: 18, color: colors.textMuted, marginTop: 10, marginBottom: 16 }, criteriaSection: { gap: 8, marginTop: 16 }, criteriaHierarchyNode: { gap: 3, padding: 9, marginTop: 5, borderLeftWidth: 2, borderLeftColor: '#C9D5E6', borderRadius: 6 }, criteriaHierarchyHeading: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }, criteriaHierarchyCopy: { flex: 1, minWidth: 0, gap: 3 }, criteriaHierarchyName: { color: colors.text, fontSize: 13, fontWeight: '700' }, criteriaContributionGroup: { width: 205, maxWidth: '58%', flexShrink: 0, flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'flex-end', gap: 8 }, criteriaContribution: { width: 58, flexShrink: 0, textAlign: 'right', color: colors.brand, fontSize: 11, lineHeight: 16, fontWeight: '700' }, criteriaLocalContribution: { flex: 1, minWidth: 0, textAlign: 'left', color: colors.textMuted, fontSize: 11, lineHeight: 16 }, criteriaScaleTitle: { color: colors.textMuted, fontSize: 12, fontWeight: '700', marginTop: 4 }, criteriaTable: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, overflow: 'hidden' }, criteriaTableHeader: { flexDirection: 'row', gap: 12, padding: 12, backgroundColor: colors.surfaceMuted, borderBottomWidth: 1, borderColor: colors.border }, criteriaTableRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 58, padding: 12, borderBottomWidth: 1, borderColor: colors.border }, criteriaHeaderText: { flex: 0.7, fontSize: 10, fontWeight: '700', letterSpacing: 0.5, color: colors.textMuted }, criteriaCell: { flex: 0.7, fontSize: 13, lineHeight: 18, color: colors.text }, criteriaComponent: { flex: 1.1 }, criteriaScoring: { flex: 2.4 }, criteriaRule: { padding: 14, marginTop: 16, borderRadius: 10, backgroundColor: '#F7ECE9' }, criteriaRuleTitle: { fontSize: 13, fontWeight: '700', color: colors.brand, marginBottom: 4 },
  attentionMetrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 }, attentionMetric: { flex: 1, minWidth: 135, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, ...shadow }, attentionMetricValue: { fontSize: 22, fontWeight: '700', color: colors.text }, attentionMetricLabel: { marginTop: 3, fontSize: 11, color: colors.textMuted }, dangerText: { color: colors.danger }, warningText: { color: colors.warning }, successText: { color: colors.success },
  predictionNotice: { gap: 6, borderLeftWidth: 4, borderLeftColor: colors.warning }, predictionNoticeRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10 }, predictionNoticeTitle: { fontSize: 13, fontWeight: '700', color: colors.text }, predictionMetrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 }, predictionMetric: { flex: 1, minWidth: 135, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, ...shadow }, predictionMetricValue: { fontSize: 22, fontWeight: '700', color: colors.text }, predictionMetricLabel: { marginTop: 3, fontSize: 11, color: colors.textMuted }, predictionToolbar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', gap: 10, marginBottom: 14 }, predictionFilter: { width: 180 }, predictionSectionLabel: { fontSize: 13, fontWeight: '700', color: colors.text, marginBottom: 4 },
  attentionToolbar: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end', marginBottom: 14 }, attentionFilter: { width: 170 }, attentionTableHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, borderBottomWidth: 1, borderColor: colors.border }, attentionHeaderText: { flex: 0.8, fontSize: 10, fontWeight: '700', letterSpacing: 0.5, color: colors.textMuted }, attentionStudent: { flex: 1.45 }, attentionConcern: { flex: 1.55 }, attentionRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 70, paddingVertical: 9, borderBottomWidth: 1, borderColor: colors.border }, attentionCell: { flex: 0.8, minWidth: 0, fontSize: 12, color: colors.text }, cellStrong: { fontSize: 12, fontWeight: '600', color: colors.text }, reviewAction: { flex: 0.8, paddingVertical: 8 }, reviewActionText: { color: colors.brand, fontSize: 12, fontWeight: '700' }, attentionCount: { fontSize: 11, color: colors.textMuted, marginTop: 12 },
  assessmentContext: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingBottom: 12, marginBottom: 8, borderBottomWidth: 1, borderColor: colors.border }, assessmentTitle: { fontSize: 16, fontWeight: '700', color: colors.text }, maxScore: { fontSize: 13, fontWeight: '700', color: colors.brand },
  gradebookTabs: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, alignSelf: 'stretch', marginBottom: 4 }, paginationToggle: { flexDirection: 'row', alignItems: 'center', gap: 7, marginLeft: 'auto', paddingHorizontal: 8, paddingVertical: 6 }, paginationToggleLabel: { color: colors.textMuted, fontSize: 12, fontWeight: '600' }, paginationToggleState: { color: colors.textMuted, fontSize: 11, minWidth: 20 }, paginationSwitch: { width: 32, height: 18, justifyContent: 'center', paddingHorizontal: 2, borderRadius: 10, backgroundColor: colors.border }, paginationSwitchOn: { backgroundColor: colors.brand }, paginationSwitchThumb: { width: 14, height: 14, borderRadius: 7, backgroundColor: colors.surface }, paginationSwitchThumbOn: { alignSelf: 'flex-end' },
  gradeToolbar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', gap: 10, marginTop: 16, marginBottom: 12 }, studentSearch: { flex: 1, minWidth: 220 }, studentFilter: { width: 190 }, studentSort: { width: 190 }, resultCount: { fontSize: 12, color: colors.textMuted, paddingBottom: 12 },
  gradebookContextOverlay: { flex: 1, backgroundColor: 'transparent' }, gradebookContextMenu: { position: 'absolute', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 7, paddingVertical: 2, overflow: 'hidden', ...shadow }, gradebookContextBack: { minHeight: 26, borderBottomWidth: 1, borderColor: colors.border }, gradebookContextBackArrow: { color: colors.textMuted, fontSize: 19, lineHeight: 20, width: 12, textAlign: 'center' }, gradebookContextSubmenuArrow: { color: colors.textMuted, fontSize: 18, lineHeight: 18, marginLeft: 4 }, gradebookContextAction: { minHeight: 28, flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 9, paddingVertical: 4 }, gradebookContextActionText: { flex: 1, color: colors.text, fontSize: 11, lineHeight: 14 },
  fullViewOptionsBar: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: -4, marginBottom: 6 }, viewOptionsOverlay: { flex: 1, backgroundColor: '#00000033', alignItems: 'flex-end', justifyContent: 'flex-start', paddingTop: 112, paddingBottom: 16, paddingHorizontal: 16 }, viewOptionsPopover: { width: 340, maxWidth: '100%', maxHeight: Platform.OS === 'web' ? 'calc(100vh - 128px)' as any : '75%', flexGrow: 0, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, ...shadow }, viewOptionsPopoverContent: { gap: 9, padding: 12 }, viewOptionsHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, viewOptionsTitle: { color: colors.text, fontSize: 15, fontWeight: '700' }, viewOptionsClose: { color: colors.textMuted, fontSize: 22, lineHeight: 24, paddingHorizontal: 4 }, viewOptionsHelp: { color: colors.textMuted, fontSize: 12, lineHeight: 17 }, fullGradeToggle: { flexDirection: 'row', alignItems: 'center', gap: 8 }, fullGradeToggleBox: { width: 16, height: 16, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border, borderRadius: 3 }, fullGradeToggleBoxSelected: { backgroundColor: colors.brand, borderColor: colors.brand }, fullGradeToggleMark: { color: colors.surface, fontSize: 11, lineHeight: 13, fontWeight: '700' }, fullGradeToggleLabel: { flex: 1, color: colors.text, fontSize: 12, lineHeight: 17 },
  gradebookActionOverlay: { flex: 1, backgroundColor: '#00000066', alignItems: 'center', justifyContent: 'center', padding: 20 }, gradebookActionDialog: { width: 460, maxWidth: '100%', gap: 14, padding: 20, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, ...shadow }, gradebookActionButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 4 }, validationError: { color: colors.danger, fontSize: 12, lineHeight: 16 },
  fullGridRestoreActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: -6 }, fullGridScrollFrame: { position: 'relative', width: '100%', borderWidth: 1, borderColor: colors.border, borderRadius: 10 }, fullGridVerticalShadow: { position: 'absolute', top: 0, bottom: 0, width: 1, zIndex: 100, pointerEvents: 'none', backgroundColor: colors.border, shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 3, shadowOffset: { width: 1, height: 0 }, elevation: 2, ...(Platform.OS === 'web' ? { boxShadow: '1px 0 3px rgba(0,0,0,0.12)' } as any : {}) }, fullGridHorizontalShadow: { position: 'absolute', left: 0, right: 0, height: 1, zIndex: 100, pointerEvents: 'none', backgroundColor: colors.border, shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 2, ...(Platform.OS === 'web' ? { boxShadow: '0 1px 3px rgba(0,0,0,0.12)' } as any : {}) }, fullGridVerticalScroll: { height: 560 }, fullGridFrozenHeader: { position: 'relative', zIndex: 80, backgroundColor: colors.surfaceMuted }, fullGridFrozenColumns: { flexDirection: 'row', flexShrink: 0, backgroundColor: colors.surface, zIndex: 10000 }, fullVerticalMergedHeader: { position: 'absolute', zIndex: 90, borderTopWidth: 1, borderLeftWidth: 1 }, fullTableRow: { flexDirection: 'row', alignItems: 'stretch', gap: 0, minHeight: 31, paddingVertical: 0, borderBottomWidth: 1, borderColor: colors.border }, gradebookHoverTint: { backgroundColor: '#EEF4FF' }, fullHeaderRow: { flexDirection: 'row', alignItems: 'stretch', gap: 0, height: 22 }, fullHierarchyLabelColumn: { justifyContent: 'center', paddingHorizontal: 6, paddingVertical: 1, borderRightWidth: 1, borderColor: colors.border }, fullClassNumberColumn: { justifyContent: 'center', alignItems: 'center', paddingHorizontal: 2, paddingVertical: 1, borderRightWidth: 1, borderColor: colors.border }, fullStudentNameColumn: { justifyContent: 'center', paddingHorizontal: 5, paddingVertical: 1, borderRightWidth: 1, borderColor: colors.border }, fullStudentIdColumn: { justifyContent: 'center', paddingHorizontal: 4, paddingVertical: 1, borderRightWidth: 1, borderColor: colors.border }, fullClassNumberHeader: { height: 22, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 2, borderRightWidth: 1, borderBottomWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceMuted }, fullStudentHeader: { height: 22, justifyContent: 'center', paddingHorizontal: 5, borderRightWidth: 1, borderBottomWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceMuted }, fullStudentHeaderSpacer: { height: 22, borderRightWidth: 1, borderBottomWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceMuted }, fullAssessmentColumn: { width: 108, justifyContent: 'center', paddingHorizontal: 2, paddingVertical: 0, borderRightWidth: 1, borderColor: colors.border }, fullComputedCell: { backgroundColor: colors.surfaceMuted }, fullComputedValue: { color: colors.text, fontSize: 9, lineHeight: 11, fontWeight: '600', textAlign: 'center' }, fullStudentName: { color: colors.text, fontSize: 10, lineHeight: 12, fontWeight: '600' }, fullStudentMeta: { color: colors.textMuted, fontSize: 8, lineHeight: 10 }, fullHeaderLevel: { color: colors.textMuted, fontSize: 8, lineHeight: 10, fontWeight: '700' }, fullMergedHeader: { height: 22, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 2, paddingVertical: 1, borderRightWidth: 1, borderBottomWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceMuted }, fullMergedHeaderVerticalContinue: { borderBottomWidth: 0 }, fullMergedHeaderText: { color: colors.text, fontSize: 8, lineHeight: 10, fontWeight: '700', textAlign: 'center' }, fullAssessmentHeading: { color: colors.text, fontSize: 10, lineHeight: 12, fontWeight: '700', marginBottom: 1 }, fullHierarchy: { color: colors.textMuted, fontSize: 9, lineHeight: 11, marginBottom: 1 }, fullScoreField: { width: '100%', minWidth: 0 }, fullNumericScoreField: { width: 48, alignSelf: 'center' }, fullNumericInput: { borderWidth: 0, paddingHorizontal: 0, paddingVertical: 0, textAlign: 'center', backgroundColor: 'transparent' },
  bulkBar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', gap: 8, padding: 10, marginBottom: 12, borderRadius: 10, backgroundColor: colors.surfaceMuted }, bulkScoreField: { width: 110 },
  gradeHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, paddingLeft: 34, borderBottomWidth: 1, borderColor: colors.border }, gradeHeaderText: { fontSize: 10, fontWeight: '700', letterSpacing: 0.7, color: colors.textMuted }, gradeStudentColumn: { flex: 1, minWidth: 0 }, gradeSummaryColumn: { flex: 1, minWidth: 0 }, gradeScoreColumn: { width: 120, flexShrink: 0, textAlign: 'right' },
  gradeRows: { gap: 0, marginBottom: 16 }, gradeRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 76, paddingVertical: 10, borderBottomWidth: 1, borderColor: colors.border }, studentCheck: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderRadius: 5, borderColor: colors.border }, studentCheckSelected: { backgroundColor: colors.brand, borderColor: colors.brand }, studentCheckText: { color: colors.surface, fontWeight: '700' },
  summaryCell: { gap: 4 }, badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 }, scoreField: { width: 120, flexShrink: 0 }, saveBar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12, paddingTop: 12 }, saveState: { fontSize: 13, fontWeight: '700', color: colors.text }, statusField: { width: 170 }, overlay: { flex: 1, backgroundColor: '#00000066', alignItems: 'center', justifyContent: 'center', padding: 24 },
  rosterCheckbox: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderRadius: 5, borderColor: colors.border }, rosterCheckboxSelected: { backgroundColor: colors.brand, borderColor: colors.brand }, rosterCheckboxMark: { color: colors.surface, fontWeight: '700' }, pagination: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingTop: 14 }, paginationText: { color: colors.textMuted, fontSize: 12 }, attendanceToolbar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingBottom: 4 }, attendanceRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 58, paddingVertical: 6, borderBottomWidth: 1, borderColor: colors.border }, attendanceStatusField: { width: 145 }, inlineStudentSearch: { gap: 6 }, inlineStudentOptions: { maxHeight: 220, borderWidth: 1, borderColor: colors.border, borderRadius: 10 }, inlineStudentOption: { paddingHorizontal: 12, paddingVertical: 9, borderBottomWidth: 1, borderColor: colors.border }, inlineStudentOptionSelected: { backgroundColor: '#F7ECE9' }, inlineStudentOptionText: { color: colors.text, fontSize: 14 }, inlineStudentOptionTextSelected: { color: colors.brand, fontWeight: '700' }, inlineStudentEmpty: { color: colors.textMuted, fontSize: 13, padding: 12, textAlign: 'center' },
  feedbackBox: { minHeight: 150, paddingTop: 10, textAlignVertical: 'top' }, aiPrompt: { color: colors.text, backgroundColor: colors.canvas, borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 12, fontSize: 12, lineHeight: 18 },
  analyticsCharts: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  dialog: { width: '100%', maxWidth: 920, maxHeight: '90%', padding: 22 }, dialogTitle: { fontSize: 19, fontWeight: '700', color: colors.text }, dialogScroll: { flexShrink: 1, marginTop: 16 }, dialogBody: { gap: 14, paddingBottom: 4 }, dialogContent: { gap: 12 }, dialogFooter: { borderTopWidth: 1, borderColor: colors.border, paddingTop: 14, marginTop: 14 }, close: { fontSize: 28, color: colors.textMuted },
});
