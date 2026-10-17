import { supabase } from './supabase';

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
  logs: { id: number; createdAt: string; action: string; entityType: string; actorId: string | null }[];
  backups: { id: string; scope: string; status: string; createdAt: string; completedAt: string | null }[];
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
  const [userResponse, roles, departments, programs, terms, logs, backups, settings] = await Promise.all([
    invoke<{ users: ManagedUser[] }>({ action: 'list' }),
    supabase.from('roles').select('id,key,name,description,role_permissions(count),user_roles(count)').order('name'),
    supabase.from('departments').select('id,code,name,status').order('code'),
    supabase.from('programs').select('id,department_id,code,name,status').order('code'),
    supabase.from('academic_terms').select('id,academic_year,semester,starts_on,ends_on,status').order('starts_on', { ascending: false }),
    supabase.from('audit_logs').select('id,created_at,action,entity_type,actor_id').order('created_at', { ascending: false }).limit(100),
    supabase.from('backups').select('id,scope,status,created_at,completed_at').order('created_at', { ascending: false }).limit(25),
    supabase.from('system_settings').select('key,value,updated_at').order('key'),
  ]);
  const error = roles.error ?? departments.error ?? programs.error ?? terms.error ?? logs.error ?? backups.error ?? settings.error;
  if (error) throw error;
  return {
    users: userResponse.users,
    roles: (roles.data ?? []).map((row: any) => ({ id: row.id, key: row.key, name: row.name, description: row.description, permissions: Number(row.role_permissions?.[0]?.count ?? 0), users: Number(row.user_roles?.[0]?.count ?? 0) })),
    departments: departments.data ?? [],
    programs: (programs.data ?? []).map((row) => ({ id: row.id, departmentId: row.department_id, code: row.code, name: row.name, status: row.status })),
    terms: (terms.data ?? []).map((row) => ({ id: row.id, academicYear: row.academic_year, semester: row.semester, startsOn: row.starts_on, endsOn: row.ends_on, status: row.status })),
    logs: (logs.data ?? []).map((row) => ({ id: row.id, createdAt: row.created_at, action: row.action, entityType: row.entity_type, actorId: row.actor_id })),
    backups: (backups.data ?? []).map((row) => ({ id: row.id, scope: row.scope, status: row.status, createdAt: row.created_at, completedAt: row.completed_at })),
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

export async function queueBackup(userId: string) {
  if (!supabase) throw new Error('APMS is not connected to Supabase.');
  const { error } = await supabase.from('backups').insert({ scope: 'full', status: 'queued', created_by: userId });
  if (error) throw error;
}

export async function saveSystemSetting(userId: string, key: string, value: unknown) {
  if (!supabase) throw new Error('APMS is not connected to Supabase.');
  const { error } = await supabase.from('system_settings').upsert({ key, value, updated_by: userId }, { onConflict: 'key' });
  if (error) throw error;
}
