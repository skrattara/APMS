-- The dashboard counts draft results by approval_status alone. The existing
-- enrollment-first index cannot efficiently serve that query, so keep a small
-- partial index containing only draft rows.
create index assessment_results_draft_count_idx
  on public.assessment_results (id)
  where approval_status = 'draft';
