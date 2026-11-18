#!/usr/bin/env python3
"""SPECIFICATION TEST HARNESS — proposed arithmetic, not application validation.

Uses only the Python standard library and sibling synthetic JSON fixtures.
No network, prompts, secrets, inference, repository imports, or production writes.
Runs independent constant expectations through unittest and writes a concise
spec_test_results.json beside this script. Passing these tests says nothing
about whether Token Horizon implements or passes the proposed contract.
"""

import copy
import io
import json
from decimal import Decimal
from pathlib import Path
import sys
import unittest


HERE = Path(__file__).resolve().parent
FIXTURES = json.loads((HERE / "token_context_fixtures.json").read_text())


def optional_sum(*values):
    """Unknown required operands propagate; absent counters are never zero."""
    return None if any(v is None for v in values) else sum(values)


def normalize(event):
    """Small executable example of the proposed contract, not a complete SDK."""
    provider = event["provider"]
    result = {
        "input": None, "prompt_input": None, "ordinary_input": None,
        "cache_read": None, "cache_write": None, "output": None,
        "reasoning": None, "tool_prompt": None, "total_reported": None,
        "total_derived": None, "residual": None, "ttl": {},
        "presence": {}, "errors": [], "accounting_level": "response",
    }

    def read(path):
        value = event
        present = True
        for segment in path.split("."):
            if not isinstance(value, dict) or segment not in value:
                present = False
                value = None
                break
            value = value[segment]
        result["presence"][path] = present
        if value is not None and (isinstance(value, bool) or not isinstance(value, int) or value < 0):
            result["errors"].append("invalid_numeric:" + path)
            return None
        return value

    if provider == "openai_responses":
        result.update(
            input=read("usage.input_tokens"),
            cache_read=read("usage.input_tokens_details.cached_tokens"),
            cache_write=read("usage.input_tokens_details.cache_write_tokens"),
            output=read("usage.output_tokens"),
            reasoning=read("usage.output_tokens_details.reasoning_tokens"),
            total_reported=read("usage.total_tokens"),
        )
        result["ttl"] = {
            "30m": read("usage.input_tokens_details.cache_write_tokens_details.ttl_30m_tokens"),
            "12h": read("usage.input_tokens_details.cache_write_tokens_details.ttl_12h_tokens"),
        }
        if all(result[k] is not None for k in ("input", "cache_read", "cache_write")):
            result["ordinary_input"] = result["input"] - result["cache_read"] - result["cache_write"]
    elif provider == "openai_chat":
        result.update(
            input=read("usage.prompt_tokens"),
            cache_read=read("usage.prompt_tokens_details.cached_tokens"),
            output=read("usage.completion_tokens"),
            reasoning=read("usage.completion_tokens_details.reasoning_tokens"),
            total_reported=read("usage.total_tokens"),
        )
        if result["input"] is not None and result["cache_read"] is not None:
            result["ordinary_input"] = result["input"] - result["cache_read"]
    elif provider == "anthropic":
        ordinary = read("usage.input_tokens")
        cache_read = read("usage.cache_read_input_tokens")
        cache_write = read("usage.cache_creation_input_tokens")
        result.update(
            input=optional_sum(ordinary, cache_read, cache_write),
            ordinary_input=ordinary, cache_read=cache_read, cache_write=cache_write,
            output=read("usage.output_tokens"),
            reasoning=read("usage.output_tokens_details.thinking_tokens"),
        )
        result["ttl"] = {
            "5m": read("usage.cache_creation.ephemeral_5m_input_tokens"),
            "1h": read("usage.cache_creation.ephemeral_1h_input_tokens"),
        }
    elif provider == "anthropic_compaction":
        # Iterations are the selected accounting layer. Top-level zeros are
        # deliberately ignored; the two layers are never added together.
        result["accounting_level"] = "iterations"
        rows = event.get("usage", {}).get("iterations")
        result["presence"]["usage.iterations"] = rows is not None
        if rows:
            normalized = [normalize({"provider": "anthropic", "usage": row}) for row in rows]
            for key in ("input", "ordinary_input", "cache_read", "cache_write", "output", "reasoning"):
                result[key] = optional_sum(*(row[key] for row in normalized))
            for row in normalized:
                result["errors"].extend(row["errors"])
        else:
            result["errors"].append("missing_compaction_iterations")
    elif provider == "gemini_generate":
        prompt = read("usageMetadata.promptTokenCount")
        tool = read("usageMetadata.toolUsePromptTokenCount")
        candidates = read("usageMetadata.candidatesTokenCount")
        thoughts = read("usageMetadata.thoughtsTokenCount")
        result.update(
            prompt_input=prompt, tool_prompt=tool,
            input=optional_sum(prompt, tool), output=optional_sum(candidates, thoughts),
            reasoning=thoughts,
            cache_read=read("usageMetadata.cachedContentTokenCount"),
            total_reported=read("usageMetadata.totalTokenCount"),
        )
    elif provider == "ollama":
        result.update(
            input=read("usage.prompt_eval_count"),
            cache_read=read("usage.prompt_eval_cached_count"),
            output=read("usage.eval_count"),
        )
        if result["input"] is not None and result["cache_read"] is not None:
            result["ordinary_input"] = result["input"] - result["cache_read"]
    else:
        raise ValueError("unsupported fixture provider")

    # Validate source values without clamping them. Quarantined observations
    # remain inspectable but cannot contribute to totals or prices.
    cache_base = result["prompt_input"] if provider == "gemini_generate" else result["input"]
    if cache_base is not None and result["cache_read"] is not None and result["cache_read"] > cache_base:
        result["errors"].append("cache_read_exceeds_input")
    if provider == "openai_responses" and all(result[k] is not None for k in ("input", "cache_read", "cache_write")):
        if result["cache_read"] + result["cache_write"] > result["input"]:
            result["errors"].append("cache_partition_exceeds_input")
    if provider in ("openai_responses", "openai_chat", "anthropic"):
        if result["output"] is not None and result["reasoning"] is not None and result["reasoning"] > result["output"]:
            result["errors"].append("reasoning_exceeds_output")
    ttl_values = list(result["ttl"].values())
    if ttl_values and all(v is not None for v in ttl_values) and result["cache_write"] is not None:
        if sum(ttl_values) != result["cache_write"]:
            result["errors"].append("cache_write_ttl_mismatch")

    result["total_derived"] = optional_sum(result["input"], result["output"])
    if result["total_derived"] is not None and result["total_reported"] is not None:
        result["residual"] = result["total_reported"] - result["total_derived"]
    result["status"] = (
        "quarantined" if result["errors"] else
        "reconciliation_mismatch" if result["residual"] not in (None, 0) else
        "partial" if result["input"] is None or result["output"] is None else "valid"
    )
    result["contributes_to_totals"] = not result["errors"]
    return result


