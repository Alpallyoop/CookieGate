# Proposal: `detected` / `candidate_count` should reflect eligible banners, not raw candidates

Status: PROPOSED (not yet applied — touches receipt contract semantics)
Author: audit pass 2026-09-14
Affects schemas: `cookiegate.banner.current.ledger.v32`, `cookiegate.banner.timeline.event.v32`

## Problem

In `banner_suppression_runtime_v32.js`, `scanAndSuppress` computes:

```js
var detected = candidates.length > 0;
```

`candidates` is the list produced BEFORE the `suppressCandidates` safety gate
(page-content veto, auth veto, overlay requirement, cookie-specific + control
requirement). On a login page, a discussion board, or any content that merely
mentions consent vocabulary, `candidates` can be non-empty while the gate
correctly suppresses nothing.

Result: the `detected` and `candidate_count` fields in the `banner.current` and
`banner.timeline` receipts report banners that were never real. This overstates
banner activity and can drive a nonzero "detected" with zero "suppressed".

## Proposed change

Split the gate into a shared predicate `cgIsSuppressibleBanner(el)` used by both:

- a pre-count: `eligible = candidates.filter(c => cgIsSuppressibleBanner(c.el)).length`
- the hider: `suppressCandidates` applies the same predicate.

Then set `detected = eligible > 0` and `candidate_count = eligible`.

This makes `detected`/`candidate_count` mean "real, suppressible consent banners
found", consistent with `suppressed_count`.

## Why this is a proposal, not a direct edit

Per `docs/canonical/ECOSYSTEM_INTEGRATION.md`, receipt contracts and
deterministic behavior must not be silently redefined. Changing the meaning of
`detected`/`candidate_count` changes what downstream consumers (`shadowprofile`,
`operators`) and the Browser Observer read from these receipts. It should be
ratified before shipping.

## Backward-compatibility options

1. Redefine in place (bump producer note; consumers already tolerate 0/N).
2. Add new fields `eligible_count` / `suppressible_detected` and keep
   `candidate_count` as raw, deprecating it.

Recommendation: option 2 (additive, non-breaking), then migrate the Observer to
`eligible_count`.
