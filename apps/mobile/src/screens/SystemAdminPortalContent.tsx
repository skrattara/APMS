import { getErrorMessage } from '@/services/errors';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';

import { useAuth } from '@/auth/AuthProvider';
import * as Linking from 'expo-linking';
import { supabase } from '@/services/supabase';
import { AppIcon } from '@/components/Icon';
import { Badge, Button, Card, ConfirmDialog, DataTable, DateField, Field, MetricCard, PageState, RefreshIndicator, SelectField, Tabs, useToast } from '@/components/ui';
import { VisualizationPanel } from '@/components/charts/VisualizationPanel';
import { ReportComposer } from '@/components/reports/ReportComposer';
import { AIServiceSettings } from '@/components/AIServiceSettings';
import { Settings as AccountSettings } from '@/screens/AppPortalScreen';
import { createJsonBackup, createManagedUser, deleteManagedUsers, deleteProgram, deleteSelectedBackups, deleteSystemSetting, loadAdminWorkspace, loadProgramRequests, resendManagedUserInvitation, resetApplicationData, restoreJsonBackup, restoreStoredScheduledBackup, reviewProgramRequest, saveAcademicTerm, saveBackupSchedule, saveDepartment, saveProgram, saveSystemSetting, sendManagedUserPasswordReset, updateManagedUser, uploadJsonBackup, type AcademicTermRecord, type AdminWorkspace, type DepartmentRecord, type ManagedUser, type ProgramRecord, type ProgramRequestRecord } from '@/services/admin';
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

export function SystemAdminPortalContent({ screen, settingsCategory }: { screen: string; settingsCategory?: string }) {
  const { user } = useAuth(); const state = useWorkspace(); const toast = useToast();
  if (!user) return <PageState kind="error" title="Session required" message="Sign in again to continue." />;
  if (state.loading) return <PageState kind="loading" title="Loading System Admin workspace" message="Retrieving users, permissions, settings, backups, and audit activity." />;
  if (state.error || !state.data) return <PageState kind="error" title="System administration unavailable" message={state.error || 'No administration data is available.'} action={<Button label="Retry" onPress={state.refresh} />} />;
  const props = { data: state.data, refresh: state.refresh, userId: user.id, toast };
  return <View style={styles.screen}>
    <RefreshIndicator visible={state.refreshing} />
    {screen === 'overview' ? <Overview {...props} /> : null}
    {screen === 'admins' ? <Users {...props} /> : null}
    {screen === 'setup' ? <AcademicSetup {...props} initialSection={settingsCategory} /> : null}
    {screen === 'roles' ? <Roles {...props} /> : null}
    {screen === 'backup' ? <Backups {...props} /> : null}
    {screen === 'logs' ? <Logs {...props} /> : null}
    {screen === 'reports' ? <SystemReports {...props} /> : null}
    {screen === 'system' ? <SystemSettings {...props} initialCategory={settingsCategory} /> : null}
    {screen === 'settings' ? <Info onMessage={toast.show} /> : null}
  </View>;
}

type Props = { data: AdminWorkspace; refresh: () => void; userId: string; toast: ReturnType<typeof useToast> };
function Heading({ title, subtitle, action }: { title: string; subtitle: string; action?: ReactNode }) { return <View style={styles.heading}><View style={styles.headingCopy}><Text accessibilityRole="header" style={styles.title}>{title}</Text><Text style={styles.subtitle}>{subtitle}</Text></View>{action}</View>; }
function displayRole(role: ManagedUser['role']) { return role === 'system_admin' ? 'System Admin' : role === 'academic_admin' ? 'Academic Admin' : role === 'faculty' ? 'Faculty' : 'Unassigned'; }
function date(value: string | null) { return value ? new Date(value).toLocaleString() : 'Never'; }
function relativeDate(value: string | null) {
  if (!value) return 'Never';
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return 'Unknown';
  const seconds = (timestamp - Date.now()) / 1000;
  if (Math.abs(seconds) < 45) return 'Just now';
  const units: [Intl.RelativeTimeFormatUnit, number][] = [['year', 60 * 60 * 24 * 365], ['month', 60 * 60 * 24 * 30], ['day', 60 * 60 * 24], ['hour', 60 * 60], ['minute', 60]];
  const [unit, size] = units.find(([, unitSeconds]) => Math.abs(seconds) >= unitSeconds) ?? ['second', 1];
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'always' }).format(Math.round(seconds / size), unit);
}
function LastLogin({ value }: { value: string | null }) {
  const [showFullDate, setShowFullDate] = useState(false);
  const fullDate = value ? new Date(value).toLocaleString(undefined, { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Never logged in';
  return <View style={{ alignItems: 'flex-start', gap: 2 }}>
    <Pressable accessibilityRole="button" accessibilityLabel={`Last login: ${relativeDate(value)}`} accessibilityHint="Show the full date and time" onPress={() => setShowFullDate((current) => !current)} {...(Platform.OS === 'web' ? ({ title: fullDate } as never) : {})}>
      <Text style={styles.help}>{relativeDate(value)}</Text>
    </Pressable>
    {showFullDate ? <Text style={styles.help}>{fullDate}</Text> : null}
  </View>;
}
function compactReference(value: string) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value.slice(0, 8) : value; }
function auditActorLabel(actorId: string | null, data: AdminWorkspace) {
  if (!actorId) return 'System';
  const actor = data.users.find((user) => user.id === actorId);
  return actor ? `${actor.firstName} ${actor.lastName}`.trim() || actor.email : `Unmatched account · ${compactReference(actorId)}`;
}
function auditEntityLabel(row: AdminWorkspace['logs'][number], data: AdminWorkspace) {
  const entityId = row.entityId;
  const entityType = row.entityType.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  if (entityId) {
    const user = data.users.find((item) => item.id === entityId);
    if (user) return `User · ${user.firstName} ${user.lastName}`.trim();
    const department = data.departments.find((item) => item.id === entityId);
    if (department) return `Department · ${department.code}`;
    const program = data.programs.find((item) => item.id === entityId);
    if (program) return `Program · ${program.code}`;
    const term = data.terms.find((item) => item.id === entityId);
    if (term) return `Term · ${term.academicYear} ${term.semester}`;
    const backup = data.backups.find((item) => item.id === entityId);
    if (backup) return `Backup · ${backup.scope}`;
  }
  return entityType || 'System';
}

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
  return <><Heading title="System Administration Dashboard" subtitle="Live operational status for APMS accounts, access control, audit activity, and protected backups." /><View style={styles.metrics}><MetricCard label="User accounts" value={String(data.users.length)} /><MetricCard label="Active accounts" value={String(active)} tone="success" /><MetricCard label="Recent audit entries" value={String(data.logs.length)} tone="info" /><MetricCard label="Backups pending" value={String(queued)} tone={queued ? 'warning' : 'success'} /></View><View style={styles.userChartFilters}><SelectField label="User role" value={roleFilter} options={[{ label: 'All roles', value: 'all' }, ...roleOptions]} onChange={setRoleFilter} containerStyle={styles.filter} /><SelectField label="Account status" value={statusFilter} options={[{ label: 'All statuses', value: 'all' }, ...['active', 'inactive', 'suspended'].map((value) => ({ label: `${value[0].toUpperCase()}${value.slice(1)}`, value }))]} onChange={setStatusFilter} containerStyle={styles.filter} /></View><Text style={styles.chartCount}>Showing {visibleUsers.length.toLocaleString()} of {data.users.length.toLocaleString()} accounts</Text><View style={styles.analyticsCharts}><VisualizationPanel title="Accounts by role" description="Role distribution for filtered accounts." data={roleSeries} type="pie" /><VisualizationPanel title="Account status" description="Active, inactive, and suspended accounts." data={statusSeries} type="pie" /><VisualizationPanel title="Audit activity" description="Audit entries per day from the latest 100 authorized records." data={auditTrend} type="line" /></View><Card><Text style={styles.cardTitle}>Recent audit activity</Text>{data.logs.length ? <DataTable columns={['Time', 'Action', 'Entity', 'Actor', 'Status']} rows={data.logs.slice(0, 10).map((row) => [date(row.createdAt), row.action, row.entityType, auditActorLabel(row.actorId, data), 'Recorded'])} columnWidths={[148, 240, 112, 200, 88]} columnFlex={[0, 0.5, 0.15, 0.25, 0]} widthMode="container" /> : <PageState kind="empty" title="No audit activity" message="Permission-checked administration events will appear here." />}</Card></>;
}

