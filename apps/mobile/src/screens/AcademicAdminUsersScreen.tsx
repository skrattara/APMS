import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Linking from 'expo-linking';

import { Badge, Button, Card, DataTable, Field, PageState, SelectField } from '@/components/ui';
import { getErrorMessage } from '@/services/errors';
import { inviteAcademicDepartmentUser, loadAcademicDepartmentUsers, resendAcademicDepartmentInvitation, type AcademicDepartmentUser } from '@/services/academicAdminUsers';
import { colors } from '@/theme/tokens';

type Props = { departmentId: string; toast: { show: (message: string) => void } };
const roles = [{ label: 'Faculty', value: 'faculty' }, { label: 'Academic Admin', value: 'academic_admin' }];

export function AcademicAdminUsersScreen({ toast }: Props) {
  const [users, setUsers] = useState<AcademicDepartmentUser[]>([]);
  const [canInviteAcademicAdmins, setCanInviteAcademicAdmins] = useState(false);
  const [canInviteFaculty, setCanInviteFaculty] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [role, setRole] = useState<'faculty' | 'academic_admin'>('faculty');

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const result = await loadAcademicDepartmentUsers();
      setUsers(result.users);
      setCanInviteAcademicAdmins(result.canInviteAcademicAdmins);
      setCanInviteFaculty(result.canInviteFaculty);
      setError('');
    } catch (cause) {
      setError(getErrorMessage(cause, 'Department accounts could not be loaded.'));
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void reload(); }, [reload, refreshVersion]);

  const createInvitation = async () => {
    setSaving(true);
    try {
      const redirectTo = Platform.OS === 'web' && typeof globalThis.location !== 'undefined'
        ? `${globalThis.location.origin}/onboarding?flow=invite`
        : `${Linking.createURL('/onboarding')}?flow=invite`;
      await inviteAcademicDepartmentUser({ email, firstName, lastName, role, employeeId: role === 'faculty' ? employeeId : undefined, redirectTo });
      toast.show(`${role === 'faculty' ? 'Faculty' : 'Academic Admin'} invitation sent to ${email.trim()}.`);
      setInviteOpen(false);
      setFirstName(''); setLastName(''); setEmail(''); setEmployeeId(''); setRole('faculty');
      setRefreshVersion((value) => value + 1);
    } catch (cause) { toast.show(getErrorMessage(cause, 'The invitation could not be sent.')); }
    finally { setSaving(false); }
  };

  const resend = async (user: AcademicDepartmentUser) => {
    setSaving(true);
    try {
      const redirectTo = Platform.OS === 'web' && typeof globalThis.location !== 'undefined'
        ? `${globalThis.location.origin}/onboarding?flow=invite`
        : `${Linking.createURL('/onboarding')}?flow=invite`;
      await resendAcademicDepartmentInvitation({ userId: user.id, redirectTo });
      toast.show(`A new invitation link was sent to ${user.email}.`);
      setRefreshVersion((value) => value + 1);
    } catch (cause) { toast.show(getErrorMessage(cause, 'The invitation could not be resent.')); }
    finally { setSaving(false); }
  };

  const visibleRoles = roles.filter((option) => option.value === 'faculty' ? canInviteFaculty : canInviteAcademicAdmins);
  const rows: ReactNode[][] = users.map((user) => [
    `${user.firstName} ${user.lastName}`.trim() || '—',
    user.email,
    user.roleName,
    <Badge key={`${user.id}-status`} tone={user.status === 'active' ? 'success' : user.status === 'invited' ? 'info' : user.status === 'suspended' ? 'danger' : 'neutral'}>{user.status[0].toUpperCase() + user.status.slice(1)}</Badge>,
    user.status === 'invited' && !user.onboardingComplete && (user.role === 'faculty' ? canInviteFaculty : canInviteAcademicAdmins)
      ? <Button key={`${user.id}-resend`} label="Resend invitation" variant="secondary" compact loading={saving} onPress={() => void resend(user)} />
      : '—',
  ]);

  if (loading && !users.length && !error) return <PageState kind="loading" title="Loading department users" message="Retrieving accounts for your department." />;
  if (error && !users.length) return <PageState kind="error" title="User management unavailable" message={error} action={<Button label="Retry" onPress={() => setRefreshVersion((value) => value + 1)} />} />;

  return <>
    <View style={styles.heading}>
      <View style={styles.copy}><Text accessibilityRole="header" style={styles.title}>User Management</Text><Text style={styles.subtitle}>Invite Faculty to your department{canInviteAcademicAdmins ? ' and other Academic Admins' : ''}. You can resend pending invitations, but account deletion and password resets are managed by the System Admin.</Text></View>
      {canInviteFaculty || canInviteAcademicAdmins ? <Button label="Invite user" onPress={() => { setRole(canInviteFaculty ? 'faculty' : 'academic_admin'); setInviteOpen(true); }} /> : null}
    </View>
    <Card style={styles.card}>
      <Text style={styles.cardTitle}>Department accounts</Text>
      {users.length ? <DataTable columns={['Name', 'Email', 'Role', 'Status', 'Actions']} rows={rows} columnWidths={[180, 260, 130, 100, 170]} columnFlex={[1, 2, 0, 0, 0]} widthMode="container" /> : <PageState kind="empty" title="No department accounts" message="Invited Faculty and Academic Admins will appear here." />}
    </Card>
    <Modal visible={inviteOpen} transparent animationType="fade" onRequestClose={() => { if (!saving) setInviteOpen(false); }}>
      <View style={styles.overlay}><Card style={styles.dialog}>
        <View style={styles.dialogHeader}><Text accessibilityRole="header" style={styles.dialogTitle}>Invite department user</Text><Pressable accessibilityLabel="Close dialog" disabled={saving} onPress={() => setInviteOpen(false)}><Text style={styles.close}>×</Text></Pressable></View>
        <ScrollView contentContainerStyle={styles.dialogBody} keyboardShouldPersistTaps="handled">
          <Text style={styles.help}>The invitation email lets the user confirm their address, set a password, and configure two-step verification.</Text>
          {visibleRoles.length > 1 ? <SelectField label="Role" value={role} options={visibleRoles} onChange={(value) => setRole(value as 'faculty' | 'academic_admin')} /> : <Text style={styles.help}>Role: {visibleRoles[0]?.label ?? 'Unavailable'}</Text>}
          <View style={styles.nameRow}><Field label="First name" value={firstName} onChangeText={setFirstName} autoCapitalize="words" containerStyle={styles.nameField} /><Field label="Last name" value={lastName} onChangeText={setLastName} autoCapitalize="words" containerStyle={styles.nameField} /></View>
          <Field label="Institutional email" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
          {role === 'faculty' ? <Field label="Employee ID" value={employeeId} onChangeText={setEmployeeId} autoCapitalize="characters" /> : null}
          <View style={styles.actions}><Button label="Send invitation" loading={saving} disabled={!firstName.trim() || !lastName.trim() || !email.trim() || (role === 'faculty' && !employeeId.trim())} onPress={() => void createInvitation()} /><Button label="Cancel" variant="secondary" disabled={saving} onPress={() => setInviteOpen(false)} /></View>
        </ScrollView>
      </Card></View>
    </Modal>
  </>;
}

const styles = StyleSheet.create({
  heading: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  copy: { flex: 1, minWidth: 260 },
  title: { color: colors.text, fontSize: 22, lineHeight: 30, fontWeight: '700' },
  subtitle: { color: colors.textMuted, fontSize: 13, lineHeight: 19, marginTop: 3 },
  card: { gap: 8 },
  cardTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  help: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  overlay: { flex: 1, backgroundColor: '#00000066', alignItems: 'center', justifyContent: 'center', padding: 20 },
  dialog: { width: '100%', maxWidth: 600, maxHeight: '90%', flexShrink: 1, padding: 20, gap: 12 },
  dialogHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  dialogTitle: { color: colors.text, fontSize: 19, fontWeight: '700' },
  close: { color: colors.textMuted, fontSize: 28 },
  dialogBody: { gap: 13, paddingBottom: 4 },
  nameRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  nameField: { flex: 1, minWidth: 200 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' },
});
