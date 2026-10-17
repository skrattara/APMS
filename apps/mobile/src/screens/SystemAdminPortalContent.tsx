import { getErrorMessage } from '@/services/errors';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/auth/AuthProvider';
import { supabase } from '@/services/supabase';
import { Button, Card, ConfirmDialog, DataTable, DateField, Field, MetricCard, PageState, RefreshIndicator, SelectField, useToast } from '@/components/ui';
import { VisualizationPanel } from '@/components/charts/VisualizationPanel';
import { ReportComposer } from '@/components/reports/ReportComposer';
import { AIServiceSettings } from '@/components/AIServiceSettings';
import { Settings as AccountSettings } from '@/screens/AppPortalScreen';
import { createManagedUser, deleteProgram, loadAdminWorkspace, queueBackup, saveAcademicTerm, saveDepartment, saveProgram, saveSystemSetting, updateManagedUser, type AcademicTermRecord, type AdminWorkspace, type DepartmentRecord, type ManagedUser, type ProgramRecord } from '@/services/admin';
import { IT_GLOBAL_GRADING_SYSTEM, type GradingDefinition } from '@apms/domain';
import { colors } from '@/theme/tokens';

type CoreRole = 'system_admin' | 'academic_admin' | 'faculty';
const roleOptions = [{ label: 'System Admin', value: 'system_admin' }, { label: 'Academic Admin', value: 'academic_admin' }, { label: 'Faculty', value: 'faculty' }];