def merge_anthropic_stream(stream):
    """Keep latest supplied cumulative values, including explicit zero."""
    usage = {}
    for event in stream["events"]:
        update = event.get("message", {}).get("usage") if event["type"] == "message_start" else event.get("usage")
        if isinstance(update, dict):
            usage.update(update)
    result = normalize({"provider": "anthropic", "usage": usage})
    result["finality"] = "final" if stream["complete"] else "lower_bound"
    return result


def ledger_totals(rows):
    """Scoped response identities dedupe; distinct retry responses remain work."""
    seen = {}
    duplicates = 0
    for row in rows:
        # Response IDs need not be globally unique across billing accounts,
        # providers or API families. All namespace fields are required.
        key = (
            row["tenant_id"], row["billing_account_namespace"],
            row["provider"], row["api_family"], row["response_id"],
        )
        if key in seen:
            if seen[key] != row["reported_total"]:
                raise ValueError("conflicting_duplicate")
            duplicates += 1
        else:
            seen[key] = row["reported_total"]
    return {"unique_responses": len(seen), "duplicates": duplicates, "reported_total": sum(seen.values())}


def context_view(context):
    """Example prompt gauge with separate client planning and admission rules.

    output_reserve_tokens is the fixture's requested generation allowance,
    not evidence of physically reserved space or provider admission policy.
    Never derive context from cumulative work.
    """
    prompt = context.get("latest_prompt_tokens")
    limit = context.get("limit_tokens")
    kind = context["limit_kind"]
    admission_rule = context.get("provider_admission_rule", "unknown")
    result = {
        "prompt_tokens": prompt, "cache_read_tokens": context.get("cache_read_tokens"),
        "limit_kind": kind, "prompt_percent": None, "input_headroom": None,
        "combined_headroom_after_reserve": None,
        "client_planning_headroom": None,
        "planning_basis": "client_requested_output_allowance",
        "provider_admission_rule": admission_rule,
        "provider_admission_input_limit_tokens": None,
        "provider_admission_headroom": None,
        "warnings": [],
    }
    if prompt is not None and limit is not None and limit > 0:
        result["prompt_percent"] = Decimal(prompt) * 100 / Decimal(limit)
        result["input_headroom"] = limit - prompt
        if result["input_headroom"] < 0:
            result["warnings"].append("prompt_exceeds_limit")
        if kind == "combined_context" and context.get("output_reserve_tokens") is not None:
            result["client_planning_headroom"] = limit - prompt - context["output_reserve_tokens"]
            # Retain the original example field as a client-planning alias.
            result["combined_headroom_after_reserve"] = result["client_planning_headroom"]
            if result["client_planning_headroom"] < 0:
                result["warnings"].append("output_reserve_exceeds_remaining_context")
        if kind == "combined_context" and admission_rule == "subtract_model_output_allowance":
            required = context.get("provider_required_output_allowance_tokens")
            if required is not None:
                result["provider_admission_input_limit_tokens"] = limit - required
                result["provider_admission_headroom"] = limit - required - prompt
                if result["provider_admission_headroom"] < 0:
                    result["warnings"].append("provider_input_admission_exceeded")
    if "unique_request_inputs" in context:
        result["cumulative_input_work"] = sum(context["unique_request_inputs"])
    return result


