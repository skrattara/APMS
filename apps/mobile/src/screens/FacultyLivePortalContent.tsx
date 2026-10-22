import { getErrorMessage } from '@/services/errors';
import { forecastError, formatForecastError, isSavedForecastResponseError } from '@/services/predictionErrors';
import { buildRecordedAssessmentColumns, formatForecastAggregate, formatRecordedAssessmentScore, isForecastOutputEnabled } from '@/services/forecastGradeColumns';
import { buildForecastEvidence } from '@/services/forecastEligibility';
import { planPredictionRequestBatches, predictionBatchItemLimit } from '@/services/predictionBatching';
import { useIsFocused } from 'expo-router';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Modal, Platform, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';

import { useAuth } from '@/auth/AuthProvider';
import { AppIcon } from '@/components/Icon';
import { supabase } from '@/services/supabase';
import { Badge, Button, Card, ConfirmDialog, DataTable, DateField, Field, MetricCard, PageState, RangeSlider, RefreshIndicator, SearchFilter, SelectField, TablePageSizeSelect, Tabs, useTablePaginationPreference, useToast } from '@/components/ui';
import { formatStudentId, normalizeStudentId } from '@/utils/studentId';
import { isValidStudentId } from '@/utils/studentId';
import { useStudentIdValidation, useYearLevels } from '@/hooks/useAcademicOptions';
import { useAnalyticsFilters } from '@/components/charts/AnalyticsFilters';
import { ReportComposer, type ReportRecord, type ReportScopeOption } from '@/components/reports/ReportComposer';
import { AIAdvisoryForecast } from '@/components/AIAdvisoryForecast';
import { evaluationRiskOptions, evaluationRiskValue } from '@/services/evaluationRiskOptions';
import { styles } from '@/screens/FacultyLivePortalContent.styles';
import { storedAssessmentValue, valueMappingForType } from '@/components/gradebook/shared';
import { adaptAssessmentForecastOverlay, assessmentComponentPath, assessmentGroupLabel, assessmentPeriodLabel, componentLabel, gradingComponentPath, groupHierarchyName } from '@/components/gradebook/model';
import {
  addStudentToClass, applyFacultyEvaluationSystemToClasses, createAssessment, createAttendanceSession, deleteFacultyClassEvaluationSystem, encodePredictionInput, exportClassCsv, invalidateFacultyClassWorkspaceCache, invalidateFacultyClassesCache, loadAssessmentScoreHistory, loadGradebookScoreHistory, nameGradebookScoreVersion, restoreAssessmentInstanceVersion, restoreAssessmentScoreVersion, restoreGradebookToVersion,
  importRosterCsv, importRosterExcel, loadClassWorkspace, loadFacultyClasses, loadFacultyEvaluationCriteriaLibrary, loadFacultyReferenceData, loadMyClassRequests, loadMySubjectRequests, removeStudentsFromClass,
  previewRosterCsv, previewRosterExcel, generateFacultyFeedbackDraft, runAiPredictions, saveAttendance, saveFacultyFeedback, sendFacultyFeedbackEmail, saveScores, saveScoreBatch,
  submitFacultyClassRequest, submitSubjectRequest, calculateEnrollmentGrade, summarizeEnrollmentStanding, updateAssessment,
  updateStudentDetails, type ClassWorkspace, type FacultyAssessment, type FacultyClass, type FacultyReferenceData, type RosterStudent,
  type FacultyClassRequest, type SubjectRequest, type PredictionInput,
} from '@/services/faculty';
import { EvaluationSystemBuilderForm } from '@/components/EvaluationSystemBuilderForm';
import { colors, shadow } from '@/theme/tokens';
import { buildUnscoredAssessmentForecastOverlays, calculateGradingSystem, calculateTrend, createAssessmentForecastDomainValidator, DEFAULT_EVALUATION_SYSTEM, evaluateStudentPerformanceDetailed, extractValidatedSavedAiFactorValues, IT_GLOBAL_GRADING_SYSTEM, summarizeSavedForecast, swunextAssessmentComponents, validateEvaluationSystem, validateGradingSystem, type EvaluationDefinition, type SwunextAssessmentComponent } from '@apms/domain';

const LazyGradebook = lazy(() => import('@/components/gradebook/Gradebook').then((module) => ({ default: module.Gradebook })));
const LazyVisualizationPanel = lazy(() => import('@/components/charts/VisualizationPanel').then((module) => ({ default: module.VisualizationPanel })));

const emptyWorkspace: ClassWorkspace = { students: [], assessments: [], scores: {}, categoricalScores: {}, criteria: null, attendanceSessions: [], attendance: {}, evaluations: {}, feedback: {} };
type StudentFormState = { institutionalId: string; email: string; firstName: string; lastName: string; yearLevel: string; section: string };
const emptyStudentForm: StudentFormState = { institutionalId: '', email: '', firstName: '', lastName: '', yearLevel: '1', section: '' };
export type AssessmentFormState = { title: string; component: SwunextAssessmentComponent; gradingTypeId: string; gradingGroupId: string; gradingPeriodId: string; instanceWeight: string; maximumScore: string; moduleNumber: string; date: string; gradingPeriod: string; source: 'manual' | 'csv' };
export const emptyAssessmentForm: AssessmentFormState = { title: '', component: 'wrap_up_quiz', gradingTypeId: 'wuq', gradingGroupId: '', gradingPeriodId: 'p1', instanceWeight: '', maximumScore: '100', moduleNumber: '', date: new Date().toISOString().slice(0, 10), gradingPeriod: 'P1', source: 'manual' };

/** Build the same schema-bound student records for every explicit forecast action. */
export function buildClassPredictionInputs(workspace: ClassWorkspace, evaluationDefinition: EvaluationDefinition): PredictionInput[] {
  return workspace.students.flatMap((student) => {
    const context = evaluationContextForStudent(workspace, student.enrollmentId);
    const standing = context.calculated.finalGrade;
    // An incomplete final is intentionally kept null; mapped history may still
    // support an early forecast when the applied criteria allow recent scores.
    const scores = recentScorePercentages(workspace, student.enrollmentId);
    const attendance = attendanceRate(workspace, student.enrollmentId);
    const missing = missingAssessments(workspace, student.enrollmentId);
    const studentAssessments = workspace.assessments.map((assessment) => ({
      assessmentRef: assessment.id,
      title: assessment.title,
      type: assessment.gradingTypeId ?? assessment.component,
      date: assessment.assessmentDate,
      score: storedAssessmentValue(workspace, student.enrollmentId, assessment.id),
      maximum: assessment.maximumScore,
      percentage: assessmentPercentForWorkspace(workspace, student.enrollmentId, assessment),
      weight: assessment.instanceWeight,
      periodId: assessment.gradingPeriodId,
      groupId: assessment.gradingGroupId,
    }));
    const evidence = buildForecastEvidence({
      currentStanding: standing,
      recentScores: scores,
      inputFeatures: evaluationDefinition.ai?.inputFeatures ?? [],
    });
    if (!evidence) return [];
    return [{
      enrollmentId: student.enrollmentId,
      currentStanding: evidence.currentStanding == null ? null : Number(evidence.currentStanding.toFixed(2)),
      recentScores: evidence.recentScores,
      attendanceRate: attendance,
      missingAssessmentCount: missing,
      evaluationValues: context.values,
      recordContext: {
        current_standing: evidence.currentStanding,
        point_grade: context.calculated.pointGrade,
        letter_grade: context.calculated.letterGrade,
        final_remarks: context.calculated.remarks,
        period_grades: context.calculated.periods,
        component_grades: context.calculated.components,
        group_grades: context.calculated.groups,
        recent_assessment_percentages: evidence.recentScores,
        recent_scores: evidence.recentScores,
        attendance_rate: attendance,
        missing_assessment_count: missing,
        assessment_results: studentAssessments,
        evaluation_factors: evaluationDefinition.factors.map((factor) => ({
          factor_id: factor.id,
          name: factor.name,
          source: factor.source,
          origin: factor.origin ?? null,
          value: evaluationFactorValue(factor, context.values) ?? null,
          unit: factor.unit ?? null,
          weight: factor.weight ?? null,
          grading_component_id: factor.gradingComponentId ?? null,
          grading_group_id: factor.gradingGroupId ?? null,
          aggregation: factor.gradingAggregation ?? null,
        })),
      },
    }];
  });
}

export function buildClassAssessmentConstraints(workspace: ClassWorkspace) {
  return workspace.assessments.map((assessment) => ({
    assessmentRef: assessment.id,
    typeId: assessment.gradingTypeId ?? assessment.component,
    maximumScore: assessment.maximumScore,
    periodId: assessment.gradingPeriodId,
    groupId: assessment.gradingGroupId,
    weight: assessment.instanceWeight,
    optional: assessment.optional,
  }));
}

export function assessmentTypeScope(system: any, typeId: string) {
  const definition = (system.components ?? []).map((item: any) => item.assessmentDefinition).find((item: any) => item?.typeId === typeId);
  const scope = definition?.count?.scope?.type;
  return { requiresGroup: scope === 'per_group', requiresPeriod: scope === 'per_period', overall: scope === 'overall' };
}

export function assessmentAggregationMode(system: any, typeId: string) {
  return (system.components ?? []).map((item: any) => item.assessmentDefinition).find((item: any) => item?.typeId === typeId)?.aggregation?.mode;
}

export function highestCategory(mapping?: { value: string; percentage: number }[]) {
  return mapping?.reduce<{ value: string; percentage: number } | undefined>((highest, item) => !highest || item.percentage > highest.percentage ? item : highest, undefined)?.value ?? '';
}

function hasStoredAssessmentValue(workspace: ClassWorkspace, enrollmentId: string, assessmentId: string) {
  const value = storedAssessmentValue(workspace, enrollmentId, assessmentId);
  return value != null && String(value).trim() !== '';
}

function assessmentPercentForWorkspace(workspace: ClassWorkspace, enrollmentId: string, assessment: FacultyAssessment) {
  const raw = storedAssessmentValue(workspace, enrollmentId, assessment.id);
  if (raw == null) return null;
  const grading = workspace.criteria?.gradingSystemDefinition ?? workspace.defaultGradingSystem ?? IT_GLOBAL_GRADING_SYSTEM;
  const typeId = assessment.gradingTypeId ?? assessment.component;
  const definition = (grading.components ?? []).map((item: any) => item.assessmentDefinition).find((item: any) => item?.typeId === typeId);
  if (definition?.scoring?.mode === 'value_mapping') return definition.scoring.mapping.find((item: any) => String(item.value) === String(raw))?.percentage ?? null;
  const score = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(score) || !(assessment.maximumScore > 0)) return null;
  if (definition?.scoring?.mode === 'numeric_mapping') {
    const mapped = [...definition.scoring.mapping].sort((left: any, right: any) => left.value - right.value).filter((item: any) => score >= item.value).at(-1);
    if (mapped) return mapped.percentage;
  }
  return Number(((score / assessment.maximumScore) * 100).toFixed(2));
}

export function assessmentTypeDefaults(system: any, typeId: string) {
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

type TrendGrouping = 'day' | 'week' | 'group' | 'assessment instance';

function buildAssessmentTrend(workspace: ClassWorkspace, visibleIds: Set<string | undefined>, grouping: TrendGrouping = 'assessment instance') {
  const instances: { assessment: FacultyAssessment; value: number }[] = [];
  for (const assessment of workspace.assessments) {
    let total = 0;
    let count = 0;
    for (const student of workspace.students) {
      if (!visibleIds.has(student.enrollmentId)) continue;
      const percentage = assessmentPercentForWorkspace(workspace, student.enrollmentId, assessment);
      if (percentage == null) continue;
      total += percentage;
      count += 1;
    }
    if (count) instances.push({ assessment, value: total / count });
  }
  if (grouping === 'assessment instance') return instances
    .sort((left, right) => left.assessment.assessmentDate.localeCompare(right.assessment.assessmentDate) || left.assessment.title.localeCompare(right.assessment.title))
    .map(({ assessment, value }) => ({ label: `${assessment.title} · ${assessment.assessmentDate.slice(5)}`, value, kind: 'timeseries' as const, timestamp: assessment.assessmentDate, category: assessment.title }));

  const grading = workspace.criteria?.gradingSystemDefinition ?? workspace.defaultGradingSystem ?? IT_GLOBAL_GRADING_SYSTEM;
  const buckets = new Map<string, { label: string; timestamp: string; values: number[] }>();
  for (const { assessment, value } of instances) {
    let key: string;
    let label: string;
    let timestamp = assessment.assessmentDate;
    if (grouping === 'day') {
      key = assessment.assessmentDate;
      label = assessment.assessmentDate.slice(5);
    } else if (grouping === 'week') {
      const monday = new Date(`${assessment.assessmentDate}T00:00:00Z`);
      monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
      timestamp = monday.toISOString().slice(0, 10);
      key = timestamp;
      label = `Week of ${timestamp.slice(5)}`;
    } else {
      const group = grading.groups?.find((item: { id: string; name: string }) => item.id === assessment.gradingGroupId);
      key = assessment.gradingGroupId ? `group:${assessment.gradingGroupId}` : assessment.moduleNumber == null ? 'ungrouped' : `module:${assessment.moduleNumber}`;
      label = group?.name ?? (assessment.moduleNumber == null ? 'Ungrouped' : `Module ${assessment.moduleNumber}`);
    }
    const bucket = buckets.get(key) ?? { label, timestamp, values: [] };
    bucket.values.push(value);
    if (timestamp < bucket.timestamp) bucket.timestamp = timestamp;
    buckets.set(key, bucket);
  }
  return [...buckets.values()]
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.label.localeCompare(right.label))
    .map(({ label, timestamp, values }) => ({ label, value: values.reduce((sum, value) => sum + value, 0) / values.length, kind: 'timeseries' as const, timestamp, category: label }));
}

