import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Modal, Platform, Pressable, Share, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/auth/AuthProvider';
import { supabase } from '@/services/supabase';
import { Badge, Button, Card, DataTable, Field, MetricCard, PageState, SelectField, useToast } from '@/components/ui';
import { useAnalyticsFilters } from '@/components/charts/AnalyticsFilters';
import { VisualizationPanel } from '@/components/charts/VisualizationPanel';
import {
  academicReportCsv, loadAcademicWorkspace, loadDepartmentSubjects, loadSubjectRequests,
  manageSubject, reviewSubjectRequest, type AcademicSubject, type AcademicSubjectRequest, type AcademicWorkspace,
} from '@/services/academic';
import { saveCriteria, summarizeEnrollmentStanding, swunextCriteriaNodes, type ClassWorkspace } from '@/services/faculty';
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

function risk(workspace: ClassWorkspace, enrollmentId: string) {
  const saved = workspace.evaluations[enrollmentId]?.riskLevel;
  if (saved && saved !== 'unknown') return saved;
  const summary = summarizeEnrollmentStanding(workspace, enrollmentId); const score = summary.finalGrade ?? summary.p3 ?? null; const rate = attendance(workspace, enrollmentId);
  if ((score != null && score < 70) || (summary.mastery != null && summary.mastery < 70) || (rate != null && rate < 70)) return 'high';
  if ((score != null && score < 80) || (summary.mastery != null && summary.mastery < 80) || (rate != null && rate < 80)) return 'medium';
  return 'low';
}

function useWorkspace(userId: string) {
  const [data, setData] = useState<AcademicWorkspace | null>(null); const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  useEffect(() => { let active = true; setLoading(true); setError(''); loadAcademicWorkspace(userId).then((value) => active && setData(value)).catch((cause) => active && setError(cause instanceof Error ? cause.message : 'Unable to load academic records.')).finally(() => active && setLoading(false)); return () => { active = false; }; }, [userId, version]);
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
  return { data, loading, error, refresh };
}

