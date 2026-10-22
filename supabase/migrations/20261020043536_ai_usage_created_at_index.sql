-- System Admin usage reports filter the full usage history by date range.
create index if not exists ai_model_usage_created_at_idx
  on public.ai_model_usage (created_at desc);