function useFacultyWorkspace(screen: string) {
  const { user } = useAuth();
  const [classes, setClasses] = useState<FacultyClass[]>([]);
  const [references, setReferences] = useState<FacultyReferenceData>({ subjects: [], terms: [], programs: [] });
  const [selectedClassId, setSelectedClassId] = useState('');
  const [workspace, setWorkspace] = useState<ClassWorkspace>(emptyWorkspace);
  const [loading, setLoading] = useState(true);
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const [workspaceClassId, setWorkspaceClassId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [classesReady, setClassesReady] = useState(false);
  const hasLoadedWorkspace = useRef(false);
  const refresh = useCallback(() => {
    invalidateFacultyClassesCache(user?.id);
    invalidateFacultyClassWorkspaceCache(user?.id, selectedClassId || undefined);
    setVersion((value) => value + 1);
  }, [user?.id, selectedClassId]);
  useEffect(() => {
    let active = true;
    if (hasLoadedWorkspace.current) setRefreshing(true);
    else setLoading(true);
    Promise.all([
      loadFacultyClasses(screen === 'classes', user?.id),
      screen === 'gradebook' || screen === 'records' || screen === 'overview' ? Promise.resolve({ subjects: [], terms: [], programs: [] } as FacultyReferenceData) : loadFacultyReferenceData(user?.id),
    ])
      .then(([nextClasses, nextReferences]) => {
        if (!active) return;
        setClasses(nextClasses); setReferences(nextReferences);
        setSelectedClassId((current) => nextClasses.some((item) => item.id === current) ? current : nextClasses[0]?.id ?? '');
        setClassesReady(true);
        setError(null);
        if (!hasLoadedWorkspace.current) setLoading(screen !== 'classes' && screen !== 'overview' && nextClasses.length > 0);
      })
      .catch((cause) => {
        if (active) {
          if (!hasLoadedWorkspace.current) setError(getErrorMessage(cause, 'Unable to load Faculty records.'));
          setLoading(false);
          setWorkspaceLoading(false);
        }
      })
      .finally(() => { if (active) setRefreshing(false); });
    return () => { active = false; };
  }, [version, screen]);
  useEffect(() => {
    if (!classesReady) return;
    let active = true;
    if (screen === 'classes') {
      setWorkspace(emptyWorkspace);
      setWorkspaceClassId(null);
      setWorkspaceLoading(false);
      setLoading(false);
      setRefreshing(false);
      return () => { active = false; };
    }
    if (!selectedClassId) {
      setWorkspace(emptyWorkspace);
      setWorkspaceClassId(null);
      setWorkspaceLoading(false);
      setLoading(false);
      return () => { active = false; };
    }
    if (hasLoadedWorkspace.current) setRefreshing(true);
    else if (screen !== 'overview') setLoading(true);
    if (screen === 'overview' && workspaceClassId !== selectedClassId) setWorkspaceLoading(true);
    setError(null);
    const gradebook = screen === 'gradebook' || screen === 'records';
    loadClassWorkspace(selectedClassId, undefined, user?.id, undefined, { includeAttendance: !gradebook, includeFeedback: screen === 'feedback', includeEvaluations: true })
      .then((nextWorkspace) => {
        if (!active) return;
        setWorkspace(nextWorkspace);
        setError(null);
        hasLoadedWorkspace.current = true;
        setWorkspaceClassId(selectedClassId);
      })
      .catch((cause) => { if (active) setError(getErrorMessage(cause, 'Unable to load Faculty records.')); })
      .finally(() => { if (active) { setLoading(false); setWorkspaceLoading(false); setRefreshing(false); } });
    return () => { active = false; };
  }, [classesReady, selectedClassId, version, user?.id, screen]);
  useEffect(() => {
    const client = supabase;
    if (!user || !client) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleRefresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, 300);
    };
    const channel = client.channel(`faculty-workspace-${user.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    for (const table of ['class_records', 'enrollments', 'assessments', 'assessment_results', 'criteria_sets', 'attendance_records', 'attendance_sessions', 'performance_evaluations', 'performance_predictions', 'faculty_class_evaluation_systems']) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, scheduleRefresh);
    }
    channel.subscribe();
    const poll = setInterval(refresh, 60_000);
    return () => { clearInterval(poll); if (timer) clearTimeout(timer); void client.removeChannel(channel); };
  }, [refresh, user]);
  return { classes, references, selectedClassId, setSelectedClassId, workspace, loading, workspaceLoading, workspaceClassId, refreshing, error, classesReady, refresh, userId: user?.id ?? '' };
}

export function FacultyLivePortalContent({ screen }: { screen: string }) {
  const isFocused = useIsFocused();
  const state = useFacultyWorkspace(screen);
  const toast = useToast();
  const forecastRosterCount = state.workspace.students.length;
  const [predictionRunning, setPredictionRunning] = useState(false);
  const [predictionRunError, setPredictionRunError] = useState<string | null>(null);
  const predictionRunLock = useRef(false);
  const mounted = useRef(true);
  const selectedClassRef = useRef(state.selectedClassId);
  const [showAiAssessmentPredictions, setShowAiAssessmentPredictions] = useState(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { selectedClassRef.current = state.selectedClassId; setPredictionRunError(null); }, [state.selectedClassId]);
  const runClassPredictions = useCallback(async () => {
    if (!state.selectedClassId || predictionRunLock.current) return;
    predictionRunLock.current = true;
    setPredictionRunning(true);
    setPredictionRunError(null);
    let completed = 0;
    let requested = 0;
    const classId = state.selectedClassId;
    const classInfo = state.classes.find((item) => item.id === classId);
    const classLabel = classInfo ? `${classInfo.code} · ${classInfo.section}` : 'selected class';
    try {
      const gradingDefinition = state.workspace.criteria?.gradingSystemDefinition ?? state.workspace.defaultGradingSystem ?? IT_GLOBAL_GRADING_SYSTEM;
      const evaluationDefinition = state.workspace.evaluationSystem ?? DEFAULT_EVALUATION_SYSTEM;
      // Check the locally applied schemas before preparing inputs so zero-eligible
      // counts do not hide a grading or evaluation configuration problem.
      if (!validateGradingSystem(gradingDefinition).valid) throw forecastError('invalid_grading');
      if (!validateEvaluationSystem(evaluationDefinition).valid) throw forecastError('invalid_criteria');
      const inputs = buildClassPredictionInputs(state.workspace, evaluationDefinition);
      requested = inputs.length;
      if (!requested) throw forecastError('no_eligible_students');
      const assessmentInstances = buildClassAssessmentConstraints(state.workspace);
      // Preflight every exact wire body before the first inference. A very large
      // schema or single student record must not fail after earlier batches save.
      const baseRequest = { class_id: classId, grading_system: gradingDefinition, evaluation_criteria: evaluationDefinition };
      const batches = planPredictionRequestBatches(baseRequest, inputs, {
        maxBytes: 900_000,
        maxItems: predictionBatchItemLimit(evaluationDefinition.ai?.provider),
        encodeItem: (input) => encodePredictionInput(input, evaluationDefinition),
      });
      for (const batch of batches) {
        const result = await runAiPredictions(classId, gradingDefinition, evaluationDefinition, batch.items, assessmentInstances);
        completed += result.predictions.length;
        invalidateFacultyClassWorkspaceCache(state.userId, classId);
      }
      if (mounted.current) {
        if (selectedClassRef.current === classId
          && (screen === 'gradebook' || screen === 'records')
          && evaluationDefinition.ai?.outputFields?.includes('assessment_score_predictions')) {
          setShowAiAssessmentPredictions(true);
        }
        state.refresh();
        toast.show(`Saved advisory forecasts for all ${completed} eligible students in ${classLabel}. Each batch is a separate run.`);
      }
    } catch (cause) {
      const savedButUnverified = isSavedForecastResponseError(cause);
      const message = savedButUnverified
        ? `${completed > 0 ? `Confirmed forecasts were saved for ${completed} earlier students in ${classLabel}. ` : `${classLabel}: `}${formatForecastError(cause)}`
        : completed > 0
        ? `Confirmed forecasts saved for ${completed} of ${requested} eligible students in ${classLabel}. The next request failed; later batches were not sent. Check saved predictions before retrying in case the interrupted request was saved. ${formatForecastError(cause)}`
        : `${classLabel}: ${formatForecastError(cause)}`;
      invalidateFacultyClassWorkspaceCache(state.userId, classId);
      if (mounted.current && selectedClassRef.current === classId) setPredictionRunError(message);
      if (completed > 0 || savedButUnverified) {
        if (mounted.current) {
          if (completed > 0 && selectedClassRef.current === classId
            && (screen === 'gradebook' || screen === 'records')) {
            const evaluationDefinition = state.workspace.evaluationSystem ?? DEFAULT_EVALUATION_SYSTEM;
            if (evaluationDefinition.ai?.outputFields?.includes('assessment_score_predictions')) setShowAiAssessmentPredictions(true);
          }
          state.refresh();
          toast.show(message);
        }
      } else {
        if (mounted.current) toast.show(message);
      }
    } finally {
      invalidateFacultyClassWorkspaceCache(state.userId, classId);
      predictionRunLock.current = false;
      if (mounted.current) setPredictionRunning(false);
    }
  }, [screen, state.classes, state.refresh, state.selectedClassId, state.workspace, toast]);
  const aiPredictionOverlays = useMemo(() => {
    if (!showAiAssessmentPredictions || (screen !== 'gradebook' && screen !== 'records')) return [];
    const gradingDefinition = state.workspace.criteria?.gradingSystemDefinition ?? state.workspace.defaultGradingSystem ?? IT_GLOBAL_GRADING_SYSTEM;
    const constraints = buildClassAssessmentConstraints(state.workspace);
    const isCurrentDomainPredictionValid = createAssessmentForecastDomainValidator(gradingDefinition, constraints);
    return buildUnscoredAssessmentForecastOverlays({ ...state.workspace, isPredictionValid: (assessmentId, prediction) => {
      return isCurrentDomainPredictionValid(assessmentId, prediction);
    } }).map(adaptAssessmentForecastOverlay);
  }, [screen, showAiAssessmentPredictions, state.workspace]);
  if (!isFocused) return null;
  if (screen !== 'overview' && state.loading) return <PageState kind="loading" title="Loading Faculty workspace" message="Retrieving your assigned classes and monitoring records." />;
  if (screen !== 'overview' && state.error) return <PageState kind="error" title="Faculty data unavailable" message={state.error} action={<Button label="Retry" onPress={state.refresh} />} />;
  const props = { ...state, toast, onRunAiPredictions: runClassPredictions, predictionRunning, predictionRunError, forecastRosterCount };
  if (screen === 'overview') {
    return <FacultyHomePage>
      <DashboardOverviewModule {...props} />
    </FacultyHomePage>;
  }
  return (
    <View style={styles.screen}>
      <RefreshIndicator visible={state.refreshing} />
      {screen === 'classes' ? <Classes {...props} /> : null}
      {screen === 'students' ? <Students {...props} /> : null}
      {screen === 'gradebook' || screen === 'records' ? <Suspense fallback={<PageState kind="loading" title="Loading gradebook" message="Preparing the gradebook view." />}><LazyGradebook
        {...props}
        cellOverlays={aiPredictionOverlays}
        overlayControl={{ label: 'AI score preview', active: showAiAssessmentPredictions, onToggle: () => setShowAiAssessmentPredictions((visible) => !visible) }}
        onCreateAssessment={(classId, input) => createAssessment(classId, state.userId, input)}
        onUpdateAssessment={updateAssessment}
        onSaveScores={(assessmentId, rows) => saveScores(state.userId, assessmentId, rows)}
        onSaveScoreBatch={(rows) => saveScoreBatch(state.userId, rows)}
        onLoadScoreHistory={loadAssessmentScoreHistory}
        onLoadGradebookHistory={(classId, cursor) => loadGradebookScoreHistory(classId, cursor)}
        onRestoreScoreVersion={restoreAssessmentScoreVersion}
        onRestoreGradebookVersion={restoreGradebookToVersion}
        onRestoreAssessmentVersion={restoreAssessmentInstanceVersion}
        onNameGradebookVersion={nameGradebookScoreVersion}
      /></Suspense> : null}
      {screen === 'attendance' ? <Attendance {...props} /> : null}
      {screen === 'criteria' ? <Criteria {...props} /> : null}
      {screen === 'risk' || screen === 'evaluation' ? <Risk {...props} /> : null}
      {screen === 'analytics' ? <Analytics {...props} /> : null}
      {screen === 'feedback' ? <Feedback {...props} /> : null}
    </View>
  );
}

type StateProps = ReturnType<typeof useFacultyWorkspace> & {
  toast: ReturnType<typeof useToast>;
  onRunAiPredictions: () => Promise<void>;
  predictionRunning: boolean;
  predictionRunError: string | null;
  forecastRosterCount: number;
};

export function Heading({ title, subtitle, action }: { title: string; subtitle: string; action?: ReactNode }) {
  return <View style={styles.heading}><View style={styles.flex}><Text accessibilityRole="header" style={styles.title}>{title}</Text><Text style={styles.subtitle}>{subtitle}</Text></View>{action}</View>;
}

export function ClassSelect({ classes, selectedClassId, setSelectedClassId }: Pick<StateProps, 'classes' | 'selectedClassId' | 'setSelectedClassId'>) {
  return <SelectField label="Class" value={selectedClassId} options={classes.map((item) => ({ label: `${item.code} · ${item.section}`, value: item.id }))} onChange={setSelectedClassId} containerStyle={styles.classSelect} />;
}

export function currentStanding(workspace: ClassWorkspace, enrollmentId: string) {
  return calculateEnrollmentGrade(workspace, enrollmentId).finalGrade;
}

export function attendanceRate(workspace: ClassWorkspace, enrollmentId: string) {
  const values = workspace.attendanceSessions.flatMap((session) => {
    const status = workspace.attendance[`${session.id}:${enrollmentId}`];
    return status ? [status === 'present' || status === 'excused' ? 1 : status === 'late' ? 0.5 : 0] : [];
  });
  return values.length ? (values.reduce((sum, value) => sum + value, 0) / values.length) * 100 : null;
}

function recentScorePercentages(workspace: ClassWorkspace, enrollmentId: string) {
  return [...workspace.assessments]
    .sort((left, right) => left.assessmentDate.localeCompare(right.assessmentDate))
    .flatMap((assessment) => {
      const value = assessmentPercentForWorkspace(workspace, enrollmentId, assessment);
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? [value] : [];
    });
}

function expectedAssessmentInstances(workspace: ClassWorkspace) {
  const grading = workspace.criteria?.gradingSystemDefinition ?? workspace.defaultGradingSystem ?? IT_GLOBAL_GRADING_SYSTEM;
  const aliases: Record<string, string> = { start_of_class: 'soc', lets_practice: 'lp', reflection: 'tb', wrap_up_quiz: 'wuq', project_checkin: 'cig', final_project: 'fo' };
  const matchesType = (rowType: string, definitionType: string) => rowType === definitionType || (aliases[rowType] ?? rowType) === (aliases[definitionType] ?? definitionType);
  const rowsForType = (typeId: string) => workspace.assessments.filter((item) => matchesType(item.gradingTypeId ?? item.component, typeId));
  let expectedButAbsent = 0;
  for (const component of grading.components ?? []) {
    const definition = component.assessmentDefinition;
    const minimum = Number(definition?.count?.min ?? 0);
    if (!definition || minimum <= 0) continue;
    const rows = rowsForType(definition.typeId);
    const scope = definition.count?.scope?.type;
    if (scope === 'per_group') {
      const groups = (grading.groups ?? []).filter((group: any) => group.typeId === definition.count.scope.groupTypeId);
      for (const group of groups) {
        const count = rows.filter((item) => (item.gradingGroupId ?? (item.moduleNumber == null ? null : `m${item.moduleNumber}`)) === group.id).length;
        expectedButAbsent += Math.max(0, minimum - count);
      }
    } else if (scope === 'per_period') {
      for (const period of grading.periods ?? []) {
        const count = rows.filter((item) => {
          const groupId = item.gradingGroupId ?? (item.moduleNumber == null ? null : `m${item.moduleNumber}`);
          const periodId = item.gradingPeriodId ?? grading.periods?.find((candidate: any) => groupId && candidate.groupIds?.includes(groupId))?.id;
          return periodId === period.id;
        }).length;
        expectedButAbsent += Math.max(0, minimum - count);
      }
    } else expectedButAbsent += Math.max(0, minimum - rows.length);
  }
  return expectedButAbsent;
}

export function missingAssessments(workspace: ClassWorkspace, enrollmentId: string, expectedButAbsent = expectedAssessmentInstances(workspace)) {
  const missingResults = workspace.assessments.filter((assessment) => !hasStoredAssessmentValue(workspace, enrollmentId, assessment.id)).length;
  return expectedButAbsent + missingResults;
}

type OverviewAssessmentRow = { assessment: FacultyAssessment; typeId: string; groupId: string | null };
type OverviewCalculationIndex = {
  assessmentsByDate: FacultyAssessment[];
  assessmentRows: OverviewAssessmentRow[];
  assessmentRowsByType: Map<string, OverviewAssessmentRow[]>;
  assessmentRowsByGroup: Map<string, OverviewAssessmentRow[]>;
  expectedMissingAssessments: number;
};
type DashboardOverviewRecord = {
  id: string;
  label: string;
  score: number;
  risk: string;
  classification: string;
  severity: string;
  riskColor?: string;
  calculated: ReturnType<typeof calculateEnrollmentGrade>;
  attendance: number | null;
  category: string;
  timestamp: string | undefined;
};

function createOverviewCalculationIndex(workspace: ClassWorkspace): OverviewCalculationIndex {
  const aliases: Record<string, string> = { start_of_class: 'soc', lets_practice: 'lp', reflection: 'tb', wrap_up_quiz: 'wuq', project_checkin: 'cig', final_project: 'fo' };
  const assessmentRows = workspace.assessments.map((assessment) => ({
    assessment,
    typeId: assessment.gradingTypeId ?? assessment.component,
    groupId: assessment.gradingGroupId ?? (assessment.moduleNumber == null ? null : `m${assessment.moduleNumber}`),
  }));
  const assessmentRowsByType = new Map<string, OverviewAssessmentRow[]>();
  for (const row of assessmentRows) {
    const key = aliases[row.typeId] ?? row.typeId;
    const rows = assessmentRowsByType.get(key) ?? [];
    rows.push(row);
    assessmentRowsByType.set(key, rows);
  }
  const grading = workspace.criteria?.gradingSystemDefinition ?? workspace.defaultGradingSystem ?? IT_GLOBAL_GRADING_SYSTEM;
  const assessmentRowsByGroup = new Map<string, OverviewAssessmentRow[]>();
  for (const group of grading.groups ?? []) {
    const included = new Set<string>([group.id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const child of grading.groups ?? []) {
        if (child.parentGroupId && included.has(child.parentGroupId) && !included.has(child.id)) {
          included.add(child.id);
          changed = true;
        }
      }
    }
    assessmentRowsByGroup.set(group.id, assessmentRows.filter((row) => row.groupId != null && included.has(row.groupId)));
  }
  return {
    assessmentsByDate: [...workspace.assessments].sort((left, right) => left.assessmentDate.localeCompare(right.assessmentDate)),
    assessmentRows,
    assessmentRowsByType,
    assessmentRowsByGroup,
    expectedMissingAssessments: expectedAssessmentInstances(workspace),
  };
}

function gradeFactorValues(workspace: ClassWorkspace, enrollmentId: string, calculated = calculateEnrollmentGrade(workspace, enrollmentId), overviewIndex?: OverviewCalculationIndex) {
  const grading = workspace.criteria?.gradingSystemDefinition ?? workspace.defaultGradingSystem ?? IT_GLOBAL_GRADING_SYSTEM;
  const values: Record<string, number | null> = {};
  const aggregate = (scores: number[], mode: 'average' | 'highest' | 'lowest') => !scores.length ? null : mode === 'highest' ? Math.max(...scores) : mode === 'lowest' ? Math.min(...scores) : scores.reduce((sum, score) => sum + score, 0) / scores.length;
  const modes = ['average', 'highest', 'lowest'] as const;
  const aliases: Record<string, string> = { start_of_class: 'soc', lets_practice: 'lp', reflection: 'tb', wrap_up_quiz: 'wuq', project_checkin: 'cig', final_project: 'fo' };
  const matchesType = (rowType: string, definitionType: string) => rowType === definitionType || (aliases[rowType] ?? rowType) === (aliases[definitionType] ?? definitionType);
  const assessmentRows = overviewIndex?.assessmentRows ?? workspace.assessments.map((assessment) => ({ assessment, typeId: assessment.gradingTypeId ?? assessment.component, groupId: assessment.gradingGroupId ?? (assessment.moduleNumber == null ? null : `m${assessment.moduleNumber}`) }));
  const percentage = (assessment: FacultyAssessment) => assessmentPercentForWorkspace(workspace, enrollmentId, assessment);
  for (const component of grading.components) {
    let scores: number[] = [];
    if (component.assessmentDefinition) {
      const typeId = component.assessmentDefinition.typeId;
      const typeRows = overviewIndex?.assessmentRowsByType.get(aliases[typeId] ?? typeId) ?? assessmentRows.filter((item) => matchesType(item.typeId, typeId));
      scores = typeRows.flatMap((item) => { const value = percentage(item.assessment); return value == null ? [] : [value]; });
    } else if (component.calculation?.components?.length) {
      scores = component.calculation.components.flatMap((item: any) => { const value = calculated.components[item.componentId]; return value == null ? [] : [value]; });
    } else if (calculated.components[component.id] != null) scores = [calculated.components[component.id]!];
    for (const mode of modes) values[`grading_component:${component.id}:${mode}`] = aggregate(scores, mode);
  }
  for (const group of grading.groups ?? []) {
    const groupRows = overviewIndex?.assessmentRowsByGroup.get(group.id) ?? (() => {
      const included = new Set<string>([group.id]);
      let changed = true;
      while (changed) { changed = false; for (const child of grading.groups ?? []) if (child.parentGroupId && included.has(child.parentGroupId) && !included.has(child.id)) { included.add(child.id); changed = true; } }
      return assessmentRows.filter((item) => item.groupId && included.has(item.groupId));
    })();
    const scores = groupRows.flatMap((item) => { const value = percentage(item.assessment); return value == null ? [] : [value]; });
    for (const mode of modes) values[`grading_group:${group.id}:${mode}`] = aggregate(scores, mode);
  }
  return values;
}

function evaluationContextForStudent(workspace: ClassWorkspace, enrollmentId: string, overviewIndex?: OverviewCalculationIndex) {
  const saved = workspace.evaluations[enrollmentId];
  const calculated = calculateEnrollmentGrade(workspace, enrollmentId);
  const attendance = attendanceRate(workspace, enrollmentId);
  const scoreHistory = (overviewIndex?.assessmentsByDate ?? [...workspace.assessments].sort((left, right) => left.assessmentDate.localeCompare(right.assessmentDate))).flatMap((assessment) => {
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
  const aiFactorValues = extractValidatedSavedAiFactorValues(definition, saved?.evaluationScores);
  const values = {
    ...gradeFactorValues(workspace, enrollmentId, calculated, overviewIndex),
    current_standing: calculated.finalGrade, attendance, attendance_rate: attendance, recent_scores: recentScores,
    recent_score_average: averageScores.length ? averageScores.reduce((sum, value) => sum + value, 0) / averageScores.length : null,
    recent_trend: recentTrend, trend,
    missing_assessment_count: missingAssessments(workspace, enrollmentId, overviewIndex?.expectedMissingAssessments),
    predicted_standing: saved?.predictedStanding ?? null, risk_probability: saved?.riskProbability ?? null, model_confidence: null,
    ai_risk_level: null,
    prediction_available: saved?.predictedStanding != null,
    prediction_age_hours: saved?.predictionGeneratedAt ? Math.max(0, (Date.now() - new Date(saved.predictionGeneratedAt).getTime()) / 3_600_000) : null,
    ai_factor_count: saved?.factors.length ?? null, data_basis: saved?.dataBasis ?? null,
    ...aiFactorValues,
  };
  return { definition, values, calculated, result: evaluateStudentPerformanceDetailed(definition, values) };
}

function useDashboardOverviewRecords(workspace: ClassWorkspace, definition: EvaluationDefinition, index: OverviewCalculationIndex, enabled: boolean) {
  const [computed, setComputed] = useState<{ workspace: ClassWorkspace; definition: EvaluationDefinition; records: DashboardOverviewRecord[] } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let cursor = 0;
    let timer: ReturnType<typeof setTimeout>;
    const records: DashboardOverviewRecord[] = [];
    const processBatch = () => {
      const end = Math.min(cursor + 8, workspace.students.length);
      for (; cursor < end; cursor += 1) {
        const student = workspace.students[cursor];
        const evaluation = evaluationContextForStudent(workspace, student.enrollmentId, index);
        const value = evaluation.calculated.finalGrade;
        if (value == null) continue;
        records.push({
          id: student.enrollmentId,
          label: student.name,
          score: value,
          risk: evaluationRiskValue(definition, evaluation.result),
          classification: evaluation.calculated.remarks,
          severity: evaluation.result.severity,
          riskColor: evaluation.definition.levels.find((level) => level.id === evaluation.result.matchedLevelId)?.color,
          calculated: evaluation.calculated,
          attendance: evaluation.values.attendance as number | null,
          category: student.section || 'Class',
          timestamp: workspace.assessments.at(-1)?.assessmentDate,
        });
      }
      if (!active) return;
      if (cursor < workspace.students.length) {
        timer = setTimeout(processBatch, 0);
        return;
      }
      setComputed({ workspace, definition, records });
    };
    timer = setTimeout(processBatch, 0);
    return () => { active = false; clearTimeout(timer); };
  }, [definition, enabled, index, workspace]);
  return enabled && computed?.workspace === workspace && computed.definition === definition ? computed.records : null;
}

export function riskFor(workspace: ClassWorkspace, enrollmentId: string) {
  return evaluationContextForStudent(workspace, enrollmentId).result.severity;
}

function evaluationRuleReasons(definition: EvaluationDefinition, result: ReturnType<typeof evaluateStudentPerformanceDetailed>) {
  const level = definition.levels.find((item) => item.id === result.matchedLevelId);
  if (!level || !result.matchedRuleIds.length) return result.severity === 'unavailable' ? 'Insufficient configured evaluation data' : 'No configured risk rule matched';
  const factors = new Map(definition.factors.map((factor) => [factor.id, factor]));
  return result.matchedRuleIds.flatMap((matchedId) => {
    const index = Number(matchedId.slice(matchedId.lastIndexOf(':') + 1));
    const rule = level.rules[index];
    const factor = rule ? factors.get(rule.factorId) : undefined;
    if (!rule || !factor) return [];
    return [rule.description || `${factor.name} ${rule.operator.replaceAll('_', ' ')} ${Array.isArray(rule.threshold) ? rule.threshold.join(', ') : rule.threshold}`];
  }).join('; ');
}

function evaluationFactorValue(factor: EvaluationDefinition['factors'][number], values: Record<string, any>) {
  const aggregation = factor.gradingAggregation ?? 'average';
  if (factor.source === 'grading_component' && factor.gradingComponentId) return values[`grading_component:${factor.gradingComponentId}:${aggregation}`];
  if (factor.source === 'grading_group' && factor.gradingGroupId) return values[`grading_group:${factor.gradingGroupId}:${aggregation}`];
  return values[factor.source];
}

function formatEvaluationFactorValue(factor: EvaluationDefinition['factors'][number], value: unknown) {
  if (value == null) return 'Unavailable';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'number') return factor.unit === 'percentage' ? `${value.toFixed(2)}%` : value.toFixed(2);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

function evaluationOriginLabel(origin: EvaluationDefinition['factors'][number]['origin']) {
  if (origin === 'academic_record') return 'Academic record';
  if (origin === 'derived') return 'Calculated from records';
  if (origin === 'ai_prediction') return 'AI prediction';
  return 'Not specified';
}

function evaluationLevelRuleSummary(definition: EvaluationDefinition, level: EvaluationDefinition['levels'][number]) {
  const factors = new Map(definition.factors.map((factor) => [factor.id, factor]));
  return level.rules.map((rule) => rule.description || `${factors.get(rule.factorId)?.name ?? 'Factor'} ${rule.operator.replaceAll('_', ' ')} ${Array.isArray(rule.threshold) ? rule.threshold.join(', ') : rule.threshold}`).join(level.match === 'all' ? ' AND ' : ' OR ') || 'Fallback level';
}

function FacultyHomePage({ children }: { children: ReactNode }) {
  return <View testID="faculty-home-page" style={styles.homePage}>{children}</View>;
}

function DashboardLoadingState({ message }: { message: string }) {
  return <View testID="faculty-dashboard-loading" style={styles.dashboardLoading}>
    <View style={styles.dashboardLoadingBanner}>
      <ActivityIndicator color={colors.brand} size="small" />
      <View style={styles.dashboardLoadingCopy}>
        <Text style={styles.cardTitle}>Preparing your dashboard</Text>
        <Text style={styles.help}>{message}</Text>
      </View>
    </View>
    <View style={styles.dashboardLoadingMetrics}>
      {[0, 1, 2, 3].map((item) => <View key={item} style={styles.dashboardLoadingMetric}>
        <View style={[styles.dashboardSkeleton, styles.dashboardSkeletonLabel]} />
        <View style={[styles.dashboardSkeleton, styles.dashboardSkeletonValue]} />
      </View>)}
    </View>
    <View style={styles.dashboardLoadingPanels}>
      {[0, 1].map((item) => <View key={item} style={styles.dashboardLoadingPanel}>
        <View style={[styles.dashboardSkeleton, styles.dashboardSkeletonHeading]} />
        <View style={styles.dashboardSkeletonChart}>
          {[34, 52, 43, 69, 58, 82, 64].map((height, index) => <View key={index} style={[styles.dashboardSkeletonBar, { height }]} />)}
        </View>
      </View>)}
    </View>
    <View style={styles.dashboardLoadingPanel}>
      <View style={[styles.dashboardSkeleton, styles.dashboardSkeletonHeading]} />
      {[0, 1, 2].map((item) => <View key={item} style={styles.dashboardSkeletonRow}>
        <View style={[styles.dashboardSkeleton, styles.dashboardSkeletonStudent]} />
        <View style={[styles.dashboardSkeleton, styles.dashboardSkeletonScore]} />
        <View style={[styles.dashboardSkeleton, styles.dashboardSkeletonStatus]} />
      </View>)}
    </View>
  </View>;
}

function DashboardOverviewModule(props: StateProps) {
  const [trendGrouping, setTrendGrouping] = useState<TrendGrouping>('day');
  const [attentionPage, setAttentionPage] = useState(0);
  const evaluationDefinition = props.workspace.evaluationSystem ?? DEFAULT_EVALUATION_SYSTEM;
  const overviewIndex = useMemo(() => createOverviewCalculationIndex(props.workspace), [props.workspace]);
  const workspaceReady = props.classesReady && (props.classes.length === 0
    || (props.workspaceClassId === props.selectedClassId && !props.workspaceLoading));
  const workspaceError = props.error && !props.loading ? props.error : null;
  const overviewRecordsResult = useDashboardOverviewRecords(props.workspace, evaluationDefinition, overviewIndex, workspaceReady);
  const dashboardDataReady = workspaceReady && overviewRecordsResult != null;
  const overviewRecords = overviewRecordsResult ?? [];
  const filters = useAnalyticsFilters(overviewRecords, evaluationRiskOptions(evaluationDefinition, 'All risks'));
  const visibleIds = useMemo(() => new Set(filters.filtered.map((item) => item.id)), [filters.filtered]);
  const studentsById = useMemo(() => new Map(props.workspace.students.map((student) => [student.enrollmentId, student])), [props.workspace.students]);
  const atRisk = useMemo(() => filters.filtered.filter((record) => record.severity !== 'low').flatMap((record) => {
    const student = studentsById.get(record.id);
    const forecast = student ? props.workspace.evaluations[student.enrollmentId] : undefined;
    return student ? [{ student, calculated: record.calculated, attendance: record.attendance, severity: record.severity, riskColor: record.riskColor, forecast }] : [];
  }), [filters.filtered, props.workspace.evaluations, studentsById]);
  const standings = useMemo(() => filters.filtered.map((item) => item.score), [filters.filtered]);
  const average = useMemo(() => standings.length ? standings.reduce((sum, value) => sum + value, 0) / standings.length : 0, [standings]);
  const riskCounts = [
    ...[...evaluationDefinition.levels].sort((left, right) => right.priority - left.priority).map((level) => ({ label: level.name, value: filters.filtered.filter((record) => record.risk === evaluationRiskValue(evaluationDefinition, { severity: level.severity, matchedLevelId: level.id, matchedRuleIds: [], evidenceCount: 0, unavailableFactors: [] })).length })),
    { label: 'No matching level', value: filters.filtered.filter((record) => record.risk === 'unmatched').length },
    { label: 'Unavailable', value: filters.filtered.filter((record) => record.risk === 'unavailable').length },
  ];
  const trend = useMemo(() => workspaceReady ? buildAssessmentTrend(props.workspace, visibleIds, trendGrouping) : [], [props.workspace, trendGrouping, visibleIds, workspaceReady]);
  const attentionPageSize = 25;
  const attentionPageCount = Math.ceil(atRisk.length / attentionPageSize);
  const visibleAttentionPage = Math.min(attentionPage, Math.max(0, attentionPageCount - 1));
  const visibleAttentionRows = useMemo(() => atRisk.slice(visibleAttentionPage * attentionPageSize, (visibleAttentionPage + 1) * attentionPageSize), [atRisk, visibleAttentionPage]);
  return <>
    <View testID="faculty-dashboard-shell" style={styles.screen}>
      <Heading title="Faculty Dashboard" subtitle="Live records from your Supabase-assigned classes. Values are provisional monitoring data, not official SIS grades." />
      {props.classesReady && props.classes.length > 0 ? <ClassSelect {...props} /> : null}
      {workspaceError ? <PageState kind="error" title="Dashboard data unavailable" message={workspaceError} action={<Button label="Retry" onPress={props.refresh} />} /> : null}
      {!dashboardDataReady && !workspaceError ? <DashboardLoadingState message={props.classesReady && !props.classes.length ? 'Checking for assigned classes…' : workspaceReady ? 'Calculating student summaries and risk levels…' : 'Loading your classes, roster, and assessment results…'} /> : null}
      {dashboardDataReady && !workspaceError ? <View testID="faculty-dashboard-data-ready" style={styles.screen}>
      <View style={styles.metrics}>
        <MetricCard label="Active classes" value={String(props.classes.length)} />
        <MetricCard label="Students monitored" value={String(filters.filtered.length)} tone="info" />
        <MetricCard label="Requiring attention" value={String(atRisk.length)} tone={atRisk.length ? 'danger' : 'success'} />
        <MetricCard label="Provisional average" value={standings.length ? `${average.toFixed(1)}%` : '—'} tone="success" />
      </View>
      {filters.controls}
      <View style={styles.analyticsCharts}><Suspense fallback={<Card><Text style={styles.cardTitle}>Preparing dashboard charts…</Text></Card>}><LazyVisualizationPanel title="Class score trend" description="Average assessment percentage in the selected class." data={trend} type="line" suffix="%" controls={<Tabs values={['day', 'week', 'group', 'assessment instance']} selected={trendGrouping} onSelect={(value) => setTrendGrouping(value as TrendGrouping)} />} /><LazyVisualizationPanel title="Risk distribution" description="Current advisory risk across the class roster." data={riskCounts} type="pie" /></Suspense></View>
      <Card><Text style={styles.cardTitle}>Students Requiring Attention</Text>{atRisk.length ? <>
      <DataTable columns={['Student', 'P3 Effort', 'Mastery', 'Final', 'Attendance', 'Applied risk', 'AI risk probability', 'Reason']} rows={visibleAttentionRows.map(({ student, calculated, attendance, severity, riskColor, forecast }) => {
      return [student.name, calculated.periods.p3 == null ? 'Missing' : `${calculated.periods.p3.toFixed(1)}%`, calculated.components.mg == null ? 'Missing' : `${calculated.components.mg.toFixed(1)}%`, calculated.finalGrade == null ? 'Incomplete' : `${calculated.finalGrade.toFixed(1)}%`, attendance == null ? 'No sessions' : `${attendance.toFixed(0)}%`, <Badge color={riskColor ?? '#64748B'}>{`${severity[0].toUpperCase()}${severity.slice(1)} Risk`}</Badge>, forecast?.riskProbability == null ? 'Unavailable' : `${(forecast.riskProbability * 100).toFixed(1)}%`, calculated.remarks === 'failing' ? 'Below SWUNEXT passing rule' : attendance != null && attendance < 80 ? 'Attendance pattern' : 'Missing assessments'];
      })} columnFlex={[1.1, 0.3, 0.3, 0.3, 0.45, 0.5, 0.2, 1.7]} />
      {attentionPageCount > 1 ? <View style={styles.pagination}><Button label="Previous" variant="secondary" disabled={visibleAttentionPage === 0} onPress={() => setAttentionPage(visibleAttentionPage - 1)} /><Text style={styles.paginationText}>Showing {visibleAttentionPage * attentionPageSize + 1}–{Math.min((visibleAttentionPage + 1) * attentionPageSize, atRisk.length)} of {atRisk.length} students</Text><Button label="Next" variant="secondary" disabled={visibleAttentionPage >= attentionPageCount - 1} onPress={() => setAttentionPage(visibleAttentionPage + 1)} /></View> : null}
      </> : <PageState kind="empty" title="No current alerts" message="Students will appear here when scores, missing work, attendance, or AI indicators require attention." />}</Card>
      </View> : null}
    </View>
  </>;
}

function Classes(props: StateProps) {
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const [reqOpen, setReqOpen] = useState(false);
  const [subject, setSubject] = useState('');
  const [term, setTerm] = useState('');
  const [section, setSection] = useState('');
  const [classRationale, setClassRationale] = useState('');
  const [requests, setRequests] = useState<SubjectRequest[]>([]);
  const [loadingReqs, setLoadingReqs] = useState(false);
  const [classRequests, setClassRequests] = useState<FacultyClassRequest[]>([]);

  // Subject Request Form
  const [reqCode, setReqCode] = useState('');
  const [reqTitle, setReqTitle] = useState('');
  const [reqLectureUnits, setReqLectureUnits] = useState(3);
  const [reqLaboratoryUnits, setReqLaboratoryUnits] = useState(0);
  const [reqRationale, setReqRationale] = useState('');

  const loadRequests = useCallback(async () => {
    setLoadingReqs(true);
    try {
      const [subjectData, classData] = await Promise.all([loadMySubjectRequests(), loadMyClassRequests()]);
      setRequests(subjectData);
      setClassRequests(classData);
    } catch {
      // Non-blocking
    } finally {
      setLoadingReqs(false);
    }
  }, []);

  useEffect(() => {
    void loadRequests();
  }, [loadRequests]);
  useEffect(() => {
    if (!subject && props.references.subjects[0]) setSubject(props.references.subjects[0].id);
    if (!term && props.references.terms[0]) setTerm(props.references.terms[0].id);
  }, [props.references.subjects, props.references.terms, subject, term]);

  const submit = async () => {
    if (!subject || !term || !section.trim() || classRationale.trim().length < 10) {
      return props.toast.show('Subject, term, section, and a rationale of at least 10 characters are required.');
    }
    setSaving(true);
    try {
      await submitFacultyClassRequest({ subjectId: subject, termId: term, section, rationale: classRationale });
      setOpen(false);
      setSubject('');
      setTerm('');
      setSection('');
      setClassRationale('');
      props.toast.show('Class request submitted to your Academic Admin. The class will appear after it is approved and assigned.');
      await loadRequests();
    } catch (cause) {
      props.toast.show(getErrorMessage(cause, 'Class request failed.'));
    } finally {
      setSaving(false);
    }
  };

  const submitRequest = async () => {
    if (!reqCode.trim() || !reqTitle.trim() || reqLectureUnits + reqLaboratoryUnits < 1 || reqRationale.trim().length < 10) {
      return props.toast.show('Enter a code, title, valid lecture and laboratory units (at least 1 total), and a rationale of at least 10 characters.');
    }
    setSaving(true);
    try {
      await submitSubjectRequest({
        code: reqCode.trim(),
        title: reqTitle.trim(),
        lectureUnits: reqLectureUnits,
        laboratoryUnits: reqLaboratoryUnits,
        rationale: reqRationale.trim(),
      });
      setReqOpen(false);
      setReqCode('');
      setReqTitle('');
      setReqLectureUnits(3);
      setReqLaboratoryUnits(0);
      setReqRationale('');
      props.toast.show('Subject request submitted to your Academic Admin for review.');
      await loadRequests();
    } catch (cause) {
      props.toast.show(getErrorMessage(cause, 'Subject request failed.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Heading
        title="My Classes"
        subtitle="View classes assigned to you and request additional classes from your Academic Admin."
        action={
          <View style={styles.actions}>
            <Button label="Request Subject" variant="secondary" onPress={() => setReqOpen(true)} />
            <Button label="Request Class" onPress={() => setOpen(true)} />
          </View>
        }
      />

      {props.classes.length ? (
          <DataTable
            columns={['Subject', 'Title', 'Section', 'Term', 'Lecture units', 'Laboratory units', 'Students', 'Status']}
            rows={props.classes.map((item) => [
              item.code,
              item.title,
              item.section,
              item.term,
              String(item.lectureUnits),
              String(item.laboratoryUnits),
              String(item.studentCount),
              'Active',
            ])}
            columnFlex={[0.5, 2.4, 0, 0.5, 0, 0, 0.4, 0]}
            widthMode="container"
          />
        ) : (
          <PageState
            kind="empty"
            title="No assigned classes"
            message="Classes assigned to you by your Academic Admin will appear here. Submit a request to get started."
            action={<Button label="Request Class" onPress={() => setOpen(true)} />}
          />
        )}

      {classRequests.length ? (
        <Card>
          <Text style={styles.cardTitle}>My Class Requests</Text>
          <DataTable columns={['Subject', 'Section', 'Term', 'Lecture / lab units', 'Status', 'Submitted', 'Review note']} columnWidths={[220, 110, 110, 130, 90, 90, 180]} columnFlex={[0, 0, 0, 0, 0, 0, 1]} widthMode="container" rows={classRequests.map((request) => [
            request.subject,
            request.section,
            request.term,
            `${request.lectureUnits} / ${request.laboratoryUnits}`,
            <Badge key={`class-request-${request.id}`} tone={request.status === 'approved' ? 'success' : request.status === 'rejected' ? 'danger' : 'warning'}>{request.status.charAt(0).toUpperCase() + request.status.slice(1)}</Badge>,
            new Date(request.createdAt).toLocaleDateString(),
            request.reviewNote ?? '—',
          ])} />
        </Card>
      ) : null}

      {requests.length ? (
        <Card>
          <Text style={styles.cardTitle}>My Subject Requests</Text>
          <DataTable
            columns={['Code', 'Title', 'Lecture units', 'Laboratory units', 'Status', 'Submitted', 'Review note']}
            columnWidths={[80, 300, 100, 100, 90, 140, 180]}
            columnFlex={[0, 0, 0, 0, 0, 0, 1]}
            widthMode="container"
            rows={requests.map((req) => [
              req.code,
              req.title,
              String(req.lectureUnits),
              String(req.laboratoryUnits),
              <Badge
                key={`req-${req.id}`}
                tone={req.status === 'approved' ? 'success' : req.status === 'rejected' ? 'danger' : 'warning'}
              >
                {req.status.charAt(0).toUpperCase() + req.status.slice(1)}
              </Badge>,
              new Date(req.createdAt).toLocaleDateString(),
              req.reviewNote || '—',
            ])}
          />
        </Card>
      ) : null}

      <Dialog visible={open} title="Request a Class" onClose={() => setOpen(false)}>
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
            {subject ? <Text style={styles.help}>Lecture {props.references.subjects.find((item) => item.id === subject)?.lecture_units ?? 3} · Laboratory {props.references.subjects.find((item) => item.id === subject)?.laboratory_units ?? 0} units (set on the subject)</Text> : null}
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
            <Field label="Rationale (10–2000 characters)" value={classRationale} onChangeText={setClassRationale} multiline numberOfLines={3} maxLength={2000} placeholder="Explain what the class is for..." />
            <Text style={styles.help}>An Academic Admin will create the class and assign at least one faculty member before it appears in your class list.</Text>
            <Button label="Submit Class Request" loading={saving} disabled={!subject || !term || !section.trim() || classRationale.trim().length < 10} onPress={() => void submit()} />
          </>
        )}
      </Dialog>

      <Dialog visible={reqOpen} title="Request New Subject" onClose={() => setReqOpen(false)}>
        <Field label="Subject Code" value={reqCode} onChangeText={setReqCode} placeholder="e.g. IT311" />
        <Field label="Subject Title" value={reqTitle} onChangeText={setReqTitle} placeholder="e.g. Advanced Web Development" />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16 }}>
          <View style={{ flex: 1, flexBasis: 240, minWidth: 200 }}><RangeSlider label="Lecture units" value={reqLectureUnits} onChange={setReqLectureUnits} /></View>
          <View style={{ flex: 1, flexBasis: 240, minWidth: 200 }}><RangeSlider label="Laboratory units" value={reqLaboratoryUnits} onChange={setReqLaboratoryUnits} /></View>
        </View>
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
          disabled={!reqCode.trim() || !reqTitle.trim() || reqLectureUnits + reqLaboratoryUnits < 1 || reqRationale.trim().length < 10}
          onPress={() => void submitRequest()}
        />
      </Dialog>
    </>
  );
}

function Students(props: StateProps) {
  const validateStudentId = useStudentIdValidation();
  const { enabled: tablePaginationEnabled } = useTablePaginationPreference();
  const [query, setQuery] = useState('');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [open, setOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [csvOpen, setCsvOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [programId, setProgramId] = useState(props.references.programs[0]?.id ?? '');
  const yearLevels = useYearLevels(programId);
  const [form, setForm] = useState<StudentFormState>(emptyStudentForm);
  const studentIdError = validateStudentId && form.institutionalId.trim() && !isValidStudentId(form.institutionalId) ? 'Use a 12-digit number or 05-XXXX-XXXXXX.' : undefined;
  const [editingStudent, setEditingStudent] = useState<RosterStudent | null>(null);
  const [selectedEnrollmentIds, setSelectedEnrollmentIds] = useState<string[]>([]);
  const [deleteSelectedOpen, setDeleteSelectedOpen] = useState(false);
  const [aiPromptOpen, setAiPromptOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [selectedPageSize, setSelectedPageSize] = useState(10);
  const [rosterFile, setRosterFile] = useState<{ name: string; kind: 'csv' | 'excel'; text?: string; data?: ArrayBuffer } | null>(null);
  const preview = useMemo(() => {
    if (!rosterFile) return [];
    try { return rosterFile.kind === 'excel' ? previewRosterExcel(rosterFile.data!) : previewRosterCsv(rosterFile.text ?? ''); }
    catch (cause) { return [{ rowNumber: 0, raw: {}, errors: [getErrorMessage(cause, 'Unable to read this file.')], duplicate: false, value: undefined }]; }
  }, [rosterFile]);

  const filtered = useMemo(() => {
    const normalizedQuery = query.toLowerCase();
    const direction = sortOrder === 'asc' ? 1 : -1;
    const lastName = (student: RosterStudent) => {
      const parts = student.name.trim().split(/\s+/);
      return (parts[parts.length - 1] ?? '').toLowerCase();
    };
    return props.workspace.students
      .filter((student) => student.name.toLowerCase().includes(normalizedQuery) || normalizeStudentId(student.institutionalId).includes(normalizeStudentId(query)))
      .sort((left, right) => {
        const lastNameCompare = lastName(left).localeCompare(lastName(right));
        if (lastNameCompare !== 0) return lastNameCompare * direction;
        return left.name.localeCompare(right.name) * direction;
      });
  }, [props.workspace.students, query, sortOrder]);
  const pageSize = tablePaginationEnabled ? selectedPageSize : Math.max(1, filtered.length);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageStudents = filtered.slice((page - 1) * pageSize, page * pageSize);
  useEffect(() => { setPage(1); }, [query, sortOrder, props.selectedClassId, props.workspace.students.length, tablePaginationEnabled]);
  useEffect(() => { setSelectedEnrollmentIds([]); }, [props.selectedClassId]);

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
    if (validateStudentId && !isValidStudentId(form.institutionalId)) return;
    setSaving(true);
    try {
      await addStudentToClass({ classId: props.selectedClassId, programId, ...form, yearLevel: Number(form.yearLevel) });
      setOpen(false);
      resetForm();
      props.toast.show('Student added to the selected class roster.');
      props.refresh();
    } catch (cause) {
      props.toast.show(getErrorMessage(cause, 'Student could not be added.'));
    } finally {
      setSaving(false);
    }
  };

  const saveEdit = async () => {
    if (!editingStudent) return;
    if (validateStudentId && !isValidStudentId(form.institutionalId)) return;
    setSaving(true);
    try {
      await updateStudentDetails(editingStudent.studentId, { programId, ...form, yearLevel: Number(form.yearLevel) });
      setEditOpen(false);
      resetForm();
      props.toast.show('Student details updated.');
      props.refresh();
    } catch (cause) {
      props.toast.show(getErrorMessage(cause, 'Student details could not be updated.'));
    } finally {
      setSaving(false);
    }
  };

  const toggleStudentSelection = (enrollmentId: string) => setSelectedEnrollmentIds((current) => current.includes(enrollmentId) ? current.filter((id) => id !== enrollmentId) : [...current, enrollmentId]);
  const pageSelectionState = pageStudents.length && pageStudents.every((student) => selectedEnrollmentIds.includes(student.enrollmentId))
    ? 'all'
    : pageStudents.some((student) => selectedEnrollmentIds.includes(student.enrollmentId)) ? 'some' : 'none';
  const selectVisibleStudents = () => setSelectedEnrollmentIds((current) => {
    const visibleIds = pageStudents.map((student) => student.enrollmentId);
    return visibleIds.every((id) => current.includes(id)) ? current.filter((id) => !visibleIds.includes(id)) : Array.from(new Set([...current, ...visibleIds]));
  });
  const selectAllFilteredStudents = () => setSelectedEnrollmentIds((current) => Array.from(new Set([...current, ...filtered.map((student) => student.enrollmentId)])));
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
      props.toast.show(getErrorMessage(cause, 'Selected students could not be removed.'));
    } finally { setSaving(false); }
  };

  const downloadRosterTemplate = async () => {
    const templateContent = 'institutional_id,first_name,last_name,email,year_level,section\n2024-0001,Juan,Dela Cruz,juan.delacruz@phinmaed.com,3,BSIT-3A\n2024-0002,Maria,Santos,maria.santos@phinmaed.com,3,BSIT-3A';
    if (Platform.OS === 'web') {
      const XLSX = await import('xlsx-js-style');
      const workbook = XLSX.utils.book_new();
      const worksheet = XLSX.utils.aoa_to_sheet([
        ['institutional_id', 'first_name', 'last_name', 'email', 'year_level', 'section'],
        [52324123456, 'Juan', 'Dela Cruz', 'juan.delacruz@phinmaed.com', 3, 'BSIT-3A'],
        [52324123457, 'Maria', 'Santos', 'maria.santos@phinmaed.com', 3, 'BSIT-3A'],
      ]);
      const institutionalIdFormat = '00-0000-000000';
      worksheet.A2.z = institutionalIdFormat;
      worksheet.A3.z = institutionalIdFormat;
      for (let row = 4; row <= 1001; row += 1) {
        worksheet[`A${row}`] = { t: 's', v: '', z: institutionalIdFormat };
      }
      worksheet['!ref'] = 'A1:F1001';
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
      props.toast.show(getErrorMessage(cause, 'Roster import failed.'));
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
            {/* <Button label="Download Excel template" variant="ghost" onPress={() => void downloadRosterTemplate()} /> */}
            <Button label="Import roster" variant="secondary" onPress={() => setCsvOpen(true)} />
              {selectedEnrollmentIds.length ? <Button label={selectedEnrollmentIds.length ? `Remove selected (${selectedEnrollmentIds.length})` : ""} variant="danger" disabled={!selectedEnrollmentIds.length} onPress={() => setDeleteSelectedOpen(true)} /> : null }
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
      <View style={styles.rosterSelectionBar}>
        <Text style={styles.rosterSelectionCount}>{selectedEnrollmentIds.length} selected</Text>
        <View style={styles.rosterSelectionActions}>
          <Button label={`Select all${filtered.length ? ` (${filtered.length})` : ''}`} variant="ghost" disabled={!filtered.length || filtered.every((student) => selectedEnrollmentIds.includes(student.enrollmentId))} onPress={selectAllFilteredStudents} />
          <Button label="Clear all" variant="ghost" disabled={!selectedEnrollmentIds.length} onPress={() => setSelectedEnrollmentIds([])} />
        </View>
      </View>
      {filtered.length ? (
          <>
          <DataTable
            columns={['Select', 'Student ID', 'Name', 'Email', 'Program', 'Year', 'Status', 'Edit']}
            rows={pageStudents.map((student) => [
              <Pressable key={`select-${student.enrollmentId}`} accessibilityRole="checkbox" accessibilityState={{ checked: selectedEnrollmentIds.includes(student.enrollmentId) }} accessibilityLabel={`Select ${student.name}`} onPress={() => toggleStudentSelection(student.enrollmentId)} style={[styles.rosterCheckbox, selectedEnrollmentIds.includes(student.enrollmentId) && styles.rosterCheckboxSelected]}><Text style={styles.rosterCheckboxMark}>{selectedEnrollmentIds.includes(student.enrollmentId) ? '✓' : ''}</Text></Pressable>,
              student.institutionalId,
              student.name,
              student.email,
              student.program,
              String(student.yearLevel),
              'Active',
              <Button key={`edit-${student.enrollmentId}`} label="Edit" variant="secondary" onPress={() => openEdit(student)} />,
            ])}
            columnWidths={[46, 145, 190, 250, 112, 80, 96, 104]}
            columnFlex={[0, 0, 1.2, 1.8, 0, 0, 0, 0]}
            columnHeaderContent={[
              <Pressable accessibilityRole="checkbox" accessibilityLabel="Select all students on this page" accessibilityState={{ checked: pageSelectionState === 'all' }} accessibilityHint={pageSelectionState === 'some' ? 'Some students on this page are selected.' : undefined} onPress={selectVisibleStudents} style={[styles.rosterCheckbox, pageSelectionState === 'all' && styles.rosterCheckboxSelected]}>
                <Text style={styles.rosterCheckboxMark}>{pageSelectionState === 'all' ? '✓' : pageSelectionState === 'some' ? '−' : ''}</Text>
              </Pressable>,
            ]}
            paginationEnabled={false}
            widthMode="container"
          />
          {tablePaginationEnabled && filtered.length ? <View style={styles.pagination}><Button label="Previous" variant="secondary" disabled={page <= 1} onPress={() => setPage((current) => Math.max(1, current - 1))} /><Text style={styles.paginationText}>Page {page} of {pageCount} · {filtered.length} students</Text><TablePageSizeSelect value={selectedPageSize} onChange={(value) => { setSelectedPageSize(value); setPage(1); }} /><Button label="Next" variant="secondary" disabled={page >= pageCount} onPress={() => setPage((current) => Math.min(pageCount, current + 1))} /></View> : null}
          </>
        ) : (
          <PageState kind="empty" title="No students in this class" message="Use Add student or Import roster to populate the selected class roster." />
        )}
      <Dialog visible={open} title="Add student to class" onClose={() => { setOpen(false); resetForm(); }}>
        <SelectField label="Program" value={programId} options={props.references.programs.map((item) => ({ label: `${item.code} · ${item.name}`, value: item.id }))} onChange={setProgramId} />
        <View style={styles.formGrid}>
          <Field label="Student ID" value={form.institutionalId} error={studentIdError} onChangeText={(value) => setForm({ ...form, institutionalId: value })} />
          <Field label="Email" value={form.email} onChangeText={(value) => setForm({ ...form, email: value })} />
          <Field label="First name" value={form.firstName} onChangeText={(value) => setForm({ ...form, firstName: value })} />
          <Field label="Last name" value={form.lastName} onChangeText={(value) => setForm({ ...form, lastName: value })} />
          <SelectField label="Year level" value={form.yearLevel} options={yearLevels.map((item) => ({ label: item.label, value: String(item.level) }))} onChange={(value) => setForm({ ...form, yearLevel: value })} />
          <Field label="Section" value={form.section} onChangeText={(value) => setForm({ ...form, section: value })} />
        </View>
        <Button label="Add to roster" loading={saving} disabled={Boolean(studentIdError)} onPress={() => void add()} />
      </Dialog>
      <Dialog visible={editOpen} title="Edit student details" onClose={() => { setEditOpen(false); resetForm(); }}>
        <SelectField label="Program" value={programId} options={props.references.programs.map((item) => ({ label: `${item.code} · ${item.name}`, value: item.id }))} onChange={setProgramId} />
        <View style={styles.formGrid}>
          <Field label="Student ID" value={form.institutionalId} error={studentIdError} onChangeText={(value) => setForm({ ...form, institutionalId: value })} />
          <Field label="Email" value={form.email} onChangeText={(value) => setForm({ ...form, email: value })} />
          <Field label="First name" value={form.firstName} onChangeText={(value) => setForm({ ...form, firstName: value })} />
          <Field label="Last name" value={form.lastName} onChangeText={(value) => setForm({ ...form, lastName: value })} />
          <SelectField label="Year level" value={form.yearLevel} options={yearLevels.map((item) => ({ label: item.label, value: String(item.level) }))} onChange={(value) => setForm({ ...form, yearLevel: value })} />
          <Field label="Section" value={form.section} onChangeText={(value) => setForm({ ...form, section: value })} />
        </View>
        <Button label="Save student details" loading={saving} disabled={Boolean(studentIdError)} onPress={() => void saveEdit()} />
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
                formatStudentId(row.raw.institutional_id ?? '—'),
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

export function assessmentOptionLabel(assessment: FacultyAssessment, system: any) {
  const typeName = componentLabel(assessment.component, assessment.gradingTypeId, system);
  const group = assessmentGroupLabel(assessment, system.groups ?? []);
  const period = assessmentPeriodLabel(assessment, system.periods ?? []);
  return [assessment.title, typeName, group, period || null, `${assessment.maximumScore} max`].filter(Boolean).join(' · ');
}

export function assessmentHelp(component: SwunextAssessmentComponent) {
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

export function validateScore(value: string, maximum: number) {
  if (!value.trim()) return undefined;
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) return 'Enter a valid non-negative score.';
  const score = Number(value);
  if (!Number.isFinite(score)) return 'Enter a valid score.';
  if (score > maximum) return `Score must be no more than ${maximum}.`;
  return undefined;
}

export function AssessmentDialog({ visible, title, form, saving, onChange, onClose, onSubmit, submitLabel, gradingSystem, gradingTypes, periods, groups }: { visible: boolean; title: string; form: AssessmentFormState; saving: boolean; onChange: (value: AssessmentFormState) => void; onClose: () => void; onSubmit: () => void | Promise<void>; submitLabel: string; gradingSystem: any; gradingTypes: { id: string; name: string }[]; periods: { id: string; name: string }[]; groups: { id: string; name: string }[] }) {
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
  const { user } = useAuth(); const [sessionId, setSessionId] = useState(props.workspace.attendanceSessions[0]?.id ?? ''); const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc'); const [studentQuery, setStudentQuery] = useState(''); const [selectedAttendanceIds, setSelectedAttendanceIds] = useState<string[]>([]); const [statuses, setStatuses] = useState<Record<string, 'present' | 'absent' | 'late' | 'excused'>>({}); const [open, setOpen] = useState(false); const [date, setDate] = useState(new Date().toISOString().slice(0, 10)); const [label, setLabel] = useState('Class session'); const [saving, setSaving] = useState(false); const [page, setPage] = useState(1); const [pageSize, setPageSize] = useState(10);
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
  const filteredStudents = useMemo(() => {
    const query = studentQuery.trim().toLocaleLowerCase();
    if (!query) return sortedStudents;
    return sortedStudents.filter((student) => student.name.toLocaleLowerCase().includes(query) || student.institutionalId.toLocaleLowerCase().includes(query));
  }, [sortedStudents, studentQuery]);
  const pageCount = Math.max(1, Math.ceil(filteredStudents.length / pageSize));
  const pageStudents = filteredStudents.slice((page - 1) * pageSize, page * pageSize);
  useEffect(() => { setPage(1); setSelectedAttendanceIds([]); }, [sessionId, sortOrder, props.selectedClassId, props.workspace.students.length]);
  useEffect(() => { setPage(1); }, [studentQuery]);
  const pageIsSelected = pageStudents.length > 0 && pageStudents.every((student) => selectedAttendanceIds.includes(student.enrollmentId));
  const toggleAttendancePage = () => setSelectedAttendanceIds((current) => pageIsSelected
    ? current.filter((id) => !pageStudents.some((student) => student.enrollmentId === id))
    : [...new Set([...current, ...pageStudents.map((student) => student.enrollmentId)])]);
  const toggleAttendanceStudent = (id: string) => setSelectedAttendanceIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const markAll = (status: 'present' | 'absent') => {
    const targetIds = selectedAttendanceIds.length ? selectedAttendanceIds : sortedStudents.map((student) => student.enrollmentId);
    setStatuses((current) => ({ ...current, ...Object.fromEntries(targetIds.map((id) => [id, status])) }));
  };
  const create = async () => { if (!user || !props.selectedClassId) return; setSaving(true); try { const id = await createAttendanceSession(props.selectedClassId, user.id, date, label); setSessionId(id); setOpen(false); props.toast.show('Attendance session created.'); props.refresh(); } catch (cause) { props.toast.show(getErrorMessage(cause, 'Session creation failed.')); } finally { setSaving(false); } };
  const save = async () => { if (!user || !sessionId) return; const rows = sortedStudents.map((student) => ({ enrollmentId: student.enrollmentId, status: statuses[student.enrollmentId] ?? props.workspace.attendance[`${sessionId}:${student.enrollmentId}`] ?? 'present' as const })); setSaving(true); try { await saveAttendance(user.id, sessionId, rows); props.toast.show('Attendance saved.'); props.refresh(); } catch (cause) { props.toast.show(getErrorMessage(cause, 'Could not save attendance. Try again.')); } finally { setSaving(false); } };
  return <>
    <Heading title="Attendance" subtitle="Create a dated session, batch mark the roster, and save authorized attendance records." action={<Button label="Create session" onPress={() => setOpen(true)} />} /><View style={styles.filterRow}><SelectField label="Class" value={props.selectedClassId} options={props.classes.map((item) => ({ label: `${item.code} · ${item.section}`, value: item.id }))} onChange={props.setSelectedClassId} containerStyle={{ flex: 1.1, minWidth: 180, maxWidth: 460 }} /><SelectField label="Attendance session" value={sessionId} options={props.workspace.attendanceSessions.map((item) => ({ label: `${item.date} · ${item.label}`, value: item.id }))} onChange={(value) => { setSessionId(value); setStatuses({}); }} searchable containerStyle={{ flex: 1, minWidth: 180 }} /><SelectField label="Sort by last name" value={sortOrder} options={[{ label: 'A to Z', value: 'asc' }, { label: 'Z to A', value: 'desc' }]} onChange={(value) => setSortOrder(value as 'asc' | 'desc')} containerStyle={{ flex: 0.8, minWidth: 160 }} /></View>
    <Card>{sessionId ? <>
      <View style={styles.attendanceToolbar}>
        <View style={styles.flex}><Text style={styles.cardTitle}>Mark attendance</Text><Text style={styles.help}>Everyone defaults to Present. Mark exceptions, then save once.</Text></View>
        <View style={styles.actions}>
          <Button label={selectedAttendanceIds.length ? 'Selected present' : 'All present'} variant="secondary" onPress={() => markAll('present')} />
          <Button label={selectedAttendanceIds.length ? 'Selected absent' : 'All absent'} variant="danger" onPress={() => markAll('absent')} />
        </View>
      </View>
      <SearchFilter value={studentQuery} onChange={setStudentQuery} placeholder="Search students by name or ID" containerStyle={{ maxWidth: '100%', height: 44, paddingVertical: 8, paddingHorizontal: 12 }} />
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 6 }}>
        <Pressable accessibilityRole="checkbox" accessibilityLabel="Select students on this page" accessibilityState={{ checked: pageIsSelected }} onPress={toggleAttendancePage} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={[styles.rosterCheckbox, pageIsSelected && styles.rosterCheckboxSelected]}><Text style={styles.rosterCheckboxMark}>{pageIsSelected ? '✓' : selectedAttendanceIds.some((id) => pageStudents.some((student) => student.enrollmentId === id)) ? '−' : ''}</Text></View>
          <Text style={styles.help}>Select page</Text>
        </Pressable>
        {selectedAttendanceIds.length ? <Text style={styles.help}>{selectedAttendanceIds.length} selected</Text> : null}
      </View>
      {pageStudents.map((student) => <View key={student.enrollmentId} style={styles.attendanceRow}>
        <Pressable accessibilityRole="checkbox" accessibilityLabel={`Select ${student.name}`} accessibilityState={{ checked: selectedAttendanceIds.includes(student.enrollmentId) }} onPress={() => toggleAttendanceStudent(student.enrollmentId)} style={[styles.rosterCheckbox, selectedAttendanceIds.includes(student.enrollmentId) && styles.rosterCheckboxSelected]}><Text style={styles.rosterCheckboxMark}>{selectedAttendanceIds.includes(student.enrollmentId) ? '✓' : ''}</Text></Pressable>
        <View style={styles.flex}><Text style={styles.rowTitle}>{student.name}</Text><Text style={styles.help}>{formatStudentId(student.institutionalId)}</Text></View>
        <SelectField label="Status" hideLabel value={statuses[student.enrollmentId] ?? props.workspace.attendance[`${sessionId}:${student.enrollmentId}`] ?? 'present'} options={['present', 'absent', 'late', 'excused'].map((value) => ({ label: value[0].toUpperCase() + value.slice(1), value }))} onChange={(value) => setStatuses((current) => ({ ...current, [student.enrollmentId]: value as typeof statuses[string] }))} containerStyle={styles.attendanceStatusField} />
      </View>)}
      {!pageStudents.length ? <Text style={styles.help}>No students match “{studentQuery}”.</Text> : null}
      {filteredStudents.length > 0 ? <View style={styles.pagination}><Button label="Previous" variant="secondary" disabled={page <= 1} onPress={() => setPage((current) => Math.max(1, current - 1))} /><View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}><Text style={styles.paginationText}>Page {page} of {pageCount} · {filteredStudents.length} students</Text><TablePageSizeSelect value={pageSize} onChange={(value) => { setPageSize(value); setPage(1); }} /></View><Button label="Next" variant="secondary" disabled={page >= pageCount} onPress={() => setPage((current) => Math.min(pageCount, current + 1))} /></View> : null}
      <View style={{ marginTop: 12 }}><Button label="Save attendance" loading={saving} onPress={() => void save()} /></View>
    </> : <PageState kind="empty" title="No attendance session" message="Create a session to begin roll call." />}</Card>
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
      .catch((cause) => current && props.toast.show(getErrorMessage(cause, 'Could not load saved evaluation criteria.')));
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
      props.toast.show(getErrorMessage(cause, 'Could not apply your evaluation criteria.'));
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
      props.toast.show(getErrorMessage(cause, 'Could not delete private evaluation criteria.'));
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

function Risk(props: StateProps) {
  const [selected, setSelected] = useState<RosterStudent | null>(null);
  const [query, setQuery] = useState('');
  const [riskFilter, setRiskFilter] = useState('attention');
  const [trendFilter, setTrendFilter] = useState<'all' | 'declining' | 'stable' | 'improving'>('all');
  const [concernFilter, setConcernFilter] = useState('all');
  const [showPredictionMetadata, setShowPredictionMetadata] = useState(false);
  const [gradeColumnView, setGradeColumnView] = useState<'summary' | 'recorded'>('summary');
  const gradingDefinition = props.workspace.criteria?.gradingSystemDefinition ?? props.workspace.defaultGradingSystem ?? IT_GLOBAL_GRADING_SYSTEM;
  const evaluationDefinition = props.workspace.evaluationSystem ?? DEFAULT_EVALUATION_SYSTEM;
  useEffect(() => { setRiskFilter('attention'); setGradeColumnView('summary'); setShowPredictionMetadata(false); }, [props.selectedClassId, evaluationDefinition.id]);
  const gradingPeriods = [...(gradingDefinition.periods ?? [])].sort((left: any, right: any) => (left.sequence ?? 0) - (right.sequence ?? 0));
  const gradingComponents = [...(gradingDefinition.components ?? [])];
  const gradingGroups = [...(gradingDefinition.groups ?? [])];
  const assessmentColumns = buildRecordedAssessmentColumns(props.workspace.assessments.map((assessment) => ({
    ...assessment,
    categorical: Boolean(valueMappingForType(gradingDefinition, assessment.gradingTypeId ?? assessment.component)),
  })));
  const run = props.onRunAiPredictions;
  const studentRows = useMemo(() => props.workspace.students.map((student) => {
    const summary = summarizeEnrollmentStanding(props.workspace, student.enrollmentId);
    const context = evaluationContextForStudent(props.workspace, student.enrollmentId);
    const current = context.calculated.finalGrade;
    const attendance = attendanceRate(props.workspace, student.enrollmentId);
    const evaluation = props.workspace.evaluations[student.enrollmentId];
    const risk = context.result.severity;
    const missing = missingAssessments(props.workspace, student.enrollmentId);
    const level = context.definition.levels.find((item) => item.id === context.result.matchedLevelId);
    const factorById = new Map(context.definition.factors.map((factor) => [factor.id, factor]));
    const matchedFactors = context.result.matchedRuleIds.flatMap((ruleId) => {
      const index = Number(ruleId.slice(ruleId.lastIndexOf(':') + 1));
      const factor = level ? factorById.get(level.rules[index]?.factorId) : undefined;
      return factor ? [factor] : [];
    });
    const concernKey = matchedFactors[0]?.id ?? 'none';
    const concernFactorIds = [...new Set(matchedFactors.map((factor) => factor.id))];
    const concern = evaluationRuleReasons(context.definition, context.result);
    const trend = String(context.values.recent_trend ?? evaluation?.trend ?? 'unknown');
    const decline = current != null && evaluation?.predictedStanding != null ? current - evaluation.predictedStanding : null;
    return { student, summary, current, calculated: context.calculated, assessmentScores: props.workspace.assessments.map((assessment) => storedAssessmentValue(props.workspace, student.enrollmentId, assessment.id)), predicted: evaluation?.predictedStanding ?? null, riskProbability: evaluation?.riskProbability ?? null, predictionGeneratedAt: evaluation?.predictionGeneratedAt ?? null, dataBasis: evaluation?.dataBasis ?? null, modelProvider: evaluation?.modelProvider ?? null, modelName: evaluation?.modelName ?? null, modelVersion: evaluation?.modelVersion ?? null, attendance, risk, riskValue: evaluationRiskValue(context.definition, context.result), levelId: level?.id ?? null, levelName: level?.name ?? (risk === 'unavailable' ? 'Unavailable' : 'No matching level'), levelColor: level?.color, missing, trend, concernKey, concernFactorIds, concern, decline };
  }), [props.workspace]);
  const riskLevelBadge = (row: (typeof studentRows)[number]) => <Badge color={row.risk === 'unavailable' ? '#64748B' : row.levelColor ?? '#64748B'}>{row.levelName}</Badge>;
  const attentionCount = studentRows.filter((row) => row.risk === 'medium' || row.risk === 'high').length;
  const highCount = studentRows.filter((row) => row.risk === 'high').length;
  const mediumCount = studentRows.filter((row) => row.risk === 'medium').length;
  const decliningCount = studentRows.filter((row) => row.trend === 'declining').length;
  const missingCount = studentRows.filter((row) => row.missing > 0).length;
  const filteredRows = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return studentRows.filter((row) => {
      if (normalizedQuery && !row.student.name.toLowerCase().includes(normalizedQuery) && !normalizeStudentId(row.student.institutionalId).includes(normalizeStudentId(normalizedQuery))) return false;
      if (riskFilter === 'attention' && row.risk !== 'medium' && row.risk !== 'high') return false;
      if (riskFilter === 'severity:high' && row.risk !== 'high') return false;
      if (riskFilter === 'severity:medium' && row.risk !== 'medium') return false;
      if (riskFilter === 'severity:low' && row.risk !== 'low') return false;
      if (riskFilter !== 'attention' && riskFilter !== 'all' && !riskFilter.startsWith('severity:') && row.riskValue !== riskFilter) return false;
      if (trendFilter !== 'all' && row.trend !== trendFilter) return false;
      if (concernFilter !== 'all' && !row.concernFactorIds.includes(concernFilter)) return false;
      return true;
    }).sort((a, b) => {
      const riskRank = { high: 0, medium: 1, low: 2, unavailable: 3, unknown: 3 } as const;
      const riskDelta = (riskRank[a.risk as keyof typeof riskRank] ?? 3) - (riskRank[b.risk as keyof typeof riskRank] ?? 3);
      if (riskDelta) return riskDelta;
      return (b.decline ?? -1) - (a.decline ?? -1) || (a.attendance ?? 101) - (b.attendance ?? 101) || b.missing - a.missing || (a.current ?? 101) - (b.current ?? 101);
    });
  }, [concernFilter, query, riskFilter, studentRows, trendFilter]);
  const clearFilters = () => { setQuery(''); setRiskFilter('attention'); setTrendFilter('all'); setConcernFilter('all'); };
  const usedEvaluationFactorIds = new Set(evaluationDefinition.levels.flatMap((level) => level.rules.map((rule) => rule.factorId)));
  const concernOptions = [{ label: 'All evaluation factors', value: 'all' }, ...evaluationDefinition.factors.filter((factor) => usedEvaluationFactorIds.has(factor.id)).map((factor) => ({ label: factor.name, value: factor.id }))];
  const missingAssessmentFactorId = evaluationDefinition.factors.find((factor) => factor.source === 'missing_assessment_count')?.id;
  const hasPredictedStandingOutput = isForecastOutputEnabled(evaluationDefinition, 'predicted_standing');
  const supportsPredictionMetadata = evaluationDefinition.ai?.enabled === true
    && ['generated_at', 'model_version'].some((field) => isForecastOutputEnabled(evaluationDefinition, field));
  const configuredRiskOptions = evaluationRiskOptions(evaluationDefinition, 'All students');
  const recordedGradeColumns = [
    ...gradingPeriods.map((period: any) => ({ key: period.id, label: period.name, kind: 'period' as const })),
    ...gradingComponents.map((component: any) => ({ key: component.id, label: `${component.shortCode ? `${component.shortCode} ` : ''}${component.name} · component`, kind: 'component' as const })),
    ...gradingGroups.map((group: any) => ({ key: group.id, label: `${group.name} · group`, kind: 'group' as const })),
    ...assessmentColumns.map((assessment) => ({ key: assessment.key, label: `${assessment.label} · score`, kind: 'assessment' as const, maximumScore: assessment.maximumScore, categorical: assessment.categorical, assessmentIndex: assessment.assessmentIndex })),
  ];
  const recordedGradeColumnWidths = [190, ...gradingPeriods.map(() => 92), ...gradingComponents.map(() => 120), ...gradingGroups.map(() => 120), ...assessmentColumns.map(() => 150)];
  const summaryGradeColumns = gradingPeriods.map((period: any) => ({ key: period.id, label: period.name, kind: 'period' as const }));
  const visibleGradeColumns = gradeColumnView === 'recorded' ? recordedGradeColumns : summaryGradeColumns;
  const visibleGradeColumnWidths = gradeColumnView === 'recorded' ? recordedGradeColumnWidths : [190, ...gradingPeriods.map(() => 92)];
  const gradeCells = (row: (typeof studentRows)[number]) => visibleGradeColumns.map((column) => {
    if (column.kind === 'assessment') {
      return formatRecordedAssessmentScore(row.assessmentScores[column.assessmentIndex], column.maximumScore, column.categorical);
    }
    const values = column.kind === 'period' ? row.calculated.periods : column.kind === 'component' ? row.calculated.components : row.calculated.groups;
    return formatForecastAggregate(values?.[column.key]);
  });
  const riskFilterOptions = [
    { label: 'All students', value: 'all' },
    { label: 'Requires Attention', value: 'attention' },
    ...configuredRiskOptions.filter((option) => option.value.startsWith('level:')),
    { label: 'Any high-severity level', value: 'severity:high' },
    { label: 'Any medium-severity level', value: 'severity:medium' },
    { label: 'Any low-severity level', value: 'severity:low' },
    ...configuredRiskOptions.filter((option) => option.value === 'unmatched' || option.value === 'unavailable'),
  ];
  const attentionColumns = ['Student', ...visibleGradeColumns.map((column) => column.label), 'Final percentage', 'Point / letter grade', 'Risk level', 'Matched evaluation rules', ...(hasPredictedStandingOutput ? ['Predicted standing'] : []), 'AI risk probability', ...(showPredictionMetadata ? ['Prediction generated', 'AI provider', 'AI model', 'Model version'] : [])];
  const attentionTableRows = filteredRows.map((row) => [
    `${row.student.name} · ${formatStudentId(row.student.institutionalId)}`,
    ...gradeCells(row),
    row.calculated.finalGrade == null ? '—' : `${row.calculated.finalGrade.toFixed(1)}%`,
    row.calculated.pointGrade == null ? '—' : `${row.calculated.pointGrade.toFixed(2)}${row.calculated.letterGrade ? ` / ${row.calculated.letterGrade}` : ''}`,
    riskLevelBadge(row),
    row.concern,
    ...(hasPredictedStandingOutput ? [row.predicted == null ? 'Unavailable' : `${row.predicted.toFixed(1)}%`] : []),
    row.riskProbability == null ? 'Unavailable' : `${(row.riskProbability * 100).toFixed(1)}%`,
    ...(showPredictionMetadata ? [
      summarizeSavedForecast({ predictionGeneratedAt: row.predictionGeneratedAt }).generatedAt ? new Date(row.predictionGeneratedAt!).toLocaleString() : 'Not recorded',
      row.modelProvider ?? '—',
      row.modelName ?? '—',
      row.modelVersion ?? '—',
    ] : []),
  ]);
  return <>
    <Heading title="At-Risk Students" subtitle="Review criteria-based risk alongside available AI forecasts. Predictions are advisory, not official grades." action={<View style={styles.actions}>{supportsPredictionMetadata ? <Button compact label={showPredictionMetadata ? 'Hide model details' : 'Show model details'} variant="secondary" onPress={() => setShowPredictionMetadata((visible) => !visible)} /> : null}<Button label="Run AI predictions" loading={props.predictionRunning} disabled={props.predictionRunning} onPress={() => void run()} /></View>} />
    <ClassSelect {...props} />
    {props.predictionRunError ? <Card><Text style={styles.help}>{props.predictionRunError}</Text></Card> : null}
    {props.predictionRunning ? <Card><Text style={styles.help}>Saving forecasts for this class. Larger rosters may take longer.</Text></Card> : null}
    <>
      <View style={styles.attentionMetrics}>
        <Pressable style={styles.attentionMetric} onPress={() => setRiskFilter('attention')}><Text style={styles.attentionMetricValue}>{attentionCount}</Text><Text style={styles.attentionMetricLabel}>Require attention</Text></Pressable>
        <Pressable style={styles.attentionMetric} onPress={() => setRiskFilter('severity:high')}><Text style={[styles.attentionMetricValue, styles.dangerText]}>{highCount}</Text><Text style={styles.attentionMetricLabel}>High risk</Text></Pressable>
        <Pressable style={styles.attentionMetric} onPress={() => setRiskFilter('severity:medium')}><Text style={[styles.attentionMetricValue, styles.warningText]}>{mediumCount}</Text><Text style={styles.attentionMetricLabel}>Medium risk</Text></Pressable>
        <Pressable style={styles.attentionMetric} onPress={() => setTrendFilter('declining')}><Text style={styles.attentionMetricValue}>{decliningCount}</Text><Text style={styles.attentionMetricLabel}>Declining</Text></Pressable>
        <Pressable style={styles.attentionMetric} onPress={() => setConcernFilter(missingAssessmentFactorId ?? 'all')}><Text style={styles.attentionMetricValue}>{missingCount}</Text><Text style={styles.attentionMetricLabel}>Missing work</Text></Pressable>
      </View>
      <Card>
        <View style={styles.attentionToolbar}>
          <SearchFilter value={query} onChange={setQuery} placeholder="Search students..." accessibilityLabel="Search students" />
          <SelectField label="Risk" value={riskFilter} options={riskFilterOptions} onChange={setRiskFilter} containerStyle={styles.attentionFilter} />
          <SelectField label="Trend" value={trendFilter} options={[{ label: 'All Trends', value: 'all' }, { label: 'Declining', value: 'declining' }, { label: 'Stable', value: 'stable' }, { label: 'Improving', value: 'improving' }]} onChange={(value) => setTrendFilter(value as typeof trendFilter)} containerStyle={styles.attentionFilter} />
          <SelectField label="Concern" value={concernFilter} options={concernOptions} onChange={(value) => setConcernFilter(value as typeof concernFilter)} containerStyle={styles.attentionFilter} />
          <SelectField label="Grade columns" value={gradeColumnView} options={[{ label: 'Summary', value: 'summary' }, { label: 'Recorded details', value: 'recorded' }]} onChange={(value) => setGradeColumnView(value as typeof gradeColumnView)} containerStyle={styles.attentionFilter} />
        </View>
        <Text style={styles.help}>Grades use {gradingDefinition.name}; risk levels and matched rules use {evaluationDefinition.name}.</Text>
        {filteredRows.length ? (
          <DataTable columns={attentionColumns} rows={attentionTableRows} onRowPress={(tableRow) => { const match = filteredRows.find((row) => `${row.student.name} · ${formatStudentId(row.student.institutionalId)}` === String(tableRow[0])); if (match) setSelected(match.student); }} highlightCell={(tableRow, columnIndex) => columnIndex === visibleGradeColumns.length + 2 && filteredRows.find((row) => `${row.student.name} · ${formatStudentId(row.student.institutionalId)}` === String(tableRow[0]))?.calculated.remarks === 'failing'} columnWidths={[...visibleGradeColumnWidths, 104, 118, 132, 290, ...(hasPredictedStandingOutput ? [120] : []), 120, ...(showPredictionMetadata ? [175, 130, 180, 130] : [])]} />
        ) : (
          <PageState kind="empty" title={riskFilter === 'attention' && !attentionCount ? 'No students currently require attention' : 'No students match the selected filters'} message={riskFilter === 'attention' && !attentionCount ? 'Based on the applied evaluation criteria and available records, no students in this class currently meet the attention criteria.' : 'Try clearing one or more filters.'} action={<Button label={riskFilter === 'attention' && !attentionCount ? 'View all students' : 'Clear filters'} variant="secondary" onPress={() => riskFilter === 'attention' && !attentionCount ? setRiskFilter('all') : clearFilters()} />} />
        )}
        <Text style={styles.attentionCount}>{filteredRows.length} student{filteredRows.length === 1 ? '' : 's'} shown · sorted by risk and urgency</Text>
      </Card>
     </>
    <StudentDetail student={selected} workspace={props.workspace} onClose={() => setSelected(null)} />
  </>;
}

function Feedback(props: StateProps) {
  const [studentId, setStudentId] = useState(props.workspace.students[0]?.enrollmentId ?? '');
  const [selectedStudentIds, setSelectedStudentIds] = useState<string[]>(props.workspace.students[0] ? [props.workspace.students[0].enrollmentId] : []);
  const [body, setBody] = useState('');
  const [status, setStatus] = useState<'draft' | 'ready'>('draft');
  const [editingFeedbackId, setEditingFeedbackId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('Compose');
  const [studentQuery, setStudentQuery] = useState('');
  const [riskFilter, setRiskFilter] = useState('all');
  const [historyStudentFilter, setHistoryStudentFilter] = useState('all');
  const [historyRiskFilter, setHistoryRiskFilter] = useState('all');
  const [historyStatusFilter, setHistoryStatusFilter] = useState('all');
  const [historyUpdatedFrom, setHistoryUpdatedFrom] = useState('');
  const [historyUpdatedTo, setHistoryUpdatedTo] = useState('');
  const [selectedHistoryFeedbackIds, setSelectedHistoryFeedbackIds] = useState<string[]>([]);
  const [bulkFeedbackAction, setBulkFeedbackAction] = useState<'email' | null>(null);
  const [bulkFeedbackPending, setBulkFeedbackPending] = useState(false);
  const [bulkFeedbackProgress, setBulkFeedbackProgress] = useState('');
  const [bulkFeedbackFailures, setBulkFeedbackFailures] = useState<string[]>([]);
  const [stylePreset, setStylePreset] = useState('supportive');
  const [styleInstructions, setStyleInstructions] = useState('');
  const [generationProgress, setGenerationProgress] = useState('');
  const [generationFailures, setGenerationFailures] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const initializedFeedbackClass = useRef<string | null>(null);
  useEffect(() => {
    const available = props.workspace.students.map((item) => item.enrollmentId);
    if (!available.length) return;
    if (initializedFeedbackClass.current !== props.selectedClassId) {
      initializedFeedbackClass.current = props.selectedClassId;
      setSelectedStudentIds([available[0]]);
      setStudentId(available[0]);
      return;
    }
    setSelectedStudentIds((current) => current.filter((id) => available.includes(id)));
    if (!available.includes(studentId)) setStudentId(available[0] ?? '');
  }, [props.workspace.students, props.selectedClassId, studentId]);
  useEffect(() => { setBody(''); setStatus('draft'); setEditingFeedbackId(null); }, [props.selectedClassId, studentId]);
  useEffect(() => { setHistoryStudentFilter('all'); setHistoryRiskFilter('all'); setHistoryStatusFilter('all'); setHistoryUpdatedFrom(''); setHistoryUpdatedTo(''); setSelectedHistoryFeedbackIds([]); setBulkFeedbackProgress(''); setBulkFeedbackFailures([]); }, [props.selectedClassId]);
  useEffect(() => { setGenerationFailures([]); setGenerationProgress(''); }, [props.selectedClassId, props.workspace.students]);
  useEffect(() => { if (selectedStudentIds.length !== 1) setStatus('draft'); }, [selectedStudentIds.length]);
  const student = props.workspace.students.find((item) => item.enrollmentId === studentId);
  const grading = props.workspace.criteria?.gradingSystemDefinition ?? props.workspace.defaultGradingSystem ?? IT_GLOBAL_GRADING_SYSTEM;
  const evaluationContext = student ? evaluationContextForStudent(props.workspace, student.enrollmentId) : null;
  const evaluationDefinition = evaluationContext?.definition ?? props.workspace.evaluationSystem ?? DEFAULT_EVALUATION_SYSTEM;
  const studentsWithRisk = useMemo(() => props.workspace.students.map((item) => {
    const context = evaluationContextForStudent(props.workspace, item.enrollmentId);
    const level = context.definition.levels.find((candidate) => candidate.id === context.result.matchedLevelId);
    const risk = level?.id ?? context.result.severity ?? 'unavailable';
    const riskLabel = level?.name ?? (context.result.severity === 'unavailable' ? 'Unavailable' : `${context.result.severity[0].toUpperCase()}${context.result.severity.slice(1)} risk`);
    return { student: item, risk, riskLabel };
  }), [props.workspace]);
  const riskOptions = useMemo(() => [
    { label: 'All risk levels', value: 'all' },
    ...[...new Map(studentsWithRisk.map((entry) => [entry.risk, entry.riskLabel])).entries()].map(([value, label]) => ({ value, label })),
  ], [studentsWithRisk]);
  const matchingStudents = useMemo(() => {
    const query = studentQuery.trim().toLowerCase();
    const normalizedQuery = normalizeStudentId(studentQuery);
    return studentsWithRisk.filter(({ student: item, risk }) =>
      (riskFilter === 'all' || risk === riskFilter)
      && (!query || item.name.toLowerCase().includes(query) || item.email.toLowerCase().includes(query) || normalizeStudentId(item.institutionalId).includes(normalizedQuery)));
  }, [studentsWithRisk, studentQuery, riskFilter]);
  const stylePresetOptions = [
    { label: 'Warm and supportive', value: 'supportive' },
    { label: 'Encouraging and strengths-first', value: 'strengths' },
    { label: 'Concise and direct', value: 'concise' },
    { label: 'Formal and professional', value: 'formal' },
    { label: 'Empathetic and reassuring', value: 'empathetic' },
    { label: 'Motivational coaching', value: 'coaching' },
  ];
  const stylePresetInstructions: Record<string, string> = {
    supportive: 'Use a warm, supportive, and professional tone.',
    strengths: 'Lead with evidence-based strengths, then frame improvement areas constructively.',
    concise: 'Be concise and direct. Use short sentences and prioritize the most useful next steps.',
    formal: 'Use a formal, respectful academic tone with clear and precise wording.',
    empathetic: 'Write warmly and directly to the student. Acknowledge the difficulty of the situation without judgment, blame, or assumptions; recognize specific effort or strengths when the records support them; reassure the student that progress is possible; and frame next steps as manageable support rather than commands. Sound human and encouraging, not clinical or report-like. Do not offer guarantees or invent feelings.',
    coaching: 'Use a motivating coaching tone and frame practical next steps as achievable actions.',
  };
  const combinedStyleInstructions = [stylePresetInstructions[stylePreset], styleInstructions.trim()].filter(Boolean).join('\n');
  const buildRecordContext = (targetStudent = student) => {
    if (!targetStudent) return {};
    const targetEvaluationContext = evaluationContextForStudent(props.workspace, targetStudent.enrollmentId);
    const grade = targetEvaluationContext.calculated;
    const componentGrades = (grading.components ?? []).map((component: any) => ({ name: component.name, short_code: component.shortCode ?? null, percentage: grade.components[component.id] ?? null, source: component.assessmentDefinition?.typeId ?? component.calculation?.mode ?? 'calculated' }));
    const factors = targetEvaluationContext.definition.factors.map((factor) => ({ name: factor.name, source: factor.source, origin: evaluationOriginLabel(factor.origin), value: evaluationFactorValue(factor, targetEvaluationContext.values) ?? null, unit: factor.unit ?? null, weight: factor.weight ?? null, aggregation: factor.gradingAggregation ?? null }));
    const assessments = props.workspace.assessments.map((assessment) => ({ title: assessment.title, type: assessment.gradingTypeId ?? assessment.component, date: assessment.assessmentDate, raw_score: storedAssessmentValue(props.workspace, targetStudent.enrollmentId, assessment.id), maximum_score: assessment.maximumScore, mapped_percentage: assessmentPercentForWorkspace(props.workspace, targetStudent.enrollmentId, assessment) }));
    return {
      applied_grading_system: { name: grading.name, version: props.workspace.criteria?.version ?? null, definition: grading },
      applied_evaluation_criteria: { name: targetEvaluationContext.definition.name, version: targetEvaluationContext.definition.definitionVersion ?? null, definition: targetEvaluationContext.definition },
      grades: { periods: grade.periods, components: componentGrades, groups: grade.groups, raw_final_percentage: grade.rawFinal, final_percentage: grade.finalGrade, point_grade: grade.pointGrade, letter_grade: grade.letterGrade, remarks: grade.remarks, passing_percentage: grading.finalGradeConversion?.passingPercentage ?? null },
      evaluation: { risk_level: targetEvaluationContext.result.severity, matched_level: targetEvaluationContext.definition.levels.find((level) => level.id === targetEvaluationContext.result.matchedLevelId)?.name ?? null, matched_rules: evaluationRuleReasons(targetEvaluationContext.definition, targetEvaluationContext.result), factors },
      attendance_percentage: attendanceRate(props.workspace, targetStudent.enrollmentId),
      missing_assessment_results: missingAssessments(props.workspace, targetStudent.enrollmentId),
      assessments,
    };
  };
  const buildTemplateDraft = () => {
    if (!student) return;
    const grade = calculateEnrollmentGrade(props.workspace, student.enrollmentId);
    const attendance = attendanceRate(props.workspace, student.enrollmentId);
    const context = evaluationContextForStudent(props.workspace, student.enrollmentId);
    const evaluation = props.workspace.evaluations[student.enrollmentId];
    const factorLines = evaluationDefinition.factors.map((factor) => `• ${factor.name}: ${formatEvaluationFactorValue(factor, evaluationFactorValue(factor, context.values))}${factor.weight == null ? '' : ` (factor weight ${factor.weight})`}`).join('\n');
    const componentLines = (grading.components ?? []).map((component: any) => `• ${component.name}${component.shortCode ? ` (${component.shortCode})` : ''}: ${grade.components[component.id] == null ? 'not yet available' : `${grade.components[component.id]!.toFixed(2)}%`}`).join('\n');
    const level = evaluationDefinition.levels.find((item) => item.id === context.result.matchedLevelId);
    setBody([
      `Hello ${student.name},`,
      '',
      `Your current standing under ${grading.name} is ${grade.finalGrade == null ? 'not yet available' : `${grade.finalGrade.toFixed(2)}%`}${grade.pointGrade == null ? '' : ` (${grade.pointGrade.toFixed(2)}${grade.letterGrade ? ` / ${grade.letterGrade}` : ''})`}.`,
      `The configured passing percentage is ${grading.finalGradeConversion?.passingPercentage ?? 'not specified'}%. Current grading status: ${grade.remarks}.`,
      '',
      'Calculated component grades:',
      componentLines || 'No components are configured in the applied grading system.',
      '',
      `Evaluation criteria: ${evaluationDefinition.name}. Current risk level: ${level?.name ?? context.result.severity}.`,
      `Matched evaluation rules: ${evaluationRuleReasons(evaluationDefinition, context.result)}.`,
      'Evaluation factors:',
      factorLines || 'No evaluation factors are configured.',
      '',
      `Attendance: ${attendance == null ? 'not available' : `${attendance.toFixed(2)}%`}.`,
      `Missing assessment results: ${missingAssessments(props.workspace, student.enrollmentId)}.`,
      evaluation?.predictedStanding == null ? '' : `Saved advisory prediction: ${evaluation.predictedStanding.toFixed(2)}% (${evaluation.riskLevel} risk).`,
      '',
      'Suggested next step: review the results above together and agree on one practical action for the coming assessment period.',
      '',
      'This is a draft for instructor review. It is not an official SIS grade or decision.',
    ].join('\n'));
  };
  const generateWithGemini = async () => {
    const recipients = props.workspace.students.filter((item) => selectedStudentIds.includes(item.enrollmentId));
    if (!recipients.length || !props.selectedClassId) return;
    setGenerating(true);
    setGenerationFailures([]);
    try {
      if (recipients.length === 1) {
        const generated = await generateFacultyFeedbackDraft(props.selectedClassId, recipients[0].enrollmentId, buildRecordContext(recipients[0]), combinedStyleInstructions);
        setBody(generated);
        setStatus('draft');
        setEditingFeedbackId(null);
        props.toast.show('Gemini created a draft from the applied criteria and student records. Review it before saving or publishing.');
        return;
      }
      let saved = 0;
      const failures: string[] = [];
      for (let index = 0; index < recipients.length; index += 1) {
        const targetStudent = recipients[index];
        setGenerationProgress(`Generating ${index + 1} of ${recipients.length}: ${targetStudent.name}`);
        try {
          const targetContext = evaluationContextForStudent(props.workspace, targetStudent.enrollmentId);
          const generated = await generateFacultyFeedbackDraft(props.selectedClassId, targetStudent.enrollmentId, buildRecordContext(targetStudent), combinedStyleInstructions);
          await saveFacultyFeedback(targetStudent.enrollmentId, generated, targetContext.result.severity ?? 'unavailable', 'draft');
          saved += 1;
        } catch (cause) {
          failures.push(`${targetStudent.name}: ${getErrorMessage(cause, 'Draft generation failed.')}`);
        }
      }
      setGenerationFailures(failures);
      setGenerationProgress(`Saved ${saved} private draft${saved === 1 ? '' : 's'}${failures.length ? ` · ${failures.length} failed` : ''}.`);
      props.toast.show(`${saved} feedback draft${saved === 1 ? '' : 's'} saved${failures.length ? `; ${failures.length} failed` : ''}. Review them in Feedback history before publishing.`);
      if (saved) props.refresh();
    } catch (cause) {
      props.toast.show(getErrorMessage(cause, 'Gemini could not generate a feedback draft.'));
    } finally {
      setGenerating(false);
    }
  };
  const save = async () => {
    if (!student || selectedStudentIds.length !== 1 || !body.trim()) return;
    setSaving(true);
    try {
      if (status === 'ready') {
        await sendFacultyFeedbackEmail(student.enrollmentId, body, evaluationContext?.result.severity ?? 'unavailable', editingFeedbackId ?? undefined);
      } else {
        await saveFacultyFeedback(student.enrollmentId, body, evaluationContext?.result.severity ?? 'unavailable', 'draft', editingFeedbackId ?? undefined);
      }
      props.toast.show(status === 'ready' ? 'Feedback emailed and published.' : editingFeedbackId ? 'Draft feedback updated.' : 'Feedback draft saved.');
      setBody('');
      setStatus('draft');
      setEditingFeedbackId(null);
      props.refresh();
    } catch (cause) {
      props.toast.show(getErrorMessage(cause, 'Feedback could not be saved.'));
    } finally {
      setSaving(false);
    }
  };
  const historyStudents = useMemo(() => new Map(studentsWithRisk.map((entry) => [entry.student.enrollmentId, entry])), [studentsWithRisk]);
  const history = useMemo(() => props.workspace.students.flatMap((historyStudent) =>
    (props.workspace.feedback[historyStudent.enrollmentId] ?? []).map((record) => ({ record, student: historyStudent, risk: historyStudents.get(historyStudent.enrollmentId) }))
  ).filter(({ record, student: historyStudent, risk }) => {
    const updatedDay = record.updatedAt.slice(0, 10);
    return (historyStudentFilter === 'all' || historyStudent.enrollmentId === historyStudentFilter)
      && (historyRiskFilter === 'all' || risk?.risk === historyRiskFilter)
      && (historyStatusFilter === 'all' || (historyStatusFilter === 'draft' ? record.status === 'draft' || record.status === 'ready' : record.status === historyStatusFilter || (historyStatusFilter === 'published' && record.status === 'sent')))
      && (!historyUpdatedFrom || updatedDay >= historyUpdatedFrom)
      && (!historyUpdatedTo || updatedDay <= historyUpdatedTo);
  }).sort((left, right) => right.record.updatedAt.localeCompare(left.record.updatedAt)), [props.workspace.students, props.workspace.feedback, historyStudents, historyStudentFilter, historyRiskFilter, historyStatusFilter, historyUpdatedFrom, historyUpdatedTo]);
  const historySelectable = history.filter(({ record }) => record.status === 'draft' || record.status === 'ready');
  const selectedHistoryItems = historySelectable.filter(({ record }) => selectedHistoryFeedbackIds.includes(record.id));
  const selectedHistoryReady = selectedHistoryItems;
  const allVisibleHistorySelected = historySelectable.length > 0 && historySelectable.every(({ record }) => selectedHistoryFeedbackIds.includes(record.id));
  const toggleHistoryFeedback = (feedbackId: string) => setSelectedHistoryFeedbackIds((current) => current.includes(feedbackId) ? current.filter((id) => id !== feedbackId) : [...current, feedbackId]);
  const toggleAllVisibleHistory = () => setSelectedHistoryFeedbackIds((current) => allVisibleHistorySelected
    ? current.filter((id) => !historySelectable.some(({ record }) => record.id === id))
    : [...new Set([...current, ...historySelectable.map(({ record }) => record.id)])]);
  const processBulkFeedback = async () => {
    const targets = selectedHistoryReady;
    if (!targets.length) return;
    setBulkFeedbackPending(true);
    setBulkFeedbackProgress('');
    setBulkFeedbackFailures([]);
    const failures: string[] = [];
    const completedIds: string[] = [];
    try {
      for (let index = 0; index < targets.length; index += 1) {
        const { record, student: targetStudent } = targets[index];
        setBulkFeedbackProgress(`Emailing ${index + 1} of ${targets.length}: ${targetStudent.name}`);
        try {
          await sendFacultyFeedbackEmail(targetStudent.enrollmentId, record.body, record.category, record.id);
          completedIds.push(record.id);
        } catch (cause) {
          failures.push(`${targetStudent.name}: ${getErrorMessage(cause, 'Email could not be sent.')}`);
        }
      }
      setSelectedHistoryFeedbackIds((current) => current.filter((id) => !completedIds.includes(id)));
      setBulkFeedbackFailures(failures);
      setBulkFeedbackProgress(`Emailed ${completedIds.length} of ${targets.length}${failures.length ? ` · ${failures.length} failed` : ''}.`);
      props.toast.show(`Emailed ${completedIds.length} of ${targets.length} selected feedback${targets.length === 1 ? '' : ' items'}${failures.length ? `; ${failures.length} failed` : ''}.`);
      if (completedIds.length) props.refresh();
    } finally {
      setBulkFeedbackPending(false);
      setBulkFeedbackAction(null);
    }
  };
  const toggleStudent = (enrollmentId: string) => {
    if (selectedStudentIds.includes(enrollmentId)) {
      const remaining = selectedStudentIds.filter((id) => id !== enrollmentId);
      setSelectedStudentIds(remaining);
      if (studentId === enrollmentId) setStudentId(remaining[0] ?? '');
    } else {
      setSelectedStudentIds([...selectedStudentIds, enrollmentId]);
      setStudentId(enrollmentId);
    }
  };
  const allMatchingSelected = matchingStudents.length > 0 && matchingStudents.every(({ student: item }) => selectedStudentIds.includes(item.enrollmentId));
  const toggleMatchingStudents = () => {
    const matchingIds = matchingStudents.map(({ student: item }) => item.enrollmentId);
    if (allMatchingSelected) {
      const remaining = selectedStudentIds.filter((id) => !matchingIds.includes(id));
      setSelectedStudentIds(remaining);
      if (!remaining.includes(studentId)) setStudentId(remaining[0] ?? '');
      return;
    }
    const next = [...new Set([...selectedStudentIds, ...matchingIds])];
    setSelectedStudentIds(next);
    if (!next.includes(studentId)) setStudentId(matchingIds[0] ?? '');
  };
  return <>
    <Heading title="Performance Feedback" subtitle="Build a draft from the applied grading and evaluation criteria, edit it, then email it to the student and publish it in the portal." />
    <ClassSelect {...props} />
    <Tabs values={['Compose', 'Feedback history']} selected={activeTab} onSelect={setActiveTab} />
    {activeTab === 'Compose' ? <Card style={styles.feedbackFormCard}>
      <Text style={styles.cardTitle}>{editingFeedbackId ? 'Edit feedback draft' : 'Compose feedback'}</Text>
      <Text style={styles.help}>Choose one student to write or review a message, or select several students to generate private drafts in one run.</Text>
      <View style={styles.feedbackComposeLayout}>
        <View style={styles.feedbackRecipientsPane}>
          <Text style={styles.feedbackPaneTitle}>Recipients</Text>
          <View style={styles.feedbackRecipientFilters}>
            <SearchFilter value={studentQuery} onChange={setStudentQuery} placeholder="Search students by name or ID" accessibilityLabel="Search feedback recipients" containerStyle={styles.feedbackRecipientSearch} />
            <SelectField label="Risk level" value={riskFilter} options={riskOptions} onChange={setRiskFilter} containerStyle={styles.feedbackRiskFilter} />
          </View>
          <View style={styles.feedbackBulkActions}>
            <Text style={styles.help}>{selectedStudentIds.length} recipient{selectedStudentIds.length === 1 ? '' : 's'} selected · {matchingStudents.length} shown</Text>
            <View style={styles.feedbackActions}>
              <Button compact label={allMatchingSelected ? 'Clear shown' : 'Select shown'} variant="secondary" disabled={!matchingStudents.length || generating} onPress={toggleMatchingStudents} />
              <Button compact label="Clear all" variant="ghost" disabled={!selectedStudentIds.length || generating} onPress={() => { setSelectedStudentIds([]); setStudentId(''); }} />
            </View>
          </View>
          <ScrollView style={styles.feedbackBulkStudentList} nestedScrollEnabled keyboardShouldPersistTaps="handled">
            {matchingStudents.map(({ student: item, riskLabel }) => {
              const selected = selectedStudentIds.includes(item.enrollmentId);
              const active = studentId === item.enrollmentId;
              return <View key={item.enrollmentId} style={[styles.feedbackRecipientRow, active && styles.feedbackRecipientActive]}>
                <Pressable accessibilityRole="button" accessibilityState={{ selected: active }} onPress={() => setStudentId(item.enrollmentId)} disabled={generating} style={styles.feedbackRecipientIdentity}>
                  <Text style={styles.feedbackBulkStudentName}>{item.name}</Text>
                  <Text style={styles.help}>{item.email || 'No email on file'}</Text>
                  <Text style={styles.help}>{formatStudentId(item.institutionalId)} · {riskLabel}</Text>
                </Pressable>
                <Pressable accessibilityRole="checkbox" accessibilityLabel={`Select ${item.name} for feedback`} accessibilityState={{ checked: selected }} onPress={() => toggleStudent(item.enrollmentId)} disabled={generating} style={[styles.feedbackBulkCheck, selected && styles.feedbackBulkCheckSelected]}>{selected ? <Text style={styles.feedbackBulkCheckMark}>✓</Text> : null}</Pressable>
              </View>;
            })}
            {!matchingStudents.length ? <Text style={styles.help}>No students match these filters.</Text> : null}
          </ScrollView>
          <Text style={styles.feedbackSelectedRecipient}>{selectedStudentIds.length} selected</Text>
        </View>
        <View style={styles.feedbackCompositionPane}>
          <Text style={styles.feedbackPaneTitle}>Composition</Text>
          {selectedStudentIds.length === 1 && student ? <Text style={styles.feedbackSelectedRecipient}>Writing for {student.name}</Text> : selectedStudentIds.length > 1 ? <Text style={styles.feedbackSelectedRecipient}>Gemini will create and save a separate private draft for each selected student. No email will be sent.</Text> : <Text style={styles.feedbackSelectedRecipient}>Select at least one student to continue.</Text>}
          {editingFeedbackId ? <View style={styles.feedbackEditingBanner}><Text style={styles.feedbackEditingText}>Editing saved draft</Text><Button label="Stop editing" variant="secondary" onPress={() => { setEditingFeedbackId(null); setBody(''); setStatus('draft'); }} /></View> : null}
          <View style={styles.feedbackStyleControls}>
            <SelectField label="Style and tone" value={stylePreset} options={stylePresetOptions} onChange={setStylePreset} containerStyle={styles.feedbackStylePreset} />
            <Field label="Additional instructions (optional)" value={styleInstructions} onChangeText={setStyleInstructions} multiline numberOfLines={2} maxLength={500} placeholder="Add a brief preference for wording or emphasis." style={styles.feedbackStyleBox} containerStyle={styles.feedbackStyleExtra} />
          </View>
          <Text style={styles.help}>Style guidance is sent to Gemini with anonymized records. Don’t include student names or identifying details. It guides wording, not the evidence.</Text>
          {selectedStudentIds.length === 1 ? <>
            <View style={styles.feedbackActions}>
              <Button label="Build from records" variant="secondary" disabled={!student || generating} onPress={buildTemplateDraft} />
              <Button label="Draft with Gemini" variant="secondary" loading={generating} disabled={!student || generating} onPress={() => void generateWithGemini()} />
              <SelectField label="Review status" value={status} options={[{ label: 'Draft', value: 'draft' }, { label: 'Ready to email', value: 'ready' }]} onChange={(value) => setStatus(value as 'draft' | 'ready')} containerStyle={styles.feedbackStatusField} />
            </View>
            <Field label="Feedback message" value={body} onChangeText={setBody} multiline numberOfLines={8} style={styles.feedbackBox} />
            <View style={styles.feedbackSaveRow}>
              <Text style={styles.help}>{status === 'ready' ? 'Email this feedback now and publish it in the student portal.' : 'Drafts remain private to you until you email them.'}</Text>
              <Button label={status === 'ready' ? 'Email feedback' : editingFeedbackId ? 'Save draft changes' : 'Save feedback'} icon={status === 'ready' ? 'email' : 'save'} loading={saving} disabled={!student || !body.trim() || generating} onPress={() => void save()} />
            </View>
          </> : selectedStudentIds.length > 1 ? <View style={styles.feedbackBulkFooter}>
            <Button label={`Generate ${selectedStudentIds.length} private drafts with Gemini`} loading={generating} disabled={generating} onPress={() => void generateWithGemini()} />
            {generationProgress ? <Text style={styles.help}>{generationProgress}</Text> : null}
            {generationFailures.length ? <View style={styles.feedbackBulkFailures}><Text style={styles.feedbackBulkFailureTitle}>Some drafts could not be generated</Text>{generationFailures.map((failure) => <Text key={failure} style={styles.feedbackBulkFailure}>{failure}</Text>)}</View> : null}
          </View> : null}
        </View>
      </View>
    </Card> : null}
    {activeTab === 'Feedback history' ? <Card style={styles.feedbackHistoryCard}>
      <View style={styles.feedbackHistoryHeading}><View style={styles.flex}><Text style={styles.cardTitle}>Feedback history</Text><Text style={styles.help}>Select drafts to email them immediately. Published feedback is read-only.</Text></View></View>
      <View style={styles.feedbackHistoryFilters}>
        <SelectField label="Student" value={historyStudentFilter} options={[{ label: 'All students', value: 'all' }, ...props.workspace.students.map((item) => ({ label: `${item.name} · ${item.email || formatStudentId(item.institutionalId)}`, value: item.enrollmentId }))]} onChange={setHistoryStudentFilter} placeholder="Search student name or email" searchable containerStyle={styles.feedbackHistoryStudentFilter} />
        <SelectField label="Risk level" value={historyRiskFilter} options={riskOptions} onChange={setHistoryRiskFilter} containerStyle={styles.feedbackHistorySelectFilter} />
        <SelectField label="Feedback status" value={historyStatusFilter} options={[{ label: 'All statuses', value: 'all' }, { label: 'Draft', value: 'draft' }, { label: 'Published', value: 'published' }, { label: 'Failed', value: 'failed' }, { label: 'Archived', value: 'archived' }]} onChange={setHistoryStatusFilter} containerStyle={styles.feedbackHistorySelectFilter} />
      </View>
      <View style={styles.feedbackHistoryDateFilters}>
        <DateField label="Updated from" value={historyUpdatedFrom} onChange={setHistoryUpdatedFrom} containerStyle={styles.feedbackHistoryDateField} />
        <DateField label="Updated to" value={historyUpdatedTo} onChange={setHistoryUpdatedTo} containerStyle={styles.feedbackHistoryDateField} />
        <Button compact label="Clear filters" variant="ghost" onPress={() => { setHistoryStudentFilter('all'); setHistoryRiskFilter('all'); setHistoryStatusFilter('all'); setHistoryUpdatedFrom(''); setHistoryUpdatedTo(''); }} />
      </View>
      {historySelectable.length ? <View style={styles.feedbackHistoryBulkBar}>
        <Pressable accessibilityRole="checkbox" accessibilityLabel="Select visible drafts" accessibilityState={{ checked: allVisibleHistorySelected }} onPress={toggleAllVisibleHistory} disabled={bulkFeedbackPending} style={[styles.feedbackBulkCheck, allVisibleHistorySelected && styles.feedbackBulkCheckSelected]}>{allVisibleHistorySelected ? <Text style={styles.feedbackBulkCheckMark}>✓</Text> : null}</Pressable>
        <Text style={styles.help}>{selectedHistoryItems.length} selected</Text>
        <View style={styles.feedbackActions}>
          {selectedHistoryReady.length ? <Button compact label={`Email feedback (${selectedHistoryReady.length})`} icon="email" disabled={bulkFeedbackPending} loading={bulkFeedbackPending && bulkFeedbackAction === 'email'} onPress={() => setBulkFeedbackAction('email')} /> : null}
        </View>
      </View> : null}
      {bulkFeedbackProgress ? <Text style={styles.help}>{bulkFeedbackProgress}</Text> : null}
      {bulkFeedbackFailures.length ? <View style={styles.feedbackBulkFailures}><Text style={styles.feedbackBulkFailureTitle}>Some feedback could not be processed</Text>{bulkFeedbackFailures.map((failure) => <Text key={failure} style={styles.feedbackBulkFailure}>{failure}</Text>)}</View> : null}
      {history.length ? <View style={styles.feedbackHistoryList}>{history.map(({ record, student: historyStudent, risk }) => <View key={record.id} style={styles.feedbackHistoryItem}>
        <View style={styles.feedbackHistoryItemHeader}>{record.status === 'draft' || record.status === 'ready' ? <Pressable accessibilityRole="checkbox" accessibilityLabel={`Select draft feedback for ${historyStudent.name}`} accessibilityState={{ checked: selectedHistoryFeedbackIds.includes(record.id) }} onPress={() => toggleHistoryFeedback(record.id)} disabled={bulkFeedbackPending} style={[styles.feedbackBulkCheck, selectedHistoryFeedbackIds.includes(record.id) && styles.feedbackBulkCheckSelected]}>{selectedHistoryFeedbackIds.includes(record.id) ? <Text style={styles.feedbackBulkCheckMark}>✓</Text> : null}</Pressable> : null}<View style={styles.flex}><Text style={styles.feedbackBulkStudentName}>{historyStudent.name}</Text><Text style={styles.help}>{historyStudent.email || 'No email on file'} · {risk?.riskLabel ?? 'Risk unavailable'}</Text></View><View style={styles.feedbackHistoryMeta}><Text style={styles.feedbackHistoryStatus}>{record.status === 'published' || record.status === 'sent' ? 'Published' : record.status === 'draft' || record.status === 'ready' ? 'Draft' : record.status}</Text><Text style={styles.help}>Updated {new Date(record.updatedAt).toLocaleString()}</Text></View>{record.status === 'draft' || record.status === 'ready' ? <Button label="Edit feedback" variant="secondary" onPress={() => { setStudentId(historyStudent.enrollmentId); setSelectedStudentIds([historyStudent.enrollmentId]); setEditingFeedbackId(record.id); setBody(record.body); setStatus('draft'); setActiveTab('Compose'); }} /> : null}</View>
        <Text numberOfLines={4} style={styles.feedbackHistoryBody}>{record.body}</Text>
      </View>)}</View> : <PageState kind="empty" title="No matching feedback" message="Adjust the filters or choose another date range to see saved feedback." />}
    </Card> : null}
    <ConfirmDialog visible={bulkFeedbackAction === 'email'} title={`Email ${selectedHistoryReady.length} feedback item${selectedHistoryReady.length === 1 ? '' : 's'}?`} message="Each selected feedback message will be emailed to its student's registered address and published in the student portal. This cannot be undone." confirmLabel={`Email ${selectedHistoryReady.length} feedback item${selectedHistoryReady.length === 1 ? '' : 's'}`} cancelLabel="Review selection" pending={bulkFeedbackPending} onClose={() => { if (!bulkFeedbackPending) setBulkFeedbackAction(null); }} onConfirm={() => void processBulkFeedback()} />
  </>;
}

function DetailSection({ title, summary, defaultExpanded = false, children }: { title: string; summary?: string; defaultExpanded?: boolean; children: ReactNode }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  return <View style={styles.detailSection}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded((value) => !value)} style={styles.detailSectionHeader}>
      <View style={styles.detailSectionHeading}><Text style={styles.cardTitle}>{title}</Text>{summary ? <Text style={styles.help}>{summary}</Text> : null}</View>
      <Text style={styles.detailSectionChevron}>{expanded ? '−' : '+'}</Text>
    </Pressable>
    {expanded ? <View style={styles.detailSectionContent}>{children}</View> : null}
  </View>;
}

export function StudentDetail({ student, workspace, onClose }: { student: RosterStudent | null; workspace: ClassWorkspace; onClose: () => void }) {
  if (!student) return null;
  const grading = workspace.criteria?.gradingSystemDefinition ?? workspace.defaultGradingSystem ?? IT_GLOBAL_GRADING_SYSTEM;
  const gradingResult = calculateEnrollmentGrade(workspace, student.enrollmentId);
  const evaluationContext = evaluationContextForStudent(workspace, student.enrollmentId);
  const evaluationDefinition = evaluationContext.definition;
  const evaluation = workspace.evaluations[student.enrollmentId];
  const attendance = attendanceRate(workspace, student.enrollmentId);
  const missing = missingAssessments(workspace, student.enrollmentId);
  const matchedLevel = evaluationDefinition.levels.find((level) => level.id === evaluationContext.result.matchedLevelId);
  const displayGrade = (value: number | null | undefined) => value == null ? '—' : `${value.toFixed(2)}%`;
  const periodRows = [...(grading.periods ?? [])].sort((left: any, right: any) => (left.sequence ?? 0) - (right.sequence ?? 0)).map((period: any) => [String(period.sequence ?? '—'), period.name, grading.periodCalculation?.mode ?? period.calculation?.mode ?? '—', (period.groupIds ?? []).map((id: string) => grading.groups?.find((group: any) => group.id === id)?.name ?? id).join(', ') || '—', displayGrade(gradingResult.periods[period.id])]);
  const componentPath = (component: any) => {
    const names = [component.name];
    let parentId = component.parentComponentId ?? component.parentId;
    const seen = new Set<string>([component.id]);
    while (parentId && !seen.has(parentId)) { seen.add(parentId); const parent = grading.components?.find((item: any) => item.id === parentId); if (!parent) break; names.unshift(parent.name); parentId = parent.parentComponentId ?? parent.parentId; }
    return names.join(' › ');
  };
  const componentRows = [...(grading.components ?? [])].sort((left: any, right: any) => (left.sequence ?? 0) - (right.sequence ?? 0)).map((component: any) => [String(component.sequence ?? '—'), componentPath(component), component.shortCode ?? '—', component.assessmentDefinition?.typeId ?? 'Calculated', component.assessmentDefinition?.aggregation?.mode ?? component.calculation?.mode ?? '—', component.weight == null ? '—' : `${Number(component.weight) * (Number(component.weight) <= 1 ? 100 : 1)}%`, displayGrade(gradingResult.components[component.id]), component.description ?? component.assessmentDefinition?.scoring?.mode ?? '—']);
  const groupRows = [...(grading.groups ?? [])].sort((left: any, right: any) => (left.sequence ?? 0) - (right.sequence ?? 0)).map((group: any) => [String(group.sequence ?? '—'), groupHierarchyName(group, grading.groups ?? []), group.typeId ?? '—', group.parentGroupId ? (grading.groups.find((item: any) => item.id === group.parentGroupId)?.name ?? '—') : '—', group.aggregation?.mode ?? '—', displayGrade(gradingResult.groups[group.id])]);
  const assessmentRows = [...workspace.assessments].sort((left, right) => left.assessmentDate.localeCompare(right.assessmentDate)).map((assessment) => {
    const score = storedAssessmentValue(workspace, student.enrollmentId, assessment.id);
    const groupId = assessment.gradingGroupId ?? (assessment.moduleNumber == null ? undefined : `m${assessment.moduleNumber}`);
    const period = grading.periods?.find((item: any) => item.id === assessment.gradingPeriodId || (groupId && item.groupIds?.includes(groupId)));
    const group = grading.groups?.find((item: any) => item.id === groupId);
    const path = assessmentComponentPath(grading, assessment.gradingTypeId ?? assessment.component).map((item) => item.name).join(' › ');
    const percent = assessmentPercentForWorkspace(workspace, student.enrollmentId, assessment);
    const component = grading.components?.find((item: any) => item.assessmentDefinition?.typeId === (assessment.gradingTypeId ?? assessment.component));
    const isScored = score != null && String(score).trim() !== '';
    return [new Date(assessment.assessmentDate).toLocaleDateString(), assessment.title, component?.shortCode ?? '—', path || 'Unmapped by grading system', period?.name ?? assessment.gradingPeriod ?? 'No period', group ? groupHierarchyName(group, grading.groups ?? []) : 'No group', isScored ? String(score) : '—', String(assessment.maximumScore ?? '—'), assessment.instanceWeight == null ? '—' : String(assessment.instanceWeight), isScored ? 'Scored' : 'Missing', displayGrade(percent)];
  });
  const evaluationFactorRows = evaluationDefinition.factors.map((factor) => [factor.name, factor.source.replaceAll('_', ' '), evaluationOriginLabel(factor.origin), factor.gradingAggregation ?? '—', formatEvaluationFactorValue(factor, evaluationFactorValue(factor, evaluationContext.values)), factor.weight == null ? '—' : String(factor.weight)]);
  const matchedRuleIds = new Set(evaluationContext.result.matchedRuleIds);
  const evaluationRuleRows = [...evaluationDefinition.levels].sort((left, right) => right.priority - left.priority).flatMap((level) => level.rules.map((rule, index) => {
    const factor = evaluationDefinition.factors.find((item) => item.id === rule.factorId);
    const ruleId = `${level.id}:${index}`;
    const value = factor ? evaluationFactorValue(factor, evaluationContext.values) : null;
    return [level.name, level.severity, String(level.priority), level.match.toUpperCase(), factor?.name ?? rule.factorId, formatEvaluationFactorValue(factor ?? ({ unit: undefined } as any), value), `${rule.operator.replaceAll('_', ' ')} ${Array.isArray(rule.threshold) ? rule.threshold.join(', ') : rule.threshold}`, matchedRuleIds.has(ruleId) ? 'Matched' : value == null ? 'Unavailable' : 'Not matched', rule.description ?? '—'];
  }));
  const evaluationLevelRows = [...evaluationDefinition.levels].sort((left, right) => right.priority - left.priority).map((level) => [level.name, level.severity, String(level.priority), level.match.toUpperCase(), String(level.rules.length), evaluationLevelRuleSummary(evaluationDefinition, level), level.id === matchedLevel?.id ? 'Applied' : 'Not selected']);
  const conversionRows = (['passingScale', 'failingScale'] as const).map((scaleKey) => {
    const scale: any = grading.finalGradeConversion?.[scaleKey];
    const range = scaleKey === 'passingScale' ? `${grading.finalGradeConversion?.passingPercentage ?? '—'}–${scale?.maximumPercentage ?? '—'}%` : `${scale?.minimumPercentage ?? '—'}–<${grading.finalGradeConversion?.passingPercentage ?? '—'}%`;
    const pointRange = scale?.mode === 'equal_interval' ? `${scale.bestPoint ?? scale.firstFailingPoint ?? '—'} to ${scale.passingPoint ?? scale.worstPoint ?? '—'}` : (scale?.mappings ?? scale?.mapping ?? []).map((item: any) => `${item.percentage ?? item.value}% → ${item.point ?? item.pointGrade ?? item.grade ?? '—'}`).join('; ') || 'Explicit mapping';
    return [scaleKey === 'passingScale' ? 'Passing' : 'Failing', range, scale?.mode ?? '—', pointRange, scale?.pointInterval == null ? 'Explicit' : String(scale.pointInterval), grading.finalGradeConversion?.rounding?.mode ?? '—', String(grading.finalGradeConversion?.rounding?.precision ?? '—')];
  });
  const factorSummary = evaluationDefinition.factors.map((factor) => {
    const value = formatEvaluationFactorValue(factor, evaluationFactorValue(factor, evaluationContext.values));
    const aggregation = factor.gradingAggregation ? `, using the ${factor.gradingAggregation} of its matching grades` : '';
    const weight = factor.weight == null ? '' : ` Its evaluation weight is ${factor.weight}.`;
    return `${factor.name} (${evaluationOriginLabel(factor.origin)}; ${factor.source.replaceAll('_', ' ')}${aggregation}): ${value}.${weight}`;
  }).join(' ');
  const riskSummary = matchedLevel
    ? `${matchedLevel.name} (${matchedLevel.severity} risk) was selected at priority ${matchedLevel.priority}. Its rules use ${matchedLevel.match.toUpperCase()} matching. Matched conditions: ${evaluationRuleReasons(evaluationDefinition, evaluationContext.result)}.`
    : evaluationContext.result.severity === 'unavailable'
      ? `Risk could not be assigned because required evaluation data is unavailable: ${evaluationContext.result.unavailableFactors.join(', ') || 'insufficient evidence'}.`
      : `No risk-level rule matched. The configured fallback is ${evaluationContext.result.severity}.`;
  const levelLabel = matchedLevel?.name ?? (evaluationContext.result.severity === 'unavailable' ? 'Unavailable' : 'No matching level');
  const gradeTone = gradingResult.remarks === 'passing' ? 'success' : gradingResult.remarks === 'failing' ? 'danger' : 'warning';
  const riskTone = evaluationContext.result.severity === 'high' ? 'danger' : evaluationContext.result.severity === 'medium' ? 'warning' : evaluationContext.result.severity === 'unavailable' ? 'warning' : 'success';
  const hasAttendanceFactor = evaluationDefinition.factors.some((factor) => factor.source === 'attendance' || factor.source === 'attendance_rate');
  return <Dialog visible title="Student Performance Details" onClose={onClose}>
    <View style={styles.studentProfileCard}>
      <View style={styles.studentProfileHeading}>
        <View style={styles.studentProfileAvatar}><AppIcon name="person" size={22} color={colors.brand} /></View>
        <View style={styles.studentProfileIdentity}>
          <Text style={styles.studentProfileName}>{student.name}</Text>
          <Text style={styles.studentProfileId}>{formatStudentId(student.institutionalId)}</Text>
        </View>
      </View>
      <View style={styles.studentProfileFacts}>
        <View style={styles.studentProfileFact}><Text style={styles.studentProfileFactLabel}>PROGRAM</Text><Text style={styles.studentProfileFactValue}>{student.program}</Text></View>
        <View style={styles.studentProfileFact}><Text style={styles.studentProfileFactLabel}>YEAR LEVEL</Text><Text style={styles.studentProfileFactValue}>Year {student.yearLevel}</Text></View>
        <View style={styles.studentProfileFact}><Text style={styles.studentProfileFactLabel}>SECTION</Text><Text style={styles.studentProfileFactValue}>{student.section}</Text></View>
      </View>
    </View>
    <View style={styles.studentCriteriaOverview}>
      <View style={styles.studentCriteriaCard}>
        <View style={styles.studentCriteriaHeading}><AppIcon name="grades" size={16} color={colors.brand} /><Text style={styles.studentCriteriaLabel}>GRADING SYSTEM</Text></View>
        <Text style={styles.studentCriteriaName}>{grading.name}</Text>
        <Text style={styles.studentCriteriaMeta}>{workspace.criteria?.version ? `Applied criteria · Version ${workspace.criteria.version}` : 'System default'}</Text>
      </View>
      <View style={styles.studentCriteriaCard}>
        <View style={styles.studentCriteriaHeading}><AppIcon name="evaluation" size={16} color={colors.brand} /><Text style={styles.studentCriteriaLabel}>EVALUATION CRITERIA</Text></View>
        <Text style={styles.studentCriteriaName}>{evaluationDefinition.name}</Text>
        <Text style={styles.studentCriteriaMeta}>{evaluationDefinition.definitionVersion ? `Version ${evaluationDefinition.definitionVersion}` : 'Current criteria'}</Text>
      </View>
    </View>
    <View style={styles.metrics}>
      <MetricCard label={grading.finalResult?.title ?? 'Final percentage'} value={displayGrade(gradingResult.finalGrade)} tone={gradeTone} />
      <MetricCard label="Point / letter grade" value={gradingResult.pointGrade == null ? 'Incomplete' : `${gradingResult.pointGrade.toFixed(2)}${gradingResult.letterGrade ? ` / ${gradingResult.letterGrade}` : ''}`} tone={gradeTone} />
      <MetricCard label="Applied risk level" value={levelLabel} tone={riskTone} valueColor={matchedLevel?.color} />
      {hasAttendanceFactor ? <MetricCard label="Attendance" value={attendance == null ? 'Unavailable' : `${attendance.toFixed(2)}%`} /> : null}
    </View>
    <AIAdvisoryForecast forecast={workspace.evaluations[student.enrollmentId] ?? null} />
    <DetailSection title="Period results" summary={`${periodRows.length} schema-defined period${periodRows.length === 1 ? '' : 's'}`}><DataTable columns={['Seq.', 'Period', 'Strategy', 'Included groups', 'Calculated percentage']} rows={periodRows} columnWidths={[64, 150, 150, 300, 150]} /></DetailSection>
    <DetailSection title="Component breakdown" summary={`${componentRows.length} components · includes configured aggregation and contribution fields`} defaultExpanded><DataTable columns={['Seq.', 'Component hierarchy', 'Code', 'Source', 'Aggregation', 'Weight', 'Calculated percentage', 'Description / scoring']} rows={componentRows} columnWidths={[56, 190, 72, 100, 125, 76, 150, 300]} /></DetailSection>
    {groupRows.length ? <DetailSection title="Group breakdown" summary={`${groupRows.length} groups`}><DataTable columns={['Seq.', 'Group hierarchy', 'Type', 'Parent', 'Aggregation', 'Calculated percentage']} rows={groupRows} columnWidths={[64, 260, 120, 200, 150, 180]} /></DetailSection> : null}
    <DetailSection title="Final-grade calculation and conversion" summary={`${gradingResult.rawFinal == null ? 'Raw grade unavailable' : `Raw ${displayGrade(gradingResult.rawFinal)} → ${displayGrade(gradingResult.finalGrade)}`} · passing at ${grading.finalGradeConversion?.passingPercentage ?? '—'}%`} defaultExpanded>
      <DataTable columns={['Final result source', 'Raw percentage', 'Final percentage', 'Point grade', 'Letter grade', 'Remarks', 'Passing threshold']} rows={[[grading.finalResult?.source === 'period_grade' ? grading.periods?.find((period: any) => period.id === grading.finalResult.periodId)?.name ?? 'Configured period' : grading.components?.find((component: any) => component.id === grading.finalResult?.componentId)?.name ?? 'Configured component', displayGrade(gradingResult.rawFinal), displayGrade(gradingResult.finalGrade), gradingResult.pointGrade == null ? '—' : gradingResult.pointGrade.toFixed(2), gradingResult.letterGrade ?? '—', gradingResult.remarks, grading.finalGradeConversion?.passingPercentage == null ? '—' : `${grading.finalGradeConversion.passingPercentage}%`]]} columnWidths={[240, 140, 140, 120, 120, 260, 150]} highlightCell={(_row, columnIndex) => gradingResult.remarks === 'failing' && (columnIndex === 3 || columnIndex === 4)} />
      <DataTable columns={['Scale', 'Percentage range', 'Conversion mode', 'Point mapping', 'Interval', 'Rounding', 'Precision']} rows={conversionRows} columnWidths={[140, 180, 180, 190, 120, 130, 110]} />
    </DetailSection>
    <DetailSection title="Evaluation-factor explanation" summary={`${evaluationDefinition.factors.length} configured factors · ${evaluationContext.result.evidenceCount} with available values`} defaultExpanded>
      <Text style={styles.detailNarrative}>{factorSummary || 'No evaluation factors are configured.'}</Text>
      <DataTable columns={['Factor', 'Metric', 'Data origin', 'Grade aggregation', 'Student value', 'Weight']} rows={evaluationFactorRows} columnWidths={[220, 180, 200, 140, 160, 110]} />
    </DetailSection>
    <DetailSection title="Why this risk level was assigned" summary={levelLabel} defaultExpanded>
      <Text style={styles.detailNarrative}>{riskSummary}</Text>
      <DataTable columns={['Level', 'Severity', 'Priority', 'Rule logic', 'Factor', 'Observed value', 'Condition', 'Outcome', 'Rule explanation']} rows={evaluationRuleRows} columnWidths={[160, 110, 90, 190, 160, 150, 170, 140, 340]} highlightRow={(row) => row[7] === 'Matched'} />
      <DataTable columns={['Configured level', 'Severity', 'Priority', 'Match logic', 'Rule count', 'Rule summary', 'Status']} rows={evaluationLevelRows} columnWidths={[180, 110, 90, 180, 110, 340, 120]} />
      <Text style={styles.help}>Missing assessment results: {missing}. {evaluation?.predictedStanding == null ? 'No saved AI prediction.' : `Saved AI predicted standing: ${evaluation.predictedStanding.toFixed(2)}%.`}</Text>
      {evaluationDefinition.explanation?.includeAiFactors && evaluation?.factors.length ? <Text style={styles.help}>AI explanation factors: {evaluation.factors.join('; ')}</Text> : null}
    </DetailSection>
    <DetailSection title="Assessment-level inputs" summary={`${assessmentRows.length} assessment instances; each result is mapped using the applied grading schema`}>
      {assessmentRows.length ? <DataTable columns={['Date', 'Assessment', 'Code', 'Component hierarchy', 'Period', 'Group', 'Raw score', 'Maximum', 'Weight', 'Status', 'Mapped percentage']} rows={assessmentRows} columnWidths={[130, 240, 100, 260, 140, 160, 110, 110, 100, 130, 160]} /> : <Text style={styles.help}>No assessment instances are recorded.</Text>}
    </DetailSection>
  </Dialog>;
}

function facultyReportRecords(workspace: ClassWorkspace, classInfo: FacultyClass): ReportRecord[] {
  const evaluationDefinition = workspace.evaluationSystem ?? DEFAULT_EVALUATION_SYSTEM;
  return workspace.students.map((student) => {
    const summary = summarizeEnrollmentStanding(workspace, student.enrollmentId);
    const score = summary.finalGrade ?? summary.p3 ?? summary.effortfulLearning ?? summary.mastery;
    const evaluation = evaluationContextForStudent(workspace, student.enrollmentId);
    const gradingSystem = workspace.criteria?.gradingSystemDefinition ?? workspace.defaultGradingSystem ?? IT_GLOBAL_GRADING_SYSTEM;
    const calculated = evaluation.calculated;
    const prediction = workspace.evaluations[student.enrollmentId] ?? null;
    const assessmentResults = workspace.assessments.map((assessment) => ({ id: assessment.id, name: assessment.title, date: assessment.assessmentDate, gradingTypeId: assessment.gradingTypeId ?? assessment.component, gradingPeriodId: assessment.gradingPeriodId ?? null, gradingGroupId: assessment.gradingGroupId ?? null, rawScore: workspace.scores[`${student.enrollmentId}:${assessment.id}`] ?? workspace.categoricalScores[`${student.enrollmentId}:${assessment.id}`] ?? null, maximumScore: assessment.maximumScore, mappedPercentage: assessmentPercentForWorkspace(workspace, student.enrollmentId, assessment) }));
    const riskKey = evaluationRiskValue(evaluationDefinition, evaluation.result);
    const riskLevel = evaluation.result.matchedLevelId ? evaluation.definition.levels.find((level) => level.id === evaluation.result.matchedLevelId)?.name ?? 'Configured risk' : evaluation.result.severity === 'unavailable' ? 'Unavailable' : 'No matching level';
    const classLabel = `${classInfo.code} · ${classInfo.section}`;
    return { id: student.enrollmentId, label: student.name, student: student.name, studentId: student.institutionalId, score: calculated.finalGrade ?? score, currentStanding: calculated.finalGrade ?? score, finalGrade: calculated.finalGrade, pointGrade: calculated.pointGrade, risk: riskKey, riskLevel, attendanceRate: evaluation.values.attendance_rate, missingAssessments: evaluation.values.missing_assessment_count, classification: summary.remarks, category: classLabel, class: classLabel, classId: classInfo.id, subject: classInfo.title, term: classInfo.term, yearLevel: student.yearLevel, program: student.program, timestamp: workspace.assessments.at(-1)?.assessmentDate, gradingSystemSchema: gradingSystem, appliedGradingSystem: workspace.criteria ?? null, assessmentResults, calculatedGrade: calculated, evaluationCriteriaSchema: evaluation.definition, evaluationInputValues: evaluation.values, evaluationResult: evaluation.result, performancePrediction: prediction, predictedStanding: prediction?.predictedStanding ?? null, riskProbability: prediction?.riskProbability ?? null, forecastGeneratedAt: prediction?.predictionGeneratedAt ?? null, forecastProvider: prediction?.modelProvider ?? null, forecastModel: prediction?.modelName ?? null, forecastModelVersion: prediction?.modelVersion ?? null, ...Object.fromEntries(Object.entries(calculated.periods ?? {}).map(([key, value]) => [`gradingPeriod_${key}`, value])), ...Object.fromEntries(Object.entries(calculated.components ?? {}).map(([key, value]) => [`gradingComponent_${key}`, value])), ...Object.fromEntries(Object.entries(calculated.groups ?? {}).map(([key, value]) => [`gradingGroup_${key}`, value])) };
  });
}

function Analytics(props: StateProps) {
  const [allClasses, setAllClasses] = useState(false);
  const [allClassWorkspaces, setAllClassWorkspaces] = useState<{ classInfo: FacultyClass; workspace: ClassWorkspace }[] | null>(null);
  useEffect(() => {
    let active = true;
    if (!allClasses) { setAllClassWorkspaces(null); return () => { active = false; }; }
    setAllClassWorkspaces(null);
    Promise.all(props.classes.map(async (classInfo) => ({
      classInfo,
      workspace: classInfo.id === props.selectedClassId
        ? props.workspace
        : await loadClassWorkspace(classInfo.id, undefined, props.userId, undefined, { includeAttendance: true, includeEvaluations: true }),
    }))).then((loaded) => { if (active) setAllClassWorkspaces(loaded); });
    return () => { active = false; };
  }, [allClasses, props.classes, props.selectedClassId, props.userId, props.workspace]);
  const analyticsWorkspace = allClasses
    ? allClassWorkspaces?.reduce<ClassWorkspace>((combined, item) => ({
      students: [...combined.students, ...item.workspace.students],
      assessments: [...combined.assessments, ...item.workspace.assessments],
      scores: { ...combined.scores, ...item.workspace.scores },
      categoricalScores: { ...combined.categoricalScores, ...item.workspace.categoricalScores },
      criteria: combined.criteria ?? item.workspace.criteria,
      defaultGradingSystem: combined.defaultGradingSystem ?? item.workspace.defaultGradingSystem,
      semesterEndsOn: combined.semesterEndsOn ?? item.workspace.semesterEndsOn,
      evaluationSystem: combined.evaluationSystem ?? item.workspace.evaluationSystem,
      attendanceSessions: [...combined.attendanceSessions, ...item.workspace.attendanceSessions],
      attendance: { ...combined.attendance, ...item.workspace.attendance },
      evaluations: { ...combined.evaluations, ...item.workspace.evaluations },
      feedback: { ...combined.feedback, ...item.workspace.feedback },
    }), emptyWorkspace) ?? props.workspace
    : props.workspace;
  const selectedClass = props.classes.find((item) => item.id === props.selectedClassId);
  const reportRows = useMemo(() => allClasses
    ? (allClassWorkspaces ?? []).flatMap(({ classInfo, workspace }) => facultyReportRecords(workspace, classInfo))
    : selectedClass ? facultyReportRecords(props.workspace, selectedClass) : [], [allClasses, allClassWorkspaces, props.workspace, selectedClass]);
  const reportScopeOptions = useMemo<ReportScopeOption[]>(() => props.classes.length > 1 ? [{
    label: 'All classes assigned to me',
    value: 'all-faculty-classes',
    loadRows: async () => {
      const loaded: ReportRecord[] = [];
      for (const classInfo of props.classes) {
        const workspace = classInfo.id === props.selectedClassId
          ? props.workspace
          : await loadClassWorkspace(classInfo.id, undefined, props.userId, undefined, { includeAttendance: true, includeEvaluations: true });
        loaded.push(...facultyReportRecords(workspace, classInfo));
      }
      return loaded;
    },
  }] : [], [props.classes, props.selectedClassId, props.userId, props.workspace]);
  const analyticsSources = allClasses ? allClassWorkspaces ?? [] : selectedClass ? [{ classInfo: selectedClass, workspace: props.workspace }] : [];
  const analyticsEvaluationDefinitions = [...new Map(analyticsSources.map(({ workspace }) => {
    const definition = workspace.evaluationSystem ?? DEFAULT_EVALUATION_SYSTEM;
    return [definition.id, definition] as const;
  })).values()];
  const evaluationDefinition = analyticsEvaluationDefinitions[0] ?? analyticsWorkspace.evaluationSystem ?? DEFAULT_EVALUATION_SYSTEM;
  const analyticsRecords = useMemo(() => analyticsSources.flatMap(({ classInfo, workspace }) => workspace.students.flatMap((student) => {
    const summary = summarizeEnrollmentStanding(workspace, student.enrollmentId);
    const score = summary.finalGrade ?? summary.p3 ?? summary.effortfulLearning ?? summary.mastery;
    if (score == null) return [];
    const evaluation = evaluationContextForStudent(workspace, student.enrollmentId);
    const definition = workspace.evaluationSystem ?? DEFAULT_EVALUATION_SYSTEM;
    const riskKey = evaluationRiskValue(definition, evaluation.result);
    const riskLevel = evaluation.result.matchedLevelId ? evaluation.definition.levels.find((level) => level.id === evaluation.result.matchedLevelId)?.name ?? 'Configured risk' : evaluation.result.severity === 'unavailable' ? 'Unavailable' : 'No matching level';
    return [{ id: student.enrollmentId, label: student.name, student: student.name, score: evaluation.calculated.finalGrade ?? score, currentStanding: evaluation.calculated.finalGrade ?? score, risk: riskKey, riskLevel, attendanceRate: evaluation.values.attendance_rate, missingAssessments: evaluation.values.missing_assessment_count, classification: summary.remarks, category: classInfo.code, timestamp: workspace.assessments.at(-1)?.assessmentDate }];
  })), [analyticsSources]);
  const filters = useAnalyticsFilters(analyticsRecords, evaluationRiskOptions(analyticsEvaluationDefinitions.length ? analyticsEvaluationDefinitions : evaluationDefinition, 'All risks'));
  const visible = filters.filtered;
  const summaries = visible.map((item) => item.classification);
  const passing = summaries.filter((value) => value === 'passing').length;
  const riskDistribution = [
    ...analyticsEvaluationDefinitions.flatMap((definition) => [...definition.levels].sort((left, right) => right.priority - left.priority).map((level) => ({ label: `${level.name} · ${definition.name}`, value: visible.filter((record) => record.risk === `level:${definition.id}:${level.id}`).length }))),
    { label: 'No matching level', value: visible.filter((record) => record.risk === 'unmatched').length },
    { label: 'Unavailable', value: visible.filter((record) => record.risk === 'unavailable').length },
  ];
  const exportCsv = async () => { const csv = exportClassCsv(analyticsWorkspace); if (Platform.OS === 'web') { const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = allClasses ? 'apms-all-classes-report.csv' : 'apms-class-report.csv'; anchor.click(); URL.revokeObjectURL(url); } else await Share.share({ message: csv }); props.toast.show('Class report exported as CSV.'); };
  const scores = visible.map((item) => ({ label: item.label, value: item.score, kind: 'continuous' as const }));
  const visibleIds = new Set(visible.map((item) => item.id));
  const assessmentTrend = buildAssessmentTrend(analyticsWorkspace, visibleIds);
  const passFail = [{ label: 'Meets rule', value: passing }, { label: 'Below or incomplete', value: visible.length - passing }];
  return <>
    <Heading title="Analytics and Reports" subtitle="Live class monitoring summary from SWUNEXT scores, attendance, and advisory risk data." action={<Button label="Export CSV" onPress={() => void exportCsv()} />} />
    {props.classes.length > 1 ? <SelectField label="Class scope" value={allClasses ? 'all-classes' : props.selectedClassId} options={[{ label: 'All classes assigned to me', value: 'all-classes' }, ...props.classes.map((item) => ({ label: `${item.code} · ${item.section}`, value: item.id }))]} onChange={(value) => { if (value === 'all-classes') setAllClasses(true); else { setAllClasses(false); props.setSelectedClassId(value); } }} containerStyle={styles.classSelect} /> : <ClassSelect {...props} />}{filters.controls}
    {allClasses && !allClassWorkspaces ? <Text style={styles.help}>Loading analytics for all assigned classes…</Text> : null}
    <View style={styles.metrics}><MetricCard label="Passing rule met" value={String(passing)} tone="success" /><MetricCard label="Below rule" value={String(visible.filter((item) => item.classification === 'failing').length)} tone="warning" /><MetricCard label="Students in applied risk levels" value={String(visible.length)} tone="danger" /><MetricCard label="Assessments" value={String(analyticsWorkspace.assessments.length)} tone="info" /></View>
    <Suspense fallback={<Card><Text style={styles.cardTitle}>Preparing analytics charts…</Text></Card>}>
      <View style={styles.analyticsCharts}><LazyVisualizationPanel title="Student score histogram" description="Filtered continuous SWUNEXT scores grouped into score bands." data={scores} type="histogram" suffix="%" /><LazyVisualizationPanel title="Risk distribution" description={`Applied criteria: ${evaluationDefinition.name}`} data={riskDistribution} type="pie" /><LazyVisualizationPanel title="Passing rule status" description="Binary pass and not yet passing classification." data={passFail} type="pie" /></View>
      <LazyVisualizationPanel title="Assessment trend" description="Mean assessment score over time for students matching these filters." data={assessmentTrend} type="line" suffix="%" />
    </Suspense>
    <Card><Text style={styles.help}>P1 and P2 are running cumulative views only. Final grade uses P3 effortful learning at 55% and FE mastery at 45%. Exports contain APMS monitoring data only and are not SIS submission files.</Text></Card>
    <ReportComposer title="Faculty Class Monitoring Report" scopeLabel={allClasses ? 'All classes assigned to me' : selectedClass ? `${selectedClass.code} · ${selectedClass.section}` : 'Assigned class'} description="Provisional student standing and advisory risk for your assigned class scope." rows={reportRows} scopeOptions={reportScopeOptions} />
  </>;
}

export function Dialog({ visible, title, onClose, children, footer }: { visible: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}><View style={styles.overlay}><Card style={styles.dialog}><View style={styles.heading}><Text accessibilityRole="header" style={styles.dialogTitle}>{title}</Text><Pressable accessibilityLabel="Close dialog" onPress={onClose}><Text style={styles.close}>×</Text></Pressable></View><ScrollView style={styles.dialogScroll} contentContainerStyle={styles.dialogBody} nestedScrollEnabled>{children}</ScrollView>{footer}</Card></View></Modal>;
}
