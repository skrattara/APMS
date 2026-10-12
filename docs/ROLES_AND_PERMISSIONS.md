# Roles and Permissions Model

Three canonical authenticated roles are implemented in APMS: **System Admin**, **Academic Admin**, and **Faculty**. Students are monitored records and do not hold interactive login roles.

## 1. Role Scope and Boundaries

| Role | Scope Type | Scope ID | Core Responsibilities |
|---|---|---|---|
| **System Admin** | Global | `NULL` | Technical platform administration, user provisioning, role assignments, system logs, backups, and security configuration. No routine academic grading access. |
| **Academic Admin** | Department | `departments.id` | Departmental operational oversight, student monitoring, subject lifecycle management (`subjects.manage.department`), review and approval of faculty subject requests, criteria oversight, and academic reporting. |
| **Faculty** | Assigned Classes | `class_records.id` via `faculty_assignments` | Autonomous class creation, student roster management and CSV import, SWUNEXT assessment management, batch grade entry, roll call attendance, advisory risk analysis, student feedback drafts, and class report exports. |

## 2. Canonical Permission Keys

```
faculty: [
  dashboard.read,
  students.read.assigned,
  students.manage.assigned,
  class_records.manage.assigned,
  criteria.manage.assigned,
  assessment_results.manage.assigned,
  evaluations.run.assigned,
  predictions.run.assigned,
  feedback.send.assigned,
  attendance.manage.assigned,
  imports.manage.assigned,
  analytics.read.assigned,
  reports.export.assigned
]

academic_admin: [
  dashboard.read,
  students.read.department,
  faculty.read.department,
  class_records.read.department,
  criteria.manage.department,
  subjects.manage.department,       <-- Added for department-scoped subject management
  attendance.read.department,
  analytics.read.department,
  reports.export.department
]

system_admin: [
  dashboard.read,
  users.manage,
  roles.manage,
  system.configure,
  integrations.manage,
  logs.read,
  logs.export,
  backups.manage,
  admin_accounts.manage,
  reports.export.system
]
```

System Admin reports are limited to operational administration data (accounts, role assignments, audit activity, and backup status). Academic performance reports remain faculty class-scoped or academic-admin department-scoped.

## 3. Database Security Enforcement

- **PostgreSQL Row Level Security (RLS)** is enabled on all 48 public tables.
- **Subject Access RLS**:
  - Faculty: Can only `SELECT` active subjects within their assigned department (`faculty_profiles.department_id`).
  - Academic Admin: Can `SELECT`, `INSERT`, and `UPDATE` all subjects in their authorized department (`user_roles.scope_id`).
  - System Admin: Global `SELECT` and `ALL` access guarded by `system.configure`.
- **Subject Request RLS**:
  - Faculty: Can `INSERT` requests (with department derived from active faculty profile) and `SELECT` their own submitted requests.
  - Academic Admin: Can `SELECT` and `UPDATE` requests matching their department.
- **RPC Functions**:
  - Security-sensitive actions run inside `SECURITY DEFINER` RPCs with `search_path = ''`.
  - Caller identity is derived strictly from `auth.uid()`, preventing client-side spoofing.

