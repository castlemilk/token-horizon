# Synthetic validation result

The isolated, standard-library Python oracle passed **69/69 synthetic checks** on 18 November 2026. This validates only the invented examples and proposal arithmetic in `../data`; it is not evidence of deployed behavior, real tenant/RBAC enforcement, production performance or production token semantics.

Run `python3 validation/verify_synthetic.py` from the deliverable root. The exact machine-readable result and input SHA-256 values are in `synthetic_results.json`. The data README describes all arithmetic, null/zero states, corrections, late-arrival, timezone and privacy examples.
