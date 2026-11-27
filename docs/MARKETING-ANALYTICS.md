# Public homepage measurement rollout

Default is **disabled** and the native app, account pages, model explorer, profiles,
reports and private telemetry remain untouched. This patch is not live analytics.

Before activation:
1. Verify a dedicated Token Horizon GA4 website stream and its real measurement ID.
2. Disable enhanced measurement (including history page changes, site search,
   forms and outbound events) in that stream. This code's send_page_view=false
   alone does not guarantee those provider-side features are disabled.
3. Review Google privacy/retention settings and publish appropriate website
   disclosures; keep app-local privacy promises distinct from optional website
   measurement. Do not activate until this review is complete.
4. Fill the dedicated measurement ID and enabled flag in marketing-analytics.js.
5. Test vendor delivery with a consented test session, withdrawal and browser
   privacy signals. Existing local mock tests do not prove vendor behavior.

No consent persistence or implicit opt-in. Only the exact canonical homepage
without a query or fragment is eligible. DNT/GPC fail closed. The loader sends a
fixed canonical page identity, empty referrer and no custom event data. Withdrawal
sets the GA disable flag and clears unsent commands; reload unloads the vendor
script. Already transmitted requests and vendor cookies cannot be recalled.

Flaggr is intentionally **not loaded**: no real per-site site_ ID is verified and
its released collector needs the transmission-stop contract in Flaggr #200.
Even that is not full observer teardown. Do not substitute the demo project or
load the collector across private SPA routes. Revisit as a separately reviewed
integration with a released, pinned collector and test consent end-to-end.
