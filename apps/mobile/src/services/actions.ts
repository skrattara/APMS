import type { Role } from '@apms/domain';

import type { AuthUser } from '@/auth/AuthProvider';
import { supabase } from './supabase';

type ActionContext = { screen: string; role: Role; user: AuthUser; demoMode: boolean; label: string };

export async function performScreenAction({ screen, user, demoMode, label }: ActionContext): Promise<string> {
  if (demoMode) return `${label} simulated with fictional development data; no production record was written.`;
  if (!supabase) throw new Error('APMS is not connected. No action was performed.');

  if (screen === 'backup') {
    const { error } = await supabase.from('backups').insert({ scope: 'full', status: 'queued', created_by: user.id });
    if (error) throw error;
    return 'Backup request queued. The protected worker will report verification and completion status.';
  }

  throw new Error(`${label} requires its validated workflow form or protected server worker. No record was changed.`);
}

export type SettingsValues = {
  first: string;
  last: string;
  phone: string;
  sessionMinutes: string;
  systemName?: string;
  institutionName?: string;
  contactEmail?: string;
  timezone?: string;
  language?: string;
  lockoutThreshold?: string;
  dataRetention?: string;
  provider?: string;
  maintenanceMode?: boolean;
  mfaRequired?: boolean;
  autosaveEnabled?: boolean;
};

export async function loadAutosavePreference(userId?: string): Promise<boolean> {
  if (!userId || !supabase) return true;
  const { data, error } = await supabase.from('profiles').select('gradebook_autosave').eq('id', userId).maybeSingle();
  if (error) throw error;
  return data?.gradebook_autosave ?? true;
}

export async function saveSettings(screen: string, user: AuthUser, demoMode: boolean, values: SettingsValues) {
  if (demoMode) return 'Settings simulated with fictional development data; no production record was written.';
  if (!supabase) throw new Error('APMS is not connected. No settings were changed.');
  if (screen === 'settings') {
    const { error } = await supabase.from('profiles').update({ first_name: values.first.trim(), last_name: values.last.trim(), phone: values.phone.trim() || null, ...(values.autosaveEnabled === undefined ? {} : { gradebook_autosave: values.autosaveEnabled }) }).eq('id', user.id);
    if (error) throw error;
    return 'Profile settings saved.';
  }
  if (screen === 'notifications') {
    const { error } = await supabase.from('notification_preferences').upsert({ user_id: user.id, event_type: 'academic_updates', in_app: true, email: true });
    if (error) throw error;
    return 'Notification preferences saved.';
  }
  const minutes = Number(values.sessionMinutes);
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440) throw new Error('Session duration must be between 5 and 1440 minutes.');
  const systemValues: Record<string, string | number | boolean | undefined> = {
    system_name: values.systemName,
    institution_name: values.institutionName,
    contact_email: values.contactEmail,
    timezone: values.timezone,
    language: values.language,
    session_timeout_minutes: minutes,
    lockout_threshold: values.lockoutThreshold ? Number(values.lockoutThreshold) : undefined,
    data_retention: values.dataRetention,
    auth_provider: values.provider,
    maintenance_mode: values.maintenanceMode,
    mfa_required: values.mfaRequired,
  };
  const rows = Object.entries(systemValues).filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined).map(([key, value]) => ({ key, value, updated_by: user.id }));
  const { error } = await supabase.from('system_settings').upsert(rows, { onConflict: 'key' });
  if (error) throw error;
  return 'System settings saved.';
}

export async function changePassword(user: AuthUser, demoMode: boolean, currentPassword: string, newPassword: string) {
  if (demoMode) throw new Error('Password changes are unavailable for development-only accounts.');
  if (!supabase) throw new Error('APMS is not connected. The password was not changed.');
  if (newPassword.length < 12) throw new Error('The new password must contain at least 12 characters.');
  const { error: verifyError } = await supabase.auth.signInWithPassword({ email: user.email, password: currentPassword });
  if (verifyError) throw new Error('The current password is incorrect.');
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw new Error('The password could not be changed.');
  return 'Password updated. Other sessions should be reviewed and signed out if they are no longer trusted.';
}
