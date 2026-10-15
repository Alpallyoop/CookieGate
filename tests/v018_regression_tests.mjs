// CookieGate v0.1.8 regression tests (fixes found in the 2026-10-15 audit).
// Run: node tests/v018_regression_tests.mjs   (needs jsdom: npm install)
//
//  A. Banner suppressor honours the Options toggle (cookiegate.bannerSuppression.enabled).
//  B. Per-domain banner ledgers are bounded (MAX_LEDGER_DOMAINS = 1000).
//  C. Firefox background: install/update keeps the user's toggle, records the real version.
//  D. Firefox background: browser-wide read includes partitioned cookies and retries
//     with firstPartyDomain:null under first-party isolation.
//  E. Chrome service worker: browser-wide read merges partitioned (CHIPS) cookies.
//  F. Version consistency across manifests and engine.

import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src");
const SUP = readFileSync(join(SRC, "shared", "banner_suppression_runtime_v32.js"), "utf8");
const FF_BG = readFileSync(join(SRC, "platform", "firefox", "background", "background.js"), "utf8");
const CR_SW = readFileSync(join(SRC, "platform", "chrome", "background", "service_worker_clean_v011.js"), "utf8");

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log("PASS  " + name); } else { fail++; console.log("FAIL  " + name + (extra ? "  -> " + extra : "")); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- A/B: suppressor in jsdom ---------- */
function storageStub(initial) {
  const store = Object.assign({}, initial || {});
  const local = {
    get: (keys, cb) => { const out = {}; (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in store) out[k] = store[k]; }); if (cb) cb(out); return Promise.resolve(out); },
    set: (obj, cb) => { Object.assign(store, obj); if (cb) cb(); return Promise.resolve(); },
  };
  return { store, api: { storage: { local }, runtime: { sendMessage: () => {}, lastError: null } } };
}
const BANNER = `<div id="target" class="onetrust-banner-sdk" style="position:fixed;z-index:2147483647" data-w="1280" data-h="180">
  We use cookies to personalise content. <button>Accept All</button> <button>Reject All</button></div><main><p>Article text</p></main>`;