function Users({ data, refresh, toast, userId }: Props) {
  const [createOpen, setCreateOpen] = useState(false); const [selected, setSelected] = useState<ManagedUser | null>(null); const [saving, setSaving] = useState(false);
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]); const [bulkMenuOpen, setBulkMenuOpen] = useState(false); const [deleteSelectedOpen, setDeleteSelectedOpen] = useState(false); const [forceDeleteWithoutTakeover, setForceDeleteWithoutTakeover] = useState(false); const [forceDeleteLinkedRecords, setForceDeleteLinkedRecords] = useState(false); const [bulkBusy, setBulkBusy] = useState(false); const [takeoverEmails, setTakeoverEmails] = useState<Record<string, string>>({});
  const bulkMenuTriggerRef = useRef<View>(null); const { width: screenWidth, height: screenHeight } = useWindowDimensions(); const [bulkMenuPosition, setBulkMenuPosition] = useState({ left: 8, top: 8 });
  const [email, setEmail] = useState(''); const [firstName, setFirstName] = useState(''); const [lastName, setLastName] = useState(''); const [role, setRole] = useState<CoreRole>('faculty'); const [departmentId, setDepartmentId] = useState(data.departments[0]?.id ?? ''); const [employeeId, setEmployeeId] = useState('');
  const [editRole, setEditRole] = useState<CoreRole>('faculty'); const [editDepartment, setEditDepartment] = useState(data.departments[0]?.id ?? ''); const [editEmployeeId, setEditEmployeeId] = useState('');
  const openManage = (user: ManagedUser) => { setSelected(user); setEditRole(user.role ?? 'faculty'); setEditDepartment(user.scopeId ?? data.departments[0]?.id ?? ''); setEditEmployeeId(''); };
  const create = async () => { setSaving(true); try { const redirectTo = Platform.OS === 'web' && typeof globalThis.location !== 'undefined' ? `${globalThis.location.origin}/onboarding?flow=invite` : `${Linking.createURL('/onboarding')}?flow=invite`; await createManagedUser({ email, redirectTo, firstName, lastName, role, departmentId: role === 'system_admin' ? undefined : departmentId, employeeId: role === 'faculty' ? employeeId : undefined }); setCreateOpen(false); setEmail(''); setFirstName(''); setLastName(''); setEmployeeId(''); toast.show('Invitation sent. The new user can set their password and secure the account from the email link.'); refresh(); } catch (cause) { toast.show(getErrorMessage(cause, 'Could not send the account invitation. Check the details and try again.')); } finally { setSaving(false); } };
  const resendInvitation = async () => { if (!selected) return; setSaving(true); try { const redirectTo = Platform.OS === 'web' && typeof globalThis.location !== 'undefined' ? `${globalThis.location.origin}/onboarding?flow=invite` : `${Linking.createURL('/onboarding')}?flow=invite`; await resendManagedUserInvitation({ userId: selected.id, redirectTo }); toast.show(`A new onboarding invitation was sent to ${selected.email}.`); refresh(); } catch (cause) { toast.show(getErrorMessage(cause, 'The onboarding invitation could not be resent.')); } finally { setSaving(false); } };
  const sendPasswordReset = async () => { if (!selected) return; setSaving(true); try { const redirectTo = Platform.OS === 'web' && typeof globalThis.location !== 'undefined' ? `${globalThis.location.origin}/reset-password` : Linking.createURL('/reset-password'); await sendManagedUserPasswordReset({ userId: selected.id, redirectTo }); toast.show(`A password reset link was sent to ${selected.email}.`); } catch (cause) { toast.show(getErrorMessage(cause, 'The password reset link could not be sent.')); } finally { setSaving(false); } };
  const update = async (status?: 'active' | 'inactive' | 'suspended') => { if (!selected) return; setSaving(true); try { await updateManagedUser({ userId: selected.id, status, role: editRole, departmentId: editRole === 'system_admin' ? undefined : editDepartment, employeeId: editRole === 'faculty' ? editEmployeeId || undefined : undefined }); setSelected(null); toast.show('Account role, scope, and status were updated.'); refresh(); } catch (cause) { toast.show(getErrorMessage(cause, 'Account update failed.')); } finally { setSaving(false); } };
  const visibleIds = data.users.map((user) => user.id);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedUserIds.includes(id));
  const activeSelectedCount = data.users.filter((user) => selectedUserIds.includes(user.id) && user.status === 'active').length;
  const academicAdminGroups = new Map<string, ManagedUser[]>();
  for (const admin of data.users) {
    if (admin.role !== 'academic_admin' || admin.scopeType !== 'department' || !admin.scopeId || admin.status !== 'active') continue;
    academicAdminGroups.set(admin.scopeId, [...(academicAdminGroups.get(admin.scopeId) ?? []), admin]);
  }
  const takeoverDepartments = [...academicAdminGroups.entries()].flatMap(([departmentId, admins]) => admins.every((admin) => selectedUserIds.includes(admin.id)) ? [{ departmentId, department: data.departments.find((item) => item.id === departmentId), admins }] : []);
  const savedTakeoverEmail = (admins: ManagedUser[]) => { const emails = [...new Set(admins.map((admin) => admin.takeoverEmail?.trim().toLowerCase()).filter((value): value is string => Boolean(value)))]; return emails.length === 1 ? emails[0] : ''; };
  const takeoverEmailValues = takeoverDepartments.map(({ departmentId, admins }) => (takeoverEmails[departmentId] ?? savedTakeoverEmail(admins)).trim().toLowerCase());
  const existingAccountEmails = new Set(data.users.map((user) => user.email.toLowerCase()));
  const takeoverEmailsValid = forceDeleteWithoutTakeover || (takeoverEmailValues.every((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !existingAccountEmails.has(email)) && new Set(takeoverEmailValues).size === takeoverEmailValues.length);
  const showBulkMenu = () => bulkMenuTriggerRef.current?.measureInWindow((x, y, width, height) => {
    setBulkMenuPosition({ left: Math.max(8, Math.min(screenWidth - 252, x + width - 244)), top: Math.max(8, Math.min(screenHeight - 116, y + height + 4)) });
    setBulkMenuOpen(true);
  });
  const toggleUser = (userId: string) => setSelectedUserIds((current) => current.includes(userId) ? current.filter((id) => id !== userId) : [...current, userId]);
  const toggleAllUsers = () => setSelectedUserIds(allSelected ? [] : visibleIds);
  const deactivateSelected = async () => {
    const targets = data.users.filter((user) => selectedUserIds.includes(user.id) && user.status === 'active');
    if (!targets.length) return;
    setBulkBusy(true);
    const outcomes = await Promise.allSettled(targets.map((user) => updateManagedUser({ userId: user.id, status: 'inactive' })));
    const succeeded = outcomes.filter((outcome) => outcome.status === 'fulfilled').length;
    const failed = outcomes.length - succeeded;
    setBulkBusy(false); setBulkMenuOpen(false); setSelectedUserIds([]); refresh();
    toast.show(failed ? `${succeeded} account${succeeded === 1 ? '' : 's'} deactivated; ${failed} could not be deactivated.` : `${succeeded} account${succeeded === 1 ? '' : 's'} deactivated.`);
  };
  const deleteSelected = async () => {
    setBulkBusy(true);
    try {
      const redirectTo = Platform.OS === 'web' && typeof globalThis.location !== 'undefined' ? `${globalThis.location.origin}/onboarding?flow=invite` : `${Linking.createURL('/onboarding')}?flow=invite`;
      const result = await deleteManagedUsers(selectedUserIds, Object.fromEntries(takeoverDepartments.map(({ departmentId, admins }) => [departmentId, (takeoverEmails[departmentId] ?? savedTakeoverEmail(admins)).trim()])), redirectTo, forceDeleteWithoutTakeover, forceDeleteLinkedRecords);
      setSelectedUserIds([]); setDeleteSelectedOpen(false); setBulkMenuOpen(false); refresh();
      const deleted = result.deletedUserIds.length;
      const failed = result.failed.length;
      const handoffs = result.createdTakeovers.length;
      const forcedDepartments = result.forcedDepartments.length;
      const linkedRecordAccounts = result.linkedRecordsDeletedUserIds.length;
      toast.show(failed ? `${deleted} account${deleted === 1 ? '' : 's'} deleted; ${handoffs} department takeover account${handoffs === 1 ? '' : 's'} invited; ${forcedDepartments ? `${forcedDepartments} department${forcedDepartments === 1 ? '' : 's'} left without a replacement Academic Admin; ` : ''}${linkedRecordAccounts ? `linked records removed for ${linkedRecordAccounts} account${linkedRecordAccounts === 1 ? '' : 's'}; ` : ''}${failed} could not be deleted.` : `${deleted} account${deleted === 1 ? '' : 's'} deleted${handoffs ? ` and ${handoffs} department takeover account${handoffs === 1 ? '' : 's'} invited` : ''}${forcedDepartments ? `; ${forcedDepartments} department${forcedDepartments === 1 ? '' : 's'} left without a replacement Academic Admin` : ''}${linkedRecordAccounts ? `; linked records removed for ${linkedRecordAccounts} account${linkedRecordAccounts === 1 ? '' : 's'}` : ''}.`);
      if (result.deletedUserIds.includes(userId)) await supabase?.auth.signOut();
    } catch (cause) { toast.show(getErrorMessage(cause, 'Selected accounts could not be deleted.')); }
    finally { setBulkBusy(false); }
  };
  const activeDepartments = data.departments.filter((department) => department.status === 'active');
  return <><Heading title="User Management" subtitle="Create and manage APMS accounts. New users receive an email invitation to complete secure account setup." action={<View style={styles.userHeadingActions}><View ref={bulkMenuTriggerRef} collapsable={false}><Button label={`Bulk actions${selectedUserIds.length ? ` (${selectedUserIds.length})` : ''}`} variant="secondary" disabled={selectedUserIds.length === 0 || bulkBusy} onPress={() => bulkMenuOpen ? setBulkMenuOpen(false) : showBulkMenu()} /></View><Button label="Invite user" onPress={() => setCreateOpen(true)} /></View>} />{data.users.length ? <DataTable compact columns={['Select', 'Name', 'Email', 'Role', 'Scope', 'Last login', 'Status', 'Manage']} columnHeaderContent={[<Pressable key="select-all" accessibilityRole="checkbox" accessibilityState={{ checked: allSelected }} accessibilityLabel={allSelected ? 'Deselect all users' : 'Select all users'} onPress={toggleAllUsers} style={styles.userCheckbox}><Text style={styles.userCheckboxMark}>{allSelected ? '✓' : ''}</Text></Pressable>]} columnWidths={[42, 150, 250, 130, 86, 170, 90, 100]} columnFlex={[0, 1, 2, 1, 0, 0, 0, 0]} widthMode="container" formatCell={(cell, _row, columnIndex) => columnIndex === 5 && typeof cell === 'string' ? <LastLogin value={cell || null} /> : undefined} rows={data.users.map((user) => [<Pressable key={`select-${user.id}`} accessibilityRole="checkbox" accessibilityState={{ checked: selectedUserIds.includes(user.id) }} accessibilityLabel={`${selectedUserIds.includes(user.id) ? 'Deselect' : 'Select'} ${user.firstName} ${user.lastName}`} onPress={() => toggleUser(user.id)} style={styles.userCheckbox}><Text style={styles.userCheckboxMark}>{selectedUserIds.includes(user.id) ? '✓' : ''}</Text></Pressable>, `${user.firstName} ${user.lastName}`, user.email, displayRole(user.role), user.scopeType === 'global' ? 'Global' : data.departments.find((department) => department.id === user.scopeId)?.code ?? 'Unassigned', user.lastLoginAt ?? '', `${user.status[0].toUpperCase()}${user.status.slice(1)}`, <Button compact key={user.id} label="Manage" variant="secondary" onPress={() => openManage(user)} />])} /> : <PageState kind="empty" title="No APMS users" message="Create a System Admin, Academic Admin, or Faculty account." />}
    <Modal visible={bulkMenuOpen} transparent animationType="fade" onRequestClose={() => setBulkMenuOpen(false)}>
      <View style={{ flex: 1 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Close bulk actions" onPress={() => setBulkMenuOpen(false)} style={StyleSheet.absoluteFill} />
        <View style={[{ position: 'absolute', minWidth: 225, gap: 4, padding: 7, backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 10, elevation: 12, shadowColor: '#000', shadowOpacity: 0.14, shadowRadius: 9, shadowOffset: { width: 0, height: 4 } }, bulkMenuPosition]}>
          <Pressable accessibilityRole="button" disabled={bulkBusy || activeSelectedCount === 0} onPress={() => void deactivateSelected()} style={({ pressed }) => [{ minHeight: 42, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 10, borderRadius: 7, backgroundColor: pressed ? colors.canvas : 'transparent', opacity: activeSelectedCount === 0 ? 0.45 : 1 }]}><AppIcon name="archive" size={16} color={colors.textMuted} /><Text style={{ color: colors.text, fontSize: 13, fontWeight: '600' }}>Deactivate selected users</Text></Pressable>
          <Pressable accessibilityRole="button" disabled={bulkBusy} onPress={() => { setBulkMenuOpen(false); setForceDeleteWithoutTakeover(false); setForceDeleteLinkedRecords(false); setDeleteSelectedOpen(true); }} style={({ pressed }) => [{ minHeight: 42, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 10, borderRadius: 7, backgroundColor: pressed ? colors.canvas : 'transparent' }]}><AppIcon name="delete" size={16} color={colors.danger} /><Text style={{ color: colors.danger, fontSize: 13, fontWeight: '600' }}>Delete selected users</Text></Pressable>
        </View>
      </View>
    </Modal>
    <Dialog visible={createOpen} title="Invite APMS account" onClose={() => setCreateOpen(false)}><Text style={styles.dialogIntro}>The System Admin sets the user's name, email, role, department, and employee ID. APMS emails them a secure onboarding link to verify their email, choose a password, and configure two-step verification.</Text><View style={styles.formGrid}><Field label="First name" value={firstName} onChangeText={setFirstName} /><Field label="Last name" value={lastName} onChangeText={setLastName} /><Field label="Institutional email" value={email} keyboardType="email-address" onChangeText={setEmail} /></View><SelectField label="Core role" value={role} options={roleOptions} onChange={(value) => setRole(value as CoreRole)} />{role !== 'system_admin' ? <SelectField label="Department scope" value={departmentId} options={activeDepartments.map((department) => ({ label: `${department.code} · ${department.name}`, value: department.id }))} onChange={setDepartmentId} /> : null}{role === 'faculty' ? <Field label="Employee ID" value={employeeId} onChangeText={setEmployeeId} /> : null}<Button label="Send onboarding invitation" loading={saving} disabled={!email.trim() || !firstName.trim() || !lastName.trim() || (role !== 'system_admin' && !departmentId) || (role === 'faculty' && !employeeId.trim())} onPress={() => void create()} /></Dialog>
    <Dialog visible={Boolean(selected)} title="Manage account" onClose={() => setSelected(null)}>{selected ? <><Text style={styles.cardTitle}>{selected.firstName} {selected.lastName}</Text><Text style={styles.help}>{selected.email}{selected.status === 'invited' ? ' · Invitation pending' : ''}</Text>{selected.status === 'invited' && !selected.onboardingComplete ? <Button label="Resend onboarding invitation" variant="secondary" loading={saving} disabled={saving} onPress={() => void resendInvitation()} /> : null}{selected.status === 'active' && selected.onboardingComplete ? <View style={{ gap: 5 }}><Button label="Send password reset link" variant="secondary" loading={saving} disabled={saving} onPress={() => void sendPasswordReset()} /><Text style={styles.help}>The user can choose a new password from the email link without entering their current password.</Text></View> : null}<SelectField label="Core role" value={editRole} options={roleOptions} onChange={(value) => setEditRole(value as CoreRole)} />{editRole !== 'system_admin' ? <SelectField label="Department scope" value={editDepartment} options={activeDepartments.map((department) => ({ label: `${department.code} · ${department.name}`, value: department.id }))} onChange={setEditDepartment} /> : null}{editRole === 'faculty' && selected.role !== 'faculty' ? <Field label="Employee ID required for new Faculty role" value={editEmployeeId} onChangeText={setEditEmployeeId} /> : null}<View style={styles.actions}><Button label="Save changes" loading={saving} disabled={editRole === 'faculty' && selected.role !== 'faculty' && !editEmployeeId.trim()} onPress={() => void update()} /><Button label={selected.status === 'active' ? 'Deactivate' : selected.status === 'invited' ? 'Deactivate invitation' : 'Activate'} variant="secondary" loading={saving} onPress={() => void update(selected.status === 'inactive' || selected.status === 'suspended' ? 'active' : 'inactive')} /></View></> : null}</Dialog>
    <Dialog visible={deleteSelectedOpen} title={`Delete ${selectedUserIds.length} selected user${selectedUserIds.length === 1 ? '' : 's'}?`} onClose={() => { if (!bulkBusy) { setDeleteSelectedOpen(false); setForceDeleteWithoutTakeover(false); setForceDeleteLinkedRecords(false); } }}>
      <Text style={styles.dialogIntro}>This permanently removes the selected accounts. Accounts still linked to records may be blocked and should be deactivated instead.</Text>
      {takeoverDepartments.length ? <View style={{ gap: 10 }}><Text style={styles.dialogIntro}>The selected admins are the only active Academic Admins for these departments. Use the saved takeover email or enter another address to invite a replacement before deleting.</Text>{takeoverDepartments.map(({ departmentId, department, admins }) => forceDeleteWithoutTakeover ? <Text key={departmentId} style={styles.forceDeleteWarning}>{department?.code ?? 'This department'} will have no active Academic Admin, and no replacement invitation will be sent.</Text> : <Field key={departmentId} label={`Takeover email · ${department?.code ?? 'Department'}`} value={takeoverEmails[departmentId] ?? savedTakeoverEmail(admins)} onChangeText={(value) => setTakeoverEmails((current) => ({ ...current, [departmentId]: value }))} keyboardType="email-address" autoCapitalize="none" placeholder="name@example.com" />)}<Pressable accessibilityRole="checkbox" accessibilityState={{ checked: forceDeleteWithoutTakeover }} onPress={() => setForceDeleteWithoutTakeover((current) => !current)} style={styles.forceDeleteOption}><AppIcon name={forceDeleteWithoutTakeover ? 'checkboxChecked' : 'checkbox'} size={18} color={forceDeleteWithoutTakeover ? colors.danger : colors.textMuted} /><View style={{ flex: 1 }}><Text style={styles.forceDeleteLabel}>Force delete without a takeover email</Text><Text style={styles.help}>Skip creating a replacement Academic Admin account.</Text></View></Pressable></View> : null}
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: forceDeleteLinkedRecords }} onPress={() => setForceDeleteLinkedRecords((current) => !current)} style={styles.forceDeleteOption}><AppIcon name={forceDeleteLinkedRecords ? 'checkboxChecked' : 'checkbox'} size={18} color={forceDeleteLinkedRecords ? colors.danger : colors.textMuted} /><View style={{ flex: 1 }}><Text style={styles.forceDeleteLabel}>Force delete even if linked to records</Text><Text style={styles.help}>Permanently delete records that prevent the selected accounts from being removed.</Text></View></Pressable>
      {forceDeleteLinkedRecords ? <Text style={styles.linkedRecordsWarning}>Linked records may contain class, grade, request, or other account-related data. This data cannot be recovered.</Text> : null}
      <View style={styles.dialogActions}><Button label="Cancel" variant="secondary" disabled={bulkBusy} onPress={() => { setDeleteSelectedOpen(false); setForceDeleteWithoutTakeover(false); setForceDeleteLinkedRecords(false); }} /><Button label={forceDeleteWithoutTakeover || forceDeleteLinkedRecords ? 'Force delete selected users' : 'Delete selected users'} variant="danger" loading={bulkBusy} disabled={bulkBusy || !takeoverEmailsValid} onPress={() => void deleteSelected()} /></View>
    </Dialog>
  </>;
}