function useWorkspace() {
  const { user } = useAuth();
  const [data, setData] = useState<AdminWorkspace | null>(null); const [loading, setLoading] = useState(true); const [refreshing, setRefreshing] = useState(false); const [error, setError] = useState(''); const [version, setVersion] = useState(0);
  const hasLoadedWorkspace = useRef(false);
  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  useEffect(() => { let active = true; if (hasLoadedWorkspace.current) setRefreshing(true); else setLoading(true); loadAdminWorkspace().then((value) => { if (!active) return; setData(value); setError(''); hasLoadedWorkspace.current = true; }).catch((cause) => { if (active && !hasLoadedWorkspace.current) setError(getErrorMessage(cause, 'Unable to load system administration records.')); }).finally(() => { if (active) { setLoading(false); setRefreshing(false); } }); return () => { active = false; }; }, [version]);
  useEffect(() => {
    const client = supabase;
    if (!user || !client) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleRefresh = () => { if (timer) clearTimeout(timer); timer = setTimeout(refresh, 300); };
    const channel = client.channel(`system-admin-dashboard-${user.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    for (const table of ['profiles', 'user_roles', 'audit_logs', 'backups']) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, scheduleRefresh);
    }
    channel.subscribe();
    const poll = setInterval(refresh, 60_000);
    return () => { clearInterval(poll); if (timer) clearTimeout(timer); void client.removeChannel(channel); };
  }, [refresh, user]);
  return { data, loading, refreshing, error, refresh };
}

export function SystemAdminPortalContent({ screen }: { screen: string }) {
  const { user } = useAuth(); const state = useWorkspace(); const toast = useToast();
  if (!user) return <PageState kind="error" title="Session required" message="Sign in again to continue." />;
  if (state.loading) return <PageState kind="loading" title="Loading System Admin workspace" message="Retrieving users, permissions, settings, backups, and audit activity." />;
  if (state.error || !state.data) return <PageState kind="error" title="System administration unavailable" message={state.error || 'No administration data is available.'} action={<Button label="Retry" onPress={state.refresh} />} />;
  const props = { data: state.data, refresh: state.refresh, userId: user.id, toast };
  return <View style={styles.screen}>
    <RefreshIndicator visible={state.refreshing} />
    {screen === 'overview' ? <Overview {...props} /> : null}
    {screen === 'admins' ? <Users {...props} /> : null}
    {screen === 'setup' ? <AcademicSetup {...props} /> : null}
    {screen === 'roles' ? <Roles {...props} /> : null}
    {screen === 'backup' ? <Backups {...props} /> : null}
    {screen === 'logs' ? <Logs {...props} /> : null}
    {screen === 'reports' ? <SystemReports {...props} /> : null}
    {screen === 'system' ? <SystemSettings {...props} /> : null}
    {screen === 'settings' ? <Info onMessage={toast.show} /> : null}
  </View>;
}

type Props = { data: AdminWorkspace; refresh: () => void; userId: string; toast: ReturnType<typeof useToast> };
function Heading({ title, subtitle, action }: { title: string; subtitle: string; action?: ReactNode }) { return <View style={styles.heading}><View style={styles.flex}><Text accessibilityRole="header" style={styles.title}>{title}</Text><Text style={styles.subtitle}>{subtitle}</Text></View>{action}</View>; }
function displayRole(role: ManagedUser['role']) { return role === 'system_admin' ? 'System Admin' : role === 'academic_admin' ? 'Academic Admin' : role === 'faculty' ? 'Faculty' : 'Unassigned'; }
function date(value: string | null) { return value ? new Date(value).toLocaleString() : 'Never'; }

function Overview({ data }: Props) {
  const [roleFilter, setRoleFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const active = data.users.filter((user) => user.status === 'active').length;
  const queued = data.backups.filter((row) => row.status === 'queued' || row.status === 'running').length;
  const visibleUsers = data.users.filter((user) => (roleFilter === 'all' || user.role === roleFilter) && (statusFilter === 'all' || user.status === statusFilter));
  const roleSeries = ['system_admin', 'academic_admin', 'faculty', 'unassigned'].map((role) => ({ label: displayRole(role === 'unassigned' ? null : role as ManagedUser['role']), value: visibleUsers.filter((user) => (user.role ?? 'unassigned') === role).length }));
  const statusSeries = ['active', 'inactive', 'suspended'].map((status) => ({ label: `${status[0].toUpperCase()}${status.slice(1)}`, value: visibleUsers.filter((user) => user.status === status).length }));
  const logsByDay = new Map<string, number>();
  for (const row of data.logs) { const day = row.createdAt.slice(0, 10); logsByDay.set(day, (logsByDay.get(day) ?? 0) + 1); }
  const auditTrend = [...logsByDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, value]) => ({ label: new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), value, kind: 'timeseries' as const, timestamp: day }));
  return <><Heading title="System Administration Dashboard" subtitle="Live operational status for APMS accounts, access control, audit activity, and protected backups." /><View style={styles.metrics}><MetricCard label="User accounts" value={String(data.users.length)} /><MetricCard label="Active accounts" value={String(active)} tone="success" /><MetricCard label="Recent audit entries" value={String(data.logs.length)} tone="info" /><MetricCard label="Backups pending" value={String(queued)} tone={queued ? 'warning' : 'success'} /></View><View style={styles.userChartFilters}><SelectField label="User role" value={roleFilter} options={[{ label: 'All roles', value: 'all' }, ...roleOptions]} onChange={setRoleFilter} containerStyle={styles.filter} /><SelectField label="Account status" value={statusFilter} options={[{ label: 'All statuses', value: 'all' }, ...['active', 'inactive', 'suspended'].map((value) => ({ label: `${value[0].toUpperCase()}${value.slice(1)}`, value }))]} onChange={setStatusFilter} containerStyle={styles.filter} /></View><Text style={styles.chartCount}>Showing {visibleUsers.length.toLocaleString()} of {data.users.length.toLocaleString()} accounts</Text><View style={styles.analyticsCharts}><VisualizationPanel title="Accounts by role" description="Role distribution for filtered accounts." data={roleSeries} type="pie" /><VisualizationPanel title="Account status" description="Active, inactive, and suspended accounts." data={statusSeries} type="pie" /><VisualizationPanel title="Audit activity" description="Audit entries per day from the latest 100 authorized records." data={auditTrend} type="line" /></View><Card><Text style={styles.cardTitle}>Recent audit activity</Text>{data.logs.length ? <DataTable columns={['Time', 'Action', 'Entity', 'Actor', 'Status']} rows={data.logs.slice(0, 10).map((row) => [date(row.createdAt), row.action, row.entityType, row.actorId ?? 'System', 'Recorded'])} /> : <PageState kind="empty" title="No audit activity" message="Permission-checked administration events will appear here." />}</Card></>;
}

function Users({ data, refresh, toast }: Props) {
  const [createOpen, setCreateOpen] = useState(false); const [selected, setSelected] = useState<ManagedUser | null>(null); const [saving, setSaving] = useState(false);
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [firstName, setFirstName] = useState(''); const [lastName, setLastName] = useState(''); const [role, setRole] = useState<CoreRole>('faculty'); const [departmentId, setDepartmentId] = useState(data.departments[0]?.id ?? ''); const [employeeId, setEmployeeId] = useState('');
  const [editRole, setEditRole] = useState<CoreRole>('faculty'); const [editDepartment, setEditDepartment] = useState(data.departments[0]?.id ?? ''); const [editEmployeeId, setEditEmployeeId] = useState(''); const [editPassword, setEditPassword] = useState('');
  const openManage = (user: ManagedUser) => { setSelected(user); setEditRole(user.role ?? 'faculty'); setEditDepartment(user.scopeId ?? data.departments[0]?.id ?? ''); setEditEmployeeId(''); setEditPassword(''); };
  const create = async () => { setSaving(true); try { await createManagedUser({ email, password, firstName, lastName, role, departmentId: role === 'system_admin' ? undefined : departmentId, employeeId: role === 'faculty' ? employeeId : undefined }); setCreateOpen(false); setEmail(''); setPassword(''); setFirstName(''); setLastName(''); setEmployeeId(''); toast.show('Account created and APMS role assigned.'); refresh(); } catch (cause) { toast.show(getErrorMessage(cause, 'Could not create the account. Check the details and try again.')); } finally { setSaving(false); } };
  const update = async (status?: ManagedUser['status']) => { if (!selected) return; setSaving(true); try { await updateManagedUser({ userId: selected.id, status, role: editRole, departmentId: editRole === 'system_admin' ? undefined : editDepartment, employeeId: editRole === 'faculty' ? editEmployeeId || undefined : undefined, password: editPassword || undefined }); setSelected(null); toast.show('Account role, scope, and status were updated.'); refresh(); } catch (cause) { toast.show(getErrorMessage(cause, 'Account update failed.')); } finally { setSaving(false); } };
  const activeDepartments = data.departments.filter((department) => department.status === 'active');
  return <><Heading title="User Management" subtitle="Create and manage the three core APMS roles. Passwords are set through the protected server endpoint and are never displayed." action={<Button label="Create user" onPress={() => setCreateOpen(true)} />} /><Card>{data.users.length ? <DataTable columns={['Name', 'Email', 'Role', 'Scope', 'Last login', 'Manage', 'Status']} rows={data.users.map((user) => [`${user.firstName} ${user.lastName}`, user.email, displayRole(user.role), user.scopeType === 'global' ? 'Global' : data.departments.find((department) => department.id === user.scopeId)?.code ?? 'Unassigned', date(user.lastLoginAt), <Button key={user.id} label="Manage" variant="secondary" onPress={() => openManage(user)} />, `${user.status[0].toUpperCase()}${user.status.slice(1)}`])} /> : <PageState kind="empty" title="No APMS users" message="Create a System Admin, Academic Admin, or Faculty account." />}</Card>
    <Dialog visible={createOpen} title="Create APMS account" onClose={() => setCreateOpen(false)}><View style={styles.formGrid}><Field label="First name" value={firstName} onChangeText={setFirstName} /><Field label="Last name" value={lastName} onChangeText={setLastName} /><Field label="Institutional email" value={email} keyboardType="email-address" onChangeText={setEmail} /><Field label="Temporary password (12+ characters)" value={password} secureTextEntry onChangeText={setPassword} /></View><SelectField label="Core role" value={role} options={roleOptions} onChange={(value) => setRole(value as CoreRole)} />{role !== 'system_admin' ? <SelectField label="Department scope" value={departmentId} options={activeDepartments.map((department) => ({ label: `${department.code} · ${department.name}`, value: department.id }))} onChange={setDepartmentId} /> : null}{role === 'faculty' ? <Field label="Employee ID" value={employeeId} onChangeText={setEmployeeId} /> : null}<Button label="Create account" loading={saving} disabled={!email.trim() || password.length < 12 || !firstName.trim() || !lastName.trim() || (role !== 'system_admin' && !departmentId) || (role === 'faculty' && !employeeId.trim())} onPress={() => void create()} /></Dialog>
    <Dialog visible={Boolean(selected)} title="Manage account" onClose={() => setSelected(null)}>{selected ? <><Text style={styles.cardTitle}>{selected.firstName} {selected.lastName}</Text><Text style={styles.help}>{selected.email}</Text><SelectField label="Core role" value={editRole} options={roleOptions} onChange={(value) => setEditRole(value as CoreRole)} />{editRole !== 'system_admin' ? <SelectField label="Department scope" value={editDepartment} options={activeDepartments.map((department) => ({ label: `${department.code} · ${department.name}`, value: department.id }))} onChange={setEditDepartment} /> : null}{editRole === 'faculty' && selected.role !== 'faculty' ? <Field label="Employee ID required for new Faculty role" value={editEmployeeId} onChangeText={setEditEmployeeId} /> : null}<Field label="New temporary password (optional)" value={editPassword} secureTextEntry onChangeText={setEditPassword} /><View style={styles.actions}><Button label="Save changes" loading={saving} disabled={editRole === 'faculty' && selected.role !== 'faculty' && !editEmployeeId.trim()} onPress={() => void update()} /><Button label={selected.status === 'active' ? 'Deactivate' : 'Activate'} variant="secondary" loading={saving} onPress={() => void update(selected.status === 'active' ? 'inactive' : 'active')} /></View></> : null}</Dialog>
  </>;
}

type SetupDialog = 'department' | 'program' | 'term' | null;
function AcademicSetup({ data, refresh, toast }: Props) {
  const [dialog, setDialog] = useState<SetupDialog>(null);
  const [saving, setSaving] = useState(false);
  const [deletingProgram, setDeletingProgram] = useState<ProgramRecord | null>(null);
  const [department, setDepartment] = useState<DepartmentRecord | null>(null);
  const [program, setProgram] = useState<ProgramRecord | null>(null);
  const [term, setTerm] = useState<AcademicTermRecord | null>(null);
  const [code, setCode] = useState(''); const [name, setName] = useState(''); const [departmentId, setDepartmentId] = useState(''); const [status, setStatus] = useState<'active' | 'inactive'>('active');
  const [academicYear, setAcademicYear] = useState(''); const [semester, setSemester] = useState(''); const [startsOn, setStartsOn] = useState(''); const [endsOn, setEndsOn] = useState(''); const [termStatus, setTermStatus] = useState<AcademicTermRecord['status']>('planned');
  const close = () => { setDialog(null); setDepartment(null); setProgram(null); setTerm(null); };
  const openDepartment = (value?: DepartmentRecord) => { setDepartment(value ?? null); setCode(value?.code ?? ''); setName(value?.name ?? ''); setStatus(value?.status ?? 'active'); setDialog('department'); };
  const openProgram = (value?: ProgramRecord) => { setProgram(value ?? null); setCode(value?.code ?? ''); setName(value?.name ?? ''); setDepartmentId(value?.departmentId ?? data.departments.find((item) => item.status === 'active')?.id ?? ''); setStatus(value?.status ?? 'active'); setDialog('program'); };
  const openTerm = (value?: AcademicTermRecord) => { setTerm(value ?? null); setAcademicYear(value?.academicYear ?? ''); setSemester(value?.semester ?? ''); setStartsOn(value?.startsOn ?? ''); setEndsOn(value?.endsOn ?? ''); setTermStatus(value?.status ?? 'planned'); setDialog('term'); };
  const save = async () => { setSaving(true); try { if (dialog === 'department') await saveDepartment({ id: department?.id, code, name, status }); if (dialog === 'program') await saveProgram({ id: program?.id, departmentId, code, name, status }); if (dialog === 'term') await saveAcademicTerm({ id: term?.id, academicYear, semester, startsOn, endsOn, status: termStatus }); toast.show('Academic setup saved.'); close(); refresh(); } catch (cause) { toast.show(getErrorMessage(cause, 'Academic setup could not be saved.')); } finally { setSaving(false); } };
  const removeProgram = async () => { if (!deletingProgram) return; setSaving(true); try { await deleteProgram(deletingProgram.id); toast.show('Program deleted.'); setDeletingProgram(null); close(); refresh(); } catch (cause) { toast.show(getErrorMessage(cause, 'Program could not be deleted.')); } finally { setSaving(false); } };
  const activeDepartments = data.departments.filter((item) => item.status === 'active');
  return <><Heading title="Academic Setup" subtitle="Create the departments, programs, and academic terms used for account scope and academic records." action={<Button label="Add department" onPress={() => openDepartment()} />} />
    <Card><View style={styles.sectionHeader}><View><Text style={styles.sectionTitle}>Departments</Text><Text style={styles.sectionHelp}>Departments define the scope available to Academic Admin and Faculty accounts.</Text></View></View>{data.departments.length ? <DataTable columns={['Code', 'Department', 'Status', 'Manage']} rows={data.departments.map((item) => [item.code, item.name, item.status[0].toUpperCase() + item.status.slice(1), <Button key={item.id} label="Edit" variant="secondary" onPress={() => openDepartment(item)} />])} /> : <PageState kind="empty" title="No departments yet" message="Use Add department above to create the first department." />}</Card>
    <Card><View style={styles.sectionHeader}><View><Text style={styles.sectionTitle}>Programs</Text><Text style={styles.sectionHelp}>Programs are grouped under a department and can be activated or archived.</Text></View><Button label="Add program" variant="secondary" disabled={!activeDepartments.length} onPress={() => openProgram()} /></View>{data.programs.length ? <DataTable columns={['Code', 'Program', 'Department', 'Status', 'Manage']} rows={data.programs.map((item) => [item.code, item.name, data.departments.find((department) => department.id === item.departmentId)?.code ?? 'Unassigned', item.status[0].toUpperCase() + item.status.slice(1), <Button key={item.id} label="Edit" variant="secondary" onPress={() => openProgram(item)} />])} /> : <PageState kind="empty" title="No programs yet" message="Programs are optional, but useful for organizing department reports." action={<Button label="Create program" disabled={!activeDepartments.length} onPress={() => openProgram()} />} />}</Card>
    <Card><View style={styles.sectionHeader}><View><Text style={styles.sectionTitle}>Academic terms</Text><Text style={styles.sectionHelp}>Terms must exist before Faculty can create monitoring classes.</Text></View><Button label="Add term" variant="secondary" onPress={() => openTerm()} /></View>{data.terms.length ? <DataTable columns={['Academic year', 'Semester', 'Starts', 'Ends', 'Status', 'Manage']} rows={data.terms.map((item) => [item.academicYear, item.semester, item.startsOn, item.endsOn, item.status[0].toUpperCase() + item.status.slice(1), <Button key={item.id} label="Edit" variant="secondary" onPress={() => openTerm(item)} />])} /> : <PageState kind="empty" title="No academic terms yet" message="Create the current academic term before setting up classes." action={<Button label="Create term" onPress={() => openTerm()} />} />}</Card>
    <Dialog visible={dialog === 'department'} title={department ? 'Edit department' : 'Create department'} onClose={close}><Field label="Department code" value={code} onChangeText={setCode} placeholder="e.g. CIT" /><Field label="Department name" value={name} onChangeText={setName} placeholder="e.g. College of Information Technology" /><SelectField label="Status" value={status} options={[{ label: 'Active', value: 'active' }, { label: 'Inactive', value: 'inactive' }]} onChange={(value) => setStatus(value as 'active' | 'inactive')} /><Button label="Save department" loading={saving} disabled={!code.trim() || !name.trim()} onPress={() => void save()} /></Dialog>
    <Dialog visible={dialog === 'program'} title={program ? 'Edit program' : 'Create program'} onClose={close}><SelectField label="Department" value={departmentId} options={activeDepartments.map((item) => ({ label: `${item.code} · ${item.name}`, value: item.id }))} onChange={setDepartmentId} /><Field label="Program code" value={code} onChangeText={setCode} placeholder="e.g. BSIT" /><Field label="Program name" value={name} onChangeText={setName} placeholder="e.g. Bachelor of Science in Information Technology" /><SelectField label="Status" value={status} options={[{ label: 'Active', value: 'active' }, { label: 'Inactive', value: 'inactive' }]} onChange={(value) => setStatus(value as 'active' | 'inactive')} /><View style={styles.dialogActions}>{program ? <Button label="Delete permanently" variant="danger" disabled={saving} onPress={() => setDeletingProgram(program)} /> : null}<Button label="Save program" loading={saving} disabled={!departmentId || !code.trim() || !name.trim()} onPress={() => void save()} /></View></Dialog>
    <Dialog visible={dialog === 'term'} title={term ? 'Edit academic term' : 'Create academic term'} onClose={close}><Text style={styles.dialogIntro}>Set the teaching period used when Faculty creates monitoring classes. Select dates from the calendar.</Text><Field label="Academic year" value={academicYear} onChangeText={setAcademicYear} placeholder="e.g. 2026-2027" autoCapitalize="none" /><Field label="Semester" value={semester} onChangeText={setSemester} placeholder="e.g. First Semester" /><View style={styles.dateGrid}><DateField containerStyle={styles.dateField} label="Start date" value={startsOn} onChange={setStartsOn} /><DateField containerStyle={styles.dateField} label="End date" value={endsOn} onChange={setEndsOn} /></View><Text style={styles.fieldHint}>Choose the first and last day of the academic term. The dates are saved as YYYY-MM-DD.</Text><SelectField label="Status" value={termStatus} options={['planned', 'active', 'closed', 'archived'].map((value) => ({ label: value[0].toUpperCase() + value.slice(1), value }))} onChange={(value) => setTermStatus(value as AcademicTermRecord['status'])} /><View style={styles.dialogActions}><Button label="Cancel" variant="secondary" onPress={close} /><Button label="Save academic term" loading={saving} disabled={!academicYear.trim() || !semester.trim() || !startsOn || !endsOn} onPress={() => void save()} /></View></Dialog>
    <ConfirmDialog visible={Boolean(deletingProgram)} title="Delete program permanently?" message={deletingProgram ? `Delete ${deletingProgram.code} · ${deletingProgram.name}? This cannot be undone. If students are linked, deletion will be blocked and you should mark the program Inactive instead.` : ''} confirmLabel="Delete program" cancelLabel="Keep program" danger pending={saving} onClose={() => { if (!saving) setDeletingProgram(null); }} onConfirm={() => void removeProgram()} />
  </>;
}
function Roles({ data }: Props) { return <><Heading title="Roles & Permissions" subtitle="The revised APMS role model contains exactly System Admin, Academic Admin, and Faculty; Super Admin is merged and Grader is removed." /><Card><DataTable columns={['Role', 'Key', 'Assigned users', 'Permissions', 'Scope']} rows={data.roles.filter((role) => ['system_admin', 'academic_admin', 'faculty'].includes(role.key)).map((role) => [role.name, role.key, String(role.users), String(role.permissions), role.key === 'system_admin' ? 'Global' : 'Department / assigned classes'])} /></Card></>; }
function Backups({ data, refresh, userId, toast }: Props) { const [saving, setSaving] = useState(false); const queue = async () => { setSaving(true); try { await queueBackup(userId); toast.show('Backup request queued. Completion requires the configured protected backup worker.'); refresh(); } catch (cause) { toast.show(getErrorMessage(cause, 'Backup could not be queued.')); } finally { setSaving(false); } }; return <><Heading title="System & Backup Status" subtitle="Queue and monitor protected backup requests without exposing database credentials." action={<Button label="Queue full backup" loading={saving} onPress={() => void queue()} />} /><Card>{data.backups.length ? <DataTable columns={['Created', 'Scope', 'Completed', 'Status']} rows={data.backups.map((row) => [date(row.createdAt), row.scope, date(row.completedAt), `${row.status[0].toUpperCase()}${row.status.slice(1)}`])} /> : <PageState kind="empty" title="No backup requests" message="Queue a backup after an institutional backup worker and protected destination are configured." />}</Card></>; }
function Logs({ data }: Props) { return <><Heading title="Access & System Logs" subtitle="Immutable audit trail for account, data, criteria, and administrative operations." /><Card>{data.logs.length ? <DataTable columns={['ID', 'Timestamp', 'Action', 'Entity', 'Actor', 'Status']} rows={data.logs.map((row) => [String(row.id), date(row.createdAt), row.action, row.entityType, row.actorId ?? 'System', 'Recorded'])} /> : <PageState kind="empty" title="No logs" message="No audit records are visible." />}</Card></>; }
function SystemReports({ data }: Props) {
  const rows = useMemo(() => [
    ...data.users.map((user) => ({ recordType: 'User', status: user.status, role: user.roleName ?? user.role ?? 'Unassigned', scope: user.scopeType ?? 'Global', date: user.lastLoginAt ?? 'No sign-in', identifier: user.id })),
    ...data.logs.map((log) => ({ recordType: 'Audit event', status: 'Recorded', role: log.action, scope: log.entityType, date: log.createdAt, identifier: String(log.id) })),
    ...data.backups.map((backup) => ({ recordType: 'Backup', status: backup.status, role: backup.scope, scope: backup.completedAt ? 'Completed' : 'Pending', date: backup.createdAt, identifier: backup.id })),
  ], [data.users, data.logs, data.backups]);
  return <><Heading title="System Reports" subtitle="Formatted operational reports for account, audit, and backup administration. Academic records are outside the System Admin reporting scope." /><ReportComposer title="System Operations Report" scopeLabel="System administration" description="Operational account status, role assignment, audit activity, and backup status. Report data is drawn from the System Admin workspace." rows={rows} /></>;
}
function SystemSettings({ data, refresh, userId, toast }: Props) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(data.settings.map((row) => [row.key, typeof row.value === 'string' ? row.value : JSON.stringify(row.value)])));
  const storedFeedbackFromEmail = data.settings.find((row) => row.key === 'FEEDBACK_FROM_EMAIL')?.value;
  const [feedbackFromEmail, setFeedbackFromEmail] = useState(typeof storedFeedbackFromEmail === 'string' ? storedFeedbackFromEmail : '');
  const storedFeedbackFromName = data.settings.find((row) => row.key === 'FEEDBACK_FROM_NAME')?.value;
  const [feedbackFromName, setFeedbackFromName] = useState(typeof storedFeedbackFromName === 'string' && storedFeedbackFromName.trim() ? storedFeedbackFromName : 'APMS Feedback');
  const [saving, setSaving] = useState(false);
  const [providerStatus, setProviderStatus] = useState<any>(null);
  useEffect(() => { let active = true; if (!supabase) return; void supabase.functions.invoke('ai-provider-settings', { method: 'GET' }).then(({ data: result }) => { if (active && result && !result.error) setProviderStatus(result); }); return () => { active = false; }; }, []);
  const storedDefaultId = data.settings.find((row) => row.key === 'grading.default_system_id')?.value;
  const [defaultSystemId, setDefaultSystemId] = useState(typeof storedDefaultId === 'string' ? storedDefaultId : IT_GLOBAL_GRADING_SYSTEM.id);
  const [studentIdValidation, setStudentIdValidation] = useState(data.settings.find((row) => row.key === 'student_id.validation_enabled')?.value === true);
  useEffect(() => { setStudentIdValidation(data.settings.find((row) => row.key === 'student_id.validation_enabled')?.value === true); }, [data.settings]);
  const [gradingSystems, setGradingSystems] = useState<GradingDefinition[]>([IT_GLOBAL_GRADING_SYSTEM]);
  useEffect(() => {
    const saved = data.settings.find((row) => row.key === 'FEEDBACK_FROM_EMAIL')?.value;
    setFeedbackFromEmail(typeof saved === 'string' ? saved : '');
    const savedName = data.settings.find((row) => row.key === 'FEEDBACK_FROM_NAME')?.value;
    setFeedbackFromName(typeof savedName === 'string' && savedName.trim() ? savedName : 'APMS Feedback');
  }, [data.settings]);
  useEffect(() => { let active = true; if (!supabase) return; void supabase.from('grading_systems').select('definition,updated_at').order('updated_at', { ascending: false }).then(({ data: rows }) => { if (!active || !rows) return; const saved = rows.map((row: any) => row.definition as GradingDefinition).filter((system) => !!system?.id); const globalName = IT_GLOBAL_GRADING_SYSTEM.name.toLocaleLowerCase(); const savedGlobal = saved.find((system) => system.id === IT_GLOBAL_GRADING_SYSTEM.id || system.name?.trim().toLocaleLowerCase() === globalName); const unique = new Map<string, GradingDefinition>(); const defaultSystem = savedGlobal ?? IT_GLOBAL_GRADING_SYSTEM; unique.set(defaultSystem.id, defaultSystem); for (const system of saved) { const isGlobal = system.id === IT_GLOBAL_GRADING_SYSTEM.id || system.name?.trim().toLocaleLowerCase() === globalName; if (!isGlobal && !unique.has(system.id)) unique.set(system.id, system); } const systems = [...unique.values()].sort((a, b) => a.name.localeCompare(b.name)); setGradingSystems(systems); const savedId = data.settings.find((row) => row.key === 'grading.default_system_id')?.value; if (typeof savedId === 'string' && systems.some((system) => system.id === savedId)) setDefaultSystemId(savedId); else setDefaultSystemId(defaultSystem.id); }); return () => { active = false; }; }, [data.settings]);
  const update = (key: string, value: string) => setValues((current) => ({ ...current, [key]: value }));
  const saveAll = async () => {
    if (feedbackFromEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(feedbackFromEmail.trim())) {
      toast.show('Enter a valid feedback sender email address.');
      return;
    }
    if (!feedbackFromName.trim() || feedbackFromName.trim().length > 100 || /[\r\n<>]/.test(feedbackFromName)) {
      toast.show('Enter a sender name up to 100 characters without angle brackets or line breaks.');
      return;
    }
    const quotaFields = [
      { key: 'ai.usage.monthly_request_limit', label: 'Monthly provider request limit', maximum: Number.MAX_SAFE_INTEGER },
      { key: 'ai.usage.monthly_token_limit', label: 'Monthly provider token limit', maximum: Number.MAX_SAFE_INTEGER },
      { key: 'ai.custom.monthly_request_limit', label: 'Monthly APMS model forecast limit', maximum: 2_147_483_647 },
    ];
    const quotaValues: Record<string, number | null> = {};
    for (const field of quotaFields) {
      const raw = values[field.key]?.trim() ?? '';
      if (raw && (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > field.maximum)) {
        toast.show(`${field.label} must be a whole number from 0 to ${field.maximum.toLocaleString()}, or blank for unlimited.`);
        return;
      }
      quotaValues[field.key] = raw ? Number(raw) : null;
    }
    setSaving(true);
    try {
      for (const row of data.settings) {
        if (row.key === 'grading.swunext_global_modules' || row.key === 'grading.default_system_id' || row.key === 'grading.default_system_definition' || row.key === 'FEEDBACK_FROM_EMAIL' || row.key === 'FEEDBACK_FROM_NAME' || quotaFields.some((field) => field.key === row.key)) continue;
        let value: unknown = values[row.key] ?? '';
        try { value = JSON.parse(value as string); } catch { /* plain strings remain valid JSONB values */ }
        await saveSystemSetting(userId, row.key, value);
      }
      await saveSystemSetting(userId, 'FEEDBACK_FROM_EMAIL', feedbackFromEmail.trim());
      await saveSystemSetting(userId, 'FEEDBACK_FROM_NAME', feedbackFromName.trim());
      await saveSystemSetting(userId, 'student_id.validation_enabled', studentIdValidation);
      for (const [key, value] of Object.entries(quotaValues)) await saveSystemSetting(userId, key, value);
      const selectedDefault = gradingSystems.find((system) => system.id === defaultSystemId) ?? IT_GLOBAL_GRADING_SYSTEM;
      await saveSystemSetting(userId, 'grading.default_system_id', selectedDefault.id);
      await saveSystemSetting(userId, 'grading.default_system_definition', selectedDefault);
      toast.show('System settings saved.'); refresh();
    } catch (cause) { toast.show(getErrorMessage(cause, 'Settings could not be saved.')); }
    finally { setSaving(false); }
  };
  const setting = (key: string) => data.settings.find((row) => row.key === key);
  const boolValue = (key: string) => values[key] === 'true';
  return <>
    <Heading title="System Settings" subtitle="Manage the global services and policies that keep APMS running." action={<Button label="Save all changes" loading={saving} onPress={() => void saveAll()} />} />
    <View style={styles.settingsLayout}>
      <Card style={styles.settingsIntro}><Text style={styles.cardTitle}>Configuration overview</Text><Text style={styles.help}>These settings affect the whole APMS installation. Changes are permission-checked and recorded in the audit log.</Text><View style={styles.summaryRow}><Text style={styles.summaryLabel}>Last configuration update</Text><Text style={styles.summaryValue}>{date(data.settings.map((row) => row.updatedAt).sort().at(-1) ?? null)}</Text></View></Card>
      <Card style={styles.settingsCard}>
        <Text style={styles.sectionTitle}>Core services</Text>
        <Text style={styles.sectionHelp}>Control optional services and their availability.</Text>
        <View style={styles.settingRow}><View style={styles.settingCopy}><Text style={styles.settingLabel}>AI assistant</Text><Text style={styles.help}>Allow approved decision-support features to run.</Text></View><Pressable accessibilityRole="switch" accessibilityState={{ checked: boolValue('ai.enabled') }} onPress={() => update('ai.enabled', String(!boolValue('ai.enabled')))} style={[styles.switch, boolValue('ai.enabled') && styles.switchOn]}><View style={[styles.switchThumb, boolValue('ai.enabled') && styles.switchThumbOn]} /></Pressable></View>
        <View style={styles.settingRow}><View style={styles.settingCopy}><Text style={styles.settingLabel}>Share anonymous assessment data with AI</Text><Text style={styles.help}>Off by default. When enabled, AI may receive numeric scores and derived grades with assessment titles and student identifiers removed.</Text></View><Pressable accessibilityRole="switch" accessibilityState={{ checked: boolValue('ai.assessment_data.enabled') }} onPress={() => update('ai.assessment_data.enabled', String(!boolValue('ai.assessment_data.enabled')))} style={[styles.switch, boolValue('ai.assessment_data.enabled') && styles.switchOn]}><View style={[styles.switchThumb, boolValue('ai.assessment_data.enabled') && styles.switchThumbOn]} /></Pressable></View>
        <View style={styles.settingRow}><View style={styles.settingCopy}><Text style={styles.settingLabel}>Share anonymous attendance data with AI</Text><Text style={styles.help}>Off by default. When enabled, AI may receive numeric attendance rates without student or class identifiers.</Text></View><Pressable accessibilityRole="switch" accessibilityState={{ checked: boolValue('ai.attendance_data.enabled') }} onPress={() => update('ai.attendance_data.enabled', String(!boolValue('ai.attendance_data.enabled')))} style={[styles.switch, boolValue('ai.attendance_data.enabled') && styles.switchOn]}><View style={[styles.switchThumb, boolValue('ai.attendance_data.enabled') && styles.switchThumbOn]} /></Pressable></View>
        <View style={styles.settingRow}><View style={styles.settingCopy}><Text style={styles.settingLabel}>Validate student ID format</Text><Text style={styles.help}>When enabled, student ID fields accept a 12-digit number or the formatted 05-XXXX-XXXXXX pattern. Disabled by default because some existing institutional IDs use other formats.</Text></View><Pressable accessibilityRole="switch" accessibilityState={{ checked: studentIdValidation }} onPress={() => setStudentIdValidation((enabled) => !enabled)} style={[styles.switch, studentIdValidation && styles.switchOn]}><View style={[styles.switchThumb, studentIdValidation && styles.switchThumbOn]} /></Pressable></View>
      </Card>
      <AIServiceSettings />
      <Card style={styles.settingsCard}>
        <Text style={styles.sectionTitle}>AI provider keys and usage</Text>
        <Text style={styles.sectionHelp}>System-provided keys stay in Supabase Edge Function Secrets (OPENAI_API_KEY and GEMINI_API_KEY). Department keys can override them for authorized classes. A shared key does not share prompts or student context: each request is authorized and sent as a fresh, stateless call. Usage records contain billing metadata, not prompts or context.</Text>
        <DataTable columns={['System provider', 'Key status', 'Default model']} rows={[
          ['OpenAI', providerStatus?.systemProviders?.openai?.configured ? 'Configured' : 'Not configured', providerStatus?.systemProviders?.openai?.model ?? 'gpt-4.1-mini'],
          ['Google Gemini', providerStatus?.systemProviders?.gemini?.configured ? 'Configured' : 'Not configured', providerStatus?.systemProviders?.gemini?.model ?? 'gemini-3.8-flash'],
        ]} />
        <View style={styles.formGrid}>
          <Field label="Monthly requests per system provider (blank = unlimited)" value={values['ai.usage.monthly_request_limit'] === 'null' ? '' : values['ai.usage.monthly_request_limit'] ?? ''} onChangeText={(value) => update('ai.usage.monthly_request_limit', value.replace(/\D/g, ''))} keyboardType="number-pad" />
          <Field label="Monthly tokens per system provider (blank = unlimited)" value={values['ai.usage.monthly_token_limit'] === 'null' ? '' : values['ai.usage.monthly_token_limit'] ?? ''} onChangeText={(value) => update('ai.usage.monthly_token_limit', value.replace(/\D/g, ''))} keyboardType="number-pad" />
          <Field label="Monthly APMS model forecasts (blank = unlimited)" value={values['ai.custom.monthly_request_limit'] === 'null' ? '' : values['ai.custom.monthly_request_limit'] ?? ''} onChangeText={(value) => update('ai.custom.monthly_request_limit', value.replace(/\D/g, '').slice(0, 10))} keyboardType="number-pad" helpText="Counts one forecast per eligible student record, not LLM tokens. Set 0 to block APMS model forecasts." helpExample="Leave blank for unlimited, or enter a monthly count such as 500." />
        </View>
        <Text style={styles.help}>APMS model-forecast usage is separate from OpenAI/Gemini token usage. Faculty may select the centrally configured custom provider in applied evaluation criteria; the service remains advisory.</Text>
        <Text style={styles.help}>System-provided-key usage this month: {providerStatus?.systemUsage?.requests ?? 0} requests · {(providerStatus?.systemUsage?.inputTokens ?? 0).toLocaleString()} input tokens · {(providerStatus?.systemUsage?.outputTokens ?? 0).toLocaleString()} output tokens.</Text>
        {providerStatus?.systemUsageByModel?.length ? <DataTable columns={['Provider', 'Model', 'Requests', 'Input tokens', 'Output tokens']} rows={providerStatus.systemUsageByModel.map((row: any) => [row.provider, row.model, String(row.requests), Number(row.input_tokens).toLocaleString(), Number(row.output_tokens).toLocaleString()])} /> : null}
        <Text style={styles.help}>All scopes this month: {providerStatus?.adminUsage?.requests ?? 0} requests · {(providerStatus?.adminUsage?.inputTokens ?? 0).toLocaleString()} input tokens · {(providerStatus?.adminUsage?.outputTokens ?? 0).toLocaleString()} output tokens.</Text>
        {providerStatus?.adminUsageByScope?.length ? <DataTable columns={['Key scope', 'Reference', 'Provider', 'Model', 'Requests', 'Input tokens', 'Output tokens']} rows={providerStatus.adminUsageByScope.map((row: any) => [row.scope_type === 'user' ? 'Legacy personal key' : row.scope_type, row.scope_id ? `${String(row.scope_id).slice(0, 8)}…` : 'System', row.provider, row.model, String(row.requests), Number(row.input_tokens).toLocaleString(), Number(row.output_tokens).toLocaleString()])} /> : null}
      </Card>
      <Card style={styles.settingsCard}>
        <Text style={styles.sectionTitle}>Feedback email</Text>
        <Text style={styles.sectionHelp}>Set the sender name and address used when Faculty emails feedback to a student.</Text>
        <Field label="Sender name (FEEDBACK_FROM_NAME)" value={feedbackFromName} onChangeText={setFeedbackFromName} placeholder="APMS Feedback" autoCapitalize="words" maxLength={100} />
        <Field label="Sender email (FEEDBACK_FROM_EMAIL)" value={feedbackFromEmail} onChangeText={setFeedbackFromEmail} placeholder="feedback@your-verified-domain.edu" keyboardType="email-address" autoCapitalize="none" />
        <Text style={styles.help}>Save the address here. Keep only RESEND_API_KEY in Edge Function Secrets. Resend must verify the sender’s domain before emails can be sent.</Text>
      </Card>
      <Card style={styles.settingsCard}>
        <Text style={styles.sectionTitle}>Backup policy</Text><Text style={styles.sectionHelp}>Set how long completed backup artifacts should be retained.</Text>
        <View style={styles.inlineField}><Field label="Retention period" value={values['backup.retention_days'] ?? ''} onChangeText={(value) => update('backup.retention_days', value.replace(/\D/g, '').slice(0, 3))} keyboardType="number-pad" containerStyle={styles.retentionField} /><Text style={styles.unit}>days</Text></View>
        <Text style={styles.help}>Minimum 1 day. Backup execution still requires the configured protected worker.</Text>
      </Card>
      <Card style={styles.settingsCard}>
        <View style={styles.sectionHeader}><View><Text style={styles.sectionTitle}>Default grading system</Text><Text style={styles.sectionHelp}>Choose which saved grading definition is used when a class has no explicitly applied system.</Text></View><Text style={styles.badge}>DEFAULT</Text></View>
        <SelectField label="Default grading system" value={defaultSystemId} options={gradingSystems.map((system) => ({ label: system.name, value: system.id }))} onChange={setDefaultSystemId} />
        <Text style={styles.help}>Grading definitions are created and edited by Academic Admins. This setting selects the system-wide fallback; class-specific grading systems continue to take precedence.</Text>
      </Card>
      <Text style={styles.updatedNote}>Settings last loaded from Supabase. {data.settings.length} configuration entries.</Text>
    </View>
  </>;
}
function PolicyItem({ label, value }: { label: string; value: string }) { return <View style={styles.policyItem}><Text style={styles.policyValue}>{value}</Text><Text style={styles.policyLabel}>{label}</Text></View>; }
function Info({ onMessage }: { onMessage: (message: string) => void }) { return <><Heading title="Account settings" subtitle="Manage your profile, password, MFA, and notification preferences." /><AccountSettings role="system_admin" screen="settings" onMessage={onMessage} /></>; }
function Dialog({ visible, title, onClose, children }: { visible: boolean; title: string; onClose: () => void; children: ReactNode }) { return <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}><View style={styles.overlay}><Card style={styles.dialog}><View style={styles.heading}><Text accessibilityRole="header" style={styles.dialogTitle}>{title}</Text><Pressable accessibilityLabel="Close dialog" onPress={onClose}><Text style={styles.close}>×</Text></Pressable></View><View style={styles.dialogBody}>{children}</View></Card></View></Modal>; }
const styles = StyleSheet.create({ screen: { gap: 16 }, heading: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12 }, flex: { flex: 1 }, title: { color: colors.text, fontSize: 22, lineHeight: 30, fontWeight: '700' }, subtitle: { color: colors.textMuted, fontSize: 13, lineHeight: 19, marginTop: 3 }, metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 }, cardTitle: { color: colors.text, fontSize: 15, fontWeight: '700', marginBottom: 8 }, help: { color: colors.textMuted, fontSize: 12, lineHeight: 18 }, formGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 }, dateGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 }, dateField: { flex: 1, minWidth: 220 }, userChartFilters: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 }, filter: { flexGrow: 1, flexBasis: 180, minWidth: 160 }, chartCount: { color: colors.textMuted, fontSize: 11, marginTop: -10 }, analyticsCharts: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 }, fieldHint: { color: colors.textMuted, fontSize: 11, marginTop: -6 }, dialogIntro: { color: colors.textMuted, fontSize: 13, lineHeight: 19, marginBottom: 2 }, actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, dialogActions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8, marginTop: 4 }, overlay: { flex: 1, backgroundColor: '#00000066', alignItems: 'center', justifyContent: 'center', padding: 24 }, dialog: { width: '100%', maxWidth: 760, maxHeight: '90%', padding: 22 }, dialogTitle: { color: colors.text, fontSize: 19, fontWeight: '700' }, dialogBody: { gap: 14, marginTop: 16 }, close: { color: colors.textMuted, fontSize: 28 }, setting: { maxWidth: 920, gap: 12 }, settingsLayout: { gap: 14, maxWidth: 980 }, settingsIntro: { gap: 10, padding: 20 }, settingsCard: { gap: 10, padding: 20 }, summaryRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, borderTopWidth: 1, borderColor: colors.border, paddingTop: 12, marginTop: 4 }, summaryLabel: { color: colors.textMuted, fontSize: 12 }, summaryValue: { color: colors.text, fontSize: 12, fontWeight: '600' }, sectionTitle: { color: colors.text, fontSize: 16, fontWeight: '700' }, sectionHelp: { color: colors.textMuted, fontSize: 12, lineHeight: 18, marginTop: 3 }, settingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16, paddingVertical: 12, borderTopWidth: 1, borderColor: colors.border, marginTop: 6 }, settingCopy: { flex: 1 }, settingLabel: { color: colors.text, fontSize: 14, fontWeight: '700' }, switch: { width: 46, height: 26, borderRadius: 14, padding: 3, justifyContent: 'center', backgroundColor: '#D0D5DD' }, switchOn: { backgroundColor: colors.brand }, switchThumb: { width: 20, height: 20, borderRadius: 10, backgroundColor: '#FFF' }, switchThumbOn: { alignSelf: 'flex-end' }, inlineField: { flexDirection: 'row', alignItems: 'flex-end', gap: 10 }, retentionField: { width: 180 }, unit: { color: colors.textMuted, fontSize: 13, paddingBottom: 12 }, sectionHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }, badge: { color: colors.success, backgroundColor: '#DCFCE7', fontSize: 10, fontWeight: '800', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999 }, policyGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 6 }, policyItem: { minWidth: 130, flex: 1, backgroundColor: colors.canvas, borderRadius: 10, padding: 12 }, policyValue: { color: colors.brand, fontSize: 18, fontWeight: '800' }, policyLabel: { color: colors.textMuted, fontSize: 11, marginTop: 3 }, jsonField: { minHeight: 108, textAlignVertical: 'top' }, updatedNote: { color: colors.textMuted, fontSize: 11, textAlign: 'center', paddingBottom: 10 } });
