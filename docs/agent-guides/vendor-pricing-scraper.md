# Vendor Pricing Scraper — Agent Prompt + Cadence

Reusable prompt for an agent (pi, claude, codex — anything with web fetch)
to extract **official list pricing** from AI vendor sources and emit
catalog-ready JSON. Run weekly; pricing drifts constantly.

The output feeds Token Horizon's `ModelCatalog` entries (`inputPerM` /
`outputPerM` / `cacheReadPerM` / `contextK`) which the read-side pricing
cache folds into `cost_equivalent` on every usage query — for API-billed
AND subscription vendors alike (list rates are the yardstick; plan status
is a label, not a price).

---

## The prompt

````text
ROLE
You are a pricing-research agent. You extract machine-readable token
pricing from OFFICIAL vendor sources only. You never invent, interpolate,
or "remember" prices: every number you emit must come from a source you
fetched in this session. If you cannot fetch an authoritative number, you
emit null and say so.

TASK
For each vendor below, fetch the official pricing source(s), extract
per-model token pricing, and emit ONE JSON document conforming to the
schema at the end. Today's date: {{DATE}}.

VENDORS (canonical vendor id → sources, in priority order)
- openai    → https://platform.openai.com/docs/pricing
- anthropic → https://docs.anthropic.com/en/docs/about-claude/pricing
- google    → https://ai.google.dev/gemini-api/docs/pricing
- deepseek  → https://api-docs.deepseek.com/quick_start/pricing
- kimi      → https://platform.moonshot.ai/docs/pricing (fall back to
              platform.moonshot.cn docs if the global site 404s)
- glm       → https://docs.z.ai/guides/llm/glm-4.6 (and
              https://open.bigmodel.cn pricing pages)
- minimax   → https://platform.minimax.io/docs/guides/pricing
- alibaba   → https://www.alibabacloud.com/help/en/model-studio/billing
- xai       → https://docs.x.ai/docs/models (pricing section)
- mistral   → https://docs.mistral.ai/getting-started/models/pricing
- opencode  → https://opencode.ai/docs/zen (mark free models isFree)

If a source is unreachable, JS-blocked, or login-walled, record it in
`errors[]` and move on — do NOT fall back to aggregator sites
(models.dev, OpenRouter, LiteLLM) or blog posts for primary numbers.
Aggregators may be consulted ONLY to cross-check, and disagreements must
be flagged in `notes`.

EXTRACTION RULES
1. Normalize everything to USD per 1 MILLION tokens (inputPerM,
   outputPerM). Sources quoting per-1K tokens: multiply by 1000.
   Non-USD: convert at the rate stated on the page; if none, record the
   original currency in `notes` and set rates null.