def retrieval_contribution(component):
    """Offered retrieval volume is not necessarily inserted model context.

    A retrieval result inserted as a tool result has one contribution, with
    provenance and carrier as separate attributes, not two token additions.
    """
    return {
        "component_id": component["component_id"],
        "offered_tokens": component["offered_tokens"],
        "inserted_tokens": component["inserted_tokens"],
        "carrier_kind": component["carrier_kind"],
        "input_contribution_tokens": component["inserted_tokens"],
    }


def estimate_synthetic_openai_cost(observation, tariff_id):
    """Invented rates exercise arithmetic only; returns no invoice claim."""
    tariff = FIXTURES["synthetic_tariffs"].get(tariff_id)
    result = {"tariff_id": tariff_id, "status": "unpriced", "currency": "USD", "amount": None, "synthetic": True}
    if observation["status"] == "quarantined":
        result["status"] = "quarantined"
        return result
    if tariff is None:
        return result
    counts = {
        "ordinary_input": observation["ordinary_input"],
        "cache_read": observation["cache_read"],
        "cache_write_30m": observation["ttl"].get("30m"),
        "cache_write_12h": observation["ttl"].get("12h"),
        "output": observation["output"],
    }
    if any(value is None for value in counts.values()):
        result["status"] = "partial_unpriced"
        return result
    result["amount"] = sum(Decimal(value) * Decimal(tariff[key]) for key, value in counts.items()) / Decimal(1000000)
    result["status"] = "synthetic_estimate"
    return result


