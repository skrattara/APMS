# AI provider integration guide

This guide describes the provider boundary and the privacy controls used by the current AI endpoints. Future AI tasks must use the same boundary.

## Existing integration points

- `apps/mobile/src/services/faculty.ts` builds student context, calls `runAiPredictions`, validates provider output against the domain schemas, and applies the evaluation criteria deterministically.
- `supabase/functions/apms-predictions` authenticates the caller, checks prediction permission and class/enrollment scope, resolves the active class definitions from the database, applies privacy settings, validates output, and saves the advisory run under the signed-in Faculty session.
- `supabase/functions/apms-feedback-draft` applies the same checks and sends only anonymous numeric evidence and a sanitized schema projection to Gemini.
- `packages/domain/src/evaluation/engine.ts` evaluates configured factors and rules. Model output should supply eligible AI factor values; this engine should continue assigning the configured risk level.
- `model_versions`, `prediction_runs`, and `performance_predictions` preserve the provider, model/version, active schema snapshots, advisory status, validated evaluation-factor values, and any configured assessment-instance predictions.
- `packages/domain/src/ai/validation.ts` contains strict validators for standing, evaluation-factor, and assessment-instance outputs. The mobile service validates the response again before it is returned to the UI.

All provider calls must stay on the server. The custom prediction URL and its key are read only from Edge Function secrets (`APMS_AI_SERVICE_URL` and `APMS_AI_SERVICE_API_KEY`); Gemini credentials also stay server-side.

## Shared contracts

`packages/domain/src/ai/contracts.ts` defines provider-neutral task names, schema context, opaque record references, output shapes, and provenance metadata. It intentionally defines no adapter, routing configuration reader, or network client.

Use the applied `GradingDefinition` to interpret assessment scores and their hierarchy. Use the applied `EvaluationDefinition` to determine eligible evaluation factors and their units/ranges/categories. The model may return advisory predictions and evidence; deterministic grading and risk classification remain in the domain engines.

Never transmit personal or identifying data to any AI provider: names, email addresses, student IDs, enrollment IDs, class numbers, subject names, academic years, sections, assessment titles/dates, or reusable database/schema identifiers. This is an absolute rule; no AI feature may request an exception. Send only the minimum allowlisted fields. Schema relationships are retained using fresh random references; names and descriptions are removed and categorical values are replaced with per-request tokens. The edge function maps permitted output categories back only after validation. Use fresh, random per-request opaque references for records and schema entities, and keep the mapping inside the authenticated Edge Function. Never reuse a provider-facing reference across requests.

Assessment-derived values and attendance are independently disabled by default. A System Admin must enable their sharing in System Settings; endpoints also require a valid signed-in user, the feature permission, and access to the requested class and enrollment before making a provider request. If AI is globally disabled or required data sharing is disabled, the endpoint fails closed without contacting any provider. Keep these checks and the shared projection helper in `supabase/functions/_shared/aiPrivacy.ts` for every future provider and task.

Apply migrations `20261011090000_ai_provider_privacy_controls.sql`, `20261011103000_ai_model_provider_provenance.sql`, and `20261011110000_ai_prediction_outputs.sql` before deploying the updated Edge Functions. Missing settings fail closed. The custom prediction provider now uses server-side `APMS_AI_SERVICE_URL`, `APMS_AI_SERVICE_API_KEY`, and optional `APMS_AI_SERVICE_MODEL` / `APMS_AI_SERVICE_MODEL_VERSION`; remove the old `EXPO_PUBLIC_APMS_AI_SERVICE_URL` configuration from the mobile app.

## Future implementation sequence

1. Extend the authenticated Edge Function gateway with task-specific request validation and class/enrollment authorization.
2. Add server-only provider adapters for the custom model, OpenAI, and Gemini that all consume the privacy-projected request, never the raw app payload.
3. Configure provider plans per task on the server: single provider, ordered fallback, or parallel execution. Parallel results must retain separate provenance; don't blend them unless an explicit task-specific policy is configured.
4. Validate every provider response against the task contract and the applied grading/evaluation representations before saving or displaying it. Reject out-of-range, unmapped, missing-required, duplicate, or unknown outputs; do not clamp them or silently treat them as a grade or zero. Assessment predictions use request-only assessment references, enforce the instance maximum, scoring mode and mappings, required/optional instances, period/group references, instance weights, and the grading schema's assessment-count constraints.
5. Persist task, provider, model/version, prompt/version, schema snapshots, time, and advisory status. Assessment forecasts are stored as advisory prediction explanation data and never overwrite assessment results.
6. Keep the mobile app provider-agnostic: it submits schema-derived context to the gateway and renders validated task results with their provenance.
7. Add contract conformance tests for every adapter, plus tests for provider timeouts, malformed output, fallback behavior, authorization boundaries, categorical score mappings, and deterministic evaluation-engine integration.

## Important boundaries

- The model must not replace grading-system calculations, remap scores contrary to the applied grading schema, or choose configured evaluation risk levels itself.
- Predicted categorical scores must be values allowed by the assessment type's mapping. Numeric predictions must respect that instance's maximum and scoring representation.
- Predictions remain advisory and must not alter official assessment results automatically.
- Provider selection is server configuration, not a request parameter clients can use to select arbitrary URLs or models.
- If the custom model and an LLM both run, preserve each output independently until an explicit compare, fallback, or task-specific combination rule is defined.
