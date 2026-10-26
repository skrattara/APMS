-- Fictional development reference data only. No production credentials or real people.
insert into public.departments (id, code, name) values
  ('10000000-0000-0000-0000-000000000001', 'BS', 'Business School'),
  ('10000000-0000-0000-0000-000000000002', 'COE', 'College of Engineering'),
  ('10000000-0000-0000-0000-000000000003', 'CIT', 'College of Information Technology'),
  ('10000000-0000-0000-0000-000000000004', 'SDC', 'School of Design and Communication')
on conflict do nothing;

insert into public.programs (id, department_id, code, name) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'BSBA', 'Bachelor of Science in Business Administration'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'BSCE', 'Bachelor of Science in Civil Engineering'),
  ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000003', 'BSIT', 'Bachelor of Science in Information Technology'),
  ('20000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000004', 'BACOMM', 'Bachelor of Arts in Communication')
on conflict do nothing;

insert into public.academic_terms (id, academic_year, semester, starts_on, ends_on, status) values
  ('30000000-0000-0000-0000-000000000001', '2026-2027', 'First Semester', '2026-08-03', '2026-12-19', 'active')
on conflict do nothing;

insert into public.subjects (id, department_id, code, title, units) values
  ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000003', 'IT-301', 'Data Structures and Algorithms', 3),
  ('40000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000003', 'IT-305', 'Database Systems', 3),
  ('40000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'BA-210', 'Operations Management', 3)
on conflict do nothing;

insert into public.roles (key, name, description) values
  ('faculty', 'Faculty', 'Manages assigned classes, assessment results, evaluation, prediction, and feedback.'),
  ('academic_admin', 'Academic Admin', 'Monitors academic records and aggregate performance within an authorized scope.'),
  ('system_admin', 'System Admin', 'Manages users, roles, configuration, security, logs, and backup status.')
on conflict (key) do update set name = excluded.name, description = excluded.description;

insert into public.permissions (key, description) values
  ('dashboard.read','Read the role dashboard'),
  ('students.read.assigned','Read assigned students'),('students.manage.assigned','Manage students for assigned classes'),
  ('students.read.department','Read department students'),('faculty.read.department','Read department faculty'),
  ('class_records.manage.assigned','Manage assigned class records'),('class_records.read.department','Read department class records'),
  ('criteria.manage.assigned','Manage assigned class criteria'),('criteria.manage.department','Manage department criteria'),
  ('assessment_results.manage.assigned','Manage assigned assessment results'),('evaluations.run.assigned','Run assigned class evaluations'),
  ('predictions.run.assigned','Run assigned predictions'),('feedback.send.assigned','Send feedback to assigned students'),
  ('attendance.manage.assigned','Manage attendance for assigned classes'),('attendance.read.department','Read department attendance'),
  ('imports.manage.assigned','Import files for assigned classes'),
  ('analytics.read.assigned','Read assigned analytics'),('analytics.read.department','Read department analytics'),
  ('reports.export.assigned','Export assigned reports'),('reports.export.department','Export department reports'),
  ('reports.export.system','Export operational system reports'),
  ('users.manage','Manage user accounts'),
  ('roles.manage','Manage roles and permissions'),('system.configure','Configure system and authentication limits'),
  ('integrations.manage','Manage integrations'),('logs.read','Read technical logs'),('logs.export','Export technical logs'),
  ('backups.manage','Manage backups'),('admin_accounts.manage','Manage System Operator/admin accounts')
on conflict (key) do update set description = excluded.description;

with mapping(role_key, permission_key) as (values
  ('faculty','dashboard.read'),('faculty','students.read.assigned'),('faculty','students.manage.assigned'),('faculty','class_records.manage.assigned'),('faculty','criteria.manage.assigned'),('faculty','assessment_results.manage.assigned'),('faculty','evaluations.run.assigned'),('faculty','predictions.run.assigned'),('faculty','feedback.send.assigned'),('faculty','attendance.manage.assigned'),('faculty','imports.manage.assigned'),('faculty','analytics.read.assigned'),('faculty','reports.export.assigned'),
  ('academic_admin','dashboard.read'),('academic_admin','students.read.department'),('academic_admin','faculty.read.department'),('academic_admin','class_records.read.department'),('academic_admin','criteria.manage.department'),('academic_admin','attendance.read.department'),('academic_admin','analytics.read.department'),('academic_admin','reports.export.department'),
  ('system_admin','dashboard.read'),('system_admin','users.manage'),('system_admin','roles.manage'),('system_admin','system.configure'),('system_admin','integrations.manage'),('system_admin','logs.read'),('system_admin','logs.export'),('system_admin','backups.manage'),('system_admin','admin_accounts.manage'),('system_admin','reports.export.system')
)
insert into public.role_permissions(role_id, permission_id)
select r.id, p.id from mapping m join public.roles r on r.key = m.role_key join public.permissions p on p.key = m.permission_key
on conflict do nothing;

insert into public.model_versions (name, version, status, feature_schema, metrics) values
  ('APMS synthetic logistic prototype', 'synthetic-logistic-demo-v1', 'testing', '{"features":["current_standing","recent_trend","attendance_rate","missing_assessments"]}', '{"institutionally_validated":false,"dataset":"controlled synthetic demonstration"}')
on conflict do nothing;

insert into public.system_settings (key, value) values
  ('security.session_minutes', '60'),
  ('security.mfa_required', 'false'),
  ('security.mfa_required_roles', '[]'),
  ('security.mfa_required_departments', '[]'),
  ('backup.retention_days', '30'),
  ('ai.enabled', 'true')
on conflict (key) do nothing;
