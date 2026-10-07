# Ecosystem Integration — CookieGate

## Canonical service identity

| Field | Value |
|---|---|
| Service ID | `cookiegate` |
| Canonical name | CookieGate |
| Ecosystem layer | `protection.browser-state` |
| Standalone-first | `true` |

## Role

Deterministic browser-state governance engine.

## This service owns

- Cookie inspection
- Active-site state
- Domain rules
- Banner governance
- Browser observer totals
- Cookie quarantine and removal
- Evidence export

## This service does not own

- DNS policy
- Network-device discovery
- Full behavioral profiling

## Upstream services

- None

## Downstream consumers or operators

- `shadowprofile`
- `operators`

## Contract families

- `browser.*`
- `cookie.*`
- `banner.*`
- `domain-rule.*`
- `quarantine.*`
- `receipt.*`

## Integration rules

1. This repository must remain independently understandable, testable, buildable, and releasable.
2. Ecosystem integrations extend capability but do not replace standalone correctness.
3. Integrations use explicit, versioned schemas and receipts.
4. No undocumented database sharing, hidden filesystem coupling, or implicit trust is permitted.
5. Producer claims must be independently verified by the receiving boundary where verification is required.
6. Integration failure must not silently corrupt local authoritative state.
7. Missing upstream services must produce an explicit unavailable, unknown, deferred, or failed state according to the local contract.
8. This repository's current implementation must not be treated as the complete product definition.

## Authoritative ecosystem sources

- `C:\dev\Constellation\ecosystem\SERVICE_MAP.md`
- `C:\dev\Constellation\registry\services.json`
- `C:\dev\Constellation\ecosystem\AGENT_POLICY.md`
- `C:\dev\Constellation\ecosystem\SHARED_INVARIANTS.md`

## Change governance

Changes to this service's ecosystem role, ownership boundaries, upstream dependencies, or downstream responsibilities require:

1. A proposal under `docs\proposals`.
2. A documented compatibility impact.
3. Updated service-map and registry entries.
4. Updated positive and negative integration tests.
5. A new service-map receipt.
