# Mobile JavaScript reference adapter

`index.mjs` builds the eleven inputs used by `compression.INPUT_NAMES`, calls an injected ONNX Runtime session, and decodes typed forecasts. It has no dependency on React Native, so it can be checked under Node and then used from a mobile app. The bundle sidecar must contain `model_config`, `fields`, `preprocessing`, and the stable `schema_symbols` map exported by the Python CLI. Supply the same unmodified metadata alongside the matching ONNX artifact.

```js
import * as ort from 'onnxruntime-react-native';
import { predictExample } from './index.mjs';

const session = await ort.InferenceSession.create(modelUri);
const forecasts = await predictExample({
  ort, session, metadata, example,
  // Call the app's existing grading/evaluation schema validators here.
  validateSchemas: async schema => validateAppliedSchemas(schema),
});
```

Fields have the same shape as Python `FieldSpec`: `{name, kind, categories?, minimum?, maximum?}`. `example` carries `history`, `queries`, and optional `schema: {gradingSystem, evaluationCriteria}`. The adapter rejects invalid typed values, nonfinite numbers, unknown categories/references, and requests over model limits. Schema AST validation that depends on the APMS domain's full JSON Schema and semantic rules should be performed by the supplied `validateSchemas` callback.

Legacy artifacts omit `assessment_context_version` (or declare version `0`) and keep the original eight query features. Version `1` artifacts must include matching top-level and `model_config.assessment_context_version`, the exact ordered `assessment_context_feature_names`, `assessment_context_normalization_version`, and `assessment_result_cutoff` from their metadata sidecar. Their query feature tensor has width 42: the unchanged base eight followed by the 34 assessment-context values. The adapter rejects version, feature-order, normalization, or cutoff mismatches rather than guessing which encoder produced the artifact.

For a version 1 assessment-bound query, include an `assessment_ref`, the validated full `assessment_instances` inventory, the matching grading snapshot, and that student's raw `assessment_results`. Instance records use opaque local join refs and the same fields as the Python contract: `assessment_ref`, `assessment_type_ref`, `sequence`, `maximum_score`, `scoring`, plus optional period/group refs, weight, optional/has-result flags, and relative/due-day offsets. Result records are `{assessment_ref, value, observed_day?}`. A null `observed_day` marks a known score whose observation time cannot be ordered; it suppresses forecasting that instance but is excluded from prior-score summaries. Missing due/relative dates produce zero value plus a zero presence flag. Scoring mappings, count scope, schema refs, cutoff, and output query bounds are checked before building tensors.

The 34 context values are ordinal/schema descriptors and bounded summary statistics only. Opaque assessment refs join instances, results, and queries locally; they are never written into an input tensor. Date strings, assessment titles, student names, and category labels are not embedded. Sequence ties remain ties, so permuting equal-date rows cannot invent a time order. A version 0 model may receive ordinary non-assessment queries as before; it does not learn these assessment-specific features.

Schema tokens use only stable structural symbols from `metadata.schema_symbols`, local entity ordinals, numeric descriptors, and category ordinals. Field/category IDs are local to the supplied contract. Natural names, descriptions, category strings, and opaque identifiers are never encoded as token text. History order follows the caller's record order and manifest field order; queries remain in caller order, and each query carries its own horizon and bounds.

The input tensors are `float32`, `int64` (`BigInt64Array`), and `bool` (`Uint8Array`) with a batch size of one. The adapter does not truncate history or queries. `numeric_bounds` are in the model's normalized target space. Decoded numeric values are transformed back to raw units and checked against active bounds. Categorical, boolean, and explicit choice queries are selected only among legal choices. Calibrated intervals appear only when a matching `calibration.by_query` entry identifies that field and horizon; an interval radius from another field or horizon is never reused. Failure logits use the matching query temperature when present.

The output is advisory. The app must continue to use its normal grading and risk engines as authoritative, and must present forecasts for educator review. Keep student records and model inputs out of logs.

No React Native app build, iOS/Android accelerator, physical-device parity, latency, battery, or memory checks are claimed here. Validate the bundled runtime and model on each target device before deployment; CPU ONNX Runtime is the portable baseline.

For Python/JavaScript tensor conformance, pipe a JSON object containing `example` and `metadata` into `node conformance.mjs prepare`. The helper prints every input tensor name, type, shape, and data (int64 values are decimal strings so JSON stays lossless). For decoder checks, use `node conformance.mjs decode` and also supply `outputs` as four plain nested arrays named `quantiles`, `categorical`, `trend`, and `failure`, with the batch dimension omitted. Factor references must first be resolved by the application domain layer. An assessment-bound query is supported by version 1 metadata when its validated instance and result context are supplied in the Example.

`node services/ai/mobile/test.mjs` compares its mixed-scoring v1 context vectors against the Python-produced `assessment-context-v1.expected.json` fixture, including the Float32 rounding used by `_prepare`. Regenerate that expected vector after intentional Python contract changes with `tmp\ai-env.cmd .venv\Scripts\python.exe services\ai\mobile\update_context_expected.py > services\ai\mobile\assessment-context-v1.expected.json`.