async function runSuppressor(initialStore, url) {
  const dom = new JSDOM(`<!doctype html><html><body>${BANNER}</body></html>`, { url: url || "https://www.example-news.com/", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  window.Element.prototype.getBoundingClientRect = function () {
    const w = Number(this.getAttribute("data-w") || 600), h = Number(this.getAttribute("data-h") || 200);
    return { width: w, height: h, top: 0, left: 0, right: w, bottom: h, x: 0, y: 0 };
  };
  window.innerWidth = 1280; window.innerHeight = 800;
  const st = storageStub(initialStore);
  window.chrome = st.api;
  new window.Function(SUP).call(window);
  await sleep(200);
  const el = window.document.getElementById("target");
  const hidden = !el || el.getAttribute("data-cookiegate-banner-suppressed") === "1" || el.style.display === "none";
  // window is left open (closing it while observers are queued makes jsdom throw); process.exit ends the run.
  return { hidden, store: st.store };
}

{
  const r = await runSuppressor({});
  ok("A1 toggle absent (default) -> banner suppressed", r.hidden);
  ok("A1 ledger written when enabled", !!r.store["cookiegate.bannerSuppression.stats.v1"]);
}
{
  const r = await runSuppressor({ "cookiegate.bannerSuppression.enabled": true });
  ok("A2 toggle true -> banner suppressed", r.hidden);
}
{
  const r = await runSuppressor({ "cookiegate.bannerSuppression.enabled": false });
  ok("A3 toggle false -> banner left visible", !r.hidden);
  ok("A3 toggle false -> nothing recorded", !("cookiegate.bannerSuppression.stats.v1" in r.store) && !("cookiegate.bannerSuppression.timeline.v1" in r.store));
}
{
  // A4: switching the toggle off while a page is open stops further suppression (storage.onChanged)
  const dom = new JSDOM(`<!doctype html><html><body><main><p>Article</p></main></body></html>`, { url: "https://www.example-news.com/", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  window.Element.prototype.getBoundingClientRect = function () { const w = Number(this.getAttribute("data-w") || 600), h = Number(this.getAttribute("data-h") || 200); return { width: w, height: h, top: 0, left: 0, right: w, bottom: h, x: 0, y: 0 }; };
  window.innerWidth = 1280; window.innerHeight = 800;
  const st = storageStub({}); const listeners = [];
  st.api.storage.onChanged = { addListener: (f) => listeners.push(f) };
  window.chrome = st.api;
  new window.Function(SUP).call(window);
  await sleep(150);
  st.store["cookiegate.bannerSuppression.enabled"] = false;
  listeners.forEach((f) => f({ "cookiegate.bannerSuppression.enabled": { oldValue: true, newValue: false } }, "local"));
  window.document.body.insertAdjacentHTML("beforeend", BANNER.replace('id="target"', 'id="late"'));
  await sleep(300);
  const el = window.document.getElementById("late");
  ok("A4 toggle switched off at runtime -> later banners left visible", el && el.getAttribute("data-cookiegate-banner-suppressed") !== "1" && el.style.display !== "none");
}
{
  const stats = {}, session = {}, current = {};
  for (let i = 0; i < 1005; i++) {
    const d = "old" + String(i).padStart(4, "0") + ".example";
    const ts = "2026-01-01T00:00:" + String(i % 60).padStart(2, "0") + "." + String(i).padStart(3, "0").slice(-3) + "Z";
    stats[d] = { domain: d, scans: 1, last_scan_utc: ts }; session[d] = { domain: d, last_utc: ts }; current[d] = { domain: d, utc: ts };
  }
  const r = await runSuppressor({ "cookiegate.bannerSuppression.stats.v1": stats, "cookiegate.bannerSuppression.session.v32": session, "cookiegate.bannerSuppression.current.v1": current });
  const s = r.store["cookiegate.bannerSuppression.stats.v1"], se = r.store["cookiegate.bannerSuppression.session.v32"], cu = r.store["cookiegate.bannerSuppression.current.v1"];
  ok("B1 stats bounded to 1000 domains", Object.keys(s).length === 1000, Object.keys(s).length);
  ok("B1 session bounded to 1000 domains", Object.keys(se).length === 1000, Object.keys(se).length);
  ok("B1 current bounded to 1000 domains", Object.keys(cu).length === 1000, Object.keys(cu).length);
  ok("B2 current site kept after pruning", !!s["example-news.com"] && Number(s["example-news.com"].suppressed) > 0);
  ok("B3 newest entries kept, oldest dropped", !s["old0000.example"] && !!s["old1004.example"]);
}
{
  const small = { "a.example": { domain: "a.example", scans: 3, last_scan_utc: "2026-01-01T00:00:00Z" } };
  const r = await runSuppressor({ "cookiegate.bannerSuppression.stats.v1": small });
  const s = r.store["cookiegate.bannerSuppression.stats.v1"];
  ok("B4 under the cap nothing is dropped", !!s["a.example"] && s["a.example"].scans === 3 && !!s["example-news.com"]);
}

/* ---------- C/D: Firefox background in a vm ---------- */
function ffBackground({ store, getAll, stores, manifestVersion }) {
  const listeners = { installed: [], message: [] };
  const local = {
    get: (keys, cb) => { const out = {}; (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in store) out[k] = store[k]; }); cb(out); },
    set: (obj, cb) => { Object.assign(store, obj); if (cb) cb(); },
  };
  const cookies = {
    getAllCookieStores: () => Promise.resolve(stores || [{ id: "firefox-default" }]),
    getAll: (q) => getAll(q),
  };
  const browser = { cookies, runtime: { onMessage: { addListener: (f) => listeners.message.push(f) } } };
  const chrome = {
    runtime: { onInstalled: { addListener: (f) => listeners.installed.push(f) }, getManifest: () => ({ version: manifestVersion || "0.1.8" }), onMessage: browser.runtime.onMessage },
    storage: { local },
  };
  const ctx = vm.createContext({ chrome, browser, globalThis: {}, Promise, JSON, Object, String, Array, console });
  vm.runInContext(FF_BG, ctx);
  return listeners;
}
{
  const store = { "cookiegate.bannerSuppression.enabled": false, "cookiegate.version": "0.1.7" };
  const l = ffBackground({ store, getAll: () => Promise.resolve([]) });
  l.installed.forEach((f) => f({ reason: "update" }));
  ok("C1 update keeps the user's 'off' toggle", store["cookiegate.bannerSuppression.enabled"] === false);
  ok("C2 records the real manifest version", store["cookiegate.version"] === "0.1.8", store["cookiegate.version"]);
}
{
  const store = {};
  const l = ffBackground({ store, getAll: () => Promise.resolve([]) });
  l.installed.forEach((f) => f({ reason: "install" }));
  ok("C3 fresh install defaults suppression on", store["cookiegate.bannerSuppression.enabled"] === true);
}
async function ffRead(getAll) {
  const l = ffBackground({ store: {}, getAll });
  return await new Promise((resolve) => { const keep = l.message[0]({ type: "COOKIEGATE_BROWSER_OBSERVER_READ_ALL_COOKIES_V1" }, {}, resolve); if (keep !== true) resolve({ notAsync: true }); });
}
{
  const unpart = [{ name: "sid", domain: "a.com", path: "/", storeId: "firefox-default" }];
  const part = [{ name: "IDE", domain: ".doubleclick.net", path: "/", storeId: "firefox-default", partitionKey: { topLevelSite: "https://a.com" } }];
  const res = await ffRead((q) => Promise.resolve(q.partitionKey ? unpart.concat(part) : unpart));
  ok("D1 partitioned cookies included", res.ok && res.cookies.length === 2 && res.cookies.some((c) => c.name === "IDE"), JSON.stringify(res.cookies && res.cookies.map((c) => c.name)));
  ok("D1 no duplicates from overlapping reads", res.cookies.filter((c) => c.name === "sid").length === 1);
}
{
  const calls = [];
  const res = await ffRead((q) => { calls.push(q); if (!("firstPartyDomain" in q)) return Promise.reject(new Error("First-Party Isolation is enabled, but the required 'firstPartyDomain' attribute was not set.")); return Promise.resolve([{ name: "fpi", domain: "b.com", path: "/", storeId: "firefox-default", firstPartyDomain: "b.com" }]); });
  ok("D2 first-party isolation retry returns cookies", res.ok && res.cookies.length === 1 && res.cookies[0].name === "fpi", JSON.stringify(res));
  ok("D2 retry used firstPartyDomain:null", calls.some((q) => q.firstPartyDomain === null));
}
{
  const res = await ffRead((q) => q.partitionKey ? Promise.reject(new Error("unsupported")) : Promise.resolve([{ name: "x", domain: "c.com", path: "/", storeId: "firefox-default" }]));
  ok("D3 partitionKey unsupported -> unpartitioned list still returned", res.ok && res.cookies.length === 1);
}

/* ---------- E: Chrome service worker in a vm ---------- */
async function swRead(getAllImpl) {
  let onMsg = null;
  const chrome = {
    runtime: { onInstalled: { addListener() {} }, onMessage: { addListener: (f) => { onMsg = f; } } },
    tabs: { onUpdated: { addListener() {} }, onRemoved: { addListener() {} }, query: async () => [] },
    storage: { local: { get: async () => ({}), set: async () => {} } },
    cookies: { getAll: getAllImpl },
  };
  const ctx = vm.createContext({ chrome, console: { log() {} }, URL, Map, Set, Promise, JSON, String, Array, Boolean, Error, Date });
  vm.runInContext(CR_SW, ctx);
  return await new Promise((resolve) => onMsg({ type: "COOKIEGATE_BROWSER_OBSERVER_READ_ALL_COOKIES_V1" }, {}, resolve));
}
{
  const a = [{ name: "sid", domain: "a.com", path: "/", storeId: "0" }];
  const p = [{ name: "chips", domain: "embed.com", path: "/", storeId: "0", partitionKey: { topLevelSite: "https://a.com" } }];
  const res = await swRead(async (q) => (q && q.partitionKey ? a.concat(p) : a));
  ok("E1 CHIPS cookies merged into browser-wide read", res.ok && res.cookies.length === 2, JSON.stringify(res.cookies));
}
{
  const res = await swRead(async (q) => { if (q && q.partitionKey) throw new Error("Invalid"); return [{ name: "sid", domain: "a.com", path: "/", storeId: "0" }]; });
  ok("E2 partitionKey rejected (older Chrome) -> still ok", res.ok && res.cookies.length === 1);
}

/* ---------- F: version consistency ---------- */
{
  const crm = JSON.parse(readFileSync(join(SRC, "platform", "chrome", "manifest.json"), "utf8"));
  const ffm = JSON.parse(readFileSync(join(SRC, "platform", "firefox", "manifest.json"), "utf8"));
  const eng = readFileSync(join(SRC, "shared", "ui", "cg_engine.js"), "utf8").match(/VERSION:"([^"]+)"/)[1];
  ok("F1 Chrome/Firefox manifest + engine versions agree", crm.version === ffm.version && ffm.version === eng, [crm.version, ffm.version, eng].join(" / "));
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
