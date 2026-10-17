"""Independent per-query conformal intervals and binary risk calibration."""

from __future__ import annotations

import hashlib

from .evaluation import (
    conformal_radius,
    prediction_records,
    select_partition,
    temperature_scale,
)
from .lifecycle import load_bundle, save_bundle


def calibrate_bundle(bundle, examples, *, coverage=0.9, batch_size=32, output=None):
    """Publish a new bundle; never modify the trained or deployed incumbent.

    Calibration is grouped by field, actual horizon and legal value domain.
    Its marginal coverage applies to the calibration population, not every
    subgroup, student or previously unseen grading policy. Missing calibration
    is recorded explicitly instead of inventing an interval/confidence value.
    """
    if not 0 < coverage < 1:
        raise ValueError("Coverage must be between zero and one")
    state, metadata = load_bundle(bundle)
    calibration = select_partition(examples, metadata, "calibration")
    records, _ = prediction_records(bundle, calibration, batch_size=batch_size)
    by_query, risk_by_query = {}, {}
    for key in sorted({item["key"] for item in records}):
        items = [item for item in records if item["key"] == key]
        numeric = [item for item in items if "actual" in item]
        risk = [item for item in items if "failure_actual" in item]
        if numeric:
            entry = {
                "field": items[0]["field"],
                "horizon": items[0]["horizon"],
                "domain": items[0]["domain"],
                "count": len(numeric),
                "radius": None,
            }
            try:
                entry["radius"] = conformal_radius(
                    [item["actual"] for item in numeric],
                    [item["lower"] for item in numeric],
                    [item["upper"] for item in numeric],
                    coverage,
                )
            except ValueError as error:
                entry["unavailable_reason"] = str(error)
            by_query[key] = entry
        if risk:
            entry = {
                "field": items[0]["field"],
                "horizon": items[0]["horizon"],
                "domain": items[0]["domain"],
                "count": len(risk),
                "temperature": 1.0,
                "calibrated": False,
            }
            try:
                entry["temperature"] = temperature_scale(
                    [item["failure_logit"] for item in risk],
                    [item["failure_actual"] for item in risk],
                )
                entry["calibrated"] = True
            except ValueError as error:
                entry["unavailable_reason"] = str(error)
            risk_by_query[key] = entry
    if not by_query and not risk_by_query:
        raise ValueError("Calibration partition contains no numeric or risk labels")
    primary = next(
        (
            key
            for key, entry in by_query.items()
            if entry["field"] == metadata.get("target_field") and entry["horizon"] == 1
        ),
        None,
    )
    risk_primary = primary or next(iter(risk_by_query), None)
    # Retain the original adapter's primary-query fields while exposing the
    # full domain-keyed map to the generic and mobile inference contracts.
    report = {
        "method": "split_conformal_and_binary_temperature",
        "coverage_target": coverage,
        "by_query": by_query,
        "risk_by_query": risk_by_query,
        "radius": by_query.get(primary, {}).get("radius"),
        "risk_temperature": risk_by_query.get(risk_primary, {}).get("temperature", 1.0),
        "count": len(calibration),
        "origin": "real"
        if calibration[0].origin == "real"
        else "synthetic_demonstration",
        "calibration_group_hashes": sorted(
            {
                hashlib.sha256(str(item.group).encode()).hexdigest()
                for item in calibration
            }
        ),
        "coverage_assumptions": "Marginal exchangeable observations; no guarantee under distribution shift or for an individual learner",
    }
    if output is not None:
        metadata["calibration"] = report
        save_bundle(output, state=state, metadata=metadata)
        report["calibrated_bundle"] = str(output)
    return report
