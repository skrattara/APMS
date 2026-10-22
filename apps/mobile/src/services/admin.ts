import { supabase } from './supabase';
import * as tus from 'tus-js-client';

export type ManagedUser = {
  id: string; email: string; firstName: string; lastName: string; status: 'active' | 'inactive' | 'suspended';
  role: 'system_admin' | 'academic_admin' | 'faculty' | null; roleName: string | null; scopeType: string | null; scopeId: string | null; lastLoginAt: string | null;
};

export type AdminWorkspace = {
  users: ManagedUser[];
  roles: { id: string; key: string; name: string; description: string; permissions: number; users: number }[];
  departments: DepartmentRecord[];
  programs: ProgramRecord[];
  terms: AcademicTermRecord[];
  logs: { id: string; createdAt: string; action: string; entityType: string; entityId: string | null; actorId: string | null }[];
  backups: { id: string; scope: string; status: string; createdAt: string; completedAt: string | null; fileName: string | null; sizeBytes: number | null; safeError: string | null; storagePath: string | null; scheduleId: string | null }[];
  backupRestores: { id: string; status: string; createdAt: string; completedAt: string | null; safeError: string | null }[];
  backupSchedule: { id: string; frequency: 'daily' | 'weekly' | 'monthly'; enabled: boolean; retentionDays: number; nextRunAt: string; lastRunAt: string | null } | null;
  settings: { key: string; value: unknown; updatedAt: string }[];
};

export type DepartmentRecord = { id: string; code: string; name: string; status: 'active' | 'inactive' };
export type ProgramRecord = { id: string; departmentId: string; code: string; name: string; status: 'active' | 'inactive' };
export type AcademicTermRecord = { id: string; academicYear: string; semester: string; startsOn: string; endsOn: string; status: 'planned' | 'active' | 'closed' | 'archived' };
export type YearLevelRecord = { level: number; label: string; sortOrder: number };

export async function loadYearLevels(programId: string): Promise<YearLevelRecord[]> {
  if (!supabase) throw new Error('APMS is not connected to Supabase.');
  const { data, error } = await supabase.from('year_levels').select('program_id,level,label,sort_order').eq('program_id', programId).order('sort_order').order('level');
  if (error) throw error;
  return (data ?? []).map((row) => ({ level: row.level, label: row.label, sortOrder: row.sort_order }));
}

export async function saveYearLevel(input: YearLevelRecord & { programId: string }) {
  if (!supabase) throw new Error('APMS is not connected to Supabase.');
  const { error } = await supabase.from('year_levels').upsert({ program_id: input.programId, level: input.level, label: input.label.trim(), sort_order: input.sortOrder }, { onConflict: 'program_id,level' });
  if (error) throw error;
}

export async function deleteYearLevel(programId: string, level: number) {
  if (!supabase) throw new Error('APMS is not connected to Supabase.');
  const { error } = await supabase.from('year_levels').delete().eq('program_id', programId).eq('level', level);
  if (error) throw error;
}

async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  if (!supabase) throw new Error('APMS is not connected to Supabase.');
  const { data, error } = await supabase.functions.invoke('admin-users', { body });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data as T;
}

