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

Schema tokens use only stable structural symbols from `metadata.schema_symbols`, local entity ordinals, numeric descriptors, and category ordinals. Field/category IDs are local to the supplied contract. Natural names, descriptions, category strings, and opaque identifiers are never encoded as token text. History order follows the caller's record order and manifest field order; queries remain in caller order, and each query carries its own horizon and bounds.

The input tensors are `float32`, `int64` (`BigInt64Array`), and `bool` (`Uint8Array`) with a batch size of one. The adapter does not truncate history or queries. `numeric_bounds` are in the model's normalized target space. Decoded numeric values are transformed back to raw units and checked against active bounds. Categorical, boolean, and explicit choice queries are selected only among legal choices. Calibrated intervals appear only when a matching `calibration.by_query` entry identifies that field and horizon; an interval radius from another field or horizon is never reused. Failure logits use the matching query temperature when present.

The output is advisory. The app must continue to use its normal grading and risk engines as authoritative, and must present forecasts for educator review. Keep student records and model inputs out of logs.

No React Native app build, iOS/Android accelerator, physical-device parity, latency, battery, or memory checks are claimed here. Validate the bundled runtime and model on each target device before deployment; CPU ONNX Runtime is the portable baseline.

For Python/JavaScript tensor conformance, pipe a JSON object containing `example` and `metadata` into `node conformance.mjs prepare`. The helper prints every input tensor name, type, shape, and data (int64 values are decimal strings so JSON stays lossless). For decoder checks, use `node conformance.mjs decode` and also supply `outputs` as four plain nested arrays named `quantiles`, `categorical`, `trend`, and `failure`, with the batch dimension omitted. Assessment and factor reference queries must first be resolved into typed, bounded queries by the application domain layer; the adapter rejects unresolved references.
