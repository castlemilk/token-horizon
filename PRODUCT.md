# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

This record covers Token Horizon’s public web experience in `docs/`. The repository also contains native macOS and cross-platform clients; this web record does not redefine their platform behavior.

## Users

People comparing the AI usage that team members choose to publish. The primary audience remains an open decision: builders and small crews, organisation managers, or both. Current public copy addresses builders and crews; that is repository evidence, not a confirmed audience priority.

## Product Purpose

Make AI model usage understandable across tools, providers, profiles and teams. The requested team experience should make comparisons and analytics useful, accessible and recognisably Token Horizon.

Every view must make its purpose, whose data it shows and the next meaningful action clear. Personal/account destinations must never substitute the first community profile or community aggregates for the signed-in person's data.

## Positioning

Usage comes from the local engine and voluntarily published profiles. Team membership is account-based and separate from publishing a usage profile. A person can join a team before publishing; public totals include published profiles only.

## Operating Context

The public web includes individual rankings, team rankings, public team/profile pages, a model catalogue, documentation and signed-in workspace tools. People can create a crew, invite others, explore its shared usage and share its public profile.

Workspace analyzes published profile snapshots; it does not read live or private device telemetry. Sign-in discovers profiles verified as owned by the current account, without publishing or claiming a profile automatically. One owned profile opens directly; multiple profiles require an intentional choice. An explicitly opened public profile remains a visibly scoped public preview.

The account's **Model costs** destination opens Workspace's **Models & costs** section for its selected profile, rather than a community cost aggregate. **Report sharing** first requires a verified-owned profile choice and shows only supported report settings and actions. Private requests wait for that choice. Local-only “Default Sharing Rules” toggles and unsupported Comment/Edit permission matrices are not product capabilities.

## Capabilities and Constraints

- Preserve the engine as the source of truth and the existing public API contracts.
- Distinguish checking sign-in, loading owned profiles, selecting a profile, loading a snapshot, ready, genuinely empty and failed states. An unresolved or failed request must never imply an empty account or zero usage.
- Signed-out Workspace offers Sign in. A verified signed-in empty state explains publication and supported account-linking steps. Failures identify the failed step and offer retry or another valid profile; public previews identify their owner and scope. Preserve valid snapshots during refresh failures.
- Keep Workspace focused on published analysis and the relevant next step. Do not add promotional feature cards or Invite friends actions to its analysis surface.
- Show real reported tokens and shared cost estimates. Missing values are unavailable, not fabricated measurements. Token volume describes activity, not productivity.
- Team comparisons support today, seven days and all time. Provider mix is all time. Daily history uses published UTC day buckets and may have incomplete coverage.
- Community analytics toggle between comparisons and daily time series over 7, 30 or 119 days. History mode and window are shareable in the URL; exact daily readings are available without hover.
- Team membership, published profiles and profiles reporting a selected window are separate populations.
- Prompts and device traces remain private under the repository’s existing privacy rules. Joining, inviting, publishing and sharing are distinct actions.
- Keep charts, avatars, fonts and search libraries locally vendored. Do not add a runtime dependency without review.
- The current frontend is static HTML/CSS/JavaScript served by the Cloudflare Worker. Preserve chart pooling, navigation, search and model cross-links.

## Brand Commitments

The name is Token Horizon. Preserve the committed Quiet precision identity and its horizon seam, original marks and icon assets. The user requested a review of the system, iconography and uniqueness, using Impeccable and Gamma components/effects as references.

## Evidence on Hand

`README.md`, `LEADERBOARD.md`, `AGENTS.md`, the public implementation, and `token-horizon-design-system/DESIGN_SYSTEM.md` provide product and brand evidence. Preview fixtures are illustrative and must never be shipped as actual team activity. Gamma is a component reference; authored adaptations must preserve provenance and avoid unsupported capability claims.

## Product Principles

- Put the measurement’s scope and publication limits beside the result.
- State the view's purpose, owner/scope and real supported actions in loading, empty, error and ready states.
- Preserve a person’s choice about what becomes public.
- Make team comparisons understandable without equating usage volume with productivity.
- Use distinctive interactions to help people inspect real data.
