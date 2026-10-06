alter table public.assessment_results
  alter column score drop not null,
  add column categorical_value text,
  add constraint assessment_results_one_score_value
    check (num_nonnulls(score, categorical_value) = 1);
