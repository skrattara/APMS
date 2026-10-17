from dataclasses import replace

from apms_ai.contracts import Example, FieldSpec
from apms_ai.data import RobustPreprocessor


def _target_example(name, value, *, history=None, kind="float", choices=None):
    query = {"field": name, "horizon": 1}
    if choices is not None:
        query["choices"] = choices
    spec = FieldSpec(
        name,
        kind,
        minimum=0 if kind in {"float", "integer"} else None,
        maximum=100 if kind in {"float", "integer"} else None,
    )
    return Example(history or [], [query], [spec], [{name: value}], origin="synthetic")


def test_target_only_numeric_field_uses_train_label_median_and_iqr():
    examples = [
        _target_example("next_score", value) for value in (10.0, 20.0, 30.0, 40.0)
    ]
    stats = RobustPreprocessor().fit(examples).stats
    assert stats["next_score"] == (25.0, 20.0)


def test_target_only_scale_does_not_cross_contaminate_observed_fields():
    examples = []
    for index, value in enumerate((10.0, 20.0, 30.0, 40.0)):
        examples.append(
            Example(
                history=[{"current_score": float(index + 1)}],
                queries=[{"field": "next_score", "horizon": 1}],
                fields=[
                    FieldSpec("current_score", "float"),
                    FieldSpec("next_score", "float"),
                ],
                labels=[{"next_score": value}],
            )
        )
    stats = RobustPreprocessor().fit(examples).stats
    assert stats["current_score"] == (2.5, 2.0)
    assert stats["next_score"] == (25.0, 20.0)


def test_observed_history_statistics_are_unchanged_by_large_target_labels():
    history = [{"score": float(value)} for value in (10, 20, 30, 40)]
    spec = FieldSpec("score", "float")
    without_label = Example(
        history, [{"field": "score", "horizon": 1}], [spec], [{} for _ in range(1)]
    )
    with_large_label = replace(without_label, labels=[{"score": 10000.0}])
    baseline = RobustPreprocessor().fit([without_label]).stats
    fitted = RobustPreprocessor().fit([with_large_label]).stats
    assert fitted["score"] == baseline["score"] == (25.0, 20.0)


def test_boolean_and_mapped_numeric_targets_do_not_fit_continuous_stats():
    examples = [
        Example(
            [],
            [{"field": "passed", "horizon": 1}],
            [FieldSpec("passed", "boolean")],
            [{"passed": True}],
        ),
        Example(
            [],
            [{"field": "mapped", "horizon": 1, "choices": [0, 1, 2]}],
            [FieldSpec("mapped", "integer", minimum=0, maximum=2)],
            [{"mapped": 2}],
        ),
    ]
    assert RobustPreprocessor().fit(examples).stats == {}


def test_fit_consumes_one_pass_iterable_only_once():
    class OnePass:
        def __init__(self, values):
            self.values = values
            self.iterations = 0

        def __iter__(self):
            self.iterations += 1
            if self.iterations > 1:
                raise AssertionError("training examples iterable was consumed twice")
            return iter(self.values)

    rows = OnePass(
        [_target_example("next_score", 12.0), _target_example("next_score", 18.0)]
    )
    assert RobustPreprocessor().fit(rows).stats["next_score"] == (15.0, 6.0)
    assert rows.iterations == 1