export function AcademicAdminPortalContent({ screen }: { screen: string }) {
  const { user } = useAuth(); const state = useWorkspace(user?.id ?? ''); const toast = useToast();
  if (!user) return <PageState kind="error" title="Session required" message="Sign in again to continue." />;
  if (state.loading) return <PageState kind="loading" title="Loading Academic Admin workspace" message="Retrieving department-scoped monitoring records." />;
  if (state.error || !state.data) return <PageState kind="error" title="Academic data unavailable" message={state.error || 'No department scope is assigned.'} action={<Button label="Retry" onPress={state.refresh} />} />;
  const props = { data: state.data, refresh: state.refresh, userId: user.id, toast };
  return <View style={styles.screen}>
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
function allStudents(data: AcademicWorkspace) { return data.classes.flatMap((item) => item.workspace.students.map((student) => ({ item, student, score: standing(item.workspace, student.enrollmentId), rate: attendance(item.workspace, student.enrollmentId), risk: risk(item.workspace, student.enrollmentId) }))); }

function Overview({ data }: Props) {
  const rows = allStudents(data); const unique = new Set(rows.map(({ student }) => student.studentId)); const alertRows = rows.filter((row) => row.risk !== 'low'); const scores = rows.flatMap((row) => row.score == null ? [] : [row.score]);
  const chartRecords = rows.flatMap((row) => row.score == null ? [] : [{ id: row.student.enrollmentId, label: row.student.name, score: row.score, risk: row.risk, classification: summarizeEnrollmentStanding(row.item.workspace, row.student.enrollmentId).remarks, category: `${row.item.code} · ${row.item.section}`, timestamp: row.item.workspace.assessments.at(-1)?.assessmentDate }]);
  const filters = useAnalyticsFilters(chartRecords);
  const visibleIds = new Set(filters.filtered.map((record) => record.id));
  const scoreByClass = data.classes.flatMap((item) => {
    const values = filters.filtered.filter((record) => record.category === `${item.code} · ${item.section}`).map((record) => record.score);
    return values.length ? [{ label: `${item.code} ${item.section}`, value: values.reduce((sum, value) => sum + value, 0) / values.length }] : [];
  });
  const riskCounts = ['low', 'medium', 'high'].map((level) => ({ label: `${level[0].toUpperCase()}${level.slice(1)}`, value: filters.filtered.filter((row) => row.risk === level).length }));
  const filteredAlerts = alertRows.filter((row) => visibleIds.has(row.student.enrollmentId));
  return <><Heading title="Academic Administration Dashboard" subtitle={`Live, department-scoped monitoring for ${data.department?.name ?? 'your assigned academic unit'}. Official grades remain in SWU SIS.`} /><View style={styles.metrics}><MetricCard label="Active classes" value={String(data.classes.length)} /><MetricCard label="Students monitored" value={String(unique.size)} tone="info" /><MetricCard label="At-risk class records" value={String(alertRows.length)} tone={alertRows.length ? 'danger' : 'success'} /><MetricCard label="Average current standing" value={scores.length ? `${(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)}%` : '—'} tone="success" /></View>{filters.controls}<View style={styles.analyticsCharts}><VisualizationPanel title="Average score by class" description="Current provisional standing by department class for matching student records." data={scoreByClass} type="bar" suffix="%" /><VisualizationPanel title="Risk distribution" description="Current advisory risk for matching class records." data={riskCounts} type="pie" /></View><Card><Text style={styles.cardTitle}>Priority monitoring</Text>{filteredAlerts.length ? <DataTable columns={['Student', 'Class', 'Current', 'Attendance', 'Risk']} rows={filteredAlerts.slice(0, 15).map((row) => [row.student.name, `${row.item.code} · ${row.item.section}`, row.score == null ? 'Missing' : `${row.score.toFixed(1)}%`, row.rate == null ? 'No data' : `${row.rate.toFixed(0)}%`, `${row.risk[0].toUpperCase()}${row.risk.slice(1)} Risk`])} /> : <PageState kind="empty" title="No active alerts" message="Alerts appear when department records indicate performance or attendance concern." />}</Card></>;
}
function Units({ data }: Props) { return <><Heading title="Academic Units" subtitle="Authorized department and program scope for this Academic Admin account." /><Card><DataTable columns={['Department', 'Code', 'Access']} rows={data.department ? [[data.department.name, data.department.code, 'Authorized']] : []} /></Card><Card><Text style={styles.cardTitle}>Programs</Text>{data.programs.length ? <DataTable columns={['Program', 'Code', 'Status']} rows={data.programs.map((program) => [program.name, program.code, 'Active'])} /> : <PageState kind="empty" title="No active programs" message="No program records are available in this department." />}</Card></>; }
function Classes({ data }: Props) { return <><Heading title="Classes Overview" subtitle="Read-only operational oversight of classes in your authorized department." /><Card>{data.classes.length ? <DataTable columns={['Subject', 'Section', 'Term', 'Students', 'Average', 'At risk']} rows={data.classes.map((item) => { const rows = item.workspace.students; const values = rows.flatMap((student) => { const value = standing(item.workspace, student.enrollmentId); return value == null ? [] : [value]; }); return [`${item.code} · ${item.title}`, item.section, item.term, String(rows.length), values.length ? `${(values.reduce((a, b) => a + b, 0) / values.length).toFixed(1)}%` : '—', String(rows.filter((student) => risk(item.workspace, student.enrollmentId) !== 'low').length)]; })} /> : <PageState kind="empty" title="No active classes" message="Faculty-created monitoring classes in this department will appear here." />}</Card></>; }
function Students({ data }: Props) { const rows = allStudents(data); return <><Heading title="Student Monitoring" subtitle="Aggregated SWUNEXT provisional standing, mastery, attendance, and risk across authorized classes." /><Card>{rows.length ? <DataTable columns={['Student ID', 'Student', 'Program', 'Class', 'Current', 'Mastery', 'Attendance', 'Risk']} rows={rows.map((row) => { const summary = summarizeEnrollmentStanding(row.item.workspace, row.student.enrollmentId); return [row.student.institutionalId, row.student.name, row.student.program, `${row.item.code} · ${row.item.section}`, row.score == null ? 'Missing' : `${row.score.toFixed(1)}%`, summary.mastery == null ? 'Missing' : `${summary.mastery.toFixed(1)}%`, row.rate == null ? 'No data' : `${row.rate.toFixed(0)}%`, `${row.risk[0].toUpperCase()}${row.risk.slice(1)} Risk`]; })} /> : <PageState kind="empty" title="No students to monitor" message="Faculty can add students manually or by CSV to populate department monitoring." />}</Card></>; }
function Risk({ data }: Props) { const rows = allStudents(data).filter((row) => row.risk !== 'low'); return <><Heading title="At-Risk Overview" subtitle="Decision support from SWUNEXT APMS records and saved AI-assisted evaluations; not an official SIS grade determination." /><Card>{rows.length ? <DataTable columns={['Student', 'Class', 'Current', 'Mastery', 'Estimated standing', 'Attendance', 'Trend', 'Risk']} rows={rows.map((row) => { const evaluation = row.item.workspace.evaluations[row.student.enrollmentId]; const summary = summarizeEnrollmentStanding(row.item.workspace, row.student.enrollmentId); return [row.student.name, `${row.item.code} · ${row.item.section}`, row.score == null ? 'Missing' : `${row.score.toFixed(1)}%`, summary.mastery == null ? 'Missing' : `${summary.mastery.toFixed(1)}%`, evaluation?.predictedStanding == null ? 'Unavailable' : `${evaluation.predictedStanding.toFixed(1)}%`, row.rate == null ? 'No data' : `${row.rate.toFixed(0)}%`, evaluation?.trend ?? 'unknown', `${row.risk[0].toUpperCase()}${row.risk.slice(1)} Risk`]; })} /> : <PageState kind="empty" title="No at-risk records" message="No authorized student records currently meet the configured warning thresholds." />}</Card></>; }
function Criteria({ data, userId, refresh, toast }: Props) {
  const [classId, setClassId] = useState(data.classes[0]?.id ?? ''); const selected = data.classes.find((item) => item.id === classId); const [name, setName] = useState(selected?.workspace.criteria?.name ?? 'SWUNEXT Global Modules grading criteria'); const [saving, setSaving] = useState(false);
  const submit = async () => { if (!classId) return; setSaving(true); try { await saveCriteria(classId, userId, name, 80, swunextCriteriaNodes); toast.show('A SWUNEXT criteria version was saved for this class.'); refresh(); } catch (cause) { toast.show(cause instanceof Error ? cause.message : 'Criteria could not be saved.'); } finally { setSaving(false); } };
  return <><Heading title="Evaluation Criteria" subtitle="Create transparent, versioned SWUNEXT monitoring criteria for an authorized class." /><Card style={styles.form}><SelectField label="Class" value={classId} options={data.classes.map((item) => ({ label: `${item.code} · ${item.section}`, value: item.id }))} onChange={setClassId} /><Field label="Criteria name" value={name} onChangeText={setName} /><DataTable columns={['Component', 'Weight']} rows={swunextCriteriaNodes.map((node) => [node.label, `${node.weight}%`])} /><Text style={styles.help}>Total: 100%. Passing requires at least 80% final grade and at least 80% mastery. P1/P2 are running views; SWU SIS remains authoritative for official grades.</Text><Button label="Save SWUNEXT criteria version" loading={saving} onPress={() => void submit()} /></Card></>;
}
function Analytics({ data, toast }: Props) {
  const rows = allStudents(data);
  const records = rows.flatMap((row) => {
    const summary = summarizeEnrollmentStanding(row.item.workspace, row.student.enrollmentId);
    const score = row.score;
    return score == null ? [] : [{ id: row.student.enrollmentId, label: row.student.name, score, risk: row.risk, classification: summary.remarks, category: `${row.item.code} · ${row.item.section}`, timestamp: row.item.workspace.assessments.at(-1)?.assessmentDate }];
  });
  const filters = useAnalyticsFilters(records);
  const visible = filters.filtered;
  const exportCsv = async () => { const csv = academicReportCsv(data); if (Platform.OS === 'web') { const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'apms-academic-monitoring-report.csv'; anchor.click(); URL.revokeObjectURL(url); } else await Share.share({ message: csv }); toast.show('Department monitoring report exported.'); };
  const low = visible.filter((row) => row.risk === 'low').length;
  const medium = visible.filter((row) => row.risk === 'medium').length;
  const high = visible.filter((row) => row.risk === 'high').length;
  const passing = visible.filter((row) => row.classification === 'passing').length;
  const failing = visible.filter((row) => row.classification === 'failing').length;
  const scoreByClass = data.classes.map((item) => {
    const classLabel = `${item.code} · ${item.section}`;
    const scores = visible.filter((row) => row.category === classLabel).map((row) => row.score);
    return scores.length ? { label: `${item.code} ${item.section}`, value: scores.reduce((sum, score) => sum + score, 0) / scores.length } : null;
  }).filter((item): item is { label: string; value: number } => item !== null);
  const passFail = [{ label: 'Meets rule', value: passing }, { label: 'Below or incomplete', value: visible.length - passing }];
  const scoreDistribution = visible.map((item) => ({ label: item.label, value: item.score, kind: 'continuous' as const }));
  return <><Heading title="Analytics & Reports" subtitle="Department-level analytics and provisional SWUNEXT passing-rule comparisons from authorized APMS data." action={<Button label="Export CSV" onPress={() => void exportCsv()} />} />{filters.controls}<View style={styles.metrics}><MetricCard label="Passing rule met" value={String(passing)} tone="success" /><MetricCard label="Below rule" value={String(failing)} tone="warning" /><MetricCard label="Medium risk" value={String(medium)} tone="warning" /><MetricCard label="High risk" value={String(high)} tone="danger" /></View><View style={styles.analyticsCharts}><VisualizationPanel title="Average score by class" description="Mean current SWUNEXT standing by class for records matching these filters." data={scoreByClass} type="bar" suffix="%" /><VisualizationPanel title="Student score histogram" description="Filtered continuous scores grouped into score bands." data={scoreDistribution} type="histogram" suffix="%" /><VisualizationPanel title="Risk distribution" description={`Low ${low} · Medium ${medium} · High ${high}`} data={[{ label: 'Low', value: low }, { label: 'Medium', value: medium }, { label: 'High', value: high }]} type="pie" /><VisualizationPanel title="Passing rule status" description="Binary pass and not yet passing classification." data={passFail} type="pie" /></View><Card><Text style={styles.cardTitle}>Class and subject comparison</Text>{data.classes.length ? <DataTable columns={['Subject / class', 'Recorded standings', 'Passing rule met', 'Below rule', 'Risk alerts']} rows={data.classes.map((item) => { const classRows = allStudents({ ...data, classes: [item] }); const classSummaries = classRows.map((row) => summarizeEnrollmentStanding(row.item.workspace, row.student.enrollmentId)); const classRecorded = classSummaries.filter((summary) => summary.finalGrade != null || summary.p3 != null || summary.mastery != null); return [`${item.code} · ${item.section}`, String(classRecorded.length), String(classSummaries.filter((summary) => summary.remarks === 'passing').length), String(classSummaries.filter((summary) => summary.remarks === 'failing').length), String(classRows.filter((row) => row.risk !== 'low').length)]; })} /> : <PageState kind="empty" title="No comparison data" message="Class comparisons appear after monitoring classes are created." />}<Text style={styles.help}>Passing requires both 80% final grade and 80% mastery. P1/P2 remain running views. These are provisional APMS indicators, not official SIS pass/fail grades. Filters apply to KPI and chart summaries; the CSV includes all authorized department rows.</Text></Card></>;
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
      toast.show(err instanceof Error ? err.message : 'Unable to load subjects');
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
      toast.show(cause instanceof Error ? cause.message : 'Failed to save subject.');
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
      toast.show(cause instanceof Error ? cause.message : 'Failed to review request.');
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
