# CookieGate

CookieGate is a local-first browser privacy extension for cookie visibility and user-controlled cleanup planning.

## What it does

- Inspect cookies for the active site
- Review browser-held cookies across domains
- Classify cookies into auth/session, preferences, tracking, and unknown/review categories
- Build cleanup plans before destructive actions
- Preserve auth/session cookies by default
- Use hash previews instead of exporting raw cookie values

## Current browser target

Chrome / Chromium Manifest V3.

## Privacy posture

CookieGate is local-first. It processes cookie metadata inside the browser extension and does not sell user data, export raw cookie values, or transfer cookie data to third parties.

See [`PRIVACY.md`](./PRIVACY.md).

## Chrome Web Store v0.1

Initial Chrome submission package was produced locally from:

```text
C:\dev\cookiegate\dist\chrome-current

Generated submission ZIPs and local proof receipts are intentionally not committed to this public repo.
