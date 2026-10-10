alter table public.audit_logs
  add column if not exists actor_name text;

update public.audit_logs l
set actor_name = nullif(btrim(concat_ws(' ', p.first_name, p.last_name)), '')
from public.profiles p
where p.id = l.actor_id
  and l.actor_name is null;

-- Snapshot the display name at the time of each audit event, without granting
-- class viewers direct access to other users' profile rows.
drop trigger if exists snapshot_audit_log_actor_name on public.audit_logs;
create trigger snapshot_audit_log_actor_name
before insert on public.audit_logs
for each row execute function private.snapshot_gradebook_version_actor_name();

drop policy if exists audit_logs_assessments_class_read on public.audit_logs;
create policy audit_logs_assessments_class_read
on public.audit_logs
for select
to authenticated
using (
  entity_type = 'assessments'
  and private.can_access_class(
    coalesce(
      nullif(after_data ->> 'class_record_id', '')::uuid,
      nullif(before_data ->> 'class_record_id', '')::uuid
    )
  )
);

create index if not exists audit_logs_assessment_history_idx
  on public.audit_logs (created_at desc, id desc)
  where entity_type = 'assessments';

create or replace view public.gradebook_version_history
with (security_invoker = true)
as
select
  v.id,
  v.class_record_id,
  v.created_at,
  'score'::text as event_type,
  v.assessment_id,
  v.enrollment_id,
  v.actor_id,
  v.actor_name,
  v.action,
  v.before_data,
  v.after_data,
  v.restored_from_version_id,
  v.version_name
from public.gradebook_score_versions v
union all
select
  l.id,
  coalesce(
    nullif(l.after_data ->> 'class_record_id', '')::uuid,
    nullif(l.before_data ->> 'class_record_id', '')::uuid
  ) as class_record_id,
  l.created_at,
  'assessment'::text as event_type,
  l.entity_id as assessment_id,
  null::uuid as enrollment_id,
  l.actor_id,
  l.actor_name,
  l.action,
  l.before_data,
  l.after_data,
  null::uuid as restored_from_version_id,
  null::text as version_name
from public.audit_logs l
where l.entity_type = 'assessments';

grant select on public.gradebook_version_history to authenticated;
