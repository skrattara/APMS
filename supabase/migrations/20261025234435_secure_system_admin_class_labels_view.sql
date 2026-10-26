-- Make the public view honor the caller's grants and RLS instead of running
-- with the view owner's privileges. System Admins only need class rows that
-- are referenced by deadline-change requests.
drop policy if exists class_records_system_admin_deadline_labels_read on public.class_records;
create policy class_records_system_admin_deadline_labels_read
  on public.class_records
  for select
  to authenticated
  using (
    (select private.has_permission('system.configure'))
    and exists (
      select 1
      from public.grade_encoding_deadline_requests request
      where request.class_record_id = class_records.id
    )
  );

alter view public.system_admin_class_labels
  set (security_invoker = true);