export async function loadAdminWorkspace(): Promise<AdminWorkspace> {
  if (!supabase) throw new Error('APMS is not connected to Supabase.');
  const [userResponse, roles, departments, programs, terms, logs, backups, restores, schedules, settings] = await Promise.all([
    invoke<{ users: ManagedUser[] }>({ action: 'list' }),
    supabase.from('roles').select('id,key,name,description,role_permissions(count),user_roles(count)').order('name'),
    supabase.from('departments').select('id,code,name,status').order('code'),
    supabase.from('programs').select('id,department_id,code,name,status').order('code'),
    supabase.from('academic_terms').select('id,academic_year,semester,starts_on,ends_on,status').order('starts_on', { ascending: false }),
    supabase.from('audit_logs').select('id,created_at,action,entity_type,entity_id,actor_id').order('created_at', { ascending: false }).limit(100),
    supabase.from('backups').select('id,scope,status,created_at,completed_at,file_name,size_bytes,safe_error,storage_path,schedule_id').order('created_at', { ascending: false }).limit(25),
    supabase.from('backup_restores').select('id,status,created_at,completed_at,safe_error').order('created_at', { ascending: false }).limit(25),
    supabase.from('backup_schedules').select('id,frequency,enabled,retention_days,next_run_at,last_run_at').order('updated_at', { ascending: false }).limit(1),
    supabase.from('system_settings').select('key,value,updated_at').order('key'),
  ]);
  const error = roles.error ?? departments.error ?? programs.error ?? terms.error ?? logs.error ?? backups.error ?? restores.error ?? schedules.error ?? settings.error;
  if (error) throw error;
  return {
    users: userResponse.users,
    roles: (roles.data ?? []).map((row: any) => ({ id: row.id, key: row.key, name: row.name, description: row.description, permissions: Number(row.role_permissions?.[0]?.count ?? 0), users: Number(row.user_roles?.[0]?.count ?? 0) })),
    departments: departments.data ?? [],
    programs: (programs.data ?? []).map((row) => ({ id: row.id, departmentId: row.department_id, code: row.code, name: row.name, status: row.status })),
    terms: (terms.data ?? []).map((row) => ({ id: row.id, academicYear: row.academic_year, semester: row.semester, startsOn: row.starts_on, endsOn: row.ends_on, status: row.status })),
    logs: (logs.data ?? []).map((row) => ({ id: row.id, createdAt: row.created_at, action: row.action, entityType: row.entity_type, entityId: row.entity_id, actorId: row.actor_id })),
    backups: (backups.data ?? []).map((row) => ({ id: row.id, scope: row.scope, status: row.status, createdAt: row.created_at, completedAt: row.completed_at, fileName: row.file_name, sizeBytes: row.size_bytes == null ? null : Number(row.size_bytes), safeError: row.safe_error, storagePath: row.storage_path, scheduleId: row.schedule_id })),
    backupRestores: (restores.data ?? []).map((row) => ({ id: row.id, status: row.status, createdAt: row.created_at, completedAt: row.completed_at, safeError: row.safe_error })),
    backupSchedule: schedules.data?.[0] ? { id: schedules.data[0].id, frequency: schedules.data[0].frequency, enabled: schedules.data[0].enabled, retentionDays: schedules.data[0].retention_days, nextRunAt: schedules.data[0].next_run_at, lastRunAt: schedules.data[0].last_run_at } : null,
    settings: (settings.data ?? []).map((row) => ({ key: row.key, value: row.value, updatedAt: row.updated_at })),
  };
}

export async function saveDepartment(input: { id?: string; code: string; name: string; status?: 'active' | 'inactive' }) {
  if (!supabase) throw new Error('APMS is not connected to Supabase.');
  const { error } = await supabase.from('departments').upsert({ id: input.id, code: input.code.trim().toUpperCase(), name: input.name.trim(), status: input.status ?? 'active', updated_at: new Date().toISOString() }, { onConflict: 'id' });
  if (error) throw error;
}

export async function saveProgram(input: { id?: string; departmentId: string; code: string; name: string; status?: 'active' | 'inactive' }) {
  if (!supabase) throw new Error('APMS is not connected to Supabase.');
  const { error } = await supabase.from('programs').upsert({ id: input.id, department_id: input.departmentId, code: input.code.trim().toUpperCase(), name: input.name.trim(), status: input.status ?? 'active', updated_at: new Date().toISOString() }, { onConflict: 'id' });
  if (error) throw error;
}

export async function deleteProgram(id: string) {
  if (!supabase) throw new Error('APMS is not connected to Supabase.');
  const { error } = await supabase.from('programs').delete().eq('id', id);
  if (error) {
    if (error.code === '23503') throw new Error('This program is linked to one or more students and cannot be deleted. Set it to Inactive instead.');
    throw error;
  }
}

export async function saveAcademicTerm(input: { id?: string; academicYear: string; semester: string; startsOn: string; endsOn: string; status: AcademicTermRecord['status'] }) {
  if (!supabase) throw new Error('APMS is not connected to Supabase.');
  const { error } = await supabase.from('academic_terms').upsert({ id: input.id, academic_year: input.academicYear.trim(), semester: input.semester.trim(), starts_on: input.startsOn, ends_on: input.endsOn, status: input.status, updated_at: new Date().toISOString() }, { onConflict: 'id' });
  if (error) throw error;
}

export async function createManagedUser(input: { email: string; password: string; firstName: string; lastName: string; role: 'system_admin' | 'academic_admin' | 'faculty'; departmentId?: string; employeeId?: string }) {
  return invoke<{ userId: string }>({ action: 'create', ...input });
}

export async function updateManagedUser(input: { userId: string; status?: 'active' | 'inactive' | 'suspended'; role?: 'system_admin' | 'academic_admin' | 'faculty'; departmentId?: string; employeeId?: string; password?: string }) {
  return invoke<{ userId: string }>({ action: 'update', ...input });
}

