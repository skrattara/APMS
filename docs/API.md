# API

Supabase generates REST endpoints for RLS-protected public tables. The application uses authenticated client requests; privileged secrets never enter the client bundle.

Key resources include `/profiles`, `/students`, `/faculty_profiles`, `/class_records`, `/criteria_sets`, `/assessments`, `/assessment_results`, `/grader_assignments`, `/grader_submissions`, `/performance_evaluations`, `/performance_predictions`, `/feedback_records`, `/events`, `/audit_logs`, and `/backups`.

Report exports are generated client-side from authorized data already loaded through RLS-protected resources. Faculty can export the selected class or lazily load all assigned classes, Academic Admin can export authorized department data, and System Admin can export operational account, role, audit, and backup reports. The shared analytics operations support typed filtering, sorting, grouping, count/sum/average/minimum/maximum aggregation, capped pivots, and drilldown. The question-led builder selects measures and multiple relevant visualizations automatically for group comparisons, dated assessment score ranges, risk, attendance, missed assessments, and score distributions. Comparison reports can filter groups by average current-standing thresholds and order groups by average, enrollment, or name. Templates include executive summary, detailed analysis, risk brief, trend report, cohort comparison, attendance brief, assessment follow-up, and data table, with portrait or landscape layout, interpretation, and concise output. Academic reports use applied grading definitions and calculated results when available. Raw records appear only in the explicit Data table template; other templates contain aggregates and selected insights.

RPC: `review_grader_submission(target_submission_id, review_decision, review_reason)` accepts only `approved|rejected`, requires review permission and class scope, rejects non-submitted records, and returns the updated submission.

AI service:

- `GET /health` — service/model availability.
- `POST /v1/predictions` — validated evaluation input; returns 503 without an approved model and never fabricates a prediction.

Errors shown to users are sanitized; raw database paths, SQL, stack traces, and secrets are not rendered.
