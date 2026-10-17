"""Independent JavaScript/Python encoder parity with complete applied schemas."""

import json
import shutil
import subprocess
from dataclasses import asdict, replace
from pathlib import Path

import pytest

torch = pytest.importorskip("torch")
np = pytest.importorskip("numpy")
from apms_ai.compression import INPUT_NAMES
from apms_ai.contracts import _schema_symbols
from apms_ai.data import RobustPreprocessor
from apms_ai.synthetic import generate
from apms_ai.training import _prepare


@pytest.mark.skipif(
    shutil.which("node") is None, reason="Node is optional for Python deployments"
)
def test_mobile_reference_compiles_the_same_eleven_tensors():
    examples = generate(4, 42)
    fields = [field.name for field in examples[0].fields]
    config = {
        "categories": 16,
        "max_fields": 512,
        "max_queries": 128,
        "max_history": 512,
    }
    preprocessing = RobustPreprocessor().fit(examples).stats
    metadata = dict(
        fields=fields,
        model_config=config,
        preprocessing=preprocessing,
        schema_symbols=_schema_symbols(),
    )
    helper = Path(__file__).resolve().parents[1] / "mobile" / "conformance.mjs"
    for example in examples:
        example = replace(example, labels=[])
        result = subprocess.run(
            [shutil.which("node"), str(helper), "prepare"],
            input=json.dumps(dict(example=asdict(example), metadata=metadata)),
            capture_output=True,
            text=True,
            check=True,
            timeout=30,
        )
        actual = json.loads(result.stdout)["feed"]
        inputs, _, _ = _prepare(
            [example], fields, {}, preprocessing, "cpu", model_config=config
        )
        assert list(actual) == list(INPUT_NAMES)
        for name, expected in zip(INPUT_NAMES, inputs):
            tensor = actual[name]
            values = np.asarray(tensor["data"], dtype=expected.numpy().dtype).reshape(
                tensor["dims"]
            )
            np.testing.assert_allclose(values, expected.numpy(), atol=1e-6, rtol=1e-6)
