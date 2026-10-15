/* CookieGate popup v0.1.8 — design D (unified), wired to the real browser APIs.
 * Engine (classification / policy / export shapes): ui/cg_engine.js
 * Preserved contracts: cookiegateGlobalMode, cookiegateSiteModes, cookiegateKeepRules,
 * cookiegateEvidenceLog (chrome.storage.local); cookiegate.globalMode,
 * cookiegate.siteMode:<host>, cookiegate.domainRules.v1 (localStorage);
 * export schemas cookiegate.browser_observer.v3 and cookiegate.site_package.v1;
 * evidence cookiegate.cookie.delete.v1 / cookiegate.policy.*.v1.
 * Nothing is ever deleted without an explicit tap; logins are preserved unless the
 * user explicitly includes them; raw cookie values are never shown or exported. */
(function(){
  "use strict";

  var E = window.CookieGateEngine;
  var api = (typeof browser !== "undefined") ? browser : (typeof chrome !== "undefined" ? chrome : null);
  var PROMISE_API = (typeof browser !== "undefined");

  /* ---------- API helpers (promise + callback styles) ---------- */
  function call(ns, method, args){
    return new Promise(function(resolve){
      try {
        if(!ns || typeof ns[method] !== "function"){ resolve(undefined); return; }
        if(PROMISE_API){ Promise.resolve(ns[method].apply(ns, args || [])).then(resolve, function(){ resolve(undefined); }); return; }
        ns[method].apply(ns, (args || []).concat([function(r){
          try { if(api.runtime && api.runtime.lastError){ resolve(undefined); return; } } catch(e){}
          resolve(r);
        }]));
      } catch(e){ resolve(undefined); }
    });
  }
  function store(){ return api && api.storage && api.storage.local; }
  function sget(keys){ return call(store(), "get", [keys]).then(function(r){ return r || {}; }); }
  function sset(obj){ return call(store(), "set", [obj]); }
  function lsGet(k){ try { return localStorage.getItem(k); } catch(e){ return null; } }
  function lsSet(k, v){ try { if(v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch(e){} }
  function lsJson(k, f){ try { var r = localStorage.getItem(k); var v = r ? JSON.parse(r) : f; return (v && typeof v === "object" && !Array.isArray(v)) ? v : f; } catch(e){ return f; } }

  /* ---------- constants ---------- */
  var GROUPS = ["auth","trk","pref","unk"];
  var NAME = { auth:"Logins & security", trk:"Tracking", pref:"Preferences", unk:"Unknown" };
  var SHORT = { auth:"Logins", trk:"Tracking", pref:"Preferences", unk:"Unknown" };
  var WHY = {
    auth:"Sign-in, session or security cookies. Clean never removes them; Wipe keeps them unless you include logins.",
    trk:"Matches a known analytics or advertising tracker signature.",
    pref:"Stores a site setting such as language, region or your cookie-consent choice.",
    unk:"No known pattern. Third-party ones are removed in Strict and Balanced; first-party ones are kept for review."
  };
  var COL_L = { auth:"#16a34a", trk:"#dc2626", pref:"#6366f1", unk:"#d97706" };
  var COL_D = { auth:"#34d399", trk:"#f87171", pref:"#a5b4fc", unk:"#fbbf24" };
  var COL = COL_L;
  var MDESC = {
    strict:"removes trackers, third-party and preference cookies. Logins and security cookies stay; unknown first-party cookies are kept for review.",
    balanced:"removes trackers and third-party cookies. Preferences and logins stay.",
    trusted:"keeps every cookie on this site. Use Wipe if you want to clear it manually."
  };
  var POS = { trusted:0, balanced:50, strict:100 };
  var STATUS = { remove:["remove","rm"], keep:["keep","kp"], review:["review","rv"], always:["always","al"] };
  var POLICY_TEXT = { "delete-on-exit":"Removed when you tap Clean", "review":"Kept for review (not removed by Clean)", "allow-session":"Kept until the browser closes",
    "allow-until-exit":"Kept", "allow-persistent":"Kept", "keep-always":"Always kept (pinned)" };

  /* ---------- state ---------- */
  var S = { tabUrl:"", tabHost:"", activeRoot:"", isWeb:false, viewing:"", items:[], loading:false,
    globalMode:"strict", siteModes:{}, keepRules:{}, domainRules:{}, bannerStats:{},
    vmode:"strict", openCat:null, lim:6, q:"", flash:null, view:"site", theme:"dark",
    browser:null, browserItems:null, browserLoading:false, siteIdx:null, bwLim:5,
    armed:false, armTimer:null, busy:false, sheet:null };

  /* ---------- DOM helpers ---------- */
  function $(id){ return document.getElementById(id); }
  function el(tag, cls, text){ var e = document.createElement(tag); if(cls) e.className = cls; if(text !== undefined && text !== null) e.textContent = String(text); return e; }
  function clear(n){ while(n && n.firstChild) n.removeChild(n.firstChild); }
  function txt(s){ return document.createTextNode(String(s)); }
  var SVGNS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs){ var e = document.createElementNS(SVGNS, tag); for(var k in attrs){ if(Object.prototype.hasOwnProperty.call(attrs, k)) e.setAttribute(k, attrs[k]); } return e; }
  var ICON = {
    moon:["M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"],
    sun:["M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8z","M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"],
    shield:["M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z","M9 12l2 2 4-4"],
    pin:["M12 17v5","M8 3h8l-1.5 6L18 12H6l3.5-3z"]
  };
  function icon(name){ var s = svgEl("svg", { viewBox:"0 0 24 24", fill:"none", stroke:"currentColor", "stroke-width":"2", "stroke-linecap":"round", "stroke-linejoin":"round", "aria-hidden":"true" }); ICON[name].forEach(function(d){ s.appendChild(svgEl("path", { d:d })); }); return s; }
  function cap(s){ return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function plural(n, one, many){ return n + " " + (n === 1 ? one : (many || one + "s")); }
  function favColor(d){ var h = 0; for(var i = 0; i < d.length; i++) h = (h * 31 + d.charCodeAt(i)) >>> 0; return "hsl(" + (h % 360) + ",52%,42%)"; }
  function hostFrom(url){ try { return new URL(url).hostname.toLowerCase(); } catch(e){ return ""; } }

  /* ---------- tooltip ---------- */
  var tipEl = $("tip");
  function buildTip(spec){
    clear(tipEl);
    var h = el("div", "h"); h.appendChild(el("span", null, spec.title));
    if(spec.tag) h.appendChild(el("span", "tg " + spec.tag[1], spec.tag[0])); else if(spec.right) h.appendChild(el("span", null, spec.right));
    tipEl.appendChild(h);
    (spec.rows || []).forEach(function(r){
      if(r === "hr"){ tipEl.appendChild(el("hr")); return; }
      var d = el("div"); d.appendChild(el("span", "k", r[0] + " "));
      if(r[2] === "code"){ r[1].forEach(function(n, i){ if(i) d.appendChild(txt(", ")); d.appendChild(el("code", null, n)); }); if(r[3]) d.appendChild(txt(r[3])); }
      else d.appendChild(txt(r[1]));
      tipEl.appendChild(d);
    });
    if(spec.foot){ var f = el("div", "k", spec.foot); f.style.marginTop = "4px"; tipEl.appendChild(f); }
  }
  function moveTip(ev){ if(!ev) return; var w = tipEl.offsetWidth, h = tipEl.offsetHeight, x = ev.clientX + 14, y = ev.clientY + 14;
    if(x + w > window.innerWidth - 6) x = ev.clientX - w - 14; if(y + h > window.innerHeight - 6) y = ev.clientY - h - 14;
    tipEl.style.left = Math.max(6, x) + "px"; tipEl.style.top = Math.max(6, y) + "px"; }
  function hideTip(){ tipEl.style.display = "none"; }
  function bindTip(node, specFn){
    node.addEventListener("mouseenter", function(e){ buildTip(specFn()); tipEl.style.display = "block"; moveTip(e); });
    node.addEventListener("mousemove", moveTip);
    node.addEventListener("mouseleave", hideTip);
    node.addEventListener("focus", function(){ var r = node.getBoundingClientRect(); buildTip(specFn()); tipEl.style.display = "block"; moveTip({ clientX:r.left, clientY:r.bottom }); });
    node.addEventListener("blur", hideTip);
    if(node.tagName !== "BUTTON" && !node.hasAttribute("tabindex")) node.setAttribute("tabindex", "0");
  }
  function tally(list, fn){ var m = {}; list.forEach(function(x){ var v = fn(x); if(v) m[v] = (m[v] || 0) + 1; }); return Object.keys(m).sort(function(a, b){ return m[b] - m[a]; }).map(function(k){ return k + " (" + m[k] + ")"; }); }

  /* ---------- settings (read both new and legacy stores) ---------- */
  function validMode(m){ return E.MODES.indexOf(m) >= 0; }
  async function loadSettings(){
    var r = await sget(["cookiegateGlobalMode","cookiegateSiteModes","cookiegateKeepRules","cookiegate.bannerSuppression.stats.v1"]);
    var g = validMode(r.cookiegateGlobalMode) ? r.cookiegateGlobalMode : lsGet("cookiegate.globalMode");
    S.globalMode = validMode(g) ? g : "strict";
    S.siteModes = (r.cookiegateSiteModes && typeof r.cookiegateSiteModes === "object") ? r.cookiegateSiteModes : {};
    S.keepRules = (r.cookiegateKeepRules && typeof r.cookiegateKeepRules === "object") ? r.cookiegateKeepRules : {};
    S.bannerStats = (r["cookiegate.bannerSuppression.stats.v1"] && typeof r["cookiegate.bannerSuppression.stats.v1"] === "object") ? r["cookiegate.bannerSuppression.stats.v1"] : {};
    S.domainRules = lsJson("cookiegate.domainRules.v1", {});
    S.theme = lsGet("cookiegate.ui.theme.v2") === "light" ? "light" : "dark"; // dark by default; remembers a later switch to light (v2 key ignores choices saved during pre-release testing)
  }
  function hostsFor(d){ var a = []; if(d === S.activeRoot && S.tabHost) a.push(S.tabHost); if(a.indexOf(d) < 0) a.push(d); if(a.indexOf("www." + d) < 0) a.push("www." + d); return a; }
  function ruleFor(d){
    var r = S.domainRules[d];
    if(r && typeof r === "object" && r.active !== false && r.enabled !== false && r.disabled !== true && validMode(r.mode)) return { mode:r.mode, src:"rule" };
    var hs = hostsFor(d);
    for(var i = 0; i < hs.length; i++){
      if(validMode(S.siteModes[hs[i]])) return { mode:S.siteModes[hs[i]], src:"site" };
      var l = lsGet("cookiegate.siteMode:" + hs[i]); if(validMode(l)) return { mode:l, src:"site" };
    }
    return null;
  }
  function effectiveFor(d){ var r = ruleFor(d); return r ? r.mode : S.globalMode; }
  function keepFor(d, c){ var hs = hostsFor(d), key = E.cookieKey(c); for(var i = 0; i < hs.length; i++){ var kr = S.keepRules[hs[i]]; if(kr && kr[key]) return true; } return false; }

  async function appendEvidence(records){
    if(!records || !records.length) return;
    var r = await sget(["cookiegateEvidenceLog"]);
    var cur = Array.isArray(r.cookiegateEvidenceLog) ? r.cookiegateEvidenceLog : [];
    await sset({ cookiegateEvidenceLog: records.slice().reverse().concat(cur).slice(0, 200) });
  }
  async function setRemembered(d, on, mode){
    var hs = hostsFor(d), now = new Date().toISOString();
    if(on){
      var prev = (S.domainRules[d] && typeof S.domainRules[d] === "object") ? S.domainRules[d] : {};
      S.domainRules[d] = { schema:"cookiegate.domain_rule.v48", root:d, domain:d, mode:mode,
        cleanup: prev.cleanup || { cookies:true, cache:false, localStorage:false, indexedDB:false, serviceWorkers:false, preserveAuth:true },
        enabled:true, active:true, disabled:false, status:"active", state:"active", checked:true,
        createdAt: prev.createdAt || now, updatedAt: now, source:"popup_v016" };
      hs.forEach(function(h){ S.siteModes[h] = mode; lsSet("cookiegate.siteMode:" + h, mode); });
    } else {
      delete S.domainRules[d];
      hs.forEach(function(h){ delete S.siteModes[h]; lsSet("cookiegate.siteMode:" + h, null); });
    }
    try { localStorage.setItem("cookiegate.domainRules.v1", JSON.stringify(S.domainRules)); } catch(e){}
    await sset({ cookiegateSiteModes: S.siteModes });
    await appendEvidence([E.evidenceRecord(on ? "cookiegate.policy.site_mode_set.v1" : "cookiegate.policy.site_mode_cleared.v1", on ? { site:d, mode:mode, source:"popup" } : { site:d, source:"popup" })]);
  }
  async function setGlobal(mode){
    S.globalMode = mode; lsSet("cookiegate.globalMode", mode);
    await sset({ cookiegateGlobalMode: mode });
    await appendEvidence([E.evidenceRecord("cookiegate.policy.global_mode_set.v1", { mode:mode, source:"popup" })]);
  }
  async function toggleKeep(d, c){
    var h = (d === S.activeRoot && S.tabHost) ? S.tabHost : d, key = E.cookieKey(c), on = !keepFor(d, c);
    if(on){ if(!S.keepRules[h] || typeof S.keepRules[h] !== "object") S.keepRules[h] = {}; S.keepRules[h][key] = true; }
    else hostsFor(d).forEach(function(x){ if(S.keepRules[x]) delete S.keepRules[x][key]; });
    await sset({ cookiegateKeepRules: S.keepRules });
    await appendEvidence([E.evidenceRecord("cookiegate.policy.keep_rule_set.v1", { site:h, cookieKey:key, keepAlways:on })]);
  }

  /* ---------- cookie reads ---------- */
  function dedupe(list){ var seen = {}, out = []; (list || []).forEach(function(c){ var k = E.dedupeKey(c); if(!seen[k]){ seen[k] = 1; out.push(c); } }); return out; }
  /* getAll with the Firefox first-party-isolation retry. */
  async function getAllAny(q){
    var list = await call(api.cookies, "getAll", [q]);
    if(list === undefined && PROMISE_API) list = await call(api.cookies, "getAll", [Object.assign({}, q, { firstPartyDomain:null })]);
    return Array.isArray(list) ? list : null;
  }
  /* v0.1.8: without partitionKey only unpartitioned cookies are returned (Chrome CHIPS,
   * Firefox Total Cookie Protection). partitionKey:{} adds partitioned ones where supported;
   * unsupported browsers reject it and the unpartitioned list is used alone. */
  async function readDomain(d){
    if(!d || !api || !api.cookies) return [];
    var a = await getAllAny({ domain:d }), b = await getAllAny({ domain:d, partitionKey:{} });
    return dedupe((a || []).concat(b || []));
  }
  async function readBrowser(){
    var r = await call(api.runtime, "sendMessage", [{ type:"COOKIEGATE_BROWSER_OBSERVER_READ_ALL_COOKIES_V1" }]);
    var list = (r && r.ok && Array.isArray(r.cookies) && r.cookies.length) ? r.cookies : null;
    if(!list){ var a = await getAllAny({}), b = await getAllAny({ partitionKey:{} }); list = (a || []).concat(b || []); }
    return dedupe(list);
  }
  function prep(list, siteRoot){
    return list.map(function(c){ var root = siteRoot || E.rootDomain(c.domain); var k = E.classify(c, siteRoot || root); return { c:c, cls:k.cls, vendor:k.vendor, g:k.group, root:root }; });
  }
  function statusOf(it, d, mode){
    if(keepFor(d, it.c)) return "always";
    var p = E.policyFor(it.c, it.cls, mode);
    return p === "delete-on-exit" ? "remove" : p === "review" ? "review" : "keep";
  }
  function cleanSet(){ var d = S.viewing; return S.items.filter(function(it){ return statusOf(it, d, S.vmode) === "remove"; }); }
  function wipeSet(includeLogins){ var d = S.viewing; return S.items.filter(function(it){ return E.wipeRemoves(it.c, it.cls, S.vmode, keepFor(d, it.c), includeLogins); }); }
  function groupStats(items, d, mode){ var o = {}; GROUPS.forEach(function(g){ o[g] = { n:0, rem:0, always:0 }; }); items.forEach(function(it){ var s = statusOf(it, d, mode); o[it.g].n++; if(s === "remove") o[it.g].rem++; if(s === "always") o[it.g].always++; }); return o; }
  function pillFor(st){ if(!st.n) return ["none","kp"]; if(st.rem === 0) return ["keep","kp"]; if(st.rem === st.n) return ["remove","rm"]; return [st.rem + " go","rm"]; }

  /* ---------- removal ---------- */
  function failReason(c){
    if(c.partitionKey) return "kept in partitioned third-party storage";
    if(c.firstPartyDomain) return "isolated by the browser's first-party protection";
    if(c.storeId && c.storeId !== "0" && c.storeId !== "firefox-default") return "stored in a container or private-window cookie store";
    return "the browser refused to remove it";
  }
  async function removeOne(c){
    var d = E.removalDetails(c);
    if(await call(api.cookies, "remove", [d])) return true;
    var host = String(c.domain || "").replace(/^\./, ""), path = c.path || "/";
    var alts = [(c.secure ? "http://" : "https://") + host + path];
    if(!/^www\./.test(host) && String(c.domain || "").charAt(0) === ".") alts.push((c.secure ? "https://" : "http://") + "www." + host + path);
    for(var i = 0; i < alts.length; i++){ if(await call(api.cookies, "remove", [Object.assign({}, d, { url:alts[i] })])) return true; }
    return false;
  }
  /* Removes each cookie (retrying alternate URL forms), then re-reads to detect cookies the
   * open page immediately re-created, so the result message can say exactly what happened. */
  async function doRemove(list, reason, progress, reread){
    S.busy = true; renderCta();
    var removed = [], failed = [], recs = [], fresh = null, back = [];
    for(var i = 0; i < list.length; i++){
      var it = list[i], c = it.c, good = await removeOne(c);
      if(good) removed.push(c); else failed.push({ c:c, why:failReason(c) });
      recs.push(E.evidenceRecord("cookiegate.cookie.delete.v1", { site: it.root || S.viewing, reason:reason, result: good ? "deleted" : "failed", name:c.name, domain:c.domain, path:c.path || "/" }));
      if(progress) progress(i + 1, list.length);
    }
    if(reread){
      fresh = await reread(); var keys = {};
      /* dedupeKey includes store + partition, so a partitioned copy that failed to remove
       * is not mistaken for the removed unpartitioned copy being re-created. */
      (fresh || []).forEach(function(x){ keys[E.dedupeKey(x)] = 1; });
      back = removed.filter(function(x){ return keys[E.dedupeKey(x)]; });
      back.forEach(function(x){ recs.push(E.evidenceRecord("cookiegate.cookie.recreated.v1", { site: E.rootDomain(x.domain), reason:reason, name:x.name, domain:x.domain, path:x.path || "/" })); });
    }
    await appendEvidence(recs);
    S.busy = false;
    return { ok:removed.length, failed:failed, back:back, fresh:fresh };
  }
  function names(list){ var n = list.map(function(c){ return c.name; }); return n.slice(0, 3).join(", ") + (n.length > 3 ? " +" + (n.length - 3) + " more" : ""); }
  function resultMessage(verb, res, where, tail){
    var p = [verb + " " + plural(res.ok, "cookie") + where + "."];
    if(res.back.length) p.push(plural(res.back.length, "cookie") + " (" + names(res.back) + ") " + (res.back.length === 1 ? "was" : "were") + " set again right away by the site, because its page is still open and keeps re-creating " + (res.back.length === 1 ? "it" : "them") + ". Close or reload the tab, then clean again.");
    if(res.failed.length) p.push(plural(res.failed.length, "cookie") + " could not be removed: " + res.failed.slice(0, 3).map(function(f){ return f.c.name + " (" + f.why + ")"; }).join(", ") + (res.failed.length > 3 ? ", …" : "") + ".");
    if(tail) p.push(tail);
    return p.join(" ");
  }
  function toast(id, msg, warn){ var t = $(id); t.className = "toast show" + (warn ? " warn" : ""); t.textContent = msg; }
  function clearToast(id){ $(id).className = "toast"; }

  /* ---------- header + theme ---------- */
  function renderHeader(){
    var fav = $("fav"), name = $("domName"), sub = $("topSub");
    if(S.view === "site" && S.viewing){
      name.textContent = S.viewing; fav.textContent = S.viewing.charAt(0); fav.style.background = favColor(S.viewing);
      sub.textContent = S.viewing === S.activeRoot ? "Active site" : "Search result — not the open tab";
    } else {
      name.textContent = "All sites"; fav.textContent = "∗"; fav.style.background = "var(--acc)";
      sub.textContent = S.isWeb ? "Whole browser" : "Browser page — showing all sites";
    }
    $("tabSite").classList.toggle("hide", !(S.isWeb || S.viewing));
  }
  function applyTheme(){
    document.documentElement.setAttribute("data-theme", S.theme);
    COL = S.theme === "dark" ? COL_D : COL_L;
    var b = $("themeBtn"); clear(b);
    b.appendChild(icon(S.theme === "dark" ? "sun" : "moon")); b.appendChild(el("span", null, S.theme === "dark" ? "Light" : "Dark"));
    b.title = S.theme === "dark" ? "Switch to light mode" : "Switch to dark mode"; b.setAttribute("aria-label", b.title);
  }

  /* ---------- site view ---------- */
  function catTip(g){
    var d = S.viewing, list = S.items.filter(function(it){ return it.g === g; }), st = groupStats(S.items, d, S.vmode)[g];
    var pct = S.items.length ? Math.round(list.length / S.items.length * 100) : 0, pill = pillFor(st);
    var rows = [["Why:", WHY[g]]];
    var vend = tally(list, function(it){ return it.vendor; }).slice(0, 4); if(vend.length) rows.push(["Sources:", vend.join(", ")]);
    var doms = tally(list, function(it){ return String(it.c.domain || "").replace(/^\./, ""); }).slice(0, 3); if(doms.length) rows.push(["Domains:", doms.join(", ")]);
    if(list.length){ rows.push("hr"); rows.push(["Cookies:", list.slice(0, 5).map(function(it){ return it.c.name; }), "code", list.length > 5 ? ", +" + (list.length - 5) + " more" : ""]); }
    return { title: NAME[g] + " · " + list.length + " (" + pct + "%)", tag:[pill[0].toUpperCase(), pill[1]], rows:rows,
      foot: "Under " + cap(S.vmode) + ": " + st.rem + " removed by Clean, " + (st.n - st.rem) + " kept" + (st.always ? " (" + st.always + " pinned)" : "") + "." };
  }
  function cookieTip(it){
    var d = S.viewing, s = statusOf(it, d, S.vmode), c = it.c;
    var pol = s === "always" ? "keep-always" : E.policyFor(c, it.cls, S.vmode);
    var catLabel = NAME[it.g] + (it.cls === "third-party/unknown" ? " (third-party)" : it.cls === "security" ? " (security)" : "");
    var flags = [c.secure ? "Secure" : "", c.httpOnly ? "HttpOnly" : "", c.session ? "Session" : "Persistent"].filter(Boolean).join(" · ");
    var rows = [["Domain:", String(c.domain || "")], ["Category:", catLabel]];
    if(it.vendor) rows.push(["Source:", it.vendor]);
    rows.push(["Action:", POLICY_TEXT[pol] || pol]); rows.push(["Flags:", flags]); rows.push(["Why:", WHY[it.g]]);
    return { title:c.name, tag:[STATUS[s][0].toUpperCase(), STATUS[s][1]], rows:rows, foot:"Value fingerprint " + E.hashPreview(c.value) + " — the raw value is never shown or exported." };
  }
  function segWidths(vals, minPct){
    var tot = vals.reduce(function(a, b){ return a + b; }, 0); if(!tot) return vals.map(function(){ return 0; });
    var raw = vals.map(function(v){ return v / tot * 100; }), small = raw.map(function(p){ return p > 0 && p < minPct; });
    var reserved = small.reduce(function(a, s){ return a + (s ? minPct : 0); }, 0), big = raw.reduce(function(a, p, i){ return a + (small[i] ? 0 : p); }, 0);
    return raw.map(function(p, i){ return p === 0 ? 0 : (small[i] ? minPct : p / big * (100 - reserved)); });
  }
  function renderSite(){
    hideTip(); renderHeader();
    var searching = S.q.length > 0;
    $("results").classList.toggle("hide", !searching);
    $("siteContent").classList.toggle("hide", searching);
    $("searchWrap").classList.toggle("has", searching);
    var showBack = !searching && S.viewing && S.viewing !== S.activeRoot;
    $("back").classList.toggle("hide", !showBack);
    if(showBack){ $("backTxt").textContent = "Showing " + S.viewing; $("backBtn").textContent = S.isWeb ? "← Back to " + S.activeRoot : "← Back to Browser"; }
    if(searching){ renderResults(); renderCta(); return; }

    var d = S.viewing, items = S.items, tot = items.length, stats = groupStats(items, d, S.vmode), rem = cleanSet().length, rule = ruleFor(d);
    $("sTot").textContent = S.loading ? "…" : tot;
    $("sOn").textContent = (tot === 1 ? "cookie" : "cookies") + " on " + d;
    var line = $("sLine"); clear(line);
    if(S.loading) line.appendChild(txt("Reading cookies…"));
    else if(tot){
      line.appendChild(el("b", "k", (tot - rem) + " kept")); line.appendChild(txt(" · ")); line.appendChild(el("b", "r", rem + " removed by Clean"));
      line.appendChild(txt(" under " + cap(S.vmode)));
    } else line.appendChild(txt("CookieGate has no cookies stored for " + d + " yet."));
    if(rule) line.appendChild(el("span", "rule", "saved for this site"));
    else if(S.vmode === S.globalMode) line.appendChild(el("span", "rule", "default"));
    else line.appendChild(el("span", "rule", "not saved"));

    var bs = S.bannerStats[d] || S.bannerStats[String(S.tabHost).replace(/^www\./, "")];
    var bn = (bs && Number(bs.suppressed)) || 0, sb = $("sBanner");
    sb.classList.toggle("hide", !(bn > 0 && d === S.activeRoot)); clear(sb);
    if(bn > 0){ sb.appendChild(icon("shield")); sb.appendChild(el("span", null, plural(bn, "cookie banner") + " hidden on this site")); }

    var bar = $("sBar"); clear(bar); bar.classList.toggle("hide", !tot);
    var w = segWidths(GROUPS.map(function(g){ return stats[g].n; }), 8);
    GROUPS.forEach(function(g, i){
      if(!stats[g].n) return;
      var s = el("i"); s.style.width = w[i] + "%"; s.style.background = COL[g]; s.style.opacity = stats[g].rem ? 1 : 0.45;
      s.setAttribute("role", "button"); s.setAttribute("aria-label", NAME[g] + " " + stats[g].n);
      bindTip(s, function(){ return catTip(g); }); s.addEventListener("click", function(){ toggleCat(g); });
      bar.appendChild(s);
    });
    var chips = $("sChips"); clear(chips); chips.classList.toggle("hide", !tot); $("sHint").classList.toggle("hide", !tot);
    GROUPS.forEach(function(g){
      var p = pillFor(stats[g]), b = el("button", "chip" + (S.openCat === g ? " on" : "")); b.type = "button";
      var l = el("span", "l"), em = el("em"); em.style.background = COL[g]; l.appendChild(em); l.appendChild(txt(SHORT[g] + " ")); l.appendChild(el("b", null, stats[g].n));
      b.appendChild(l); b.appendChild(el("span", "st " + p[1], p[0]));
      bindTip(b, function(){ return catTip(g); }); b.addEventListener("click", function(){ toggleCat(g); });
      chips.appendChild(b);
    });
    renderDrawer();

    $("fill").style.width = POS[S.vmode] + "%";
    Array.prototype.forEach.call(document.querySelectorAll("#slider button"), function(b){ b.classList.toggle("on", b.getAttribute("data-m") === S.vmode); b.setAttribute("aria-pressed", b.getAttribute("data-m") === S.vmode ? "true" : "false"); });
    Array.prototype.forEach.call(document.querySelectorAll("#slabels span"), function(s){ s.classList.toggle("on", s.getAttribute("data-m") === S.vmode); });
    var md = $("mdesc"); clear(md); md.appendChild(el("b", null, cap(S.vmode))); md.appendChild(txt(" " + MDESC[S.vmode]));
    $("remember").checked = !!rule;
    $("rememberLbl").textContent = "Always use " + cap(S.vmode) + " on " + d;
    var dl = $("defLine"); clear(dl);
    dl.appendChild(txt("Default for all sites: " + cap(S.globalMode) + ". "));
    if(S.vmode !== S.globalMode){ var lb = el("button", "linkbtn", "Make " + cap(S.vmode) + " the default"); lb.type = "button"; lb.addEventListener("click", async function(){ await setGlobal(S.vmode); toast("toast", cap(S.vmode) + " is now the default for sites without a saved mode."); renderSite(); }); dl.appendChild(lb); }
    renderCta();
  }
  function renderCta(){
    var cta = $("cta"), visible = S.view === "site" && !!S.viewing;
    cta.classList.toggle("hide", !visible); if(!visible) return;
    var d = S.viewing, rem = cleanSet().length, cl = $("clean"), wp = $("wipe");
    cl.classList.toggle("armed", S.armed);
    if(S.busy) cl.textContent = "Removing…";
    else if(S.armed) cl.textContent = "Tap again to remove " + plural(rem, "cookie");
    else if(rem) cl.textContent = "Clean " + plural(rem, "cookie") + " on " + d;
    else cl.textContent = S.vmode === "trusted" ? "Trusted mode — nothing to clean" : "Nothing to clean on " + d;
    cl.disabled = !rem || S.busy || S.loading;
    wp.textContent = "Wipe " + d + "…"; wp.disabled = !S.items.length || S.busy || S.loading;
  }
  function toggleCat(g){ S.openCat = S.openCat === g ? null : g; S.lim = 6; renderSite(); }
  function renderDrawer(){
    var dr = $("drawer"); if(!S.openCat){ dr.classList.add("hide"); return; } dr.classList.remove("hide");
    var g = S.openCat, d = S.viewing, list = S.items.filter(function(it){ return it.g === g; }), st = groupStats(S.items, d, S.vmode)[g], p = pillFor(st);
    var t = $("dTitle"); clear(t); t.appendChild(txt(NAME[g] + " · " + list.length)); t.appendChild(el("span", "st " + p[1], p[0]));
    var box = $("dList"); clear(box);
    if(!list.length){ box.appendChild(el("div", "empty", "No cookies in this category.")); return; }
    list.slice(0, S.lim).forEach(function(it){
      var s = statusOf(it, d, S.vmode), row = el("div", "ck" + (it.c.name === S.flash ? " flash" : ""));
      var nm = el("span", "nm"); nm.appendChild(el("code", null, it.c.name)); nm.appendChild(el("span", "d", String(it.c.domain || "") + (it.vendor ? " · " + it.vendor : "")));
      var rt = el("span", "rt"); rt.appendChild(el("span", "st " + STATUS[s][1], STATUS[s][0]));
      var pin = el("button", "pin" + (s === "always" ? " on" : "")); pin.type = "button"; pin.appendChild(icon("pin"));
      pin.title = s === "always" ? "Stop always keeping this cookie" : "Always keep this cookie"; pin.setAttribute("aria-label", pin.title);
      pin.addEventListener("click", async function(e){ e.stopPropagation(); await toggleKeep(d, it.c); renderSite(); });
      rt.appendChild(pin); row.appendChild(nm); row.appendChild(rt);
      bindTip(row, function(){ return cookieTip(it); }); box.appendChild(row);
    });
    if(list.length > S.lim || S.lim > 6){
      var w = el("div", "lbtns");
      if(list.length > S.lim){ var m = el("button", "more", "Show " + Math.min(10, list.length - S.lim) + " more (" + (list.length - S.lim) + " left)"); m.type = "button"; m.addEventListener("click", function(){ S.lim += 10; renderDrawer(); }); w.appendChild(m); }
      if(S.lim > 6){ var f = el("button", "more", "Show fewer"); f.type = "button"; f.addEventListener("click", function(){ S.lim = 6; renderDrawer(); }); w.appendChild(f); }
      box.appendChild(w);
    }
    S.flash = null;
  }

  /* ---------- search (results replace the site view) ---------- */
  function siteIndex(){
    if(!S.browserItems) return null; if(S.siteIdx) return S.siteIdx;
    var m = {}; S.browserItems.forEach(function(it){ if(it.root) m[it.root] = (m[it.root] || 0) + 1; }); S.siteIdx = m; return m;
  }
  function renderResults(){
    var box = $("results"); clear(box);
    var q = S.q.toLowerCase(), root = E.rootDomain(S.q), idx = siteIndex();
    if(!idx && !S.browserLoading) loadBrowser().then(function(){ if(S.q && S.view === "site") renderSite(); });
    var doms = idx ? Object.keys(idx).filter(function(x){ return x.indexOf(root) >= 0 || x.indexOf(q) >= 0; }).sort(function(a, b){ return idx[b] - idx[a]; }).slice(0, 5) : [];
    var typedNew = E.looksLikeDomain(S.q) && !(idx && idx[root]) && doms.indexOf(root) < 0;
    if(doms.length || typedNew || !idx){
      box.appendChild(el("div", "rg", "Sites"));
      if(!idx) box.appendChild(el("div", "empty", "Loading your browser's sites…"));
      doms.forEach(function(x){
        var r = el("button", "srow"); r.type = "button";
        var mi = el("span", "mini", x.charAt(0)); mi.style.background = favColor(x); r.appendChild(mi);
        r.appendChild(el("span", "n", x + (x === S.activeRoot ? " (open tab)" : ""))); r.appendChild(el("span", "c", plural(idx[x], "cookie"))); r.appendChild(el("span", "go", "›"));
        r.addEventListener("click", function(){ openDomain(x); }); box.appendChild(r);
      });
      if(typedNew){
        var r2 = el("button", "srow"); r2.type = "button"; var m2 = el("span", "mini", root.charAt(0)); m2.style.background = "#64748b"; r2.appendChild(m2);
        r2.appendChild(el("span", "n", root)); r2.appendChild(el("span", "c", "no cookies stored")); r2.appendChild(el("span", "go", "›"));
        r2.addEventListener("click", function(){ openDomain(root); }); box.appendChild(r2);
      }
    }
    if(S.viewing){
      var matches = S.items.filter(function(it){ return (it.c.name + " " + it.c.domain + " " + it.vendor + " " + NAME[it.g]).toLowerCase().indexOf(q) >= 0; });
      box.appendChild(el("div", "rg", "Cookies on " + S.viewing + " (" + matches.length + ")"));
      if(matches.length){
        var rb = el("div", "rbox");
        matches.slice(0, 8).forEach(function(it){
          var s = statusOf(it, S.viewing, S.vmode), row = el("div", "ck"); row.style.cursor = "pointer";
          var nm = el("span", "nm"); nm.appendChild(el("code", null, it.c.name)); nm.appendChild(el("span", "d", it.vendor || NAME[it.g]));
          row.appendChild(nm); row.appendChild(el("span", "st " + STATUS[s][1], STATUS[s][0]));
          bindTip(row, function(){ return cookieTip(it); }); row.addEventListener("click", function(){ selectCookie(it); }); rb.appendChild(row);
        });
        if(matches.length > 8) rb.appendChild(el("div", "empty", "+" + (matches.length - 8) + " more — keep typing to narrow it down"));
        box.appendChild(rb);
      } else box.appendChild(el("div", "empty", "No cookies on " + S.viewing + " match “" + S.q + "”." + (doms.length || typedNew ? "" : " Type a domain like bbc.com to look up another site.")));
    }
  }
  function clearSearch(){ S.q = ""; $("q").value = ""; }
  async function openDomain(d){
    if(!d) return;
    S.viewing = d; S.items = []; S.loading = true; S.vmode = effectiveFor(d); S.openCat = null; S.lim = 6; S.armed = false;
    clearSearch(); clearToast("toast"); switchView("site");
    var list = await readDomain(d);
    if(S.viewing !== d) return;
    S.items = prep(list, d); S.loading = false; renderSite();
  }
  function selectCookie(it){
    clearSearch(); S.openCat = it.g;
    var idx = S.items.filter(function(x){ return x.g === it.g; }).indexOf(it);
    S.lim = Math.max(6, idx + 1); S.flash = it.c.name; renderSite();
  }

  /* ---------- browser view (the ring chart lives only here) ---------- */
  async function loadBrowser(force){
    if(S.browserLoading) return; if(S.browser && !force) return;
    S.browserLoading = true;
    var list = await readBrowser();
    S.browser = list; S.browserItems = prep(list, null); S.siteIdx = null; S.browserLoading = false;
  }
  function arcPath(cx, cy, r, a0, a1){ var s = [cx + r * Math.cos(a0), cy + r * Math.sin(a0)], e = [cx + r * Math.cos(a1), cy + r * Math.sin(a1)]; return "M" + s[0] + " " + s[1] + " A" + r + " " + r + " 0 " + ((a1 - a0) > Math.PI ? 1 : 0) + " 1 " + e[0] + " " + e[1]; }
  function browserGroups(){ var o = { auth:[], trk:[], pref:[], unk:[] }; (S.browserItems || []).forEach(function(it){ o[it.g].push(it); }); return o; }
  function obsTip(g, groups, total){
    var list = groups[g], top = tally(list, function(it){ return it.root; }).slice(0, 3);
    var rows = [["Why:", WHY[g]]]; if(top.length) rows.push(["Most from:", top.join(", ")]);
    var vend = tally(list, function(it){ return it.vendor; }).slice(0, 3); if(vend.length) rows.push(["Sources:", vend.join(", ")]);
    return { title: NAME[g] + " · " + plural(list.length, "cookie"), right: (total ? Math.round(list.length / total * 100) : 0) + "%", rows:rows };
  }
  function siteTip(root){
    var list = (S.browserItems || []).filter(function(it){ return it.root === root; }), c = { auth:0, trk:0, pref:0, unk:0 };
    list.forEach(function(it){ c[it.g]++; });
    var vend = tally(list, function(it){ return it.vendor; }).slice(0, 3);
    var rows = [["Breakdown:", GROUPS.filter(function(g){ return c[g]; }).map(function(g){ return SHORT[g] + " " + c[g]; }).join(" · ")]];
    if(vend.length) rows.push(["Sources:", vend.join(", ")]);
    var r = ruleFor(root); rows.push(["Mode:", cap(effectiveFor(root)) + (r ? " (saved)" : " (default)")]);
    return { title: root, right: plural(list.length, "cookie"), rows:rows, foot:"Tap to open this site." };
  }
  function cleanAllSet(){ return (S.browserItems || []).filter(function(it){ return E.cleanRemoves(it.c, it.cls, effectiveFor(it.root), keepFor(it.root, it.c)); }); }
  function renderBrowser(){
    hideTip(); renderHeader();
    var svg = $("ring"); while(svg.firstChild) svg.removeChild(svg.firstChild);
    if(!S.browser){
      $("bTot").textContent = "–"; $("bLbl").textContent = "reading cookies…"; clear($("oCats")); clear($("oSites")); $("oMore").classList.add("hide"); $("oNote").textContent = ""; $("cleanAll").disabled = true;
      if(!S.browserLoading) loadBrowser().then(function(){ if(S.view === "browser") renderBrowser(); });
      return;
    }
    var groups = browserGroups(), total = S.browserItems.length, idx = siteIndex() || {}, roots = Object.keys(idx);
    $("bTot").textContent = total; $("bLbl").textContent = "cookies · " + plural(roots.length, "site");
    var w = segWidths(GROUPS.map(function(g){ return groups[g].length; }), 6), a = -Math.PI / 2, gap = 0.04;
    GROUPS.forEach(function(g, i){
      if(!groups[g].length) return; var span = w[i] / 100 * Math.PI * 2;
      var p = svgEl("path", { d: arcPath(60, 60, 48, a + gap, a + span - gap), stroke: COL[g], "stroke-width":"14", fill:"none" });
      bindTip(p, function(){ return obsTip(g, groups, total); }); svg.appendChild(p); a += span;
    });
    var cats = $("oCats"); clear(cats);
    GROUPS.forEach(function(g){ var r = el("div", "lrow"), dot = el("span", "dot"); dot.style.background = COL[g]; r.appendChild(dot); r.appendChild(el("span", "cn", NAME[g])); r.appendChild(el("b", null, groups[g].length)); bindTip(r, function(){ return obsTip(g, groups, total); }); cats.appendChild(r); });
    var sites = $("oSites"); clear(sites);
    var sorted = roots.sort(function(x, y){ return idx[y] - idx[x] || x.localeCompare(y); }), max = sorted.length ? idx[sorted[0]] : 1;
    if(!sorted.length) sites.appendChild(el("div", "empty", "No cookies readable. If you just installed CookieGate, reload your tabs and rescan."));
    sorted.slice(0, S.bwLim).forEach(function(x){
      var b = el("button", "site"); b.type = "button"; b.appendChild(el("span", "n", x));
      var t = el("span", "t"), fi = el("i"); fi.style.width = (idx[x] / max * 100) + "%"; t.appendChild(fi); b.appendChild(t); b.appendChild(el("span", "c", idx[x]));
      bindTip(b, function(){ return siteTip(x); }); b.addEventListener("click", function(){ openDomain(x); }); sites.appendChild(b);
    });
    var more = $("oMore"), expanded = S.bwLim > 5;
    more.classList.toggle("hide", sorted.length <= 5);
    more.textContent = expanded ? "Show less ▴" : "Show more (top " + Math.min(15, sorted.length) + ") ▾";
    $("oNote").textContent = expanded && sorted.length > 15 ? "All " + sorted.length + " sites are in Download JSON." : "";
    var n = cleanAllSet().length, ca = $("cleanAll");
    ca.textContent = n ? "Clean " + plural(n, "cookie") + " across all sites" : "Nothing to clean across sites"; ca.disabled = !n || S.busy;
  }

  /* ---------- confirmation sheet ---------- */
  function openSheet(spec){
    S.sheet = spec; $("shOpt").checked = false; $("shOpt2").checked = false;
    $("shOptWrap").classList.toggle("hide", !spec.opt); $("shOpt2Wrap").classList.toggle("hide", !spec.opt2);
    if(spec.opt) $("shOptLbl").textContent = spec.opt; if(spec.opt2) $("shOpt2Lbl").textContent = spec.opt2;
    renderSheet(); $("sheet").classList.remove("hide"); $("shCancel").focus();
  }
  function sheetOpts(){ return { a: $("shOpt").checked, b: $("shOpt2").checked }; }
  function renderSheet(){ var s = S.sheet; if(!s) return; var o = sheetOpts(); $("shTitle").textContent = s.title; $("shText").textContent = s.text(o); var go = $("shGo"); go.textContent = s.go(o); go.disabled = !!(s.disabled && s.disabled(o)); }
  function closeSheet(){ S.sheet = null; $("sheet").classList.add("hide"); }

  /* ---------- views ---------- */
  function switchView(v){
    S.view = v; hideTip();
    $("vSite").classList.toggle("hide", v !== "site"); $("vBrowser").classList.toggle("hide", v !== "browser");
    $("tabSite").classList.toggle("on", v === "site"); $("tabBrowser").classList.toggle("on", v === "browser");
    if(v === "site") renderSite(); else { renderCta(); renderBrowser(); }
  }
  function download(name, obj){
    var blob = new Blob([JSON.stringify(obj, null, 2)], { type:"application/json" }), url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function(){ URL.revokeObjectURL(url); }, 1500);
  }
  var PRIVACY = { rawCookieValuesExported:false, valueHandling:"valueHashPreview only" };

  /* ---------- events ---------- */
  function bind(){
    $("themeBtn").addEventListener("click", function(){ S.theme = S.theme === "dark" ? "light" : "dark"; lsSet("cookiegate.ui.theme.v2", S.theme); applyTheme(); if(S.view === "site") renderSite(); else renderBrowser(); });
    $("q").addEventListener("input", function(e){ S.q = e.target.value.trim(); renderSite(); });
    $("q").addEventListener("keydown", function(e){
      if(e.key === "Escape"){ clearSearch(); renderSite(); return; }
      if(e.key !== "Enter" || !S.q) return;
      var root = E.rootDomain(S.q), idx = siteIndex();
      if((idx && idx[root]) || E.looksLikeDomain(S.q)){ openDomain(root); return; }
      var hit = idx ? Object.keys(idx).filter(function(x){ return x.indexOf(root) >= 0; }).sort(function(a, b){ return idx[b] - idx[a]; })[0] : null;
      if(hit) openDomain(hit);
    });
    $("qx").addEventListener("click", function(){ clearSearch(); renderSite(); $("q").focus(); });
    $("backBtn").addEventListener("click", function(){ if(S.isWeb) openDomain(S.activeRoot); else { S.viewing = ""; switchView("browser"); } });
    $("dClose").addEventListener("click", function(){ S.openCat = null; renderSite(); });
    Array.prototype.forEach.call(document.querySelectorAll("#slider button, #slabels span"), function(b){
      b.addEventListener("click", async function(){
        var m = b.getAttribute("data-m"); if(!validMode(m) || m === S.vmode) return;
        S.vmode = m; S.armed = false; clearToast("toast");
        if(ruleFor(S.viewing)){ await setRemembered(S.viewing, true, m); toast("toast", "Saved: " + cap(m) + " on " + S.viewing + "."); }
        renderSite();
      });
    });
    $("remember").addEventListener("change", async function(e){
      var on = e.target.checked; await setRemembered(S.viewing, on, S.vmode);
      toast("toast", on ? "Saved: CookieGate will use " + cap(S.vmode) + " every time you visit " + S.viewing + "." : "Removed the saved mode for " + S.viewing + ". It now follows your default (" + cap(S.globalMode) + ").");
      if(!on) S.vmode = effectiveFor(S.viewing);
      renderSite();
    });
    $("clean").addEventListener("click", async function(){
      if(S.busy) return; var list = cleanSet(); if(!list.length) return;
      if(!S.armed){ S.armed = true; renderCta(); clearTimeout(S.armTimer); S.armTimer = setTimeout(function(){ S.armed = false; renderCta(); }, 4000); return; }
      S.armed = false; clearTimeout(S.armTimer);
      var d = S.viewing, res = await doRemove(list, "manual-clean", null, function(){ return readDomain(d); });
      S.items = prep(res.fresh || await readDomain(d), d); S.browser = null; S.browserItems = null; S.siteIdx = null;
      toast("toast", resultMessage("Removed", res, " on " + d, "Your logins were kept."), res.failed.length > 0 || res.back.length > 0);
      renderSite();
    });
    $("wipe").addEventListener("click", function(){
      if(S.busy || !S.items.length) return;
      var d = S.viewing, logins = S.items.filter(function(it){ return it.g === "auth" && !keepFor(d, it.c); }).length;
      openSheet({
        title: "Wipe " + d + "?",
        text: function(o){ var n = wipeSet(o.a).length, keep = S.items.length - n; return "Removes " + plural(n, "cookie") + " set by " + d + ". " + (o.a ? "This includes login cookies, so you will be signed out." : keep + " stay: login, security, session and pinned cookies.") ; },
        opt: logins ? "Also remove " + plural(logins, "login & security cookie") + " (signs you out)" : null,
        go: function(o){ return "Remove " + plural(wipeSet(o.a).length, "cookie"); },
        disabled: function(o){ return wipeSet(o.a).length === 0; },
        run: async function(o){ var res = await doRemove(wipeSet(o.a), "manual-wipe", null, function(){ return readDomain(d); }); S.items = prep(res.fresh || await readDomain(d), d); S.browser = null; S.browserItems = null; S.siteIdx = null;
          toast("toast", resultMessage("Wiped", res, " on " + d, o.a ? "You may need to sign in again." : "Logins were kept."), res.failed.length > 0 || res.back.length > 0); renderSite(); }
      });
    });
    $("exportSite").addEventListener("click", async function(){
      var d = S.viewing; if(!d) return;
      var ev = await sget(["cookiegateEvidenceLog"]), log = Array.isArray(ev.cookiegateEvidenceLog) ? ev.cookiegateEvidenceLog : [];
      var rule = ruleFor(d);
      download("cookiegate_site_package_" + d.replace(/[^a-z0-9.-]+/gi, "_") + "_" + Date.now() + ".json", {
        schema:"cookiegate.site_package.v1", exported_at:new Date().toISOString(), site:d, url: d === S.activeRoot ? S.tabUrl : null,
        mode:{ global:S.globalMode, site: rule ? rule.mode : "inherit-global", effective:S.vmode },
        privacy:PRIVACY, engine:"cg_engine " + E.VERSION,
        cookies: S.items.map(function(it){ return E.sanitize(it.c, d, S.vmode, keepFor(d, it.c)); }),
        evidence: log.filter(function(r){ return r && r.payload && (r.payload.site === d || r.payload.site === S.tabHost); }).slice(0, 50)
      });
    });
    $("tabSite").addEventListener("click", function(){ if(!S.viewing && S.isWeb) openDomain(S.activeRoot); else switchView("site"); });
    $("tabBrowser").addEventListener("click", function(){ switchView("browser"); });
    $("oMore").addEventListener("click", function(){ S.bwLim = S.bwLim > 5 ? 5 : 15; renderBrowser(); });
    $("rescan").addEventListener("click", async function(){ S.browser = null; S.browserItems = null; S.siteIdx = null; renderBrowser(); });
    $("exportBrowser").addEventListener("click", async function(){
      if(!S.browser) await loadBrowser();
      var cookies = (S.browserItems || []).map(function(it){ return E.sanitize(it.c, it.root, effectiveFor(it.root), keepFor(it.root, it.c)); });
      download("cookiegate_browser_observer_v3_" + Date.now() + ".json", { schema:"cookiegate.browser_observer.v3", captured_at:new Date().toISOString(), ok:true, error:null, privacy:PRIVACY, engine:"cg_engine " + E.VERSION, analysis:E.analyze(cookies), cookies:cookies });
    });
    $("cleanAll").addEventListener("click", function(){
      var list = cleanAllSet(); if(!list.length || S.busy) return;
      var sitesN = Object.keys(list.reduce(function(m, it){ m[it.root] = 1; return m; }, {})).length;
      openSheet({
        title:"Clean all sites?",
        text:function(o){ return "Removes " + plural(list.length, "cookie") + " across " + plural(sitesN, "site") + ", using each site's saved mode (default: " + cap(S.globalMode) + "). Logins and security cookies stay." + (o.a ? " Your browser cache will also be cleared." : ""); },
        opt:"Also clear cached files (browser cache)",
        go:function(){ return "Remove " + plural(list.length, "cookie"); },
        run: async function(o){
          var ca = $("cleanAll");
          var res = await doRemove(list, "manual-clean-all", function(i, n){ ca.textContent = "Removing… " + i + "/" + n; }, readBrowser);
          if(o.a) await call(api.browsingData, "remove", [{ since:0 }, { cache:true }]);
          S.browser = null; S.browserItems = null; S.siteIdx = null;
          await loadBrowser(true);
          if(S.viewing) S.items = prep(await readDomain(S.viewing), S.viewing);
          toast("btoast", resultMessage("Removed", res, " across sites", (o.a ? "Cache cleared. " : "") + "Logins were kept."), res.failed.length > 0 || res.back.length > 0);
          renderBrowser();
        }
      });
    });
    $("shCancel").addEventListener("click", closeSheet);
    $("shOpt").addEventListener("change", renderSheet); $("shOpt2").addEventListener("change", renderSheet);
    $("shGo").addEventListener("click", async function(){ var s = S.sheet; if(!s) return; var o = sheetOpts(); closeSheet(); await s.run(o); });
    document.addEventListener("keydown", function(e){ if(e.key === "Escape" && S.sheet) closeSheet(); });
  }

  /* ---------- init ---------- */
  async function init(){
    bind();
    if(!E || !api){ $("topSub").textContent = "CookieGate could not start (browser API unavailable)."; return; }
    await loadSettings(); applyTheme();
    var tabs = await call(api.tabs, "query", [{ active:true, currentWindow:true }]), tab = tabs && tabs[0];
    S.tabUrl = (tab && tab.url) || ""; S.isWeb = /^https?:\/\//i.test(S.tabUrl);
    S.tabHost = S.isWeb ? hostFrom(S.tabUrl) : ""; S.activeRoot = S.isWeb ? E.rootDomain(S.tabHost) : "";
    if(S.isWeb){ await openDomain(S.activeRoot); loadBrowser(); }
    else { S.viewing = ""; switchView("browser"); }
  }
  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
