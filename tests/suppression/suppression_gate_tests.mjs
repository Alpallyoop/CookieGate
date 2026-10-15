// CookieGate — banner suppression gate tests
// Run after the workspace shell is restored:
//   cd C:\dev\cookiegate\dist\patch_v0.1.2
//   npm i jsdom
//   node suppression_gate_tests.mjs
//
// Loads the REAL banner_suppression_runtime_v32.js into a jsdom document per
// fixture and asserts that genuine cookie banners are suppressed while page
// content, login/OAuth UI, and discussion content are never touched.
//
// jsdom has no layout engine, so getBoundingClientRect is stubbed from data-w/
// data-h attributes; position/zIndex come from inline styles (which jsdom's
// getComputedStyle honors). Fixtures therefore use position:fixed/absolute
// inline styles to exercise cgIsOverlayish.

import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "..", "src", "shared", "banner_suppression_runtime_v32.js");
const CODE = readFileSync(SRC, "utf8");

const SUPPRESSED_ATTR = "data-cookiegate-banner-suppressed";

function makeChromeStub() {
  const store = {};
  const local = {
    get: (keys, cb) => { const out = {}; (Array.isArray(keys) ? keys : [keys]).forEach(k => { if (k in store) out[k] = store[k]; }); cb ? cb(out) : Promise.resolve(out); return Promise.resolve(out); },
    set: (obj, cb) => { Object.assign(store, obj); cb ? cb() : null; return Promise.resolve(); },
  };
  return { storage: { local }, runtime: { sendMessage: () => {}, lastError: null } };
}

async function runFixture({ url, html }) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  // Stub layout: rect from data-w/data-h/data-x/data-y (default large fixed area).
  window.Element.prototype.getBoundingClientRect = function () {
    const w = Number(this.getAttribute("data-w") || 600);
    const h = Number(this.getAttribute("data-h") || 200);
    const x = Number(this.getAttribute("data-x") || 0);
    const y = Number(this.getAttribute("data-y") || 0);
    return { width: w, height: h, top: y, left: x, right: x + w, bottom: y + h, x, y };
  };
  window.innerWidth = 1280; window.innerHeight = 800;
  window.chrome = makeChromeStub();
  // Execute the suppressor in the window context.
  const script = new window.Function(CODE);
  script.call(window);
  // Let boot()'s initial scan + 40ms observer settle.
  await new Promise(r => setTimeout(r, 120));
  return window;
}

function isGone(win, id) {
  const el = win.document.getElementById(id);
  if (!el) return true; // removed from DOM
  if (el.getAttribute(SUPPRESSED_ATTR) === "1") return true;
  if ((el.style && el.style.display === "none")) return true;
  return false;
}

const CASES = [
  {
    name: "OneTrust cookie banner is suppressed",
    url: "https://www.example-news.com/",
    html: `<div id="target" class="onetrust-banner-sdk" style="position:fixed;z-index:2147483647" data-w="1280" data-h="180">
      We use cookies to personalise content. <button>Accept All</button> <button>Reject All</button></div>`,
    expect: "gone",
  },
  {
    name: "Generic 'we use cookies' bar is suppressed",
    url: "https://shop.example.com/",
    html: `<div id="target" class="cc-banner" style="position:fixed;z-index:9999" data-w="1280" data-h="120">
      This site uses cookies to improve your experience. <button>Accept</button> <button>Reject</button></div>`,
    expect: "gone",
  },
  {
    name: "CNN Sourcepoint modal is suppressed",
    url: "https://www.cnn.com/",
    html: `<div id="target" class="sp_message_container_1" style="position:fixed;z-index:2147483647" data-w="1280" data-h="800">
      <div role="dialog" aria-modal="true">We and our partners use cookies and process personal data. <button>I Accept</button> <button>Manage Choices</button></div></div>`,
    expect: "gone",
  },
  {
    name: "Gmail OAuth consent is NOT hidden (host guard)",
    url: "https://accounts.google.com/o/oauth2/auth",
    html: `<div id="target" style="position:fixed;z-index:9999" data-w="500" data-h="600">
      SomeApp wants to access your Google Account. This will allow SomeApp to read your email. <button>Allow</button> <button>Cancel</button></div>`,
    expect: "kept",
  },
  {
    name: "Embedded OAuth 'sign in with Google' is NOT hidden (auth veto)",
    url: "https://www.someapp.com/",
    html: `<div id="target" style="position:fixed;z-index:9999" data-w="480" data-h="520">
      Privacy Policy and Terms apply. Continue with Google to sign in. <button>Continue with Google</button></div>`,
    expect: "kept",
  },
  {
    name: "Login modal with password field is NOT hidden",
    url: "https://portal.example.com/",
    html: `<div id="target" style="position:fixed;z-index:9999" data-w="420" data-h="480">
      <h2>Sign in</h2><input type="email"><input type="password"><button>Log in</button></div>`,
    expect: "kept",
  },
  {
    name: "Discussion board post mentioning 'informed consent' is NOT hidden",
    url: "https://lms.example.edu/discussion/123",
    html: `<div id="target" style="position:static" data-w="800" data-h="400">
      <p>This week we discuss informed consent and privacy in research ethics. Do you agree that consent must be ongoing?</p>
      <button>Reply</button> <button>Like</button> <button>Edit</button></div>`,
    expect: "kept",
  },
  {
    name: "BBC-style main content wrapper is NOT hidden",
    url: "https://www.bbc.com/",
    html: `<div id="target" style="position:absolute;z-index:1" data-w="1280" data-h="3000">
      <main><nav></nav><article>Lots of news content here about privacy, cookies, and consent in the abstract.
      ${Array.from({ length: 30 }).map((_, i) => `<a href="/story/${i}">Story ${i}</a>`).join(" ")}</article></main></div>`,
    expect: "kept",
  },
];

let pass = 0, fail = 0;
for (const c of CASES) {
  try {
    const win = await runFixture(c);
    const gone = isGone(win, "target");
    const ok = c.expect === "gone" ? gone : !gone;
    console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}  (expected ${c.expect}, ${gone ? "gone" : "kept"})`);
    ok ? pass++ : fail++;
  } catch (e) {
    console.log(`ERROR ${c.name}: ${e && e.message ? e.message : e}`);
    fail++;
  }
}
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
