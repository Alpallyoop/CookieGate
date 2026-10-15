// Headless end-to-end tests for the REAL v0.1.6 popup (popup.html + cg_engine.js + popup.js).
// A minimal DOM + HTML parser (the sandbox blocks npm, so no jsdom) and a mock browser API
// (cookie jar, storage, tabs, runtime messaging, browsingData). Each scenario runs twice:
// Chrome callback-style API and Firefox promise-style API. Run: node popup_headless_tests.mjs
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI = join(HERE, "..", "src", "shared", "ui");
const HTML = readFileSync(join(UI, "popup.html"), "utf8");
const ENGINE = readFileSync(join(UI, "cg_engine.js"), "utf8");
const POPUP = readFileSync(join(UI, "popup.js"), "utf8");

/* ---------------- minimal DOM ---------------- */
class TextNode { constructor(t){ this.nodeType = 3; this.data = String(t); this.parentNode = null; } get textContent(){ return this.data; } set textContent(v){ this.data = String(v); } }
class ClassList {
  constructor(el){ this.el = el; }
  _g(){ return (this.el.getAttribute("class") || "").split(/\s+/).filter(Boolean); } _s(a){ this.el.setAttribute("class", a.join(" ")); }
  add(...c){ const a = this._g(); c.forEach(x => { if(!a.includes(x)) a.push(x); }); this._s(a); }
  remove(...c){ this._s(this._g().filter(x => !c.includes(x))); }
  toggle(c, f){ const has = this._g().includes(c), want = f === undefined ? !has : !!f; if(want && !has) this.add(c); if(!want && has) this.remove(c); return want; }
  contains(c){ return this._g().includes(c); }
}
class El {
  constructor(tag, doc){ this.nodeType = 1; this.localName = tag.toLowerCase(); this.tagName = tag.toUpperCase(); this.childNodes = []; this.parentNode = null; this.attributes = {}; this.style = {}; this._l = {}; this.classList = new ClassList(this); this.ownerDocument = doc; this._value = ""; this._checked = false; this._disabled = false; }
  getAttribute(n){ return Object.prototype.hasOwnProperty.call(this.attributes, n) ? this.attributes[n] : null; }
  setAttribute(n, v){ this.attributes[n] = String(v); if(n === "style") String(v).split(";").forEach(p => { const i = p.indexOf(":"); if(i > 0) this.style[p.slice(0, i).trim()] = p.slice(i + 1).trim(); }); if(n === "checked") this._checked = true; if(n === "disabled") this._disabled = true; if(n === "value") this._value = String(v); }
  hasAttribute(n){ return this.getAttribute(n) !== null; } removeAttribute(n){ delete this.attributes[n]; }
  get id(){ return this.getAttribute("id") || ""; } set id(v){ this.setAttribute("id", v); }
  get className(){ return this.getAttribute("class") || ""; } set className(v){ this.setAttribute("class", v); }
  get type(){ return this.getAttribute("type") || ""; } set type(v){ this.setAttribute("type", v); }
  get title(){ return this.getAttribute("title") || ""; } set title(v){ this.setAttribute("title", v); }
  get href(){ return this.getAttribute("href") || ""; } set href(v){ this.setAttribute("href", v); }
  get download(){ return this.getAttribute("download") || ""; } set download(v){ this.setAttribute("download", v); }
  get value(){ return this._value; } set value(v){ this._value = String(v); }
  get checked(){ return this._checked; } set checked(v){ this._checked = !!v; }
  get disabled(){ return this._disabled; } set disabled(v){ this._disabled = !!v; }
  get firstChild(){ return this.childNodes[0] || null; }
  get children(){ return this.childNodes.filter(n => n.nodeType === 1); }
  appendChild(n){ if(n.parentNode) n.parentNode.removeChild(n); this.childNodes.push(n); n.parentNode = this; return n; }
  removeChild(n){ const i = this.childNodes.indexOf(n); if(i >= 0){ this.childNodes.splice(i, 1); n.parentNode = null; } return n; }
  remove(){ if(this.parentNode) this.parentNode.removeChild(this); }
  get textContent(){ return this.childNodes.map(n => n.textContent).join(""); }
  set textContent(v){ this.childNodes.forEach(n => n.parentNode = null); this.childNodes = []; if(v !== "" && v != null) this.appendChild(new TextNode(v)); }
  addEventListener(t, fn){ (this._l[t] = this._l[t] || []).push(fn); }
  removeEventListener(t, fn){ this._l[t] = (this._l[t] || []).filter(f => f !== fn); }
  fire(t, extra){ const ev = Object.assign({ type:t, target:this, currentTarget:this, stopPropagation(){}, preventDefault(){} }, extra || {}); return Promise.all((this._l[t] || []).slice().map(fn => Promise.resolve(fn.call(this, ev)))); }
  click(){ return this.fire("click"); }
  focus(){} blur(){}
  getBoundingClientRect(){ return { left:0, top:0, right:0, bottom:0, width:0, height:0 }; }
  get offsetWidth(){ return 0; } get offsetHeight(){ return 0; }
  *walk(){ for(const c of this.childNodes){ if(c.nodeType === 1){ yield c; yield* c.walk(); } } }
  querySelectorAll(sel){ return qsa(this, sel); } querySelector(sel){ return this.querySelectorAll(sel)[0] || null; }
}
function simpleMatch(el, s){
  const m = s.match(/^([a-zA-Z0-9-]*)((?:[#.][a-zA-Z0-9_-]+)*)$/); if(!m) return false;
  if(m[1] && el.localName !== m[1].toLowerCase()) return false;
  const parts = m[2].match(/[#.][a-zA-Z0-9_-]+/g) || [];
  return parts.every(p => p[0] === "#" ? el.id === p.slice(1) : el.classList.contains(p.slice(1)));
}
function qsa(root, sel){
  const out = [];
  for(const one of sel.split(",").map(s => s.trim()).filter(Boolean)){
    const chain = one.split(/\s+/);
    for(const el of root.walk()){
      if(!simpleMatch(el, chain[chain.length - 1])) continue;
      let i = chain.length - 2, p = el.parentNode, ok = true;
      while(i >= 0){ while(p && p.nodeType === 1 && !simpleMatch(p, chain[i])) p = p.parentNode; if(!p || p.nodeType !== 1){ ok = false; break; } i--; p = p.parentNode; }
      if(ok && !out.includes(el)) out.push(el);
    }
  }
  return out;
}
class Doc {
  constructor(){ this.documentElement = new El("html", this); this.body = null; this.readyState = "complete"; this._l = {}; }
  createElement(t){ return new El(t, this); } createElementNS(ns, t){ const e = new El(t, this); e.namespaceURI = ns; return e; } createTextNode(t){ return new TextNode(t); }
  getElementById(id){ for(const e of this.documentElement.walk()) if(e.id === id) return e; return null; }
  querySelectorAll(sel){ return qsa(this.documentElement, sel); }
  addEventListener(t, fn){ (this._l[t] = this._l[t] || []).push(fn); }
  fire(t, extra){ const ev = Object.assign({ type:t, stopPropagation(){}, preventDefault(){} }, extra || {}); (this._l[t] || []).forEach(fn => fn(ev)); }
}
const VOID = new Set(["meta","link","input","br","img","hr","area","base","col","embed","source","track","wbr"]);
function decode(s){ return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'"); }
function parseInto(doc, html){
  const re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/gi;
  const stack = []; let m;
  const top = () => stack[stack.length - 1];
  while((m = re.exec(html))){
    if(m[5] !== undefined){ if(top() && m[5].trim()) top().appendChild(new TextNode(decode(m[5].replace(/\s+/g, " ")))); continue; }
    if(!m[2]) continue;
    const tag = m[2].toLowerCase();
    if(m[1]){ while(stack.length && stack[stack.length - 1].localName !== tag) stack.pop(); stack.pop(); continue; }
    const el = tag === "html" ? doc.documentElement : new El(tag, doc);
    const ar = /([^\s=>\/]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g; let a;
    while((a = ar.exec(m[3] || ""))){ let v = a[2] === undefined ? "" : a[2]; if(/^["']/.test(v)) v = v.slice(1, -1); el.setAttribute(a[1], decode(v)); }
    if(tag !== "html" && top()) top().appendChild(el);
    if(tag === "body") doc.body = el;
    if(!(VOID.has(tag) || m[4] === "/")) stack.push(el);
  }
}

/* ---------------- mock browser ---------------- */
function mkCookie(name, domain, o){ return Object.assign({ name, domain, path:"/", secure:true, httpOnly:false, session:false, hostOnly:false, storeId:"0", value:"RAWVAL-" + name + "-" + domain }, o || {}); }
function makeJar(){
  const cnn = ["sendAuthToken","sendAuthToken2","isInAuthTokenExperiment","optimizelySession","resolveAuthTimestamp","WMUKID_STABLE","_ga","_ga_XJ4T","_gid","_gcl_au","_fbp","fr","s_ecid","AMCV_7FF8","AMCVS_7FF8","s_cc","s_sq","_cb","_cb_svref","_chartbeat2","_v__chartbeat3","_pcid","_pctx","cX_P","cX_G","_sp_ses.f5fb","_sp_id.f5fb","countryCode","stateCode","OptanonAlertBoxClosed","wbdLTP","datid","CDPID","sendWMSegs","FastAB","FastAB_Zion","umto","sato","psmPageLoadId","g_state","SecGpc","usprivacy","__idcontext","nexus-web-app-id","_pc_may_test_group"];
  const jar = cnn.map(n => mkCookie(n, n === "umto" || n === "g_state" ? "www.cnn.com" : ".cnn.com", { session: n === "sato" || n === "AMCVS_7FF8" || n === "_sp_ses.f5fb", httpOnly: n.indexOf("Auth") >= 0 }));
  jar.push(mkCookie("sp", "collector.cdp.cnn.com", { secure:false }));
  ["ckns_policy","ckns_explicit","_ga","_gid","atuserid","ecos.dt","ckpf_ppid","_cb","s_ecid","BBC-UID"].forEach(n => jar.push(mkCookie(n, ".bbc.com")));
  ["SID","HSID","SSID","APISID","SAPISID","__Secure-3PSID","NID","AEC"].forEach(n => jar.push(mkCookie(n, ".google.com")));
  ["_ga","_fbp","_uetsid","_ttp","dsg_session","cart_id"].forEach(n => jar.push(mkCookie(n, ".dickssportinggoods.com")));
  return jar;
}
function makeApi(env){
  const done = (cb, v) => { if(env.promise) return Promise.resolve(v); setTimeout(() => cb && cb(v), 0); };
  const copy = o => JSON.parse(JSON.stringify(o));
  return {
    tabs:{ query(q, cb){ return done(cb, [{ url:env.tabUrl, active:true }]); } },
    cookies:{
      getAll(q, cb){ let list = env.jar.slice(); if(q && q.domain){ const d = q.domain.toLowerCase(); list = list.filter(c => { const cd = c.domain.replace(/^\./, "").toLowerCase(); return cd === d || cd.endsWith("." + d); }); } return done(cb, list.map(c => Object.assign({}, c))); },
      remove(det, cb){ env.removeCalls.push(det); const u = new URL(det.url); const i = env.jar.findIndex(c => c.name === det.name && c.domain.replace(/^\./, "") === u.hostname && (c.path || "/") === u.pathname && (!det.storeId || c.storeId === det.storeId));
        let r = null; if(i >= 0 && !(env.sticky || []).includes(det.name)){ const gone = env.jar.splice(i, 1)[0]; if((env.respawn || []).includes(det.name)) env.jar.push(Object.assign({}, gone)); r = { name:det.name, url:det.url, storeId:det.storeId || "0" }; } return done(cb, r); }
    },
    storage:{ local:{
      get(keys, cb){ const o = {}; (Array.isArray(keys) ? keys : [keys]).forEach(k => { if(k in env.local) o[k] = copy(env.local[k]); }); return done(cb, o); },
      set(obj, cb){ Object.assign(env.local, copy(obj)); return done(cb, undefined); } } },
    runtime:{ lastError:undefined, sendMessage(msg, cb){ return done(cb, msg && msg.type === "COOKIEGATE_BROWSER_OBSERVER_READ_ALL_COOKIES_V1" ? { ok:true, cookies:env.jar.map(c => Object.assign({}, c)) } : undefined); } },
    browsingData:{ remove(a, b, cb){ env.cacheCleared = true; return done(cb, undefined); } }
  };
}
async function boot({ promise, tabUrl, local, ls }){
  const doc = new Doc(); parseInto(doc, HTML);
  const env = { promise, tabUrl, jar:makeJar(), local:Object.assign({}, local || {}), removeCalls:[], downloads:[], sticky:[], respawn:[] };
  const store = new Map(Object.entries(ls || {}));
  class CaptureBlob { constructor(parts){ this.text = parts.join(""); } }
  class U extends URL { static createObjectURL(b){ env.downloads.push(b.text); return "blob:test"; } static revokeObjectURL(){} }
  const win = { document:doc, innerWidth:380, innerHeight:600, console, setTimeout, clearTimeout, Promise, JSON, Math, Date, Object, Array, String, Number, Blob:CaptureBlob, URL:U,
    localStorage:{ getItem:k => store.has(k) ? store.get(k) : null, setItem:(k, v) => store.set(k, String(v)), removeItem:k => store.delete(k) } };
  win.window = win; win.self = win; win.globalThis = win;
  if(promise) win.browser = makeApi(env); else win.chrome = makeApi(env);
  const ctx = vm.createContext(win);
  vm.runInContext(ENGINE, ctx, { filename:"cg_engine.js" });
  vm.runInContext(POPUP, ctx, { filename:"popup.js" });
  await flush();
  return { doc, env, store, E:win.CookieGateEngine, $:id => doc.getElementById(id) };
}
const flush = async (n = 12) => { for(let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 2)); };
const hidden = el => el.classList.contains("hide");

/* ---------------- scenarios ---------------- */
let pass = 0, fail = 0; const fails = [];
function ok(label, cond, info){ if(cond) pass++; else { fail++; fails.push(label + (info !== undefined ? "  → " + JSON.stringify(info) : "")); } }

async function scenarioSite(mode){
  const T = await boot({ promise: mode === "firefox", tabUrl:"https://www.cnn.com/politics" });
  const { $, env, E } = T, tag = "[" + mode + "] ";
  const cnnJar = () => env.jar.filter(c => E.cookieBelongsTo(c.domain, "cnn.com"));
  const startCnn = cnnJar().length;
  const expectedClean = cnnJar().filter(c => E.cleanRemoves(c, E.classify(c, "cnn.com").cls, "strict", false)).length;
  ok(tag + "opens in dark mode by default", T.doc.documentElement.getAttribute("data-theme") === "dark" && $("themeBtn").textContent === "Light");
  ok(tag + "header shows cnn.com", $("domName").textContent === "cnn.com", $("domName").textContent);
  ok(tag + "subtitle Active site", $("topSub").textContent === "Active site", $("topSub").textContent);
  ok(tag + "total equals jar", $("sTot").textContent === String(startCnn), [$("sTot").textContent, startCnn]);
  ok(tag + "clean button count", $("clean").textContent === "Clean " + expectedClean + " cookies on cnn.com", $("clean").textContent);
  ok(tag + "4 category chips", $("sChips").querySelectorAll("button").length === 4);
  ok(tag + "bar segments rendered", $("sBar").children.length >= 3, $("sBar").children.length);
  ok(tag + "only site+browser tabs", T.doc.querySelectorAll("#tabs button").length === 2);
  ok(tag + "site tab visible on web page", !hidden($("tabSite")));

  // Category drawer
  const trkChip = $("sChips").querySelectorAll("button")[1];
  await trkChip.click(); await flush(2);
  ok(tag + "drawer opens on chip click", !hidden($("drawer")));
  ok(tag + "drawer capped at 6 rows", $("dList").querySelectorAll(".ck").length === 6, $("dList").querySelectorAll(".ck").length);
  ok(tag + "drawer has show-more", $("dList").querySelectorAll(".more").length === 1);
  await $("dList").querySelectorAll(".more")[0].click(); await flush(2);
  ok(tag + "show more expands", $("dList").querySelectorAll(".ck").length > 6);
  ok(tag + "show fewer appears", $("dList").querySelectorAll(".more").some(b => b.textContent === "Show fewer"));
  await $("dClose").click(); await flush(2);
  ok(tag + "drawer closes", hidden($("drawer")));

  // Mode slider
  const sl = m => $("slider").querySelectorAll("button").find(b => b.getAttribute("data-m") === m);
  await sl("balanced").click(); await flush(4);
  const expBal = cnnJar().filter(c => E.cleanRemoves(c, E.classify(c, "cnn.com").cls, "balanced", false)).length;
  ok(tag + "balanced recount", $("clean").textContent === "Clean " + expBal + " cookies on cnn.com", $("clean").textContent);
  ok(tag + "not-saved tag after change", $("sLine").textContent.includes("not saved"), $("sLine").textContent);
  await sl("trusted").click(); await flush(4);
  ok(tag + "trusted cleans nothing", $("clean").textContent === "Trusted mode — nothing to clean" && $("clean").disabled, $("clean").textContent);
  await sl("strict").click(); await flush(4);

  // Remember for site
  $("remember").checked = true; await $("remember").fire("change"); await flush(6);
  ok(tag + "site mode saved (new store)", env.local.cookiegateSiteModes && env.local.cookiegateSiteModes["cnn.com"] === "strict", env.local.cookiegateSiteModes);
  ok(tag + "site mode saved for tab host", env.local.cookiegateSiteModes["www.cnn.com"] === "strict");
  ok(tag + "legacy siteMode key written", T.store.get("cookiegate.siteMode:cnn.com") === "strict");
  const rules = JSON.parse(T.store.get("cookiegate.domainRules.v1") || "{}");
  ok(tag + "legacy domain rule written", rules["cnn.com"] && rules["cnn.com"].mode === "strict" && rules["cnn.com"].schema === "cookiegate.domain_rule.v48");
  ok(tag + "evidence site_mode_set", (env.local.cookiegateEvidenceLog || []).some(r => r.event_type === "cookiegate.policy.site_mode_set.v1"));
  ok(tag + "saved tag shown", $("sLine").textContent.includes("saved for this site"));

  // Pin a tracking cookie (keep always)
  await trkChip.click(); await flush(2);
  const firstPin = $("dList").querySelectorAll(".pin")[0];
  await firstPin.click(); await flush(6);
  const keepRules = env.local.cookiegateKeepRules || {};
  const pinnedKeys = Object.values(keepRules).flatMap(o => Object.keys(o));
  ok(tag + "keep rule stored", pinnedKeys.length === 1, keepRules);
  ok(tag + "clean count drops by pinned", $("clean").textContent === "Clean " + (expectedClean - 1) + " cookies on cnn.com", $("clean").textContent);

  // Clean: two-tap confirm
  const loginsBefore = cnnJar().filter(c => E.classify(c, "cnn.com").group === "auth").length;
  await $("clean").click(); await flush(2);
  ok(tag + "first tap arms", $("clean").textContent.startsWith("Tap again to remove"), $("clean").textContent);
  ok(tag + "nothing removed on first tap", env.removeCalls.length === 0);
  await $("clean").click(); await flush(30);
  ok(tag + "removed expected cookies", startCnn - cnnJar().length === expectedClean - 1, [startCnn, cnnJar().length, expectedClean]);
  ok(tag + "logins untouched by clean", cnnJar().filter(c => E.classify(c, "cnn.com").group === "auth").length === loginsBefore);
  ok(tag + "pinned cookie survived", cnnJar().some(c => pinnedKeys.includes(E.cookieKey(c))));
  ok(tag + "delete evidence written", (env.local.cookiegateEvidenceLog || []).filter(r => r.event_type === "cookiegate.cookie.delete.v1").length === expectedClean - 1);
  ok(tag + "toast confirms", $("toast").textContent.startsWith("Removed " + (expectedClean - 1) + " cookies on cnn.com"), $("toast").textContent);
  ok(tag + "removal used secure https url", env.removeCalls.every(d => /^https?:\/\//.test(d.url) && d.name));

  // Wipe sheet — default keeps logins
  await $("wipe").click(); await flush(2);
  ok(tag + "wipe opens confirm sheet", !hidden($("sheet")));
  ok(tag + "sheet offers include-logins", !hidden($("shOptWrap")));
  const before = cnnJar().length;
  await $("shGo").click(); await flush(30);
  ok(tag + "wipe kept logins", cnnJar().filter(c => E.classify(c, "cnn.com").group === "auth").length === loginsBefore, cnnJar().map(c => c.name));
  ok(tag + "wipe removed non-logins", cnnJar().length < before);
  // Wipe including logins
  await $("wipe").click(); await flush(2);
  $("shOpt").checked = true; await $("shOpt").fire("change"); await flush(2);
  ok(tag + "sheet text warns sign-out", $("shText").textContent.includes("signed out"), $("shText").textContent);
  await $("shGo").click(); await flush(30);
  ok(tag + "explicit wipe removes logins too (except pinned)", cnnJar().every(c => pinnedKeys.includes(E.cookieKey(c))), cnnJar().map(c => c.name));

  // Search: cookies, then a domain
  $("q").value = "chart"; await $("q").fire("input", { target:$("q") }); await flush(4);
  ok(tag + "search hides summary", hidden($("siteContent")) && !hidden($("results")));
  $("q").value = "bbc"; await $("q").fire("input", { target:$("q") }); await flush(10);
  ok(tag + "search lists bbc.com site", $("results").querySelectorAll(".srow").some(r => r.textContent.includes("bbc.com")), $("results").textContent.slice(0, 200));
  await $("q").fire("keydown", { key:"Enter" }); await flush(10);
  ok(tag + "enter opens bbc.com", $("domName").textContent === "bbc.com", $("domName").textContent);
  ok(tag + "marked as search result", $("topSub").textContent.startsWith("Search result"), $("topSub").textContent);
  ok(tag + "back banner shown", !hidden($("back")) && $("backBtn").textContent === "← Back to cnn.com");
  ok(tag + "bbc total", $("sTot").textContent === "10", $("sTot").textContent);
  $("q").value = "https://www.example.org/some/path"; await $("q").fire("input", { target:$("q") }); await flush(4);
  ok(tag + "unknown typed domain offered", $("results").querySelectorAll(".srow").some(r => r.textContent.includes("example.org") && r.textContent.includes("no cookies stored")));
  await $("qx").click(); await flush(2);
  await $("backBtn").click(); await flush(10);
  ok(tag + "back returns to cnn.com", $("domName").textContent === "cnn.com");

  // Browser tab
  await $("tabBrowser").click(); await flush(10);
  ok(tag + "browser view shown", !hidden($("vBrowser")) && hidden($("vSite")));
  ok(tag + "CTA hidden on browser tab", hidden($("cta")));
  ok(tag + "ring drawn (only here)", $("ring").children.length >= 3 && T.doc.querySelectorAll("#vSite .gauge").length === 0 && T.doc.querySelectorAll("#vBrowser .gauge").length === 1, [$("ring").children.length]);
  ok(tag + "browser total", $("bTot").textContent === String(env.jar.length), [$("bTot").textContent, env.jar.length]);
  ok(tag + "top sites listed", $("oSites").querySelectorAll(".site").length >= 1);
  // Export browser JSON
  await $("exportBrowser").click(); await flush(6);
  const exp = JSON.parse(env.downloads[env.downloads.length - 1] || "{}");
  ok(tag + "export schema v3", exp.schema === "cookiegate.browser_observer.v3" && exp.privacy && exp.privacy.rawCookieValuesExported === false);
  ok(tag + "export has all cookies", exp.cookies && exp.cookies.length === env.jar.length);
  ok(tag + "export never contains raw values", !env.downloads.join("").includes("RAWVAL-"));
  ok(tag + "export analysis shape", exp.analysis && exp.analysis.byClass && "authSession" in exp.analysis.byClass && Array.isArray(exp.analysis.topDomains));
  // Clean all sites (with cache)
  const gBefore = env.jar.filter(c => E.classify(c, E.rootDomain(c.domain)).group === "auth").length;
  await $("cleanAll").click(); await flush(2);
  ok(tag + "clean-all asks first", !hidden($("sheet")));
  $("shOpt").checked = true; await $("shOpt").fire("change");
  await $("shGo").click(); await flush(40);
  ok(tag + "clean-all kept logins", env.jar.filter(c => E.classify(c, E.rootDomain(c.domain)).group === "auth").length === gBefore);
  ok(tag + "cache cleared when chosen", env.cacheCleared === true);
  // Open a site from the browser list
  const siteBtn = $("oSites").querySelectorAll(".site")[0];
  if(siteBtn){ await siteBtn.click(); await flush(10); ok(tag + "site row opens site view", !hidden($("vSite"))); }

  // Theme
  await $("themeBtn").click(); await flush(2);
  ok(tag + "switches to light and remembers it", T.doc.documentElement.getAttribute("data-theme") === "light" && T.store.get("cookiegate.ui.theme.v2") === "light");
  ok(tag + "theme button label flips", $("themeBtn").textContent === "Dark");
  // Site export
  await $("tabSite").click(); await flush(6);
  await $("exportSite").click(); await flush(6);
  const sp = JSON.parse(env.downloads[env.downloads.length - 1] || "{}");
  ok(tag + "site package schema", sp.schema === "cookiegate.site_package.v1" && sp.privacy && sp.privacy.valueHandling === "valueHashPreview only");
  ok(tag + "no innerHTML used", !/\.innerHTML\s*=/.test(POPUP));
}

async function scenarioNonWeb(mode){
  const T = await boot({ promise: mode === "firefox", tabUrl:"about:newtab" });
  const { $ } = T, tag = "[" + mode + " non-web] ";
  ok(tag + "site tab hidden", hidden($("tabSite")));
  ok(tag + "browser view shown", !hidden($("vBrowser")) && hidden($("vSite")));
  ok(tag + "header says browser page", $("topSub").textContent.startsWith("Browser page"), $("topSub").textContent);
  ok(tag + "no clean CTA", hidden($("cta")));
}

async function scenarioLegacySettings(mode){
  // A user upgrading from v0.1.5 (Firefox popup stored modes in localStorage; Chrome SW in storage.local).
  const T = await boot({ promise: mode === "firefox", tabUrl:"https://www.bbc.com/", local:{ cookiegateGlobalMode:"balanced" }, ls:{ "cookiegate.siteMode:www.bbc.com":"trusted" } });
  const { $ } = T, tag = "[" + mode + " legacy] ";
  ok(tag + "legacy site mode honored", $("slabels").querySelectorAll("span").find(s => s.classList.contains("on")).textContent === "Trusted");
  ok(tag + "global default from storage", $("defLine").textContent.startsWith("Default for all sites: Balanced"), $("defLine").textContent);
  ok(tag + "remember switch reflects saved mode", $("remember").checked === true);
}

async function scenarioExplain(mode){
  // A site that re-creates _ga instantly (open page) and a cookie the browser refuses to remove.
  const T = await boot({ promise: mode === "firefox", tabUrl:"https://www.cnn.com/", ls:{ "cookiegate.ui.theme":"light" } });
  const { $, env, E } = T, tag = "[" + mode + " explain] ";
  ok(tag + "old saved light theme ignored, starts dark", T.doc.documentElement.getAttribute("data-theme") === "dark");
  env.respawn = ["_ga"]; env.sticky = ["_gid"];
  const n = env.jar.filter(c => E.cookieBelongsTo(c.domain, "cnn.com") && E.cleanRemoves(c, E.classify(c, "cnn.com").cls, "strict", false)).length;
  await $("clean").click(); await flush(2); await $("clean").click(); await flush(40);
  const msg = $("toast").textContent;
  ok(tag + "says how many were removed", msg.startsWith("Removed " + (n - 1) + " cookies on cnn.com."), msg);
  ok(tag + "names the re-created cookie and why", msg.includes("(_ga)") && msg.includes("set again right away") && msg.includes("Close or reload the tab"), msg);
  ok(tag + "names the cookie that failed and why", msg.includes("could not be removed: _gid (the browser refused to remove it)"), msg);
  ok(tag + "shown as a warning", $("toast").classList.contains("warn"));
  ok(tag + "button reflects what is left", $("clean").textContent === "Clean 2 cookies on cnn.com", $("clean").textContent);
  ok(tag + "retried alternate URL before giving up", env.removeCalls.filter(d => d.name === "_gid").length >= 2);
  ok(tag + "re-creation recorded as evidence", (env.local.cookiegateEvidenceLog || []).some(r => r.event_type === "cookiegate.cookie.recreated.v1" && r.payload.name === "_ga"));
}
for(const mode of ["chrome","firefox"]){ await scenarioSite(mode); await scenarioNonWeb(mode); await scenarioLegacySettings(mode); await scenarioExplain(mode); }
console.log(`${pass}/${pass + fail} checks passed`);
if(fail){ console.log("FAILURES:"); fails.forEach(f => console.log("  " + f)); process.exit(1); }
