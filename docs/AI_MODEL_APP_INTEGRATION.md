# AI forecasts in the APMS app

The new custom-service assessment previews require a trained **assessment context version one** artifact. In System Admin **Check connection**, confirm **Assessment-specific forecast support** is Yes (`assessment_instance_conditioning: true`). A ready legacy model can still forecast standing/risk, but the updated gateway rejects assessment-preview requests against it before charging usage. See the [assessment upgrade and Docker rollout](AI_ASSESSMENT_CONTEXT_UPGRADE.md).

## Run a first prediction from the app

Use an authorized Faculty account and a small test class containing demo records. A complete numeric standing can be forecast when **Current standing** is an allowed AI input. Early forecasts for students whose final grade is still incomplete require **Recent scores** to be enabled and at least one saved, schema-mapped score. The current synthetic-only model is for demonstration. The run action covers all eligible students in the selected class, regardless of table/search filters, so use an actually small class for this check.

1. Open **Grading Criteria → My evaluation criteria** in the Faculty portal. Choose the test class. Use **Make a copy** for department criteria, **Edit** for your private criteria, or **Create evaluation criteria** when starting from the defaults.
2. Under **AI forecasts and evaluation factors**, set **AI provider for applied criteria** to **APMS forecasting service (custom)**. Ensure AI is enabled (the button reads **Disable AI** when enabled). Keep the default required standing/trend outputs and allowed numeric inputs for the first run; leave optional model-name/version overrides blank. Select only the test class under **Apply to your classes**, then choose **Save and apply to 1 selected classes**. This changes that private applied evaluation definition, not the department library.
3. Open **AI Prediction**, select the same class, and choose **Run AI predictions** once. Wait for the confirmation showing how many eligible students were saved. If the request fails or times out, check saved results before repeating it; an interrupted response may have followed a successful save.
4. Review the table's requested prediction values, **AI risk probability**, **Generated**, and **AI model / version**. Select a student to review the saved advisory forecast and source indicators. The displayed model/version should correspond to the successfully probed custom worker; a changed generated time identifies this run.
5. Leave the page and return, or reload the app and reselect that class. Verify the saved forecast values and generated timestamp remain without running another prediction. This confirms persistence as well as rendering.

To check assessment previews too, edit/apply the same private criteria and enable **Assessment score predictions** under **Allowed AI outputs**. This also selects the required assessment-result and instance-detail inputs. The class needs valid assessment instances with some results still unrecorded, and System Admin assessment sharing must be enabled. Open **Gradebook → Full View**, select the class, then enable **AI score preview** to inspect existing saved forecasts. If a new run is needed, choose **Refresh AI predictions**; a successful run enables the preview automatically when assessment forecasts are configured. Supported unscored cells display an `AI ·` preview; existing recorded scores stay intact. Merely enabling the preview displays saved forecasts and does not run the model.

Both **At-Risk Students** and **AI Prediction** include a **Grade columns** selector. **Summary** is the default and keeps grading periods, current standing, risk, and forecast fields together. Choose **Recorded details** to view grading components, groups, and individual saved assessment scores. These tables scroll horizontally to reach columns beyond the visible screen width. At-Risk Students starts with **Requires Attention** selected; choose **View all students** (or set Risk to **All students**) to include every student in that class.

After a successful run, open **At-Risk Students** for that class to review criteria-based severity alongside available AI risk probability. The current criteria may intentionally keep a student's risk level unchanged. A successful forecast is not a requirement that more students become at risk.

If the run buttons or provider choice are missing, update/rebuild the app frontend from the current source; deploying the model worker alone does not update app screens. If the app reports no eligible students, check the **applied** criteria's allowed AI inputs. A current-standing-only setup requires a calculable final grade; for an early forecast, enable **Recent scores** and ensure saved scores map under the active grading system. Enabling **Assessment results** by itself does not currently provide numeric history to the forecasting runtime. Provider/AI-disabled messages require checking the **applied** criteria for this class, not only the central connection check. Monthly custom-service quota must permit a run. Capture the exact displayed error if the request reaches the gateway but fails.

