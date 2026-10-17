"""Shared schema conditioned, variable length encoder/query Transformer."""

from __future__ import annotations

try:
    import torch
    from torch import nn
except ImportError:
    torch = None
    nn = object


if torch is not None:

    class SchemaForecaster(nn.Module):
        """Forecast typed field queries from their local history and schema.

        The first dimensions of the public tensors are always batch, query,
        and history. Entity indexes are temporary positions within one schema;
        the model does not learn student identities.
        """

        def __init__(
            self,
            width=96,
            heads=4,
            layers=3,
            dropout=0.1,
            numeric_outputs=1,
            categories=16,
            quantiles=3,
            max_fields=512,
            max_queries=128,
            max_history=512,
            numeric_residual=False,
            residual_link="logit",
            numeric_history_context=False,
        ):
            super().__init__()
            if width <= 0 or heads <= 0 or width % heads or layers < 1:
                raise ValueError(
                    "Positive width must be divisible by positive heads; layers must be positive"
                )
            if quantiles < 3 or quantiles % 2 != 1:
                # Training and decoding use a central .5 quantile. An even
                # number would silently label an off-center quantile a median.
                raise ValueError("quantiles must be odd and at least 3")
            self.max_fields = max_fields
            self.max_queries = max_queries
            self.max_history = max_history
            self.quantile_count = quantiles
            self.numeric_outputs = numeric_outputs
            # Kept opt-in so model bundles created before the residual head can
            # still be instantiated with their original state-dict contract.
            self.numeric_residual = bool(numeric_residual)
            if residual_link not in {"logit", "additive"}:
                raise ValueError("residual_link must be 'logit' or 'additive'")
            self.residual_link = residual_link
            # This optional branch is constructed only when requested. Old
            # bundles therefore keep the same parameters and state-dict keys.
            self.numeric_history_context = bool(numeric_history_context)
            # These are small learned lookup tables: each field/type/position
            # becomes a fixed-width vector. They are structured-data features,
            # not text tokens or word embeddings.
            self.value = nn.Linear(1, width)
            self.field = nn.Embedding(max_fields, width)
            self.kind = nn.Embedding(8, width)
            self.history_position = nn.Embedding(max_history, width)
            self.query_field = nn.Embedding(max_fields, width)
            self.query_position = nn.Embedding(max_queries, width)
            self.query_features = nn.Linear(8, width, bias=False)
            self.schema_input = nn.Linear(16, width)
            # Self-attention lets every valid schema or history token compare
            # itself with the others. Multiple attention heads learn different
            # kinds of relationships in parallel before combining their views.
            self.schema_encoder = nn.TransformerEncoder(
                nn.TransformerEncoderLayer(
                    width, heads, width * 4, dropout, batch_first=True, norm_first=True
                ),
                max(1, layers // 2),
            )
            self.history_encoder = nn.TransformerEncoder(
                nn.TransformerEncoderLayer(
                    width, heads, width * 4, dropout, batch_first=True, norm_first=True
                ),
                layers,
            )
            self.schema_attention = nn.MultiheadAttention(
                width, heads, dropout, batch_first=True
            )
            self.history_attention = nn.MultiheadAttention(
                width, heads, dropout, batch_first=True
            )
            # The query reads relevant schema and history memories here.
            # Layer normalization stabilizes activation scales; the feed-forward
            # block mixes each query's features, with dropout only during training.
            self.cross_norm = nn.LayerNorm(width)
            self.cross_ff = nn.Sequential(
                nn.Linear(width, width * 2),
                nn.GELU(),
                nn.Dropout(dropout),
                nn.Linear(width * 2, width),
            )
            self.output_norm = nn.LayerNorm(width)
            # Separate heads answer different questions from the shared query
            # representation: numeric ranges, category, trend, and failure risk.
            self.numeric = nn.Linear(width, numeric_outputs * quantiles)
            if self.numeric_residual:
                # Start the median at zero delta (persistence) with narrow,
                # nonzero monotone spreads. The optimizer can then learn
                # corrections without needing to cancel a random initial bias.
                nn.init.zeros_(self.numeric.weight)
                nn.init.constant_(self.numeric.bias, -2.0)
                with torch.no_grad():
                    self.numeric.bias.view(numeric_outputs, quantiles)[
                        :, quantiles // 2
                    ].zero_()
            self.category = nn.Linear(width, categories)
            self.trend = nn.Linear(width, 3)
            self.failure = nn.Linear(width, 1)
            if self.numeric_history_context:
                # Optional layers come last so enabling them does not change
                # the shared layers' seeded weights in controlled tests.
                self.numeric_context_encoder = nn.Sequential(
                    nn.Linear(11, max(8, width // 2)),
                    nn.GELU(),
                    nn.Linear(max(8, width // 2), width),
                    nn.GELU(),
                )
                self.numeric_context_to_forecast = nn.Linear(width, width)
                self.numeric_context_to_quantiles = nn.Linear(
                    width, numeric_outputs * quantiles
                )
                nn.init.zeros_(self.numeric_context_to_forecast.weight)
                nn.init.zeros_(self.numeric_context_to_forecast.bias)
                nn.init.zeros_(self.numeric_context_to_quantiles.weight)
                nn.init.zeros_(self.numeric_context_to_quantiles.bias)

        def forward(
            self,
            values,
            field_ids,
            kinds,
            schema_tokens,
            history_mask,
            query_ids,
            query_mask,
            legal_category_mask=None,
            schema_mask=None,
            numeric_bounds=None,
            query_features=None,
        ):
            batch, history_length = values.shape
            query_length = query_ids.shape[1]
            if history_length > self.max_history or query_length > self.max_queries:
                raise ValueError("Input length exceeds configured model limits")
            if (
                field_ids.min() < 0
                or field_ids.max() >= self.max_fields
                or query_ids.min() < 0
                or query_ids.max() >= self.max_fields
            ):
                raise ValueError("Field identity is outside configured vocabulary")

            history_pos = torch.arange(history_length, device=values.device)
            # A history token combines its value with what field and type it
            # belongs to, plus its relative place in the supplied sequence.
            history = (
                self.value(values.unsqueeze(-1))
                + self.field(field_ids)
                + self.kind(kinds)
                + self.history_position(history_pos)[None, :, :]
            )
            schema = self.schema_encoder(
                self.schema_input(schema_tokens), src_key_padding_mask=schema_mask
            )
            # Queries first read the schema, then the encoded history. Attention
            # lets each requested field select relevant context independently.
            query_pos = torch.arange(query_length, device=values.device)
            query = self.query_field(query_ids)
            if query_features is None:
                # Legacy tensor callers infer horizons from ordered slots.
                # Explicit typed queries carry their own horizons and must be
                # equivariant to reordering or selecting a query subset.
                query = query + self.query_position(query_pos)[None, :, :]
            if query_features is not None:
                if query_features.shape != (batch, query_length, 8):
                    raise ValueError(
                        "Query features must have shape [batch, queries, 8]"
                    )
                query = query + self.query_features(query_features)
            schema_context, _ = self.schema_attention(
                query, schema, schema, key_padding_mask=schema_mask, need_weights=False
            )
            query = query + schema_context
            encoded = self.history_encoder(history, src_key_padding_mask=history_mask)
            attended, _ = self.history_attention(
                query,
                encoded,
                encoded,
                key_padding_mask=history_mask,
                need_weights=False,
            )
            forecast = self.cross_norm(query + attended)
            forecast = self.output_norm(forecast + self.cross_ff(forecast))

            numeric_context = None
            if self.numeric_history_context:
                # All matching and reductions stay within [B,Q,H]: B is the
                # learner, Q the requested field, and H its observed tokens.
                # Reducing only H prevents one learner/query from borrowing
                # another learner's values. No label or field name is used.
                history_index = torch.arange(history_length, device=values.device)
                is_number = (kinds == 0) | (kinds == 1)
                matches = (
                    (field_ids[:, None, :] == query_ids[:, :, None])
                    & is_number[:, None, :]
                    & (~history_mask)[:, None, :]
                )
                if query_features is not None:
                    query_is_number = (query_features[..., 1] == 0) | (
                        query_features[..., 1] == 1
                    )
                    matches = matches & query_is_number[:, :, None]
                has_value = matches.any(dim=-1)
                last_index = torch.where(
                    matches,
                    history_index[None, None, :],
                    torch.full_like(history_index[None, None, :], -1),
                ).amax(dim=-1)
                before_last = matches & (
                    history_index[None, None, :] < last_index[:, :, None]
                )
                previous_index = torch.where(
                    before_last,
                    history_index[None, None, :],
                    torch.full_like(history_index[None, None, :], -1),
                ).amax(dim=-1)
                has_previous = previous_index >= 0

                # Bound normalized inputs so a single extreme token cannot
                # dominate the summaries. Missing tokens contribute zero.
                clipped = values.clamp(-10.0, 10.0)
                observed = torch.where(matches, clipped[:, None, :], 0.0)
                count = matches.sum(dim=-1).clamp_min(1).to(values.dtype)
                latest = observed.gather(
                    2, last_index.clamp_min(0).unsqueeze(-1)
                ).squeeze(-1)
                previous = observed.gather(
                    2, previous_index.clamp_min(0).unsqueeze(-1)
                ).squeeze(-1)
                mean = observed.sum(dim=-1) / count
                centered = torch.where(
                    matches, clipped[:, None, :] - mean[..., None], 0.0
                )
                variance = (centered.square().sum(dim=-1) / count).clamp_min(0)
                epsilon = torch.finfo(values.dtype).eps
                # Clamp before sqrt so constant or single-value histories have
                # a finite derivative; report their true standard deviation
                # as exactly zero.
                std = torch.where(variance > 0, variance.clamp_min(epsilon).sqrt(), 0.0)
                minimum = torch.where(matches, clipped[:, None, :], float("inf")).amin(
                    -1
                )
                maximum = torch.where(matches, clipped[:, None, :], float("-inf")).amax(
                    -1
                )
                minimum = torch.where(has_value, minimum, 0.0)
                maximum = torch.where(has_value, maximum, 0.0)
                latest = torch.where(has_value, latest, 0.0)
                previous = torch.where(has_previous, previous, 0.0)
                difference = torch.where(has_previous, latest - previous, 0.0)
                # Age is relative token position, not elapsed clock time.
                # A single observation has age zero; empty histories use zero.
                last_valid_position = (
                    torch.where(
                        ~history_mask,
                        history_index[None, :],
                        torch.full_like(history_index[None, :], -1),
                    )
                    .amax(dim=-1)
                    .clamp_min(0)
                )
                age = (last_valid_position[:, None] - last_index.clamp_min(0)).to(
                    values.dtype
                )
                age = age / last_valid_position[:, None].clamp_min(1).to(values.dtype)
                age = torch.where(has_value, age, 0.0)
                history_count = (
                    (~history_mask).sum(dim=-1).clamp_min(1).to(values.dtype)
                )
                history_count = history_count[:, None]
                count_fraction = matches.sum(dim=-1).to(values.dtype) / history_count
                summary = torch.stack(
                    (
                        latest,
                        previous,
                        difference,
                        mean,
                        std,
                        minimum,
                        maximum,
                        count_fraction,
                        age,
                        has_value.to(values.dtype),
                        has_previous.to(values.dtype),
                    ),
                    dim=-1,
                )
                numeric_context = self.numeric_context_encoder(summary)
                forecast = forecast + self.numeric_context_to_forecast(numeric_context)

            raw = self.numeric(forecast).view(
                batch, query_length, self.numeric_outputs, self.quantile_count
            )
            if numeric_context is not None:
                correction = self.numeric_context_to_quantiles(numeric_context).view(
                    batch,
                    query_length,
                    self.numeric_outputs,
                    self.quantile_count,
                )
                raw = raw + correction
            if self.numeric_residual:
                # The shared head predicts an ordered set of quantiles. In
                # residual mode, its center is a correction around the latest
                # matching value and its positive spreads keep quantiles sorted.
                # BQH means batch, query, and history axes. Building the match
                # matrix as [B,Q,H] and reducing only H prevents a batch/query
                # dimension from broadcasting against another learner.
                history_index = torch.arange(history_length, device=values.device)
                numeric_history = (kinds == 0) | (kinds == 1)
                matches = (
                    (field_ids[:, None, :] == query_ids[:, :, None])
                    & numeric_history[:, None, :]
                    & (~history_mask)[:, None, :]
                )
                last_index = torch.where(
                    matches,
                    history_index[None, None, :],
                    torch.full_like(history_index[None, None, :], -1),
                ).amax(dim=-1)
                has_anchor = last_index >= 0
                # Expand to [B,Q,H] before gathering the last matching history
                # token for each query independently.
                anchor = (
                    values[:, None, :]
                    .expand(-1, query_length, -1)
                    .gather(2, last_index.clamp_min(0).unsqueeze(-1))
                    .squeeze(-1)
                )
                # Typed queries use 0=float, 1=integer, 2=boolean,
                # 3=category, 4=mapped. Non-numeric queries never use anchors.
                numeric_query = (
                    (query_features[..., 1] == 0) | (query_features[..., 1] == 1)
                    if query_features is not None
                    else torch.ones_like(query_mask, dtype=torch.bool)
                )
                has_anchor = has_anchor & numeric_query & (~query_mask)
                if numeric_bounds is None:
                    low = torch.full_like(raw[..., 0], float("-inf"))
                    high = torch.full_like(raw[..., 0], float("inf"))
                else:
                    low, high = numeric_bounds[..., 0, 0], numeric_bounds[..., 0, 1]
                    low, high = low.unsqueeze(-1), high.unsqueeze(-1)
                anchor = anchor.unsqueeze(-1).expand_as(raw[..., 0])
                low_finite, high_finite = torch.isfinite(low), torch.isfinite(high)
                both = low_finite & high_finite
                lower_only = low_finite & ~high_finite
                upper_only = ~low_finite & high_finite
                epsilon = torch.finfo(values.dtype).eps
                safe_low = torch.where(low_finite, low, torch.zeros_like(low))
                safe_high = torch.where(high_finite, high, torch.ones_like(high))

                def inverse_softplus(distance):
                    distance = distance.clamp_min(epsilon)
                    # Avoid expm1, which is not implemented by the supported
                    # ONNX opset; this bounded form stays finite at zero.
                    return distance + torch.log(
                        (1.0 - torch.exp(-distance)).clamp_min(epsilon)
                    )

                fraction = (
                    (anchor - safe_low) / (safe_high - safe_low).clamp_min(epsilon)
                ).clamp(epsilon, 1.0 - epsilon)
                lower_distance = torch.where(
                    lower_only, anchor - safe_low, torch.ones_like(anchor)
                )
                upper_distance = torch.where(
                    upper_only, safe_high - anchor, torch.ones_like(anchor)
                )
                if self.residual_link == "additive":
                    # Add deltas in normalized target units. Unlike the logit
                    # link this keeps useful gradients at censored boundaries.
                    linked_anchor = anchor
                else:
                    linked_anchor = torch.where(
                        both,
                        torch.logit(fraction),
                        torch.where(
                            lower_only,
                            inverse_softplus(lower_distance),
                            torch.where(
                                upper_only,
                                -inverse_softplus(upper_distance),
                                anchor,
                            ),
                        ),
                    )
                center_delta = raw[..., self.quantile_count // 2]
                linked_center = linked_anchor + center_delta
                center_slot = self.quantile_count // 2
                lower_steps = torch.nn.functional.softplus(raw[..., :center_slot]).flip(
                    -1
                )
                upper_steps = torch.nn.functional.softplus(raw[..., center_slot + 1 :])
                lower_values = linked_center.unsqueeze(-1) - torch.cumsum(
                    lower_steps, dim=-1
                ).flip(-1)
                upper_values = linked_center.unsqueeze(-1) + torch.cumsum(
                    upper_steps, dim=-1
                )
                linked_quantiles = torch.cat(
                    (lower_values, linked_center.unsqueeze(-1), upper_values), dim=-1
                )
                # With no matching observation, use zero as the fallback
                # center. The selected residual link determines how that
                # center maps into the normalized target domain.
                fallback_center = raw[..., center_slot]
                fallback_lower = fallback_center.unsqueeze(-1) - torch.cumsum(
                    lower_steps, dim=-1
                ).flip(-1)
                fallback_upper = fallback_center.unsqueeze(-1) + torch.cumsum(
                    upper_steps, dim=-1
                )
                fallback_linked_quantiles = torch.cat(
                    (
                        fallback_lower,
                        fallback_center.unsqueeze(-1),
                        fallback_upper,
                    ),
                    dim=-1,
                )
                low_e = safe_low.unsqueeze(-1)
                high_e = safe_high.unsqueeze(-1)
                both_e = both.unsqueeze(-1)
                lower_e = lower_only.unsqueeze(-1)
                upper_e = upper_only.unsqueeze(-1)

                def apply_bounds(linked):
                    return torch.where(
                        both_e,
                        low_e + (high_e - low_e) * torch.sigmoid(linked),
                        torch.where(
                            lower_e,
                            low_e + torch.nn.functional.softplus(linked),
                            torch.where(
                                upper_e,
                                high_e - torch.nn.functional.softplus(-linked),
                                linked,
                            ),
                        ),
                    )

                if self.residual_link == "additive":
                    # Clamp quantiles in normalized value space. This retains
                    # monotonic order and keeps boundary arithmetic finite.
                    # Comparisons with +/-inf are safe. Keep the original
                    # infinities here so one-sided and unbounded domains are
                    # not accidentally capped at the finite sentinels used by
                    # the logit-link arithmetic above.
                    low_q = low.unsqueeze(-1)
                    high_q = high.unsqueeze(-1)
                    bounded_linked = torch.maximum(
                        torch.minimum(linked_quantiles, high_q), low_q
                    )
                    bounded_fallback = torch.maximum(
                        torch.minimum(fallback_linked_quantiles, high_q), low_q
                    )
                else:
                    bounded_linked = apply_bounds(linked_quantiles)
                    bounded_fallback = apply_bounds(fallback_linked_quantiles)
                # [B,Q,O,K]; scalar forecast uses O=1. Keep the no-anchor
                # fallback on the exact pre-residual output transform.
                quantiles = torch.where(
                    has_anchor[:, :, None, None], bounded_linked, bounded_fallback
                )
            else:
                first = raw[..., :1]
                increments = torch.nn.functional.softplus(raw[..., 1:])
                quantiles = torch.cat(
                    (first, first + torch.cumsum(increments, dim=-1)), dim=-1
                )
            if numeric_bounds is not None and not self.numeric_residual:
                low, high = numeric_bounds[..., 0:1], numeric_bounds[..., 1:2]
                low_finite, high_finite = torch.isfinite(low), torch.isfinite(high)
                both = low_finite & high_finite
                safe_low = torch.where(low_finite, low, torch.zeros_like(low))
                safe_high = torch.where(high_finite, high, torch.ones_like(high))
                both_bounded = safe_low + (safe_high - safe_low) * torch.sigmoid(
                    quantiles
                )
                lower_bounded = safe_low + torch.nn.functional.softplus(quantiles)
                upper_bounded = safe_high - torch.nn.functional.softplus(-quantiles)
                quantiles = torch.where(
                    both,
                    both_bounded,
                    torch.where(
                        low_finite,
                        lower_bounded,
                        torch.where(high_finite, upper_bounded, quantiles),
                    ),
                )

            categorical = self.category(forecast)
            if legal_category_mask is not None:
                if legal_category_mask.shape != categorical.shape:
                    raise ValueError(
                        "Legal category mask shape must match category logits"
                    )
                categorical = categorical.masked_fill(~legal_category_mask, -1e9)
            keep = (~query_mask).to(forecast.dtype).unsqueeze(-1)
            return {
                "quantiles": quantiles * keep.unsqueeze(-1),
                "categorical": categorical * keep,
                "trend": self.trend(forecast) * keep,
                "failure": self.failure(forecast).squeeze(-1) * keep.squeeze(-1),
            }
else:

    class SchemaForecaster:
        def __init__(self, *args, **kwargs):
            raise RuntimeError("Install the 'ml' extra to use SchemaForecaster")


def multitask_loss(
    outputs,
    targets,
    masks,
    weights=None,
    *,
    numeric_center_loss_weight=0.0,
    numeric_center_loss_kind="smooth_l1",
):
    """Average observed task losses; center loss is optional, not a likelihood."""
    if torch is None:
        raise RuntimeError("PyTorch is required")
    if numeric_center_loss_kind not in {"smooth_l1", "mse"}:
        raise ValueError("numeric_center_loss_kind must be 'smooth_l1' or 'mse'")
    task_weights = {
        "numeric": 1.0,
        "category": 1.0,
        "trend": 1.0,
        "failure": 1.0,
        **(weights or {}),
    }
    total = None
    details = {}
    quantile_count = outputs["quantiles"].shape[-1]
    quantiles = torch.linspace(
        0.1, 0.9, quantile_count, device=outputs["quantiles"].device
    )
    for task in ("numeric", "category", "trend", "failure"):
        mask = masks[task].bool()
        pred = (
            outputs["quantiles"]
            if task == "numeric"
            else outputs[task if task != "category" else "categorical"]
        )
        if not mask.any():
            value = pred.sum() * 0
        elif task == "numeric":
            target = targets[task]
            # A scalar query may omit the singleton output dimension. Never
            # allow general broadcasting: it can accidentally compare every
            # learner's target with every other learner's prediction.
            if target.shape == pred.shape[:-2] and pred.shape[-2] == 1:
                target = target.unsqueeze(-1)
            if target.shape != pred.shape[:-1]:
                raise ValueError(
                    "Numeric target shape must match batch/query/output dimensions"
                )
            if mask.shape == pred.shape[:-2]:
                mask = mask.unsqueeze(-1).expand_as(target)
            if mask.shape != target.shape:
                raise ValueError("Numeric observation mask does not match target shape")
            selected = pred[mask]
            observed = target[mask]
            if not torch.isfinite(observed).all():
                raise ValueError("Observed numeric labels must be finite")
            error = observed.unsqueeze(-1) - selected
            # Pinball loss gives each quantile an asymmetric absolute-error
            # penalty: values above and below a quantile have different weights.
            # Classification uses cross-entropy/BCE below; neither loss makes
            # a normal-distribution assumption about numeric outcomes.
            pinball = torch.maximum(quantiles * error, (quantiles - 1) * error).mean()
            if numeric_center_loss_weight:
                median = selected[..., selected.shape[-1] // 2]
                # This optional point penalty encourages a useful center while
                # pinball loss still trains the full quantile interval.
                # MSE adds no assumption that outcomes follow a distribution.
                center_function = (
                    nn.functional.smooth_l1_loss
                    if numeric_center_loss_kind == "smooth_l1"
                    else nn.functional.mse_loss
                )
                center = center_function(median, observed)
                value = pinball + float(numeric_center_loss_weight) * center
            else:
                value = pinball
        elif task in ("category", "trend"):
            logits = outputs["categorical" if task == "category" else "trend"]
            value = nn.functional.cross_entropy(
                logits[mask], targets[task][mask].long()
            )
        else:
            value = nn.functional.binary_cross_entropy_with_logits(
                pred[mask], targets[task][mask].float()
            )
        details[task] = value
        weighted = task_weights[task] * value
        total = weighted if total is None else total + weighted
    return total, details


def constrain_numeric(value, *, minimum=None, maximum=None, integer=False):
    if (
        not isinstance(value, (int, float))
        or isinstance(value, bool)
        or not math_isfinite(value)
    ):
        raise ValueError("Non-finite numeric prediction")
    if (minimum is not None and value < minimum) or (
        maximum is not None and value > maximum
    ):
        raise ValueError("Prediction outside schema range")
    if integer:
        import math

        lower = math.ceil(minimum) if minimum is not None else None
        upper = math.floor(maximum) if maximum is not None else None
        if lower is not None and upper is not None and lower > upper:
            raise ValueError("Declared numeric domain contains no integer")
        rounded = round(value)
        if lower is not None:
            rounded = max(lower, rounded)
        if upper is not None:
            rounded = min(upper, rounded)
        return int(rounded)
    return float(value)


def math_isfinite(value):
    import math

    return math.isfinite(float(value))


def constrained_choice(logits, allowed):
    if len(logits) != len(allowed) or not allowed:
        raise ValueError("Legal choices must align with logits")
    indexes = [i for i, legal in enumerate(allowed) if legal]
    if not indexes:
        raise ValueError("No legal choices remain")
    return max(indexes, key=lambda i: float(logits[i]))
