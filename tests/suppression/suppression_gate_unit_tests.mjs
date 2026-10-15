// Headless unit test of the REAL suppression gate functions.
// Extracts cgTextLower, cgConsentControlText, cgHasConsentControl, cgIsKnownCmp,
// cgMentionsCookieConsent, cgIsPageContent, cgIsOverlayish, cgIsAuthSurface
// verbatim from banner_suppression_runtime_v32.js and runs them against
// controlled element stubs, reproducing suppressCandidates' decision:
//   suppress = !pageContent && !auth && overlayish && (knownCmp || (cookie && control))
// No DOM library needed (sandbox blocks npm). Run: node suppression_gate_unit_tests.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const CODE = readFileSync(join(HERE, "..", "..", "src", "shared", "banner_suppression_runtime_v32.js"), "utf8");

function extractFn(name) {
  const sig = "function " + name + "(";
  const at = CODE.indexOf(sig);
  if (at < 0) throw new Error("fn not found: " + name);
  const open = CODE.indexOf("{", CODE.indexOf(")", at));
  let depth = 0, i = open;
  for (; i < CODE.length; i++) {
    if (CODE[i] === "{") depth++;
    else if (CODE[i] === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return CODE.slice(at, i);
}

const names = ["cgTextLower","cgConsentControlText","cgHasConsentControl","cgIsKnownCmp",
  "cgMentionsCookieConsent","cgIsPageContent","cgIsOverlayish","cgIsAuthSurface"];

// Environment stubs the functions reference.
const BODY = { nodeType: 1, __name: "body" };
const HTML = { nodeType: 1, __name: "html" };
globalThis.window = { innerWidth: 1280, innerHeight: 800 };
globalThis.document = { body: BODY, documentElement: HTML };
globalThis.getComputedStyle = (el) => (el && el.__style) || { position: "static", zIndex: "auto" };

const src = names.map(extractFn).join("\n");
const factory = new Function(src + "\nreturn {" + names.join(",") + "};");
const F = factory();

function El(o) {
  return {
    nodeType: 1,
    id: o.id || "",
    className: o.className || "",
    __text: o.text || "",
    get innerText() { return this.__text; },
    get textContent() { return this.__text; },
    __style: o.style || { position: "static", zIndex: "auto" },
    __rect: o.rect || { width: 320, height: 90 },
    __links: o.links || 0,
    __hasLandmark: !!o.hasLandmark,
    __isLandmark: !!o.isLandmark,
    __hasPassword: !!o.hasPassword,
    __controls: o.controls || [],
    __attrs: o.attrs || {},
    parentElement: o.parent || BODY,
    getAttribute(n) { return (n in this.__attrs) ? this.__attrs[n] : null; },
    getBoundingClientRect() { return this.__rect; },
    matches(sel) { return this.__isLandmark && /main|article|header|footer|nav/.test(sel); },
    querySelector(sel) {
      if (/password/.test(sel)) return this.__hasPassword ? {} : null;
      if (/main|article|header|footer|nav/.test(sel)) return this.__hasLandmark ? {} : null;
      return null;
    },
    querySelectorAll(sel) {
      // Control query is "button, a[href], [role=button], ..." — match it first.
      if (/button/.test(sel)) return this.__controls.map((t) => ({ innerText: t, textContent: t, value: "", getAttribute: () => "" }));
      if (/a\[href\]/.test(sel)) return { length: this.__links };
      return { length: 0 };
    },
  };
}

function suppressible(el) {
  if (F.cgIsPageContent(el)) return false;
  if (F.cgIsAuthSurface(el)) return false;
  if (!F.cgIsOverlayish(el)) return false;
  if (!F.cgIsKnownCmp(el) && !(F.cgMentionsCookieConsent(el) && F.cgHasConsentControl(el))) return false;
  return true;
}

const FIXED = { position: "fixed", zIndex: "2147483000" };
const STATIC = { position: "static", zIndex: "auto" };
const ABS = { position: "absolute", zIndex: "1" };

const cases = [
  { name: "OneTrust cookie banner", expect: true, el: El({ id: "onetrust-banner-sdk", text: "we use cookies to personalise content accept all reject all manage preferences", style: FIXED, controls: ["Accept All", "Reject All", "Manage Preferences"] }) },
  { name: "Generic 'we use cookies' bar", expect: true, el: El({ className: "cc-window", text: "this site uses cookies to improve your experience accept reject", style: FIXED, controls: ["Accept", "Reject"] }) },
  { name: "Sourcepoint cookie modal", expect: true, el: El({ className: "sp_message_container_1", text: "we and our partners use cookies and process personal data i accept manage choices", style: FIXED, controls: ["I Accept", "Manage Choices"] }) },
  { name: "Gmail OAuth 'Allow access'", expect: false, el: El({ text: "someapp wants to access your google account this will allow someapp to read your email allow cancel", style: FIXED, controls: ["Allow", "Cancel"] }) },
  { name: "Login modal (password)", expect: false, el: El({ text: "sign in enter your password forgot your password", style: FIXED, hasPassword: true, controls: ["Log in"] }) },
  { name: "Discussion post ('informed consent')", expect: false, el: El({ text: "week 4 informed consent and privacy in research ethics do you agree reply", style: STATIC, controls: ["Reply", "Like", "Edit"], links: 2 }) },
  { name: "BBC-style main content", expect: false, el: El({ text: "privacy cookies and consent explained long article", style: ABS, rect: { width: 1280, height: 3000 }, hasLandmark: true, links: 25 }) },
  { name: "Footer privacy links", expect: false, el: El({ className: "site-footer", text: "privacy policy cookie policy terms", style: STATIC, isLandmark: true, links: 3 }) },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const got = suppressible(c.el);
  const ok = got === c.expect;
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}  (expected ${c.expect ? "hide" : "keep"}, got ${got ? "hide" : "keep"})`);
}
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
