"""Selection must honor frozen rules and recover from a partial report write."""
import copy
import importlib.util
import json
from pathlib import Path

import pytest


@pytest.fixture
def runner():
    path = Path(__file__).resolve().parents[1] / "examples/compare_assessment_context.py"
    spec = importlib.util.spec_from_file_location("assessment_selection_review", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def selection_rules():
    return {
        "primary_metric": "linear_assessment_score_rmse",
        "guard_metrics": ["standing_mae", "standing_rmse", "failure_brier",
                          "ai_risk_level_accuracy", "mapped_score_accuracy_or_mae",
                          "categorical_score_accuracy"],
        "standing_error_tolerance": 1.0,
        "failure_brier_tolerance": 0.02,
        "category_accuracy_tolerance": 0.03,
    }


def standard_report():
    return {
        "score_mae": 4.0, "score_rmse": 5.0, "failure_brier": 0.1,
        "ai_risk_level_accuracy": 0.8,
        "by_query": {
            "risk|1|domain": {"field": "ai_risk_level", "category_accuracy": 0.8, "category_count": 20},
            "mapped|1|domain": {"field": "mapped_score", "category_accuracy": 0.8, "category_count": 20},
            "mapped|2|domain": {"field": "mapped_score", "category_accuracy": 0.8, "category_count": 20},
            "category|1|domain": {"field": "categorical_score", "category_accuracy": 0.8, "category_count": 20},
        },
    }


def test_shipped_profile_all_six_guards_are_supported(runner):
    profile = runner._read(Path(__file__).resolve().parents[1] / "examples/assessment-context-comparison.json")
    runner._validate_selection_rules(profile["selection"])
    result, details = runner._declared_guards_pass(
        standard_report(), standard_report(), selection_rules()["guard_metrics"], selection_rules(),
    )
    assert result
    assert set(details) == set(selection_rules()["guard_metrics"])


@pytest.mark.parametrize("field,key,guard", [
    ("mapped_score", "mapped|2|domain", "mapped_score_accuracy_or_mae"),
    ("categorical_score", "category|1|domain", "categorical_score_accuracy"),
])
def test_category_guards_check_each_horizon_domain_and_label_count(runner, field, key, guard):
    old = standard_report()
    new = copy.deepcopy(old)
    new["by_query"][key]["category_accuracy"] = 0.77
    assert runner._declared_guards_pass(old, new, [guard], selection_rules())[0]
    new["by_query"][key]["category_accuracy"] = 0.76
    passed, details = runner._declared_guards_pass(old, new, [guard], selection_rules())
    assert not passed
    assert not details[guard]["by_query"][key]["passed"]
    new = copy.deepcopy(old)
    new["by_query"][key]["category_count"] = 19
    assert not runner._declared_guards_pass(old, new, [guard], selection_rules())[0]
    del new["by_query"][key]
    assert not runner._declared_guards_pass(old, new, [guard], selection_rules())[0]


def test_mapped_score_uses_mae_only_when_both_reports_are_numeric(runner):
    old = {"by_query": {"mapped|1|domain": {
        "field": "mapped_score", "numeric_count": 20, "regression": {"mae": 0.5},
    }}}
    new = copy.deepcopy(old)
    new["by_query"]["mapped|1|domain"]["regression"]["mae"] = 1.5
    guards = ["mapped_score_accuracy_or_mae"]
    assert runner._declared_guards_pass(old, new, guards, selection_rules())[0]
    new["by_query"]["mapped|1|domain"]["regression"]["mae"] = 1.51
    assert not runner._declared_guards_pass(old, new, guards, selection_rules())[0]
    new["by_query"]["mapped|1|domain"].update(category_accuracy=0.9, category_count=20)
    assert not runner._declared_guards_pass(old, new, guards, selection_rules())[0]
    assert not runner._declared_guards_pass(old, {}, guards, selection_rules())[0]


def setup_experiment(runner, folder):
    runner._write_new(folder / "protocol.json", {"selection": selection_rules()})
    for name, error in (("context_control", 2.0), ("assessment_context_v1", 1.0)):
        runner._write_new(folder / f"{name}-validation-assessment.json", {
            "model_config": {"assessment_context_version": int(name.endswith("v1"))},
            "linear_percentage_point_metrics": {"count": 20, "rmse": error},
        })
        runner._write_new(folder / f"{name}-validation.json", standard_report())


def test_select_reuses_old_partial_reports_and_is_idempotent(runner, tmp_path, monkeypatch):
    setup_experiment(runner, tmp_path)
    cached = runner._read(tmp_path / "context_control-validation-assessment.json")
    cached["baselines"] = {"retained_original_baseline": {"rmse": 3.0}}
    cache_path = tmp_path / "context_control-validation-assessment-reviewed.json"
    runner._write_new(cache_path, cached)
    original = cache_path.read_bytes()
    calls = []
    def baseline(*args):
        calls.append(args[3].name)
        return {"computed_once": True}
    monkeypatch.setattr(runner, "_baseline_predictions", baseline)
    first = runner._select_comparison(tmp_path, [], [])
    assert first["selected"] == "assessment_context_v1"
    assert calls == ["assessment_context_v1"]
    assert cache_path.read_bytes() == original
    fingerprints = {path.name: (path.read_bytes(), path.stat().st_mtime_ns)
                    for path in tmp_path.glob("*.json")}
    assert runner._select_comparison(tmp_path, [], []) == first
    assert calls == ["assessment_context_v1"]
    assert fingerprints == {path.name: (path.read_bytes(), path.stat().st_mtime_ns)
                            for path in tmp_path.glob("*.json")}


def test_retry_completes_after_interrupted_selection_publication(runner, tmp_path, monkeypatch):
    setup_experiment(runner, tmp_path)
    monkeypatch.setattr(runner, "_baseline_predictions", lambda *args: {"computed_once": True})
    real_write = runner._write_new
    def interrupted_write(path, value):
        if path.name == "selection.json":
            raise OSError("simulated publication failure")
        real_write(path, value)
    monkeypatch.setattr(runner, "_write_new", interrupted_write)
    with pytest.raises(OSError, match="publication failure"):
        runner._select_comparison(tmp_path, [], [])
    reviewed = {path: path.read_bytes() for path in tmp_path.glob("*-reviewed.json")}
    assert len(reviewed) == 2 and not (tmp_path / "selection.json").exists()
    monkeypatch.setattr(runner, "_write_new", real_write)
    monkeypatch.setattr(runner, "_baseline_predictions", lambda *args: pytest.fail("Should reuse reviews"))
    assert runner._select_comparison(tmp_path, [], [])["selected"] == "assessment_context_v1"
    assert all(path.read_bytes() == contents for path, contents in reviewed.items())


def test_unknown_rules_and_conflicting_review_fail_without_writes(runner, tmp_path, monkeypatch):
    setup_experiment(runner, tmp_path)
    protocol = runner._read(tmp_path / "protocol.json")
    protocol["selection"]["guard_metrics"].append("unknown_guard")
    (tmp_path / "protocol.json").write_text(json.dumps(protocol))
    monkeypatch.setattr(runner, "_baseline_predictions", lambda *args: pytest.fail("Validate first"))
    with pytest.raises(ValueError, match="Unknown declared selection guard"):
        runner._select_comparison(tmp_path, [], [])
    assert not list(tmp_path.glob("*-reviewed.json"))
    protocol["selection"]["guard_metrics"].remove("unknown_guard")
    (tmp_path / "protocol.json").write_text(json.dumps(protocol))
    runner._write_new(tmp_path / "context_control-validation-assessment-reviewed.json", {
        "linear_percentage_point_metrics": {"count": 20, "rmse": 999}, "baselines": {},
    })
    with pytest.raises(ValueError, match="does not match original"):
        runner._select_comparison(tmp_path, [], [])
    assert not (tmp_path / "selection.json").exists()