export async function createJsonBackup(password: string) {
  if (!supabase) throw new Error('APMS is not connected to Supabase.');
  const { data, error } = await supabase.functions.invoke('apms-backups', { body: { action: 'create', password } });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data as { id: string; fileName: string; sizeBytes: number; checksum: string; downloadUrl: string };
}

export async function uploadJsonBackup(file: File, onProgress: (percent: number) => void) {
  if (!supabase) throw new Error('APMS is not connected to Supabase.');
  if (typeof window === 'undefined' || typeof File === 'undefined') throw new Error('Resumable backup restore is available in the web portal.');
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError || !sessionData.session) throw sessionError ?? new Error('Sign in again to restore a backup.');
  const fingerprint = `${file.name}:${file.size}:${file.lastModified}`;
  const priorPath = localStorage.getItem(`apms-backup-upload:${fingerprint}`);
  const path = priorPath ?? `${sessionData.session.user.id}/restore-${crypto.randomUUID()}/${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  localStorage.setItem(`apms-backup-upload:${fingerprint}`, path);
  const { data: signedUpload, error: signedError } = await supabase.storage.from('apms-backups').createSignedUploadUrl(path, { upsert: true });
  if (signedError || !signedUpload) throw signedError ?? new Error('Could not prepare the resumable upload.');
  const projectUrl = process.env.EXPO_PUBLIC_SUPABASE_URL?.replace(/\/$/, '');
  if (!projectUrl) throw new Error('Supabase project URL is not configured.');
  const storageUrl = projectUrl.replace(/\.supabase\.co$/, '.storage.supabase.co');
  return await new Promise<{ path: string; name: string }>((resolve, reject) => {
    const upload = new tus.Upload(file, {
      endpoint: `${storageUrl}/storage/v1/upload/resumable`,
      retryDelays: [0, 3000, 5000, 10000, 20000],
      headers: { authorization: `Bearer ${sessionData.session!.access_token}`, apikey: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '', 'x-signature': signedUpload.token, 'x-upsert': 'true' },
      metadata: { bucketName: 'apms-backups', objectName: path, contentType: 'application/json', cacheControl: '3600' },
      chunkSize: 6 * 1024 * 1024,
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      onError: reject,
      onProgress: (uploaded, total) => onProgress(total ? Math.round(uploaded / total * 100) : 0),
      onSuccess: () => resolve({ path, name: file.name }),
    });
    void upload.findPreviousUploads().then((previous) => {
      if (previous.length) upload.resumeFromPreviousUpload(previous[0]);
      upload.start();
    }).catch(reject);
  });
}

export async function restoreJsonBackup(storagePath: string, fileName: string, password: string) {
  if (!supabase) throw new Error('APMS is not connected to Supabase.');
  const { data, error } = await supabase.functions.invoke('apms-backups', { body: { action: 'restore', storagePath, fileName, password } });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data as { id: string; restored_rows: number };
}

export async function restoreStoredScheduledBackup(backupId: string) {
  if (!supabase) throw new Error('APMS is not connected to Supabase.');
  const { data, error } = await supabase.functions.invoke('apms-backups', { body: { action: 'restore', backupId } });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data as { id: string; restored_rows: number };
}

export async function saveBackupSchedule(userId: string, input: { id?: string; frequency: 'daily' | 'weekly' | 'monthly'; enabled: boolean; retentionDays: number }) {
  if (!supabase) throw new Error('APMS is not connected to Supabase.');
  const intervalDays = input.frequency === 'daily' ? 1 : input.frequency === 'weekly' ? 7 : 30;
  const row = {
    ...(input.id ? { id: input.id } : {}),
    frequency: input.frequency, enabled: input.enabled, retention_days: input.retentionDays,
    next_run_at: new Date(Date.now() + intervalDays * 86_400_000).toISOString(), created_by: userId, updated_at: new Date().toISOString(),
  };
  const { error } = input.id
    ? await supabase.from('backup_schedules').update(row).eq('id', input.id)
    : await supabase.from('backup_schedules').insert(row);
  if (error) throw error;
}

export async function saveSystemSetting(userId: string, key: string, value: unknown) {
  if (!supabase) throw new Error('APMS is not connected to Supabase.');
  const { error } = await supabase.from('system_settings').upsert({ key, value, updated_by: userId }, { onConflict: 'key' });
  if (error) throw error;
}