type SetupDialog = 'department' | 'program' | 'term' | null;
function AcademicSetup({ data, refresh, userId, toast, initialSection }: Props & { initialSection?: string }) {
  const requestedSection = initialSection === 'Program requests' ? 'Program creation requests' : initialSection;
  const [section, setSection] = useState(['Departments', 'Programs', 'Program creation requests', 'Academic terms', 'Institution code'].includes(requestedSection ?? '') ? requestedSection! : 'Departments');
  const [institutionCode, setInstitutionCode] = useState(String(data.settings.find((item) => item.key === 'academic.institution_code')?.value ?? 'SWU').toUpperCase());
  const [savingInstitutionCode, setSavingInstitutionCode] = useState(false);
  const [dialog, setDialog] = useState<SetupDialog>(null);
  const [saving, setSaving] = useState(false);
  const [deletingProgram, setDeletingProgram] = useState<ProgramRecord | null>(null);
  const [department, setDepartment] = useState<DepartmentRecord | null>(null);
  const [program, setProgram] = useState<ProgramRecord | null>(null);
  const [term, setTerm] = useState<AcademicTermRecord | null>(null);
  const [code, setCode] = useState(''); const [name, setName] = useState(''); const [departmentId, setDepartmentId] = useState(''); const [status, setStatus] = useState<'active' | 'inactive'>('active');
  const [academicYear, setAcademicYear] = useState(''); const [semester, setSemester] = useState(''); const [startsOn, setStartsOn] = useState(''); const [endsOn, setEndsOn] = useState(''); const [termStatus, setTermStatus] = useState<AcademicTermRecord['status']>('planned');
  const [programRequests, setProgramRequests] = useState<ProgramRequestRecord[]>([]);
  const [selectedProgramRequest, setSelectedProgramRequest] = useState<ProgramRequestRecord | null>(null);
  const [programRequestRejectionReason, setProgramRequestRejectionReason] = useState('');
  const [reviewingProgramRequest, setReviewingProgramRequest] = useState(false);
  useEffect(() => {
    let active = true;
    void loadProgramRequests().then((loaded) => { if (active) setProgramRequests(loaded); })
      .catch((cause) => { if (active) toast.show(getErrorMessage(cause, 'Program creation requests could not be loaded.')); });
    return () => { active = false; };
  }, [data.programs, toast]);
  useEffect(() => { setInstitutionCode(String(data.settings.find((item) => item.key === 'academic.institution_code')?.value ?? 'SWU').toUpperCase()); }, [data.settings]);
  const saveInstitutionCodeValue = async () => {
    const normalized = institutionCode.trim().toUpperCase();
    if (!/^[A-Z0-9]{2,12}$/.test(normalized)) return toast.show('Use 2–12 letters or numbers for the institution code.');
    setSavingInstitutionCode(true);
    try { await saveSystemSetting(userId, 'academic.institution_code', normalized); setInstitutionCode(normalized); toast.show('Institution code saved.'); refresh(); }
    catch (cause) { toast.show(getErrorMessage(cause, 'Institution code could not be saved.')); }
    finally { setSavingInstitutionCode(false); }
  };
  const close = () => { setDialog(null); setDepartment(null); setProgram(null); setTerm(null); };
  const openDepartment = (value?: DepartmentRecord) => { setDepartment(value ?? null); setCode(value?.code ?? ''); setName(value?.name ?? ''); setStatus(value?.status ?? 'active'); setDialog('department'); };
  const openProgram = (value?: ProgramRecord) => { setProgram(value ?? null); setCode(value?.code ?? ''); setName(value?.name ?? ''); setDepartmentId(value?.departmentId ?? data.departments.find((item) => item.status === 'active')?.id ?? ''); setStatus(value?.status ?? 'active'); setDialog('program'); };
  const openTerm = (value?: AcademicTermRecord) => { setTerm(value ?? null); setAcademicYear(value?.academicYear ?? ''); setSemester(value?.semester ?? ''); setStartsOn(value?.startsOn ?? ''); setEndsOn(value?.endsOn ?? ''); setTermStatus(value?.status ?? 'planned'); setDialog('term'); };
  const save = async () => { setSaving(true); try { if (dialog === 'department') await saveDepartment({ id: department?.id, code, name, status }); if (dialog === 'program') await saveProgram({ id: program?.id, departmentId, code, name, status }); if (dialog === 'term') await saveAcademicTerm({ id: term?.id, academicYear, semester, startsOn, endsOn, status: termStatus }); toast.show('Academic setup saved.'); close(); refresh(); } catch (cause) { toast.show(getErrorMessage(cause, 'Academic setup could not be saved.')); } finally { setSaving(false); } };
  const removeProgram = async () => { if (!deletingProgram) return; setSaving(true); try { await deleteProgram(deletingProgram.id); toast.show('Program deleted.'); setDeletingProgram(null); close(); refresh(); } catch (cause) { toast.show(getErrorMessage(cause, 'Program could not be deleted.')); } finally { setSaving(false); } };
  const reviewProgram = async (request: ProgramRequestRecord, decision: 'approved' | 'rejected') => {
    if (decision === 'rejected' && programRequestRejectionReason.trim().length < 3) return toast.show('Enter a rejection reason (at least 3 characters).');
    setReviewingProgramRequest(true);
    try {
      await reviewProgramRequest({ requestId: request.id, decision, rejectionReason: decision === 'rejected' ? programRequestRejectionReason : undefined });
      toast.show(decision === 'approved' ? `${request.code} was approved and added to Academic Setup.` : `${request.code} request was rejected.`);
      setSelectedProgramRequest(null); setProgramRequestRejectionReason('');
      setProgramRequests(await loadProgramRequests());
      refresh();
    } catch (cause) { toast.show(getErrorMessage(cause, 'Program request could not be reviewed.')); }
    finally { setReviewingProgramRequest(false); }
  };
  const activeDepartments = data.departments.filter((item) => item.status === 'active');
  const sectionAction = section === 'Departments'
    ? <Button label="Add department" onPress={() => openDepartment()} />
    : section === 'Programs'
      ? <Button label="Add program" disabled={!activeDepartments.length} onPress={() => openProgram()} />
      : section === 'Academic terms' ? <Button label="Add term" onPress={() => openTerm()} /> : undefined;
  return <><Heading title="Academic Setup" subtitle="Manage departments, programs, academic terms, and institution identity." action={sectionAction} />
    <Tabs values={['Departments', 'Programs', 'Program creation requests', 'Academic terms', 'Institution code']} selected={section} onSelect={setSection} />
    <View style={{ gap: 16 }}>
      {section === 'Departments' ? <>
        <View style={{ gap: 3 }}><Text style={styles.sectionTitle}>Departments</Text><Text style={styles.sectionHelp}>Departments define the scope available to Academic Admin and Faculty accounts.</Text></View>
        {data.departments.length ? <DataTable columns={['Code', 'Department', 'Programs', 'Status', 'Actions']} rows={data.departments.map((item) => [item.code, item.name, String(data.programs.filter((program) => program.departmentId === item.id).length), item.status[0].toUpperCase() + item.status.slice(1), <Button compact key={item.id} label="Edit" variant="secondary" onPress={() => openDepartment(item)} />])} columnWidths={[96, 300, 88, 92, 96]} widthMode="container" /> : <PageState kind="empty" title="No departments yet" message="Use Add department above to create the first department." />}
      </> : null}
      {section === 'Programs' ? <>
        <View style={{ gap: 3 }}><Text style={styles.sectionTitle}>Programs</Text><Text style={styles.sectionHelp}>Programs are grouped under a department and can be activated or archived.</Text></View>
        {data.programs.length ? <DataTable columns={['Code', 'Program', 'Department', 'Status', 'Actions']} rows={data.programs.map((item) => [item.code, item.name, data.departments.find((department) => department.id === item.departmentId)?.name ?? 'Unassigned', item.status[0].toUpperCase() + item.status.slice(1), <View key={item.id} style={{ flexDirection: 'row', gap: 6 }}><Button compact label="Edit" variant="secondary" onPress={() => openProgram(item)} /><Button compact label="Delete" variant="danger" onPress={() => setDeletingProgram(item)} /></View>])} columnWidths={[92, 320, 220, 92, 172]} widthMode="container" /> : <PageState kind="empty" title="No programs yet" message="You may need to create a department first, if you haven't already." action={<Button label="Create program" disabled={!activeDepartments.length} onPress={() => openProgram()} />} />}
      </> : null}
      {section === 'Program creation requests' ? <>
        <View style={{ gap: 3 }}><Text style={styles.sectionTitle}>Program creation requests</Text><Text style={styles.sectionHelp}>Review program creation requests from Academic Admins. Approving creates an active program. Rejections require a reason.</Text></View>
        {programRequests.length ? programRequests.map((request) => {
          const department = data.departments.find((item) => item.id === request.departmentId);
          const requester = data.users.find((item) => item.id === request.requestedBy);
          const statusTone = request.status === 'approved' ? 'success' : request.status === 'rejected' ? 'danger' : 'warning';
          return <Card key={request.id} style={{ gap: 10 }}>
            <View style={styles.sectionHeader}><View style={styles.flex}><Text style={styles.settingLabel}>{request.code} · {request.name}</Text><Text style={styles.sectionHelp}>{department?.code ?? 'Department'} · {department?.name ?? 'Unknown department'} · Requested by {requester ? `${requester.firstName} ${requester.lastName}`.trim() : 'Academic Admin'} on {date(request.createdAt)}</Text></View><Badge tone={statusTone}>{request.status[0].toUpperCase() + request.status.slice(1)}</Badge></View>
            {request.rationale || request.rejectionReason ? <View style={styles.programRequestNotes}>
              {request.rationale ? <View style={styles.programRequestReason}><Text style={styles.deadlineReasonLabel}>Request reason</Text><Text style={styles.help}>{request.rationale}</Text></View> : null}
              {request.rejectionReason ? <View style={styles.programRequestReason}><Text style={styles.deadlineReasonLabel}>Rejection reason</Text><Text style={styles.help}>{request.rejectionReason}</Text></View> : null}
            </View> : null}
            {request.status === 'pending' ? <View style={styles.actions}><Button compact label="Approve and add program" disabled={reviewingProgramRequest} onPress={() => void reviewProgram(request, 'approved')} /><Button compact label="Reject…" variant="secondary" disabled={reviewingProgramRequest} onPress={() => { setSelectedProgramRequest(request); setProgramRequestRejectionReason(''); }} /></View> : request.programId ? <Text style={styles.help}>Created as an active program.</Text> : null}
          </Card>;
        }) : <PageState kind="empty" title="No program creation requests" message="Program creation requests from Academic Admins will appear here." />}
      </> : null}
      {section === 'Academic terms' ? <>
        <View style={{ gap: 3 }}><Text style={styles.sectionTitle}>Academic terms</Text><Text style={styles.sectionHelp}>Terms must exist before Faculty can create monitoring classes.</Text></View>
        {data.terms.length ? <DataTable columns={['Academic year', 'Semester', 'Starts', 'Ends', 'Status', 'Actions']} rows={data.terms.map((item) => [item.academicYear, item.semester, item.startsOn, item.endsOn, item.status[0].toUpperCase() + item.status.slice(1), <Button compact key={item.id} label="Edit" variant="secondary" onPress={() => openTerm(item)} />])} columnWidths={[120, 120, 112, 112, 92, 96]} widthMode="container" /> : <PageState kind="empty" title="No academic terms yet" message="Create the current academic term before setting up classes." action={<Button label="Create term" onPress={() => openTerm()} />} />}
      </> : null}
      {section === 'Institution code' ? <Card style={{ gap: 12, maxWidth: 680 }}>
        <View style={{ gap: 3 }}><Text style={styles.sectionTitle}>Institution code</Text><Text style={styles.sectionHelp}>Used in institution-wide section names, for example {institutionCode || 'SWU'}-BSIT3-C2. Department codes are not used as institution prefixes.</Text></View>
        <Field label="Institution code" value={institutionCode} onChangeText={(value) => setInstitutionCode(value.replace(/[^a-z0-9]/gi, '').slice(0, 12).toUpperCase())} placeholder="SWU" maxLength={12} autoCapitalize="characters" />
        <Button label="Save institution code" loading={savingInstitutionCode} disabled={savingInstitutionCode || institutionCode.trim().length < 2} onPress={() => void saveInstitutionCodeValue()} />
      </Card> : null}
    </View>
    <Dialog visible={dialog === 'department'} title={department ? 'Edit department' : 'Create department'} onClose={close}><Field label="Department code" value={code} onChangeText={setCode} placeholder="e.g. CIT" /><Field label="Department name" value={name} onChangeText={setName} placeholder="e.g. College of Information Technology" /><SelectField label="Status" value={status} options={[{ label: 'Active', value: 'active' }, { label: 'Inactive', value: 'inactive' }]} onChange={(value) => setStatus(value as 'active' | 'inactive')} /><Button label="Save department" loading={saving} disabled={!code.trim() || !name.trim()} onPress={() => void save()} /></Dialog>
    <Dialog visible={dialog === 'program'} title={program ? 'Edit program' : 'Create program'} onClose={close}><SelectField label="Department" value={departmentId} options={activeDepartments.map((item) => ({ label: `${item.code} · ${item.name}`, value: item.id }))} onChange={setDepartmentId} /><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}><Field containerStyle={{ flex: 1, minWidth: 120, maxWidth: 180 }} label="Program code" value={code} onChangeText={setCode} placeholder="e.g. BSIT" /><Field containerStyle={{ flex: 3, minWidth: 220 }} label="Program name" value={name} onChangeText={setName} placeholder="e.g. Bachelor of Science in Information Technology" /></View><SelectField label="Status" value={status} options={[{ label: 'Active', value: 'active' }, { label: 'Inactive', value: 'inactive' }]} onChange={(value) => setStatus(value as 'active' | 'inactive')} /><View style={styles.dialogActions}>{program ? <Button label="Delete permanently" variant="danger" disabled={saving} onPress={() => setDeletingProgram(program)} /> : null}<Button label="Save program" loading={saving} disabled={!departmentId || !code.trim() || !name.trim()} onPress={() => void save()} /></View></Dialog>
    <Dialog visible={dialog === 'term'} title={term ? 'Edit academic term' : 'Create academic term'} onClose={close}><Text style={styles.dialogIntro}>Set the teaching period used when Faculty creates monitoring classes. Select dates from the calendar.</Text><Field label="Academic year" value={academicYear} onChangeText={setAcademicYear} placeholder="e.g. 2026-2027" autoCapitalize="none" /><Field label="Semester" value={semester} onChangeText={setSemester} placeholder="e.g. First Semester" /><View style={styles.dateGrid}><DateField containerStyle={styles.dateField} label="Start date" value={startsOn} onChange={setStartsOn} /><DateField containerStyle={styles.dateField} label="End date" value={endsOn} onChange={setEndsOn} /></View><Text style={styles.fieldHint}>Choose the first and last day of the academic term. The dates are saved as YYYY-MM-DD.</Text><SelectField label="Status" value={termStatus} options={['planned', 'active', 'closed', 'archived'].map((value) => ({ label: value[0].toUpperCase() + value.slice(1), value }))} onChange={(value) => setTermStatus(value as AcademicTermRecord['status'])} /><View style={styles.dialogActions}><Button label="Cancel" variant="secondary" onPress={close} /><Button label="Save academic term" loading={saving} disabled={!academicYear.trim() || !semester.trim() || !startsOn || !endsOn} onPress={() => void save()} /></View></Dialog>
    <Dialog visible={selectedProgramRequest !== null} title="Reject program request" onClose={() => { if (!reviewingProgramRequest) { setSelectedProgramRequest(null); setProgramRequestRejectionReason(''); } }}><Text style={styles.dialogIntro}>A rejection reason is required and will be sent to the Academic Admin who requested {selectedProgramRequest?.code}.</Text><Field label="Rejection reason (required)" value={programRequestRejectionReason} onChangeText={setProgramRequestRejectionReason} multiline numberOfLines={4} maxLength={1000} placeholder="Explain why this program request is being rejected." /><View style={styles.dialogActions}><Button label="Cancel" variant="secondary" disabled={reviewingProgramRequest} onPress={() => setSelectedProgramRequest(null)} /><Button label="Reject request" variant="danger" loading={reviewingProgramRequest} disabled={programRequestRejectionReason.trim().length < 3} onPress={() => selectedProgramRequest && void reviewProgram(selectedProgramRequest, 'rejected')} /></View></Dialog>
    <ConfirmDialog visible={Boolean(deletingProgram)} title="Delete program permanently?" message={deletingProgram ? `Delete ${deletingProgram.code} · ${deletingProgram.name}? This cannot be undone. If students are linked, deletion will be blocked and you should mark the program Inactive instead.` : ''} confirmLabel="Delete program" cancelLabel="Keep program" danger pending={saving} onClose={() => { if (!saving) setDeletingProgram(null); }} onConfirm={() => void removeProgram()} />
  </>;
}
function Roles({ data }: Props) { return <><Heading title="Roles & Permissions" subtitle="The revised APMS role model contains exactly System Admin, Academic Admin, and Faculty; Super Admin is merged and Grader is removed." /><Card><DataTable columns={['Role', 'Key', 'Assigned users', 'Permissions', 'Scope']} rows={data.roles.filter((role) => ['system_admin', 'academic_admin', 'faculty'].includes(role.key)).map((role) => [role.name, role.key, String(role.users), String(role.permissions), role.key === 'system_admin' ? 'Global' : 'Department / assigned classes'])} /></Card></>; }
function Backups({ data, refresh, userId, toast }: Props) {
  const [activeTab, setActiveTab] = useState('Backup');
  const [selectedBackupIds, setSelectedBackupIds] = useState<string[]>([]);
  const [deletingBackups, setDeletingBackups] = useState(false);
  const [confirmDeleteBackups, setConfirmDeleteBackups] = useState(false);
  const [backupPassword, setBackupPassword] = useState('');
  const [latestBackupUrl, setLatestBackupUrl] = useState<{ url: string; fileName: string } | null>(null);
  const [restorePassword, setRestorePassword] = useState('');
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetConfirmation, setResetConfirmation] = useState('');
  const [resetResult, setResetResult] = useState<Awaited<ReturnType<typeof resetApplicationData>> | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreProgress, setRestoreProgress] = useState<number | null>(null);
  const [restoreFile, setRestoreFile] = useState<{ file: File; name: string } | null>(null);
  const [restoreRequiresPassword, setRestoreRequiresPassword] = useState(true);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [restoreStoredId, setRestoreStoredId] = useState<string | null>(null);
  const [frequency, setFrequency] = useState<'daily' | 'weekly' | 'monthly'>(data.backupSchedule?.frequency ?? 'daily');
  const [retentionDays, setRetentionDays] = useState(String(data.backupSchedule?.retentionDays ?? 30));
  const [scheduleEnabled, setScheduleEnabled] = useState(data.backupSchedule?.enabled ?? false);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const selectableBackups = data.backups.filter((backup) => !['deleted', 'running', 'queued'].includes(backup.status));
  const allBackupsSelected = selectableBackups.length > 0 && selectableBackups.every((backup) => selectedBackupIds.includes(backup.id));
  const toggleAllBackups = () => setSelectedBackupIds(allBackupsSelected ? [] : selectableBackups.map((backup) => backup.id));
  const toggleBackup = (id: string) => setSelectedBackupIds((current) => current.includes(id) ? current.filter((selectedId) => selectedId !== id) : [...current, id]);
  const deleteBackups = async () => {
    if (!selectedBackupIds.length) return;
    setDeletingBackups(true);
    try {
      const result = await deleteSelectedBackups(selectedBackupIds);
      setSelectedBackupIds((current) => current.filter((id) => !result.deletedIds.includes(id)));
      setConfirmDeleteBackups(false);
      toast.show(result.failed.length ? `${result.deletedIds.length} backup${result.deletedIds.length === 1 ? '' : 's'} deleted; ${result.failed.length} could not be deleted.` : `${result.deletedIds.length} backup${result.deletedIds.length === 1 ? '' : 's'} deleted.`);
      refresh();
    } catch (cause) { toast.show(getErrorMessage(cause, 'Selected backups could not be deleted.')); }
    finally { setDeletingBackups(false); }
  };
  useEffect(() => {
    setFrequency(data.backupSchedule?.frequency ?? 'daily');
    setRetentionDays(String(data.backupSchedule?.retentionDays ?? 30));
    setScheduleEnabled(data.backupSchedule?.enabled ?? false);
  }, [data.backupSchedule]);
  const makeBackup = async (passwordProtected: boolean) => {
    if (passwordProtected && backupPassword.length < 12) return toast.show('Use a backup password with at least 12 characters.');
    setCreating(true);
    try {
      const result = await createJsonBackup(passwordProtected ? backupPassword : undefined);
      setLatestBackupUrl({ url: result.downloadUrl, fileName: result.fileName });
      toast.show(`${passwordProtected ? 'Encrypted' : 'Unencrypted'} JSON backup created (${(result.sizeBytes / 1024 / 1024).toFixed(1)} MB).`);
      setBackupPassword('');
      refresh();
    } catch (cause) { toast.show(getErrorMessage(cause, 'Backup could not be created.')); }
    finally { setCreating(false); }
  };
  const selectRestoreFile = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: ['application/json', 'text/json', 'text/plain'], copyToCacheDirectory: true, multiple: false });
      if (result.canceled || !result.assets[0]) return;
      const asset = result.assets[0];
      const blob = asset.file ?? await (await fetch(asset.uri)).blob();
      const file = blob instanceof File ? blob : new File([blob], asset.name, { type: asset.mimeType ?? 'application/json' });
      if (!file.name.toLowerCase().endsWith('.json')) return toast.show('Choose an APMS backup JSON file.');
      if (file.size > 110 * 1024 * 1024) return toast.show('This backup is larger than the current 110 MB restore processing limit.');
      const header = await file.slice(0, 1024).text();
      const requiresPassword = /"format"\s*:\s*"apms-encrypted-json-backup"/.test(header);
      setRestoreFile({ file, name: file.name });
      setRestoreRequiresPassword(requiresPassword);
      setRestorePassword('');
      setRestoreProgress(null);
    } catch (cause) { toast.show(getErrorMessage(cause, 'Backup file could not be opened.')); }
  };
  const runRestore = async () => {
    if (!restoreFile || (restoreRequiresPassword && restorePassword.length < 12)) return;
    setRestoring(true);
    try {
      const uploaded = await uploadJsonBackup(restoreFile.file, setRestoreProgress);
      const result = await restoreJsonBackup(uploaded.path, uploaded.name, restoreRequiresPassword ? restorePassword : '');
      const accountNote = result.recreated_auth_accounts ? ` ${result.recreated_auth_accounts.toLocaleString()} account${result.recreated_auth_accounts === 1 ? ' was' : 's were'} recreated without a password or MFA; resend invitations so those users can complete setup.` : '';
      toast.show(`Restore complete. ${result.restored_rows.toLocaleString()} rows were recovered; existing rows were preserved.${accountNote}`);
      setRestoreFile(null);
      setRestorePassword('');
      setRestoreProgress(null);
      setConfirmRestore(false);
      refresh();
    } catch (cause) { toast.show(getErrorMessage(cause, 'Backup could not be restored.')); }
    finally { setRestoring(false); }
  };
  const runStoredRestore = async () => {
    if (!restoreStoredId) return;
    setRestoring(true);
    try {
      const result = await restoreStoredScheduledBackup(restoreStoredId);
      const accountNote = result.recreated_auth_accounts ? ` ${result.recreated_auth_accounts.toLocaleString()} account${result.recreated_auth_accounts === 1 ? ' was' : 's were'} recreated without a password or MFA; resend invitations so those users can complete setup.` : '';
      toast.show(`Restore complete. ${result.restored_rows.toLocaleString()} rows were recovered; existing rows were updated from the backup.${accountNote}`);
      setRestoreStoredId(null);
      refresh();
    } catch (cause) { toast.show(getErrorMessage(cause, 'Scheduled backup could not be restored.')); }
    finally { setRestoring(false); }
  };
  const runApplicationReset = async () => {
    if (resetConfirmation !== 'RESET') return;
    setResetting(true);
    try {
      const result = await resetApplicationData();
      setConfirmReset(false);
      setResetConfirmation('');
      setResetResult(result);
      refresh();
    } catch (cause) { toast.show(getErrorMessage(cause, 'Application data could not be reset.')); }
    finally { setResetting(false); }
  };
  const saveSchedule = async () => {
    const retention = Number(retentionDays);
    if (!Number.isInteger(retention) || retention < 1 || retention > 3650) return toast.show('Retention must be a whole number from 1 to 3,650 days.');
    setSavingSchedule(true);
    try {
      await saveBackupSchedule(userId, { id: data.backupSchedule?.id, frequency, enabled: scheduleEnabled, retentionDays: retention });
      toast.show('Backup schedule saved. Scheduled execution requires the APMS backup scheduler to be enabled in Supabase.');
      refresh();
    } catch (cause) { toast.show(getErrorMessage(cause, 'Backup schedule could not be saved.')); }
    finally { setSavingSchedule(false); }
  };
  const openBackup = async (path: string) => {
    const popup = window.open('about:blank', '_blank');
    if (popup) popup.opener = null;
    try {
      if (!supabase) throw new Error('APMS is not connected to Supabase.');
      const { data: signed, error } = await supabase.storage.from('apms-backups').createSignedUrl(path, 300);
      if (error || !signed) throw error ?? new Error('Download link could not be created.');
      if (popup) popup.location.replace(signed.signedUrl);
      else toast.show('Allow pop-ups to download the backup.');
    } catch (cause) { popup?.close(); toast.show(getErrorMessage(cause, 'Backup could not be downloaded.')); }
  };
  return <>
    <Heading title="Backup management" subtitle="Create and restore APMS application-data backups, manage automatic backups, and review recent activity." />
    <Tabs values={['Backup', 'Restore', 'Reset']} selected={activeTab} onSelect={setActiveTab} />
    {activeTab === 'Backup' ? <>
      <Card style={{ gap: 10 }}>
        <Text style={styles.sectionTitle}>Create a backup</Text>
        <Text style={styles.sectionHelp}>The JSON backup contains APMS application records. Authentication passwords and AI provider credentials are excluded.</Text>
        <Field label="Optional backup password" value={backupPassword} onChangeText={setBackupPassword} secureTextEntry autoCapitalize="none" placeholder="At least 12 characters for encryption" />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Button label="Create encrypted backup" loading={creating} disabled={creating || backupPassword.length < 12} onPress={() => void makeBackup(true)} />
          <Button label="Create unencrypted backup" variant="secondary" loading={creating} disabled={creating} onPress={() => void makeBackup(false)} />
        </View>
        <Text style={styles.sectionHelp}>Choose encrypted to protect the file with your password, or unencrypted to create it without one. Store unencrypted files only in a secure location.</Text>
        {latestBackupUrl ? <Button label={`Download ${latestBackupUrl.fileName}`} variant="secondary" onPress={() => window.open(latestBackupUrl.url, '_blank', 'noopener,noreferrer')} /> : null}
      </Card>
      <Card style={{ gap: 10 }}>
        <Text style={styles.sectionTitle}>Automatic backups</Text>
        <Text style={styles.sectionHelp}>Choose how often APMS creates a server-managed backup and how long to retain scheduled copies.</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', gap: 12 }}>
          <SelectField label="Frequency" value={frequency} options={[{ label: 'Daily', value: 'daily' }, { label: 'Weekly', value: 'weekly' }, { label: 'Monthly', value: 'monthly' }]} onChange={(value) => setFrequency(value as typeof frequency)} containerStyle={{ flex: 1, minWidth: 160 }} />
          <Field label="Keep backups (days)" value={retentionDays} onChangeText={setRetentionDays} keyboardType="numeric" containerStyle={{ flex: 1, minWidth: 160 }} />
          <Button label={scheduleEnabled ? 'Disable schedule' : 'Enable schedule'} variant="secondary" onPress={() => setScheduleEnabled((value) => !value)} />
          <Button label="Save schedule" loading={savingSchedule} disabled={savingSchedule} onPress={() => void saveSchedule()} />
        </View>
        {data.backupSchedule ? <Text style={styles.sectionHelp}>{data.backupSchedule.enabled ? 'Enabled' : 'Disabled'} · Next scheduled run {date(data.backupSchedule.nextRunAt)} · Last run {date(data.backupSchedule.lastRunAt)}</Text> : null}
      </Card>
      <View style={{ gap: 10, width: '100%' }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
          <Text style={styles.sectionTitle}>Backup history</Text>
          {selectedBackupIds.length ? <Button compact label={`Delete selected (${selectedBackupIds.length})`} variant="danger" disabled={deletingBackups} onPress={() => setConfirmDeleteBackups(true)} /> : null}
        </View>
        {data.backups.length ? <DataTable columns={['Select', 'Backup started', 'Backup completed', 'File', 'Size', 'Checksum (SHA-256)', 'Status', 'Details', 'Actions']} columnHeaderContent={[<Pressable key="select-all-backups" accessibilityRole="checkbox" accessibilityState={{ checked: allBackupsSelected }} accessibilityLabel={allBackupsSelected ? 'Deselect all backups' : 'Select all backups'} onPress={toggleAllBackups} style={styles.userCheckbox}><Text style={styles.userCheckboxMark}>{allBackupsSelected ? '✓' : ''}</Text></Pressable>]} rows={data.backups.map((row) => [<Pressable key={`select-${row.id}`} accessibilityRole="checkbox" accessibilityState={{ checked: selectedBackupIds.includes(row.id) }} accessibilityLabel={`${selectedBackupIds.includes(row.id) ? 'Deselect' : 'Select'} backup ${row.fileName ?? row.id}`} disabled={['deleted', 'running', 'queued'].includes(row.status)} onPress={() => toggleBackup(row.id)} style={[styles.userCheckbox, ['deleted', 'running', 'queued'].includes(row.status) && { opacity: 0.4 }]}><Text style={styles.userCheckboxMark}>{selectedBackupIds.includes(row.id) ? '✓' : ''}</Text></Pressable>, date(row.createdAt), date(row.completedAt), row.fileName ?? 'Backup', row.sizeBytes == null ? '—' : `${(row.sizeBytes / 1024 / 1024).toFixed(1)} MB`, row.checksum ?? '—', `${row.status[0].toUpperCase()}${row.status.slice(1)}`, row.safeError ?? '—', row.storagePath && row.status !== 'deleted' ? <View key={row.id} style={{ flexDirection: 'row', gap: 6 }}><Button compact label="Download" variant="secondary" onPress={() => void openBackup(row.storagePath!)} />{row.scheduleId ? <Button compact label="Restore" variant="secondary" onPress={() => setRestoreStoredId(row.id)} /> : null}</View> : '—'])} columnWidths={[42, 150, 150, 190, 80, 300, 96, 220, 220]} columnFlex={[0, 0, 0, 1.2, 0, 2, 0, 1, 0]} widthMode="container" formatCell={(cell, _row, columnIndex) => columnIndex === 6 && typeof cell === 'string' ? <Badge tone={cell === 'Completed' ? 'success' : cell === 'Failed' ? 'danger' : cell === 'Deleted' ? 'neutral' : 'warning'}>{cell}</Badge> : undefined} /> : <PageState kind="empty" title="No backups yet" message="Create a JSON backup to see it here." />}
      </View>
    </> : null}
    {activeTab === 'Restore' ? <>
      <Card style={{ gap: 10 }}>
        <Text style={styles.sectionTitle}>Restore from JSON</Text>
        <Text style={styles.sectionHelp}>Uploads above 6 MB use resumable chunks. The current restore processing limit is 110 MB. Matching rows are updated from the backup, and newer rows remain.</Text>
        <Text style={styles.sectionHelp}>Deleted accounts are recreated with their original IDs but no password or MFA factors. Profile and role data are restored; resend invitations so users can complete setup. OAuth sign-in links are not restored.</Text>
        <Button label={restoreFile ? `Selected: ${restoreFile.name}` : 'Choose backup JSON'} variant="secondary" onPress={() => void selectRestoreFile()} />
        <Field label={restoreRequiresPassword ? 'Backup password' : 'Backup password (not required for this file)'} value={restorePassword} onChangeText={setRestorePassword} secureTextEntry autoCapitalize="none" placeholder={restoreRequiresPassword ? 'Enter the password used for this backup' : 'This backup is unencrypted'} />
        {restoreProgress !== null ? <Text style={styles.sectionHelp}>{restoreProgress < 100 ? `Uploading backup: ${restoreProgress}% · upload can resume if interrupted` : 'Upload complete · preparing restore'}</Text> : null}
        <Button label="Restore backup" disabled={!restoreFile || (restoreRequiresPassword && restorePassword.length < 12) || restoring} loading={restoring} onPress={() => setConfirmRestore(true)} />
      </Card>
      <View style={{ gap: 10, width: '100%' }}>
        <Text style={styles.sectionTitle}>Restore history</Text>
        {data.backupRestores.length ? <DataTable columns={['Backup created', 'Restore started', 'Restore completed', 'Checksum (SHA-256)', 'Status', 'Details']} rows={data.backupRestores.map((row) => [date(row.backupCreatedAt), date(row.createdAt), date(row.completedAt), row.checksum ?? '—', `${row.status[0].toUpperCase()}${row.status.slice(1)}`, row.safeError ?? '—'])} columnWidths={[150, 150, 150, 300, 100, 280]} widthMode="container" formatCell={(cell, _row, columnIndex) => columnIndex === 4 && typeof cell === 'string' ? <Badge tone={cell === 'Completed' ? 'success' : cell === 'Failed' ? 'danger' : 'warning'}>{cell}</Badge> : undefined} /> : <Text style={styles.sectionHelp}>Completed and failed restore attempts will appear here.</Text>}
      </View>
    </> : null}
    {activeTab === 'Reset' ? <Card style={{ gap: 10, borderColor: '#FECACA', backgroundColor: '#FFFBFA' }}>
      <Text style={[styles.sectionTitle, { color: colors.danger }]}>Reset application data</Text>
      <Text style={styles.sectionHelp}>Permanently removes all accounts except your active System Admin account, along with departments, academic terms, programs, classes, students, gradebooks, evaluations, requests, and other application records. Roles, permissions, system settings, and backup history and schedules are retained.</Text>
      <View style={{ alignSelf: 'flex-start' }}><Button label="Reset application data" variant="danger" onPress={() => { setResetConfirmation(''); setConfirmReset(true); }} /></View>
    </Card> : null}
    <ConfirmDialog visible={confirmRestore} title="Restore this APMS backup?" message="Rows from the backup will be restored. Matching rows will be updated to the saved values, and records added after the backup will remain. The restore will be recorded in the audit log." confirmLabel="Restore backup" cancelLabel="Cancel" pending={restoring} onClose={() => { if (!restoring) setConfirmRestore(false); }} onConfirm={() => void runRestore()} />
    <ConfirmDialog visible={confirmDeleteBackups} title="Delete selected backups?" message={`Delete ${selectedBackupIds.length} selected backup${selectedBackupIds.length === 1 ? '' : 's'} and their stored files? Restore history will be kept, and these backups will be marked as deleted.`} confirmLabel="Delete selected" cancelLabel="Cancel" danger pending={deletingBackups} onClose={() => { if (!deletingBackups) setConfirmDeleteBackups(false); }} onConfirm={() => void deleteBackups()} />
    <ConfirmDialog visible={Boolean(restoreStoredId)} title="Restore scheduled backup?" message="Rows in this scheduled backup will be restored, and existing rows with the same primary key will be updated to match the backup. Newer rows will remain. The action will be added to the audit log." confirmLabel="Restore scheduled backup" cancelLabel="Cancel" pending={restoring} onClose={() => { if (!restoring) setRestoreStoredId(null); }} onConfirm={() => void runStoredRestore()} />
    <Dialog visible={confirmReset} title="Reset all application data?" onClose={() => { if (!resetting) { setConfirmReset(false); setResetConfirmation(''); } }}>
      <Text style={styles.dialogIntro}>This cannot be undone. Your current System Admin account will remain active. All other accounts and application records will be deleted, including departments and academic terms. Roles, permissions, system settings, and existing backups and schedules will remain.</Text>
      <Text style={styles.sectionHelp}>To confirm, type RESET below.</Text>
      <Field label="Confirmation" value={resetConfirmation} onChangeText={setResetConfirmation} autoCapitalize="characters" autoCorrect={false} placeholder="RESET" />
      <View style={styles.dialogActions}>
        <Button label="Cancel" variant="secondary" disabled={resetting} onPress={() => { setConfirmReset(false); setResetConfirmation(''); }} />
        <Button label="Reset application data" variant="danger" loading={resetting} disabled={resetConfirmation !== 'RESET' || resetting} onPress={() => void runApplicationReset()} />
      </View>
    </Dialog>
    <Dialog visible={Boolean(resetResult)} title={resetResult?.failed_auth_account_deletions.length ? 'Application data reset partially complete' : 'Application data reset complete'} onClose={() => setResetResult(null)}>
      <Text style={styles.dialogIntro}>Application records were cleared. {resetResult?.deleted_auth_accounts.toLocaleString() ?? '0'} other account{resetResult?.deleted_auth_accounts === 1 ? '' : 's'} were deleted. Your signed-in System Admin account was retained.</Text>
      {resetResult?.failed_auth_account_deletions.length ? <>
        <Text style={[styles.sectionHelp, { color: colors.danger }]}>These authentication accounts could not be deleted. Their application records have been removed, so they may need to be cleaned up or invited again.</Text>
        {resetResult.failed_auth_account_deletions.map((item) => <View key={item.userId} style={styles.forceDeleteWarning}><Text style={styles.forceDeleteLabel}>{item.email || item.userId}</Text><Text style={styles.sectionHelp}>{item.error}</Text></View>)}
      </> : <Text style={styles.sectionHelp}>Roles, permissions, system settings, and backup history and schedules were preserved.</Text>}
      <View style={styles.dialogActions}><Button label="Done" onPress={() => setResetResult(null)} /></View>
    </Dialog>
  </>;
}
function Logs({ data }: Props) { return <><Heading title="Access & System Logs" subtitle="Immutable audit trail for account, data, criteria, and administrative operations." />{data.logs.length ? <DataTable columns={['Log ref', 'Timestamp', 'Action', 'Entity', 'Actor', 'Status']} rows={data.logs.map((row) => [`Log ${compactReference(row.id)}`, date(row.createdAt), row.action, auditEntityLabel(row, data), auditActorLabel(row.actorId, data), 'Recorded'])} columnWidths={[112, 160, 240, 220, 170, 100]} columnFlex={[0.5, 0.7, 1, 1, 0.8, 0.3]} widthMode="container" /> : <PageState kind="empty" title="No logs" message="No audit records are visible." />}</>; }
function SystemReports({ data }: Props) {
  const rows = useMemo(() => [
    ...data.users.map((user) => ({ recordType: 'User', status: user.status, role: user.roleName ?? user.role ?? 'Unassigned', scope: user.scopeType ?? 'Global', date: user.lastLoginAt ?? 'No sign-in', identifier: user.id })),
    ...data.logs.map((log) => ({ recordType: 'Audit event', status: 'Recorded', role: log.action, scope: log.entityType, date: log.createdAt, identifier: String(log.id) })),
    ...data.backups.map((backup) => ({ recordType: 'Backup', status: backup.status, role: backup.scope, scope: backup.completedAt ? 'Completed' : 'Pending', date: backup.createdAt, identifier: backup.id })),
  ], [data.users, data.logs, data.backups]);
  return <><Heading title="System Reports" subtitle="Formatted operational reports for account, audit, and backup administration. Academic records are outside the System Admin reporting scope." /><ReportComposer title="System Operations Report" scopeLabel="System administration" description="Operational account status, role assignment, audit activity, and backup status. Report data is drawn from the System Admin workspace." rows={rows} /></>;
}
function SystemSettings({ data, refresh, userId, toast, initialCategory }: Props & { initialCategory?: string }) {
  const [category, setCategory] = useState(initialCategory && ['Core services', 'Forecasting service', 'AI provider usage', 'Feedback email', 'Backup policy', 'Grading defaults', 'Grade deadlines', 'Security & sign-in'].includes(initialCategory) ? initialCategory : 'Core services');
  const settingsCategories = ['Core services', 'Forecasting service', 'AI provider usage', 'Feedback email', 'Backup policy', 'Grading defaults', 'Grade deadlines', 'Security & sign-in'];
  useEffect(() => { if (initialCategory && ['Core services', 'Forecasting service', 'AI provider usage', 'Feedback email', 'Backup policy', 'Grading defaults', 'Grade deadlines', 'Security & sign-in'].includes(initialCategory)) setCategory(initialCategory); }, [initialCategory]);
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
        if (row.key === 'grading.swunext_global_modules' || row.key === 'grading.default_system_id' || row.key === 'grading.default_system_definition' || row.key === 'FEEDBACK_FROM_EMAIL' || row.key === 'FEEDBACK_FROM_NAME' || row.key.startsWith('security.mfa_required') || quotaFields.some((field) => field.key === row.key)) continue;
        let value: unknown = values[row.key] ?? '';
        try { value = JSON.parse(value as string); } catch { /* plain strings remain valid JSONB values */ }
        await saveSystemSetting(userId, row.key, value);
      }
      await saveSystemSetting(userId, 'FEEDBACK_FROM_EMAIL', feedbackFromEmail.trim());
      await saveSystemSetting(userId, 'FEEDBACK_FROM_NAME', feedbackFromName.trim());
      await saveSystemSetting(userId, 'student_id.validation_enabled', studentIdValidation);
      await saveSystemSetting(userId, 'security.mfa_required', boolValue('security.mfa_required'));
      await saveSystemSetting(userId, 'security.mfa_required_roles', readStringArray(values['security.mfa_required_roles']));
      await saveSystemSetting(userId, 'security.mfa_required_departments', readStringArray(values['security.mfa_required_departments']));
      for (const [key, value] of Object.entries(quotaValues)) {
        if (value === null) await deleteSystemSetting(key);
        else await saveSystemSetting(userId, key, value);
      }
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
      <View accessibilityRole="tablist" style={styles.settingsCategoryNav}>
        {settingsCategories.map((item) => <Pressable key={item} accessibilityRole="tab" accessibilityState={{ selected: category === item }} onPress={() => setCategory(item)} style={[styles.settingsCategoryTab, category === item && styles.settingsCategoryTabActive]}>
          <Text style={[styles.settingsCategoryText, category === item && styles.settingsCategoryTextActive]}>{item}</Text>
        </Pressable>)}
      </View>
      {category === 'Core services' ? <>
      <Card style={styles.settingsIntro}><Text style={styles.cardTitle}>Configuration overview</Text><Text style={styles.help}>These settings affect the whole APMS installation. Changes are permission-checked and recorded in the audit log.</Text><View style={styles.summaryRow}><Text style={styles.summaryLabel}>Last configuration update</Text><Text style={styles.summaryValue}>{date(data.settings.map((row) => row.updatedAt).sort().at(-1) ?? null)}</Text></View></Card>
      <Card style={styles.settingsCard}>
        <Text style={styles.sectionTitle}>Core services</Text>
        <Text style={styles.sectionHelp}>Control optional services and their availability.</Text>
        <View style={styles.settingRow}><View style={styles.settingCopy}><Text style={styles.settingLabel}>AI assistant</Text><Text style={styles.help}>Allow approved decision-support features to run.</Text></View><Pressable accessibilityRole="switch" accessibilityState={{ checked: boolValue('ai.enabled') }} onPress={() => update('ai.enabled', String(!boolValue('ai.enabled')))} style={[styles.switch, boolValue('ai.enabled') && styles.switchOn]}><View style={[styles.switchThumb, boolValue('ai.enabled') && styles.switchThumbOn]} /></Pressable></View>
        <View style={styles.settingRow}><View style={styles.settingCopy}><Text style={styles.settingLabel}>Share anonymous assessment data with AI</Text><Text style={styles.help}>Off by default. When enabled, AI may receive numeric scores and derived grades with assessment titles and student identifiers removed.</Text></View><Pressable accessibilityRole="switch" accessibilityState={{ checked: boolValue('ai.assessment_data.enabled') }} onPress={() => update('ai.assessment_data.enabled', String(!boolValue('ai.assessment_data.enabled')))} style={[styles.switch, boolValue('ai.assessment_data.enabled') && styles.switchOn]}><View style={[styles.switchThumb, boolValue('ai.assessment_data.enabled') && styles.switchThumbOn]} /></Pressable></View>
        <View style={styles.settingRow}><View style={styles.settingCopy}><Text style={styles.settingLabel}>Share anonymous attendance data with AI</Text><Text style={styles.help}>Off by default. When enabled, AI may receive numeric attendance rates without student or class identifiers.</Text></View><Pressable accessibilityRole="switch" accessibilityState={{ checked: boolValue('ai.attendance_data.enabled') }} onPress={() => update('ai.attendance_data.enabled', String(!boolValue('ai.attendance_data.enabled')))} style={[styles.switch, boolValue('ai.attendance_data.enabled') && styles.switchOn]}><View style={[styles.switchThumb, boolValue('ai.attendance_data.enabled') && styles.switchThumbOn]} /></Pressable></View>
        <View style={styles.settingRow}><View style={styles.settingCopy}><Text style={styles.settingLabel}>Validate student ID format</Text><Text style={styles.help}>When enabled, student ID fields accept a 12-digit number or the formatted 05-XXXX-XXXXXX pattern. Disabled by default because some existing institutional IDs use other formats.</Text></View><Pressable accessibilityRole="switch" accessibilityState={{ checked: studentIdValidation }} onPress={() => setStudentIdValidation((enabled) => !enabled)} style={[styles.switch, studentIdValidation && styles.switchOn]}><View style={[styles.switchThumb, studentIdValidation && styles.switchThumbOn]} /></Pressable></View>
      </Card>
      </> : null}
      {category === 'Forecasting service' ? <AIServiceSettings /> : null}
      {category === 'AI provider usage' ? <>
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
      </> : null}
      {category === 'Feedback email' ? <>
      <Card style={styles.settingsCard}>
        <Text style={styles.sectionTitle}>Feedback email</Text>
        <Text style={styles.sectionHelp}>Set the sender name and address used when Faculty emails feedback to a student.</Text>
        <Field label="Sender name (FEEDBACK_FROM_NAME)" value={feedbackFromName} onChangeText={setFeedbackFromName} placeholder="APMS Feedback" autoCapitalize="words" maxLength={100} />
        <Field label="Sender email (FEEDBACK_FROM_EMAIL)" value={feedbackFromEmail} onChangeText={setFeedbackFromEmail} placeholder="feedback@your-verified-domain.edu" keyboardType="email-address" autoCapitalize="none" />
        <Text style={styles.help}>Save the address here. Keep only RESEND_API_KEY in Edge Function Secrets. Resend must verify the sender’s domain before emails can be sent.</Text>
      </Card>
      </> : null}
      {category === 'Backup policy' ? <>
      <Card style={styles.settingsCard}>
        <Text style={styles.sectionTitle}>Backup policy</Text><Text style={styles.sectionHelp}>Set how long completed backup artifacts should be retained.</Text>
        <View style={styles.inlineField}><Field label="Retention period" value={values['backup.retention_days'] ?? ''} onChangeText={(value) => update('backup.retention_days', value.replace(/\D/g, '').slice(0, 3))} keyboardType="number-pad" containerStyle={styles.retentionField} /><Text style={styles.unit}>days</Text></View>
        <Text style={styles.help}>Minimum 1 day. Backup execution still requires the configured protected worker.</Text>
      </Card>
      </> : null}
      {category === 'Grading defaults' ? <>
      <Card style={styles.settingsCard}>
        <View style={styles.sectionHeader}><View><Text style={styles.sectionTitle}>Default grading system</Text><Text style={styles.sectionHelp}>Choose which saved grading definition is used when a class has no explicitly applied system.</Text></View><Text style={styles.badge}>DEFAULT</Text></View>
        <SelectField label="Default grading system" value={defaultSystemId} options={gradingSystems.map((system) => ({ label: system.name, value: system.id }))} onChange={setDefaultSystemId} />
        <Text style={styles.help}>Grading definitions are created and edited by Academic Admins. This setting selects the system-wide fallback; class-specific grading systems continue to take precedence.</Text>
      </Card>
      </> : null}
      {category === 'Grade deadlines' ? <SystemGradeDeadlines data={data} userId={userId} toast={toast} /> : null}
      {category === 'Security & sign-in' ? <>
        <Card style={styles.settingsCard}>
          <Text style={styles.sectionTitle}>Academic Admin Faculty invitations</Text>
          <Text style={styles.sectionHelp}>Control whether Academic Admins can invite Faculty into their own department. This setting is enabled by default. Turning it off also disables resending pending Faculty invitations.</Text>
          <Pressable accessibilityRole="switch" accessibilityState={{ checked: boolValue('academic_admins.can_invite_faculty') }} onPress={() => update('academic_admins.can_invite_faculty', String(!boolValue('academic_admins.can_invite_faculty')))} style={styles.settingRow}>
            <View style={styles.settingCopy}><Text style={styles.settingLabel}>Allow Academic Admins to invite Faculty</Text><Text style={styles.help}>Enabled by default. Invitations are limited to the inviter’s department.</Text></View>
            <View style={[styles.switch, boolValue('academic_admins.can_invite_faculty') && styles.switchOn]}><View style={[styles.switchThumb, boolValue('academic_admins.can_invite_faculty') && styles.switchThumbOn]} /></View>
          </Pressable>
        </Card>
        <Card style={styles.settingsCard}>
          <Text style={styles.sectionTitle}>Academic Admin account invitations</Text>
          <Text style={styles.sectionHelp}>When enabled, Academic Admins can invite additional Academic Admins into their own department. They can always invite Faculty. Academic Admins cannot delete accounts or send password reset links.</Text>
          <Pressable accessibilityRole="switch" accessibilityState={{ checked: boolValue('academic_admins.can_invite_academic_admins') }} onPress={() => update('academic_admins.can_invite_academic_admins', String(!boolValue('academic_admins.can_invite_academic_admins')))} style={styles.settingRow}>
            <View style={styles.settingCopy}><Text style={styles.settingLabel}>Allow Academic Admins to invite Academic Admins</Text><Text style={styles.help}>Off by default. Invitations are limited to the inviter’s department.</Text></View>
            <View style={[styles.switch, boolValue('academic_admins.can_invite_academic_admins') && styles.switchOn]}><View style={[styles.switchThumb, boolValue('academic_admins.can_invite_academic_admins') && styles.switchThumbOn]} /></View>
          </Pressable>
        </Card>
        <Card style={styles.settingsCard}>
          <Text style={styles.sectionTitle}>Two-step verification policy</Text>
          <Text style={styles.sectionHelp}>Require an authenticator app code at sign-in and during onboarding. Global enforcement applies to every account; role and department selections apply when the global setting is off.</Text>
          <Pressable accessibilityRole="switch" accessibilityState={{ checked: boolValue('security.mfa_required') }} onPress={() => update('security.mfa_required', String(!boolValue('security.mfa_required')))} style={styles.settingRow}>
            <View style={styles.settingCopy}><Text style={styles.settingLabel}>Require MFA for everyone</Text><Text style={styles.help}>Off by default. Turn this on to require an authenticator code for all users.</Text></View>
            <View style={[styles.switch, boolValue('security.mfa_required') && styles.switchOn]}><View style={[styles.switchThumb, boolValue('security.mfa_required') && styles.switchThumbOn]} /></View>
          </Pressable>
          <Text style={styles.settingLabel}>Require MFA by role</Text>
          <View style={styles.policySelectionGrid}>{[
            ['system_admin', 'System Admin'], ['academic_admin', 'Academic Admin'], ['faculty', 'Faculty'],
          ].map(([key, label]) => {
            const selected = readStringArray(values['security.mfa_required_roles']).includes(key);
            return <Pressable key={key} accessibilityRole="checkbox" accessibilityState={{ checked: selected }} onPress={() => update('security.mfa_required_roles', JSON.stringify(toggleStringArray(values['security.mfa_required_roles'], key)))} style={styles.policySelectionItem}>
              <View style={[styles.userCheckbox, selected && styles.userCheckboxSelected]}><Text style={styles.userCheckboxMark}>{selected ? '✓' : ''}</Text></View><Text style={styles.help}>{label}</Text>
            </Pressable>;
          })}</View>
          <Text style={styles.settingLabel}>Require MFA by department</Text>
          {data.departments.length ? <View style={styles.policySelectionGrid}>{data.departments.map((department) => {
            const selected = readStringArray(values['security.mfa_required_departments']).includes(department.id);
            return <Pressable key={department.id} accessibilityRole="checkbox" accessibilityState={{ checked: selected }} onPress={() => update('security.mfa_required_departments', JSON.stringify(toggleStringArray(values['security.mfa_required_departments'], department.id)))} style={styles.policySelectionItem}>
              <View style={[styles.userCheckbox, selected && styles.userCheckboxSelected]}><Text style={styles.userCheckboxMark}>{selected ? '✓' : ''}</Text></View><Text style={styles.help}>{department.code} · {department.name}</Text>
            </Pressable>;
          })}</View> : <Text style={styles.help}>No departments are available.</Text>}
          <Text style={styles.help}>A user is required to use MFA if the global setting is on, their role is selected, or their department is selected. The rule is checked again when onboarding is completed.</Text>
        </Card>
      </> : null}
      <Text style={styles.updatedNote}>Settings last loaded from Supabase. {data.settings.length} configuration entries.</Text>
    </View>
  </>;
}

