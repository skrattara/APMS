"""Independent calibration and split-integrity checks."""

import hashlib

import pytest
from apms_ai.data import group_split
from apms_ai.evaluation import (
    binary_metrics,
    conformal_radius,
    dataset_fingerprint,
    select_partition,
    temperature_scale,
)
from apms_ai.synthetic import generate


def test_conformal_finite_sample_requirement_and_invalid_intervals():
    with pytest.raises(ValueError, match="too small"):
        conformal_radius([0.0] * 8, [-1.0] * 8, [1.0] * 8, 0.9)
    assert conformal_radius([0.0] * 9, [-1.0] * 9, [1.0] * 9, 0.9) == 0
    with pytest.raises(ValueError, match="finite"):
        conformal_radius([float("nan")], [-1.0], [1.0], 0.5)
    with pytest.raises(ValueError, match="ordered"):
        conformal_radius([0.0], [1.0], [-1.0], 0.5)


def test_binary_temperature_fit_and_tied_probability_metrics():
    torch = pytest.importorskip("torch")
    x = torch.tensor([-10.0, -5.0, 1.0, 2.0])
    y = torch.tensor([0.0, 1.0, 0.0, 1.0])
    temperature = temperature_scale(x, y)
    assert temperature > 0
    assert torch.nn.functional.binary_cross_entropy_with_logits(
        x / temperature, y
    ) <= torch.nn.functional.binary_cross_entropy_with_logits(x, y)
    metrics = binary_metrics([0, 1, 0, 1], [0.5] * 4)
    assert metrics["auroc"] == 0.5 and metrics["average_precision"] == 0.5
    assert binary_metrics([1, 1], [0.8, 0.9])["auroc"] is None


def test_heldout_roles_cannot_be_repartitioned_or_overlap_external_data():
    data = generate(40, 18)
    parts = group_split(data, 18)
    metadata = {
        "training": {
            "seed": 18,
            "data_fingerprint": dataset_fingerprint(data),
            "split_group_hashes": {
                role: [hashlib.sha256(str(x.group).encode()).hexdigest() for x in rows]
                for role, rows in parts.items()
            },
        }
    }
    assert select_partition(data, metadata, "test") == parts["test"]
    with pytest.raises(ValueError, match="Dataset differs"):
        select_partition(data[:-1], metadata, "test")
    with pytest.raises(ValueError, match="overlaps"):
        select_partition([data[0]], metadata, "test", external=True)
    external = generate(5, 99)
    for item in external:
        item.group = "external-" + item.group
        item.origin = "real"
    assert select_partition(external, metadata, "test", external=True) == external
