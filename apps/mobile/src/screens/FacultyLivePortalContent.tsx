import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Modal, Platform, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as XLSX from 'xlsx';

import { useAuth } from '@/auth/AuthProvider';
import { supabase } from '@/services/supabase';
import { Badge, Button, Card, ConfirmDialog, DataTable, Field, MetricCard, PageState, SearchFilter, SelectField, useToast } from '@/components/ui';
import { useAnalyticsFilters } from '@/components/charts/AnalyticsFilters';
import { VisualizationPanel } from '@/components/charts/VisualizationPanel';
import {
  addStudentToClass, createAssessment, createAttendanceSession, createFacultyClass, exportClassCsv,
  importRosterCsv, importRosterExcel, loadClassWorkspace, loadFacultyClasses, loadFacultyReferenceData, loadMySubjectRequests, removeStudentsFromClass,
  previewRosterCsv, previewRosterExcel, runAiPredictions, saveAttendance, saveFeedbackDraft, saveScores,
  submitSubjectRequest, summarizeEnrollmentStanding, swunextCriteriaNodes, updateAssessment,
  updateStudentDetails, type ClassWorkspace, type FacultyClass, type FacultyReferenceData, type RosterStudent,
  type SubjectRequest,
} from '@/services/faculty';
import { colors, shadow } from '@/theme/tokens';
import { swunextAssessmentComponents, type SwunextAssessmentComponent } from '@apms/domain';

const emptyWorkspace: ClassWorkspace = { students: [], assessments: [], scores: {}, criteria: null, attendanceSessions: [], attendance: {}, evaluations: {}, feedback: {} };
type StudentFormState = { institutionalId: string; email: string; firstName: string; lastName: string; yearLevel: string; section: string };
const emptyStudentForm: StudentFormState = { institutionalId: '', email: '', firstName: '', lastName: '', yearLevel: '1', section: '' };
type AssessmentFormState = { title: string; component: SwunextAssessmentComponent; maximumScore: string; moduleNumber: string; date: string; gradingPeriod: string; source: 'manual' | 'csv' };
const emptyAssessmentForm: AssessmentFormState = { title: '', component: 'wrap_up_quiz', maximumScore: '100', moduleNumber: '1', date: new Date().toISOString().slice(0, 10), gradingPeriod: 'P1', source: 'manual' };

