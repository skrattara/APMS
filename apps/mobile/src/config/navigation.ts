import type { Role } from '@apms/domain';
import type { AppIconName } from '@/components/Icon';

export type NavItem = { key: string; label: string; icon: AppIconName; hidden?: boolean };

export const ROLE_LABELS: Record<Role, string> = {
  faculty: 'Faculty',
  academic_admin: 'Academic Admin',
  system_admin: 'System Admin',
};

export const ROLE_HOME: Record<Role, string> = {
  faculty: 'overview', academic_admin: 'overview', system_admin: 'overview',
};

export const NAVIGATION: Record<Role, NavItem[]> = {
  faculty: [
    { key: 'overview', label: 'Dashboard', icon: 'home' }, { key: 'classes', label: 'My Classes', icon: 'records' },
    { key: 'gradebook', label: 'Gradebook', icon: 'grades' }, { key: 'attendance', label: 'Attendance', icon: 'criteria' },
    { key: 'students', label: 'Students', icon: 'students' }, { key: 'risk', label: 'At-Risk Students', icon: 'evaluation' },
    { key: 'criteria', label: 'Grading Criteria', icon: 'criteria' }, { key: 'feedback', label: 'Feedback', icon: 'feedback' },
    { key: 'analytics', label: 'Analytics & Reports', icon: 'analytics' }, { key: 'evaluation', label: 'AI Prediction', icon: 'assistant' },
    { key: 'settings', label: 'Settings', icon: 'settings', hidden: true },
  ],
  academic_admin: [
    { key: 'overview', label: 'Dashboard', icon: 'home' }, { key: 'units', label: 'Academic Units', icon: 'faculty' },
    { key: 'subjects', label: 'Subjects', icon: 'records' }, { key: 'classes', label: 'Classes Overview', icon: 'records' },
    { key: 'students', label: 'Student Monitoring', icon: 'students' }, { key: 'risk', label: 'At-Risk Overview', icon: 'evaluation' },
    { key: 'criteria', label: 'Evaluation Criteria', icon: 'criteria' }, { key: 'analytics', label: 'Analytics & Reports', icon: 'analytics' },
    { key: 'settings', label: 'Settings', icon: 'settings' },
  ],
  system_admin: [
    { key: 'overview', label: 'Dashboard', icon: 'home' }, { key: 'admins', label: 'User Management', icon: 'admins' },
    { key: 'setup', label: 'Academic Setup', icon: 'records' },
    { key: 'roles', label: 'Roles & Permissions', icon: 'roles' }, { key: 'backup', label: 'System & Backup Status', icon: 'backup' },
    { key: 'logs', label: 'Access & System Logs', icon: 'logs' }, { key: 'system', label: 'System Settings', icon: 'system' },
    { key: 'data-generator', label: 'Data Generator (Dev)', icon: 'records', hidden: !__DEV__ },
    { key: 'settings', label: 'Settings', icon: 'settings' },
  ],
};

export function isRole(value: string | undefined): value is Role {
  return !!value && Object.prototype.hasOwnProperty.call(NAVIGATION, value);
}
