alter table public.gradebook_score_versions
  add column if not exists version_name text;

alter table public.gradebook_score_versions
  drop constraint if exists gradebook_score_versions_version_name_length;
alter table public.gradebook_score_versions
  add constraint gradebook_score_versions_version_name_length
  check (version_name is null or char_length(version_name) <= 120);

-- Keep naming under RLS and restrict the table privilege to this one column.
grant update (version_name) on public.gradebook_score_versions to authenticated;

drop policy if exists gradebook_score_versions_name on public.gradebook_score_versions;
create policy gradebook_score_versions_name
on public.gradebook_score_versions
for update
to authenticated
using (
  private.can_access_class(class_record_id)
  and (
    private.has_permission('assessment_results.manage.assigned')
    or private.has_permission('assessment_results.manage.department')
  )
)
with check (
  private.can_access_class(class_record_id)
  and (
    private.has_permission('assessment_results.manage.assigned')
    or private.has_permission('assessment_results.manage.department')
  )
);
