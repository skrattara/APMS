-- System Admins can review class-scoped deadline requests, but the normal class
-- RLS policy intentionally excludes them. Expose only the labels needed by that UI.
create view public.system_admin_class_labels
with (security_barrier = true)
as
select cr.id, cr.section, s.code as subject_code, s.title as subject_title
from public.class_records cr
join public.subjects s on s.id = cr.subject_id
where private.has_permission('system.configure');

revoke all on public.system_admin_class_labels from public, anon;
grant select on public.system_admin_class_labels to authenticated;
