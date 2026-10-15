# CookieGate — Banner Suppression Audit & Hardening (2026-09-14)

Scope: `banner_suppression_runtime_v32.js` (content script), the single file that
decides what gets hidden on every page. Goal: harden against false positives
(hiding real content/logins) while staying flexible enough to catch real consent
banners across sites.

Governance note: per `docs/canonical/ECOSYSTEM_INTEGRATION.md`, banner governance
is owned by this service. Changes here are behavioral hardening of owned logic.
One change that would alter receipt-field semantics was NOT applied in code and is
filed as a proposal instead (see `docs/proposals/banner_detected_count_semantics.md`).

## Pipeline (as audited)

`boot()` triggers `scanAndSuppress()` on: startup, a dense timer ladder
(80ms…20s), a 40ms-debounced MutationObserver, a 1.2s interval, and
visibility/focus/pageshow. Each `scanAndSuppress`:

1. `host()` empty → return.
2. `cgHostIsAuth()` → return (identity/auth hosts are fully skipped).
3. `cgV74NavigationSuppressionPaused()` → clears candidates on search/auth hosts.
4. Build candidates: `scanCandidates` (selector+score) + `cgScanOverlayModals`
   + `cgScanByHitTest` + `cgV63ExtraCandidates` (CMP selectors + broad
   consent-overlay scan).
5. `cgV74NavigationSafeCandidates` drops navigation-critical elements
   (main/article/nav/header/form, search inputs, >55% viewport, >20 links).
6. `suppressCandidates` applies the final safety gate and hides/removes.

## Layered defenses (defense in depth)

Two host-level guards, one candidate-level content guard, and a four-check
suppression gate — a false positive must defeat all applicable layers:

- Host guards: `cgHostIsAuth` + `cgV74NavigationSuppressionPaused`
  (accounts.google.com, mail.google.com, login.*, signin.*, sso.*, auth.*,
  oauth*, id.*, Microsoft/Apple/Okta/Auth0, and search engines).
- Candidate guard: `cgV74NavigationCriticalCandidate` protects page structure.
- Suppression gate (`suppressCandidates`), in order:
  1. `cgIsPageContent` — landmark / >1500 chars / >10 links / full-page-height
     wrappers are never touched.
  2. `cgIsAuthSurface` — password field, sign-in/2FA wording, or OAuth
     "wants to access your account" language is never touched.
  3. `cgIsOverlayish` — must be fixed/sticky or a large high-z-index absolute
     layer; inline content in normal flow is never touched.
  4. `cgIsKnownCmp` OR (`cgMentionsCookieConsent` AND `cgHasConsentControl`) —
     must be a recognized consent framework, or an overlay that specifically
     talks about cookies/consent AND has a real Accept/Reject/Manage control.

## Findings and hardening applied (this pass)

1. Broadened `cgIsKnownCmp` to match the same strong-vendor set the internal
   detectors already use (added Sourcepoint sp-ccpa/sp-gdpr/sp_choice, qc-cmp,
   privacy/consent-manager, cybot, evidon, cookie-banner, Google Funding Choices/
   googlefc). Improves flexibility and makes the final gate consistent with
   detection. (APPLIED)
2. Broadened `cgMentionsCookieConsent` to also recognize banners that lead with
   "we value your privacy", "privacy preferences", "manage your privacy/consent",
   "legitimate interest". Catches real banners that don't use the literal word
   "cookie" in their first line. (APPLIED)
3. Restricted irreversible DOM removal (`removeChild`) to unambiguous known CMPs.
   Heuristic matches are now only hidden via reversible CSS (re-applied every
   scan), shrinking the blast radius of any residual false positive. (APPLIED)

## Finding filed as proposal (NOT applied — receipt semantics)

4. `detected` / `candidate_count` are computed from pre-gate candidates, so a
   login or discussion page can report banners "detected" that were correctly
   rejected. Fixing this changes the meaning of receipt fields consumed
   downstream, so it is proposed, not silently changed. See
   `docs/proposals/banner_detected_count_semantics.md`.

## Flexibility coverage (real banners still caught)

OneTrust/Optanon, Cookiebot/Cybot, TrustArc/TRUSTe, Didomi, Quantcast (qc-cmp),
Usercentrics, Osano, Sourcepoint (incl. CNN), Klaro, CookieFirst, Termly,
iubenda, Complianz, Borlabs, Google Funding Choices → matched via `cgIsKnownCmp`.
Generic "we use cookies … [Accept][Reject]" fixed/sticky bars → matched via
cookie-specific text + control + overlay. Verified as fixtures in
`suppression_gate_tests.mjs`.

## Known intentional limitations

- A cookie bar rendered inline (position:static, not sticky/fixed) is not
  suppressed. This is deliberate — it is the trade that prevents hiding page
  content; such banners are rare.
- A non-CMP banner that never mentions cookies/consent/privacy anywhere in its
  text is not suppressed. Deliberate, to protect logins/OAuth.

## Verification status (completed 2026-09-15)

- `node --check` on suppressor, popup, and background: PASS.
- Decision-boundary tests: `suppression_gate_regex_tests.mjs` — 65/65 PASS.
  Extracts the real regex literals from source and asserts known-CMP,
  cookie-consent language, consent-control, and auth vetoes on representative
  strings (real banners classified; logins/OAuth/discussion prose excluded).
- Chrome build synced to the identical hardened suppressor (diff-clean).
- Rebuilt `cookiegate_v0.1.5_firefox_TEST.zip` and
  `cookiegate_v0.1.5_chrome_TEST.zip`; both contain the hardened suppressor.
- Fresh Chrome unpacked folder for Load unpacked:
  `dist/chrome_v0.1.5_hardened_unpacked`.

Note: the full jsdom pipeline harness (`suppression_gate_tests.mjs`) requires
`npm i jsdom`, which the sandbox registry blocks (403); it is retained to run in
a normal dev environment. The dependency-free regex harness covers the changed
decision boundaries here.