class ContractExamples(unittest.TestCase):
    """Expected outcomes are fixed independent examples, not fixture-generated."""

    def obs(self, name):
        return normalize(FIXTURES["observations"][name])

    def test_openai_inclusive_buckets(self):
        r = self.obs("openai_complete")
        self.assertEqual((r["input"], r["output"], r["total_derived"]), (1000, 200, 1200))
        self.assertEqual((r["ordinary_input"], r["cache_read"], r["cache_write"], r["reasoning"]), (300, 600, 100, 50))
        self.assertEqual(r["residual"], 0)

    def test_openai_ttl_is_partition(self):
        self.assertEqual(self.obs("openai_complete")["ttl"], {"30m": 60, "12h": 40})

    def test_absent_is_not_zero(self):
        r = self.obs("chat_absent")
        self.assertIsNone(r["input"])
        self.assertIsNone(r["total_derived"])
        self.assertFalse(r["presence"]["usage.prompt_tokens"])

    def test_null_is_not_zero(self):
        self.assertIsNone(self.obs("chat_null")["total_reported"])

    def test_explicit_zero_stays_observed_zero(self):
        r = self.obs("chat_zero")
        self.assertEqual((r["input"], r["output"], r["total_derived"]), (0, 0, 0))
        self.assertTrue(r["presence"]["usage.prompt_tokens"])

    def test_missing_reasoning_not_filled(self):
        r = self.obs("openai_no_reasoning")
        self.assertIsNone(r["reasoning"])
        self.assertEqual(r["output"], 200)

    def test_anthropic_disjoint_input(self):
        r = self.obs("anthropic_complete")
        self.assertEqual((r["input"], r["output"], r["total_derived"]), (10000, 2000, 12000))
        self.assertEqual(r["reasoning"], 1500)
        self.assertEqual(r["ttl"], {"5m": 1000, "1h": 500})

    def test_anthropic_absent_category_preserves_uncertainty(self):
        r = self.obs("anthropic_missing_cache")
        self.assertIsNone(r["input"])
        self.assertEqual(r["ordinary_input"], 500)
        self.assertEqual(r["status"], "partial")

    def test_sse_is_cumulative_not_additive(self):
        r = merge_anthropic_stream(FIXTURES["anthropic_stream"])
        self.assertEqual((r["input"], r["output"], r["total_derived"]), (600, 85, 685))
        self.assertEqual(r["reasoning"], 35)
        self.assertEqual(r["finality"], "final")

    def test_interrupted_sse_is_lower_bound(self):
        stream = copy.deepcopy(FIXTURES["anthropic_stream"])
        stream["complete"] = False
        stream["events"] = stream["events"][:2]
        r = merge_anthropic_stream(stream)
        self.assertEqual(r["output"], 30)
        self.assertEqual(r["finality"], "lower_bound")

    def test_compaction_uses_iterations_not_zero_top(self):
        r = self.obs("anthropic_compaction")
        self.assertEqual((r["input"], r["output"], r["total_derived"]), (14000, 900, 14900))
        self.assertEqual(r["accounting_level"], "iterations")

    def test_gemini_separate_thought_and_tool_work(self):
        r = self.obs("gemini_complete")
        self.assertEqual((r["prompt_input"], r["input"], r["output"], r["total_derived"]), (10000, 12000, 2000, 14000))
        self.assertEqual(r["cache_read"], 8000)

    def test_gemini_residual_is_exposed(self):
        r = self.obs("gemini_residual")
        self.assertEqual((r["total_reported"], r["total_derived"], r["residual"]), (14100, 14000, 100))
        self.assertEqual(r["status"], "reconciliation_mismatch")

    def test_total_only_does_not_invent_input(self):
        r = self.obs("gemini_total_only")
        self.assertEqual(r["total_reported"], 900)
        self.assertIsNone(r["input"])
        self.assertIsNone(r["output"])
        self.assertIsNone(r["residual"])

    def test_ollama_cache_is_subset(self):
        r = self.obs("ollama_complete")
        self.assertEqual((r["input"], r["ordinary_input"], r["total_derived"]), (1000, 200, 1200))

    def test_invalid_cache_is_quarantined_not_clamped(self):
        r = self.obs("invalid_cache_subset")
        self.assertEqual((r["input"], r["cache_read"]), (100, 101))
        self.assertEqual(r["status"], "quarantined")
        self.assertFalse(r["contributes_to_totals"])

    def test_invalid_reasoning_is_quarantined(self):
        self.assertEqual(self.obs("invalid_reasoning_subset")["status"], "quarantined")

    def test_invalid_ttl_partition_is_quarantined(self):
        self.assertIn("cache_write_ttl_mismatch", self.obs("invalid_ttl_split")["errors"])

    def test_invalid_numbers_are_quarantined(self):
        self.assertEqual(self.obs("invalid_negative")["status"], "quarantined")
        self.assertEqual(self.obs("invalid_boolean")["status"], "quarantined")

    def test_duplicate_observation_vs_retry(self):
        self.assertEqual(ledger_totals(FIXTURES["ledger"]), {"unique_responses": 2, "duplicates": 1, "reported_total": 245})

    def test_dedupe_is_tenant_scoped(self):
        rows = [copy.deepcopy(FIXTURES["ledger"][0]), copy.deepcopy(FIXTURES["ledger"][0])]
        rows[1]["tenant_id"] = "synth_tenant_b"
        self.assertEqual(ledger_totals(rows)["reported_total"], 240)

    def test_dedupe_is_billing_account_scoped(self):
        rows = [copy.deepcopy(FIXTURES["ledger"][0]), copy.deepcopy(FIXTURES["ledger"][0])]
        rows[1]["billing_account_namespace"] = "synth_account_b"
        self.assertEqual(ledger_totals(rows), {"unique_responses": 2, "duplicates": 0, "reported_total": 240})

    def test_dedupe_is_provider_scoped(self):
        rows = [copy.deepcopy(FIXTURES["ledger"][0]), copy.deepcopy(FIXTURES["ledger"][0])]
        rows[1]["provider"] = "synth_provider_b"
        self.assertEqual(ledger_totals(rows), {"unique_responses": 2, "duplicates": 0, "reported_total": 240})

    def test_dedupe_is_api_family_scoped(self):
        rows = [copy.deepcopy(FIXTURES["ledger"][0]), copy.deepcopy(FIXTURES["ledger"][0])]
        rows[1]["api_family"] = "synth_api_b"
        self.assertEqual(ledger_totals(rows), {"unique_responses": 2, "duplicates": 0, "reported_total": 240})

    def test_conflicting_duplicate_is_not_silently_overwritten(self):
        rows = copy.deepcopy(FIXTURES["ledger"])
        rows[1]["reported_total"] = 121
        with self.assertRaisesRegex(ValueError, "conflicting_duplicate"):
            ledger_totals(rows)

    def test_unknown_limit_has_no_percentage(self):
        r = context_view(FIXTURES["contexts"]["unknown_limit"])
        self.assertIsNone(r["prompt_percent"])
        self.assertIsNone(r["input_headroom"])

    def test_combined_context_reserves_output_separately(self):
        r = context_view(FIXTURES["contexts"]["combined"])
        self.assertEqual(r["prompt_percent"], Decimal("40"))
        self.assertEqual(r["combined_headroom_after_reserve"], 80000)

    def test_max_input_does_not_subtract_output_reserve(self):
        r = context_view(FIXTURES["contexts"]["separate_input"])
        self.assertEqual((r["prompt_percent"], r["input_headroom"]), (Decimal("80"), 20000))
        self.assertIsNone(r["combined_headroom_after_reserve"])

    def test_cumulative_work_is_not_latest_context(self):
        r = context_view(FIXTURES["contexts"]["session"])
        self.assertEqual((r["cumulative_input_work"], r["prompt_tokens"], r["prompt_percent"]), (230000, 100000, Decimal("50")))

    def test_negative_headroom_is_preserved_with_warning(self):
        r = context_view(FIXTURES["contexts"]["negative_headroom"])
        self.assertEqual(r["combined_headroom_after_reserve"], -20000)
        self.assertEqual(r["input_headroom"], 20000)
        self.assertIn("output_reserve_exceeds_remaining_context", r["warnings"])

    def test_cached_tokens_still_occupy_prompt_context(self):
        r = context_view(FIXTURES["contexts"]["cached_prompt"])
        self.assertEqual((r["prompt_tokens"], r["cache_read_tokens"], r["prompt_percent"]), (100000, 80000, Decimal("50")))

    def test_provider_admission_can_be_stricter_than_client_planning(self):
        r = context_view(FIXTURES["contexts"]["provider_admission_strict"])
        self.assertEqual(r["client_planning_headroom"], 20000)
        self.assertEqual(r["provider_admission_input_limit_tokens"], 140000)
        self.assertEqual(r["provider_admission_headroom"], -20000)
        self.assertEqual(r["planning_basis"], "client_requested_output_allowance")
        self.assertIn("provider_input_admission_exceeded", r["warnings"])

    def test_unknown_admission_policy_is_not_inferred_from_planning(self):
        r = context_view(FIXTURES["contexts"]["provider_admission_unknown"])
        self.assertEqual(r["client_planning_headroom"], 20000)
        self.assertIsNone(r["provider_admission_input_limit_tokens"])
        self.assertIsNone(r["provider_admission_headroom"])

    def test_only_inserted_retrieval_contributes_once(self):
        r = retrieval_contribution(FIXTURES["retrieval"])
        self.assertEqual(r["offered_tokens"], 4000)
        self.assertEqual(r["input_contribution_tokens"], 900)
        self.assertEqual(r["carrier_kind"], "tool_result")

    def test_synthetic_tariff_v1_uses_disjoint_categories(self):
        r = estimate_synthetic_openai_cost(self.obs("openai_complete"), "synth_tariff_v1")
        self.assertEqual(r["amount"], Decimal("0.00267"))
        self.assertEqual(r["tariff_id"], "synth_tariff_v1")

    def test_synthetic_tariff_revision_is_retained(self):
        r = estimate_synthetic_openai_cost(self.obs("openai_complete"), "synth_tariff_v2")
        self.assertEqual(r["amount"], Decimal("0.00307"))
        self.assertEqual(r["tariff_id"], "synth_tariff_v2")

    def test_unknown_tariff_is_not_free(self):
        r = estimate_synthetic_openai_cost(self.obs("openai_complete"), "synth_missing_tariff")
        self.assertIsNone(r["amount"])
        self.assertEqual(r["status"], "unpriced")

    def test_missing_ttl_does_not_pick_a_price(self):
        r = estimate_synthetic_openai_cost(self.obs("openai_missing_ttl"), "synth_tariff_v1")
        self.assertIsNone(r["amount"])
        self.assertEqual(r["status"], "partial_unpriced")

    def test_quarantined_record_cannot_be_priced(self):
        r = estimate_synthetic_openai_cost(self.obs("invalid_cache_subset"), "synth_tariff_v1")
        self.assertIsNone(r["amount"])
        self.assertEqual(r["status"], "quarantined")


def main():
    stream = io.StringIO()
    result = unittest.TextTestRunner(stream=stream, verbosity=1).run(unittest.defaultTestLoader.loadTestsFromTestCase(ContractExamples))
    summary = {
        "artifact_type": "SPECIFICATION TEST HARNESS",
        "scope": "Synthetic proposed normalization arithmetic; NOT Token Horizon application tests",
        "fixture_schema": FIXTURES["schema_version"],
        "tests_run": result.testsRun,
        "passed": result.testsRun - len(result.failures) - len(result.errors) - len(result.skipped),
        "failures": len(result.failures), "errors": len(result.errors), "skipped": len(result.skipped),
        "success": result.wasSuccessful(), "network_calls": 0, "production_code_imports": 0,
        "failure_test_ids": [test.id() for test, _ in result.failures + result.errors],
    }
    (HERE / "spec_test_results.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))
    if not result.wasSuccessful():
        print(stream.getvalue(), file=sys.stderr)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