const gradeDeadlinePeriods = [{ key: 'overall', label: 'Overall encoding' }, { key: 'p1', label: 'Period 1' }, { key: 'p2', label: 'Period 2' }, { key: 'p3', label: 'Period 3' }];
function deadlineValue(date: string) { return `${date}T23:59:59+08:00`; }
function SystemGradeDeadlines({ data, userId, toast }: Pick<Props, 'data' | 'userId' | 'toast'>) {
  const [deadlines, setDeadlines] = useState<Record<string, string>>({ overall: '', p1: '', p2: '', p3: '' });
  const [configuredDeadlines, setConfiguredDeadlines] = useState<any[]>([]);
  const [requests, setRequests] = useState<any[]>([]);
  const [classRecords, setClassRecords] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [rejectingRequest, setRejectingRequest] = useState<any | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');
  const load = useCallback(async () => {
    if (!supabase) return;
    const [deadlineResult, requestResult] = await Promise.all([
      supabase.from('grade_encoding_deadlines').select('scope_type,department_id,program_id,year_level,class_record_id,period_key,deadline_at'),
      supabase.from('grade_encoding_deadline_requests').select('id,department_id,requested_by,scope_type,program_id,year_level,class_record_id,class_record_ids,requested_periods,requested_deadlines,rationale,academic_admin_reason,status,review_note,created_at,reviewed_at').order('created_at', { ascending: true }),
    ]);
    const error = deadlineResult.error ?? requestResult.error;
    if (error) throw error;
    const next = { overall: '', p1: '', p2: '', p3: '' } as Record<string, string>;
    const configured = deadlineResult.data ?? [];
    for (const row of configured) if (row.scope_type === 'system' && row.period_key in next) next[row.period_key] = String(row.deadline_at).slice(0, 10);
    setDeadlines(next);
    setConfiguredDeadlines(configured);
    const requestRows = [...(requestResult.data ?? [])].sort((a, b) => {
      const isPending = (status: string) => status === 'pending' || status === 'pending_system_admin';
      const pendingOrder = Number(isPending(b.status)) - Number(isPending(a.status));
      if (pendingOrder) return pendingOrder;
      if (isPending(a.status)) return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      return new Date(b.reviewed_at ?? b.created_at).getTime() - new Date(a.reviewed_at ?? a.created_at).getTime();
    });
    setRequests(requestRows);
    const classIds = [...new Set(requestRows.flatMap((request) => [
      ...(request.class_record_id ? [request.class_record_id] : []),
      ...(request.class_record_ids ?? []),
    ]))];
    if (!classIds.length) { setClassRecords([]); return; }
    const classResult = await supabase.from('system_admin_class_labels').select('id,section,subject_code,subject_title').in('id', classIds);
    if (classResult.error) throw classResult.error;
    setClassRecords(classResult.data ?? []);
  }, []);
  useEffect(() => { void load().catch((cause) => toast.show(getErrorMessage(cause, 'Grade deadlines could not be loaded.'))); }, [load, toast]);
  const save = async () => {
    if (!supabase) return toast.show('APMS is not connected to Supabase.');
    setBusy(true);
    try {
      const values = Object.fromEntries(gradeDeadlinePeriods.map(({ key }) => [key, deadlines[key] ? deadlineValue(deadlines[key]) : null]));
      const { error } = await supabase.rpc('save_system_grade_encoding_deadlines', { p_deadlines: values });
      if (error) throw error;
      toast.show('System-wide grade deadlines saved.');
      await load();
    } catch (cause) { toast.show(getErrorMessage(cause, 'Grade deadlines could not be saved.')); }
    finally { setBusy(false); }
  };
  const review = async (requestId: string, status: 'approved' | 'rejected', reason?: string) => {
    if (!supabase) return toast.show('APMS is not connected to Supabase.');
    setBusy(true);
    try {
      const { error } = await supabase.from('grade_encoding_deadline_requests').update({ status, review_note: status === 'rejected' ? reason?.trim() : null, reviewed_by: userId, reviewed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', requestId);
      if (error) throw error;
      toast.show(status === 'approved' ? 'Deadline request approved and applied.' : 'Deadline request declined.');
      setRejectingRequest(null); setRejectionReason('');
      await load();
    } catch (cause) { toast.show(getErrorMessage(cause, 'The deadline request could not be reviewed.')); }
    finally { setBusy(false); }
  };
  const displayDeadline = (value: unknown) => {
    if (typeof value !== 'string' || !value) return 'No deadline set';
    const date = value.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
    return date ? new Date(`${date}T12:00:00`).toLocaleDateString() : new Date(value).toLocaleDateString();
  };
  const currentDeadlineFor = (request: any, periodKey: string) => {
    if (request.scope_type === 'faculty') {
      const systemDeadline = configuredDeadlines.find((row) => row.scope_type === 'system' && row.period_key === periodKey)?.deadline_at;
      const values = [...new Set((request.class_record_ids ?? []).map((classId: string) =>
        configuredDeadlines.find((row) => row.scope_type === 'class' && row.class_record_id === classId && row.period_key === periodKey)?.deadline_at ?? systemDeadline,
      ).filter(Boolean))];
      if (values.length > 1) return 'Varies by class';
      if (values.length === 1) return values[0];
    }
    const scope = request.scope_type === 'class'
      ? configuredDeadlines.find((row) => row.scope_type === 'class' && row.class_record_id === request.class_record_id && row.period_key === periodKey)
      : request.scope_type === 'program'
      ? configuredDeadlines.find((row) => row.scope_type === 'program' && row.program_id === request.program_id && row.period_key === periodKey)
      : configuredDeadlines.find((row) => row.scope_type === 'year_level' && row.department_id === request.department_id && row.year_level === request.year_level && row.period_key === periodKey);
    const system = configuredDeadlines.find((row) => row.scope_type === 'system' && row.period_key === periodKey);
    return scope?.deadline_at ?? system?.deadline_at;
  };
  const displayCurrentDeadline = (value: unknown) => value === 'Varies by class' ? value : displayDeadline(value);
  return <>
    <Card style={styles.settingsCard}>
      <Text style={styles.sectionTitle}>System-wide encoding deadlines</Text>
      <Text style={styles.sectionHelp}>These deadlines apply to every program unless an approved class, program, or year-level request overrides them. Once a deadline passes, grade scores for that period cannot be added, edited, cleared, or restored.</Text>
      <View style={styles.dateGrid}>{[...gradeDeadlinePeriods.filter(({ key }) => key !== 'overall'), ...gradeDeadlinePeriods.filter(({ key }) => key === 'overall')].map(({ key, label }) => <DateField key={key} label={`${label} deadline`} value={deadlines[key] ?? ''} onChange={(value) => setDeadlines((current) => ({ ...current, [key]: value }))} containerStyle={styles.dateField} />)}</View>
      <View style={[styles.actions, styles.deadlineSaveActions]}><Button label="Save system-wide deadlines" loading={busy} disabled={busy} onPress={() => void save()} /></View>
    </Card>
    <Card style={styles.settingsCard}>
      <Text style={styles.sectionTitle}>Deadline change requests</Text>
      <Text style={styles.sectionHelp}>Review Academic Admin requests and Faculty requests forwarded by their department Academic Admin.</Text>
      {requests.length ? <View style={{ gap: 8 }}>{requests.map((request) => {
        const department = data.departments.find((item) => item.id === request.department_id);
        const program = data.programs.find((item) => item.id === request.program_id);
        const requester = data.users.find((item) => item.id === request.requested_by);
        const requesterName = requester ? `${requester.firstName} ${requester.lastName}`.trim() : '';
        const classRecord = classRecords.find((item) => item.id === request.class_record_id);
        const classLabel = classRecord ? `${classRecord.subject_code} · ${classRecord.subject_title} · ${classRecord.section}` : 'Class';
        const requestedClassLabels = (request.class_record_ids ?? []).map((id: string) => classRecords.find((item) => item.id === id)).filter(Boolean).map((item: any) => `${item.subject_code} · ${item.section}`);
        const statusTone = request.status === 'approved' ? 'success' : request.status === 'rejected' ? 'danger' : 'warning';
        return <View key={request.id} style={[styles.settingRow, styles.deadlineRequestRow]}>
          <View style={styles.deadlineRequestContent}>
            <View style={styles.deadlineRequestHeader}><Text style={styles.settingLabel}>{request.scope_type === 'faculty' ? `${request.class_record_ids?.length ?? 0} selected classes · ${department?.code ?? 'Department'}` : request.scope_type === 'program' ? `${program?.code ?? 'Program'} · ${program?.name ?? ''} · ${department?.code ?? 'Department'}` : request.scope_type === 'class' ? `${classLabel} · ${department?.code ?? 'Department'}` : `Year ${request.year_level} · ${department?.code ?? 'Department'}`}</Text><Badge tone={statusTone}>{request.status === 'pending_system_admin' ? 'Forwarded to System Admin' : request.status.charAt(0).toUpperCase() + request.status.slice(1)}</Badge></View>
            <Text style={styles.help}>Requested by {requesterName || requester?.email || (request.scope_type === 'faculty' ? 'Faculty member' : 'Academic Admin')} · {new Date(request.created_at).toLocaleString()}</Text>
            {request.scope_type === 'faculty' ? <Text style={styles.help}>Classes: {requestedClassLabels.join(', ') || `${request.class_record_ids?.length ?? 0} selected`}</Text> : null}
            <View style={styles.deadlineChanges}>{gradeDeadlinePeriods.map(({ key, label }) => request.requested_deadlines?.[key] !== undefined ? <View key={key} style={{ backgroundColor: colors.canvas, borderRadius: 8, padding: 8 }}><Text style={styles.deadlineReasonLabel}>{label}</Text><Text style={styles.help}>{displayCurrentDeadline(currentDeadlineFor(request, key))} → {displayDeadline(request.requested_deadlines[key])}</Text></View> : null)}</View>
            <View style={styles.deadlineNotesGrid}><View style={[styles.deadlineReason, !request.academic_admin_reason && !request.review_note && styles.deadlineNoteFullWidth]}><Text style={styles.deadlineReasonLabel}>{request.scope_type === 'faculty' ? 'Faculty reason' : 'Reason for request'}</Text><Text style={styles.help}>{request.rationale}</Text></View>
            {request.academic_admin_reason ? <View style={styles.deadlineReason}><Text style={styles.deadlineReasonLabel}>Academic Admin reason</Text><Text style={styles.help}>{request.academic_admin_reason}</Text></View> : null}
            {request.review_note ? <View style={styles.deadlineReason}><Text style={styles.deadlineReasonLabel}>{request.status === 'rejected' ? 'Reason for rejection' : 'Review note'}</Text><Text style={styles.help}>{request.review_note}</Text></View> : null}</View>
          </View>
          {(request.status === 'pending' || request.status === 'pending_system_admin') ? <View style={styles.actions}><Button compact label="Approve" disabled={busy} onPress={() => void review(request.id, 'approved')} /><Button compact label="Decline" variant="secondary" disabled={busy} onPress={() => { setRejectingRequest(request); setRejectionReason(''); }} /></View> : null}
        </View>;
      })}</View> : <Text style={styles.help}>No deadline requests have been submitted.</Text>}
    </Card>
    <Dialog visible={!!rejectingRequest} title="Decline deadline request" onClose={() => { setRejectingRequest(null); setRejectionReason(''); }}>
      <Text style={styles.dialogIntro}>Give the Academic Admin a clear reason for rejecting this deadline change.</Text>
      <Field label="Reason for rejection" value={rejectionReason} onChangeText={setRejectionReason} multiline numberOfLines={4} maxLength={1000} placeholder="Explain why the requested deadline cannot be approved." style={{ paddingTop: 14 }} />
      <View style={styles.dialogActions}><Button label="Cancel" variant="secondary" disabled={busy} onPress={() => { setRejectingRequest(null); setRejectionReason(''); }} /><Button label="Decline request" variant="danger" loading={busy} disabled={busy || rejectionReason.trim().length < 10} onPress={() => rejectingRequest && void review(rejectingRequest.id, 'rejected', rejectionReason)} /></View>
    </Dialog>
  </>;
}
function readStringArray(value: string | undefined): string[] { try { const parsed = JSON.parse(value ?? '[]'); return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []; } catch { return []; } }
function toggleStringArray(value: string | undefined, item: string): string[] { const current = readStringArray(value); return current.includes(item) ? current.filter((entry) => entry !== item) : [...current, item]; }
const styles = StyleSheet.create({ screen: { gap: 16 }, heading: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12 }, headingCopy: { flex: 1, minWidth: 240 }, flex: { flex: 1 }, title: { color: colors.text, fontSize: 22, lineHeight: 30, fontWeight: '700' }, subtitle: { color: colors.textMuted, fontSize: 13, lineHeight: 19, marginTop: 3 }, metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 }, cardTitle: { color: colors.text, fontSize: 15, fontWeight: '700', marginBottom: 8 }, help: { color: colors.textMuted, fontSize: 12, lineHeight: 18 }, formGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 }, dateGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 }, dateField: { flex: 1, flexBasis: 180, minWidth: 180 }, userChartFilters: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 }, filter: { flexGrow: 1, flexBasis: 180, minWidth: 160 }, chartCount: { color: colors.textMuted, fontSize: 11, marginTop: -10 }, analyticsCharts: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 }, fieldHint: { color: colors.textMuted, fontSize: 11, marginTop: -6 }, dialogIntro: { color: colors.textMuted, fontSize: 13, lineHeight: 19, marginBottom: 2 }, actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, userHeadingActions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }, userCheckbox: { width: 20, height: 20, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border, borderRadius: 4, backgroundColor: '#FFFFFF' }, userCheckboxSelected: { borderColor: colors.brand, backgroundColor: colors.surfaceMuted }, userCheckboxMark: { color: colors.brand, fontSize: 14, lineHeight: 17, fontWeight: '800' }, policySelectionGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 6 }, policySelectionItem: { flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 180, maxWidth: '100%', padding: 9, borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.surface }, deadlineSaveActions: { marginTop: 5 }, forceDeleteOption: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, padding: 10, borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.surfaceMuted }, forceDeleteLabel: { color: colors.danger, fontSize: 12, fontWeight: '700' }, forceDeleteWarning: { color: colors.danger, fontSize: 12, lineHeight: 18, padding: 9, borderRadius: 7, backgroundColor: '#FEF2F2' }, linkedRecordsWarning: { color: colors.danger, fontSize: 12, lineHeight: 18, padding: 9, borderRadius: 7, backgroundColor: '#FEF2F2' }, dialogActions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8, marginTop: 4 }, overlay: { flex: 1, backgroundColor: '#00000066', alignItems: 'center', justifyContent: 'center', padding: 24 }, dialog: { width: '100%', maxWidth: 760, maxHeight: '90%', padding: 22, flexShrink: 1 }, dialogTitle: { color: colors.text, fontSize: 19, fontWeight: '700' }, dialogBody: { flexShrink: 1, marginTop: 16 }, dialogBodyContent: { gap: 14 }, close: { color: colors.textMuted, fontSize: 28 }, setting: { maxWidth: 920, gap: 12 }, settingsLayout: { gap: 10, maxWidth: 980 }, settingsCategoryNav: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, borderBottomWidth: 1, borderColor: colors.border }, settingsCategoryTab: { paddingHorizontal: 11, paddingVertical: 9, borderBottomWidth: 2, borderBottomColor: 'transparent' }, settingsCategoryTabActive: { borderBottomColor: colors.brand }, settingsCategoryText: { color: colors.textMuted, fontSize: 12, fontWeight: '600' }, settingsCategoryTextActive: { color: colors.brand }, settingsIntro: { gap: 7, padding: 14 }, settingsCard: { gap: 7, padding: 14 }, summaryRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, borderTopWidth: 1, borderColor: colors.border, paddingTop: 8, marginTop: 2 }, summaryLabel: { color: colors.textMuted, fontSize: 12 }, summaryValue: { color: colors.text, fontSize: 12, fontWeight: '600' }, sectionTitle: { color: colors.text, fontSize: 16, fontWeight: '700' }, sectionHelp: { color: colors.textMuted, fontSize: 12, lineHeight: 18, marginTop: 2 }, settingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 14, paddingVertical: 8, borderTopWidth: 1, borderColor: colors.border, marginTop: 2 }, deadlineRequestRow: { alignItems: 'flex-start', paddingVertical: 12 }, deadlineRequestContent: { flex: 1, gap: 5 }, deadlineRequestHeader: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 }, deadlineChanges: { gap: 2, marginTop: 3 }, deadlineNotesGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 5 }, deadlineReason: { flex: 1, flexBasis: 240, minWidth: 220, gap: 4, padding: 10, marginTop: 5, backgroundColor: colors.canvas, borderRadius: 8 }, programRequestNotes: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 }, programRequestReason: { flex: 1, flexBasis: 260, minWidth: 220, gap: 4, padding: 10, backgroundColor: colors.canvas, borderRadius: 8 }, deadlineNoteFullWidth: { flexBasis: '100%' }, deadlineReasonLabel: { color: colors.text, fontSize: 12, fontWeight: '700' }, settingCopy: { flex: 1 }, settingLabel: { color: colors.text, fontSize: 14, fontWeight: '700' }, switch: { width: 42, height: 24, borderRadius: 14, padding: 2, justifyContent: 'center', backgroundColor: '#D0D5DD' }, switchOn: { backgroundColor: colors.brand }, switchThumb: { width: 20, height: 20, borderRadius: 10, backgroundColor: '#FFF' }, switchThumbOn: { alignSelf: 'flex-end' }, inlineField: { flexDirection: 'row', alignItems: 'flex-end', gap: 10 }, retentionField: { width: 180 }, unit: { color: colors.textMuted, fontSize: 13, paddingBottom: 12 }, sectionHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }, badge: { color: colors.success, backgroundColor: '#DCFCE7', fontSize: 10, fontWeight: '800', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999 }, policyGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 6 }, policyItem: { minWidth: 130, flex: 1, backgroundColor: colors.canvas, borderRadius: 10, padding: 12 }, policyValue: { color: colors.brand, fontSize: 18, fontWeight: '800' }, policyLabel: { color: colors.textMuted, fontSize: 11, marginTop: 3 }, jsonField: { minHeight: 108, textAlignVertical: 'top' }, updatedNote: { color: colors.textMuted, fontSize: 11, textAlign: 'center', paddingBottom: 10 } });
function PolicyItem({ label, value }: { label: string; value: string }) { return <View style={styles.policyItem}><Text style={styles.policyValue}>{value}</Text><Text style={styles.policyLabel}>{label}</Text></View>; }
function Info({ onMessage }: { onMessage: (message: string) => void }) { return <><Heading title="Account settings" subtitle="Manage your profile, password, MFA, and notification preferences." /><AccountSettings role="system_admin" screen="settings" onMessage={onMessage} /></>; }
function Dialog({ visible, title, onClose, children }: { visible: boolean; title: string; onClose: () => void; children: ReactNode }) { return <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}><View style={styles.overlay}><Card style={styles.dialog}><View style={styles.heading}><Text accessibilityRole="header" style={styles.dialogTitle}>{title}</Text><Pressable accessibilityLabel="Close dialog" onPress={onClose}><Text style={styles.close}>×</Text></Pressable></View><ScrollView style={styles.dialogBody} contentContainerStyle={styles.dialogBodyContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator>{children}</ScrollView></Card></View></Modal>; }
