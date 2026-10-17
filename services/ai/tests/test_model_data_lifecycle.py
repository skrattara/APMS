from dataclasses import replace

import pytest
from apms_ai.contracts import Example, FieldSpec
from apms_ai.data import RobustPreprocessor, group_split
from apms_ai.lifecycle import bounded_replay, candidate_passes
from apms_ai.model import constrain_numeric, constrained_choice
from apms_ai.synthetic import generate


def test_group_split_and_seeded_synthetic_families():
    a = generate(80, 7)
    b = generate(80, 7)
    assert a[0].history == b[0].history
    parts = group_split(a, 7)
    owners = {}
    for role, items in parts.items():
        for item in items:
            owners.setdefault(item.group, set()).add(role)
    assert all(len(roles) == 1 for roles in owners.values())
    assert {e.origin for e in a} == {"synthetic"}


def test_train_only_preprocessor_and_missing_mask():
    train = Example([{"score": 10.0}], [], [FieldSpec("score", "float")])
    held = Example([{"score": 1000.0}], [], [FieldSpec("score", "float")])
    p = RobustPreprocessor().fit([train])
    assert p.transform("score", None) == (0.0, 1.0)
    assert p.transform("score", held.history[0]["score"])[0] > 100


def test_feature_ids_follow_manifest_when_record_schema_reorders_fields():
    torch = pytest.importorskip("torch")
    from apms_ai.training import _prepare

    example = generate(4, 19)[0]
    reordered = replace(example, fields=list(reversed(example.fields)))
    manifest = [field.name for field in example.fields]
    vocab = {
        field.name: {value: index + 1 for index, value in enumerate(field.categories)}
        for field in example.fields
        if field.categories
    }
    inputs, _, _ = _prepare(
        [example, reordered], manifest, vocab, {}, torch.device("cpu")
    )
    assert torch.equal(inputs[1][0], inputs[1][1])
    assert torch.equal(inputs[5][0], inputs[5][1])


def test_constraints_and_candidate_replay_gates():
    assert constrained_choice([1, 100, 3], [True, False, True]) == 2
    with pytest.raises(ValueError):
        constrain_numeric(11, maximum=10)
    replay = bounded_replay([1, 2, 3], [4, 5, 6], maximum=10, real_fraction=0.7)
    assert len(replay) == 4
    assert sum(item in {1, 2, 3} for item in replay) / len(replay) >= 0.7
    assert candidate_passes({"loss": 0.5}, {"loss": 0.52}, {"loss": 0.03})
    assert not candidate_passes({"loss": 0.5}, {"loss": 0.52}, {"loss": 0.01})
    assert not candidate_passes({"rmse": 1.0}, {"rmse": None}, {})
    assert not candidate_passes({"rmse": None}, {"rmse": 1.0}, {})
    assert not candidate_passes({"rmse": 1.0}, {"rmse": 1.0}, {"rmse": float("nan")})


def test_exportable_transformer_forward_backward_if_ml_available():
    torch = pytest.importorskip("torch")
    from apms_ai.model import SchemaForecaster

    model = SchemaForecaster(width=32, heads=4, layers=1)
    args = (
        torch.randn(2, 3),
        torch.tensor([[0, 1, 2], [1, 2, 3]]),
        torch.zeros(2, 3, dtype=torch.long),
        torch.randn(2, 2, 16),
        torch.tensor([[False, False, True], [False, False, False]]),
        torch.tensor([[0, 1], [1, 2]]),
        torch.tensor([[False, False], [False, True]]),
    )
    out = model(*args)
    loss = (
        out["quantiles"].sum()
        + out["trend"].sum()
        + out["failure"].sum()
        + out["categorical"].sum()
    )
    loss.backward()
    assert out["quantiles"].shape == (2, 2, 1, 3)
    assert (out["quantiles"][..., 1:] >= out["quantiles"][..., :-1]).all()
