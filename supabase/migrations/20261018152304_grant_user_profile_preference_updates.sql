-- RLS continues to restrict updates to the signed-in user's own profile row.
-- Grant only the account preference columns, not broad profile-table updates.
grant update (gradebook_autosave, table_pagination_enabled, failing_grades_red)
  on public.profiles to authenticated;