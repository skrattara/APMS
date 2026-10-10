-- Let users who can access a class see only score-result audit entries for that
-- class. The existing assessment_results audit trigger records before/after
-- snapshots, so no duplicate history table is needed.
create policy assessment_result_audit_history_scoped_read
on public.audit_logs
for select
to authenticated
using (
  entity_type = 'assessment_results'
  and exists (
    select 1
    from public.assessments a
    where a.id::text = coalesce(after_data ->> 'assessment_id', before_data ->> 'assessment_id')
      and private.can_access_class(a.class_record_id)
  )
);

-- PostgreSQL ORs permissive policies together. Keep the existing technical-log
-- permission from granting global access to assessment-result history; those
-- entries are readable only through the class-scoped policy above.
drop policy if exists audit_logs_technical on public.audit_logs;
create policy audit_logs_technical
on public.audit_logs
for select
to authenticated
using (
  entity_type <> 'assessment_results'
  and private.has_permission('logs.read')
);
