from apms_ai.contracts import Example, FieldSpec
from apms_ai.lifecycle import load_bundle
from apms_ai.training import train


def test_v0_keeps_the_historical_first_query_default_even_if_categorical(tmp_path):
    examples = []
    for index in range(16):
        score = float(35 + index * 3)
        choice = "high" if score >= 60 else "low"
        examples.append(
            Example(
                history=[{"score": score - 2}],
                queries=[{"field": "choice"}, {"field": "score"}],
                fields=[
                    FieldSpec("choice", "category", ("low", "high")),
                    FieldSpec("score", "float", minimum=0, maximum=100),
                ],
                labels=[{"choice": choice}, {"score": score}],
                group=f"legacy-group-{index}",
                origin="synthetic",
            )
        )
    bundle = tmp_path / "legacy-order"
    train(
        examples,
        bundle,
        seed=5,
        epochs=1,
        batch_size=4,
        width=16,
        patience=1,
    )
    _, metadata = load_bundle(bundle)
    assert metadata["model_config"]["assessment_context_version"] == 0
    assert metadata["target_field"] == "choice"