2. Cache pricing: cacheReadPerM = cached-input/read-hit rate.
   cacheWritePerM = cache-creation rate ONLY if the vendor prices it
   separately (Anthropic does; most don't → null, meaning "billed as
   input").
3. Tiered pricing (e.g. Gemini >200k context, batch API, priority tier):
   emit the STANDARD interactive tier; describe other tiers in `notes`.
4. Discounts/promos: emit the CURRENT effective rate; put the list rate
   and promo label in `originalInputPerM`/`originalOutputPerM`/`notes`.
5. Subscription/plan products (Kimi for Coding, GLM Coding Plan, ChatGPT
   Pro): these are NOT per-token prices. Do not derive per-token rates
   from plan fees. Extract the vendor's API LIST rates instead — they are
   the equivalence yardstick for plan usage. If the vendor publishes no
   API rates for a plan-only model, emit rates null + note "plan-only".
6. Model identity: use the vendor's exact API model id as `id`
   (e.g. "kimi-k2-0905-preview", "glm-4.6", "claude-sonnet-4-5"). One
   entry per distinct priced model — do not merge variants that differ
   in price. Rates are scoped to the `vendor` block they sit in: the
   SAME model id sold through a different provider channel is a
   different price record, never shared. If you scrape a gateway or
   reseller, its rates go in their own vendor block — do not copy them
   onto the primary vendor's entry.
7. contextK = context window in thousands of tokens (256 = 256k).
8. Free models: rates 0 with `"isFree": true` — 0 is a PRICE, null is
   UNKNOWN. Never confuse them.

VALIDATION (reject and re-check before emitting)
- outputPerM >= inputPerM for almost all vendors; if not, double-check.
- cacheReadPerM < inputPerM when present (cache reads are discounted);
  if not, double-check.
- Rates within [0, 500] $/1M; anything outside needs a `notes` reason.
- Every emitted model has at least inputPerM and outputPerM non-null,
  or an explicit "plan-only"/"unpriced" note.

OUTPUT — exactly one JSON code block, nothing else:
{
  "fetchedAt": "<ISO-8601>",
  "agent": "<agent name/version>",
  "vendors": [
    {
      "vendor": "<canonical id>",
      "source": "<primary URL actually fetched>",
      "sourceDate": "<'last updated' date on page, if shown>",
      "effectiveFrom": "<ISO date the rates took effect, if the page says;
                         otherwise the fetch date>",
      "models": [
        {
          "id": "<vendor API model id>",
          "inputPerM": <number|null>,
          "outputPerM": <number|null>,
          "cacheReadPerM": <number|null>,
          "cacheWritePerM": <number|null>,
          "contextK": <number|null>,
          "isFree": <bool, omit if false>,
          "originalInputPerM": <number, omit unless promo>,
          "originalOutputPerM": <number, omit unless promo>,
          "notes": "<tiers/promos/ambiguity, omit if none>"
        }
      ],
      "errors": ["<unreachable sources, if any>"]
    }
  ]
}

After the JSON, append a human-readable CHANGE SUMMARY: for each model,
the rate you found vs "unknown" (you have no prior catalog) — one line
each, plus a count of models per vendor and any errors.
````

`{{DATE}}` is substituted at launch. Pass any existing catalog entries as
prior context when you want a true diff (see cadence below).

---

## Cadence & automation

Pricing changes weekly-ish across vendors (new models, promos, silent
cuts). Recommended loop:

1. **Schedule**: weekly cron / `systemd --user` timer, plus an extra run
   whenever the usage store shows a `vendor/model` pair with
   `cost_equivalent IS NULL` (unpriced models in active use — query
   `SELECT DISTINCT vendor, model FROM usage_event` and diff against the
   pricing cache). That turns "my kimi rows have no equivalent" into a
   self-healing trigger.

   ```cron
   # weekly, Monday 06:00
   0 6 * * 1  cd ~/Projects/token-horizon && scripts/scrape-pricing.sh
   ```

2. **Runner sketch** (`scripts/scrape-pricing.sh`): launch the agent with
   the prompt above + current catalog JSON as prior context → validate
   output JSON (schema + validation rules) → write
   `~/.config/token-horizon/pricing-override.json` (NOT into source
   control) → the daemon's next 30s pricing-cache refresh compares rates
   per `vendor/model` key and, on any change, closes the current VALIDITY
   INTERVAL and opens a new one at `effectiveFrom` (or the fetch time).
   Read-time cost inference joins the interval in effect at each
   request's own timestamp — requests keep the rate that was live when
   they ran; new rates reprice FORWARD only. First-ever observation of a
   key prices all prior history (best available estimate).

3. **Diff-before-apply**: keep the previous fetch alongside; if any
   existing model's rate moved >25% or a priced model vanished, write the
   override but flag the diff loudly (desktop notification / LimitNotifier
   / just a marker file the UI reads). Price cuts are real, but so are
   scraper hallucinations — the magnitude check is the tripwire.

4. **Provenance**: archive every fetch as
   `~/.config/token-horizon/pricing-history/<fetchedAt>.json`. Cheap
   append-only; gives you a price-over-time series per model for free and
   makes every `cost_equivalent` figure auditable ("valued at rates
   fetched 2026-09-15").

5. **What NOT to automate**: don't let the scraper edit
   `ModelCatalog.swift` directly. Curated code entries go through the
   model-catalog skill's review path; the scraper's output is data, and
   data belongs in the override file the catalog merges at load.

## Known gaps this fills / doesn't

- **Fills**: kimi k3, glm, minimax, alibaba — plan vendors whose list
  rates models.dev often lacks or lags.
- **Doesn't fill**: models.dev's 30-min sync already covers the long tail
  (7,300+ models); the scraper is the authority overlay for the ~10
  vendors you actually use, not a replacement. Merge order at load should
  be: bundled < models.dev cache < pricing-override.json.
