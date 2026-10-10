-- Support the audit feed's newest-first, limited query without scanning and
-- sorting the entire audit log table.
create index if not exists audit_logs_created_at_desc_idx
  on public.audit_logs (created_at desc);