Forecast preparation and schema checks happen before the `apms-predictions` network call. If there is no such request in the browser's Network view, check the selected class's saved scores/current standing and local grading/evaluation validation before changing cloud credentials. The forecast screen now uses fixed, safe messages for no eligible students, invalid grading/evaluation schemas and known HTTP status categories; production mode no longer hides these known local reasons behind a generic confirmation error. Unexpected errors and raw response bodies remain hidden. Rebuild/redeploy the frontend to receive this change; rebuilding the model container does not update it. This message improvement does not remove eligibility checks, relax schema constraints, or prove that a forecast was generated.

## Saved forecast behavior

### HTTP 200 followed by a local confirmation error

A successful gateway response includes a saved `run_id`. The frontend still checks the response before displaying it, so an HTTP 200 can be followed by a local validation error even when persistence succeeded. Check saved results before generating another forecast.

The 2026-10-19 frontend fix separates model-owned evaluation factors from locally derived availability and age values. Previously, the app passed `prediction_available` and `prediction_age_hours` into a validator restricted to AI-owned factors, rejecting otherwise valid responses after saving. The validator remains strict about active factor IDs, ownership, types, ranges and assessment domains. An empty `evaluation_scores` object is valid when no extra evaluation factors are returned; standing, risk and assessment predictions have their own fields.

For the reported successful run, read-only verification confirmed 10 saved prediction rows containing 620 assessment forecasts. Offline replay through the app service accepted all ten response records after the fix. Their standing and assessment values passed the current schema-domain checks; this checks contract validity, not predictive accuracy.

Reload the updated local app, reselect the class, and open **Gradebook → Full View → AI score preview** to inspect those saved forecasts without another inference request. On a later acknowledged saved run whose response cannot be validated, the app now reports that distinction and reloads saved workspace data without automatically retrying. Opening the page still does not start inference, and the preview starts off on a fresh screen. This repair requires the updated frontend only; it does not require rebuilding Docker images, retraining, or redeploying Supabase functions.

### Saved assessment forecasts remain invisible in Full View

The 2026-10-20 display repair aligns forecast overlays with the Gradebook's assessment column IDs. Stored forecasts correctly identify an instance by its assessment UUID, but Full View uses `assessment:<UUID>` for its column key. The previous host adapter supplied the bare UUID, so no preview matched a rendered column even when **AI score preview** was enabled. The adapter and column builder now share the same key function; persisted assessment IDs and score storage keys keep their existing format.

Read-only verification for the reported class confirmed 250 latest student forecasts containing 15,500 assessment forecasts. The attached ten-student response contained 620 assessment forecasts whose values passed the current grading domains. A successful save and valid domains therefore did not establish that the UI had rendered the previews.

Verification: all 106 unit tests and the complete web build passed. Offline replay through the actual column builder and host adapter matched all 620 sample previews after the repair, compared with zero before it. The authenticated browser check could not reach the Gradebook using the saved test session, so on-screen rendering in that session remains unverified. No new inference was requested.

Reload the updated frontend, reselect the class, open **Gradebook → Full View**, and enable **AI score preview** if the button does not already say **Hide AI score preview**. Existing forecasts can then display without generating a new run. This is another frontend-only repair: Docker, the trained model and Supabase functions need no update. Recorded scores still take precedence, and stale outputs outside current domains remain hidden.

### Clipped previews and repeated assessment values

Active value previews now contribute to assessment column width instead of using only recorded/draft score lengths. The preview label can wrap to two lines; hiding previews restores ordinary score widths. This is a display change and does not change stored model outputs or official grades. Reload the updated frontend to receive it.

