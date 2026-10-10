create index if not exists gradebook_score_versions_class_history_idx
  on public.gradebook_score_versions (class_record_id, created_at desc, id desc);
