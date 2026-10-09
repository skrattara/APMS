# APMS / SWUNEXT

APMS is an AI-based student performance evaluation and monitoring system for SWUNEXT at Southwestern University PHINMA. It helps Faculty consolidate assessment and attendance records, calculate current/provisional standing, review trends, and identify students who may need attention. Academic Admin receives authorized aggregate oversight; System Admin manages users, security, audit, settings, and system status.

APMS is not SWU SIS, an enrollment system, an LMS, or an official-grade submission tool. SWU SIS remains authoritative for official grades. Manual entry and CSV import are the baseline data paths; no SIS or Google Classroom integration is assumed.

## Architecture

- `apps/mobile`: Expo SDK 57 / React Native / Expo Router application
- `packages/domain`: typed RBAC, validation, standing, attendance, trend, report, and CSV logic
- `supabase`: preserved Supabase configuration, RLS schema, safe migrations, and fictional seed
- `services/ai`: isolated FastAPI service with a controlled-synthetic logistic prototype
- `tests`: Playwright role/access and workflow coverage

Core authenticated roles are exactly `system_admin`, `academic_admin`, and `faculty`. Students are monitored records, not a primary APMS portal role.

## Setup

Requirements: Node.js 22.13+ (Expo SDK 57), npm, Python 3.11+, and Docker Desktop only for local Supabase.

```powershell
npm install
Copy-Item apps/mobile/.env.example apps/mobile/.env.local
npm run dev
```

Client variables are `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, and optional fictional `EXPO_PUBLIC_DEMO_MODE`. Never expose a service-role key or database password through `EXPO_PUBLIC_`. Existing populated variables must not be replaced.

Set `EXPO_PUBLIC_APMS_SHOW_ERROR_DETAILS=true` only while debugging to show technical error details. It defaults to `false`, which shows user-friendly error messages and toasts. This is a client-side setting and must not be used to expose secrets.

## Supabase and migrations

```powershell
npx supabase start
npx supabase db reset
npm run test:schema
npx supabase db lint --local
```

The repository uses imperative migrations. The revised-thesis migration merges former technical admin roles, deactivates Grader access while preserving history, and adds attendance, assessment-source, import-validation, and RLS support. Do not create another Supabase project.

The production portal is Supabase-backed (`EXPO_PUBLIC_DEMO_MODE=false`). Faculty manages assigned monitoring classes, rosters, assessments, attendance, criteria, feedback, and AI-assisted prediction. Academic Admin receives department-scoped aggregates, drill-down, criteria configuration, and reports. System Admin manages users/roles/status through the protected `admin-users` Edge Function and manages settings, audit visibility, and backup requests. Demo mode is an explicit optional validation mode only.

## SWUNEXT grading

The implemented Global Modules grading model uses the revised SWUNEXT weights:

- Effortful Learning is 55%: Start of Class 5%, Let's Practice 35%, Reflection 15%.
- Mastery is 45%: Wrap-Up Quiz 15%, Final Project / Output 30%.
- Start of Class is binary: present is 100%, absent is 0%.
- Let's Practice and Reflection use the 0-3 rubric transmutation: 0 = 0%, 1 = 60%, 2 = 80%, 3 = 100%.
- Wrap-Up Quiz and project scores are recorded as percentages. Project check-ins count 65% and final output counts 35%; if there is only one side available APMS uses the documented 50/50 fallback.
- P1 and P2 are running cumulative views only. Final grade uses `P3 * 0.55 + FE * 0.45`.
- Passing requires both at least 80% final grade and at least 80% mastery. APMS labels this as provisional monitoring, not an official SIS grade.

## AI service

```powershell
python -m pip install -e "services/ai[test]"
python -m uvicorn apms_ai.main:app --app-dir services/ai/src --reload
python -m pytest services/ai
```

The included logistic classifier is trained on controlled synthetic demonstration data at startup. It is advisory, explainable, and not institutionally validated. Production use requires authorized de-identified SWU data and institutional approval. Normal records and deterministic calculations remain usable when AI is unavailable.

## Validation

```powershell
npm run typecheck
npm run lint
npm test
npm run test:schema
npm run build
npm run test:e2e
```

See [system architecture](docs/system-architecture.md), [database schema](docs/database-schema.md), [implementation audit](docs/implementation-audit.md), and [testing](docs/TESTING.md).