Repeated values in the original artifact reflect a legacy conditioning limitation: its assessment queries could have identical field/horizon/domain descriptors, so the model received no instance-specific distinction. Small integer/category domains can cause further ties. The new context-version-one model represents schema scope, sequence and preceding observations, with a shared training/serving compiler and a newly trained context projection. Equivalent evidence can still produce equal values; variation alone is not an accuracy measure. See the [legacy explanation](AI_MODEL_ARCHITECTURE.md#legacy-assessment-adapter-and-context-version-one-upgrade) and [new design and rollout](AI_ASSESSMENT_CONTEXT_UPGRADE.md). A frontend refresh alone does not update weights or rewrite saved predictions.

AI forecasts are saved advisory records. Faculty trigger them from the AI predictions page, At-Risk page, or Gradebook Full View; opening a screen or changing a filter never starts inference. The refresh action covers the selected class roster, regardless of visible table filters. The app sends only eligible student records through the authenticated `apms-predictions` gateway, which checks the active grading and evaluation schemas before saving.

Before sending a class forecast, the app plans all batches using the UTF-8 byte length of each complete JSON request, including both schema snapshots. Batches stay within 900,000 bytes, below the gateway's 1,000,000-byte limit. Every provider uses a working cap of 10 students and may use fewer to fit the byte limit. The gateway's 100-student hard ceiling is not the recommended batch size: the custom connector sends individual student requests sequentially under a shared 45-second budget. Smaller batches reduce per-invocation work; they do not prove that a particular CPU or memory limit has been resolved. No records or history are silently dropped. If one record plus the schemas cannot fit, preparation stops before the first request. Each batch is a separate saved run. If a request is interrupted, later batches are not sent; the app reports the confirmed count and tells the user to check saved predictions before retrying because an interrupted request may have reached the service. More batches can consume more provider requests; existing monthly usage limits still apply.

Saved forecasts appear separately from recorded results. A forecast can exist while the final grade is incomplete; its `current_standing`, point grade, and letter grade remain null. This does not fill or change an official grade. Gradebook previews are read-only, include only unscored assessment instances, and are hidden if the current grading rules no longer allow the saved score or category. A recorded score—including zero—always takes precedence. Forecast predictions do not write, replace, or apply penalties to official SIS grades.

**Predicted standing** is a forecast-level value from the applied AI output contract. The At-Risk and AI Prediction pages show its column when **predicted_standing** is enabled; until a forecast has been saved for a student, the cell remains unavailable. Individual assessment-score previews are a separate feature: the applied criteria must enable **Assessment score predictions**, a forecast containing those saved outputs must exist, System Admin assessment sharing must be enabled, and the target Gradebook cell must be unscored. After enabling that output, select **Gradebook → Full View → AI score preview** to reveal those read-only cell previews. The Grade columns selector displays recorded scores; it does not itself request or create forecasts.

At-Risk severity remains the result of the applied evaluation criteria. A configured rule may explicitly use a validated AI factor; in that case the criteria engine evaluates it like its other configured factors. The app does not replace criteria with the model's own risk label. The displayed AI risk probability estimates an adverse outcome and is not model confidence. Confidence thresholds disable model factors when independent confidence is missing or outside the configured range; ordinary academic factors remain available under the continue-with-available-rules policy.

The saved criteria-based risk snapshot is never reused as the model's risk category. Model-owned factors are saved and validated under their original factor IDs against the current schema. Component/group factors retain their own aggregation keys, so an AI factor cannot overwrite a different manually supplied factor merely because both use the same source type.

Forecast timestamps, provider, model name, and model version are displayed when saved. A recent timestamp is only a time signal: records or grading rules may have changed since the forecast was generated, so educators should review it before use. Older predictions remain visible for context and are not presented as current.
## Early forecasts with a partial assessment inventory

Assessment score previews can run before every minimum-count requirement in the grading design has been met. The gateway still validates the active grading domains, assessment references, uniqueness, required weights, maximum counts, and each preview; it skips only minimum-count checks when the class inventory is incomplete. Existing recorded scores are never replaced.

If the configured custom model runtime does not advertise partial-inventory support, the gateway rejects the request before reserving usage or sending inference. Turn off **Assessment score predictions** to run standing and risk forecasts from **Recent scores** while assessment instances are still being added. The runtime capability is available only after updating the model service image and deploying the current `apms-predictions` gateway; reload the frontend after its UI changes. No retraining, schema edits, or fabricated future assessment rows are needed.

### Historical partial-inventory runtime update

The commands below document the earlier validation-only change. They do **not** enable the new assessment-specific context capability with `release-20261017`. For current assessment previews, follow the [new artifact and runtime rollout](AI_ASSESSMENT_CONTEXT_UPGRADE.md#rollout-to-the-docker-computer); the new gateway requires both capabilities.

Copy the updated project source to the Docker computer first. Rebuild the runtime as well as the image that contains the model: rebuilding only `Dockerfile.model` on top of an old runtime keeps the old validation code. The existing approved `release-20261017` model bundle can be reused. From the project root in **cmd**:

```bat
docker build --platform linux/amd64 -f services/ai/Dockerfile -t apms-ai:cpu-20261018 .
docker build --platform linux/amd64 -f services/ai/deploy/Dockerfile.model --build-arg RUNTIME_IMAGE=apms-ai:cpu-20261018 -t apms-ai-model:20261018-partial services/ai/artifacts/release-20261017
cd services\ai\deploy\cloudflare
node_modules\.bin\wrangler.cmd containers push apms-ai-model:20261018-partial
```

Set `containers[0].image` in this computer's `wrangler.jsonc` to the fully qualified image reference printed by the push command, then deploy:

```bat
node_modules\.bin\wrangler.cmd deploy
```

Retain the existing server token and artifact settings. This update changes runtime validation, not the trained weights; the model version can stay the same. For ECS or Docker behind a Cloudflare Tunnel, rebuild the runtime in the same way and roll out the new image using the [deployment guide](AI_MODEL_CLOUD_DEPLOYMENT.md).

The matching gateway and status function also need the updated source. From the project root on a computer with the authorized Supabase CLI session:

```bat
node_modules\.bin\supabase.cmd functions deploy apms-predictions ai-service-status --project-ref YOUR_PROJECT_REF --use-api
```

Keep JWT verification enabled. Reload the local frontend, then use the System Admin service probe to check `probe.capabilities.partial_assessment_inventory` is `true` before requesting assessment previews. A missing or false flag identifies an older runtime; a `ready: true` response alone does not establish support. The app also recognizes fixed error codes from the exposed `X-APMS-Error-Code` response header when the browser cannot show the response body.

## Diagnose a long request with an empty error response

Check the provider in the **applied** evaluation criteria first. A Gemini or OpenAI request goes from Supabase to that provider, so it does not produce a request in the custom Cloudflare model container's logs. The configured custom service can still be healthy while a different provider fails.

The gateway rejects requests above 1,000,000 bytes with HTTP 413. A reported 100-student Gemini request inspected on 2026-10-18 was 2,290,620 bytes; count-only batching had exceeded that limit. Local verification of the byte-aware planner split the same attached request into 10 ordered batches, with the largest 241,434 bytes, without sending student data to a provider. The prior handler returned 413 for a synthetic body of that size. Therefore, the size defect is confirmed, but it does not establish the source of a separately reported delayed HTTP 503.

Updated handler responses expose `X-APMS-Request-ID` and `X-APMS-Error-Code`. Supabase's `apms_prediction_stage` and `apms_prediction_request` log events contain only operational metadata such as request ID, processing stage, elapsed time, status, provider and record count. They do not contain student/class identifiers, payloads, credentials or raw exception messages. The handler has a 90-second overall deadline, and Gemini/OpenAI calls have a 60-second timeout that includes consuming the response body. The app's request timeout is 110 seconds, allowing a margin for the gateway to return its controlled failure; an abort remains an unconfirmed result and is never retried automatically. Platform errors before the handler starts or after it is terminated can still omit application headers and bodies; application instrumentation cannot guarantee a response from a stopped platform worker.

For a failed request:

1. In browser Network, record the Request URL, failure time/timezone, HTTP status, `X-APMS-Request-ID`, `X-APMS-Error-Code`, `sb-request-id`, `sb-error-code` and `cf-ray` when present. Do not copy Authorization, API keys, cookies or student records.
2. In the matching Supabase project, open **Edge Functions → apms-predictions → Invocations** for the HTTP request. Use **Logs** for custom stage messages, exceptions and platform boot/shutdown events. Check the time range and filters. These are distinct views; no custom log message does not prove that no invocation reached Supabase.
3. Match the application request ID to its stage logs. A gateway-generated `provider_timeout` differs from a platform `BOOT_ERROR` or another upstream failure. Duration alone cannot identify the cause. In Chrome's Timing view, **Initial connection** covers connection establishment, including TCP retries and TLS negotiation; it is not model execution time. **Waiting for server response** measures a different phase. Supabase documents a 150-second request idle limit, normally returned as HTTP 504; do not label every delayed HTTP 503 as a timeout.
4. Check saved forecasts before retrying. Do not automatically retry a timed-out provider request; processing or persistence may have completed after the response was lost.

References: [Supabase function logging](https://supabase.com/docs/guides/functions/logging), [status codes](https://supabase.com/docs/guides/functions/status-codes), [runtime limits](https://supabase.com/docs/guides/functions/limits), and [Chrome request timing phases](https://developer.chrome.com/docs/devtools/network/reference/#timing-explanation).

The batching change requires updating/reloading the local frontend. The timeout and trace changes require deploying the updated `apms-predictions` function. A Docker or Cloudflare container rebuild is not required for this Gemini-request repair; the separate model-runtime update remains necessary for custom-service partial assessment previews.

## Distinguish custom-provider errors from Edge resource limits

HTTP 546 with `sb-error-code: WORKER_RESOURCE_LIMIT` means the Supabase Edge Function was stopped for a platform resource limit. Consult its platform shutdown/error log to distinguish CPU from memory. Supabase currently documents a 2-second CPU budget and 256 MB memory limit. These are separate from network timeout budgets; making an HTTP timeout longer does not increase either resource limit. A ready custom container does not establish that the Edge gateway stayed within its limits or that a specific inference request succeeded.

A handled HTTP 502 has a different meaning. The custom connector now returns a fixed diagnostic code, plus numeric `upstream_status` when the provider sent an HTTP response. Logs add `phase: status|prediction`, `error_code` and the numeric status to the request trace. No upstream response body, URL, credential, student record or raw exception text is logged or returned.

| Response code | Interpretation and next check |
| --- | --- |
| `provider_authentication_failed`, upstream 401/403 | Compare the configured server token and, if used, Cloudflare Access credentials; keep keys out of browser code. |
| `provider_request_rejected`, upstream 422 | The service rejected its request contract. Review the matching container validation event and runtime/schema compatibility; do not change grading rules to bypass validation. |
| `provider_busy`, upstream 429 | Inference capacity rejected the call. Check concurrent workloads and saved runs before another attempt; the app does not retry automatically. |
| `provider_unavailable`, upstream 5xx | The service returned a server error. Match the request time to container logs. |
| `provider_connection_failed`, no upstream status | The connector failed before receiving an HTTP response. Check reachability/TLS/routing; this code does not establish which network component failed. |
| `provider_timeout` | A bounded fetch or response-body read expired. An HTTP 200 header followed by an incomplete body is also a timeout. |
| `invalid_response` | The response was malformed, oversized, or did not match the probed artifact/contract. Keep provenance checks enabled. |

The earlier generic `provider_unavailable` response combined several of these cases and cannot retrospectively identify the upstream status. Check connection status, prediction results, and Edge resource errors separately. The app's conservative 10-record batches are a mitigation, not evidence that the reported 546's specific cause has been identified.

A categorical assessment HTTP 422 was subsequently reproduced with the current applied policy and 80-instance inventory: the older runtime compared anonymous category values against names saved during training. Install the [categorical runtime update](AI_CATEGORY_RUNTIME_UPDATE.md) to bind schema-derived categories locally without changing the trained artifact. Its runbook includes the source transfer package and exact Docker/Cloudflare commands. A ready probe or unchanged model version does not establish that this runtime fix has been deployed.
