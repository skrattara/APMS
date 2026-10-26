import { supabase } from './supabase';

export type AcademicDepartmentUser = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: 'faculty' | 'academic_admin';
  roleName: string;
  status: 'invited' | 'active' | 'inactive' | 'suspended';
  onboardingComplete: boolean;
};

async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  if (!supabase) throw new Error('APMS is not connected to Supabase.');
  const { data, error } = await supabase.functions.invoke('academic-admin-users', { body });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data as T;
}

export async function loadAcademicDepartmentUsers() {
  return invoke<{ users: AcademicDepartmentUser[]; canInviteAcademicAdmins: boolean; canInviteFaculty: boolean }>({ action: 'list' });
}

export async function inviteAcademicDepartmentUser(input: {
  email: string;
  firstName: string;
  lastName: string;
  role: 'faculty' | 'academic_admin';
  employeeId?: string;
  redirectTo: string;
}) {
  return invoke<{ userId: string; invited: boolean }>({ action: 'invite', ...input });
}

export async function resendAcademicDepartmentInvitation(input: { userId: string; redirectTo: string }) {
  return invoke<{ userId: string; invitationSent: boolean }>({ action: 'resend_invitation', ...input });
}
