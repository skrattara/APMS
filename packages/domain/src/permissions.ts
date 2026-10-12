import type { RoleKey, SessionActor } from './types';

export const permissionKeys = [
  'dashboard.read',
  'students.read.assigned',
  'students.manage.assigned',
  'students.read.department',
  'subjects.manage.department',
  'faculty.read.department',
  'class_records.manage.assigned',
  'class_records.read.department',
  'criteria.manage.assigned',
  'criteria.manage.department',
  'assessment_results.manage.assigned',
  'evaluations.run.assigned',
  'predictions.run.assigned',
  'feedback.send.assigned',
  'attendance.manage.assigned',
  'attendance.read.department',
  'imports.manage.assigned',
  'analytics.read.assigned',
  'analytics.read.department',
  'reports.export.assigned',
  'reports.export.department',
  'reports.export.system',
  'users.manage',
  'roles.manage',
  'system.configure',
  'integrations.manage',
  'logs.read',
  'logs.export',
  'backups.manage',
  'admin_accounts.manage',
] as const;

export type PermissionKey = (typeof permissionKeys)[number];

export const rolePermissions: Record<RoleKey, readonly PermissionKey[]> = {
  faculty: [
    'dashboard.read', 'students.read.assigned', 'students.manage.assigned',
    'class_records.manage.assigned', 'criteria.manage.assigned',
    'assessment_results.manage.assigned', 'evaluations.run.assigned',
    'predictions.run.assigned', 'feedback.send.assigned',
    'attendance.manage.assigned', 'imports.manage.assigned',
    'analytics.read.assigned', 'reports.export.assigned',
  ],
  academic_admin: [
    'dashboard.read', 'students.read.department', 'faculty.read.department',
    'class_records.read.department', 'criteria.manage.department',
    'subjects.manage.department', 'attendance.read.department',
    'analytics.read.department', 'reports.export.department',
  ],
  system_admin: [
    'dashboard.read', 'users.manage', 'roles.manage', 'system.configure',
    'integrations.manage', 'logs.read', 'logs.export', 'backups.manage',
    'admin_accounts.manage',
    'reports.export.system',
  ],
};

export function hasPermission(role: RoleKey, permission: PermissionKey): boolean {
  return rolePermissions[role].includes(permission);
}

export function canAccessClassRecord(
  actor: SessionActor,
  record: { id: string; departmentId: string; studentProfileIds?: string[] },
): boolean {
  if (actor.role === 'faculty') return actor.assignedClassRecordIds.includes(record.id);
  if (actor.role === 'academic_admin') return actor.departmentIds.includes(record.departmentId);
  return false;
}
