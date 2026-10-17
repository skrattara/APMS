# APMS System Architecture

## Roles and boundary

| Role | Responsibility | Academic mutation scope |
| --- | --- | --- |
| System Admin | Users, roles, security, audit, settings, integrations, system/backup status | No routine academic record editing |
| Academic Admin | Authorized program/department oversight, aggregate trends, criteria templates, reports | Criteria/configuration only; no routine score or attendance entry |
| Faculty | Assigned classes, rosters, assessments, batch scores, attendance, provisional standing, prediction, feedback, reports | Assigned classes only |

Students are monitored records. SWU SIS remains outside APMS and is authoritative for enrollment and official grades.

## Data flow

1. Faculty creates a local monitoring class and roster or imports authorized CSV data.
2. Faculty creates manual or CSV-sourced SWUNEXT assessments and records scores.
3. Faculty creates attendance sessions and records present, absent, late, or excused status.
4. The domain engine calculates current/provisional standing, category results, missing-work indicators, attendance rate, and trend.
5. The isolated AI service receives a minimal feature snapshot and returns advisory predicted standing, risk, trend, model version, probability, and understandable factors.
6. APMS stores traceable metadata for Faculty review. Faculty decides whether feedback or intervention is appropriate.
7. Academic Admin sees authorized aggregate/drill-down monitoring. System Admin sees technical operations and audit data.

If AI is unavailable, records, calculations, reports, and historical data remain operational.

## Components and external systems

- Expo client: authenticated UI, manual/batch workflows, dashboards, and reports.
- Shared domain package: deterministic calculations and validation; it never calls AI or Supabase.
- Supabase Auth/Postgres/Data API: identity, persistence, RLS authorization, auditing, and the preserved connection.
- FastAPI AI service: isolated, authenticated prediction contract backed by a configured schema-conditioned Transformer artifact. Explicit synthetic pretraining and real-data adaptation share a versioned pipeline. No official-grade authority; see [model architecture](AI_MODEL_ARCHITECTURE.md) and [service guide](../services/ai/README.md).
- SWU SIS: external authoritative system; no scraping, grade submission, enrollment, billing, or account-management workflow exists.
- External classroom/SIS systems: not implemented. APMS classes remain independent and manual/CSV input remains supported.
- Email: feedback drafts/history work without delivery; sending requires an approved service and Faculty confirmation.

## Security

The publishable Supabase key is used by the client; no service-role credential is bundled. RLS enforces faculty assignment and academic scope. Authorization is stored in database role assignments, not user-editable metadata. High-value mutations are auditable.