function buildAssessmentTrend(workspace: ClassWorkspace, visibleIds: Set<string | undefined>) {
  const points = workspace.assessments.flatMap((assessment) => {
    const values = workspace.students.filter((student) => visibleIds.has(student.enrollmentId)).flatMap((student) => {
      const score = workspace.scores[`${student.enrollmentId}:${assessment.id}`];
      return score == null ? [] : [score / assessment.maximumScore * 100];
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
        setWorkspace(nextId ? await loadClassWorkspace(nextId) : emptyWorkspace);
      })
      .catch((cause) => active && setError(cause instanceof Error ? cause.message : 'Unable to load Faculty records.'))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [version, selectedClassId]);
  useEffect(() => {
    const client = supabase;
    if (!user || !client) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleRefresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, 300);
    };
    const channel = client.channel(`faculty-workspace-${user.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    for (const table of ['enrollments', 'assessment_results', 'attendance_records', 'attendance_sessions', 'performance_evaluations', 'performance_predictions']) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, scheduleRefresh);
    }
    channel.subscribe();
    const poll = setInterval(refresh, 60_000);
    return () => { clearInterval(poll); if (timer) clearTimeout(timer); void client.removeChannel(channel); };
  }, [refresh, user]);
  return { classes, references, selectedClassId, setSelectedClassId, workspace, loading, error, refresh };
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
    const value = workspace.scores[`${enrollmentId}:${assessment.id}`];
    return value == null ? [] : [Number(((value / assessment.maximumScore) * 100).toFixed(2))];
  });
}

function missingAssessments(workspace: ClassWorkspace, enrollmentId: string) {
  return workspace.assessments.filter((assessment) => workspace.scores[`${enrollmentId}:${assessment.id}`] == null).length;
}

function riskFor(workspace: ClassWorkspace, enrollmentId: string) {
  const saved = workspace.evaluations[enrollmentId];
  if (saved && saved.riskLevel !== 'unknown') return saved.riskLevel;
  const summary = summarizeEnrollmentStanding(workspace, enrollmentId);
  const score = summary.finalGrade ?? summary.p3 ?? null;
  const attendance = attendanceRate(workspace, enrollmentId);
  if ((score != null && score < 70) || (summary.mastery != null && summary.mastery < 70) || (attendance != null && attendance < 70)) return 'high';
  if ((score != null && score < 80) || (summary.mastery != null && summary.mastery < 80) || (attendance != null && attendance < 80)) return 'medium';
  return 'low';
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
  const riskCounts = ['low', 'medium', 'high'].map((risk) => ({ label: `${risk[0].toUpperCase()}${risk.slice(1)}`, value: filters.filtered.filter((student) => student.risk === risk).length }));
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
  const [assessmentId, setAssessmentId] = useState(props.workspace.assessments[0]?.id ?? '');
  const [values, setValues] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [studentQuery, setStudentQuery] = useState('');
  const [studentFilter, setStudentFilter] = useState<'all' | 'missing' | 'at_risk' | 'passing'>('all');
  const [selectedStudents, setSelectedStudents] = useState<string[]>([]);
  const [bulkScore, setBulkScore] = useState('');
  const [studentSort, setStudentSort] = useState<'name' | 'risk' | 'standing'>('name');
  const [page, setPage] = useState(1);
  const [form, setForm] = useState<AssessmentFormState>(emptyAssessmentForm);

  useEffect(() => {
    if (!props.workspace.assessments.some((item) => item.id === assessmentId)) {
      setAssessmentId(props.workspace.assessments[0]?.id ?? '');
    }
  }, [assessmentId, props.workspace.assessments]);

  const selected = props.workspace.assessments.find((item) => item.id === assessmentId);
  const effectiveScore = (enrollmentId: string) => values[enrollmentId] ?? String(props.workspace.scores[`${enrollmentId}:${assessmentId}`] ?? '');
  const dirtyCount = selected
    ? props.workspace.students.filter((student) => {
        const next = effectiveScore(student.enrollmentId).trim();
        const saved = props.workspace.scores[`${student.enrollmentId}:${selected.id}`];
        return next !== (saved == null ? '' : String(saved));
      }).length
    : 0;
  const visibleStudents = useMemo(() => {
    const normalizedQuery = studentQuery.trim().toLowerCase();
    const filtered = props.workspace.students.filter((student) => {
      const matchesQuery = !normalizedQuery || `${student.name} ${student.institutionalId}`.toLowerCase().includes(normalizedQuery);
      if (!matchesQuery) return false;
      if (studentFilter === 'missing') return effectiveScore(student.enrollmentId).trim() === '';
      if (studentFilter === 'at_risk') return riskFor(props.workspace, student.enrollmentId) !== 'low';
      if (studentFilter === 'passing') return summarizeEnrollmentStanding(props.workspace, student.enrollmentId).remarks === 'passing';
      return true;
    });
    return filtered.sort((a, b) => {
      if (studentSort === 'risk') {
        const rank = { high: 0, medium: 1, low: 2 } as const;
        return rank[riskFor(props.workspace, a.enrollmentId) as keyof typeof rank] - rank[riskFor(props.workspace, b.enrollmentId) as keyof typeof rank];
      }
      if (studentSort === 'standing') return (currentStanding(props.workspace, b.enrollmentId) ?? -1) - (currentStanding(props.workspace, a.enrollmentId) ?? -1);
      return a.name.localeCompare(b.name);
    });
  }, [props.workspace, studentFilter, studentQuery, values, assessmentId, studentSort]);
  const pageSize = 10;
  const pageCount = Math.max(1, Math.ceil(visibleStudents.length / pageSize));
  const pageStudents = visibleStudents.slice((page - 1) * pageSize, page * pageSize);
  useEffect(() => { setPage(1); }, [assessmentId, studentFilter, studentQuery, studentSort, props.selectedClassId, props.workspace.students.length]);
  const resetForm = () => setForm(emptyAssessmentForm);
  const openCreate = () => {
    resetForm();
    setOpen(true);
  };
  const openEdit = () => {
    if (!selected) return;
    setForm({
      title: selected.title,
      component: selected.component,
      maximumScore: String(selected.maximumScore),
      moduleNumber: selected.moduleNumber == null ? '' : String(selected.moduleNumber),
      date: selected.assessmentDate,
      gradingPeriod: selected.gradingPeriod,
      source: selected.source as 'manual' | 'csv',
    });
    setEditOpen(true);
  };

  const assessmentInput = () => ({
    ...form,
    type: form.component,
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

  const save = async () => {
    if (!user || !selected) return;
    const rows = props.workspace.students.flatMap((student) => {
      const raw = values[student.enrollmentId] ?? String(props.workspace.scores[`${student.enrollmentId}:${selected.id}`] ?? '');
      if (!raw.trim()) return [];
      const score = Number(raw);
      if (!Number.isFinite(score) || score < 0 || score > selected.maximumScore) {
        throw new Error(`${student.name}: score must be 0–${selected.maximumScore}.`);
      }
      return [{ enrollmentId: student.enrollmentId, score }];
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

  const toggleStudent = (enrollmentId: string) => {
    setSelectedStudents((current) => current.includes(enrollmentId) ? current.filter((id) => id !== enrollmentId) : [...current, enrollmentId]);
  };

  const selectVisible = () => setSelectedStudents((current) => Array.from(new Set([...current, ...pageStudents.map((student) => student.enrollmentId)])));
  const clearSelection = () => setSelectedStudents([]);
  const clearPageSelection = () => setSelectedStudents((current) => current.filter((id) => !pageStudents.some((student) => student.enrollmentId === id)));
  const applyBulkScore = () => {
    if (!bulkScore.trim() || !selectedStudents.length) return props.toast.show('Select students and enter a score first.');
    const score = Number(bulkScore);
    if (!Number.isFinite(score) || !selected || score < 0 || score > selected.maximumScore) return props.toast.show(`Score must be between 0 and ${selected?.maximumScore ?? 0}.`);
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
        subtitle="Batch score entry using SWUNEXT components. Values are provisional monitoring indicators; official records are kept in SWU SIS."
        action={
          <View style={styles.actions}>
            <Button label="Edit assessment" variant="secondary" disabled={!selected} onPress={openEdit} />
            <Button label="Create assessment" onPress={openCreate} />
          </View>
        }
      />
      <ClassSelect {...props} />
      <SelectField
        label="Assessment"
        value={assessmentId}
        options={props.workspace.assessments.map((item) => ({
          label: `${item.title} · ${componentLabel(item.component)} · ${item.maximumScore} max`,
          value: item.id,
        }))}
        onChange={(value) => {
          setAssessmentId(value);
          setValues({});
          setStudentQuery('');
          setStudentFilter('all');
        }}
      />
      <Card>
        {selected ? (
          <>
            <View style={styles.assessmentContext}>
              <View style={styles.flex}>
                <Text style={styles.assessmentTitle}>{selected.title}</Text>
                <Text style={styles.help}>{componentLabel(selected.component)} · {selected.gradingPeriod}{selected.moduleNumber == null ? '' : ` · Module ${selected.moduleNumber}`}</Text>
              </View>
              <Text style={styles.maxScore}>Max {selected.maximumScore}</Text>
            </View>
            <Text style={styles.help}>{assessmentHelp(selected.component)} Blank scores are excluded from running calculations until recorded.</Text>
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
              <SelectField label="Sort" value={studentSort} options={[{ label: 'Name (A–Z)', value: 'name' }, { label: 'Highest risk first', value: 'risk' }, { label: 'Lowest standing first', value: 'standing' }]} onChange={(value) => setStudentSort(value as typeof studentSort)} containerStyle={styles.studentSort} />
              <Text style={styles.resultCount}>{visibleStudents.length} students · Page {page} of {pageCount}</Text>
            </View>
            <View style={styles.bulkBar}>
              <Button label={pageStudents.length && pageStudents.every((student) => selectedStudents.includes(student.enrollmentId)) ? 'Clear page' : 'Select page'} variant="secondary" onPress={pageStudents.length && pageStudents.every((student) => selectedStudents.includes(student.enrollmentId)) ? clearPageSelection : selectVisible} />
              <Field label="Bulk score" value={bulkScore} placeholder={`0–${selected.maximumScore}`} keyboardType="numeric" onChangeText={setBulkScore} containerStyle={styles.bulkScoreField} />
              <Button label={`Apply to ${selectedStudents.length || 'selected'}`} disabled={!selectedStudents.length || !bulkScore.trim()} onPress={applyBulkScore} />
              <Button label="Paste scores" variant="secondary" onPress={() => void pasteScores()} />
              <Text style={styles.help}>Paste one score per line; values follow the visible student order.</Text>
            </View>
            <View style={styles.gradeHeader}>
              <Text style={styles.gradeHeaderText}>STUDENT</Text>
              <Text style={styles.gradeHeaderText}>MONITORING SUMMARY</Text>
              <Text style={styles.gradeHeaderText}>SCORE / {selected.maximumScore}</Text>
            </View>
            <View style={styles.gradeRows}>
              {pageStudents.map((student) => {
                const summary = summarizeEnrollmentStanding(props.workspace, student.enrollmentId);
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
                  <View style={styles.flex}>
                    <Text style={styles.rowTitle}>{student.name}</Text>
                    <Text style={styles.help}>{student.institutionalId}</Text>
                  </View>
                  <View style={styles.summaryCell}>
                    <View style={styles.badgeRow}>
                      <Badge tone={remarksTone}>{summary.remarks === 'passing' ? 'Passing' : summary.remarks === 'incomplete' ? 'Incomplete' : 'Below rule'}</Badge>
                      <Badge tone={riskTone}>{risk[0].toUpperCase()}{risk.slice(1)} risk</Badge>
                    </View>
                    <Text style={styles.help}>Standing {standing == null ? '—' : `${standing.toFixed(1)}%`} · Mastery {summary.mastery == null ? '—' : `${summary.mastery.toFixed(1)}%`} · Attendance {attendance == null ? '—' : `${attendance.toFixed(0)}%`} · Missing {missingAssessments(props.workspace, student.enrollmentId)}</Text>
                  </View>
                  <Field
                    label="Score"
                    value={effectiveScore(student.enrollmentId)}
                    keyboardType="numeric"
                    onChangeText={(value) => setValues((current) => ({ ...current, [student.enrollmentId]: value }))}
                    containerStyle={styles.scoreField}
                  />
                </View>
                );
              })}
              {!visibleStudents.length ? <PageState kind="empty" title="No matching students" message="Try a different search or filter." /> : null}
            </View>
            {visibleStudents.length > pageSize ? <View style={styles.pagination}><Button label="Previous" variant="secondary" disabled={page <= 1} onPress={() => setPage((current) => Math.max(1, current - 1))} /><Text style={styles.paginationText}>Page {page} of {pageCount} · {visibleStudents.length} students</Text><Button label="Next" variant="secondary" disabled={page >= pageCount} onPress={() => setPage((current) => Math.min(pageCount, current + 1))} /></View> : null}
            <View style={styles.saveBar}>
              <View style={styles.flex}>
                <Text style={styles.saveState}>{dirtyCount ? `${dirtyCount} unsaved change${dirtyCount === 1 ? '' : 's'}` : 'All scores saved'}</Text>
                <Text style={styles.help}>Scores remain provisional monitoring data until recorded in SWU SIS.</Text>
              </View>
              <Button label="Save all scores" loading={saving} disabled={!dirtyCount} onPress={() => void save()} />
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
        saving={saving}
        onChange={setForm}
        onClose={() => { setEditOpen(false); resetForm(); }}
        onSubmit={saveEdit}
        submitLabel="Save assessment changes"
      />
    </>
  );
}

function componentLabel(component: SwunextAssessmentComponent) {
  return swunextAssessmentComponents.find((item) => item.key === component)?.label ?? 'Other monitoring item';
}

function assessmentHelp(component: SwunextAssessmentComponent) {
  if (component === 'start_of_class') return 'Start of Class uses binary encoding: present = 1, absent = 0.';
  if (component === 'lets_practice' || component === 'reflection') return "Use the 0-3 rubric: 0 = 0%, 1 = 60%, 2 = 80%, 3 = 100%.";
  if (component === 'project_checkin') return 'Project check-ins are percentage scores. APMS averages up to four check-ins before applying the project weight.';
  if (component === 'final_project') return 'Final project/output is entered as a percentage or raw score and contributes to mastery.';
  return 'Wrap-up quizzes and other mastery items use the raw percentage from score divided by maximum score.';
}

function AssessmentDialog({ visible, title, form, saving, onChange, onClose, onSubmit, submitLabel }: { visible: boolean; title: string; form: AssessmentFormState; saving: boolean; onChange: (value: AssessmentFormState) => void; onClose: () => void; onSubmit: () => void | Promise<void>; submitLabel: string }) {
  const selectedComponent = swunextAssessmentComponents.find((item) => item.key === form.component);
  const updateComponent = (component: SwunextAssessmentComponent) => onChange({ ...form, component, maximumScore: String(swunextAssessmentComponents.find((item) => item.key === component)?.defaultMaximumScore ?? 100) });
  return <Dialog visible={visible} title={title} onClose={onClose}><Field label="Title" value={form.title} onChangeText={(value) => onChange({ ...form, title: value })} /><View style={styles.formGrid}><SelectField label="SWUNEXT component" value={form.component} options={swunextAssessmentComponents.map((item) => ({ label: item.label, value: item.key }))} onChange={(value) => updateComponent(value as SwunextAssessmentComponent)} containerStyle={styles.statusField} /><Field label="Maximum score" value={form.maximumScore} keyboardType="numeric" onChangeText={(value) => onChange({ ...form, maximumScore: value })} /><Field label="Module number" value={form.moduleNumber} keyboardType="numeric" onChangeText={(value) => onChange({ ...form, moduleNumber: value })} /><Field label="Assessment date" value={form.date} onChangeText={(value) => onChange({ ...form, date: value })} placeholder="YYYY-MM-DD" /><SelectField label="Period view" value={form.gradingPeriod} options={['P1', 'P2', 'P3'].map((value) => ({ label: value, value }))} onChange={(value) => onChange({ ...form, gradingPeriod: value })} containerStyle={styles.statusField} /></View><Text style={styles.help}>{selectedComponent?.label}: {assessmentHelp(form.component)}</Text><SelectField label="Source" value={form.source} options={[{ label: 'Manual', value: 'manual' }, { label: 'CSV', value: 'csv' }]} onChange={(value) => onChange({ ...form, source: value as 'manual' | 'csv' })} /><Button label={submitLabel} loading={saving} disabled={!form.title.trim() || !Number.isFinite(Number(form.maximumScore)) || Number(form.maximumScore) <= 0} onPress={() => void onSubmit()} /></Dialog>;
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
  const name = props.workspace.criteria?.name ?? 'SWUNEXT Global Modules grading criteria';
  const nodes = props.workspace.criteria?.nodes?.length ? props.workspace.criteria.nodes : swunextCriteriaNodes;
  const scoring: Record<string, string> = { 'Start of Class': 'Present = 100; absent = 0', "Let's Practice": '0–3 rubric → 0, 60, 80, 100', Reflection: '0–3 rubric → 0, 60, 80, 100', 'Wrap-Up Quiz': 'Percent score as-is', 'Final Project / Output': 'Check-ins 65% + final output 35%' };
  const passingThreshold = props.workspace.criteria?.passingThreshold ?? 80;
  return <>
    <Heading title="Grading Criteria" subtitle="View the institution-approved SWUNEXT rules used to calculate provisional monitoring indicators." />
    <ClassSelect {...props} />
    <View style={styles.criteriaOverview}>
      <MetricCard label="Components" value={String(nodes.length)} tone="info" />
      <MetricCard label="Total weighting" value={`${nodes.reduce((sum, node) => sum + node.weight, 0)}%`} tone="success" />
      <MetricCard label="Passing standard" value={`${passingThreshold}%`} tone="warning" />
    </View>
    <Card>
      <View style={styles.criteriaIntro}>
        <View style={styles.flex}>
          <Text style={styles.criteriaNameLabel}>Active criteria version</Text>
          <Text style={styles.criteriaName}>{name}</Text>
          {props.workspace.criteria?.version ? <Text style={styles.help}>Version {props.workspace.criteria.version} · Applies to this class</Text> : null}
        </View>
        <Badge tone="info">Read only</Badge>
      </View>
      <Text style={styles.criteriaNote}>These rules are maintained by Academic Admin and cannot be changed by Faculty.</Text>
      <View style={styles.criteriaTable}>
        <View style={styles.criteriaTableHeader}><Text style={[styles.criteriaHeaderText, styles.criteriaComponent]}>COMPONENT</Text><Text style={styles.criteriaHeaderText}>WEIGHT</Text><Text style={[styles.criteriaHeaderText, styles.criteriaScoring]}>HOW IT IS SCORED</Text></View>
        {nodes.map((node) => <View key={node.label} style={styles.criteriaTableRow}><Text style={[styles.criteriaCell, styles.criteriaComponent]}>{node.label}</Text><Text style={styles.criteriaCell}>{node.weight}%</Text><Text style={[styles.criteriaCell, styles.criteriaScoring]}>{scoring[node.label] ?? 'Configured scoring rule'}</Text></View>)}
      </View>
      <View style={styles.criteriaRule}><Text style={styles.criteriaRuleTitle}>Passing rule</Text><Text style={styles.help}>A student passes when the final grade and mastery are both at least {passingThreshold}%. P1 and P2 are cumulative progress views and are not included in the final grade.</Text></View>
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
  const attentionCount = studentRows.filter((row) => row.risk !== 'low').length;
  const highCount = studentRows.filter((row) => row.risk === 'high').length;
  const mediumCount = studentRows.filter((row) => row.risk === 'medium').length;
  const decliningCount = studentRows.filter((row) => row.trend === 'declining').length;
  const missingCount = studentRows.filter((row) => row.missing > 0).length;
  const filteredRows = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return studentRows.filter((row) => {
      if (normalizedQuery && !`${row.student.name} ${row.student.institutionalId}`.toLowerCase().includes(normalizedQuery)) return false;
      if (riskFilter === 'attention' && row.risk === 'low') return false;
      if (riskFilter !== 'attention' && riskFilter !== 'all' && row.risk !== riskFilter) return false;
      if (trendFilter !== 'all' && row.trend !== trendFilter) return false;
      if (concernFilter !== 'all' && row.concernKey !== concernFilter) return false;
      return true;
    }).sort((a, b) => {
      const riskRank = { high: 0, medium: 1, low: 2, unknown: 3 } as const;
      const riskDelta = riskRank[a.risk] - riskRank[b.risk];
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
          <View style={styles.attentionCell}><Badge tone={row.risk === 'high' ? 'danger' : row.risk === 'medium' ? 'warning' : 'success'}>{row.risk[0].toUpperCase()}{row.risk.slice(1)} Risk</Badge></View>
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
           <View style={styles.attentionCell}><Badge tone={row.risk === 'high' ? 'danger' : row.risk === 'medium' ? 'warning' : 'success'}>{row.risk[0].toUpperCase()}{row.risk.slice(1)} Risk</Badge></View>
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
  ]} /><DataTable columns={['Assessment', 'Component', 'Module', 'Score', 'Percent']} rows={workspace.assessments.map((assessment) => { const score = workspace.scores[`${student.enrollmentId}:${assessment.id}`]; return [assessment.title, componentLabel(assessment.component), assessment.moduleNumber == null ? '—' : String(assessment.moduleNumber), score == null ? 'Missing' : `${score}/${assessment.maximumScore}`, score == null ? '—' : `${((score / assessment.maximumScore) * 100).toFixed(1)}%`]; })} /><Text style={styles.help}>Estimated standing: {evaluation?.predictedStanding == null ? 'Unavailable' : `${evaluation.predictedStanding.toFixed(1)}%`}. Missing work: {missing}. Key factors: {(evaluation?.factors.length ? evaluation.factors : ['Current monitoring indicators']).join('; ')}</Text></Dialog>;
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
  screen: { gap: 16 }, flex: { flex: 1 }, heading: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 22, lineHeight: 30, fontWeight: '700', color: colors.text }, subtitle: { fontSize: 13, lineHeight: 19, color: colors.textMuted, marginTop: 3 },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 }, cardTitle: { fontSize: 15, fontWeight: '700', color: colors.text, marginBottom: 12 },
  classSelect: { maxWidth: 460 }, actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, formGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }, sortField: { width: 220 },
  help: { fontSize: 12, lineHeight: 18, color: colors.textMuted }, rowTitle: { fontSize: 13, fontWeight: '600', color: colors.text },
  criteriaNameLabel: { fontSize: 12, fontWeight: '700', color: colors.textMuted, marginBottom: 6 }, criteriaName: { fontSize: 16, fontWeight: '700', color: colors.text, padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.surfaceMuted },
  criteriaOverview: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 }, criteriaIntro: { flexDirection: 'row', alignItems: 'flex-start', gap: 14 }, criteriaNote: { fontSize: 12, lineHeight: 18, color: colors.textMuted, marginTop: 10, marginBottom: 16 }, criteriaTable: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, overflow: 'hidden' }, criteriaTableHeader: { flexDirection: 'row', gap: 12, padding: 12, backgroundColor: colors.surfaceMuted, borderBottomWidth: 1, borderColor: colors.border }, criteriaTableRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 58, padding: 12, borderBottomWidth: 1, borderColor: colors.border }, criteriaHeaderText: { flex: 0.7, fontSize: 10, fontWeight: '700', letterSpacing: 0.5, color: colors.textMuted }, criteriaCell: { flex: 0.7, fontSize: 13, lineHeight: 18, color: colors.text }, criteriaComponent: { flex: 1.1 }, criteriaScoring: { flex: 2.4 }, criteriaRule: { padding: 14, marginTop: 16, borderRadius: 10, backgroundColor: '#F7ECE9' }, criteriaRuleTitle: { fontSize: 13, fontWeight: '700', color: colors.brand, marginBottom: 4 },
  attentionMetrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 }, attentionMetric: { flex: 1, minWidth: 135, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, ...shadow }, attentionMetricValue: { fontSize: 22, fontWeight: '700', color: colors.text }, attentionMetricLabel: { marginTop: 3, fontSize: 11, color: colors.textMuted }, dangerText: { color: colors.danger }, warningText: { color: colors.warning }, successText: { color: colors.success },
  predictionNotice: { gap: 6, borderLeftWidth: 4, borderLeftColor: colors.warning }, predictionNoticeRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10 }, predictionNoticeTitle: { fontSize: 13, fontWeight: '700', color: colors.text }, predictionMetrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 }, predictionMetric: { flex: 1, minWidth: 135, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, ...shadow }, predictionMetricValue: { fontSize: 22, fontWeight: '700', color: colors.text }, predictionMetricLabel: { marginTop: 3, fontSize: 11, color: colors.textMuted }, predictionToolbar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', gap: 10, marginBottom: 14 }, predictionFilter: { width: 180 }, predictionSectionLabel: { fontSize: 13, fontWeight: '700', color: colors.text, marginBottom: 4 },
  attentionToolbar: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end', marginBottom: 14 }, attentionFilter: { width: 170 }, attentionTableHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, borderBottomWidth: 1, borderColor: colors.border }, attentionHeaderText: { flex: 0.8, fontSize: 10, fontWeight: '700', letterSpacing: 0.5, color: colors.textMuted }, attentionStudent: { flex: 1.45 }, attentionConcern: { flex: 1.55 }, attentionRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 70, paddingVertical: 9, borderBottomWidth: 1, borderColor: colors.border }, attentionCell: { flex: 0.8, minWidth: 0, fontSize: 12, color: colors.text }, cellStrong: { fontSize: 12, fontWeight: '600', color: colors.text }, reviewAction: { flex: 0.8, paddingVertical: 8 }, reviewActionText: { color: colors.brand, fontSize: 12, fontWeight: '700' }, attentionCount: { fontSize: 11, color: colors.textMuted, marginTop: 12 },
  assessmentContext: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingBottom: 12, marginBottom: 8, borderBottomWidth: 1, borderColor: colors.border }, assessmentTitle: { fontSize: 16, fontWeight: '700', color: colors.text }, maxScore: { fontSize: 13, fontWeight: '700', color: colors.brand },
  gradeToolbar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', gap: 10, marginTop: 16, marginBottom: 12 }, studentSearch: { flex: 1, minWidth: 220 }, studentFilter: { width: 190 }, studentSort: { width: 190 }, resultCount: { fontSize: 12, color: colors.textMuted, paddingBottom: 12 },
  bulkBar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', gap: 8, padding: 10, marginBottom: 12, borderRadius: 10, backgroundColor: colors.surfaceMuted }, bulkScoreField: { width: 110 },
  gradeHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, paddingLeft: 34, borderBottomWidth: 1, borderColor: colors.border }, gradeHeaderText: { flex: 1, fontSize: 10, fontWeight: '700', letterSpacing: 0.7, color: colors.textMuted },
  gradeRows: { gap: 0, marginBottom: 16 }, gradeRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 76, paddingVertical: 10, borderBottomWidth: 1, borderColor: colors.border }, studentCheck: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderRadius: 5, borderColor: colors.border }, studentCheckSelected: { backgroundColor: colors.brand, borderColor: colors.brand }, studentCheckText: { color: colors.surface, fontWeight: '700' },
  summaryCell: { flex: 1, gap: 4 }, badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 }, scoreField: { width: 120 }, saveBar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12, paddingTop: 12 }, saveState: { fontSize: 13, fontWeight: '700', color: colors.text }, statusField: { width: 170 }, overlay: { flex: 1, backgroundColor: '#00000066', alignItems: 'center', justifyContent: 'center', padding: 24 },
  rosterCheckbox: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderRadius: 5, borderColor: colors.border }, rosterCheckboxSelected: { backgroundColor: colors.brand, borderColor: colors.brand }, rosterCheckboxMark: { color: colors.surface, fontWeight: '700' }, pagination: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingTop: 14 }, paginationText: { color: colors.textMuted, fontSize: 12 }, attendanceToolbar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingBottom: 4 }, attendanceRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 58, paddingVertical: 6, borderBottomWidth: 1, borderColor: colors.border }, attendanceStatusField: { width: 145 }, inlineStudentSearch: { gap: 6 }, inlineStudentOptions: { maxHeight: 220, borderWidth: 1, borderColor: colors.border, borderRadius: 10 }, inlineStudentOption: { paddingHorizontal: 12, paddingVertical: 9, borderBottomWidth: 1, borderColor: colors.border }, inlineStudentOptionSelected: { backgroundColor: '#F7ECE9' }, inlineStudentOptionText: { color: colors.text, fontSize: 14 }, inlineStudentOptionTextSelected: { color: colors.brand, fontWeight: '700' }, inlineStudentEmpty: { color: colors.textMuted, fontSize: 13, padding: 12, textAlign: 'center' },
  feedbackBox: { minHeight: 150, paddingTop: 10, textAlignVertical: 'top' }, aiPrompt: { color: colors.text, backgroundColor: colors.canvas, borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 12, fontSize: 12, lineHeight: 18 },
  analyticsCharts: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  dialog: { width: '100%', maxWidth: 920, maxHeight: '90%', padding: 22 }, dialogTitle: { fontSize: 19, fontWeight: '700', color: colors.text }, dialogScroll: { flexShrink: 1, marginTop: 16 }, dialogBody: { gap: 14, paddingBottom: 4 }, dialogContent: { gap: 12 }, dialogFooter: { borderTopWidth: 1, borderColor: colors.border, paddingTop: 14, marginTop: 14 }, close: { fontSize: 28, color: colors.textMuted },
});
