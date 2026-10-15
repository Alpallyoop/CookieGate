// Dependency-free verification of the hardened suppression decision boundaries.
// Extracts the ACTUAL regex literals from banner_suppression_runtime_v32.js
// (so the test tracks the real source) and asserts classification on
// representative strings. Run: node suppression_gate_regex_tests.mjs
//
// This does not exercise the wired DOM pipeline (that needs jsdom, which the
// sandbox registry blocks); it validates the risk-bearing text classifiers that
// this audit changed: known-CMP, cookie-consent language, consent control, and
// the auth vetoes.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const CODE = readFileSync(join(HERE, "..", "..", "src", "shared", "banner_suppression_runtime_v32.js"), "utf8");

// Pull a `/REGEX/.test(` literal out of the source by an anchor substring.
function extractRegex(anchor) {
  const idx = CODE.indexOf(anchor);
  if (idx < 0) throw new Error("anchor not found: " + anchor);
  const slashStart = CODE.lastIndexOf("/", idx);
  const end = CODE.indexOf("/.test(", idx);
  if (slashStart < 0 || end < 0) throw new Error("regex bounds not found for: " + anchor);
  const body = CODE.slice(slashStart + 1, end);
  return new RegExp(body);
}

const reKnownCmp = extractRegex("onetrust|optanon");
const reCookieConsent = extractRegex("\\bcookies?\\b|\\bgdpr");
const reControl = extractRegex("accept|agree|i agree");
const reAuthSignin = extractRegex("sign in|signin|sign-in|log in");
const reAuthOauth = extractRegex("wants to access|to access your");

let pass = 0, fail = 0;
function check(name, cond) { cond ? pass++ : fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); }
const L = (s) => String(s).toLowerCase();

// --- Known CMP recognition (flexibility) ---
["onetrust-banner-sdk", "optanon-alert-box", "CybotCookiebotDialog", "sp_message_container_1",
 "qc-cmp2-container", "truste-consent-track", "trustarc-banner", "didomi-popup",
 "usercentrics-root", "osano-cm-window", "sourcepoint-message", "klaro", "cookiefirst-root",
 "onetrust", "sp-ccpa", "sp-gdpr", "privacy-manager", "consent_manager", "cookie-banner",
 "funding-choices", "googlefc"].forEach((s) =>
  check(`known CMP: ${s}`, reKnownCmp.test(L(s))));
// Non-CMP class names must NOT be seen as a framework
["discussion-post", "article-body", "login-form", "gmail-compose", "nav-header"].forEach((s) =>
  check(`NOT CMP: ${s}`, !reKnownCmp.test(L(s))));

// --- Cookie-consent language (flexibility) ---
["We use cookies to improve your experience", "This site uses cookies",
 "We value your privacy", "Manage your privacy choices", "privacy preferences",
 "This relies on legitimate interest", "GDPR consent required", "Do Not Sell My Info",
 "cookie settings"].forEach((s) =>
  check(`cookie-consent text: "${s}"`, reCookieConsent.test(L(s))));
// Login / OAuth / prose must NOT read as cookie-consent
["Sign in to continue", "Enter your password", "SomeApp wants to access your Google Account",
 "This week we discuss informed consent in research ethics",
 "Continue with Google"].forEach((s) =>
  check(`NOT cookie-consent: "${s}"`, !reCookieConsent.test(L(s))));

// --- Consent control labels (short button text) ---
["Accept All", "Reject All", "Manage choices", "I Agree", "Allow all", "Only necessary",
 "Save preferences"].forEach((s) =>
  check(`consent control: "${s}"`, reControl.test(L(s))));
["Reply", "Like", "Edit", "Post", "Send", "Submit comment"].forEach((s) =>
  check(`NOT consent control: "${s}"`, !reControl.test(L(s))));

// --- Auth surface vetoes (must always be recognized so they are NOT hidden) ---
["Sign in", "Log in to your account", "Enter your password", "Choose an account",
 "Use another account", "Forgot your password", "verification code",
 "Sign up"].forEach((s) =>
  check(`auth (sign-in): "${s}"`, reAuthSignin.test(L(s))));
["SomeApp wants to access your Google Account", "This will allow SomeApp to access your email",
 "Continue with Google", "Sign in with Apple"].forEach((s) =>
  check(`auth (oauth): "${s}"`, reAuthSignin.test(L(s)) || reAuthOauth.test(L(s))));

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
