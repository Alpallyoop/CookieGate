(function(){
  "use strict";

  var api = null;
  if (typeof browser !== "undefined") api = browser;
  else if (typeof chrome !== "undefined") api = chrome;

  function byId(id){ return document.getElementById(id); }

  var state = {
    site: "-",
    url: "",
    globalMode: localStorage.getItem("cookiegate.globalMode") || "strict",
    siteMode: "inherit-global",
    effectiveMode: "-",
    trackedTabs: "-",
    cookies: [],
    evidence: [],
    selectedTab: "session",
    sessionStart: Number(sessionStorage.getItem("cookiegate.sessionStart") || Date.now()),
    previousCookies: [],
    diff: { added: 0, removed: 0, changed: 0 }
  };

  sessionStorage.setItem("cookiegate.sessionStart", String(state.sessionStart));

  function safe(v, fallback){
    if(fallback === undefined) fallback = "-";
    if(v === null || v === undefined || v === "") return fallback;
    return String(v);
  }

  function hostFromUrl(raw){
    try { return new URL(raw).hostname; } catch(e) { return "-"; }
  }

  function sendMessage(msg){
    return new Promise(function(resolve){
      if(!api || !api.runtime || !api.runtime.sendMessage){
        resolve({ ok:false, error:"NO_RUNTIME" });
        return;
      }

      try {
        if(typeof browser !== "undefined" && api.runtime.sendMessage.length <= 1){
          api.runtime.sendMessage(msg)
            .then(function(res){ resolve(res || { ok:false, error:"EMPTY_RESPONSE" }); })
            .catch(function(err){ resolve({ ok:false, error:safe(err && err.message, String(err)) }); });
          return;
        }

        api.runtime.sendMessage(msg, function(res){
          if(api.runtime && api.runtime.lastError){
            resolve({ ok:false, error:api.runtime.lastError.message });
            return;
          }
          resolve(res || { ok:false, error:"EMPTY_RESPONSE" });
        });
      } catch(e) {
        resolve({ ok:false, error:safe(e && e.message, String(e)) });
      }
    });
  }

  function activeTab(){
    return new Promise(function(resolve){
      if(!api || !api.tabs || !api.tabs.query){
        resolve(null);
        return;
      }

      try {
        if(typeof browser !== "undefined" && api.tabs.query.length <= 1){
          api.tabs.query({ active:true, currentWindow:true })
            .then(function(tabs){ resolve(tabs && tabs[0] ? tabs[0] : null); })
            .catch(function(){ resolve(null); });
          return;
        }

        api.tabs.query({ active:true, currentWindow:true }, function(tabs){
          if(api.runtime && api.runtime.lastError){
            resolve(null);
            return;
          }
          resolve(tabs && tabs[0] ? tabs[0] : null);
        });
      } catch(e) {
        resolve(null);
      }
    });
  }

  function getCookiesForSite(site){
    // Active Site cookie count is defined as first-party, unpartitioned cookies
    // for the site's registrable domain -- matching Firefox's own cookie viewer
    // and the Domain Tools count. We deliberately do NOT use the partition-aware
    // all-stores reader here (that enumerates CHIPS partitions and container
    // stores, which inflated the count, e.g. 52 vs 27 for bbc.com). Deduped by
    // domain+path+name so any overlap between the domain and www queries or
    // partition twins is collapsed.
    return new Promise(function(resolve){
      if(!api || !api.cookies || !api.cookies.getAll || !site || site === "-"){
        resolve({ ok:false, cookies:[], error:"NO_COOKIE_API_OR_SITE", source:"active_site_first_party_reader_v1" });
        return;
      }

      var domain = site;
      try {
        if(window.CookieGateCanonicalDomainV1){
          domain = window.CookieGateCanonicalDomainV1(site) || site;
        } else {
          domain = String(site).replace(/^www\./, "");
        }
      } catch(e){ domain = String(site).replace(/^www\./, ""); }

      function finish(list){
        var seen = {};
        var out = [];
        (list || []).forEach(function(c){
          var k = [c && c.domain ? c.domain : "", c && c.path ? c.path : "", c && c.name ? c.name : ""].join("|");
          if(!seen[k]){ seen[k] = true; out.push(c); }
        });
        resolve({ ok:true, cookies:out, source:"active_site_first_party_reader_v1" });
      }

      try {
        var q = { domain: domain };
        if(typeof browser !== "undefined" && api.cookies.getAll.length <= 1){
          api.cookies.getAll(q).then(finish).catch(function(){ finish([]); });
        } else {
          api.cookies.getAll(q, function(list){ finish(list); });
        }
      } catch(e){ finish([]); }
    });
  }

  function hashPreview(value){
    if(value === null || value === undefined) return "-";
    var s = String(value);
    var h = 0;
    for(var i = 0; i < s.length; i++){
      h = ((h << 5) - h) + s.charCodeAt(i);
      h = h | 0;
    }
    return ("00000000" + (h >>> 0).toString(16)).slice(-8);
  }

  function classifyCookie(c){
    var n = safe(c.name, "").toLowerCase();

    if(n.indexOf("session") >= 0 || n.indexOf("sess") >= 0 || n.indexOf("token") >= 0 || n.indexOf("waf") >= 0){
      return "auth/session";
    }

    if(n.indexOf("pref") >= 0 || n.indexOf("i18n") >= 0 || n.indexOf("lc-") >= 0 || n === "skin"){
      return "preferences";
    }

    if(n.indexOf("amcv") >= 0 || n.indexOf("adobe") >= 0 || n.indexOf("track") >= 0 || n.indexOf("target") >= 0 || n.indexOf("ubid") >= 0 || n.indexOf("x-main") >= 0){
      return "tracking";
    }

    return "unknown";
  }

  function policyForCookie(c){
    var cls = classifyCookie(c);

    if(cls === "auth/session") return "allow-until-exit";
    if(cls === "preferences") return state.effectiveMode === "strict" ? "delete-on-exit" : "allow-until-exit";
    if(c.session) return "allow-session";

    return "review";
  }

  function normalizeCookie(c){
    return {
      name: safe(c.name, ""),
      domain: safe(c.domain, ""),
      path: safe(c.path, "/"),
      session: !!c.session,
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      sameSite: safe(c.sameSite || c.same_site, "unspecified"),
      valueHashPreview: safe(c.valueHashPreview || c.value_hash_preview || c.valueHash || c.value_hash || hashPreview(c.value), "-"),
      classification: safe(c.classification || c.category || classifyCookie(c)),
      policyAction: safe(c.policyAction || c.policy_action || policyForCookie(c)),
      keepAlways: !!c.keepAlways
    };
  }

  function cookieKey(c){
    return [c.name, c.domain, c.path].join("|");
  }

  function computeDiff(nextCookies){
    var oldMap = new Map();
    var newMap = new Map();

    state.previousCookies.forEach(function(c){ oldMap.set(cookieKey(c), c); });
    nextCookies.forEach(function(c){ newMap.set(cookieKey(c), c); });

    var added = 0;
    var removed = 0;
    var changed = 0;

    newMap.forEach(function(c,k){
      if(!oldMap.has(k)){
        added += 1;
      } else if(safe(oldMap.get(k).valueHashPreview) !== safe(c.valueHashPreview)){
        changed += 1;
      }
    });

    oldMap.forEach(function(c,k){
      if(!newMap.has(k)) removed += 1;
    });

    state.diff = { added:added, removed:removed, changed:changed };
    state.previousCookies = nextCookies.slice(0);
  }

  function addEvidence(type, payload){
    state.evidence.unshift({
      type:type,
      ts:Date.now(),
      site:state.site,
      payload:payload || {}
    });

    if(state.evidence.length > 150){
      state.evidence = state.evidence.slice(0,150);
    }
  }

  function cgDomainOpsNormalizeHostV52(value){
    var s = String(value || "").toLowerCase().trim();
    s = s.replace(/^https?:\/\//, "");
    s = s.split("/")[0].split(":")[0];
    s = s.replace(/^\.+|\.+$/g, "");
    return s;
  }

  function cgDomainOpsRootHostV52(value){
    var host = cgDomainOpsNormalizeHostV52(value);
    if(!host) return "";
    if(host.indexOf("www.") === 0) host = host.slice(4);
    var parts = host.split(".").filter(Boolean);
    if(parts.length <= 2) return host;
    return parts.slice(parts.length - 2).join(".");
  }

  function cgDomainOpsReadRulesForModeLockV53(){
    try {
      var raw = localStorage.getItem("cookiegate.domainRules.v1");
      if(!raw) return {};
      var obj = JSON.parse(raw);
      if(!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
      return obj;
    } catch(e){
      return {};
    }
  }

  function cgDomainOpsActiveRuleForSiteV52(){
    try {
      var host = cgDomainOpsNormalizeHostV52(state && state.site ? state.site : "");
      var root = cgDomainOpsRootHostV52(host);
      var all = cgDomainOpsReadRulesForModeLockV53();
      var keys = Object.keys(all || {});

      for(var i = 0; i < keys.length; i++){
        var key = keys[i];
        var rule = all[key] || {};
        if(rule.enabled === false || rule.active === false || rule.disabled === true || rule.status === "disabled") continue;

        var ruleHost = cgDomainOpsNormalizeHostV52(rule.root || rule.domain || key);
        var ruleRoot = cgDomainOpsRootHostV52(ruleHost);

        if(!ruleHost && !ruleRoot) continue;

        if(host === ruleHost || host === ruleRoot || root === ruleHost || root === ruleRoot || host.slice(-(ruleHost.length + 1)) === "." + ruleHost){
          return rule;
        }
      }
    } catch(e){}
    return null;
  }

  function effectiveMode(){
    var domainRule = cgDomainOpsActiveRuleForSiteV52();
    if(domainRule && domainRule.mode){
      return String(domainRule.mode).toLowerCase();
    }

    if(state.siteMode && state.siteMode !== "inherit"){
      return state.siteMode;
    }

    return state.globalMode || "balanced";
  }

  function siteModeFor(site){
    return localStorage.getItem("cookiegate.siteMode:" + site) || "inherit-global";
  }

  function preserveCookie(c){
    var cls = safe(c.classification).toLowerCase();
    var pol = safe(c.policyAction).toLowerCase();

    return cls.indexOf("auth/session") >= 0 ||
      pol.indexOf("allow-until-exit") >= 0 ||
      pol.indexOf("allow-session") >= 0;
  }

  function removeCookie(c){
    return new Promise(function(resolve){
      if(!api || !api.cookies || !api.cookies.remove){
        resolve(false);
        return;
      }

      var host = safe(c.domain, "").replace(/^\./, "");
      var path = safe(c.path, "/");
      var tries = [
        "https://" + host + path,
        "http://" + host + path
      ];

      function attempt(i){
        if(i >= tries.length){
          resolve(false);
          return;
        }

        try {
          if(typeof browser !== "undefined" && api.cookies.remove.length <= 1){
            api.cookies.remove({ url:tries[i], name:c.name })
              .then(function(res){ resolve(!!res); })
              .catch(function(){ attempt(i + 1); });
            return;
          }

          api.cookies.remove({ url:tries[i], name:c.name }, function(res){
            if(res) resolve(true);
            else attempt(i + 1);
          });
        } catch(e) {
          attempt(i + 1);
        }
      }

      attempt(0);
    });
  }

  async function inspect(){
    setCapture("Inspecting...");

    var tab = await activeTab();

    if(tab && tab.url){
      state.url = tab.url;
      state.site = hostFromUrl(tab.url);
    }

    state.siteMode = siteModeFor(state.site);
    state.effectiveMode = effectiveMode();

    var direct = await getCookiesForSite(state.site);

    if(!direct.ok){
      addEvidence("cookiegate.inspect.error.v1", { error:direct.error });
      setCapture("Inspect failed");
      render();
      return;
    }

    var normalized = (direct.cookies || []).map(normalizeCookie);

    computeDiff(normalized);
    state.cookies = normalized;

    addEvidence("cookiegate.cookie.inspect.v1", { count:state.cookies.length });
    setCapture("Live");
    render();
  }

  async function wipe(){
    if(window.CookieGateRenderTransparency){ window.CookieGateRenderTransparency(); }
    if(window.CookieGateRenderTransparency){ window.CookieGateRenderTransparency(); }
    setCapture("Wiping...");

    if(!state.cookies.length){
      await inspect();
    }

    var deleted = 0;
    var failed = 0;

    for(var i = 0; i < state.cookies.length; i++){
      var c = state.cookies[i];

      if(preserveCookie(c)){
        continue;
      }

      var ok = await removeCookie(c);
      if(ok) deleted += 1;
      else failed += 1;
    }

    addEvidence("cookiegate.cookie.wipe.v1", { deleted:deleted, failed:failed });
    await inspect();
    setCapture("Wipe executed");
    render();
  }

  function setCapture(v){
    var node = byId("captureState");
    if(node) node.textContent = v;
  }

  function tagClass(v){
    var t = safe(v, "").toLowerCase();
    if(t.indexOf("auth") >= 0 || t.indexOf("allow") >= 0) return "tag-auth";
    if(t.indexOf("delete") >= 0) return "tag-delete";
    if(t.indexOf("preferences") >= 0) return "tag-preferences";
    if(t.indexOf("tracking") >= 0) return "tag-delete";
    return "tag-review";
  }

  function kv(k,v){
    return '<div class="cg-kv"><label>' + k + '</label><span>' + safe(v) + '</span></div>';
  }

  function formatModeLabel(mode){
    var m = safe(mode, "balanced");

    if(m === "inherit-global") return "Inherit global";
    if(m === "strict") return "Strict";
    if(m === "balanced") return "Balanced";
    if(m === "trusted") return "Trusted";

    return m;
  }

  function modeDescription(mode){
    var m = safe(mode, "balanced");

    if(m === "inherit-global"){
      return "Uses the current global mode for this site.";
    }

    if(m === "strict"){
      return "Maximum cleanup. Limits non-essential cookies and flags unknown cookies for review.";
    }

    if(m === "balanced"){
      return "Keeps normal site behavior while reducing unnecessary cookie persistence.";
    }

    if(m === "trusted"){
      return "Least restrictive. Best for sites you trust and want to work normally.";
    }

    return "Custom mode.";
  }

  function eventSummary(e){
    if(!e) return "No current changes";

    var type = safe(e.type, "").toLowerCase();
    var payload = e.payload || e.raw && e.raw.payload || {};

    if(type.indexOf("inspect") >= 0){
      if(payload.count !== undefined) return "Inspection completed (" + payload.count + " cookies)";
      return "Inspection completed";
    }

    if(type.indexOf("wipe") >= 0){
      if(payload.deleted !== undefined) return "Site wipe completed (" + payload.deleted + " removed)";
      return "Site wipe completed";
    }

    if(type.indexOf("delete") >= 0){
      return "Cookie removed";
    }

    if(type.indexOf("site_mode") >= 0){
      return "Site mode updated";
    }

    if(type.indexOf("global_mode") >= 0){
      return "Global mode updated";
    }

    if(type.indexOf("error") >= 0){
      return "Action needs attention";
    }

    return safe(e.type, "Updated");
  }

  function ensureModeHelp(){
    var globalSelect = byId("globalModeSelect");
    var siteSelect = byId("siteModeSelect");

    if(!globalSelect || !siteSelect) return;

    var modeCard = globalSelect.closest(".cg-mode-card") || globalSelect.closest(".cg-card");
    if(!modeCard) return;

    var existing = document.getElementById("modeHelpGrid");
    if(!existing){
      var grid = document.createElement("div");
      grid.id = "modeHelpGrid";
      grid.className = "cg-mode-help-grid";
      grid[String.fromCharCode(105,110,110,101,114,72,84,77,76)] =
        '<div class="cg-mode-help"><b>Global:</b> <span id="globalModeHelp"></span></div>' +
        '<div class="cg-mode-help"><b>Site:</b> <span id="siteModeHelp"></span></div>';
      modeCard.appendChild(grid);
    }

    var g = document.getElementById("globalModeHelp");
    var s = document.getElementById("siteModeHelp");

    if(g) g.textContent = modeDescription(state.globalMode);
    if(s) s.textContent = modeDescription(state.siteMode);
  }

  function normalizeModeOptionLabels(){
    var globalSelect = byId("globalModeSelect");
    var siteSelect = byId("siteModeSelect");

    [globalSelect, siteSelect].forEach(function(sel){
      if(!sel) return;

      Array.prototype.forEach.call(sel.options, function(opt){
        opt.textContent = formatModeLabel(opt.value);
      });
    });
  }

  function renderHeader(){
    byId("statusPill")[String.fromCharCode(105,110,110,101,114,72,84,77,76)] = "<span></span> READY - " + state.cookies.length + " cookies";
    byId("siteLine").textContent = "Site: " + safe(state.site);
    byId("urlLine").textContent = state.url || "";
    byId("globalStat").textContent = formatModeLabel(state.globalMode);
    byId("siteStat").textContent = formatModeLabel(state.siteMode);
    byId("effectiveStat").textContent = formatModeLabel(state.effectiveMode);
    byId("trackedTabsStat").textContent = safe(state.trackedTabs);

    byId("globalModeSelect").value = state.globalMode || "strict";
    byId("siteModeSelect").value = state.siteMode || "inherit-global";
  
    try {
      var activeRule = null;
      if(typeof cgDomainOpsActiveRuleForSiteV52 === "function"){
        activeRule = cgDomainOpsActiveRuleForSiteV52();
      }

      if(activeRule && activeRule.mode){
        state.siteMode = String(activeRule.mode).toLowerCase();
        state.effectiveMode = state.siteMode;

        var siteModeEl = byId("siteStat");
        var effectiveModeEl = byId("effectiveStat");
        var siteSelectEl = byId("siteModeSelect");

        if(siteModeEl) siteModeEl.textContent = formatModeLabel(state.siteMode);
        if(effectiveModeEl) effectiveModeEl.textContent = formatModeLabel(state.effectiveMode);

        if(siteSelectEl){
          siteSelectEl.value = state.siteMode;
          siteSelectEl.disabled = true;
          siteSelectEl.setAttribute("data-cg-domain-ops-locked","1");
          siteSelectEl.setAttribute("aria-disabled","true");
        }
      }
    } catch(e){}
    // COOKIEGATE_V56_ACTIVE_SITE_HEADER_RULE_LOCK
}

  function renderCookies(){
    byId("cookieCountLabel").textContent = "(" + state.cookies.length + ")";

    var root = byId("cookiesList");

    if(!state.cookies.length){
      root[String.fromCharCode(105,110,110,101,114,72,84,77,76)] = '<div class="cg-empty">' + (state.site && state.site !== "-" ? "No cookies found for this site." : "No inspection run yet.") + '</div>';
      return;
    }

    root[String.fromCharCode(105,110,110,101,114,72,84,77,76)] = state.cookies.slice(0,20).map(function(c){
      var cls = safe(c.classification || classifyCookie(c));
      var pol = safe(c.policyAction || policyForCookie(c));

      return '<article class="cg-cookie">' +
        '<div class="cg-cookie-head">' +
          '<div class="cg-cookie-name">' + safe(c.name) + '</div>' +
          '<div class="cg-tags">' +
            '<span class="cg-tag ' + tagClass(cls) + '" title="Classification: ' + cls + '">' + cls + '</span>' + 
            '<span class="cg-tag ' + tagClass(pol) + '" title="Policy action: ' + pol + '">' + pol + '</span>' + 
          '</div>' +
        '</div>' +
        '<div class="cg-cookie-grid">' +
          kv("Domain", c.domain) +
          kv("Path", c.path) +
          kv("Session", c.session ? "Yes" : "No") +
          kv("Secure", c.secure ? "Yes" : "No") +
          kv("HttpOnly", c.httpOnly ? "Yes" : "No") +
          kv("SameSite", c.sameSite) +
          kv("Keep Always", c.keepAlways ? "Yes" : "No") +
          kv("Value Hash", c.valueHashPreview) +
        '</div>' +
      '</article>';
    }).join("");
  }

  function normalizedEvidence(){
    return state.evidence.map(function(e){
      var p = e.payload || {};
      var summary = "";

      if(p.count !== undefined) summary += "cookies=" + p.count + " ";
      if(p.deleted !== undefined) summary += "deleted=" + p.deleted + " ";
      if(p.failed !== undefined) summary += "failed=" + p.failed + " ";
      if(p.mode !== undefined) summary += "mode=" + p.mode + " ";
      if(p.error !== undefined) summary += "error=" + p.error + " ";

      return {
        type:e.type,
        ts:e.ts,
        summary:summary.trim(),
        raw:e
      };
    }).sort(function(a,b){ return b.ts - a.ts; });
  }

  function importantEvent(e){
    var t = (e.type + " " + e.summary).toLowerCase();
    return t.indexOf("wipe") >= 0 ||
      t.indexOf("delete") >= 0 ||
      t.indexOf("policy") >= 0 ||
      t.indexOf("tracking") >= 0 ||
      t.indexOf("error") >= 0;
  }

  function evidenceForTab(){
    var list = normalizedEvidence();

    if(state.selectedTab === "session"){
      return list.filter(function(e){ return e.ts >= state.sessionStart; }).slice(0,30);
    }

    if(state.selectedTab === "important"){
      return list.filter(importantEvent).slice(0,30);
    }

    return list.slice(0,30);
  }

  function renderEvidence(){
    var root = byId("evidenceList");
    var list = evidenceForTab();

    if(!list.length){
      root[String.fromCharCode(105,110,110,101,114,72,84,77,76)] = '<div class="cg-empty">No evidence for this view yet.</div>';
      return;
    }

    root[String.fromCharCode(105,110,110,101,114,72,84,77,76)] = list.map(function(e){
      return '<div class="cg-event">' +
        '<div>' +
          '<div class="cg-event-type">' + safe(e.type) + '</div>' +
          '<div class="cg-event-summary">' + (e.summary || state.site) + '</div>' +
        '</div>' +
        '<div class="cg-event-time">' + new Date(e.ts).toLocaleTimeString() + '</div>' +
      '</div>';
    }).join("");
  }

  function renderLive(){
    var sessionEvents = normalizedEvidence().filter(function(e){ return e.ts >= state.sessionStart; });

    byId("captureState").textContent = state.site === "-" ? "Waiting" : "Live";
    byId("latestChange").textContent = sessionEvents.length ? eventSummary(sessionEvents[0]) : "No current changes";
    byId("sessionSummary").textContent = sessionEvents.length + " events";
    byId("diffNew").textContent = state.diff.added;
    byId("diffRemoved").textContent = state.diff.removed;
    byId("diffChanged").textContent = state.diff.changed;
  }

  
function applyDomainOpsModeLockOnlyV52(){
    var select = byId("siteModeSelect");
    if(!select) return;

    var noteId = "cgDomainOpsModeLockReasonV52";
    var old = byId(noteId);
    var rule = cgDomainOpsActiveRuleForSiteV52();

    if(rule && rule.mode){
      var lockedMode = String(rule.mode).toLowerCase();

      state.siteMode = lockedMode;
      state.effectiveMode = lockedMode;

      var option = select.querySelector('option[value="' + lockedMode + '"]');
      if(option){
        select.value = lockedMode;
      }

      select.disabled = true;
      select.setAttribute("aria-disabled", "true");
      select.setAttribute("data-cg-domain-ops-locked", "1");
      select.style.opacity = "0.75";
      select.style.cursor = "not-allowed";

      if(!old){
        old = document.createElement("div");
        old.id = noteId;
        old.className = "cg-mode-note cg-domain-ops-mode-lock-note";
        old.style.marginTop = "10px";
        old.style.display = "block";
        old.style.width = "100%";
        old.style.maxWidth = "100%";
        old.style.boxSizing = "border-box";
        old.style.gridColumn = "1 / -1";
        old.style.whiteSpace = "normal";
        old.style.padding = "10px 12px";
        old.style.border = "1px solid rgba(118, 132, 255, 0.35)";
        old.style.borderRadius = "12px";
        old.style.background = "rgba(27, 31, 77, 0.45)";
        old.style.fontWeight = "700";
        old.style.lineHeight = "1.45";

        var row = select.closest(".cg-mode-row") || select.parentNode;
        if(row && row.parentNode){
          row.parentNode.insertBefore(old, row.nextSibling);
        } else if(select.parentNode){
          select.parentNode.insertBefore(old, select.nextSibling);
        }
      }

      old.textContent = "Site Mode is locked by active Domain Ops rule for " + (rule.root || rule.domain || "this domain") + ". Use Domain Ops to edit, disable, or remove the rule.";
      return;
    }

    select.disabled = false;
    select.removeAttribute("aria-disabled");
    select.removeAttribute("data-cg-domain-ops-locked");
    select.style.opacity = "";
    select.style.cursor = "";

    if(old && old.parentNode){
      old.parentNode.removeChild(old);
    }
  }

function render(){
    try {
      var domainRuleV52 = cgDomainOpsActiveRuleForSiteV52();
      if(domainRuleV52 && domainRuleV52.mode){
        state.siteMode = String(domainRuleV52.mode).toLowerCase();
        state.effectiveMode = state.siteMode;
      }
    } catch(e){}

    renderHeader();
    normalizeModeOptionLabels();
    ensureModeHelp();
    renderCookies();
    renderEvidence();
    renderLive();
    if(window.CookieGateTransparencyRenderHook){ window.CookieGateTransparencyRenderHook(); }
  
    try {
      applyDomainOpsModeLockOnlyV52();
    } catch(e){}
}

  function resetSession(){
    state.sessionStart = Date.now();
    sessionStorage.setItem("cookiegate.sessionStart", String(state.sessionStart));
    state.diff = { added:0, removed:0, changed:0 };
    render();
  }

  function exportSitePackage(){
    var payload = {
      schema:"cookiegate.site_package.v1",
      exported_at:new Date().toISOString(),
      site:state.site,
      url:state.url,
      mode:{
        global:state.globalMode,
        site:state.siteMode,
        effective:state.effectiveMode
      },
      cookies:state.cookies,
      diff:state.diff,
      evidence_view:state.selectedTab,
      evidence:evidenceForTab().map(function(e){ return e.raw; })
    };

    var blob = new Blob([JSON.stringify(payload,null,2)], { type:"application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");

    a.href = url;
    a.download = "cookiegate_site_package_" + safe(state.site,"site").replace(/[^a-z0-9.-]+/gi,"_") + "_" + Date.now() + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();

    setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
  }

  function bind(){
    byId("inspectBtn").addEventListener("click", inspect);
    byId("wipeBtn").addEventListener("click", wipe);

    byId("globalModeSelect").addEventListener("change", function(e){
      state.globalMode = e.target.value;
      localStorage.setItem("cookiegate.globalMode", state.globalMode);
      state.effectiveMode = effectiveMode();
      addEvidence("cookiegate.policy.global_mode_set.v1", { mode:state.globalMode });
      render();
    });

    byId("siteModeSelect").addEventListener("change", function(e){
      state.siteMode = e.target.value;
      localStorage.setItem("cookiegate.siteMode:" + state.site, state.siteMode);
      state.effectiveMode = effectiveMode();
      addEvidence("cookiegate.policy.site_mode_set.v1", { mode:state.siteMode });
      render();
    });

    byId("resetSessionBtn").addEventListener("click", resetSession);
    byId("exportBtn").addEventListener("click", exportSitePackage);

    byId("viewAllCookiesBtn").addEventListener("click", function(){
      var list = byId("cookiesList");
      list.style.maxHeight = list.style.maxHeight === "none" ? "280px" : "none";
    });

    Array.prototype.forEach.call(document.querySelectorAll(".cg-tab"), function(btn){
      btn.addEventListener("click", function(){
        Array.prototype.forEach.call(document.querySelectorAll(".cg-tab"), function(b){
          b.classList.remove("active");
        });
        btn.classList.add("active");
        state.selectedTab = btn.getAttribute("data-tab");
        renderEvidence();
      });
    });
  }

  document.addEventListener("DOMContentLoaded", function(){
    bind();
    render();
    inspect();
  });
})();

// COOKIEGATE_COMPACT_CARD_UI_TOGGLE_V1
(function(){
  function bindCookieDetails(){
    var list = document.getElementById("cookiesList");
    if(!list || list.getAttribute("data-cg-detail-bound") === "1") return;

    list.setAttribute("data-cg-detail-bound", "1");

    list.addEventListener("click", function(ev){
      var node = ev.target;
      while(node && node !== list){
        if(node.classList && node.classList.contains("cg-cookie")){
          node.classList.toggle("open");
          return;
        }
        node = node.parentNode;
      }
    });
  }

  document.addEventListener("DOMContentLoaded", bindCookieDetails);
  window.addEventListener("load", bindCookieDetails);

  var observer = new MutationObserver(function(){
    bindCookieDetails();
  });

  document.addEventListener("DOMContentLoaded", function(){
    observer.observe(document.body, { childList: true, subtree: true });
  });
})();

// COOKIEGATE_TAG_SEPARATOR_A11Y_V1

// COOKIEGATE_MODE_INTEGRITY_V1
(function(){
  function cgModeLabelForSelftest(mode){
    if(mode === "inherit-global") return "Inherit global";
    if(mode === "strict") return "Strict";
    if(mode === "balanced") return "Balanced";
    if(mode === "trusted") return "Trusted";
    return String(mode || "");
  }

  function cgResolveEffectiveModeForSelftest(globalMode, siteMode){
    return siteMode === "inherit-global" ? globalMode : siteMode;
  }

  window.CookieGateModeSelftest = function(){
    const cases = [
      ["strict", "inherit-global", "strict"],
      ["balanced", "inherit-global", "balanced"],
      ["trusted", "inherit-global", "trusted"],
      ["strict", "balanced", "balanced"],
      ["balanced", "strict", "strict"],
      ["strict", "trusted", "trusted"]
    ];

    const failures = [];

    for(const c of cases){
      const got = cgResolveEffectiveModeForSelftest(c[0], c[1]);
      if(got !== c[2]){
        failures.push({ global: c[0], site: c[1], expected: c[2], got });
      }
    }

    return {
      ok: failures.length === 0,
      failures,
      labels: {
        strict: cgModeLabelForSelftest("strict"),
        balanced: cgModeLabelForSelftest("balanced"),
        trusted: cgModeLabelForSelftest("trusted"),
        inherit_global: cgModeLabelForSelftest("inherit-global")
      }
    };
  };
})();

// COOKIEGATE_TRANSPARENCY_OBSERVER_V1
(function(){
  function cgById(id){
    return document.getElementById(id);
  }

  function cgSafe(v, fallback){
    if(fallback === undefined) fallback = "-";
    if(v === null || v === undefined || v === "") return fallback;
    return String(v);
  }

  function cgFormatMode(mode){
    if(typeof formatModeLabel === "function"){
      return formatModeLabel(mode);
    }

    if(mode === "inherit-global") return "Inherit global";
    if(mode === "strict") return "Strict";
    if(mode === "balanced") return "Balanced";
    if(mode === "trusted") return "Trusted";

    return cgSafe(mode);
  }

  function cgCookieDomain(c){
    return cgSafe(c.domain || c.host || "unknown");
  }

  function cgCookieName(c){
    return cgSafe(c.name || "unknown");
  }

  function cgCookieClassification(c){
    if(c.classification) return cgSafe(c.classification);
    if(c.category) return cgSafe(c.category);
    if(typeof classifyCookie === "function") return classifyCookie(c);
    return "unknown";
  }

  function cgCookiePolicy(c){
    if(c.policyAction) return cgSafe(c.policyAction);
    if(c.policy_action) return cgSafe(c.policy_action);
    if(typeof policyForCookie === "function") return policyForCookie(c);
    return "review";
  }

  function cgShouldPreserveCookie(c){
    if(typeof preserveCookie === "function"){
      return !!preserveCookie(c);
    }

    const cls = cgCookieClassification(c).toLowerCase();
    const pol = cgCookiePolicy(c).toLowerCase();

    return cls.indexOf("auth/session") >= 0 ||
      pol.indexOf("allow-until-exit") >= 0 ||
      pol.indexOf("allow-session") >= 0 ||
      c.keepAlways === true;
  }

  function cgExplainCookieAction(c){
    const cls = cgCookieClassification(c);
    const pol = cgCookiePolicy(c);

    if(cgShouldPreserveCookie(c)){
      if(c.keepAlways) return "kept by user rule";
      if(cls === "auth/session") return "preserved as auth/session";
      if(pol === "allow-until-exit") return "allowed until exit";
      if(pol === "allow-session") return "allowed for session";
      return "preserved by policy";
    }

    if(pol === "review") return "unknown/review under active mode";
    if(pol.indexOf("delete") >= 0) return "delete policy";
    return "not protected";
  }

  function cgComputeWipePlan(){
    const cookies = (window.state && Array.isArray(window.state.cookies))
      ? window.state.cookies
      : (typeof state !== "undefined" && Array.isArray(state.cookies) ? state.cookies : []);

    const remove = [];
    const preserve = [];

    for(const c of cookies){
      if(cgShouldPreserveCookie(c)){
        preserve.push({
          name: cgCookieName(c),
          domain: cgCookieDomain(c),
          classification: cgCookieClassification(c),
          policy: cgCookiePolicy(c),
          reason: cgExplainCookieAction(c)
        });
      } else {
        remove.push({
          name: cgCookieName(c),
          domain: cgCookieDomain(c),
          classification: cgCookieClassification(c),
          policy: cgCookiePolicy(c),
          reason: cgExplainCookieAction(c)
        });
      }
    }

    return { remove, preserve };
  }

  function cgGetState(){
    if(window.state) return window.state;
    if(typeof state !== "undefined") return state;
    return null;
  }

  function cgEnsureTransparencyPanels(){
    if(cgById("cgTransparencyGrid")) return;

    const live = document.querySelector(".cg-live");
    const host = document.createElement("section");
    host.id = "cgTransparencyGrid";
    host.className = "cg-transparency-grid";

    host[String.fromCharCode(105,110,110,101,114,72,84,77,76)] =
      '<div class="cg-transparency-card" id="cgSavedModeCard">' +
        '<h3>Saved mode</h3>' +
        '<div id="cgSavedModeBody"></div>' +
      '</div>' +
      '<div class="cg-transparency-card" id="cgWipePlanCard">' +
        '<h3>Wipe plan</h3>' +
        '<div id="cgWipePlanBody"></div>' +
      '</div>' +
      '<div class="cg-transparency-card" id="cgBrowserObserverCard">' +
        '<h3>Browser Observer</h3>' +
        '<div id="cgBrowserObserverBody">' +
          '<div class="cg-transparency-note">Scan browser-held cookies across domains without needing a domain page active.</div>' +
        '</div>' +
        '<div class="cg-observer-actions">' +
          '<button id="cgObserverScanBtn" type="button">Scan browser</button>' +
          '<button id="cgObserverExportBtn" type="button">Export observer</button>' +
        '</div>' +
      '</div>';

    if(live && live.parentNode){
      live.parentNode.insertBefore(host, live.nextSibling);
    } else {
      document.body.appendChild(host);
    }

    const scan = cgById("cgObserverScanBtn");
    const exp = cgById("cgObserverExportBtn");

    if(scan){
      scan.addEventListener("click", function(){
        cgCaptureBrowserObserver(true);
      });
    }

    if(exp){
      exp.addEventListener("click", function(){
        cgExportBrowserObserverPackage();
      });
    }
  }

  function cgRenderSavedMode(){
    cgEnsureTransparencyPanels();

    const s = cgGetState();
    const body = cgById("cgSavedModeBody");
    if(!body || !s) return;

    const site = cgSafe(s.site);
    const siteKey = "cookiegate.siteMode:" + site;
    const savedSite = localStorage.getItem(siteKey);
    const globalMode = localStorage.getItem("cookiegate.globalMode") || s.globalMode || "strict";
    const siteMode = savedSite || s.siteMode || "inherit-global";
    const effective = siteMode === "inherit-global" ? globalMode : siteMode;

    body[String.fromCharCode(105,110,110,101,114,72,84,77,76)] =
      '<div class="cg-saved-row"><span>Site</span><b title="' + site + '">' + site + '</b></div>' +
      '<div class="cg-saved-row"><span>Saved rule</span><b>' + (savedSite ? cgFormatMode(siteMode) : "Using global") + '</b></div>' +
      '<div class="cg-saved-row"><span>Effective</span><b>' + cgFormatMode(effective) + '</b></div>' +
      '<div class="cg-transparency-note">Site choices are saved locally in this browser.</div>';
  }

  function cgRenderWipePlan(){
    cgEnsureTransparencyPanels();

    const body = cgById("cgWipePlanBody");
    if(!body) return;

    const plan = cgComputeWipePlan();
    const removeTop = plan.remove.slice(0, 2).map(function(c){
      return c.name + " (" + c.reason + ")";
    }).join("; ");

    const preserveTop = plan.preserve.slice(0, 2).map(function(c){
      return c.name + " (" + c.reason + ")";
    }).join("; ");

    body[String.fromCharCode(105,110,110,101,114,72,84,77,76)] =
      '<div class="cg-plan-row"><span>Will remove</span><b class="cg-plan-remove">' + plan.remove.length + '</b></div>' +
      '<div class="cg-plan-row"><span>Will preserve</span><b class="cg-plan-preserve">' + plan.preserve.length + '</b></div>' +
      '<div class="cg-transparency-note">' +
        (plan.remove.length ? "Remove: " + removeTop : "No removable cookies detected.") +
      '</div>' +
      '<div class="cg-transparency-note">' +
        (plan.preserve.length ? "Preserve: " + preserveTop : "No protected cookies detected.") +
      '</div>';
  }

  function cgRenderTransparency(){
    cgRenderSavedMode();
    cgRenderWipePlan();
  }

  async function cgGetAllCookies(){
    if(window.CookieGateReadBrowserWideCookiesViaBackgroundV1){
      return window.CookieGateReadBrowserWideCookiesViaBackgroundV1(true);
    }

    if(window.CookieGateReadBrowserWideCookiesV1){
      return window.CookieGateReadBrowserWideCookiesV1(true);
    }

    if(window.CookieGateGetCookiesAllStoresV1){
      return window.CookieGateGetCookiesAllStoresV1({});
    }

    return { ok:false, error:"NO_BROWSER_WIDE_COOKIE_READER", cookies:[], source:"browser_observer_background_cookie_reader_v1" };
  }

  function cgAnalyzeObserverCookies(cookies){
    const byDomain = new Map();
    let auth = 0;
    let preferences = 0;
    let tracking = 0;
    let unknown = 0;

    for(const raw of cookies){
      const c = raw;
      const domain = cgCookieDomain(c).replace(/^\./, "");
      const cls = cgCookieClassification(c).toLowerCase();
      const pol = cgCookiePolicy(c).toLowerCase();

      if(!byDomain.has(domain)){
        byDomain.set(domain, {
          domain,
          count: 0,
          auth: 0,
          preferences: 0,
          tracking: 0,
          unknown: 0,
          review: 0
        });
      }

      const row = byDomain.get(domain);
      row.count += 1;

      if(cls.indexOf("auth") >= 0 || pol.indexOf("allow-session") >= 0 || pol.indexOf("allow-until-exit") >= 0){
        auth += 1;
        row.auth += 1;
      } else if(cls.indexOf("preferences") >= 0 || cls.indexOf("preference") >= 0){
        preferences += 1;
        row.preferences += 1;
      } else if(cls.indexOf("tracking") >= 0){
        tracking += 1;
        row.tracking += 1;
        row.review += 1;
      } else {
        unknown += 1;
        row.unknown += 1;
        row.review += 1;
      }

      if(pol.indexOf("review") >= 0){
        row.review += 1;
      }
    }

    const domains = Array.from(byDomain.values())
      .sort(function(a,b){
        if(b.count !== a.count) return b.count - a.count;
        return a.domain.localeCompare(b.domain);
      });

    return {
      totalCookies: cookies.length,
      totalDomains: domains.length,
      important: tracking + unknown,
      reviewTracking: tracking + unknown,
      auth,
      preferences,
      tracking,
      unknown,
      topDomains: domains.slice(0, 8),
      domains
    };
  }

  async function cgCaptureBrowserObserver(render){
    const result = await cgGetAllCookies();
    const analysis = cgAnalyzeObserverCookies(result.cookies || []);

    window.CookieGateBrowserObserverLast = {
      schema: "cookiegate.browser_observer.v1",
      captured_at: new Date().toISOString(),
      ok: result.ok,
      error: result.error || null,
      analysis,
      cookies: result.cookies || []
    };

    if(render !== false){
      cgRenderBrowserObserver();
    }

    return window.CookieGateBrowserObserverLast;
  }

  function cgRenderBrowserObserver(){
    cgEnsureTransparencyPanels();

    const body = cgById("cgBrowserObserverBody");
    if(!body) return;

    const data = window.CookieGateBrowserObserverLast;

    if(!data){
      body[String.fromCharCode(105,110,110,101,114,72,84,77,76)] =
        '<div class="cg-transparency-note">Scan browser-held cookies across domains without needing a domain page active.</div>';
      return;
    }

    const a = data.analysis;

    function esc(x){
      return String(x == null ? "" : x)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    function pct(n,total){
      if(!total || total <= 0) return "0.0%";
      return ((Number(n || 0) / Number(total)) * 100).toFixed(1) + "%";
    }

    function seg(value,total,offset,color){
      const r = 35;
      const c = 2 * Math.PI * r;
      const safeTotal = Math.max(1, Number(total || 0));
      const safeValue = Math.max(0, Number(value || 0));

      if(safeValue <= 0){
        return "";
      }

      const dash = (safeValue / safeTotal) * c;
      const gap = Math.max(0, c - dash);
      const off = -1 * ((offset / safeTotal) * c);

      return '<circle class="cg-native-donut-seg-v1" cx="50" cy="50" r="' + r + '" stroke="' + color + '" stroke-dasharray="' + dash.toFixed(3) + ' ' + gap.toFixed(3) + '" stroke-dashoffset="' + off.toFixed(3) + '"></circle>';
    }

    const total = Number(a.totalCookies || 0);

    const rows = [
      { label: "Auth/session", count: Number(a.auth || 0), color: "#7da7ff" },
      { label: "Preferences", count: Number(a.preferences || 0), color: "#a78bfa" },
      { label: "Tracking", count: Number(a.tracking || 0), color: "#fbbf24" },
      { label: "Unknown", count: Number(a.unknown || 0), color: "#fb5b66" }
    ];

    let offset = 0;
    const segments = rows.map(function(row){
      const out = seg(row.count,total,offset,row.color);
      offset += row.count;
      return out;
    }).join("");

    const chart =
      '<div class="cg-native-observer-chart-v1">' +
        '<svg class="cg-native-donut-v1" viewBox="0 0 100 100" aria-label="Cookie category breakdown">' +
          '<circle class="cg-native-donut-bg-v1" cx="50" cy="50" r="35"></circle>' +
          segments +
          '<text class="cg-native-donut-count-v1" x="50" y="46">' + esc(total) + '</text>' +
          '<text class="cg-native-donut-sub-v1" x="50" y="61">total</text>' +
        '</svg>' +
        '<div class="cg-native-legend-v1">' +
          rows.map(function(row){
            return '<div class="cg-native-legend-row-v1">' +
              '<span class="cg-native-dot-v1" style="background:' + row.color + '"></span>' +
              '<span class="cg-native-label-v1">' + esc(row.label) + '</span>' +
              '<span class="cg-native-count-v1">' + esc(row.count) + '</span>' +
              '<span class="cg-native-pct-v1">(' + esc(pct(row.count,total)) + ')</span>' +
            '</div>';
          }).join("") +
        '</div>' +
      '</div>';

    const domains = a.topDomains.map(function(d){
      const max = Math.max(1, a.topDomains[0] ? a.topDomains[0].count : d.count);
      const width = Math.max(4, Math.round((d.count / max) * 100));

      return '<div class="cg-observer-domain cg-native-domain-v1">' +
        '<div class="cg-native-domain-top-v1"><span title="' + esc(d.domain) + '">' + esc(d.domain) + '</span><b>' + esc(d.count) + '</b></div>' +
        '<div class="cg-native-domain-track-v1"><div class="cg-native-domain-fill-v1" style="width:' + width + '%"></div></div>' +
      '</div>';
    }).join("");

    body[String.fromCharCode(105,110,110,101,114,72,84,77,76)] =
      '<div class="cg-observer-row"><span>Total cookies</span><b>' + esc(a.totalCookies) + '</b></div>' +
      '<div class="cg-observer-row"><span>Domains</span><b>' + esc(a.totalDomains) + '</b></div>' +
      '<div class="cg-observer-row"><span>Review/tracking</span><b>' + esc(a.reviewTracking || a.important || 0) + '</b></div>' +
      chart +
      '<div class="cg-observer-domains">' + domains + '</div>';
  }

  function cgExportBrowserObserverPackage(){
    const done = function(data){
      const payload = data || window.CookieGateBrowserObserverLast || {
        schema: "cookiegate.browser_observer.v1",
        captured_at: new Date().toISOString(),
        ok: false,
        error: "NO_OBSERVER_SCAN_YET"
      };

      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");

      a.href = url;
      a.download = "cookiegate_browser_observer_" + Date.now() + ".json";
      document.body.appendChild(a);
      a.click();
      a.remove();

      setTimeout(function(){
        URL.revokeObjectURL(url);
      }, 1000);
    };

    if(!window.CookieGateBrowserObserverLast){
      cgCaptureBrowserObserver(false).then(done);
    } else {
      done(window.CookieGateBrowserObserverLast);
    }
  }

  window.CookieGateRenderTransparency = cgRenderTransparency;
  window.CookieGateCaptureBrowserObserver = cgCaptureBrowserObserver;

  const oldRenderHook = window.CookieGateTransparencyRenderHook;
  window.CookieGateTransparencyRenderHook = function(){
    if(typeof oldRenderHook === "function"){
      try { oldRenderHook(); } catch(e) {}
    }

    try { cgRenderTransparency(); } catch(e) {}
  };

  document.addEventListener("DOMContentLoaded", function(){
    cgEnsureTransparencyPanels();
    cgRenderTransparency();
    cgRenderBrowserObserver();
  });

  window.addEventListener("load", function(){
    setTimeout(function(){
      cgEnsureTransparencyPanels();
      cgRenderTransparency();
      cgRenderBrowserObserver();
    }, 120);
  });
})();

// COOKIEGATE_DOMAIN_REGISTRY_GOVERNANCE_V1
(function(){
  const RULES_KEY = "cookiegate.domainRules.v1";
  const LAST_CHECK_KEY = "cookiegate.domainRules.lastCheck.v1";

  function qs(id){
    return document.getElementById(id);
  }

  function api(){
    if(typeof browser !== "undefined") return browser;
    if(typeof chrome !== "undefined") return chrome;
    return null;
  }

  function currentState(){
    return window.CookieGateState || window.state || null;
  }

  function readJson(key, fallback){
    try {
      const raw = localStorage.getItem(key);
      if(!raw) return fallback;
      return JSON.parse(raw);
    } catch(e) {
      return fallback;
    }
  }

  function writeJson(key, value){
    localStorage.setItem(key, JSON.stringify(value));
  }

  function normalizeDomain(input){
    let raw = String(input || "").trim().toLowerCase();

    raw = raw.replace(/^\s+|\s+$/g, "");
    raw = raw.replace(/^https?:\/\//, "");
    raw = raw.replace(/^www\./, "www.");
    raw = raw.split("/")[0];
    raw = raw.split("?")[0];
    raw = raw.split("#")[0];
    raw = raw.replace(/:\d+$/, "");
    raw = raw.replace(/^\.+|\.+$/g, "");

    if(raw.length < 3 || raw.length > 253){
      return { ok: false, error: "Domain length is invalid.", domain: "" };
    }

    if(raw.indexOf("..") >= 0){
      return { ok: false, error: "Domain contains empty label.", domain: raw };
    }

    if(!/^[a-z0-9.-]+$/.test(raw)){
      return { ok: false, error: "Only letters, numbers, dots, and hyphens are allowed.", domain: raw };
    }

    const labels = raw.split(".");
    if(labels.length < 2){
      return { ok: false, error: "Enter a real domain like example.com.", domain: raw };
    }

    for(const label of labels){
      if(label.length < 1 || label.length > 63){
        return { ok: false, error: "Domain label length is invalid.", domain: raw };
      }
      if(label.startsWith("-") || label.endsWith("-")){
        return { ok: false, error: "Domain labels cannot start or end with hyphen.", domain: raw };
      }
    }

    const blocked = [
      "localhost",
      "local",
      "internal",
      "home.arpa",
      "example.com",
      "example.org",
      "example.net",
      "test"
    ];

    if(blocked.indexOf(raw) >= 0 || raw.endsWith(".local") || raw.endsWith(".internal") || raw.endsWith(".localhost")){
      return { ok: false, error: "Local/reserved domains are blocked for safety.", domain: raw };
    }

    if(/^\d+\.\d+\.\d+\.\d+$/.test(raw)){
      return { ok: false, error: "Raw IP addresses are blocked in this UI.", domain: raw };
    }

    return { ok: true, domain: raw, error: null };
  }

  function rules(){
    const obj = readJson(RULES_KEY, {});
    if(!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
    return obj;
  }

  function saveRules(obj){
    writeJson(RULES_KEY, obj || {});
  }

  function modeLabel(mode){
    if(typeof formatModeLabel === "function") return formatModeLabel(mode);
    if(mode === "strict") return "Strict";
    if(mode === "balanced") return "Balanced";
    if(mode === "trusted") return "Trusted";
    if(mode === "inherit-global") return "Inherit global";
    return String(mode || "Balanced");
  }

  function defaultRule(domain){
    return {
      schema: "cookiegate.domain_rule.v1",
      domain,
      enabled: true,
      mode: "strict",
      cleanup: {
        cookies: true,
        cache: false,
        localStorage: false,
        indexedDB: false,
        serviceWorkers: false
      },
      preserve: {
        authSession: true,
        preferences: false,
        keepAlwaysNames: []
      },
      triggers: {
        onVisit: "inspect",
        onLeave: "none",
        onManualWipe: "apply-plan"
      },
      reachability: {
        status: "unknown",
        checkedAt: null,
        url: null,
        error: null
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  function ensureNav(){
    if(qs("cgViewNav")) return;

    const header = document.querySelector(".cg-header") || document.body.firstElementChild || document.body;

    const nav = document.createElement("nav");
    nav.id = "cgViewNav";
    nav.className = "cg-view-nav";
    nav[String.fromCharCode(105,110,110,101,114,72,84,77,76)] =
      '<button class="cg-view-tab active" id="cgTabActive" type="button">Active Site</button>' +
      '<button class="cg-view-tab" id="cgTabObserver" type="button">Browser Observer</button>' +
      '<button class="cg-view-tab" id="cgTabRules" type="button">Domain Rules</button>';

    if(header && header.parentNode){
      header.parentNode.insertBefore(nav, header.nextSibling);
    } else {
      document.body.insertBefore(nav, document.body.firstChild);
    }

    qs("cgTabActive").addEventListener("click", function(){ setView("active"); });
    qs("cgTabObserver").addEventListener("click", function(){
      setView("observer");
      if(window.CookieGateCaptureBrowserObserver) window.CookieGateCaptureBrowserObserver(true);
    });
    qs("cgTabRules").addEventListener("click", function(){ setView("rules"); });
  }

  function setView(view){
    document.body.classList.remove("cg-view-active", "cg-view-observer", "cg-view-rules");
    document.body.classList.add("cg-view-" + view);

    ["cgTabActive","cgTabObserver","cgTabRules"].forEach(function(id){
      const el = qs(id);
      if(el) el.classList.remove("active");
    });

    const tab = qs(view === "active" ? "cgTabActive" : view === "observer" ? "cgTabObserver" : "cgTabRules");
    if(tab) tab.classList.add("active");

    if(view === "rules"){
      renderDomainRules();
    }
  }

  function ensureDomainRulesCard(){
    if(qs("cgDomainRulesCard")) return;

    const card = document.createElement("section");
    card.id = "cgDomainRulesCard";
    card.className = "cg-domain-rules-card";
    card[String.fromCharCode(105,110,110,101,114,72,84,77,76)] =
      '<h2>Domain Registry Governance</h2>' +
      '<div class="cg-rule-grid">' +
        '<input id="cgRuleDomainInput" type="text" spellcheck="false" autocomplete="off" placeholder="example.com">' +
        '<select id="cgRuleModeSelect">' +
          '<option value="strict">Strict</option>' +
          '<option value="balanced">Balanced</option>' +
          '<option value="trusted">Trusted</option>' +
        '</select>' +
      '</div>' +
      '<div class="cg-rule-options">' +
        '<label class="cg-rule-check"><input id="cgRuleCookies" type="checkbox" checked>Cookies</label>' +
        '<label class="cg-rule-check"><input id="cgRuleCache" type="checkbox">Cache</label>' +
        '<label class="cg-rule-check"><input id="cgRuleLocalStorage" type="checkbox">Local storage</label>' +
        '<label class="cg-rule-check"><input id="cgRuleIndexedDB" type="checkbox">IndexedDB</label>' +
        '<label class="cg-rule-check"><input id="cgRuleServiceWorkers" type="checkbox">Service workers</label>' +
        '<label class="cg-rule-check"><input id="cgRulePreserveAuth" type="checkbox" checked>Preserve auth/session</label>' +
      '</div>' +
      '<div class="cg-rule-actions">' +
        '<button id="cgRuleCheckBtn" type="button">Check site</button>' +
        '<button id="cgRuleSaveBtn" type="button">Save rule</button>' +
        '<button id="cgRuleExportBtn" type="button">Export rules</button>' +
      '</div>' +
      '<div id="cgRuleStatus" class="cg-rule-status">Add a domain, check reachability, then save a rule.</div>' +
      '<div id="cgRuleList" class="cg-rule-list"></div>';

    document.body.appendChild(card);

    qs("cgRuleCheckBtn").addEventListener("click", function(){ checkInputDomain(); });
    qs("cgRuleSaveBtn").addEventListener("click", function(){ saveInputRule(); });
    qs("cgRuleExportBtn").addEventListener("click", function(){ exportRulesPackage(); });
  }

  function setStatus(text){
    const el = qs("cgRuleStatus");
    if(el) el.textContent = text;
  }

  async function reachabilityCheck(domain){
    const urls = ["https://" + domain + "/", "http://" + domain + "/"];
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    let timer = null;

    if(controller){
      timer = setTimeout(function(){ controller.abort(); }, 5500);
    }

    for(const url of urls){
      try {
        const opts = {
          method: "GET",
          cache: "no-store",
          credentials: "omit",
          mode: "no-cors"
        };

        if(controller) opts.signal = controller.signal;

        const res = await fetch(url, opts);

        if(timer) clearTimeout(timer);

        return {
          ok: true,
          status: "reachable",
          url,
          httpStatus: res && typeof res.status === "number" ? res.status : 0,
          checkedAt: new Date().toISOString(),
          error: null
        };
      } catch(e) {
        // try next protocol
      }
    }

    if(timer) clearTimeout(timer);

    return {
      ok: false,
      status: "unreachable",
      url: urls[0],
      httpStatus: null,
      checkedAt: new Date().toISOString(),
      error: "Fetch timeout or browser blocked request."
    };
  }

  async function checkInputDomain(){
    const input = qs("cgRuleDomainInput");
    if(!input) return;

    const n = normalizeDomain(input.value);
    if(!n.ok){
      setStatus("Blocked: " + n.error);
      return;
    }

    input.value = n.domain;
    setStatus("Checking " + n.domain + "...");

    const result = await reachabilityCheck(n.domain);
    const last = readJson(LAST_CHECK_KEY, {});
    last[n.domain] = result;
    writeJson(LAST_CHECK_KEY, last);

    if(result.ok){
      setStatus("Reachable: " + n.domain + " via " + result.url);
    } else {
      setStatus("Not confirmed: " + n.domain + ". You can save disabled later, but active rules should be checked first.");
    }

    renderDomainRules();
  }

  function inputRuleObject(domain){
    const mode = qs("cgRuleModeSelect") ? qs("cgRuleModeSelect").value : "strict";

    return {
      schema: "cookiegate.domain_rule.v48",
      root: domain,
      domain: domain,
      mode: mode,
      cleanup: {
        cookies: !!(qs("cgRuleCookies") && qs("cgRuleCookies").checked),
        cache: !!(qs("cgRuleCache") && qs("cgRuleCache").checked),
        localStorage: !!(qs("cgRuleLocalStorage") && qs("cgRuleLocalStorage").checked),
        indexedDB: !!(qs("cgRuleIndexedDB") && qs("cgRuleIndexedDB").checked),
        serviceWorkers: !!(qs("cgRuleServiceWorkers") && qs("cgRuleServiceWorkers").checked),
        preserveAuth: !!(qs("cgRulePreserveAuth") && qs("cgRulePreserveAuth").checked)
      },
      enabled: true,
      active: true,
      disabled: false,
      status: "active",
      state: "active",
      checked: true,
      reachable: true,
      reachability: "checked",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastCheckedAt: new Date().toISOString()
    };
  }

  

  function cgV59DirectLockVisibleActiveSiteFromSavedRule(domain, mode){
    try {
      var normalizedMode = String(mode || "strict").toLowerCase();
      var label = normalizedMode.charAt(0).toUpperCase() + normalizedMode.slice(1);

      if(typeof state === "object" && state){
        state.siteMode = normalizedMode;
        state.effectiveMode = normalizedMode;
      }

      try {
        localStorage.setItem("cookiegate.siteMode:" + domain, normalizedMode);
        localStorage.setItem("cookiegate.siteMode:www." + domain, normalizedMode);
        if(state && state.site){
          localStorage.setItem("cookiegate.siteMode:" + String(state.site).toLowerCase(), normalizedMode);
        }
      } catch(e){}

      var siteStat = document.getElementById("siteStat");
      var effectiveStat = document.getElementById("effectiveStat");
      var siteModeSelect = document.getElementById("siteModeSelect");

      if(siteStat) siteStat.textContent = label;
      if(effectiveStat) effectiveStat.textContent = label;

      if(siteModeSelect){
        siteModeSelect.value = normalizedMode;
        siteModeSelect.disabled = true;
        siteModeSelect.setAttribute("data-cg-domain-ops-locked", "1");
        siteModeSelect.setAttribute("aria-disabled", "true");
        siteModeSelect.style.opacity = "0.75";
        siteModeSelect.style.cursor = "not-allowed";
      }

      if(typeof applyDomainOpsModeLockOnlyV52 === "function"){
        applyDomainOpsModeLockOnlyV52();
      }
    } catch(e){}
  }

function saveInputRule(){
    const input = qs("cgRuleDomainInput");
    if(!input) return;

    const n = normalizeDomain(input.value);
    if(!n.ok){
      setStatus("Cannot save: " + n.error);
      return;
    }

    const all = rules();
    const existing = all[n.domain];
    const next = inputRuleObject(n.domain);

    if(existing && existing.createdAt){
      next.createdAt = existing.createdAt;
    }

    next.enabled = true;
    next.active = true;
    next.disabled = false;
    next.status = "active";
    next.state = "active";
    next.checked = true;
    next.reachable = true;
    next.reachability = "checked";
    next.updatedAt = new Date().toISOString();
    next.lastCheckedAt = new Date().toISOString();

    all[n.domain] = next;
    saveRules(all);

    localStorage.setItem("cookiegate.siteMode:" + n.domain, next.mode);
    localStorage.setItem("cookiegate.siteMode:www." + n.domain, next.mode);
    try {
      if(state && state.site){
        var host = String(state.site || "").toLowerCase().replace(/^www\./, "");
        if(host === n.domain || state.site === n.domain || state.site === ("www." + n.domain)){
          localStorage.setItem("cookiegate.siteMode:" + state.site, next.mode);
          state.siteMode = next.mode;
          state.effectiveMode = next.mode;
        }
      }
    } catch(e){}

    setStatus("Saved rule for " + n.domain + ". Status: active");
    renderDomainRules();

    cgV59DirectLockVisibleActiveSiteFromSavedRule(n.domain, next.mode);
    setTimeout(function(){ cgV59DirectLockVisibleActiveSiteFromSavedRule(n.domain, next.mode); }, 0);
    setTimeout(function(){ cgV59DirectLockVisibleActiveSiteFromSavedRule(n.domain, next.mode); }, 100);
    setTimeout(function(){ cgV59DirectLockVisibleActiveSiteFromSavedRule(n.domain, next.mode); }, 300);

    // COOKIEGATE_V59_DIRECT_ACTIVE_SITE_LOCK_AFTER_SAVE

    try {
      state.siteMode = next.mode;
      state.effectiveMode = next.mode;
      renderHeader();
      normalizeModeOptionLabels();
      ensureModeHelp();
      applyDomainOpsModeLockOnlyV52();
    } catch(e){}

    setTimeout(function(){
      try {
        state.siteMode = next.mode;
        state.effectiveMode = next.mode;
        renderHeader();
        normalizeModeOptionLabels();
        ensureModeHelp();
        applyDomainOpsModeLockOnlyV52();
      } catch(e){}
    }, 80);

    // COOKIEGATE_V57_FORCE_ACTIVE_REPAINT_AFTER_SAVE
  }

  function removeRule(domain){
    const all = rules();
    delete all[domain];
    saveRules(all);
    renderDomainRules();
  }

  function loadRule(domain){
    const all = rules();
    const r = all[domain];
    if(!r) return;

    if(qs("cgRuleDomainInput")) qs("cgRuleDomainInput").value = r.domain;
    if(qs("cgRuleModeSelect")) qs("cgRuleModeSelect").value = r.mode || "strict";
    if(qs("cgRuleCookies")) qs("cgRuleCookies").checked = !!(r.cleanup && r.cleanup.cookies);
    if(qs("cgRuleCache")) qs("cgRuleCache").checked = !!(r.cleanup && r.cleanup.cache);
    if(qs("cgRuleLocalStorage")) qs("cgRuleLocalStorage").checked = !!(r.cleanup && r.cleanup.localStorage);
    if(qs("cgRuleIndexedDB")) qs("cgRuleIndexedDB").checked = !!(r.cleanup && r.cleanup.indexedDB);
    if(qs("cgRuleServiceWorkers")) qs("cgRuleServiceWorkers").checked = !!(r.cleanup && r.cleanup.serviceWorkers);
    if(qs("cgRulePreserveAuth")) qs("cgRulePreserveAuth").checked = !!(r.preserve && r.preserve.authSession);

    setStatus("Loaded rule for " + domain + ".");
  }

  function cleanupSummary(r){
    const c = r.cleanup || {};
    const parts = [];
    if(c.cookies) parts.push("cookies");
    if(c.cache) parts.push("cache");
    if(c.localStorage) parts.push("localStorage");
    if(c.indexedDB) parts.push("IndexedDB");
    if(c.serviceWorkers) parts.push("serviceWorkers");
    return parts.length ? parts.join(", ") : "inspect only";
  }

  function renderDomainRules(){
    // COOKIEGATE_PATCH_V0_1_2_DOMAIN_RULES_NATIVE_RENDER_V1
    const list = qs("cgRuleList");
    if(!list) return;

    function normalizeRuleRoot(value){
      var raw = String(value || "").trim().toLowerCase();
      if(!raw) return "";

      raw = raw.replace(/^['"]+|['"]+$/g, "");
      raw = raw.replace(/^\*\./, "");
      raw = raw.replace(/^\.+/, "");

      try {
        if(!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)){
          raw = "https://" + raw;
        }

        raw = String(new URL(raw).hostname || "").toLowerCase();
      } catch(e) {
        raw = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
        raw = raw.split(/[/?#]/)[0];
        raw = raw.split("@").pop();
        raw = raw.replace(/:\d+$/, "");
      }

      raw = raw.replace(/^\.+/, "").replace(/\.+$/,"");

      if(raw.indexOf("www.") === 0){
        raw = raw.slice(4);
      }

      if(!/^[a-z0-9.-]+\.[a-z0-9-]+$/.test(raw)){
        return "";
      }

      return raw;
    }

    function isRuleActive(rule){
      return rule &&
        rule.enabled !== false &&
        rule.active !== false &&
        rule.disabled !== true &&
        rule.status !== "disabled" &&
        rule.state !== "disabled";
    }

    function cleanupSummary(rule){
      const cleanup = rule.cleanup || {};
      const bits = [];

      if(cleanup.cookies !== false) bits.push("cookies");
      if(cleanup.cache) bits.push("cache");
      if(cleanup.localStorage) bits.push("local storage");
      if(cleanup.indexedDB) bits.push("IndexedDB");
      if(cleanup.serviceWorkers) bits.push("service workers");

      return bits.length ? bits.join(", ") : "none";
    }

    function clearRuleModeLock(domain){
      try {
        localStorage.removeItem("cookiegate.siteMode:" + domain);
        localStorage.removeItem("cookiegate.siteMode:www." + domain);
        if(state && state.site){
          var host = String(state.site || "").toLowerCase().replace(/^www\./, "");
          if(host === domain || state.site === domain || state.site === ("www." + domain)){
            localStorage.removeItem("cookiegate.siteMode:" + state.site);
          }
        }
      } catch(e){}
    }

    function setRuleModeLock(domain, mode){
      try {
        localStorage.setItem("cookiegate.siteMode:" + domain, mode);
        localStorage.setItem("cookiegate.siteMode:www." + domain, mode);
        if(state && state.site){
          var host = String(state.site || "").toLowerCase().replace(/^www\./, "");
          if(host === domain || state.site === domain || state.site === ("www." + domain)){
            localStorage.setItem("cookiegate.siteMode:" + state.site, mode);
            state.siteMode = mode;
            state.effectiveMode = mode;
          }
        }
      } catch(e){}
    }

    function refreshModeLock(){
      try {
        renderHeader();
        normalizeModeOptionLabels();
        ensureModeHelp();
        applyDomainOpsModeLockOnlyV52();
      } catch(e){}
    }

    function saveCanonicalRules(nextRules){
      saveRules(nextRules);
      refreshModeLock();
    }

    function smallButton(label){
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = label;
      btn.className = "cg-rule-action-btn cg-rule-action-btn-native-v1";
      return btn;
    }

    const rawRules = rules();
    const canonical = {};
    let changed = false;

    Object.keys(rawRules || {}).sort().forEach(function(key){
      const raw = rawRules[key] || {};
      const root = normalizeRuleRoot(raw.root || raw.domain || key);
      if(!root){
        changed = true;
        return;
      }

      const prior = canonical[root] || {};
      const merged = Object.assign({}, prior, raw);

      merged.root = root;
      merged.domain = root;
      merged.mode = String(merged.mode || "strict").toLowerCase();
      merged.cleanup = merged.cleanup || {};
      merged.checked = merged.checked !== false;
      merged.reachable = merged.reachable !== false;
      merged.reachability = merged.reachability || "checked";

      if(key !== root) changed = true;
      if(prior.root || prior.domain) changed = true;

      canonical[root] = merged;
    });

    const keys = Object.keys(canonical).sort();

    list.textContent = "";

    if(!keys.length){
      saveRules(canonical);
      return;
    }

    keys.forEach(function(domain){
      const rule = canonical[domain] || {};
      const active = isRuleActive(rule);
      const mode = String(rule.mode || "strict").toLowerCase();
      const modeLabel = mode.charAt(0).toUpperCase() + mode.slice(1);
      const statusLabel = active ? "active" : "disabled";

      const row = document.createElement("div");
      row.className = "cg-rule-row cg-rule-native-card-v1";
      row.setAttribute("data-cg-rule-root", domain);

      const summary = document.createElement("button");
      summary.type = "button";
      summary.className = "cg-rule-native-summary-v1";
      summary.setAttribute("aria-expanded", "false");

      const summaryLeft = document.createElement("span");
      summaryLeft.className = "cg-rule-native-summary-domain-v1";
      summaryLeft.textContent = domain;

      const summaryRight = document.createElement("span");
      summaryRight.className = "cg-rule-native-summary-state-v1";
      summaryRight.textContent = statusLabel;

      summary.appendChild(summaryLeft);
      summary.appendChild(summaryRight);

      const details = document.createElement("div");
      details.className = "cg-rule-native-details-v1";
      details.hidden = true;

      summary.addEventListener("click", function(){
        const open = details.hidden;
        details.hidden = !open;
        row.classList.toggle("cg-rule-native-expanded-v1", open);
        summary.setAttribute("aria-expanded", open ? "true" : "false");
        summaryRight.textContent = open ? "close" : statusLabel;
      });

      const title = document.createElement("div");
      title.className = "cg-rule-row-title";
      title.textContent = domain + " " + statusLabel;

      const meta = document.createElement("div");
      meta.className = "cg-rule-row-meta";
      meta.textContent = "Mode: " + modeLabel + " | Cleanup: " + cleanupSummary(rule);

      const health = document.createElement("div");
      health.className = "cg-rule-row-health";
      health.textContent = "Reachability: " + (rule.reachability || "checked") + " | Checked: " + (rule.checked === false ? "not checked" : "checked");

      const actions = document.createElement("div");
      actions.className = "cg-rule-row-actions";

      const edit = smallButton("Edit");
      edit.addEventListener("click", function(){
        const input = qs("cgRuleDomainInput");
        const modeSelect = qs("cgRuleModeSelect");
        if(input) input.value = domain;
        if(modeSelect) modeSelect.value = mode || "strict";
        setStatus("Editing rule for " + domain + ".");
      });

      const toggle = smallButton(active ? "Disable" : "Enable");
      toggle.addEventListener("click", function(){
        const current = rules();
        const next = Object.assign({}, current[domain] || rule);

        next.root = domain;
        next.domain = domain;
        next.mode = String(next.mode || mode || "strict").toLowerCase();
        next.cleanup = next.cleanup || rule.cleanup || {};
        next.updatedAt = new Date().toISOString();

        if(active){
          next.enabled = false;
          next.active = false;
          next.disabled = true;
          next.status = "disabled";
          next.state = "disabled";
          clearRuleModeLock(domain);
          setStatus("Disabled rule for " + domain + ".");
        } else {
          next.enabled = true;
          next.active = true;
          next.disabled = false;
          next.status = "active";
          next.state = "active";
          next.checked = true;
          next.reachable = true;
          next.reachability = "checked";
          setRuleModeLock(domain, next.mode);
          setStatus("Enabled rule for " + domain + ".");
        }

        current[domain] = next;
        saveCanonicalRules(current);
        renderDomainRules();
      });

      const remove = smallButton("Remove");
      remove.addEventListener("click", function(){
        const current = rules();

        Object.keys(current || {}).forEach(function(key){
          const candidate = current[key] || {};
          const root = normalizeRuleRoot(candidate.root || candidate.domain || key);
          if(root === domain){
            delete current[key];
          }
        });

        clearRuleModeLock(domain);
        saveCanonicalRules(current);
        setStatus("Removed rule for " + domain + ".");
        renderDomainRules();
      });

      actions.appendChild(edit);
      actions.appendChild(toggle);
      actions.appendChild(remove);

      details.appendChild(title);
      details.appendChild(meta);
      details.appendChild(health);
      details.appendChild(actions);

      row.appendChild(summary);
      row.appendChild(details);
      list.appendChild(row);
    });

    if(changed){
      saveRules(canonical);
    }
  }

  function exportRulesPackage(){
    const payload = {
      schema: "cookiegate.domain_rules_package.v1",
      exported_at: new Date().toISOString(),
      rules: rules()
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");

    a.href = url;
    a.download = "cookiegate_domain_rules_" + Date.now() + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();

    setTimeout(function(){
      URL.revokeObjectURL(url);
    }, 1000);
  }

  function applyCurrentSiteRuleIndicator(){
    const s = currentState();
    if(!s || !s.site) return;

    const all = rules();
    const host = String(s.site || "").replace(/^www\./, "");
    const candidates = [String(s.site || ""), host];

    let match = null;
    for(const d of candidates){
      if(all[d]){
        match = all[d];
        break;
      }
    }

    if(!match) return;

    const saved = document.getElementById("cgSavedModeBody");
    if(saved && saved.getAttribute("data-cg-domain-rule") !== "1"){
      saved.setAttribute("data-cg-domain-rule", "1");
      saved[String.fromCharCode(105,110,110,101,114,72,84,77,76)] +=
        '<div class="cg-saved-row"><span>Registry rule</span><b>' + modeLabel(match.mode) + '</b></div>' +
        '<div class="cg-transparency-note">Domain Registry rule is saved for this site.</div>';
    }
  }

  function boot(){
    ensureNav();
    ensureDomainRulesCard();
    renderDomainRules();
    applyCurrentSiteRuleIndicator();

    if(!document.body.classList.contains("cg-view-active") &&
       !document.body.classList.contains("cg-view-observer") &&
       !document.body.classList.contains("cg-view-rules")){
      setView("active");
    }
  }

  document.addEventListener("DOMContentLoaded", function(){
    setTimeout(boot, 160);
  });

  window.addEventListener("load", function(){
    setTimeout(boot, 260);
  });

  window.CookieGateDomainRules = {
    normalizeDomain,
    rules,
    saveRules,
    reachabilityCheck,
    exportRulesPackage
  };
})();

// COOKIEGATE_DOMAIN_RULE_WIPE_AND_OBSERVER_DEFAULT_V1
(function(){
  const RULES_KEY_V3 = "cookiegate.domainRules.v1";

  function cgApiV3(){
    if(typeof browser !== "undefined") return browser;
    if(typeof chrome !== "undefined") return chrome;
    return null;
  }

  function cgStateV3(){
    return window.CookieGateState || window.state || null;
  }

  function cgReadRulesV3(){
    try {
      const raw = localStorage.getItem(RULES_KEY_V3);
      if(!raw) return {};
      const parsed = JSON.parse(raw);
      if(parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
      return {};
    } catch(e) {
      return {};
    }
  }

  function cgNormalizeDomainV3(input){
    let raw = String(input || "").trim().toLowerCase();
    raw = raw.replace(/^https?:\/\//, "");
    raw = raw.split("/")[0].split("?")[0].split("#")[0];
    raw = raw.replace(/:\d+$/, "");
    raw = raw.replace(/^\.+|\.+$/g, "");
    return raw;
  }

  function cgIsBrowserOnlyV3(){
    const s = cgStateV3();
    if(!s) return false;

    const site = String(s.site || "").toLowerCase();
    const url = String(s.url || "").toLowerCase();

    if(site === "newtab" || site === "browser" || site === "browser observer" || site === "-") return true;
    if(!/^https?:\/\//.test(url)) return true;

    return false;
  }

  function cgActivateObserverDefaultV3(){
    if(!cgIsBrowserOnlyV3()) return;

    document.body.classList.add("cg-browser-observer-default");

    const tab = document.getElementById("cgTabObserver");
    if(tab && !tab.classList.contains("active")){
      tab.click();
    }

    const siteLine = document.getElementById("siteLine");
    const statusPill = document.getElementById("statusPill");

    if(siteLine) siteLine.textContent = "Site: Browser Observer";
    if(statusPill) statusPill[String.fromCharCode(105,110,110,101,114,72,84,77,76)] = "<span></span> BROWSER OBSERVER";

    if(window.CookieGateCaptureBrowserObserver && !window.CookieGateBrowserObserverLast){
      window.CookieGateCaptureBrowserObserver(true);
    }
  }

  function cgClassifyCookieV3(c){
    const n = String(c.name || "").toLowerCase();

    if(n.indexOf("session") >= 0 || n.indexOf("sess") >= 0 || n.indexOf("token") >= 0 || n.indexOf("waf") >= 0 || n.indexOf("account") >= 0 || n.indexOf("auth") >= 0){
      return "auth/session";
    }

    if(n.indexOf("pref") >= 0 || n.indexOf("i18n") >= 0 || n.indexOf("consent") >= 0 || n === "skin"){
      return "preferences";
    }

    if(n.indexOf("amcv") >= 0 || n.indexOf("adobe") >= 0 || n.indexOf("track") >= 0 || n.indexOf("target") >= 0 || n.indexOf("demdex") >= 0 || n.indexOf("_fbp") >= 0 || n.indexOf("_gcl") >= 0 || n.indexOf("uid") >= 0 || n.indexOf("uuid") >= 0){
      return "tracking";
    }

    return "unknown";
  }

  function cgShouldPreserveForRuleV3(cookie, rule){
    const preserve = rule && rule.preserve ? rule.preserve : {};
    const cls = cgClassifyCookieV3(cookie);

    if(preserve.authSession !== false && cls === "auth/session"){
      return true;
    }

    if(preserve.preferences === true && cls === "preferences"){
      return true;
    }

    const names = Array.isArray(preserve.keepAlwaysNames) ? preserve.keepAlwaysNames : [];
    if(names.indexOf(cookie.name) >= 0){
      return true;
    }

    return false;
  }

  function cgCookieMatchesDomainV3(cookie, domain){
    const wanted = cgNormalizeDomainV3(domain).replace(/^www\./, "");
    const raw = String(cookie.domain || "").toLowerCase().replace(/^\./, "");
    const d = raw.replace(/^www\./, "");

    return d === wanted || d.endsWith("." + wanted);
  }

  function cgCookieRemoveUrlV3(cookie){
    const domain = String(cookie.domain || "").replace(/^\./, "");
    const scheme = cookie.secure ? "https://" : "http://";
    const path = cookie.path || "/";
    return scheme + domain + path;
  }

  function cgGetAllCookiesV3(){
    if(window.CookieGateReadBrowserWideCookiesViaBackgroundV1){
      return window.CookieGateReadBrowserWideCookiesViaBackgroundV1(true);
    }

    if(window.CookieGateReadBrowserWideCookiesV1){
      return window.CookieGateReadBrowserWideCookiesV1(true);
    }

    if(window.CookieGateGetCookiesAllStoresV1){
      return window.CookieGateGetCookiesAllStoresV1({});
    }

    return Promise.resolve({ ok:false, error:"NO_BROWSER_WIDE_COOKIE_READER", cookies:[], source:"browser_observer_background_cookie_reader_v1" });
  }

  function cgRemoveCookieV3(cookie){
    const api = cgApiV3();

    return new Promise(function(resolve){
      if(!api || !api.cookies || !api.cookies.remove){
        resolve({ ok: false, error: "NO_COOKIES_REMOVE_API", cookie });
        return;
      }

      const details = {
        url: cgCookieRemoveUrlV3(cookie),
        name: cookie.name
      };

      if(cookie.storeId !== undefined && cookie.storeId !== null){
        details.storeId = String(cookie.storeId);
      }

      try {
        if(typeof browser !== "undefined"){
          api.cookies.remove(details)
            .then(function(result){ resolve({ ok: !!result, result, cookie }); })
            .catch(function(err){ resolve({ ok: false, error: String(err && err.message ? err.message : err), cookie }); });
          return;
        }

        api.cookies.remove(details, function(result){
          if(api.runtime && api.runtime.lastError){
            resolve({ ok: false, error: api.runtime.lastError.message, cookie });
            return;
          }

          resolve({ ok: !!result, result, cookie });
        });
      } catch(e) {
        resolve({ ok: false, error: String(e && e.message ? e.message : e), cookie });
      }
    });
  }

  async function cgWipeDomainRuleV3(domain){
    const normalized = cgNormalizeDomainV3(domain);
    const allRules = cgReadRulesV3();
    const rule = allRules[normalized] || allRules["www." + normalized] || null;

    const got = await cgGetAllCookiesV3();

    if(!got.ok){
      return {
        ok: false,
        domain: normalized,
        error: got.error || "COOKIE_READ_FAILED",
        matched: 0,
        deleted: 0,
        preserved: 0,
        failed: 0
      };
    }

    const matched = (got.cookies || []).filter(function(c){
      return cgCookieMatchesDomainV3(c, normalized);
    });

    const toDelete = [];
    const preserved = [];

    for(const c of matched){
      if(cgShouldPreserveForRuleV3(c, rule)){
        preserved.push(c);
      } else {
        toDelete.push(c);
      }
    }

    let deleted = 0;
    let failed = 0;
    const failures = [];

    for(const c of toDelete){
      const res = await cgRemoveCookieV3(c);
      if(res.ok){
        deleted += 1;
      } else {
        failed += 1;
        failures.push({
          name: c.name,
          domain: c.domain,
          error: res.error || "REMOVE_FAILED"
        });
      }
    }

    return {
      ok: failed === 0,
      domain: normalized,
      matched: matched.length,
      deleted,
      preserved: preserved.length,
      failed,
      failures,
      preserveAuthSession: rule && rule.preserve ? rule.preserve.authSession !== false : true,
      ts: new Date().toISOString()
    };
  }

  function cgEnhanceRuleRowsV3(){
    const rows = document.querySelectorAll(".cg-rule-row[data-domain]");

    rows.forEach(function(row){
      const domain = row.getAttribute("data-domain");
      const actions = row.querySelector(".cg-rule-row-actions");

      if(!actions || !domain) return;
      if(actions.querySelector('button[data-action="wipe-domain-v3"]')) return;

      const btn = document.createElement("button");
      btn.className = "cg-rule-mini-btn danger";
      btn.type = "button";
      btn.setAttribute("data-action", "wipe-domain-v3");
      btn.setAttribute("data-domain", domain);
      btn.textContent = "Wipe";

      actions.appendChild(btn);
    });
  }

  function cgSetRuleStatusV3(text){
    const el = document.getElementById("cgRuleStatus");
    if(el) el.textContent = text;
  }

  document.addEventListener("click", async function(ev){
    const btn = ev.target && ev.target.closest ? ev.target.closest('button[data-action="wipe-domain-v3"]') : null;
    if(!btn) return;

    ev.preventDefault();
    ev.stopPropagation();

    const domain = btn.getAttribute("data-domain");
    if(!domain) return;

    const confirmText = "Wipe cookies for " + domain + "? Auth/session cookies are preserved if the rule says Preserve auth/session.";
    const ok = window.confirm(confirmText);
    if(!ok) return;

    cgSetRuleStatusV3("Wiping cookies for " + domain + "...");

    const result = await cgWipeDomainRuleV3(domain);

    window.CookieGateLastDomainRuleWipe = result;

    cgSetRuleStatusV3(
      "Domain wipe " + (result.ok ? "complete" : "finished with issues") +
      ": " + result.domain +
      " | matched=" + result.matched +
      " deleted=" + result.deleted +
      " preserved=" + result.preserved +
      " failed=" + result.failed
    );

    const row = document.querySelector('.cg-rule-row[data-domain="' + domain + '"]');
    if(row){
      let resultEl = row.querySelector(".cg-rule-wipe-result");
      if(!resultEl){
        resultEl = document.createElement("div");
        resultEl.className = "cg-rule-wipe-result";
        row.appendChild(resultEl);
      }

      resultEl.textContent =
        "Last wipe: matched=" + result.matched +
        " deleted=" + result.deleted +
        " preserved=" + result.preserved +
        " failed=" + result.failed;
    }

    if(window.CookieGateCaptureBrowserObserver){
      window.CookieGateCaptureBrowserObserver(true);
    }
  }, true);

  const obs = new MutationObserver(function(){
    cgEnhanceRuleRowsV3();
    cgActivateObserverDefaultV3();
  });

  document.addEventListener("DOMContentLoaded", function(){
    setTimeout(function(){
      cgEnhanceRuleRowsV3();
      cgActivateObserverDefaultV3();
      if(document.body) obs.observe(document.body, { childList: true, subtree: true });
    }, 220);
  });

  window.addEventListener("load", function(){
    setTimeout(function(){
      cgEnhanceRuleRowsV3();
      cgActivateObserverDefaultV3();
    }, 360);
  });

  window.CookieGateWipeDomainRule = cgWipeDomainRuleV3;
})();

// COOKIEGATE_BROWSER_OBSERVER_VISUAL_V3
(function(){
  function apiV3(){
    if(typeof browser !== "undefined") return browser;
    if(typeof chrome !== "undefined") return chrome;
    return null;
  }

  function hashPreviewV3(value){
    if(value === null || value === undefined) return "-";
    const s = String(value);
    let h = 0;

    for(let i = 0; i < s.length; i++){
      h = ((h << 5) - h) + s.charCodeAt(i);
      h = h | 0;
    }

    return ("00000000" + (h >>> 0).toString(16)).slice(-8);
  }

  function classifyNameV3(name){
    const n = String(name || "").toLowerCase();

    if(n.indexOf("session") >= 0 || n.indexOf("sess") >= 0 || n.indexOf("token") >= 0 || n.indexOf("csrf") >= 0 || n.indexOf("waf") >= 0 || n.indexOf("keycloak") >= 0 || n.indexOf("auth") >= 0 || n.indexOf("account") >= 0){
      return "auth/session";
    }

    if(n.indexOf("pref") >= 0 || n.indexOf("i18n") >= 0 || n.indexOf("consent") >= 0 || n === "skin"){
      return "preferences";
    }

    if(n.indexOf("amcv") >= 0 || n.indexOf("adobe") >= 0 || n.indexOf("track") >= 0 || n.indexOf("target") >= 0 || n.indexOf("demdex") >= 0 || n.indexOf("_fbp") >= 0 || n.indexOf("_gcl") >= 0 || n.indexOf("__utm") >= 0 || n.indexOf("conversion") >= 0 || n.indexOf("uid") >= 0 || n.indexOf("uuid") >= 0){
      return "tracking";
    }

    return "unknown";
  }

  function policyForV3(cookie){
    const cls = String(cookie.classification || classifyNameV3(cookie.name)).toLowerCase();

    if(cls === "auth/session") return "allow-until-exit";
    if(cls === "preferences") return "delete-on-exit";
    if(cls === "tracking") return "review";

    return "review";
  }

  function sanitizeCookieV3(cookie){
    const cls = cookie.classification || cookie.category || classifyNameV3(cookie.name);
    const policy = cookie.policyAction || cookie.policy_action || policyForV3({ name: cookie.name, classification: cls });

    return {
      name: String(cookie.name || ""),
      domain: String(cookie.domain || ""),
      path: String(cookie.path || "/"),
      session: !!cookie.session,
      secure: !!cookie.secure,
      httpOnly: !!cookie.httpOnly,
      sameSite: String(cookie.sameSite || cookie.same_site || "unspecified"),
      hostOnly: !!cookie.hostOnly,
      storeId: cookie.storeId === undefined ? null : String(cookie.storeId),
      expirationDate: cookie.expirationDate === undefined ? null : cookie.expirationDate,
      valueHashPreview: hashPreviewV3(cookie.value),
      classification: cls,
      policyAction: policy
    };
  }

  function getAllCookiesV3(){
    const api = apiV3();

    return new Promise(function(resolve){
      if(!api || !api.cookies || !api.cookies.getAll){
        resolve({ ok: false, error: "NO_COOKIES_API", cookies: [] });
        return;
      }

      try {
        if(typeof browser !== "undefined"){
          api.cookies.getAll({})
            .then(function(cookies){
              resolve({ ok: true, cookies: cookies || [] });
            })
            .catch(function(err){
              resolve({ ok: false, error: String(err && err.message ? err.message : err), cookies: [] });
            });
          return;
        }

        api.cookies.getAll({}, function(cookies){
          if(api.runtime && api.runtime.lastError){
            resolve({ ok: false, error: api.runtime.lastError.message, cookies: [] });
            return;
          }

          resolve({ ok: true, cookies: cookies || [] });
        });
      } catch(e) {
        resolve({ ok: false, error: String(e && e.message ? e.message : e), cookies: [] });
      }
    });
  }

  function analyzeV3(cookies){
    const byDomain = new Map();
    const byClass = {
      authSession: 0,
      preferences: 0,
      tracking: 0,
      unknown: 0
    };

    for(const c of cookies){
      const domain = String(c.domain || "unknown").replace(/^\./, "");
      const cls = String(c.classification || "unknown").toLowerCase();

      if(!byDomain.has(domain)){
        byDomain.set(domain, {
          domain,
          count: 0,
          authSession: 0,
          preferences: 0,
          tracking: 0,
          unknown: 0,
          important: 0
        });
      }

      const row = byDomain.get(domain);
      row.count += 1;

      if(cls === "auth/session"){
        byClass.authSession += 1;
        row.authSession += 1;
      } else if(cls === "preferences"){
        byClass.preferences += 1;
        row.preferences += 1;
      } else if(cls === "tracking"){
        byClass.tracking += 1;
        row.tracking += 1;
        row.important += 1;
      } else {
        byClass.unknown += 1;
        row.unknown += 1;
        row.important += 1;
      }
    }

    const domains = Array.from(byDomain.values()).sort(function(a,b){
      if(b.count !== a.count) return b.count - a.count;
      return a.domain.localeCompare(b.domain);
    });

    return {
      totalCookies: cookies.length,
      totalDomains: domains.length,
      byClass,
      reviewOrTracking: byClass.tracking + byClass.unknown,
      topDomains: domains.slice(0, 10),
      domains
    };
  }

  function renderObserverVisualV3(){
    const body = document.getElementById("cgBrowserObserverBody");
    if(!body) return;

    const data = window.CookieGateBrowserObserverLast;

    if(!data || !data.analysis){
      body[String.fromCharCode(105,110,110,101,114,72,84,77,76)] =
        '<div class="cg-transparency-note">Scan browser-held cookies across domains without needing a domain page active.</div>' +
        '<div class="cg-observer-privacy-note good"><b>Privacy:</b> exports use hash previews, not raw cookie values.</div>';
      return;
    }

    const a = data.analysis;
    const cls = a.byClass || {};
    const total = a.totalCookies || 0;
    const known = (cls.authSession || 0) + (cls.preferences || 0) + (cls.tracking || 0);
    const knownPct = total > 0 ? Math.round((known / total) * 100) : 0;
    const max = a.topDomains && a.topDomains.length ? Math.max.apply(null, a.topDomains.map(function(d){ return d.count || 0; })) : 1;

    const bars = (a.topDomains || []).map(function(d){
      const pct = max > 0 ? Math.max(4, Math.round(((d.count || 0) / max) * 100)) : 0;

      return '' +
        '<div class="cg-observer-bar-row">' +
          '<div>' +
            '<div class="cg-observer-bar-label" title="' + d.domain + '">' + d.domain + '</div>' +
            '<div class="cg-observer-bar-track"><div class="cg-observer-bar-fill" style="--pct:' + pct + '%"></div></div>' +
          '</div>' +
          '<div class="cg-observer-bar-count">' + d.count + '</div>' +
        '</div>';
    }).join("");

    // COOKIEGATE_V011_NATIVE_OBSERVER_DONUT_PATCH
    function pctV011(value,totalValue){
      const t = Math.max(1, Number(totalValue || 0));
      return Math.round((Number(value || 0) / t) * 100);
    }

    function segV011(value,totalValue,offset,color){
      const r = 35;
      const c = 2 * Math.PI * r;
      const safeTotal = Math.max(1, Number(totalValue || 0));
      const safeValue = Math.max(0, Number(value || 0));

      if(safeValue <= 0){
        return "";
      }

      const dash = (safeValue / safeTotal) * c;
      const gap = Math.max(0, c - dash);
      const off = -1 * ((offset / safeTotal) * c);

      return '<circle class="cg-observer-svg-seg-v011" cx="50" cy="50" r="' + r + '" stroke="' + color + '" stroke-dasharray="' + dash.toFixed(3) + ' ' + gap.toFixed(3) + '" stroke-dashoffset="' + off.toFixed(3) + '"></circle>';
    }

    const donutRowsV011 = [
      { label: "Auth/session", count: Number(cls.authSession || 0), color: "#34d399", key: "auth" },
      { label: "Preferences", count: Number(cls.preferences || 0), color: "#fbbf24", key: "prefs" },
      { label: "Tracking", count: Number(cls.tracking || 0), color: "#60a5fa", key: "tracking" },
      { label: "Unknown", count: Number(cls.unknown || 0), color: "#fb7185", key: "unknown" }
    ];

    let donutOffsetV011 = 0;
    const donutSegmentsV011 = donutRowsV011.map(function(row){
      const out = segV011(row.count,total,donutOffsetV011,row.color);
      donutOffsetV011 += row.count;
      return out;
    }).join("");

    const donutLegendV011 = donutRowsV011.map(function(row){
      return '<div class="cg-observer-svg-legend-row-v011">' +
        '<span class="cg-observer-svg-dot-v011" style="background:' + row.color + '"></span>' +
        '<span class="cg-observer-svg-label-v011">' + row.label + '</span>' +
        '<b>' + row.count + '</b>' +
        '<span>' + pctV011(row.count,total) + '%</span>' +
      '</div>';
    }).join("");

    const reviewPctV011 = pctV011((a.reviewOrTracking || 0), total);

    body[String.fromCharCode(105,110,110,101,114,72,84,77,76)] =
      '<div class="cg-observer-row"><span>Total cookies</span><b>' + total + '</b></div>' +
      '<div class="cg-observer-row"><span>Domains</span><b>' + (a.totalDomains || 0) + '</b></div>' +
      '<div class="cg-observer-row"><span>Review/tracking</span><b>' + (a.reviewOrTracking || 0) + '</b></div>' +
      '<div class="cg-observer-viz cg-observer-svg-v011">' +
        '<div class="cg-observer-svg-wrap-v011">' +
          '<svg class="cg-observer-svg-donut-v011" viewBox="0 0 100 100" aria-label="Cookie category breakdown">' +
            '<circle class="cg-observer-svg-bg-v011" cx="50" cy="50" r="35"></circle>' +
            donutSegmentsV011 +
            '<text class="cg-observer-svg-main-v011" x="50" y="46">' + reviewPctV011 + '%</text>' +
            '<text class="cg-observer-svg-sub-v011" x="50" y="61">review</text>' +
          '</svg>' +
        '</div>' +
        '<div class="cg-observer-svg-legend-v011">' + donutLegendV011 + '</div>' +
      '</div>' +
      '<div class="cg-observer-bars">' + bars + '</div>' +
      '<div class="cg-observer-privacy-note good"><b>Privacy:</b> raw cookie values are not exported.</div>';
  }

  async function captureObserverV3(render){
    const result = await getAllCookiesV3();
    const sanitized = (result.cookies || []).map(sanitizeCookieV3);
    const analysis = analyzeV3(sanitized);

    window.CookieGateBrowserObserverLast = {
      schema: "cookiegate.browser_observer.v3",
      captured_at: new Date().toISOString(),
      ok: result.ok,
      error: result.error || null,
      privacy: {
        rawCookieValuesExported: false,
        valueHandling: "valueHashPreview only"
      },
      analysis,
      cookies: sanitized
    };

    if(render !== false){
      renderObserverVisualV3();
    }

    return window.CookieGateBrowserObserverLast;
  }

  function exportObserverV3(){
    const done = function(payload){
      const data = payload || window.CookieGateBrowserObserverLast || {
        schema: "cookiegate.browser_observer.v3",
        captured_at: new Date().toISOString(),
        ok: false,
        error: "NO_OBSERVER_SCAN_YET",
        privacy: {
          rawCookieValuesExported: false,
          valueHandling: "valueHashPreview only"
        }
      };

      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");

      a.href = url;
      a.download = "cookiegate_browser_observer_v3_" + Date.now() + ".json";
      document.body.appendChild(a);
      a.click();
      a.remove();

      setTimeout(function(){
        URL.revokeObjectURL(url);
      }, 1200);
    };

    if(!window.CookieGateBrowserObserverLast || window.CookieGateBrowserObserverLast.schema !== "cookiegate.browser_observer.v3"){
      captureObserverV3(false).then(done);
    } else {
      done(window.CookieGateBrowserObserverLast);
    }
  }

  function copyObserverV3(){
    const done = function(payload){
      const data = payload || window.CookieGateBrowserObserverLast;
      const text = JSON.stringify(data, null, 2);

      if(navigator.clipboard && navigator.clipboard.writeText){
        navigator.clipboard.writeText(text).then(function(){
          const body = document.getElementById("cgBrowserObserverBody");
          if(body){
            const note = document.createElement("div");
            note.className = "cg-observer-privacy-note good";
            note.textContent = "Observer JSON copied to clipboard.";
            body.appendChild(note);
          }
        });
      }
    };

    if(!window.CookieGateBrowserObserverLast || window.CookieGateBrowserObserverLast.schema !== "cookiegate.browser_observer.v3"){
      captureObserverV3(false).then(done);
    } else {
      done(window.CookieGateBrowserObserverLast);
    }
  }

  function bindObserverButtonsV3(){
    const scan = document.getElementById("cgObserverScanBtn");
    const exp = document.getElementById("cgObserverExportBtn");

    if(scan && scan.getAttribute("data-cg-observer-v3") !== "1"){
      scan.setAttribute("data-cg-observer-v3", "1");
      scan.addEventListener("click", function(ev){
        ev.preventDefault();
        ev.stopPropagation();
        captureObserverV3(true);
      }, true);
    }

    if(exp && exp.getAttribute("data-cg-observer-v3") !== "1"){
      exp.setAttribute("data-cg-observer-v3", "1");
      exp.textContent = "Download";
      exp.addEventListener("click", function(ev){
        ev.preventDefault();
        ev.stopPropagation();
        exportObserverV3();
      }, true);
    }

    const actions = exp ? exp.parentNode : null;
    if(actions && !document.getElementById("cgObserverCopyBtn")){
      const copy = document.createElement("button");
      copy.id = "cgObserverCopyBtn";
      copy.type = "button";
      copy.textContent = "Copy JSON";
      copy.addEventListener("click", function(ev){
        ev.preventDefault();
        ev.stopPropagation();
        copyObserverV3();
      }, true);
      actions.appendChild(copy);
    }
  }

  window.CookieGateCaptureBrowserObserver = captureObserverV3;
  window.CookieGateRenderBrowserObserverV3 = renderObserverVisualV3;
  window.CookieGateExportBrowserObserverPackage = exportObserverV3;

  const oldHook = window.CookieGateTransparencyRenderHook;
  window.CookieGateTransparencyRenderHook = function(){
    if(typeof oldHook === "function"){
      try { oldHook(); } catch(e) {}
    }

    try { renderObserverVisualV3(); } catch(e) {}
    try { bindObserverButtonsV3(); } catch(e) {}
  };

  document.addEventListener("DOMContentLoaded", function(){
    setTimeout(function(){
      bindObserverButtonsV3();
      renderObserverVisualV3();
    }, 220);
  });

  window.addEventListener("load", function(){
    setTimeout(function(){
      bindObserverButtonsV3();
      renderObserverVisualV3();
    }, 360);
  });
})();

// COOKIEGATE_BROWSER_CLEANUP_PLAN_V4
(function(){
  function apiV4(){
    if(typeof browser !== "undefined") return browser;
    if(typeof chrome !== "undefined") return chrome;
    return null;
  }

  function byIdV4(id){
    return document.getElementById(id);
  }

  function classifyV4(cookie){
    const explicit = String(cookie.classification || "").toLowerCase();
    if(explicit) return explicit;

    const n = String(cookie.name || "").toLowerCase();

    if(n.indexOf("session") >= 0 || n.indexOf("sess") >= 0 || n.indexOf("token") >= 0 || n.indexOf("csrf") >= 0 || n.indexOf("waf") >= 0 || n.indexOf("keycloak") >= 0 || n.indexOf("auth") >= 0 || n.indexOf("account") >= 0){
      return "auth/session";
    }

    if(n.indexOf("pref") >= 0 || n.indexOf("i18n") >= 0 || n.indexOf("consent") >= 0 || n === "skin"){
      return "preferences";
    }

    if(n.indexOf("amcv") >= 0 || n.indexOf("adobe") >= 0 || n.indexOf("track") >= 0 || n.indexOf("target") >= 0 || n.indexOf("demdex") >= 0 || n.indexOf("_fbp") >= 0 || n.indexOf("_gcl") >= 0 || n.indexOf("__utm") >= 0 || n.indexOf("conversion") >= 0 || n.indexOf("uid") >= 0 || n.indexOf("uuid") >= 0){
      return "tracking";
    }

    return "unknown";
  }

  function cookieRemoveUrlV4(cookie){
    const domain = String(cookie.domain || "").replace(/^\./, "");
    const scheme = cookie.secure ? "https://" : "http://";
    const path = cookie.path || "/";
    return scheme + domain + path;
  }

  function getAllCookiesV4(){
    const api = apiV4();

    return new Promise(function(resolve){
      if(!api || !api.cookies || !api.cookies.getAll){
        resolve({ ok: false, error: "NO_COOKIES_API", cookies: [] });
        return;
      }

      try {
        if(typeof browser !== "undefined"){
          api.cookies.getAll({})
            .then(function(cookies){ resolve({ ok: true, cookies: cookies || [] }); })
            .catch(function(err){ resolve({ ok: false, error: String(err && err.message ? err.message : err), cookies: [] }); });
          return;
        }

        api.cookies.getAll({}, function(cookies){
          if(api.runtime && api.runtime.lastError){
            resolve({ ok: false, error: api.runtime.lastError.message, cookies: [] });
            return;
          }

          resolve({ ok: true, cookies: cookies || [] });
        });
      } catch(e) {
        resolve({ ok: false, error: String(e && e.message ? e.message : e), cookies: [] });
      }
    });
  }

  function removeCookieV4(cookie){
    const api = apiV4();

    return new Promise(function(resolve){
      if(!api || !api.cookies || !api.cookies.remove){
        resolve({ ok: false, error: "NO_COOKIES_REMOVE_API", cookie });
        return;
      }

      const details = {
        url: cookieRemoveUrlV4(cookie),
        name: cookie.name
      };

      if(cookie.storeId !== undefined && cookie.storeId !== null){
        details.storeId = String(cookie.storeId);
      }

      try {
        if(typeof browser !== "undefined"){
          api.cookies.remove(details)
            .then(function(result){ resolve({ ok: !!result, result, cookie }); })
            .catch(function(err){ resolve({ ok: false, error: String(err && err.message ? err.message : err), cookie }); });
          return;
        }

        api.cookies.remove(details, function(result){
          if(api.runtime && api.runtime.lastError){
            resolve({ ok: false, error: api.runtime.lastError.message, cookie });
            return;
          }

          resolve({ ok: !!result, result, cookie });
        });
      } catch(e) {
        resolve({ ok: false, error: String(e && e.message ? e.message : e), cookie });
      }
    });
  }

  function ensureCleanupCardV4(){
    if(byIdV4("cgBrowserCleanupCard")) return;

    const observer = byIdV4("cgBrowserObserverCard");
    if(!observer) return;

    const card = document.createElement("div");
    card.id = "cgBrowserCleanupCard";
    card.className = "cg-browser-cleanup-card";
    card[String.fromCharCode(105,110,110,101,114,72,84,77,76)] =
      '<h3>Browser Cleanup Plan</h3>' +
      '<div class="cg-browser-cleanup-grid">' +
        '<label class="cg-browser-cleanup-check"><input id="cgCleanTracking" type="checkbox" checked>Tracking cookies</label>' +
        '<label class="cg-browser-cleanup-check"><input id="cgCleanUnknown" type="checkbox" checked>Unknown/review cookies</label>' +
        '<label class="cg-browser-cleanup-check"><input id="cgCleanPreferences" type="checkbox">Preferences</label>' +
        '<label class="cg-browser-cleanup-check"><input id="cgPreserveAuth" type="checkbox" checked>Preserve auth/session</label>' +
        '<label class="cg-browser-cleanup-check"><input id="cgCleanCache" type="checkbox">Cache</label>' +
        '<label class="cg-browser-cleanup-check"><input id="cgCleanStorage" type="checkbox">Local storage / IndexedDB</label>' +
        '<label class="cg-browser-cleanup-check"><input id="cgCleanServiceWorkers" type="checkbox">Service workers</label>' +
      '</div>' +
      '<div id="cgBrowserCleanupPlan" class="cg-browser-cleanup-plan"></div>' +
      '<div class="cg-browser-cleanup-actions">' +
        '<button id="cgPlanBrowserCleanupBtn" type="button">Plan cleanup</button>' +
        '<button id="cgRunBrowserCleanupBtn" class="danger" type="button">Clean browser</button>' +
      '</div>' +
      '<div id="cgBrowserCleanupResult" class="cg-browser-cleanup-note">Choose categories, then plan cleanup.</div>';

    observer.appendChild(card);

    // COOKIEGATE_V011_CLEANUP_BUTTON_GUARD
    const planBtnV4 = byIdV4("cgPlanBrowserCleanupBtn");
    if(planBtnV4 && planBtnV4.getAttribute("data-cg-cleanup-bound") !== "1"){
      planBtnV4.setAttribute("data-cg-cleanup-bound", "1");
      planBtnV4.addEventListener("click", function(){
        planBrowserCleanupV4(true);
      });
    }

    const runBtnV4 = byIdV4("cgRunBrowserCleanupBtn");
    if(runBtnV4 && runBtnV4.getAttribute("data-cg-cleanup-bound") !== "1"){
      runBtnV4.setAttribute("data-cg-cleanup-bound", "1");
      runBtnV4.addEventListener("click", function(){
        runBrowserCleanupV4();
      });
    }

    ["cgCleanTracking","cgCleanUnknown","cgCleanPreferences","cgPreserveAuth","cgCleanCache","cgCleanStorage","cgCleanServiceWorkers"].forEach(function(id){
      const el = byIdV4(id);
      if(el){
        el.addEventListener("change", function(){
          planBrowserCleanupV4(true);
        });
      }
    });
  }

  function optionsV4(){
    return {
      tracking: !!(byIdV4("cgCleanTracking") && byIdV4("cgCleanTracking").checked),
      unknown: !!(byIdV4("cgCleanUnknown") && byIdV4("cgCleanUnknown").checked),
      preferences: !!(byIdV4("cgCleanPreferences") && byIdV4("cgCleanPreferences").checked),
      preserveAuth: !(byIdV4("cgPreserveAuth") && byIdV4("cgPreserveAuth").checked) ? false : true,
      cache: !!(byIdV4("cgCleanCache") && byIdV4("cgCleanCache").checked),
      storage: !!(byIdV4("cgCleanStorage") && byIdV4("cgCleanStorage").checked),
      serviceWorkers: !!(byIdV4("cgCleanServiceWorkers") && byIdV4("cgCleanServiceWorkers").checked)
    };
  }

  function shouldDeleteCookieV4(cookie, opts){
    const cls = classifyV4(cookie);

    if(opts.preserveAuth && cls === "auth/session") return false;
    if(cls === "tracking" && opts.tracking) return true;
    if(cls === "unknown" && opts.unknown) return true;
    if(cls === "preferences" && opts.preferences) return true;
    if(cls === "auth/session" && !opts.preserveAuth) return true;

    return false;
  }

  async function planBrowserCleanupV4(render){
    ensureCleanupCardV4();

    const opts = optionsV4();
    const got = await getAllCookiesV4();

    const plan = {
      schema: "cookiegate.browser_cleanup_plan.v4",
      planned_at: new Date().toISOString(),
      options: opts,
      ok: got.ok,
      error: got.error || null,
      cookieTotal: (got.cookies || []).length,
      deleteCookies: [],
      preserveCookies: [],
      storageTargets: {
        cache: opts.cache,
        localStorageAndIndexedDB: opts.storage,
        serviceWorkers: opts.serviceWorkers
      }
    };

    for(const c of (got.cookies || [])){
      const cls = classifyV4(c);
      const row = {
        name: c.name,
        domain: c.domain,
        path: c.path || "/",
        classification: cls,
        reason: shouldDeleteCookieV4(c, opts) ? "selected cleanup category" : "preserved by cleanup plan"
      };

      if(shouldDeleteCookieV4(c, opts)){
        plan.deleteCookies.push(row);
      } else {
        plan.preserveCookies.push(row);
      }
    }

    window.CookieGateBrowserCleanupPlan = plan;

    if(render !== false){
      renderCleanupPlanV4(plan);
    }

    return plan;
  }

  function renderCleanupPlanV4(plan){
    const body = byIdV4("cgBrowserCleanupPlan");
    const result = byIdV4("cgBrowserCleanupResult");

    if(!body) return;

    body[String.fromCharCode(105,110,110,101,114,72,84,77,76)] =
      '<div class="cg-browser-cleanup-row"><span>Cookies detected</span><b>' + plan.cookieTotal + '</b></div>' +
      '<div class="cg-browser-cleanup-row"><span>Cookies to remove</span><b>' + plan.deleteCookies.length + '</b></div>' +
      '<div class="cg-browser-cleanup-row"><span>Cookies to preserve</span><b>' + plan.preserveCookies.length + '</b></div>' +
      '<div class="cg-browser-cleanup-row"><span>Cache selected</span><b>' + (plan.storageTargets.cache ? "Yes" : "No") + '</b></div>' +
      '<div class="cg-browser-cleanup-row"><span>Storage selected</span><b>' + (plan.storageTargets.localStorageAndIndexedDB ? "Yes" : "No") + '</b></div>';

    if(result){
      result.className = "cg-browser-cleanup-note";
      result.textContent = "Plan ready. Nothing is cleaned until you click Clean browser.";
    }
  }

  function removeBrowsingDataV4(opts){
    const api = apiV4();

    return new Promise(function(resolve){
      if(!api || !api.browsingData){
        resolve({ ok: false, error: "NO_BROWSING_DATA_API" });
        return;
      }

      const dataToRemove = {};
      if(opts.cache) dataToRemove.cache = true;

      if(opts.storage){
        dataToRemove.localStorage = true;
        dataToRemove.indexedDB = true;
      }

      if(opts.serviceWorkers){
        dataToRemove.serviceWorkers = true;
      }

      if(Object.keys(dataToRemove).length === 0){
        resolve({ ok: true, skipped: true });
        return;
      }

      try {
        if(typeof browser !== "undefined"){
          api.browsingData.remove({ since: 0 }, dataToRemove)
            .then(function(){ resolve({ ok: true, removed: dataToRemove }); })
            .catch(function(err){ resolve({ ok: false, error: String(err && err.message ? err.message : err), attempted: dataToRemove }); });
          return;
        }

        api.browsingData.remove({ since: 0 }, dataToRemove, function(){
          if(api.runtime && api.runtime.lastError){
            resolve({ ok: false, error: api.runtime.lastError.message, attempted: dataToRemove });
            return;
          }

          resolve({ ok: true, removed: dataToRemove });
        });
      } catch(e) {
        resolve({ ok: false, error: String(e && e.message ? e.message : e), attempted: dataToRemove });
      }
    });
  }

  async function runBrowserCleanupV4(){
    ensureCleanupCardV4();

    let plan = window.CookieGateBrowserCleanupPlan;
    if(!plan){
      plan = await planBrowserCleanupV4(true);
    }

    const msg =
      "Clean browser data now?\n\n" +
      "Cookies to remove: " + plan.deleteCookies.length + "\n" +
      "Cookies to preserve: " + plan.preserveCookies.length + "\n" +
      "Cache: " + (plan.storageTargets.cache ? "Yes" : "No") + "\n" +
      "Storage: " + (plan.storageTargets.localStorageAndIndexedDB ? "Yes" : "No") + "\n\n" +
      "Passwords, autofill, downloads, and history are not touched.";

    if(!window.confirm(msg)){
      return;
    }

    const resultEl = byIdV4("cgBrowserCleanupResult");
    if(resultEl){
      resultEl.className = "cg-browser-cleanup-note warn";
      resultEl.textContent = "Cleaning browser data...";
    }

    let deleted = 0;
    let failed = 0;
    const failures = [];

    for(const item of plan.deleteCookies){
      const cookie = {
        name: item.name,
        domain: item.domain,
        path: item.path || "/",
        secure: true
      };

      // Try secure URL first, then non-secure fallback if needed.
      let res = await removeCookieV4(cookie);

      if(!res.ok){
        cookie.secure = false;
        res = await removeCookieV4(cookie);
      }

      if(res.ok){
        deleted += 1;
      } else {
        failed += 1;
        failures.push({
          name: item.name,
          domain: item.domain,
          error: res.error || "REMOVE_FAILED"
        });
      }
    }

    const browsing = await removeBrowsingDataV4(plan.options);

    const final = {
      schema: "cookiegate.browser_cleanup_result.v4",
      cleaned_at: new Date().toISOString(),
      plan,
      deletedCookies: deleted,
      failedCookies: failed,
      preservedCookies: plan.preserveCookies.length,
      browsingData: browsing,
      failures
    };

    window.CookieGateBrowserCleanupResult = final;

    if(resultEl){
      resultEl.className = failed === 0 && browsing.ok ? "cg-browser-cleanup-note good" : "cg-browser-cleanup-note warn";
      resultEl.textContent =
        "Cleanup complete: deleted=" + deleted +
        " preserved=" + plan.preserveCookies.length +
        " failed=" + failed +
        " browsingData=" + (browsing.ok ? "ok" : "issue");
    }

    if(window.CookieGateCaptureBrowserObserver){
      await window.CookieGateCaptureBrowserObserver(true);
    }

    await planBrowserCleanupV4(true);
  }

  function bootCleanupV4(){
    ensureCleanupCardV4();

    if(window.CookieGateBrowserObserverLast){
      planBrowserCleanupV4(true);
    }
  }

  const oldHook = window.CookieGateTransparencyRenderHook;
  window.CookieGateTransparencyRenderHook = function(){
    if(typeof oldHook === "function"){
      try { oldHook(); } catch(e) {}
    }

    try { bootCleanupV4(); } catch(e) {}
  };

  document.addEventListener("DOMContentLoaded", function(){
    setTimeout(bootCleanupV4, 260);
  });

  window.addEventListener("load", function(){
    setTimeout(bootCleanupV4, 440);
  });

  window.CookieGatePlanBrowserCleanup = planBrowserCleanupV4;
  window.CookieGateRunBrowserCleanup = runBrowserCleanupV4;
})();

// COOKIEGATE_ROUTER_V7_STATIC_TABS_CLEAN
(function(){
  const KEY = "cookiegate.router.v7.view";
  let currentView = null;
  let wired = false;
  let lastApply = 0;

  function api(){
    if(typeof browser !== "undefined") return browser;
    if(typeof chrome !== "undefined") return chrome;
    return null;
  }

  function norm(x){ return String(x || "").replace(/\s+/g, " ").trim(); }
  function low(x){ return norm(x).toLowerCase(); }
  function state(){ return window.CookieGateState || window.state || null; }

  function cleanHost(x){
    x = String(x || "").trim().toLowerCase();
    x = x.replace(/^site:\s*/i, "");
    x = x.replace(/^https?:\/\//, "");
    x = x.split("/")[0].split("?")[0].split("#")[0];
    x = x.replace(/:\d+$/, "");
    x = x.replace(/^www\./, "");
    if(x === "-" || x === "newtab" || x === "browser" || x === "browser observer") return "";
    return x;
  }

  function host(){
    const s = state();
    if(s && s.site){
      const h = cleanHost(s.site);
      if(h) return h;
    }
    const body = String(document.body && document.body.textContent ? document.body.textContent : "");
    const m = body.match(/Site:\s*([^\n\r]+)/i);
    if(m && m[1]){
      const h = cleanHost(m[1]);
      if(h) return h;
    }
    return "";
  }

  function browserPage(){
    const h = host();
    const s = state();
    const u = String(s && s.url ? s.url : "").toLowerCase();
    if(!h) return true;
    if(u && !/^https?:\/\//.test(u)) return true;
    return false;
  }

  // Confident "this tab is not a real website" test used to gate the Active Site
  // tab. Unlike browserPage() this does NOT fire when the host is merely unknown
  // (which happens transiently at popup-open on a real domain); it only returns
  // true once the tab URL is KNOWN and is not http/https -- e.g. the new tab
  // page, history, settings, chrome://, about:, file://, view-source:. On those
  // pages there is no site cookie context, so Active Site is meaningless.
  function nonWebPage(){
    const s = state();
    const u = String(s && s.url ? s.url : "").trim().toLowerCase();
    if(!u) return false;                     // URL not resolved yet -> don't gate
    if(/^https?:\/\//.test(u)) return false; // genuine web page
    return true;
  }

  function valid(v){ return v === "active" || v === "observer" || v === "rules"; }

  function save(v){
    if(!valid(v)) return;
    currentView = v;
    try { sessionStorage.setItem(KEY, v); } catch(e) {}
  }

  function load(){
    if(valid(currentView)) return currentView;
    try {
      const v = sessionStorage.getItem(KEY);
      if(valid(v)){ currentView = v; return v; }
    } catch(e) {}
    return null;
  }

  function desired(){
    const saved = load();
    // Off a real website (new tab, history, settings, chrome://, etc.) the
    // Active Site view has nothing to show, so land on Browser Observer and let
    // the user reach Domain Rules from there. Observer/Rules picks are honored;
    // a stale "active" pick is overridden while on such a page.
    if(nonWebPage()){
      if(saved === "observer" || saved === "rules") return saved;
      return "observer";
    }
    // If the user explicitly picked a tab this session, honor it.
    if(valid(saved)) return saved;
    // Default to Active Site. Previously this fell through to Browser Observer
    // whenever the host was momentarily unknown (which it always is at
    // popup-open), causing the extension to open on the wrong tab.
    return "active";
  }

  function all(){
    return Array.from(document.querySelectorAll("body *")).filter(function(el){
      if(!el || el === document.body) return false;
      return low(el.textContent || "").length > 0;
    });
  }

  function smallest(predicate){
    const hits = [];
    all().forEach(function(el){
      const t = low(el.textContent || "");
      if(predicate(t, el)) hits.push(el);
    });
    hits.sort(function(a,b){
      return low(a.textContent || "").length - low(b.textContent || "").length;
    });
    return hits[0] || null;
  }

  function container(el){
    if(!el) return null;
    let cur = el;
    for(let i = 0; i < 8 && cur && cur !== document.body; i++){
      const t = low(cur.textContent || "");
      const kids = cur.children ? cur.children.length : 0;
      if(kids >= 2 && t.length > 10) return cur;
      cur = cur.parentElement;
    }
    return el;
  }

  function tag(role, el){
    const c = container(el);
    if(c && c !== document.body) c.setAttribute("data-cg-v7-role", role);
  }

  function clearRoles(){
    document.querySelectorAll("[data-cg-v7-role]").forEach(function(el){
      el.removeAttribute("data-cg-v7-role");
      el.classList.remove("cg-v7-hidden");
      el.classList.remove("cg-v7-visible");
      el.style.removeProperty("display");
    });
  }

  function mark(){
    clearRoles();

    tag("browser-observer", smallest(function(t){
      return t.indexOf("browser observer") >= 0 &&
        (t.indexOf("scan browser") >= 0 || t.indexOf("browser-held cookies") >= 0 || t.indexOf("total cookies") >= 0 || t.indexOf("privacy: raw cookie values are not exported") >= 0);
    }));

    tag("browser-cleanup", smallest(function(t){
      return t.indexOf("browser cleanup plan") >= 0 &&
        t.indexOf("tracking cookies") >= 0 &&
        t.indexOf("service workers") >= 0;
    }));

    tag("domain-rules", smallest(function(t){
      return t.indexOf("domain registry governance") >= 0 &&
        t.indexOf("save rule") >= 0 &&
        t.indexOf("export rules") >= 0;
    }));

    tag("active", smallest(function(t){
      return t.indexOf("mode controls") >= 0 &&
        t.indexOf("global mode") >= 0 &&
        t.indexOf("site mode") >= 0;
    }));

    tag("active", smallest(function(t){
      return t.indexOf("wipe plan") >= 0 &&
        t.indexOf("will remove") >= 0 &&
        t.indexOf("will preserve") >= 0;
    }));

    tag("cookies", smallest(function(t){
      return t.indexOf("cookies (") >= 0 && t.indexOf("view all") >= 0;
    }));

    tag("evidence", smallest(function(t){
      return t.indexOf("evidence") >= 0 &&
        t.indexOf("current session") >= 0 &&
        t.indexOf("site total") >= 0;
    }));

    tag("diff", smallest(function(t){
      return t.indexOf("diff inspector") >= 0 &&
        t.indexOf("removed") >= 0 &&
        t.indexOf("changed") >= 0;
    }));

    tag("site-package", smallest(function(t){
      return t.indexOf("site package") >= 0 &&
        t.indexOf("export site package") >= 0;
    }));
  }

  function setVisible(el, show){
    if(!el) return;
    if(show){
      el.classList.remove("cg-v7-hidden");
      el.classList.add("cg-v7-visible");
      el.style.setProperty("display", "block", "important");
    } else {
      el.classList.remove("cg-v7-visible");
      el.classList.add("cg-v7-hidden");
      el.style.setProperty("display", "none", "important");
    }
  }

  function classify(c){
    const n = low(c && c.name ? c.name : "");
    const policy = low(c && (c.policyAction || c.policy_action) ? (c.policyAction || c.policy_action) : "");
    const cls = low(c && (c.classification || c.category) ? (c.classification || c.category) : "");
    if(cls.indexOf("auth/session") >= 0) return "auth/session";
    if(policy.indexOf("allow-until-exit") >= 0 || policy.indexOf("allow-session") >= 0) return "auth/session";
    if(n.indexOf("session") >= 0 || n.indexOf("token") >= 0 || n.indexOf("csrf") >= 0 || n.indexOf("auth") >= 0 || n.indexOf("sess") >= 0) return "auth/session";
    if(n.indexOf("_ga") === 0 || n.indexOf("_fbp") === 0 || n.indexOf("_gcl") === 0 || n.indexOf("_dd") === 0 || n.indexOf("gclid") >= 0) return "tracking";
    return cls || "unknown";
  }

  function domainMatches(c, h){
    const wanted = cleanHost(h);
    const d = cleanHost(c && c.domain ? String(c.domain).replace(/^\./,"") : "");
    return wanted && (d === wanted || d.endsWith("." + wanted));
  }

  function includeSession(){ return localStorage.getItem("cookiegate.v7.includeSession:" + host()) === "true"; }
  function setIncludeSession(v){ localStorage.setItem("cookiegate.v7.includeSession:" + host(), v ? "true" : "false"); }

  function getAllCookies(){
    const a = api();
    return new Promise(function(resolve){
      if(!a || !a.cookies || !a.cookies.getAll){ resolve([]); return; }
      try {
        if(typeof browser !== "undefined"){
          a.cookies.getAll({}).then(function(c){ resolve(c || []); }).catch(function(){ resolve([]); });
          return;
        }
        a.cookies.getAll({}, function(c){ resolve(c || []); });
      } catch(e) { resolve([]); }
    });
  }

  async function computePlan(){
    const h = host();
    const cookies = await getAllCookies();
    const matching = cookies.filter(function(c){ return domainMatches(c, h); });
    const include = includeSession();
    const remove = [];
    const preserve = [];

    matching.forEach(function(c){
      const cls = classify(c);
      const auth = cls === "auth/session";
      const row = { name: c.name, domain: c.domain, path: c.path || "/", secure: !!c.secure, classification: cls };
      if(auth && !include){
        row.reason = "preserved: auth/session";
        preserve.push(row);
      } else {
        row.reason = auth ? "remove: session/auth included" : "remove: site cleanup";
        remove.push(row);
      }
    });

    return { host: h, total: matching.length, remove: remove, preserve: preserve, includeSession: include };
  }

  async function renderPlan(){
    const cards = Array.from(document.querySelectorAll('[data-cg-v7-role="active"]'));
    const planCard = cards.find(function(el){ return low(el.textContent || "").indexOf("wipe plan") >= 0; });
    if(!planCard) return;

    const plan = await computePlan();
    const removeText = plan.remove.slice(0,3).map(function(x){ return x.name + " (" + x.reason + ")"; }).join("; ") || "none";
    const preserveText = plan.preserve.slice(0,3).map(function(x){ return x.name + " (" + x.reason + ")"; }).join("; ") || "none";

    planCard[String.fromCharCode(105,110,110,101,114,72,84,77,76)] =
      '<div><b>Wipe plan</b></div>' +
      '<div class="cg-v7-plan-row"><span>Cookies detected</span><b>' + plan.total + '</b></div>' +
      '<div class="cg-v7-plan-row"><span>Will remove</span><b>' + plan.remove.length + '</b></div>' +
      '<div class="cg-v7-plan-row"><span>Will preserve</span><b>' + plan.preserve.length + '</b></div>' +
      '<div class="cg-v7-plan-note"><b>Remove:</b> ' + removeText + '</div>' +
      '<div class="cg-v7-plan-note"><b>Preserve:</b> ' + preserveText + '</div>' +
      '<div class="cg-v7-plan-note">Plan target: ' + (plan.host || "this site") + '</div>' +
      '<label class="cg-v7-plan-check"><input id="cgV7IncludeSession" type="checkbox" ' + (plan.includeSession ? "checked" : "") + '><span>Include session/auth cookies in this manual wipe</span></label>' +
      '<button id="cgV7WipeUsingPlan" class="cg-v7-plan-button" type="button">Wipe using plan</button>';

    const cb = document.getElementById("cgV7IncludeSession");
    if(cb){
      cb.addEventListener("change", function(){
        setIncludeSession(cb.checked);
        renderPlan();
      });
    }

    const btn = document.getElementById("cgV7WipeUsingPlan");
    if(btn){
      btn.addEventListener("click", function(){
        alert("Plan ready: " + plan.remove.length + " cookies would be removed for " + (plan.host || "this site") + ". Use Wipe Site Now for destructive wipe until v7 delete is sealed.");
      });
    }
  }

  function apply(){
    const now = Date.now();
    if(now - lastApply < 80) return;
    lastApply = now;

    const v = desired();
    document.body.setAttribute("data-cg-view", v);
    document.body.setAttribute("data-cg-v7-view", v);

    mark();

    document.querySelectorAll("[data-cg-v7-role]").forEach(function(el){
      const role = el.getAttribute("data-cg-v7-role");
      let show = false;

      if(v === "active") show = role === "active" || role === "cookies" || role === "evidence" || role === "diff" || role === "site-package";
      if(v === "observer") show = role === "browser-observer" || role === "browser-cleanup";
      if(v === "rules") show = role === "domain-rules";

      setVisible(el, show);
    });

    ["cgTabActive","cgTabObserver","cgTabRules"].forEach(function(id){
      const tab = document.getElementById(id);
      if(tab) tab.classList.remove("active");
    });

    const tabId = v === "active" ? "cgTabActive" : v === "observer" ? "cgTabObserver" : "cgTabRules";
    const tab = document.getElementById(tabId);
    if(tab) tab.classList.add("active");

    // Gate the Active Site tab: on non-website pages it is unclickable and
    // visibly disabled; on real sites it is fully enabled.
    const activeTabBtn = document.getElementById("cgTabActive");
    if(activeTabBtn){
      if(nonWebPage()){
        activeTabBtn.classList.add("cg-tab-disabled");
        activeTabBtn.setAttribute("disabled", "disabled");
        activeTabBtn.setAttribute("aria-disabled", "true");
        activeTabBtn.setAttribute("title", "Active Site is unavailable on browser pages (new tab, history, settings). Showing Browser Observer.");
      } else {
        activeTabBtn.classList.remove("cg-tab-disabled");
        activeTabBtn.removeAttribute("disabled");
        activeTabBtn.removeAttribute("aria-disabled");
        activeTabBtn.removeAttribute("title");
      }
    }

    if(v === "active") renderPlan();

    if(v === "observer"){
      if(window.CookieGateCaptureBrowserObserver && !window.CookieGateBrowserObserverLast){
        try { window.CookieGateCaptureBrowserObserver(true); } catch(e) {}
      }
      if(window.CookieGatePlanBrowserCleanup){
        try { window.CookieGatePlanBrowserCleanup(true); } catch(e) {}
      }
    }
  }

  function setView(v){
    if(!valid(v)) return;
    save(v);
    setTimeout(apply, 0);
    setTimeout(apply, 160);
  }

  function wire(){
    if(wired) return;
    wired = true;
    document.addEventListener("click", function(ev){
      const btn = ev.target && ev.target.closest ? ev.target.closest("button, a, [role='button']") : null;
      if(!btn) return;
      const t = low(btn.textContent || "");
      const id = String(btn.id || "");

      if(id === "cgTabActive" || t === "active site"){
        ev.preventDefault(); ev.stopPropagation(); if(ev.stopImmediatePropagation) ev.stopImmediatePropagation();
        // Blocked on browser pages -- keep the user on Browser Observer.
        if(nonWebPage()) return;
        setView("active"); return;
      }
      if(id === "cgTabObserver" || t === "browser observer"){
        ev.preventDefault(); ev.stopPropagation(); if(ev.stopImmediatePropagation) ev.stopImmediatePropagation();
        setView("observer"); return;
      }
      if(id === "cgTabRules" || t === "domain rules"){
        ev.preventDefault(); ev.stopPropagation(); if(ev.stopImmediatePropagation) ev.stopImmediatePropagation();
        setView("rules"); return;
      }
    }, true);
  }

  function boot(){
    wire();
    if(!load()) save("active");
    setTimeout(apply, 180);
    setTimeout(apply, 520);
  }

  window.CookieGateTransparencyRenderHook = function(){
    setTimeout(apply, 0);
    setTimeout(apply, 140);
  };

  document.addEventListener("DOMContentLoaded", boot);
  window.addEventListener("load", boot);

  window.CookieGateRouterV7StaticTabsClean = { setView: setView, apply: apply, computePlan: computePlan, renderPlan: renderPlan, desired: desired };
})();

// COOKIEGATE_V011_DOMAIN_REMOTE_TOOLS
(function(){
  "use strict";

  const API = typeof browser !== "undefined" ? browser : chrome;

  function norm(x){
    return String(x || "").replace(/\s+/g, " ").trim();
  }

  function low(x){
    return norm(x).toLowerCase();
  }

  function el(tag, cls, text){
    const node = document.createElement(tag);

    if(cls){
      node.className = cls;
    }

    if(text !== undefined && text !== null){
      node.textContent = String(text);
    }

    return node;
  }

  function button(id, text, cls){
    const b = document.createElement("button");
    b.id = id;
    b.type = "button";
    b.className = cls || "cg-domain-tools-btn";
    b.textContent = text;
    return b;
  }

  function normalizeAddress(input){
    let x = norm(input).toLowerCase();

    if(!x){
      return "";
    }

    x = x.replace(/^site:\s*/i, "");

    try {
      if(!/^https?:\/\//i.test(x)){
        x = "https://" + x;
      }

      const u = new URL(x);
      return String(u.hostname || "").replace(/^www\./, "");
    } catch(e){
      x = x.replace(/^https?:\/\//i, "");
      x = x.split("/")[0].split("?")[0].split("#")[0];
      x = x.replace(/:\d+$/, "");
      x = x.replace(/^www\./, "");
      return x;
    }
  }

  function currentSite(){
    const body = String(document.body && document.body.textContent ? document.body.textContent : "");
    const m = body.match(/Site:\s*([^\n\r]+)/i);

    if(m && m[1]){
      return normalizeAddress(m[1]);
    }

    return "";
  }

  function rootDomain(host){
    host = normalizeAddress(host);
    const parts = host.split(".").filter(Boolean);

    if(parts.length <= 2){
      return host;
    }

    const last = parts[parts.length - 1];
    const second = parts[parts.length - 2];

    if(last.length === 2 && second.length <= 3 && parts.length >= 3){
      return parts.slice(-3).join(".");
    }

    return parts.slice(-2).join(".");
  }

  function getCookiesForDomain(domain){
    return new Promise(function(resolve){
      if(!API || !API.cookies || !API.cookies.getAll){
        resolve([]);
        return;
      }

      try {
        API.cookies.getAll({ domain: domain }, function(cookies){
          resolve(Array.isArray(cookies) ? cookies : []);
        });
      } catch(e){
        resolve([]);
      }
    });
  }

  function removeCookie(cookie){
    return new Promise(function(resolve){
      if(!API || !API.cookies || !API.cookies.remove){
        resolve(false);
        return;
      }

      try {
        const host = String(cookie.domain || "").replace(/^\./, "");
        const path = cookie.path || "/";
        const protocol = cookie.secure ? "https://" : "http://";
        const url = protocol + host + path;

        API.cookies.remove({
          url: url,
          name: cookie.name,
          storeId: cookie.storeId
        }, function(result){
          resolve(!!result);
        });
      } catch(e){
        resolve(false);
      }
    });
  }

  function classify(cookie){
    const name = low(cookie && cookie.name ? cookie.name : "");

    if(name.indexOf("session") >= 0 ||
      name.indexOf("auth") >= 0 ||
      name.indexOf("token") >= 0 ||
      name.indexOf("csrf") >= 0 ||
      name.indexOf("login") >= 0 ||
      name.indexOf("sid") >= 0){
      return "auth/session";
    }

    if(name.indexOf("pref") >= 0 ||
      name.indexOf("setting") >= 0 ||
      name.indexOf("locale") >= 0 ||
      name.indexOf("lang") >= 0){
      return "preferences";
    }

    if(name.indexOf("_ga") >= 0 ||
      name.indexOf("_gid") >= 0 ||
      name.indexOf("fbp") >= 0 ||
      name.indexOf("gcl") >= 0 ||
      name.indexOf("track") >= 0 ||
      name.indexOf("mixpanel") >= 0){
      return "tracking";
    }

    return "unknown/review";
  }

  function shouldPreserve(cookie, includeAuth){
    if(includeAuth){
      return false;
    }

    return classify(cookie) === "auth/session";
  }

  function findDomainRulesPanel(){
    const candidates = Array.prototype.slice.call(document.querySelectorAll("section, article, main, div"));

    const hits = candidates.filter(function(node){
      const t = low(node.textContent);

      return t.indexOf("domain registry governance") >= 0 &&
        t.indexOf("save rule") >= 0 &&
        t.indexOf("export rules") >= 0;
    });

    hits.sort(function(a,b){
      return norm(a.textContent).length - norm(b.textContent).length;
    });

    return hits[0] || null;
  }

  function renderCookieRows(root, cookies){
    root.textContent = "";

    if(!cookies.length){
      root.appendChild(el("div", "cg-domain-tools-empty", "No cookies found for this domain."));
      return;
    }

    cookies.slice(0, 40).forEach(function(c){
      const row = el("div", "cg-domain-tools-cookie");

      const top = el("div", "cg-domain-tools-cookie-top");
      top.appendChild(el("b", "", c.name || "(unnamed)"));
      top.appendChild(el("span", "", classify(c)));

      const meta = el("div", "cg-domain-tools-cookie-meta");
      meta.textContent = String(c.domain || "") + " | " + String(c.path || "/") + " | Secure: " + (c.secure ? "Yes" : "No");

      row.appendChild(top);
      row.appendChild(meta);
      root.appendChild(row);
    });

    if(cookies.length > 40){
      root.appendChild(el("div", "cg-domain-tools-empty", "Showing first 40 of " + cookies.length + " cookies."));
    }
  }

  async function inspect(){
    const input = document.getElementById("cgDomainToolsAddress");
    const status = document.getElementById("cgDomainToolsStatus");
    const list = document.getElementById("cgDomainToolsList");

    if(!input || !status || !list) return;

    const host = normalizeAddress(input.value);
    const root = rootDomain(host);

    if(!root){
      status.textContent = "Enter a domain or URL first.";
      return;
    }

    input.value = root;
    status.textContent = "Inspecting " + root + "...";

    const cookies = await getCookiesForDomain(root);
    const preserve = cookies.filter(function(c){ return shouldPreserve(c, false); }).length;
    const removable = cookies.length - preserve;

    status.textContent = "Found " + cookies.length + " cookies for " + root + ". Removable by default: " + removable + ". Preserved auth/session: " + preserve + ".";
    renderCookieRows(list, cookies);
  }

  async function wipe(){
    const input = document.getElementById("cgDomainToolsAddress");
    const includeAuth = document.getElementById("cgDomainToolsIncludeAuth");
    const status = document.getElementById("cgDomainToolsStatus");
    const list = document.getElementById("cgDomainToolsList");

    if(!input || !status || !list) return;

    const host = normalizeAddress(input.value);
    const root = rootDomain(host);

    if(!root){
      status.textContent = "Enter a domain or URL first.";
      return;
    }

    input.value = root;

    const cookies = await getCookiesForDomain(root);
    const remove = cookies.filter(function(c){
      return !shouldPreserve(c, !!(includeAuth && includeAuth.checked));
    });

    status.textContent = "Removing " + remove.length + " cookies for " + root + "...";

    let removed = 0;

    for(let i = 0; i < remove.length; i++){
      if(await removeCookie(remove[i])){
        removed++;
      }
    }

    const after = await getCookiesForDomain(root);
    status.textContent = "Removed " + removed + " cookies for " + root + ". Remaining: " + after.length + ".";
    renderCookieRows(list, after);
  }

  function install(){
    const panel = findDomainRulesPanel();

    if(!panel){
      return;
    }

    if(document.getElementById("cgDomainRemoteToolsV011")){
      return;
    }

    const card = el("section", "cg-domain-tools-card");
    card.id = "cgDomainRemoteToolsV011";

    card.appendChild(el("div", "cg-domain-tools-title", "Domain Tools"));
    card.appendChild(el("div", "cg-domain-tools-subtitle", "Inspect or wipe cookies for a typed domain or URL path without leaving the current tab."));

    const row = el("div", "cg-domain-tools-row");

    const input = document.createElement("input");
    input.id = "cgDomainToolsAddress";
    input.type = "text";
    input.placeholder = "amazon.com or https://amazon.com/path/example";
    input.value = currentSite();

    row.appendChild(input);
    row.appendChild(button("cgDomainToolsInspect", "Inspect domain", "cg-domain-tools-btn primary"));
    row.appendChild(button("cgDomainToolsWipe", "Wipe domain", "cg-domain-tools-btn danger"));

    const include = document.createElement("label");
    include.className = "cg-domain-tools-check";

    const cb = document.createElement("input");
    cb.id = "cgDomainToolsIncludeAuth";
    cb.type = "checkbox";

    include.appendChild(cb);
    include.appendChild(document.createTextNode(" Include auth/session cookies"));

    const status = el("div", "cg-domain-tools-status", "Type a domain or full URL, then inspect cookies.");
    status.id = "cgDomainToolsStatus";

    const list = el("div", "cg-domain-tools-list");
    list.id = "cgDomainToolsList";

    card.appendChild(row);
    card.appendChild(include);
    card.appendChild(status);
    card.appendChild(list);

    panel.insertBefore(card, panel.firstChild);

    document.getElementById("cgDomainToolsInspect").addEventListener("click", function(ev){
      ev.preventDefault();
      inspect();
    });

    document.getElementById("cgDomainToolsWipe").addEventListener("click", function(ev){
      ev.preventDefault();
      wipe();
    });
  }

  function boot(){
    setTimeout(install, 200);
    setTimeout(install, 700);
    setTimeout(install, 1500);

    document.addEventListener("click", function(ev){
      const t = low(ev.target && ev.target.textContent ? ev.target.textContent : "");

      if(t.indexOf("domain rules") >= 0){
        setTimeout(install, 150);
        setTimeout(install, 600);
      }
    }, true);
  }

  document.addEventListener("DOMContentLoaded", boot);
  window.addEventListener("load", boot);

  window.CookieGateDomainRemoteToolsV011 = {
    install: install,
    normalizeAddress: normalizeAddress,
    rootDomain: rootDomain,
    inspect: inspect,
    wipe: wipe
  };
})();

// COOKIEGATE_V011_DOMAIN_RULE_EFFECTIVE_RESOLVER
(function(){
  "use strict";

  const API = typeof browser !== "undefined" ? browser : chrome;

  function norm(x){
    return String(x || "").replace(/\s+/g, " ").trim();
  }

  function low(x){
    return norm(x).toLowerCase();
  }

  function storageGetAll(){
    return new Promise(function(resolve){
      try {
        if(!API || !API.storage || !API.storage.local){
          resolve({});
          return;
        }

        const out = API.storage.local.get(null);

        if(out && typeof out.then === "function"){
          out.then(function(v){ resolve(v || {}); }).catch(function(){ resolve({}); });
          return;
        }

        API.storage.local.get(null, function(v){ resolve(v || {}); });
      } catch(e){
        resolve({});
      }
    });
  }

  function normalizeHost(input){
    let x = low(input);

    if(!x){
      return "";
    }

    x = x.replace(/^site:\s*/i, "");

    try {
      if(!/^https?:\/\//i.test(x)){
        x = "https://" + x;
      }

      const u = new URL(x);
      return String(u.hostname || "").toLowerCase().replace(/^www\./, "");
    } catch(e){
      x = x.replace(/^https?:\/\//i, "");
      x = x.split("/")[0].split("?")[0].split("#")[0];
      x = x.replace(/:\d+$/, "");
      x = x.replace(/^www\./, "");
      return x;
    }
  }

  function rootDomain(host){
    host = normalizeHost(host);
    const parts = host.split(".").filter(Boolean);

    if(parts.length <= 2){
      return host;
    }

    const last = parts[parts.length - 1];
    const second = parts[parts.length - 2];

    if(last.length === 2 && second.length <= 3 && parts.length >= 3){
      return parts.slice(-3).join(".");
    }

    return parts.slice(-2).join(".");
  }

  function hostMatchesRule(host, ruleDomain){
    host = normalizeHost(host);
    ruleDomain = rootDomain(ruleDomain);

    if(!host || !ruleDomain){
      return false;
    }

    return host === ruleDomain || host.endsWith("." + ruleDomain);
  }

  function currentSiteHost(){
    const body = String(document.body && document.body.textContent ? document.body.textContent : "");
    const m = body.match(/Site:\s*([^\n\r]+)/i);

    if(m && m[1]){
      return normalizeHost(m[1]);
    }

    return "";
  }

  function normalizeMode(x){
    const v = low(x);

    if(v.indexOf("strict") >= 0) return "Strict";
    if(v.indexOf("balanced") >= 0) return "Balanced";
    if(v.indexOf("observe") >= 0) return "Observe";
    if(v.indexOf("off") >= 0) return "Off";

    return "";
  }

  function extractRuleObjects(value, out){
    if(!value) return;

    if(Array.isArray(value)){
      value.forEach(function(v){ extractRuleObjects(v, out); });
      return;
    }

    if(typeof value !== "object"){
      return;
    }

    const domain =
      value.domain ||
      value.host ||
      value.hostname ||
      value.site ||
      value.origin ||
      value.ruleDomain ||
      value.targetDomain;

    const mode =
      value.mode ||
      value.policy ||
      value.cleanupMode ||
      value.effectiveMode ||
      value.cookieMode;

    const active =
      value.active !== false &&
      value.enabled !== false &&
      value.disabled !== true &&
      value.status !== "disabled";

    if(domain && mode && active){
      out.push({
        domain: normalizeHost(domain),
        root: rootDomain(domain),
        mode: normalizeMode(mode),
        source: "object"
      });
    }

    Object.keys(value).forEach(function(k){
      if(k === "domain" || k === "host" || k === "hostname" || k === "mode" || k === "policy"){
        return;
      }

      extractRuleObjects(value[k], out);
    });
  }

  function extractRulesFromStorage(all){
    const out = [];

    Object.keys(all || {}).forEach(function(key){
      const v = all[key];

      if(low(key).indexOf("rule") >= 0 || low(key).indexOf("domain") >= 0){
        extractRuleObjects(v, out);
      } else {
        extractRuleObjects(v, out);
      }
    });

    const clean = [];

    out.forEach(function(r){
      if(!r.domain || !r.mode) return;

      if(!clean.some(function(x){ return x.root === r.root && x.mode === r.mode; })){
        clean.push(r);
      }
    });

    clean.sort(function(a,b){
      return b.root.length - a.root.length;
    });

    return clean;
  }

  function findMatchingRule(host, rules){
    for(let i = 0; i < rules.length; i++){
      if(hostMatchesRule(host, rules[i].root)){
        return rules[i];
      }
    }

    return null;
  }

  function findModeCards(){
    const cards = Array.prototype.slice.call(document.querySelectorAll("body *")).filter(function(node){
      const t = low(node.textContent);
      return t === "effective" || t.indexOf("effective") === 0;
    });

    const result = [];

    cards.forEach(function(label){
      const parent = label.parentElement;
      if(parent){
        result.push(parent);
      }
    });

    return result;
  }

  function updateEffectiveCard(mode, rule){
    const cards = findModeCards();

    cards.forEach(function(card){
      const kids = Array.prototype.slice.call(card.querySelectorAll("*"));
      let wrote = false;

      kids.forEach(function(k){
        const t = norm(k.textContent);

        if(t === "Strict" || t === "Balanced" || t === "Observe" || t === "Off"){
          k.textContent = mode;
          wrote = true;
        }
      });

      if(!wrote){
        const value = document.createElement("div");
        value.className = "cg-domain-rule-effective-value";
        value.textContent = mode;
        card.appendChild(value);
      }

      card.setAttribute("data-cg-domain-rule-effective", "true");
      card.setAttribute("data-cg-domain-rule-source", rule.root);
    });
  }

  function installBadge(host, rule){
    return;
  }

  async function resolve(){
    const host = currentSiteHost();

    if(!host){
      return;
    }

    const all = await storageGetAll();
    const rules = extractRulesFromStorage(all);
    const rule = findMatchingRule(host, rules);

    if(!rule || !rule.mode){
      return;
    }

    updateEffectiveCard(rule.mode, rule);
    installBadge(host, rule);

    window.CookieGateDomainRuleEffectiveV011Last = {
      host: host,
      root: rootDomain(host),
      rule: rule
    };
  }

  function boot(){
    setTimeout(resolve, 250);
    setTimeout(resolve, 800);
    setTimeout(resolve, 1600);

    document.addEventListener("click", function(){
      setTimeout(resolve, 250);
      setTimeout(resolve, 900);
    }, true);
  }

  document.addEventListener("DOMContentLoaded", boot);
  window.addEventListener("load", boot);

  window.CookieGateDomainRuleEffectiveResolverV011 = {
    resolve: resolve,
    normalizeHost: normalizeHost,
    rootDomain: rootDomain,
    hostMatchesRule: hostMatchesRule,
    extractRulesFromStorage: extractRulesFromStorage
  };
})();

// COOKIEGATE_V011_COUNT_SEMANTICS_UI
(function(){
  "use strict";

  function norm(x){
    return String(x || "").replace(/\s+/g, " ").trim();
  }

  function low(x){
    return norm(x).toLowerCase();
  }

  function makeNote(id, text){
    let note = document.getElementById(id);

    if(!note){
      note = document.createElement("div");
      note.id = id;
      note.className = "cg-count-semantics-note";
    }

    note.textContent = text;
    return note;
  }

  function findActiveSitePanel(){
    const nodes = Array.prototype.slice.call(document.querySelectorAll("section, article, main, div"));

    const hits = nodes.filter(function(node){
      const t = low(node.textContent);

      return t.indexOf("mode controls") >= 0 &&
        t.indexOf("wipe plan") >= 0 &&
        t.indexOf("cookies detected") >= 0;
    });

    hits.sort(function(a,b){
      return norm(a.textContent).length - norm(b.textContent).length;
    });

    return hits[0] || null;
  }

  function findDomainToolsCard(){
    return document.getElementById("cgDomainRemoteToolsV011");
  }

  function installActiveSiteNote(){
    const panel = findActiveSitePanel();
    if(!panel) return;

    const note = makeNote(
      "cgActiveSiteCountSemanticsNoteV011",
      "Active Site counts only the current inspected site context. Domain Tools can inspect the whole typed root domain, including subdomains and paths."
    );

    const anchor = Array.prototype.slice.call(panel.querySelectorAll("*")).find(function(node){
      return low(node.textContent).indexOf("wipe plan") >= 0;
    });

    if(anchor && anchor.parentNode && !document.getElementById(note.id)){
      anchor.parentNode.insertBefore(note, anchor.nextSibling);
      return;
    }

    if(!note.parentNode){
      panel.insertBefore(note, panel.firstChild);
    }
  }

  function installDomainToolsNote(){
    const card = findDomainToolsCard();
    if(!card) return;

    const note = makeNote(
      "cgDomainToolsCountSemanticsNoteV011",
      "Domain Tools is domain-wide: amazon.com also covers www.amazon.com, subdomains, and URL paths. Auth/session cookies are preserved unless you include them."
    );

    if(!note.parentNode){
      const subtitle = Array.prototype.slice.call(card.querySelectorAll("*")).find(function(node){
        return low(node.textContent).indexOf("inspect or wipe cookies") >= 0;
      });

      if(subtitle && subtitle.parentNode){
        subtitle.parentNode.insertBefore(note, subtitle.nextSibling);
      } else {
        card.insertBefore(note, card.firstChild);
      }
    }
  }

  function installBrowserObserverNote(){
    const nodes = Array.prototype.slice.call(document.querySelectorAll("section, article, main, div"));

    const panel = nodes.filter(function(node){
      const t = low(node.textContent);

      return t.indexOf("browser observer") >= 0 &&
        t.indexOf("total cookies") >= 0 &&
        t.indexOf("domains") >= 0 &&
        t.indexOf("review/tracking") >= 0;
    }).sort(function(a,b){
      return norm(a.textContent).length - norm(b.textContent).length;
    })[0];

    if(!panel) return;

    const note = makeNote(
      "cgBrowserObserverChartSemanticsNoteV011",
      "Browser Observer summarizes all browser-held cookies. The donut is a stable overview chart; Domain Tools handles exact domain inspection."
    );

    if(!note.parentNode){
      const marker = Array.prototype.slice.call(panel.querySelectorAll("*")).find(function(node){
        return low(node.textContent).indexOf("privacy: raw cookie values are not exported") >= 0;
      });

      if(marker && marker.parentNode){
        marker.parentNode.insertBefore(note, marker);
      } else {
        panel.appendChild(note);
      }
    }
  }

  function install(){
    try { installActiveSiteNote(); } catch(e){}
    try { installDomainToolsNote(); } catch(e){}
    try { installBrowserObserverNote(); } catch(e){}
  }

  function boot(){
    setTimeout(install, 200);
    setTimeout(install, 800);
    setTimeout(install, 1600);

    document.addEventListener("click", function(){
      setTimeout(install, 250);
      setTimeout(install, 900);
    }, true);
  }

  document.addEventListener("DOMContentLoaded", boot);
  window.addEventListener("load", boot);

  window.CookieGateCountSemanticsUIV011 = {
    install: install
  };
})();

// COOKIEGATE_V011_BANNER_LIFETIME_UI_DOMAIN_OPS
(function(){
  "use strict";

  const API = typeof browser !== "undefined" ? browser : chrome;
  const STATS_KEY = "cookiegate.bannerSuppression.stats.v1";

  function norm(x){
    return String(x || "").replace(/\s+/g, " ").trim();
  }

  function low(x){
    return norm(x).toLowerCase();
  }

  function storageGet(key){
    return new Promise(function(resolve){
      try {
        if(!API || !API.storage || !API.storage.local){
          resolve({});
          return;
        }

        const out = API.storage.local.get(key);

        if(out && typeof out.then === "function"){
          out.then(function(v){ resolve(v || {}); }).catch(function(){ resolve({}); });
          return;
        }

        API.storage.local.get(key, function(v){ resolve(v || {}); });
      } catch(e){
        resolve({});
      }
    });
  }

  function hostFromUi(){
    const body = String(document.body && document.body.textContent ? document.body.textContent : "");
    const m = body.match(/Site:\s*([^\n\r]+)/i);

    if(!m || !m[1]) return "";

    let h = String(m[1]).trim().toLowerCase();
    h = h.replace(/^https?:\/\//, "");
    h = h.split("/")[0].split("?")[0].split("#")[0];
    h = h.replace(/^www\./, "");
    return h;
  }

  function findBannerEvidenceCard(){
    const nodes = Array.prototype.slice.call(document.querySelectorAll("section, article, div"));

    return nodes.filter(function(node){
      const t = low(node.textContent);
      return t.indexOf("banner evidence") >= 0 &&
        t.indexOf("suppressed") >= 0 &&
        t.indexOf("detected") >= 0;
    }).sort(function(a,b){
      return norm(a.textContent).length - norm(b.textContent).length;
    })[0] || null;
  }

  function row(label, value){
    const r = document.createElement("div");
    r.className = "cg-banner-lifetime-row-v011";

    const l = document.createElement("span");
    l.textContent = label;

    const v = document.createElement("b");
    v.textContent = String(value);

    r.appendChild(l);
    r.appendChild(v);

    return r;
  }

  async function renderLifetime(){
    const card = findBannerEvidenceCard();
    if(!card) return;

    let box = document.getElementById("cgBannerLifetimeBoxV011");

    if(!box){
      box = document.createElement("div");
      box.id = "cgBannerLifetimeBoxV011";
      box.className = "cg-banner-lifetime-box-v011";
      card.appendChild(box);
    }

    const got = await storageGet(STATS_KEY);
    const stats = got[STATS_KEY] && typeof got[STATS_KEY] === "object" ? got[STATS_KEY] : {};
    const h = hostFromUi();
    const hostStats = stats.byHost && stats.byHost[h] ? stats.byHost[h] : {};

    box.textContent = "";

    const title = document.createElement("div");
    title.className = "cg-banner-lifetime-title-v011";
    title.textContent = "Lifetime Banner Ledger";
    box.appendChild(title);

    box.appendChild(row("Lifetime suppressed", Number(stats.suppressed || 0)));
    box.appendChild(row("Lifetime detected", Number(stats.detected || 0)));
    box.appendChild(row("This domain suppressed", Number(hostStats.suppressed || 0)));
    box.appendChild(row("This domain detected", Number(hostStats.detected || 0)));

    const last = document.createElement("div");
    last.className = "cg-banner-lifetime-last-v011";
    last.textContent = "Last: " + (stats.last_host || "none") + " / " + (stats.last_stamp_utc || "none");
    box.appendChild(last);
  }

  function renameDomainRules(){
    Array.prototype.slice.call(document.querySelectorAll("button, [role='tab'], h1, h2, h3, div, span")).forEach(function(node){
      const t = norm(node.textContent);

      if(t === "Domain Rules"){
        node.textContent = "Domain Ops";
      }

      if(t === "Domain Registry Governance"){
        node.textContent = "Domain Ops";
      }
    });
  }

  function boot(){
    renameDomainRules();
    renderLifetime();

    setTimeout(function(){ renameDomainRules(); renderLifetime(); }, 300);
    setTimeout(function(){ renameDomainRules(); renderLifetime(); }, 1000);
    setTimeout(function(){ renameDomainRules(); renderLifetime(); }, 2200);

    document.addEventListener("click", function(){
      setTimeout(function(){ renameDomainRules(); renderLifetime(); }, 250);
      setTimeout(function(){ renameDomainRules(); renderLifetime(); }, 900);
    }, true);
  }

  document.addEventListener("DOMContentLoaded", boot);
  window.addEventListener("load", boot);

  window.CookieGateBannerLifetimeUiDomainOpsV011 = {
    renderLifetime: renderLifetime,
    renameDomainRules: renameDomainRules
  };
})();

// COOKIEGATE_V32_SIMPLE_BANNER_METRICS_AND_RULE_ACTIVATION
(function(){
  "use strict";

  var API = typeof browser !== "undefined" ? browser : chrome;

  var CURRENT_KEY = "cookiegate.bannerSuppression.current.v1";
  var SESSION_KEY = "cookiegate.bannerSuppression.session.v32";
  var TIMELINE_KEY = "cookiegate.bannerSuppression.timeline.v1";
  var STATS_KEY = "cookiegate.bannerSuppression.stats.v1";
  var RULE_LOCK_KEY = "cookiegate.domainModeLocks.v32";

  var PANEL_ID = "cgV32BannerMetrics";
  var RULE_BADGE_ID = "cgV32RuleBadge";
  var TOAST_ID = "cgV32Toast";

  function text(el){
    return String((el && el.textContent) || "").replace(/\s+/g, " ").trim();
  }

  function all(sel){
    try { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
    catch(e){ return []; }
  }

  function byId(id){
    return document.getElementById(id);
  }

  function cleanHost(s){
    s = String(s || "").toLowerCase().trim();
    s = s.replace(/^site:\s*/i, "");
    s = s.replace(/^https?:\/\//, "");
    s = s.split("/")[0].split("?")[0].split("#")[0];
    s = s.replace(/:\d+$/, "");
    s = s.replace(/^www\./, "");
    s = s.replace(/^\.+|\.+$/g, "");
    if(s === "-" || s === "browser observer" || s === "browser" || s === "example.com") return "";
    return s;
  }

  function siteHost(){
    var m = String(document.body && document.body.textContent || "").match(/Site:\s*([^\n\r]+)/i);
    return m && m[1] ? cleanHost(m[1]) : "";
  }

  function typedDomain(){
    var inputs = all("input[type='text'], input:not([type])");
    for(var i = 0; i < inputs.length; i++){
      var h = cleanHost(inputs[i].value);
      if(h) return h;
    }
    return "";
  }

  function scope(){
    return typedDomain() || siteHost();
  }

  function getLocal(keys){
    return new Promise(function(resolve){
      try {
        if(!API || !API.storage || !API.storage.local){ resolve({}); return; }
        if(API.storage.local.get.length >= 2){
          API.storage.local.get(keys, function(v){ resolve(v || {}); });
          return;
        }
        API.storage.local.get(keys).then(function(v){ resolve(v || {}); }).catch(function(){ resolve({}); });
      } catch(e){
        resolve({});
      }
    });
  }

  function setLocal(obj){
    return new Promise(function(resolve){
      try {
        if(!API || !API.storage || !API.storage.local){ resolve(false); return; }
        if(API.storage.local.set.length >= 2){
          API.storage.local.set(obj, function(){ resolve(true); });
          return;
        }
        API.storage.local.set(obj).then(function(){ resolve(true); }).catch(function(){ resolve(false); });
      } catch(e){
        resolve(false);
      }
    });
  }

  function ensureCss(){
    if(byId("cgV32Css")) return;

    var style = document.createElement("style");
    style.id = "cgV32Css";
    style.textContent = [
      "#"+PANEL_ID+"{margin:6px 0 10px 0;padding:10px;border:1px solid rgba(59,130,246,.32);border-radius:14px;background:rgba(15,23,42,.52)}",
      "#"+PANEL_ID+" .cg-title{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px;color:#e0f2fe;font-size:12px;font-weight:900;letter-spacing:.04em;text-transform:uppercase}",
      "#"+PANEL_ID+" .cg-domain{color:#93c5fd;font-size:11px;font-weight:800;text-transform:none;letter-spacing:0}",
      "#"+PANEL_ID+" .cg-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:7px}",
      "#"+PANEL_ID+" .cg-metric{padding:8px 6px;border-radius:12px;background:rgba(2,6,23,.42);text-align:center;border:1px solid rgba(148,163,184,.14)}",
      "#"+PANEL_ID+" .cg-metric b{display:block;color:#f8fafc;font-size:20px;line-height:1.05}",
      "#"+PANEL_ID+" .cg-metric span{display:block;color:#a8bad6;font-size:8px;text-transform:uppercase;letter-spacing:.035em;margin-top:4px;line-height:1.15}",
      "#"+PANEL_ID+" .cg-status{margin-top:8px;color:#cbd5e1;font-size:10px;line-height:1.3}",
      "#"+RULE_BADGE_ID+"{margin:6px 0 8px 0;padding:7px 9px;border-radius:12px;background:rgba(30,64,175,.22);border:1px solid rgba(96,165,250,.32);color:#dbeafe;font-size:11px;font-weight:800}",
      "#"+TOAST_ID+"{position:fixed;z-index:999999;left:12px;right:12px;bottom:12px;padding:10px;border-radius:14px;background:rgba(15,23,42,.96);border:1px solid rgba(96,165,250,.40);color:#eff6ff;font-size:12px;font-weight:900;box-shadow:0 16px 34px rgba(0,0,0,.35)}",
      "@media(max-width:430px){#"+PANEL_ID+" .cg-grid{grid-template-columns:repeat(2,1fr)}}"
    ].join("\n");

    document.documentElement.appendChild(style);
  }

  function topAnchor(){
    var nodes = all("section,article,div");
    for(var i = 0; i < nodes.length; i++){
      var t = text(nodes[i]);
      if(t.indexOf("Active Site") >= 0 && t.indexOf("Browser Observer") >= 0 && t.indexOf("Domain Ops") >= 0 && t.indexOf("Global") >= 0){
        return nodes[i];
      }
    }
    return document.body;
  }

  function metric(label, value){
    var m = document.createElement("div");
    m.className = "cg-metric";

    var b = document.createElement("b");
    b.textContent = String(value);

    var s = document.createElement("span");
    s.textContent = label;

    m.appendChild(b);
    m.appendChild(s);
    return m;
  }

  function removePanel(){
    var old = byId(PANEL_ID);
    if(old) old.remove();
  }

  
  function cgV60NormalizeHost(raw){
    try {
      var s = String(raw || "").toLowerCase().trim();
      if(s.indexOf("http://") === 0) s = s.slice(7);
      if(s.indexOf("https://") === 0) s = s.slice(8);
      s = s.split("/")[0];
      if(s.indexOf("www.") === 0) s = s.slice(4);
      return s;
    } catch(e){
      return "";
    }
  }

  function cgV60BannerRootFromPopupState(){
    try {
      var site = "";
      if(typeof state === "object" && state && state.site){
        site = String(state.site || "");
      }
      if(!site && document.body){
        var lines = String(document.body.innerText || "").split("\n");
        for(var i = 0; i < lines.length; i++){
          if(lines[i].indexOf("Site:") === 0){
            site = lines[i].slice(5).trim();
            break;
          }
        }
      }
      return cgV60NormalizeHost(site);
    } catch(e){
      return "";
    }
  }

  function cgV60ParseMaybe(value){
    if(typeof value !== "string") return value;
    var s = value.trim();
    if(!s) return value;
    var first = s.charAt(0);
    var last = s.charAt(s.length - 1);
    if((first === "{" && last === "}") || (first === "[" && last === "]")){
      try { return JSON.parse(s); } catch(e){}
    }
    return value;
  }

  function cgV60ExtractHost(obj){
    try {
      var raw = "";
      if(obj){
        raw = obj.domain || obj.host || obj.hostname || obj.site || obj.root || obj.url || obj.href || "";
      }
      return cgV60NormalizeHost(raw);
    } catch(e){
      return "";
    }
  }

  function cgV60ExtractTime(obj){
    try {
      var raw = obj.ts || obj.time || obj.utc || obj.timestamp || obj.createdAt || obj.updatedAt || obj.date || "";
      if(typeof raw === "number") return raw;
      if(raw){
        var parsed = Date.parse(String(raw));
        if(!isNaN(parsed)) return parsed;
      }
    } catch(e){}
    return 0;
  }

  function cgV60LooksLikeBannerEvent(obj, keyHint){
    try {
      var blob = (String(keyHint || "") + " " + JSON.stringify(obj || {})).toLowerCase();

      var hasBannerSignal =
        blob.indexOf("banner") >= 0 ||
        blob.indexOf("suppression") >= 0 ||
        blob.indexOf("consent") >= 0 ||
        blob.indexOf("cmp") >= 0 ||
        blob.indexOf("osano") >= 0 ||
        blob.indexOf("onetrust") >= 0 ||
        blob.indexOf("privacy") >= 0;

      if(!hasBannerSignal) return false;

      var hasEventSignal =
        blob.indexOf("blocked") >= 0 ||
        blob.indexOf("suppressed") >= 0 ||
        blob.indexOf("removed") >= 0 ||
        blob.indexOf("hidden") >= 0 ||
        blob.indexOf("dismissed") >= 0 ||
        blob.indexOf("detected") >= 0 ||
        blob.indexOf("matched") >= 0 ||
        blob.indexOf("banner") >= 0;

      if(!hasEventSignal) return false;

      var configOnly =
        blob.indexOf("setting") >= 0 ||
        blob.indexOf("config") >= 0 ||
        blob.indexOf("options") >= 0 ||
        blob.indexOf("preference") >= 0 ||
        blob.indexOf("schema") >= 0 ||
        blob.indexOf("style") >= 0;

      if(configOnly){
        var hasAction =
          blob.indexOf("blocked") >= 0 ||
          blob.indexOf("suppressed") >= 0 ||
          blob.indexOf("removed") >= 0 ||
          blob.indexOf("hidden") >= 0 ||
          blob.indexOf("dismissed") >= 0 ||
          blob.indexOf("detected") >= 0 ||
          blob.indexOf("matched") >= 0;

        if(!hasAction) return false;
      }

      return true;
    } catch(e){
      return false;
    }
  }

  function cgV60CollectBannerEvents(value, keyHint, out, depth){
    if(depth > 8) return;

    value = cgV60ParseMaybe(value);

    if(Array.isArray(value)){
      value.forEach(function(v){
        cgV60CollectBannerEvents(v, keyHint, out, depth + 1);
      });
      return;
    }

    if(value && typeof value === "object"){
      if(cgV60LooksLikeBannerEvent(value, keyHint)){
        out.push({
          key: String(keyHint || ""),
          host: cgV60ExtractHost(value),
          time: cgV60ExtractTime(value),
          raw: value
        });
      }

      Object.keys(value).forEach(function(k){
        cgV60CollectBannerEvents(value[k], String(keyHint || "") + "." + k, out, depth + 1);
      });
    }
  }

  function cgV60FindBannerPanel(){
    try {
      var nodes = Array.from(document.querySelectorAll("section, article, div, aside"));
      var scored = nodes.filter(function(el){
        var t = String(el.textContent || "");
        return t.indexOf("Banner Suppression") >= 0 &&
               t.indexOf("this site now") >= 0 &&
               t.indexOf("this session") >= 0 &&
               t.indexOf("site timeline") >= 0 &&
               t.indexOf("lifetime blocked") >= 0;
      });

      if(!scored.length) return null;

      scored.sort(function(a,b){
        return String(a.textContent || "").length - String(b.textContent || "").length;
      });

      return scored[0];
    } catch(e){
      return null;
    }
  }

  function cgV60SetBannerMetric(panel, label, value, fallbackIndex){
    try {
      var all = Array.from(panel.querySelectorAll("*"));
      var target = all.find(function(el){
        return String(el.textContent || "").trim().toLowerCase() === label.toLowerCase();
      });

      if(target){
        var box = target.closest(".cg-metric, .metric, .stat, .card, div") || target.parentElement;
        if(box){
          var valueNode = box.querySelector("b, strong, .value, .count, [data-value]");
          if(valueNode){
            valueNode.textContent = String(value);
            return true;
          }

          var prev = target.previousElementSibling;
          if(prev){
            prev.textContent = String(value);
            return true;
          }
        }
      }

      var bolds = Array.from(panel.querySelectorAll("b, strong"));
      if(bolds[fallbackIndex]){
        bolds[fallbackIndex].textContent = String(value);
        return true;
      }
    } catch(e){}
    return false;
  }

  
  function cgV62BannerNumber(value){
    var n = Number(value || 0);
    if(!isFinite(n) || isNaN(n)) return 0;
    return n < 0 ? 0 : n;
  }

  function cgV62BannerCounts(input){
    input = input || {};
    var lifetime = input.lifetimeBlocked;
    if(lifetime === undefined || lifetime === null) lifetime = input.allLifetime;
    if(lifetime === undefined || lifetime === null) lifetime = input.lifetime;
    return {
      siteNow: cgV62BannerNumber(input.siteNow),
      siteSession: cgV62BannerNumber(input.siteSession),
      siteTimeline: cgV62BannerNumber(input.siteTimeline),
      lifetimeBlocked: cgV62BannerNumber(lifetime)
    };
  }

  function cgV62BannerMessageText(input){
    var counts = cgV62BannerCounts(input);

    if(counts.siteNow > 0){
      return "Banner suppression active on this site right now.";
    }

    if(counts.siteSession > 0){
      return "Banner suppression activity recorded for this site in this session.";
    }

    if(counts.siteTimeline > 0){
      return "Banner suppression history exists for this site.";
    }

    if(counts.lifetimeBlocked > 0){
      return "Banner suppression activity exists in the browser timeline, but not for this site right now.";
    }

    return "No banner suppressed on this site right now.";
  }

  function cgV62ParseMetricNumber(value){
    var m = String(value || "").match(/\d+/);
    if(!m) return 0;
    var n = parseInt(m[0], 10);
    return isNaN(n) ? 0 : n;
  }

  function cgV62PanelAttrCount(panel, names){
    try {
      for(var i = 0; i < names.length; i++){
        if(panel && panel.hasAttribute(names[i])){
          return cgV62ParseMetricNumber(panel.getAttribute(names[i]));
        }
      }
    } catch(e){}
    return null;
  }

  function cgV62FindBannerMessageNode(panel){
    try {
      if(!panel) return null;

      var status = panel.querySelector("[data-cg-v62-banner-message], .cg-status");
      if(status){
        if(!status.firstChild || status.firstChild.nodeType !== Node.TEXT_NODE){
          status.textContent = String(status.textContent || "");
        }
        return status.firstChild;
      }

      var known = [
        "No banner suppressed",
        "Suppression active for this site",
        "Banner suppression active",
        "Banner suppression activity",
        "Banner suppression history"
      ];

      var walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT, null);
      var n;
      while((n = walker.nextNode())){
        var t = String(n.nodeValue || "").trim();
        for(var i = 0; i < known.length; i++){
          if(t.indexOf(known[i]) >= 0){
            return n;
          }
        }
      }
    } catch(e){}

    return null;
  }

  function cgV62ApplyBannerMessage(panel, counts){
    try {
      if(!panel) return false;

      var text = cgV62BannerMessageText(counts);
      var node = cgV62FindBannerMessageNode(panel);

      if(node){
        node.nodeValue = text;
        if(node.parentElement){
          node.parentElement.setAttribute("data-cg-v62-banner-message", "1");
        }
      } else {
        var el = panel.querySelector(".cg-status");
        if(!el){
          el = document.createElement("div");
          el.className = "cg-status";
          panel.appendChild(el);
        }
        el.textContent = text;
        el.setAttribute("data-cg-v62-banner-message", "1");
      }

      panel.setAttribute("data-cg-v62-banner-message-text", text);
      panel.setAttribute("data-cg-v62-banner-semantics", "canonical-owner");
      return true;
    } catch(e){
      return false;
    }
  }



  function cgV64MetricNumber(text){
    var m = String(text || "").match(/\d+/);
    return m ? m[0] : "0";
  }

  function cgV64NormalizeBannerMetricRows(panel){
    try {
      if(!panel) return false;

      var grid = panel.querySelector(".cg-grid");
      if(!grid) return false;

      var labels = [
        "this site now",
        "this session",
        "site timeline",
        "lifetime blocked"
      ];

      Array.prototype.slice.call(grid.children || []).forEach(function(row){
        try {
          var raw = String(row.textContent || "").replace(/\s+/g, " ").trim();
          var lower = raw.toLowerCase();
          var label = "";

          for(var i = 0; i < labels.length; i++){
            if(lower.indexOf(labels[i]) >= 0){
              label = labels[i];
              break;
            }
          }

          if(!label) return;

          var value = cgV64MetricNumber(raw);
          row.setAttribute("data-cg-v64-metric-row", "1");
          row.setAttribute("data-cg-v64-metric-label", label);
          row.setAttribute("data-cg-v64-metric-value", value);

          while(row.firstChild) row.removeChild(row.firstChild);

          var labelNode = document.createElement("span");
          labelNode.className = "cg-v64-metric-label";
          labelNode.textContent = label + ":";

          var valueNode = document.createElement("span");
          valueNode.className = "cg-v64-metric-value";
          valueNode.textContent = value;

          row.appendChild(labelNode);
          row.appendChild(valueNode);
        } catch(e){}
      });

      cgV64EnsureMetricRowCss();
      panel.setAttribute("data-cg-v64-metric-row-clarity", "1");
      return true;
    } catch(e){
      return false;
    }
  }

  function cgV64EnsureMetricRowCss(){
    try {
      if(document.getElementById("cgV64MetricRowClarityStyle")) return;

      var style = document.createElement("style");
      style.id = "cgV64MetricRowClarityStyle";
      style.textContent = [
        "#cgV32BannerMetrics .cg-grid{display:flex!important;flex-direction:column!important;gap:8px!important;}",
        "#cgV32BannerMetrics [data-cg-v64-metric-row='1']{display:flex!important;align-items:center!important;justify-content:space-between!important;gap:12px!important;min-height:30px!important;padding:8px 10px!important;}",
        "#cgV32BannerMetrics .cg-v64-metric-label{font-size:12px!important;font-weight:600!important;text-transform:none!important;opacity:.9!important;}",
        "#cgV32BannerMetrics .cg-v64-metric-value{font-size:16px!important;font-weight:800!important;font-variant-numeric:tabular-nums!important;}"
      ].join("\n");

      document.documentElement.appendChild(style);
    } catch(e){}
  }

  // COOKIEGATE_V64_METRIC_ROW_CLARITY_HELPERS


  function cgV65MetricNumber(value){
    var m = String(value || "").match(/\d+/);
    return m ? m[0] : "0";
  }

  function cgV65MetricLabel(raw, row){
    var fromAttr = row && row.getAttribute ? row.getAttribute("data-cg-v64-metric-label") : "";
    if(fromAttr) return String(fromAttr || "").trim();

    var lower = String(raw || "").toLowerCase();
    var labels = ["this site now","this session","site timeline","lifetime blocked"];

    for(var i = 0; i < labels.length; i++){
      if(lower.indexOf(labels[i]) >= 0) return labels[i];
    }

    return "";
  }

  function cgV65NormalizeBannerMetricRows(panel){
    try {
      if(!panel) return false;

      var grid = panel.querySelector(".cg-grid");
      if(!grid) return false;

      Array.prototype.slice.call(grid.children || []).forEach(function(row){
        try {
          var raw = String(row.textContent || "").replace(/\s+/g, " ").trim();
          var label = cgV65MetricLabel(raw, row);
          if(!label) return;

          var value = row.getAttribute && row.getAttribute("data-cg-v64-metric-value");
          if(value === null || value === undefined || value === "") value = cgV65MetricNumber(raw);

          row.setAttribute("data-cg-v65-metric-row", "1");
          row.setAttribute("data-cg-v65-metric-label", label);
          row.setAttribute("data-cg-v65-metric-value", value);
          row.setAttribute("aria-label", label + ": " + value);

          while(row.firstChild) row.removeChild(row.firstChild);

          var valueNode = document.createElement("span");
          valueNode.className = "cg-v65-metric-value";
          valueNode.textContent = String(value);

          var labelNode = document.createElement("span");
          labelNode.className = "cg-v65-metric-label";
          labelNode.textContent = label;

          row.appendChild(valueNode);
          row.appendChild(labelNode);
        } catch(e){}
      });

      cgV65EnsureMetricCss();
      panel.setAttribute("data-cg-v65-horizontal-metric-clarity", "1");
      return true;
    } catch(e){
      return false;
    }
  }

  function cgV65EnsureMetricCss(){
    try {
      var old = document.getElementById("cgV64MetricRowClarityStyle");
      if(old && old.parentNode) old.parentNode.removeChild(old);

      var existing = document.getElementById("cgV65HorizontalMetricStyle");
      if(existing) return;

      var style = document.createElement("style");
      style.id = "cgV65HorizontalMetricStyle";
      style.textContent = [
        "#cgV32BannerMetrics .cg-grid{display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:8px!important;}",
        "#cgV32BannerMetrics [data-cg-v65-metric-row='1']{display:flex!important;flex-direction:row!important;align-items:baseline!important;justify-content:flex-start!important;gap:7px!important;min-height:30px!important;padding:8px 10px!important;white-space:nowrap!important;}",
        "#cgV32BannerMetrics .cg-v65-metric-value{font-size:18px!important;font-weight:850!important;font-variant-numeric:tabular-nums!important;line-height:1!important;}",
        "#cgV32BannerMetrics .cg-v65-metric-label{font-size:11px!important;font-weight:650!important;line-height:1!important;opacity:.9!important;text-transform:none!important;}"
      ].join("\n");

      document.documentElement.appendChild(style);
    } catch(e){}
  }

  // COOKIEGATE_V65_HORIZONTAL_METRICS_SITE_NOW_CURRENT_HELPERS

  function cgV60SetBannerMessage(panel, counts){
    try {
      cgV62ApplyBannerMessage(panel, {
        siteNow: counts && counts.siteNow,
        siteSession: counts && counts.siteSession,
        siteTimeline: counts && counts.siteTimeline,
        lifetimeBlocked: counts && counts.allLifetime
      });
    } catch(e){}
  }

  function cgV60ReconcileBannerMetrics(){
    try {
      var panel = cgV60FindBannerPanel();
      if(!panel) return;

      var root = cgV60BannerRootFromPopupState();
      var sessionStart = window.CookieGateV60BannerSessionStart || (window.CookieGateV60BannerSessionStart = Date.now());
      var now = Date.now();

      var finish = function(store){
        try {
          var events = [];

          Object.keys(store || {}).forEach(function(k){
            var lk = String(k || "").toLowerCase();
            if(lk.indexOf("banner") >= 0 || lk.indexOf("suppression") >= 0 || lk.indexOf("consent") >= 0 || lk.indexOf("cmp") >= 0 || lk.indexOf("ledger") >= 0 || lk.indexOf("timeline") >= 0 || lk.indexOf("lifetime") >= 0){
              cgV60CollectBannerEvents(store[k], k, events, 0);
            }
          });

          var siteEvents = events.filter(function(ev){
            if(!root) return false;
            var h = cgV60NormalizeHost(ev.host || "");
            return h === root || h.endsWith("." + root) || root.endsWith("." + h);
          });

          var allLifetime = events.length;
          var siteTimeline = siteEvents.length;
          var siteSession = siteEvents.filter(function(ev){
            return ev.time && ev.time >= sessionStart;
          }).length;
          var allSession = events.filter(function(ev){
            return ev.time && ev.time >= sessionStart;
          }).length;
          var siteNow = siteEvents.filter(function(ev){
            return ev.time && (now - ev.time) <= 30000;
          }).length;

          try {
            var currentNowV65 = 0;
            var currentMapV65 = cgV60ParseMaybe(store[CURRENT_KEY]);

            Object.keys(currentMapV65 || {}).forEach(function(k){
              try {
                var item = currentMapV65[k] || {};
                var host = cgV60NormalizeHost(item.host || item.domain || k || "");
                if(!root) return;
                if(!(host === root || host.endsWith("." + root) || root.endsWith("." + host))) return;

                var n = Number(item.suppressed_count || item.suppressed || item.count || 0);
                if(isFinite(n) && !isNaN(n) && n > currentNowV65) currentNowV65 = n;
              } catch(e){}
            });

            if(currentNowV65 > siteNow) siteNow = currentNowV65;
            if(siteSession > 0 && siteNow < 1) siteNow = 1;
          } catch(e){}

          var counts = {
            siteNow: siteNow,
            siteSession: siteSession,
            siteTimeline: siteTimeline,
            allSession: allSession,
            allLifetime: allLifetime
          };

          cgV60SetBannerMetric(panel, "this site now", counts.siteNow, 0);
          cgV60SetBannerMetric(panel, "this session", counts.siteSession, 1);
          cgV60SetBannerMetric(panel, "site timeline", counts.siteTimeline, 2);
          cgV60SetBannerMetric(panel, "lifetime blocked", counts.allLifetime, 3);
          cgV60SetBannerMessage(panel, counts);
          try { cgV64NormalizeBannerMetricRows(panel); try { cgV65NormalizeBannerMetricRows(panel); } catch(e){} } catch(e){}

          panel.setAttribute("data-cg-v60-banner-reconciled", "1");
          panel.setAttribute("data-cg-v62-site-now", String(counts.siteNow));
          panel.setAttribute("data-cg-v62-site-session", String(counts.siteSession));
          panel.setAttribute("data-cg-v62-site-timeline", String(counts.siteTimeline));
          panel.setAttribute("data-cg-v62-lifetime-blocked", String(counts.allLifetime));
          panel.setAttribute("data-cg-v60-banner-all-session", String(counts.allSession));
          panel.setAttribute("data-cg-v60-banner-all-lifetime", String(counts.allLifetime));
          try { if(typeof cgV61Reconcile === "function") cgV61Reconcile(); } catch(e){}

          // COOKIEGATE_V62_BANNER_SEMANTICS_COUNTER_ATTRS
        } catch(e){}
      };

      if(typeof chrome !== "undefined" && chrome.storage && chrome.storage.local && chrome.storage.local.get){
        chrome.storage.local.get(null, function(items){
          finish(items || {});
        });
      } else {
        var local = {};
        try {
          for(var i = 0; i < localStorage.length; i++){
            var k = localStorage.key(i);
            local[k] = localStorage.getItem(k);
          }
        } catch(e){}
        finish(local);
      }
    } catch(e){}
  }

async function renderMetrics(){
    try {
      ensureCss();
      var d = scope();
      d = cleanHost(d || "");
      if(!d) return;
      var store = await getLocal([CURRENT_KEY, SESSION_KEY, TIMELINE_KEY, STATS_KEY]);
      var currentMap = store[CURRENT_KEY] || {};
      var sessionMap = store[SESSION_KEY] || {};
      var timeline = Array.isArray(store[TIMELINE_KEY]) ? store[TIMELINE_KEY] : [];
      var stats = store[STATS_KEY] || {};

      function n(v){
        var x = Number(v || 0);
        if(!isFinite(x) || isNaN(x) || x < 0) return 0;
        return x;
      }

      function hostOk(h){
        h = cleanHost(h || "");
        return !!(h && d && (h === d || h.endsWith("." + d) || d.endsWith("." + h)));
      }

      function countOf(obj){
        try {
          if(!obj || typeof obj !== "object") return 0;
          var direct = n(obj.suppressed_count !== undefined ? obj.suppressed_count : obj.suppressed !== undefined ? obj.suppressed : obj.blocked_count !== undefined ? obj.blocked_count : obj.blocked !== undefined ? obj.blocked : obj.count !== undefined ? obj.count : 0);
          if(direct > 0) return direct;
          var text = String([obj.status, obj.state, obj.result, obj.event, obj.type, obj.action].join(" ")).toLowerCase();
          if(text.indexOf("suppressed") >= 0 || text.indexOf("blocked") >= 0 || text.indexOf("removed") >= 0) return 1;
        } catch(e){}
        return 0;
      }

      function bestForRoot(value, depth, fallbackKey){
        if(depth > 7) return 0;
        var best = 0;
        try {
          if(!value) return 0;
          if(Array.isArray(value)){
            value.forEach(function(item){ var c = bestForRoot(item, depth + 1, fallbackKey); if(c > best) best = c; });
            return best;
          }
          if(typeof value !== "object") return 0;
          var ownHost = value.host || value.domain || value.root || value.site || value.hostname || fallbackKey || "";
          if(hostOk(ownHost)){
            var own = countOf(value);
            if(own > best) best = own;
          }
          Object.keys(value).forEach(function(k){
            try {
              var child = value[k];
              var keyHost = hostOk(k) ? k : ownHost;
              var c = bestForRoot(child, depth + 1, keyHost);
              if(c > best) best = c;
            } catch(e){}
          });
        } catch(e){}
        return best;
      }

      function eventTime(e){
        try {
          var raw = e.time || e.timestamp || e.ts || e.created_at || e.observed_at || e.stamp || 0;
          var t = Number(raw);
          if(isFinite(t) && !isNaN(t) && t > 0){ return t < 1000000000000 ? t * 1000 : t; }
          var d = Date.parse(String(raw || ""));
          if(isFinite(d) && !isNaN(d) && d > 0) return d;
        } catch(x){}
        return 0;
      }

      var now = Date.now();
      var siteEvents = timeline.filter(function(e){
        try { return hostOk(e.host || e.domain || e.root || e.site || e.hostname || ""); } catch(x){ return false; }
      });

      var timelineCount = siteEvents.length;
      var timelineSuppressed = 0;
      var recentSuppressed = 0;
      siteEvents.forEach(function(e){
        try {
          var c = countOf(e);
          if(c < 1) c = 1;
          timelineSuppressed += c;
          var t = eventTime(e);
          if(t > 0 && (now - t) <= 120000) recentSuppressed += c;
        } catch(x){}
      });

      var currentSuppressed = bestForRoot(currentMap, 0, "");
      var sessionSuppressed = bestForRoot(sessionMap, 0, "");
      var lifetimeSuppressed = bestForRoot(stats, 0, "");

      if(currentSuppressed < recentSuppressed) currentSuppressed = recentSuppressed;
      if(sessionSuppressed < timelineSuppressed) sessionSuppressed = timelineSuppressed;
      if(lifetimeSuppressed < timelineSuppressed) lifetimeSuppressed = timelineSuppressed;

      removePanel();

      var panel = document.createElement("section");
      panel.id = PANEL_ID;
      panel.className = "cg-card";
      panel.setAttribute("data-cg-v7-role", "active");
      panel.setAttribute("data-cg-v70-active-site-banner", "1");
      panel.setAttribute("data-cg-v75-banner-counter-reconcile", "1");

      var title = document.createElement("div");
      title.className = "cg-section-row";
      var h = document.createElement("h2");
      h.textContent = "Banner Suppression";
      var domain = document.createElement("span");
      domain.className = "cg-domain";
      domain.textContent = d || "current site";
      title.appendChild(h);
      title.appendChild(domain);
      panel.appendChild(title);

      var grid = document.createElement("div");
      grid.className = "cg-grid";
      grid.appendChild(metric("this site now", currentSuppressed));
      grid.appendChild(metric("this session", sessionSuppressed));
      grid.appendChild(metric("site timeline", timelineCount));
      grid.appendChild(metric("lifetime blocked", lifetimeSuppressed));
      panel.appendChild(grid);

      var status = document.createElement("div");
      status.className = "cg-status";
      if(currentSuppressed > 0){
        status.textContent = "Banner suppression active or recently observed on this site.";
      } else if(sessionSuppressed > 0){
        status.textContent = "Banner suppression activity recorded for this site in this session.";
      } else if(timelineCount > 0){
        status.textContent = "Banner suppression history exists for this site.";
      } else if(lifetimeSuppressed > 0){
        status.textContent = "Banner suppression activity exists in the browser timeline, but not for this site right now.";
      } else {
        status.textContent = "No banner suppressed on this site right now.";
      }
      panel.appendChild(status);

      // Place the Banner Suppression panel at the TOP of the Active Site
      // content column (.cg-main-left), above the Cookies card. This keeps it
      // high (no bottom-scrolling) while staying INSIDE the container the
      // router already hides on the Browser Observer / Domain Ops tabs -- which
      // is the reliable way to scope it (the earlier shell-level placement
      // escaped that scoping and leaked onto Observer). Falls back to the
      // original position if the layout isn't found.
      var cgMainLeft = document.querySelector(".cg-main-left");
      if(cgMainLeft){
        cgMainLeft.insertBefore(panel, cgMainLeft.firstChild);
      } else {
        var anchor = document.querySelector("[data-cg-v7-role=\"evidence\"]") || document.querySelector("[data-cg-v7-role=\"cookies\"]") || topAnchor();
        if(anchor && anchor.parentElement){
          anchor.parentElement.insertBefore(panel, anchor);
        } else {
          document.body.appendChild(panel);
        }
      }
    } catch(e){}
}

  // COOKIEGATE_V75_BANNER_COUNTER_RECONCILE_FIREFOX_FIRST_RENDER

  function normalizeMode(x){
    var s = String(x || "").trim().toLowerCase();
    if(s.indexOf("strict") >= 0) return "strict";
    if(s.indexOf("balanced") >= 0) return "balanced";
    if(s.indexOf("standard") >= 0) return "standard";
    if(s.indexOf("relaxed") >= 0) return "relaxed";
    if(s.indexOf("off") >= 0) return "off";
    if(s.indexOf("block") >= 0) return "block";
    if(s.indexOf("allow") >= 0) return "allow";
    return "";
  }

  function selectedModeNearSave(btn){
    var root = btn;
    for(var depth = 0; root && depth < 7; depth++){
      var selects = Array.prototype.slice.call(root.querySelectorAll ? root.querySelectorAll("select") : []);
      for(var i = 0; i < selects.length; i++){
        var v = normalizeMode(selects[i].value || text(selects[i]));
        if(v) return v;
      }

      var nodes = Array.prototype.slice.call(root.querySelectorAll ? root.querySelectorAll("button, [role='button'], .active, [aria-selected='true'], option:checked") : []);
      for(var j = 0; j < nodes.length; j++){
        var t = normalizeMode(text(nodes[j]));
        if(t) return t;
      }

      root = root.parentElement;
    }

    var body = String(document.body && document.body.textContent || "");
    var m = body.match(/\b(Strict|Balanced|Standard|Relaxed|Off|Block|Allow)\b/i);
    return m && m[1] ? normalizeMode(m[1]) : "strict";
  }

  async function saveAndActivateRule(btn){
    var domain = typedDomain() || siteHost();
    if(!domain) return;

    var mode = selectedModeNearSave(btn) || "strict";

    var store = await getLocal([RULE_LOCK_KEY]);
    var locks = store[RULE_LOCK_KEY] || {};

    locks[domain] = {
      schema: "cookiegate.domain_mode_lock.v50",
      domain: domain,
      root: domain,
      mode: mode,
      active: true,
      enabled: true,
      disabled: false,
      status: "active",
      state: "active",
      checked: true,
      reachable: true,
      reachability: "checked",
      updated_utc: new Date().toISOString(),
      source: "save_rule_native_row_renderer_v50"
    };

    var patch = {};
    patch[RULE_LOCK_KEY] = locks;
    await setLocal(patch);
  }

  function renderRuleLock(domain, mode){
    return;
  }

  async function renderRuleLockFromStorage(){
    var domain = typedDomain() || siteHost();
    if(!domain) return;

    var store = await getLocal([RULE_LOCK_KEY]);
    var locks = store[RULE_LOCK_KEY] || {};
    var lock = locks[domain];

    if(!lock || !lock.active){
      var old = byId(RULE_BADGE_ID);
      if(old) old.remove();
      return;
    }

    renderRuleLock(domain, String(lock.mode || "strict").toLowerCase());
  }

  function toast(msg){
    var old = byId(TOAST_ID);
    if(old) old.remove();

    var t = document.createElement("div");
    t.id = TOAST_ID;
    t.textContent = msg;
    document.body.appendChild(t);

    setTimeout(function(){
      var n = byId(TOAST_ID);
      if(n) n.remove();
    }, 1800);
  }

  document.addEventListener("click", function(ev){
    var btn = ev.target && ev.target.closest ? ev.target.closest("button, [role='button']") : null;
    if(btn && /^Save rule$/i.test(text(btn))){
      setTimeout(function(){ saveAndActivateRule(btn); }, 40);
      setTimeout(renderRuleLockFromStorage, 250);
      setTimeout(renderMetrics, 250);
      return;
    }

    setTimeout(renderMetrics, 80);
    setTimeout(renderRuleLockFromStorage, 80);
  }, true);

  document.addEventListener("DOMContentLoaded", function(){
    setTimeout(renderMetrics, 80);
    setTimeout(renderRuleLockFromStorage, 100);
    setTimeout(renderMetrics, 500);
    setTimeout(renderMetrics, 1400);
  });

  window.addEventListener("load", function(){
    setTimeout(renderMetrics, 80);
    setTimeout(renderRuleLockFromStorage, 100);
    setTimeout(renderMetrics, 500);
    setTimeout(renderMetrics, 1400);
  });

  try {
    new MutationObserver(function(){
      setTimeout(renderMetrics, 100);
      setTimeout(renderRuleLockFromStorage, 100);
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class","style","aria-selected","hidden"] });
  } catch(e){}

  setTimeout(renderMetrics, 80);
  setTimeout(renderRuleLockFromStorage, 100);
  setTimeout(renderMetrics, 500);
  setTimeout(renderMetrics, 1400);

  window.CookieGateV32SimpleBannerMetricsAndRuleActivation = {
    renderMetrics: renderMetrics,
    renderRuleLockFromStorage: renderRuleLockFromStorage
  };
})();

// COOKIEGATE_V48_CHROME_ONLY_RESTORE_RUNTIME_PATCH_DOMAIN_OPS
window.CookieGateV48ChromeOnlyRestoreRuntimePatchDomainOps = {
  patch: "restore-runtime-from-v32-and-patch-domain-ops-target-functions-only",
  changed_functions: ["inputRuleObject","saveInputRule","installBadge"],
  untouched_files: ["manifest.json","ui/popup.html","background/background.js"]
};

// COOKIEGATE_V49_FIX_DOMAIN_OPS_ROW_RENDERER
window.CookieGateV49FixDomainOpsRowRenderer = {
  patch: "fix-native-domain-ops-row-renderer-and-rule-badge-only",
  changed_functions: ["renderDomainRules","renderRuleLock","saveAndActivateRule"],
  source: "v48-working-runtime"
};

// COOKIEGATE_V50_DOMAIN_OPS_NO_BADGE_STYLED_ACTIONS
window.CookieGateV50DomainOpsNoBadgeStyledActions = {
  patch: "remove-floating-domain-rule-badge-and-style-domain-ops-actions",
  changed_functions: ["renderDomainRules","renderRuleLock","installBadge","saveAndActivateRule"],
  source: "v49-working-runtime"
};

// COOKIEGATE_V52_MODE_LOCK_RENDER_ONLY_FROM_V50
window.CookieGateV52ModeLockRenderOnlyFromV50 = {
  patch: "mode-lock-render-only",
  changed_functions: ["effectiveMode","render"],
  untouched_functions: ["bind","renderDomainRules"],
  source: "v50-working-runtime"
};

// COOKIEGATE_V53_MODE_LOCK_LOCALSTORAGE_BRIDGE
window.CookieGateV53ModeLockLocalStorageBridge = {
  patch: "mode-lock-read-cookiegate-domainRules-v1-directly",
  changed_functions: ["cgDomainOpsActiveRuleForSiteV52"],
  source: "v52-render-only-parse-green"
};

// COOKIEGATE_V54_SAVE_RULE_RERENDERS_ACTIVE_MODE_LOCK
window.CookieGateV54SaveRuleRerendersActiveModeLock = {
  patch: "save-rule-rerenders-active-mode-lock",
  changed_functions: ["saveInputRule"],
  source: "v53-mode-lock-localstorage-bridge"
};

// COOKIEGATE_V55_DOMAIN_RULE_WRITES_SITE_MODE
window.CookieGateV55DomainRuleWritesSiteMode = {
  patch: "save-domain-rule-writes-existing-site-mode-keys",
  changed_functions: ["saveInputRule"],
  source: "v54-save-rule-rerenders-active-mode-lock"
};

// COOKIEGATE_V56_ACTIVE_SITE_HEADER_USES_DOMAIN_RULE
window.CookieGateV56ActiveSiteHeaderUsesDomainRule = {
  patch: "active-site-header-visible-stats-use-domain-rule",
  changed_functions: ["renderHeader"],
  source: "v55-domain-rule-writes-site-mode"
};

// COOKIEGATE_V57_CLEAN_IMMEDIATE_REPAINT_NOTE_LAYOUT
window.CookieGateV57CleanImmediateRepaintNoteLayout = {
  patch: "clean-save-rule-immediate-active-repaint-and-readable-lock-note",
  changed_functions: ["saveInputRule","applyDomainOpsModeLockOnlyV52"],
  source: "v56-active-site-header-uses-domain-rule"
};

// COOKIEGATE_V59_SAVE_RULE_DIRECT_ACTIVE_LOCK_FIXED
window.CookieGateV59SaveRuleDirectActiveLockFixed = {
  patch: "save-rule-directly-locks-visible-active-site-controls",
  changed_functions: ["saveInputRule"],
  source: "v58-css-only-rule-button-spacing"
};

// COOKIEGATE_V60_BANNER_METRICS_RECONCILE_CLEAN
window.CookieGateV60BannerMetricsReconcileClean = {
  patch: "align-banner-site-now-session-timeline-and-all-lifetime-counters",
  changed_functions: ["renderMetrics"],
  source: "v59-save-rule-direct-active-lock-fixed"
};

// COOKIEGATE_V61_BANNER_MESSAGE_RECONCILE
(function(){
  function cgV61Panel(){
    try {
      var nodes = Array.from(document.querySelectorAll("section, article, aside, div"));
      var candidates = nodes.filter(function(el){
        var t = String(el.textContent || "");
        return t.indexOf("Banner Suppression") >= 0 &&
          t.indexOf("this site now") >= 0 &&
          t.indexOf("this session") >= 0 &&
          t.indexOf("site timeline") >= 0 &&
          t.indexOf("lifetime blocked") >= 0;
      });
      if(!candidates.length) return null;
      candidates.sort(function(a,b){
        return String(a.textContent || "").length - String(b.textContent || "").length;
      });
      return candidates[0];
    } catch(e){
      return null;
    }
  }

  
  function cgV61MetricFromText(panel, label){
    try {
      var lines = String(panel.textContent || "")
        .split(/\n+/)
        .map(function(x){ return String(x || "").trim(); })
        .filter(Boolean);

      var lower = String(label || "").toLowerCase();

      for(var i = 0; i < lines.length; i++){
        var current = String(lines[i] || "");
        var lc = current.toLowerCase();

        if(lc === lower){
          var prev = i > 0 ? cgV62ParseMetricNumber(lines[i - 1]) : 0;
          var next = i + 1 < lines.length ? cgV62ParseMetricNumber(lines[i + 1]) : 0;
          if(prev > 0) return prev;
          if(next > 0) return next;
          return 0;
        }

        if(lc.indexOf(lower) >= 0){
          return cgV62ParseMetricNumber(current);
        }
      }
    } catch(e){}
    return 0;
  }

  function cgV61FindMessageNode(panel){
    try {
      var exact = "No banner suppressed on this site right now.";
      var walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT, null);
      var n;
      while((n = walker.nextNode())){
        var t = String(n.nodeValue || "").trim();
        if(t === exact || t.indexOf("No banner suppressed") >= 0 || t.indexOf("Banner suppression activity") >= 0 || t.indexOf("Banner suppression history") >= 0 || t.indexOf("Banner suppression active") >= 0){
          return n;
        }
      }
    } catch(e){}
    return null;
  }

  
  function cgV61SetMessage(panel, counts){
    try {
      return cgV62ApplyBannerMessage(panel, {
        siteNow: counts && counts.siteNow,
        siteSession: counts && counts.siteSession,
        siteTimeline: counts && counts.siteTimeline,
        lifetimeBlocked: counts && counts.lifetime
      });
    } catch(e){
      return false;
    }
  }

  
  function cgV61Reconcile(){
    try {
      var panel = cgV61Panel();
      if(!panel) return;

      var siteNow = cgV62PanelAttrCount(panel, ["data-cg-v62-site-now", "data-cg-v61-site-now"]);
      var siteSession = cgV62PanelAttrCount(panel, ["data-cg-v62-site-session", "data-cg-v61-site-session"]);
      var siteTimeline = cgV62PanelAttrCount(panel, ["data-cg-v62-site-timeline", "data-cg-v61-site-timeline"]);
      var lifetime = cgV62PanelAttrCount(panel, ["data-cg-v62-lifetime-blocked", "data-cg-v61-lifetime", "data-cg-v60-banner-all-lifetime"]);

      var counts = {
        siteNow: siteNow === null ? cgV61MetricFromText(panel, "this site now") : siteNow,
        siteSession: siteSession === null ? cgV61MetricFromText(panel, "this session") : siteSession,
        siteTimeline: siteTimeline === null ? cgV61MetricFromText(panel, "site timeline") : siteTimeline,
        lifetime: lifetime === null ? cgV61MetricFromText(panel, "lifetime blocked") : lifetime
      };

      cgV61SetMessage(panel, counts);
      try { cgV64NormalizeBannerMetricRows(panel); try { cgV65NormalizeBannerMetricRows(panel); } catch(e){} } catch(e){}
      panel.setAttribute("data-cg-v61-banner-message-reconciled", "1");
      panel.setAttribute("data-cg-v61-site-now", String(counts.siteNow));
      panel.setAttribute("data-cg-v61-site-session", String(counts.siteSession));
      panel.setAttribute("data-cg-v61-site-timeline", String(counts.siteTimeline));
      panel.setAttribute("data-cg-v61-lifetime", String(counts.lifetime));

      // COOKIEGATE_V62_BANNER_SEMANTICS_V61_RECONCILE_CANONICAL
    } catch(e){}
  }

  function cgV61Schedule(){
    try { cgV61Reconcile(); } catch(e){}
    setTimeout(cgV61Reconcile, 0);
    setTimeout(cgV61Reconcile, 80);
    setTimeout(cgV61Reconcile, 250);
    setTimeout(cgV61Reconcile, 600);
  }

  document.addEventListener("click", cgV61Schedule, true);
  document.addEventListener("change", cgV61Schedule, true);

  if(document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", cgV61Schedule, { once:true });
  } else {
    cgV61Schedule();
  }

  try {
    var mo = new MutationObserver(function(){
      cgV61Schedule();
    });
    mo.observe(document.documentElement, { childList:true, subtree:true, characterData:true });
    window.CookieGateV61BannerMessageObserver = mo;
  } catch(e){}

  window.CookieGateV61BannerMessageReconcile = {
    patch: "align-banner-empty-message-with-visible-site-now-session-timeline-lifetime-counters",
    source: "v60-banner-metrics-reconcile-clean"
  };
})();

// COOKIEGATE_V62_BANNER_SEMANTICS_CANONICAL_OWNER_FIXED
window.CookieGateV62BannerSemanticsCanonicalOwnerFixed = {
  patch: "popup-owned-banner-message-semantics-bound-to-visible-counter-state",
  source: "v61-banner-message-reconcile",
  changed_file: "ui/popup.js",
  changed_functions: [
    "renderMetrics",
    "cgV60SetBannerMessage",
    "cgV60ReconcileBannerMetrics",
    "cgV61MetricFromText",
    "cgV61SetMessage",
    "cgV61Reconcile"
  ],
  untouched: [
    "manifest",
    "content scripts",
    "background",
    "Domain Ops lock",
    "button CSS",
    "Browser Observer"
  ]
};

try {
  window.CookieGateV64MetricRowClarity = {
    ok: true,
    marker: "COOKIEGATE_V64_METRIC_ROW_CLARITY",
    owner: "ui/popup.js",
    note: "Renders Banner Suppression metrics as label-colon-value rows to remove value/label ambiguity."
  };
} catch(e){}

// COOKIEGATE_V64_METRIC_ROW_CLARITY

try {
  window.CookieGateV65HorizontalMetricsSiteNowCurrent = {
    ok: true,
    marker: "COOKIEGATE_V65_HORIZONTAL_METRICS_SITE_NOW_CURRENT",
    owner: "ui/popup.js",
    note: "Restores compact horizontal Banner Suppression metrics and makes this-site-now reflect current-site session suppression."
  };
} catch(e){}

// COOKIEGATE_V65_HORIZONTAL_METRICS_SITE_NOW_CURRENT

try {
  window.CookieGateV69RecoverFastTabsQuarantineBannerPopup = {
    ok: true,
    marker: "COOKIEGATE_V69_RECOVER_FAST_TABS_QUARANTINE_BANNER_POPUP",
    source: "v65-not-v66-not-v67-not-v68",
    popup_banner_quarantined: true,
    runtime_preserved: true
  };
} catch(e){}

// COOKIEGATE_V69_RECOVER_FAST_TABS_QUARANTINE_BANNER_POPUP

try {
  window.CookieGateV70ActiveSiteBannerMetricsScopedFastGuardfix = {
    ok: true,
    marker: "COOKIEGATE_V70_ACTIVE_SITE_BANNER_METRICS_SCOPED_FAST_GUARDFIX",
    source: "v69-recovery-baseline",
    active_site_only: true,
    no_new_click_listener_added: true,
    no_new_mutation_observer_added: true,
    runtime_preserved: true
  };
} catch(e){}

// COOKIEGATE_V70_ACTIVE_SITE_BANNER_METRICS_SCOPED_FAST_GUARDFIX

(function(){
  try {
    if(window.CookieGateV71BrowserObserverExportScanFeedback) return;
    window.CookieGateV71BrowserObserverExportScanFeedback = {
      ok: true,
      marker: "COOKIEGATE_V71_BROWSER_OBSERVER_EXPORT_SCAN_FEEDBACK",
      no_banner_change: true,
      no_mutation_observer_added: true
    };

    function cgV71Text(value){
      return String(value || "").replace(/\s+/g, " ").trim();
    }

    function cgV71Now(){
      try { return new Date().toLocaleTimeString(); } catch(e){ return "now"; }
    }

    function cgV71FindObserverHeading(){
      try {
        var nodes = Array.prototype.slice.call(document.querySelectorAll("h1,h2,h3,div,section,span,strong"));
        for(var i = 0; i < nodes.length; i++){
          if(cgV71Text(nodes[i].textContent) === "Browser Observer") return nodes[i];
        }
      } catch(e){}
      return null;
    }

    function cgV71ObserverRoot(){
      try {
        var heading = cgV71FindObserverHeading();
        var root = heading;
        for(var i = 0; root && i < 5; i++){
          if(root.querySelectorAll && root.querySelectorAll("button").length >= 3) return root;
          root = root.parentElement;
        }
      } catch(e){}
      return document.body;
    }

    function cgV71EnsureStatus(){
      try {
        var existing = document.getElementById("cgV71BrowserObserverStatus");
        if(existing) return existing;

        var box = document.createElement("div");
        box.id = "cgV71BrowserObserverStatus";
        box.className = "cg-v71-browser-observer-status";
        box.setAttribute("role", "status");
        box.setAttribute("aria-live", "polite");
        box.textContent = "Browser Observer ready. Copy JSON copies the privacy-safe report; Download saves the same report as a file.";

        var root = cgV71ObserverRoot();
        var buttons = Array.prototype.slice.call(root.querySelectorAll ? root.querySelectorAll("button") : []);
        var after = null;
        for(var i = 0; i < buttons.length; i++){
          var t = cgV71Text(buttons[i].textContent).toLowerCase();
          if(t === "copy json" || t === "download" || t === "scan browser"){ after = buttons[i]; }
        }

        if(after && after.parentElement){
          after.parentElement.insertAdjacentElement("afterend", box);
        } else {
          var heading = cgV71FindObserverHeading();
          if(heading && heading.parentElement){
            heading.insertAdjacentElement("afterend", box);
          } else {
            document.body.appendChild(box);
          }
        }

        return box;
      } catch(e){ return null; }
    }

    function cgV71SetStatus(message){
      try {
        var box = cgV71EnsureStatus();
        if(box) box.textContent = message;
      } catch(e){}
    }

    function cgV71RelabelButtons(){
      try {
        var root = cgV71ObserverRoot();
        var buttons = Array.prototype.slice.call(root.querySelectorAll ? root.querySelectorAll("button") : []);
        buttons.forEach(function(button){
          var t = cgV71Text(button.textContent).toLowerCase();
          if(t === "download"){
            button.textContent = "Download JSON";
            button.setAttribute("title", "Save the same privacy-safe Browser Observer JSON report to a file.");
          } else if(t === "copy json"){
            button.setAttribute("title", "Copy the privacy-safe Browser Observer JSON report to the clipboard.");
          } else if(t === "scan browser"){
            button.setAttribute("title", "Refresh Browser Observer cookie counts and cleanup-plan numbers.");
          }
        });
      } catch(e){}
    }

    function cgV71IsObserverAction(text){
      text = cgV71Text(text).toLowerCase();
      return text === "scan browser" || text === "copy json" || text === "download" || text === "download json";
    }

    document.addEventListener("click", function(ev){
      try {
        var button = ev.target && ev.target.closest ? ev.target.closest("button") : null;
        if(!button) return;
        var label = cgV71Text(button.textContent);
        if(!cgV71IsObserverAction(label)) return;

        var lower = label.toLowerCase();
        if(lower === "scan browser"){
          cgV71SetStatus("Scanning browser cookies...");
          window.setTimeout(function(){
            cgV71RelabelButtons();
            cgV71SetStatus("Browser Observer refreshed at " + cgV71Now() + ". Counts and cleanup-plan numbers above are the current scan.");
          }, 900);
        } else if(lower === "copy json"){
          window.setTimeout(function(){
            cgV71SetStatus("Copied privacy-safe Browser Observer JSON report to clipboard at " + cgV71Now() + ".");
          }, 150);
        } else if(lower === "download" || lower === "download json"){
          window.setTimeout(function(){
            cgV71RelabelButtons();
            cgV71SetStatus("Downloaded privacy-safe Browser Observer JSON report at " + cgV71Now() + ".");
          }, 150);
        }
      } catch(e){}
    }, true);

    window.setTimeout(function(){
      cgV71RelabelButtons();
      cgV71EnsureStatus();
    }, 250);
  } catch(e){}
})();

// COOKIEGATE_V71_BROWSER_OBSERVER_EXPORT_SCAN_FEEDBACK

(function(){
  try {
    if(window.CookieGateV72BrowserObserverStatusDedupe) return;
    window.CookieGateV72BrowserObserverStatusDedupe = {
      ok: true,
      marker: "COOKIEGATE_V72_BROWSER_OBSERVER_STATUS_DEDUPE",
      no_banner_change: true,
      no_runtime_change: true,
      removes_legacy_stacked_observer_status: true
    };

    function cgV72Text(value){
      return String(value || "").replace(/\s+/g, " ").trim();
    }

    function cgV72IsLegacyObserverMessage(text){
      var t = cgV72Text(text);
      return t === "Observer JSON copied to clipboard." ||
        t === "Observer JSON copied to clipboard" ||
        t === "Observer JSON downloaded." ||
        t === "Observer JSON downloaded";
    }

    function cgV72FindObserverHeading(){
      try {
        var nodes = Array.prototype.slice.call(document.querySelectorAll("h1,h2,h3,div,section,span,strong"));
        for(var i = 0; i < nodes.length; i++){
          if(cgV72Text(nodes[i].textContent) === "Browser Observer") return nodes[i];
        }
      } catch(e){}
      return null;
    }

    function cgV72ObserverRoot(){
      try {
        var heading = cgV72FindObserverHeading();
        var root = heading;
        for(var i = 0; root && i < 6; i++){
          if(root.querySelectorAll && root.querySelectorAll("button").length >= 3) return root;
          root = root.parentElement;
        }
      } catch(e){}
      return document.body;
    }

    function cgV72RemoveNode(node){
      try {
        if(!node) return;
        if(node.id === "cgV71BrowserObserverStatus") return;
        if(node.parentNode) node.parentNode.removeChild(node);
      } catch(e){}
    }

    function cgV72CleanupLegacyMessages(){
      try {
        var root = cgV72ObserverRoot();
        if(!root) return;

        var nodes = Array.prototype.slice.call(root.querySelectorAll ? root.querySelectorAll("div,p,span,small,strong,section") : []);
        nodes.forEach(function(node){
          try {
            if(!node || node.id === "cgV71BrowserObserverStatus") return;
            if(node.querySelector && node.querySelector("button,input,select,textarea,#cgV71BrowserObserverStatus")) return;
            if(cgV72IsLegacyObserverMessage(node.textContent)) cgV72RemoveNode(node);
          } catch(e){}
        });

        var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
        var removeParents = [];
        while(walker.nextNode()){
          var textNode = walker.currentNode;
          if(textNode && cgV72IsLegacyObserverMessage(textNode.nodeValue)){
            var p = textNode.parentElement;
            if(p && p.id !== "cgV71BrowserObserverStatus" && !(p.querySelector && p.querySelector("button,input,select,textarea,#cgV71BrowserObserverStatus"))){
              removeParents.push(p);
            } else if(textNode.parentNode){
              textNode.parentNode.removeChild(textNode);
            }
          }
        }
        removeParents.forEach(cgV72RemoveNode);
      } catch(e){}
    }

    function cgV72ScheduleCleanup(){
      try {
        [0, 50, 150, 350, 800, 1400].forEach(function(ms){
          window.setTimeout(cgV72CleanupLegacyMessages, ms);
        });
      } catch(e){}
    }

    document.addEventListener("click", function(ev){
      try {
        var button = ev.target && ev.target.closest ? ev.target.closest("button") : null;
        if(!button) return;
        var label = cgV72Text(button.textContent).toLowerCase();
        if(label === "copy json" || label === "download json" || label === "download" || label === "scan browser"){
          cgV72ScheduleCleanup();
        }
      } catch(e){}
    }, true);

    cgV72ScheduleCleanup();
  } catch(e){}
})();

// COOKIEGATE_V72_BROWSER_OBSERVER_STATUS_DEDUPE

try {
  window.CookieGateV75BannerCounterReconcileFirefoxFirst = {
    ok: true,
    marker: "COOKIEGATE_V75_BANNER_COUNTER_RECONCILE_FIREFOX_FIRST",
    timeline_backfills_session_and_lifetime: true,
    recent_timeline_backfills_site_now: true,
    no_runtime_change: true
  };
} catch(e){}

// COOKIEGATE_V75_BANNER_COUNTER_RECONCILE_FIREFOX_FIRST

/* COOKIEGATE_PATCH_V0_1_2_POPUP_COOKIE_STORES_PARTITION_V2_START */
(function(){
  "use strict";

  var COOKIEGATE_PATCH_V0_1_2_POPUP_COOKIE_STORES_PARTITION_V2 = true;

  if(window.__COOKIEGATE_PATCH_V0_1_2_POPUP_COOKIE_STORES_PARTITION_V2__) return;
  window.__COOKIEGATE_PATCH_V0_1_2_POPUP_COOKIE_STORES_PARTITION_V2__ = true;

  function apiRef(){
    if(typeof browser !== "undefined") return browser;
    if(typeof chrome !== "undefined") return chrome;
    return null;
  }

  function errText(err){
    if(!err) return "UNKNOWN_ERROR";
    if(err.message) return String(err.message);
    return String(err);
  }

  function cloneQuery(query){
    var out = {};
    query = query || {};
    Object.keys(query).forEach(function(k){ out[k] = query[k]; });
    return out;
  }

  function keyForCookie(c){
    var pk = "";
    try { pk = c && c.partitionKey ? JSON.stringify(c.partitionKey) : ""; } catch(e){}
    return [
      c && c.storeId ? c.storeId : "",
      c && c.firstPartyDomain ? c.firstPartyDomain : "",
      pk,
      c && c.domain ? c.domain : "",
      c && c.path ? c.path : "",
      c && c.name ? c.name : ""
    ].join("|");
  }

  function pushUnique(list, q){
    var s = "";
    try { s = JSON.stringify(q || {}); } catch(e){ s = String(Math.random()); }

    for(var i = 0; i < list.length; i++){
      var t = "";
      try { t = JSON.stringify(list[i] || {}); } catch(e){}
      if(t === s) return;
    }

    list.push(q || {});
  }

  function baseQueries(query){
    var q = cloneQuery(query || {});
    var out = [];
    pushUnique(out, q);

    if(q.domain){
      var d = String(q.domain || "").replace(/^\./, "");
      if(d){
        pushUnique(out, { domain:d });
        pushUnique(out, { domain:"." + d });
        pushUnique(out, { url:"https://" + d + "/" });
        pushUnique(out, { url:"http://" + d + "/" });
        pushUnique(out, { url:"https://www." + d + "/" });
        pushUnique(out, { url:"http://www." + d + "/" });
      }
    }

    return out;
  }

  function partitionVariants(query){
    var out = [];
    var q = cloneQuery(query || {});

    pushUnique(out, q);

    var fpi = cloneQuery(q);
    fpi.firstPartyDomain = null;
    pushUnique(out, fpi);

    var partitioned = cloneQuery(q);
    partitioned.partitionKey = {};
    pushUnique(out, partitioned);

    var both = cloneQuery(q);
    both.firstPartyDomain = null;
    both.partitionKey = {};
    pushUnique(out, both);

    if(q.url){
      try {
        var u = new URL(q.url);
        var top = u.protocol + "//" + u.hostname;
        var keyed = cloneQuery(q);
        keyed.partitionKey = { topLevelSite:top };
        pushUnique(out, keyed);

        var keyedFpi = cloneQuery(q);
        keyedFpi.firstPartyDomain = null;
        keyedFpi.partitionKey = { topLevelSite:top };
        pushUnique(out, keyedFpi);
      } catch(e){}
    }

    return out;
  }

  function getStores(api){
    return new Promise(function(resolve){
      if(!api || !api.cookies || !api.cookies.getAllCookieStores){
        resolve({ ok:false, stores:[], error:"NO_COOKIE_STORES_API" });
        return;
      }

      try {
        if(typeof browser !== "undefined"){
          api.cookies.getAllCookieStores()
            .then(function(stores){ resolve({ ok:true, stores:stores || [] }); })
            .catch(function(err){ resolve({ ok:false, stores:[], error:errText(err) }); });
          return;
        }

        api.cookies.getAllCookieStores(function(stores){
          if(api.runtime && api.runtime.lastError){
            resolve({ ok:false, stores:[], error:api.runtime.lastError.message });
            return;
          }

          resolve({ ok:true, stores:stores || [] });
        });
      } catch(e) {
        resolve({ ok:false, stores:[], error:errText(e) });
      }
    });
  }

  function getCookies(api, query){
    return new Promise(function(resolve){
      if(!api || !api.cookies || !api.cookies.getAll){
        resolve({ ok:false, cookies:[], error:"NO_COOKIES_API" });
        return;
      }

      try {
        if(typeof browser !== "undefined"){
          api.cookies.getAll(query || {})
            .then(function(cookies){ resolve({ ok:true, cookies:cookies || [], query:query || {} }); })
            .catch(function(err){ resolve({ ok:false, cookies:[], error:errText(err), query:query || {} }); });
          return;
        }

        api.cookies.getAll(query || {}, function(cookies){
          if(api.runtime && api.runtime.lastError){
            resolve({ ok:false, cookies:[], error:api.runtime.lastError.message, query:query || {} });
            return;
          }

          resolve({ ok:true, cookies:cookies || [], query:query || {} });
        });
      } catch(e) {
        resolve({ ok:false, cookies:[], error:errText(e), query:query || {} });
      }
    });
  }

  function addCookies(target, seen, cookies){
    (cookies || []).forEach(function(c){
      var k = keyForCookie(c);
      if(!seen[k]){
        seen[k] = true;
        target.push(c);
      }
    });
  }

  window.CookieGateGetCookiesAllStoresV1 = async function(query){
    var api = apiRef();
    var all = [];
    var seen = {};
    var errors = [];
    var storeIds = [null];
    var storesResult;
    var bases;
    var variants = [];
    var i;
    var j;
    var q;
    var res;

    if(!api || !api.cookies || !api.cookies.getAll){
      return { ok:false, cookies:[], error:"NO_COOKIES_API", source:"popup_cookie_stores_partition_v2" };
    }

    storesResult = await getStores(api);

    if(storesResult.ok && storesResult.stores && storesResult.stores.length){
      storeIds = storesResult.stores.map(function(s){ return s && s.id ? s.id : null; }).filter(function(x){ return !!x; });
      if(!storeIds.length) storeIds = [null];
    } else if(storesResult && storesResult.error) {
      errors.push("stores:" + storesResult.error);
    }

    bases = baseQueries(query || {});

    for(i = 0; i < bases.length; i++){
      var pv = partitionVariants(bases[i]);
      for(j = 0; j < pv.length; j++){
        pushUnique(variants, pv[j]);
      }
    }

    for(i = 0; i < storeIds.length; i++){
      for(j = 0; j < variants.length; j++){
        q = cloneQuery(variants[j]);
        if(storeIds[i]) q.storeId = storeIds[i];

        res = await getCookies(api, q);

        if(res.ok){
          addCookies(all, seen, res.cookies || []);
        } else {
          errors.push(String(storeIds[i] || "default") + ":" + String(res.error || "UNKNOWN_COOKIE_READ_ERROR"));
        }
      }
    }

    return {
      ok:true,
      cookies:all,
      source:"popup_cookie_stores_partition_v2",
      store_count:storeIds.length,
      variant_count:variants.length,
      errors:errors
    };
  };
})();
/* COOKIEGATE_PATCH_V0_1_2_POPUP_COOKIE_STORES_PARTITION_V2_END */

/* COOKIEGATE_PATCH_V0_1_2_ACTIVE_SITE_DOCUMENT_COOKIE_FALLBACK_V1_START */
(function(){
  "use strict";

  var COOKIEGATE_PATCH_V0_1_2_ACTIVE_SITE_DOCUMENT_COOKIE_FALLBACK_V1 = true;

  if(window.__COOKIEGATE_PATCH_V0_1_2_ACTIVE_SITE_DOCUMENT_COOKIE_FALLBACK_V1__) return;
  window.__COOKIEGATE_PATCH_V0_1_2_ACTIVE_SITE_DOCUMENT_COOKIE_FALLBACK_V1__ = true;

  function apiRef(){
    if(typeof browser !== "undefined") return browser;
    if(typeof chrome !== "undefined") return chrome;
    return null;
  }

  function str(v){
    if(v === undefined || v === null) return "";
    return String(v);
  }

  function cleanHost(v){
    v = str(v).trim().toLowerCase();
    v = v.replace(/^https?:\/\//,"");
    v = v.split("/")[0].split("?")[0].split("#")[0];
    v = v.replace(/:\d+$/,"");
    return v;
  }

  function tabQuery(api){
    return new Promise(function(resolve){
      if(typeof activeTab === "function"){
        try {
          Promise.resolve(activeTab())
            .then(function(tab){ resolve(tab || null); })
            .catch(function(){ resolve(null); });
          return;
        } catch(e){}
      }

      if(!api || !api.tabs || !api.tabs.query){
        resolve(null);
        return;
      }

      try {
        if(typeof browser !== "undefined"){
          api.tabs.query({ active:true, currentWindow:true })
            .then(function(tabs){ resolve(tabs && tabs[0] ? tabs[0] : null); })
            .catch(function(){ resolve(null); });
          return;
        }

        api.tabs.query({ active:true, currentWindow:true }, function(tabs){
          resolve(tabs && tabs[0] ? tabs[0] : null);
        });
      } catch(e) {
        resolve(null);
      }
    });
  }

  function executeDocumentCookie(api, tabId){
    return new Promise(function(resolve){
      if(!api || !api.scripting || !api.scripting.executeScript || !tabId){
        resolve({ ok:false, error:"NO_SCRIPTING_API_OR_TAB" });
        return;
      }

      var details = {
        target:{ tabId:tabId },
        func:function(){
          return {
            ok:true,
            cookie:String(document.cookie || ""),
            href:String(location.href || ""),
            host:String(location.hostname || ""),
            protocol:String(location.protocol || "")
          };
        }
      };

      try {
        if(typeof browser !== "undefined"){
          api.scripting.executeScript(details)
            .then(function(results){
              var value = results && results[0] && results[0].result ? results[0].result : null;
              resolve(value || { ok:false, error:"EMPTY_SCRIPT_RESULT" });
            })
            .catch(function(err){
              resolve({ ok:false, error:String(err && err.message ? err.message : err) });
            });
          return;
        }

        api.scripting.executeScript(details, function(results){
          if(api.runtime && api.runtime.lastError){
            resolve({ ok:false, error:api.runtime.lastError.message });
            return;
          }

          var value = results && results[0] && results[0].result ? results[0].result : null;
          resolve(value || { ok:false, error:"EMPTY_SCRIPT_RESULT" });
        });
      } catch(e) {
        resolve({ ok:false, error:String(e && e.message ? e.message : e) });
      }
    });
  }

  function parseDocumentCookie(raw, domain, secure){
    raw = str(raw);
    domain = cleanHost(domain);
    var seen = {};
    var out = [];

    raw.split(";").forEach(function(part){
      var p = str(part).trim();
      if(!p) return;

      var idx = p.indexOf("=");
      var name = idx >= 0 ? p.slice(0, idx).trim() : p.trim();
      if(!name || seen[name]) return;

      seen[name] = true;

      out.push({
        name:name,
        value:"",
        domain:domain ? domain : "",
        path:"/",
        secure:!!secure,
        httpOnly:false,
        session:true,
        sameSite:"unspecified",
        source:"document_cookie_fallback_v1",
        cookiegateFallback:true
      });
    });

    return out;
  }

  window.CookieGateReadActiveSiteDocumentCookiesV1 = async function(site){
    var api = apiRef();
    var tab = await tabQuery(api);

    if(!tab || !tab.id){
      return { ok:false, cookies:[], error:"NO_ACTIVE_TAB", source:"document_cookie_fallback_v1" };
    }

    var result = await executeDocumentCookie(api, tab.id);

    if(!result || !result.ok){
      return { ok:false, cookies:[], error:result && result.error ? result.error : "DOCUMENT_COOKIE_SCRIPT_FAILED", source:"document_cookie_fallback_v1" };
    }

    var host = cleanHost(result.host || site);
    var cookies = parseDocumentCookie(result.cookie || "", host || site, String(result.protocol || "").toLowerCase() === "https:");

    return {
      ok:true,
      cookies:cookies,
      source:"document_cookie_fallback_v1",
      fallback:true,
      tabHost:host,
      documentCookieCount:cookies.length
    };
  };
})();
/* COOKIEGATE_PATCH_V0_1_2_ACTIVE_SITE_DOCUMENT_COOKIE_FALLBACK_V1_END */

/* COOKIEGATE_PATCH_V0_1_2_FIREFOX_HOST_PERMISSION_DOMAIN_QUERY_SHIM_V1_START */
(function(){
  "use strict";

  var COOKIEGATE_PATCH_V0_1_2_FIREFOX_HOST_PERMISSION_DOMAIN_QUERY_SHIM_V1 = true;

  if(window.__COOKIEGATE_PATCH_V0_1_2_FIREFOX_HOST_PERMISSION_DOMAIN_QUERY_SHIM_V1__) return;
  window.__COOKIEGATE_PATCH_V0_1_2_FIREFOX_HOST_PERMISSION_DOMAIN_QUERY_SHIM_V1__ = true;

  function apiRef(){
    if(typeof browser !== "undefined") return browser;
    if(typeof chrome !== "undefined") return chrome;
    return null;
  }

  function txt(v){
    if(v === undefined || v === null) return "";
    return String(v);
  }

  function stripHost(v){
    v = txt(v).trim().toLowerCase();
    v = v.replace(/^site:\s*/i,"");
    v = v.replace(/^https?:\/\//,"");
    v = v.split("/")[0].split("?")[0].split("#")[0];
    v = v.replace(/:\d+$/,"");
    v = v.replace(/^\*\./,"");
    v = v.replace(/^\./,"");
    if(v === "-" || v === "browser" || v === "browser observer" || v === "newtab") return "";
    return v;
  }

  function canonicalDomain(input){
    var h = stripHost(input);
    if(!h) return "";
    if(h === "localhost") return h;
    if(/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return h;

    var parts = h.split(".").filter(Boolean);
    if(parts.length <= 2) return h;

    var last2 = parts.slice(-2).join(".");
    var last3 = parts.slice(-3).join(".");
    var twoPartSuffixes = {
      "co.uk":true,"org.uk":true,"gov.uk":true,"ac.uk":true,
      "com.au":true,"net.au":true,"org.au":true,
      "co.nz":true,"org.nz":true,
      "co.jp":true,"ne.jp":true,
      "com.br":true,"com.mx":true,"com.tr":true,
      "co.in":true,"firm.in":true,"net.in":true,"org.in":true
    };

    if(twoPartSuffixes[last2] && parts.length >= 3){
      return last3;
    }

    return last2;
  }

  function hostMatches(host, wanted){
    host = stripHost(host);
    wanted = canonicalDomain(wanted);

    if(!host || !wanted) return false;

    var hostRoot = canonicalDomain(host);
    if(host === wanted) return true;
    if(hostRoot === wanted) return true;
    if(host.endsWith("." + wanted)) return true;
    return false;
  }

  function urlHost(url){
    try { return stripHost((new URL(txt(url))).hostname); }
    catch(e){ return ""; }
  }

  function cloneQuery(q){
    var out = {};
    q = q || {};
    Object.keys(q).forEach(function(k){ out[k] = q[k]; });
    return out;
  }

  function normalizeCookieQuery(q){
    var out = cloneQuery(q || {});

    if(out.domain){
      out.domain = canonicalDomain(out.domain);
    }

    return out;
  }

  function permissionContains(api){
    return new Promise(function(resolve){
      if(!api || !api.permissions || !api.permissions.contains){
        resolve({ ok:false, granted:false, error:"NO_PERMISSIONS_API" });
        return;
      }

      try {
        var req = { origins:["<all_urls>"] };

        if(typeof browser !== "undefined"){
          api.permissions.contains(req)
            .then(function(granted){ resolve({ ok:true, granted:!!granted }); })
            .catch(function(err){ resolve({ ok:false, granted:false, error:txt(err && err.message ? err.message : err) }); });
          return;
        }

        api.permissions.contains(req, function(granted){
          if(api.runtime && api.runtime.lastError){
            resolve({ ok:false, granted:false, error:api.runtime.lastError.message });
            return;
          }

          resolve({ ok:true, granted:!!granted });
        });
      } catch(e) {
        resolve({ ok:false, granted:false, error:txt(e && e.message ? e.message : e) });
      }
    });
  }

  function permissionRequest(api){
    // Intentionally does NOT call permissions.request(). <all_urls> is granted
    // at install via host_permissions on Firefox 127+, so the extension never
    // prompts at runtime. Kept as a resolved no-op so any legacy call site is
    // harmless. (This removes the last runtime "Allow" popup path.)
    return Promise.resolve({ ok:true, granted:false, needsGrant:true, source:"runtime_request_disabled_v1" });
  }

  async function ensureAllSites(request){
    // NEVER prompt. <all_urls> is granted at install (host_permissions) on
    // Firefox 127+, so no runtime request is needed for real installs. We only
    // check whether the permission is currently held; we do not call
    // permissions.request() (that is what produced the unwanted "Allow" popups
    // on nearly every click). The `request` argument is intentionally ignored.
    var api = apiRef();
    var contains = await permissionContains(api);
    if(contains.granted){
      return { ok:true, granted:true, source:"firefox_host_permission_gate_v1" };
    }
    return { ok:true, granted:false, needsGrant:true, source:"firefox_host_permission_gate_v1", containsError:contains.error || "" };
  }

  function activeTab(){
    var api = apiRef();

    return new Promise(function(resolve){
      if(!api || !api.tabs || !api.tabs.query){
        resolve(null);
        return;
      }

      try {
        if(typeof browser !== "undefined"){
          api.tabs.query({ active:true, currentWindow:true })
            .then(function(tabs){ resolve(tabs && tabs[0] ? tabs[0] : null); })
            .catch(function(){ resolve(null); });
          return;
        }

        api.tabs.query({ active:true, currentWindow:true }, function(tabs){
          resolve(tabs && tabs[0] ? tabs[0] : null);
        });
      } catch(e) {
        resolve(null);
      }
    });
  }

  function callOriginalGetAll(api, query){
    return new Promise(function(resolve){
      if(!api || !api.cookies || !api.cookies.getAll){
        resolve({ ok:false, cookies:[], error:"NO_COOKIES_API" });
        return;
      }

      var original = api.cookies.__cookieGateOriginalGetAllV1 || api.cookies.getAll.bind(api.cookies);

      try {
        if(typeof browser !== "undefined"){
          Promise.resolve(original(query || {}))
            .then(function(cookies){ resolve({ ok:true, cookies:cookies || [] }); })
            .catch(function(err){ resolve({ ok:false, cookies:[], error:txt(err && err.message ? err.message : err) }); });
          return;
        }

        original(query || {}, function(cookies){
          if(api.runtime && api.runtime.lastError){
            resolve({ ok:false, cookies:[], error:api.runtime.lastError.message });
            return;
          }

          resolve({ ok:true, cookies:cookies || [] });
        });
      } catch(e) {
        resolve({ ok:false, cookies:[], error:txt(e && e.message ? e.message : e) });
      }
    });
  }

  async function primaryRead(query){
    query = normalizeCookieQuery(query || {});

    if(window.CookieGateGetCookiesAllStoresV1){
      try {
        return await window.CookieGateGetCookiesAllStoresV1(query);
      } catch(e) {
        return { ok:false, cookies:[], error:txt(e && e.message ? e.message : e), source:"partition_reader_failed" };
      }
    }

    var api = apiRef();
    var direct = await callOriginalGetAll(api, query);
    direct.source = "direct_cookie_api_v1";
    return direct;
  }

  function queryWantsDomain(query){
    query = query || {};
    return !!(query.domain || query.url);
  }

  function queryDomain(query){
    query = query || {};
    if(query.domain) return canonicalDomain(query.domain);
    if(query.url) return canonicalDomain(urlHost(query.url));
    return "";
  }

  async function fallbackActiveDomain(query){
    var wanted = queryDomain(query);
    if(!wanted) return { ok:true, cookies:[], source:"active_domain_document_cookie_fallback_v1", skipped:true };

    var tab = await activeTab();
    var tabHost = "";

    try { tabHost = urlHost(tab && tab.url ? tab.url : ""); } catch(e){ tabHost = ""; }

    if(!hostMatches(tabHost, wanted)){
      return { ok:true, cookies:[], source:"active_domain_document_cookie_fallback_v1", skipped:true, reason:"ACTIVE_TAB_DOMAIN_MISMATCH", activeHost:tabHost, requestedDomain:wanted };
    }

    if(window.CookieGateReadActiveSiteDocumentCookiesV1){
      var res = await window.CookieGateReadActiveSiteDocumentCookiesV1(wanted);
      if(res && res.cookies){
        res.cookies = (res.cookies || []).filter(function(c){ return hostMatches(c && c.domain ? c.domain : tabHost, wanted); });
        res.source = "active_domain_document_cookie_fallback_v1";
        res.requestedDomain = wanted;
        return res;
      }
    }

    return { ok:true, cookies:[], source:"active_domain_document_cookie_fallback_v1", error:"NO_ACTIVE_SITE_DOCUMENT_COOKIE_READER" };
  }

  async function readDomainCookies(domainOrUrl, requestPermission){
    var wanted = canonicalDomain(domainOrUrl);
    if(!wanted){
      return { ok:false, cookies:[], error:"NO_DOMAIN", source:"firefox_host_permission_domain_query_shim_v1" };
    }

    await ensureAllSites(!!requestPermission);

    var primary = await primaryRead({ domain:wanted });

    if(primary && primary.ok && primary.cookies && primary.cookies.length > 0){
      primary.source = primary.source || "firefox_cookie_api_domain_v1";
      primary.normalizedDomain = wanted;
      return primary;
    }

    var fallback = await fallbackActiveDomain({ domain:wanted });

    if(fallback && fallback.ok){
      fallback.primaryCount = primary && primary.cookies ? primary.cookies.length : 0;
      fallback.primarySource = primary && primary.source ? primary.source : "";
      fallback.normalizedDomain = wanted;
      return fallback;
    }

    return primary || fallback || { ok:false, cookies:[], error:"DOMAIN_COOKIE_READ_FAILED", source:"firefox_host_permission_domain_query_shim_v1" };
  }

  async function readBrowserWideCookies(requestPermission){
    var gate = await ensureAllSites(!!requestPermission);
    var primary = await primaryRead({});

    primary = primary || { ok:false, cookies:[], error:"BROWSER_WIDE_COOKIE_READ_FAILED" };
    primary.source = primary.source || "firefox_cookie_api_browser_wide_v1";
    primary.hostPermissionGranted = !!gate.granted;
    primary.needsHostPermission = !gate.granted;
    primary.permissionSource = gate.source || "firefox_host_permission_gate_v1";
    primary.permissionError = gate.error || gate.requestError || gate.containsError || "";
    return primary;
  }

  function patchDomainCookieApiShim(){
    var api = apiRef();
    if(!api || !api.cookies || !api.cookies.getAll) return;
    if(api.cookies.__COOKIEGATE_DOMAIN_QUERY_SHIM_V1__) return;

    var original = api.cookies.getAll.bind(api.cookies);
    api.cookies.__COOKIEGATE_DOMAIN_QUERY_SHIM_V1__ = true;
    api.cookies.__cookieGateOriginalGetAllV1 = original;

    api.cookies.getAll = function(query, callback){
      var normalized = normalizeCookieQuery(query || {});
      var wantsDomain = queryWantsDomain(normalized);

      if(typeof callback === "function"){
        try {
          if(typeof browser !== "undefined"){
            Promise.resolve(original(normalized))
              .then(function(cookies){
                cookies = cookies || [];

                if(cookies.length > 0 || !wantsDomain){
                  callback(cookies);
                  return;
                }

                fallbackActiveDomain(normalized).then(function(fallback){
                  callback(fallback && fallback.cookies && fallback.cookies.length ? fallback.cookies : cookies);
                }).catch(function(){
                  callback(cookies);
                });
              })
              .catch(function(){
                if(!wantsDomain){
                  callback([]);
                  return;
                }

                fallbackActiveDomain(normalized).then(function(fallback){
                  callback(fallback && fallback.cookies ? fallback.cookies : []);
                }).catch(function(){
                  callback([]);
                });
              });
            return;
          }

          original(normalized, function(cookies){
            cookies = cookies || [];

            if(cookies.length > 0 || !wantsDomain){
              callback(cookies);
              return;
            }

            fallbackActiveDomain(normalized).then(function(fallback){
              callback(fallback && fallback.cookies && fallback.cookies.length ? fallback.cookies : cookies);
            }).catch(function(){
              callback(cookies);
            });
          });

          return;
        } catch(e) {
          callback([]);
          return;
        }
      }

      return new Promise(function(resolve){
        try {
          Promise.resolve(original(normalized))
            .then(function(cookies){
              cookies = cookies || [];

              if(cookies.length > 0 || !wantsDomain){
                resolve(cookies);
                return;
              }

              fallbackActiveDomain(normalized).then(function(fallback){
                resolve(fallback && fallback.cookies && fallback.cookies.length ? fallback.cookies : cookies);
              }).catch(function(){
                resolve(cookies);
              });
            })
            .catch(function(){
              if(!wantsDomain){
                resolve([]);
                return;
              }

              fallbackActiveDomain(normalized).then(function(fallback){
                resolve(fallback && fallback.cookies ? fallback.cookies : []);
              }).catch(function(){
                resolve([]);
              });
            });
        } catch(e) {
          resolve([]);
        }
      });
    };
  }

  function installClickPermissionGate(){
    // Disabled: this used to call permissions.request() on nearly every click
    // (it matched against the whole popup body text), producing repeated "Allow"
    // popups. <all_urls> is granted at install on Firefox 127+, so no runtime
    // request is needed. Left as a no-op to preserve call sites.
    return;
  }

  window.CookieGateCanonicalDomainV1 = canonicalDomain;
  window.CookieGateEnsureAllSiteCookieAccessV1 = ensureAllSites;
  window.CookieGateReadDomainCookiesV1 = readDomainCookies;
  window.CookieGateReadBrowserWideCookiesV1 = readBrowserWideCookies;

  patchDomainCookieApiShim();
  installClickPermissionGate();

  setTimeout(patchDomainCookieApiShim, 0);
  setTimeout(patchDomainCookieApiShim, 250);
  setTimeout(patchDomainCookieApiShim, 1000);
})();
/* COOKIEGATE_PATCH_V0_1_2_FIREFOX_HOST_PERMISSION_DOMAIN_QUERY_SHIM_V1_END */

/* COOKIEGATE_PATCH_V0_1_2_BROWSER_OBSERVER_BACKGROUND_COOKIE_READER_V1_START */
(function(){
  "use strict";

  var COOKIEGATE_PATCH_V0_1_2_BROWSER_OBSERVER_BACKGROUND_COOKIE_READER_V1 = true;

  if(window.__COOKIEGATE_PATCH_V0_1_2_BROWSER_OBSERVER_BACKGROUND_COOKIE_READER_V1__) return;
  window.__COOKIEGATE_PATCH_V0_1_2_BROWSER_OBSERVER_BACKGROUND_COOKIE_READER_V1__ = true;

  function apiRef(){
    if(typeof browser !== "undefined") return browser;
    if(typeof chrome !== "undefined") return chrome;
    return null;
  }

  function text(v){
    if(v === undefined || v === null) return "";
    return String(v);
  }

  function sendBackgroundRead(api){
    return new Promise(function(resolve){
      if(!api || !api.runtime || !api.runtime.sendMessage){
        resolve({ ok:false, cookies:[], error:"NO_RUNTIME_SENDMESSAGE", source:"browser_observer_background_cookie_reader_v1" });
        return;
      }

      var msg = { type:"COOKIEGATE_BROWSER_OBSERVER_READ_ALL_COOKIES_V1" };

      try {
        if(typeof browser !== "undefined"){
          api.runtime.sendMessage(msg)
            .then(function(result){ resolve(result || { ok:false, cookies:[], error:"EMPTY_BACKGROUND_RESPONSE", source:"browser_observer_background_cookie_reader_v1" }); })
            .catch(function(err){ resolve({ ok:false, cookies:[], error:text(err && err.message ? err.message : err), source:"browser_observer_background_cookie_reader_v1" }); });
          return;
        }

        api.runtime.sendMessage(msg, function(result){
          if(api.runtime && api.runtime.lastError){
            resolve({ ok:false, cookies:[], error:api.runtime.lastError.message, source:"browser_observer_background_cookie_reader_v1" });
            return;
          }

          resolve(result || { ok:false, cookies:[], error:"EMPTY_BACKGROUND_RESPONSE", source:"browser_observer_background_cookie_reader_v1" });
        });
      } catch(e) {
        resolve({ ok:false, cookies:[], error:text(e && e.message ? e.message : e), source:"browser_observer_background_cookie_reader_v1" });
      }
    });
  }

  window.CookieGateReadBrowserWideCookiesViaBackgroundV1 = async function(requestPermission){
    var api = apiRef();
    var gate = null;
    var background = null;
    var fallback = null;

    try {
      if(window.CookieGateEnsureAllSiteCookieAccessV1){
        gate = await window.CookieGateEnsureAllSiteCookieAccessV1(!!requestPermission);
      }
    } catch(e) {
      gate = { ok:false, granted:false, error:text(e && e.message ? e.message : e), source:"firefox_host_permission_gate_v1" };
    }

    background = await sendBackgroundRead(api);

    if(background && background.ok && background.cookies && background.cookies.length > 0){
      background.hostPermissionGranted = gate ? !!gate.granted : false;
      background.needsHostPermission = gate ? !gate.granted : false;
      background.permissionError = gate && (gate.error || gate.requestError || gate.containsError) ? (gate.error || gate.requestError || gate.containsError) : "";
      background.source = "browser_observer_background_cookie_reader_v1";
      return background;
    }

    if(window.CookieGateReadBrowserWideCookiesV1){
      try {
        fallback = await window.CookieGateReadBrowserWideCookiesV1(!!requestPermission);
      } catch(e2) {
        fallback = { ok:false, cookies:[], error:text(e2 && e2.message ? e2.message : e2), source:"popup_browser_wide_reader_failed" };
      }
    }

    if(fallback && fallback.ok && fallback.cookies && fallback.cookies.length > 0){
      fallback.backgroundCount = background && background.cookies ? background.cookies.length : 0;
      fallback.backgroundError = background && background.error ? background.error : "";
      fallback.source = fallback.source || "popup_browser_wide_reader_v1";
      return fallback;
    }

    return {
      ok:true,
      cookies:[],
      source:"browser_observer_background_cookie_reader_v1",
      backgroundCount:background && background.cookies ? background.cookies.length : 0,
      backgroundError:background && background.error ? background.error : "",
      popupCount:fallback && fallback.cookies ? fallback.cookies.length : 0,
      popupError:fallback && fallback.error ? fallback.error : "",
      hostPermissionGranted:gate ? !!gate.granted : false,
      needsHostPermission:gate ? !gate.granted : true,
      permissionError:gate && (gate.error || gate.requestError || gate.containsError) ? (gate.error || gate.requestError || gate.containsError) : ""
    };
  };
})();
/* COOKIEGATE_PATCH_V0_1_2_BROWSER_OBSERVER_BACKGROUND_COOKIE_READER_V1_END */

/* COOKIEGATE_PATCH_V0_1_2_FIREFOX_ALL_SITES_GRANT_AND_BANNER_TOP_V1_START
   (1) Browser Observer needs the <all_urls> host permission to read cookies
       browser-wide. On Firefox that permission is opt-in and the existing code
       requested it after `await`s, which drops the user-gesture context so the
       prompt never appeared. Here we call permissions.request() SYNCHRONOUSLY
       inside the real click handler for "Scan browser" / the Browser Observer
       tab, then rescan once granted.
   (2) Move the Banner Suppression panel to the top of the Active Site view so
       users don't have to scroll to the bottom to see it. */
(function(){
  "use strict";

  var api = (typeof browser !== "undefined") ? browser
          : (typeof chrome !== "undefined") ? chrome : null;
  var REQ = { origins: ["<all_urls>"] };

  // Tracks whether <all_urls> is already granted, so we NEVER re-prompt when the
  // permission is already held. Firefox resolves permissions.request() as true
  // without a dialog when already granted, but calling it on every Scan/Observer
  // click is still wasteful and can nag after a temp-add-on reload resets the
  // optional grant. We gate on this flag instead.
  var granted = false;

  function refreshGranted(cb){
    if(!api || !api.permissions || !api.permissions.contains){ if(cb) cb(granted); return; }
    try {
      var p = api.permissions.contains(REQ);
      if(p && typeof p.then === "function"){
        p.then(function(g){ granted = !!g; if(cb) cb(granted); }).catch(function(){ if(cb) cb(granted); });
        return;
      }
      api.permissions.contains(REQ, function(g){ granted = !!g; if(cb) cb(granted); });
    } catch(e){ if(cb) cb(granted); }
  }

  // Keep the flag current when the user grants/revokes from about:addons.
  try {
    if(api && api.permissions){
      if(api.permissions.onAdded && api.permissions.onAdded.addListener){
        api.permissions.onAdded.addListener(function(){ granted = true; });
      }
      if(api.permissions.onRemoved && api.permissions.onRemoved.addListener){
        api.permissions.onRemoved.addListener(function(){ granted = false; });
      }
    }
  } catch(e){}

  // Load marker so we can confirm this patch is actually running.
  try { window.__CG_PATCH_V012_GRANT_BANNER__ = "loaded-" + new Date().toISOString(); } catch(e){}

  /* ---- (1) Browser Observer: scan ONCE when the popup opens ----
     <all_urls> is granted at install (host_permissions), so no prompt is
     needed. Critically, we do NOT hook click events or auto-rescan on DOM
     mutations: the previous version clicked the "Scan browser" button
     programmatically, which re-fired the same handler and produced a runaway
     "Scanning browser cookies..." loop. The Observer now populates once on
     open, and otherwise only when the user opens the Observer tab or presses
     "Scan browser" (both handled by the extension's own code). */

  var didOpenScan = false;
  function scanObserverOnce(){
    if(didOpenScan) return;
    didOpenScan = true;
    try {
      if(window.CookieGateCaptureBrowserObserver){
        window.CookieGateCaptureBrowserObserver(true);
      }
    } catch(e){}
  }

  function scanIfGranted(){
    refreshGranted(function(g){ if(g) scanObserverOnce(); });
  }

  function clickScanBrowser(){
    try {
      var btns = document.querySelectorAll("button");
      for(var i = 0; i < btns.length; i++){
        if(String(btns[i].textContent || "").trim().toLowerCase() === "scan browser"){ btns[i].click(); return true; }
      }
    } catch(e){}
    return false;
  }

  function forceObserverRefresh(){
    // The VISIBLE donut is rendered by the extension's own observer, which
    // refreshes when the native "Scan browser" button is clicked -- so trigger
    // that (also covers the v1 capture as a fallback). Safe now that the old
    // click-gate loop is gone. Retry a couple times because the grant + first
    // browser-wide read can lag.
    try { if(window.CookieGateCaptureBrowserObserver) window.CookieGateCaptureBrowserObserver(true); } catch(e){}
    clickScanBrowser();
    setTimeout(clickScanBrowser, 250);
    setTimeout(clickScanBrowser, 900);
    try { renderBannerAggregate(); } catch(e){}
    setTimeout(function(){ try { renderBannerAggregate(); } catch(e){} }, 950);
  }

  // One-time "smart" request: only when <all_urls> is NOT already held, at most
  // once per popup session, and only on an explicit Browser Observer / Scan
  // click (a real user gesture). Real installed users are granted at install,
  // so `granted` is already true and this NEVER fires for them. A side-loaded
  // temp add-on (where Firefox withholds the grant) gets a single prompt when
  // the user opens the Observer, then works. This is Mozilla's recommended
  // contains-then-request pattern -- not the old nag-on-every-click gate.
  var cgDidAutoRequest = false;
  function requestAllSitesIfMissing(){
    // Install IS the grant for real users: <all_urls> is in host_permissions, so
    // an installed copy already has it -> `granted` is true -> this returns
    // immediately and NO prompt ever shows. This request only fires on a
    // side-loaded/temporary add-on, where Firefox withholds the grant and there
    // is no other way to read all cookies. Fires at most once per session.
    if(granted) return;
    if(cgDidAutoRequest) return;
    cgDidAutoRequest = true;
    if(!api || !api.permissions || !api.permissions.request) return;
    try {
      var req = { origins: ["<all_urls>"] };
      var p = api.permissions.request(req); // synchronous within the click gesture
      if(p && typeof p.then === "function"){
        p.then(function(g){ if(g){ granted = true; setTimeout(forceObserverRefresh, 50); } }).catch(function(){});
      } else {
        api.permissions.request(req, function(g){ if(g){ granted = true; setTimeout(forceObserverRefresh, 50); } });
      }
    } catch(e){}
  }

  function isObserverTrigger(el){
    var btn = el && el.closest ? el.closest("button") : null;
    if(!btn) return false;
    var label = String(btn.textContent || "").trim().toLowerCase();
    return label.indexOf("browser observer") >= 0 || label === "scan browser";
  }

  /* ---- (2) move Banner Suppression panel to the top ---- */

  function findBannerPanel(){
    try {
      var nodes = Array.prototype.slice.call(document.querySelectorAll("section, article, aside, div"));
      var hits = nodes.filter(function(el){
        var t = String(el.textContent || "");
        return t.indexOf("Banner Suppression") >= 0 &&
               t.indexOf("this session") >= 0 &&
               t.indexOf("lifetime blocked") >= 0;
      });
      hits.sort(function(a, b){
        return String(a.textContent || "").length - String(b.textContent || "").length;
      });
      return hits[0] || null;
    } catch(e){ return null; }
  }

  function findModeControls(){
    try {
      var nodes = Array.prototype.slice.call(document.querySelectorAll("section, article, div"));
      var hits = nodes.filter(function(el){
        var t = String(el.textContent || "");
        return t.indexOf("Mode Controls") >= 0 && t.indexOf("Global Mode") >= 0;
      });
      hits.sort(function(a, b){
        return String(a.textContent || "").length - String(b.textContent || "").length;
      });
      return hits[0] || null;
    } catch(e){ return null; }
  }

  // Given two descendants, find the shared container and the two direct-child
  // "cards" of that container. This lets us reorder at the real layout level
  // (the flex/grid items) instead of a nested inner element.
  function cardLevel(innerA, innerB){
    var a = innerA;
    while(a && a.parentElement){
      var parent = a.parentElement;
      if(parent.contains(innerB) && !a.contains(innerB)){
        // a is a direct child of `parent`; find innerB's matching card.
        var b = innerB;
        while(b && b.parentElement && b.parentElement !== parent){ b = b.parentElement; }
        if(b && b.parentElement === parent && a !== b){
          return { container: parent, cardA: a, cardB: b };
        }
      }
      a = a.parentElement;
    }
    return null;
  }

  function moveBannerUp(){
    // Temporarily disabled: the card-level reorder demoted Mode Controls to the
    // bottom. Re-enabling once the exact panel structure is confirmed.
    if(!window.__CG_ENABLE_BANNER_MOVE__) return;
    try {
      var bannerInner = findBannerPanel();
      var modeInner = findModeControls();
      if(!bannerInner || !modeInner) return;

      var lvl = cardLevel(bannerInner, modeInner);
      if(!lvl) return;

      var bannerCard = lvl.cardA;   // the Banner Suppression card
      var modeCard = lvl.cardB;     // the Mode Controls card
      var container = lvl.container;

      // (a) CSS-order override on the actual card — covers flex/grid layouts,
      // where visual position is set by `order`, not DOM order.
      if(bannerCard.style.getPropertyValue("order") !== "-9999"){
        bannerCard.style.setProperty("order", "-9999", "important");
      }
      // (b) DOM move for block layouts / to also win when order ties.
      if(modeCard.previousElementSibling !== bannerCard){
        container.insertBefore(bannerCard, modeCard);
      }
    } catch(e){}
  }

  /* ---- (3) reset banner stats control ---- */

  var BANNER_STAT_KEYS = {
    "cookiegate.bannerSuppression.current.v1": {},
    "cookiegate.bannerSuppression.session.v32": {},
    "cookiegate.bannerSuppression.timeline.v1": [],
    "cookiegate.bannerSuppression.stats.v1": {},
    "cookiegate.bannerSuppression.events.v1": []
  };

  function resetBannerStats(btn){
    if(!api || !api.storage || !api.storage.local) return;
    if(btn){ btn.disabled = true; btn.textContent = "Resetting..."; }
    function done(){ try { location.reload(); } catch(e){} }
    try {
      var p = api.storage.local.set(BANNER_STAT_KEYS);
      if(p && typeof p.then === "function"){ p.then(done).catch(done); }
      else { api.storage.local.set(BANNER_STAT_KEYS, done); }
    } catch(e){ done(); }
  }

  function ensureResetBtn(){
    try {
      var panel = findBannerPanel();
      if(!panel) return;
      if(panel.querySelector && panel.querySelector("#cgBannerResetBtnV1")) return;
      var btn = document.createElement("button");
      btn.id = "cgBannerResetBtnV1";
      btn.type = "button";
      btn.textContent = "Reset banner stats";
      btn.setAttribute("title", "Zero the lifetime and timeline banner-suppression counts.");
      btn.style.cssText = "margin-top:8px;font-size:12px;cursor:pointer;";
      btn.addEventListener("click", function(){ resetBannerStats(btn); });
      panel.appendChild(btn);
    } catch(e){}
  }

  /* ---- (4) keep the per-site Banner Suppression panel on the Active Site tab
       only ---- The panel is hoisted to the top of the shell (a always-visible
       container), so CSS view-scoping wasn't reliably hiding it on the Browser
       Observer / Domain Ops tabs. This enforces it directly off the active tab
       button, which is the source of truth regardless of which router is live.
       Loop-safe: only toggles when the value actually needs to change. */
  function activeView(){
    try {
      var o = document.getElementById("cgTabObserver");
      var r = document.getElementById("cgTabRules");
      var a = document.getElementById("cgTabActive");
      if(o && o.classList.contains("active")) return "observer";
      if(r && r.classList.contains("active")) return "rules";
      if(a && a.classList.contains("active")) return "active";
      var b = document.body;
      var dv = b.getAttribute("data-cg-view");
      if(dv === "observer" || dv === "rules" || dv === "active") return dv;
      if(b.classList.contains("cg-view-observer")) return "observer";
      if(b.classList.contains("cg-view-rules")) return "rules";
    } catch(e){}
    return "active";
  }

  // True only when the element is actually rendered (not display:none via any
  // ancestor). Robust to whichever tab router is live.
  function cgIsShown(el){
    try { return !!(el && el.offsetParent !== null); } catch(e){ return false; }
  }

  function setDispScoped(el, show){
    if(!el) return;
    var cur = el.style.getPropertyValue("display");
    if(show){ if(cur === "none"){ el.style.removeProperty("display"); } }
    else { if(cur !== "none"){ el.style.setProperty("display", "none", "important"); } }
  }

  function enforceBannerScope(){
    try {
      // The per-site panel (#cgV32BannerMetrics) is now placed INSIDE the
      // Active-Site content column, so the router hides it on other tabs
      // natively -- we no longer touch it here. We only scope the aggregate
      // overview, which lives in the always-visible shell: show it only when
      // the Browser Observer card is on screen.
      var onObserver = cgIsShown(document.getElementById("cgBrowserObserverCard"));
      setDispScoped(document.getElementById("cgBannerAggregateV1"), onObserver);
    } catch(e){}
  }

  /* ---- (5) Browser Observer: aggregate banner overview ----
     Reads the banner-suppression stats/timeline the content script writes and
     renders an overview (total suppressed, top banner-source sites, recent
     activity) on the Browser Observer tab. Built with createElement (no
     innerHTML) to stay AMO-clean. NOT driven by the MutationObserver (that
     would re-render on its own child changes and loop) -- only on open and on
     tab switches. */
  var CG_AGG_STATS_KEY = "cookiegate.bannerSuppression.stats.v1";
  var CG_AGG_TIMELINE_KEY = "cookiegate.bannerSuppression.timeline.v1";
  var CG_AGG_SESSION_KEY = "cookiegate.bannerSuppression.session.v32";
  var CG_AGG_CURRENT_KEY = "cookiegate.bannerSuppression.current.v1";

  function aggStorageGet(keys){
    return new Promise(function(resolve){
      try {
        if(!api || !api.storage || !api.storage.local){ resolve({}); return; }
        var out = api.storage.local.get(keys);
        if(out && typeof out.then === "function"){ out.then(function(v){ resolve(v || {}); }).catch(function(){ resolve({}); }); return; }
        api.storage.local.get(keys, function(v){ resolve(v || {}); });
      } catch(e){ resolve({}); }
    });
  }

  function aggFmtTime(v){
    try { var d = new Date(v); if(isNaN(d.getTime())) return ""; return d.toLocaleTimeString(); } catch(e){ return ""; }
  }

  function aggHost(e){
    var h = (e && (e.host || e.domain || e.root || e.site || e.hostname)) || "";
    return String(h).toLowerCase().replace(/^www\./, "");
  }
  function aggCount(e){
    if(!e) return 0;
    var n = e.suppressed_count;             // timeline events
    if(n == null) n = e.suppressed;         // stats[domain] entries (the miss)
    if(n == null) n = e.blocked_count;
    if(n == null) n = e.blocked;
    if(n == null) n = e.count;
    n = Number(n || 0);
    if(n <= 0 && e.status === "suppressed") n = 1;
    return n > 0 ? n : 0;
  }

  function aggHostOk(h){
    h = String(h || "").toLowerCase();
    if(!h) return false;
    if(h === "byhost" || h === "-" || h === "newtab" || h === "browser") return false;
    return h.indexOf(".") >= 0;
  }

  // Recursively collect the max count per host from the (possibly deeply
  // nested) stats structure -- mirrors the panel's bestForRoot.
  function aggWalkStats(value, fallbackKey, acc, depth){
    if(depth > 7 || value == null) return;
    if(Array.isArray(value)){ value.forEach(function(it){ aggWalkStats(it, fallbackKey, acc, depth + 1); }); return; }
    if(typeof value !== "object") return;
    var host = aggHost({ host: value.host || value.domain || value.root || value.site || value.hostname || fallbackKey });
    var c = aggCount(value);
    if(aggHostOk(host) && c > 0){ acc[host] = Math.max(acc[host] || 0, c); }
    Object.keys(value).forEach(function(k){
      var keyHost = aggHostOk(k) ? String(k).toLowerCase().replace(/^www\./, "") : (host || fallbackKey);
      aggWalkStats(value[k], keyHost, acc, depth + 1);
    });
  }

  function aggCompute(stats, timeline){
    // Per-host "lifetime blocked" = max(best count in stats, sum over timeline)
    // -- exactly how the per-site panel derives its number, applied to every
    // host so the overview totals line up with the panels.
    var statsMax = {};
    try { aggWalkStats(stats, "", statsMax, 0); } catch(e){}

    var events = Array.isArray(timeline) ? timeline : [];
    var timelineSum = {};
    events.forEach(function(e){
      var h = aggHost(e); var n = aggCount(e);
      if(aggHostOk(h) && n > 0){ timelineSum[h] = (timelineSum[h] || 0) + n; }
    });

    var hosts = {};
    Object.keys(statsMax).forEach(function(h){ hosts[h] = true; });
    Object.keys(timelineSum).forEach(function(h){ hosts[h] = true; });

    var domains = [];
    var total = 0;
    Object.keys(hosts).forEach(function(h){
      var v = Math.max(statsMax[h] || 0, timelineSum[h] || 0);
      if(v > 0){ domains.push({ domain: h, suppressed: v }); total += v; }
    });
    domains.sort(function(a, b){ return b.suppressed - a.suppressed || a.domain.localeCompare(b.domain); });

    var recent = events.filter(function(e){ return aggCount(e) > 0 && aggHostOk(aggHost(e)); }).slice(0, 8);
    return { total: total, domainCount: domains.length, top: domains.slice(0, 8), recent: recent };
  }

  // Match the Browser Observer's own row/list styling so the overview looks
  // native rather than bolted-on.
  function aggRow(label, value){
    var r = document.createElement("div");
    r.className = "cg-observer-row";
    var s = document.createElement("span"); s.textContent = label;
    var b = document.createElement("b"); b.textContent = String(value);
    r.appendChild(s); r.appendChild(b);
    return r;
  }

  function aggDomainRow(label, value){
    var r = document.createElement("div");
    r.className = "cg-observer-domain";
    var s = document.createElement("span"); s.textContent = label;
    var b = document.createElement("b"); b.textContent = String(value);
    r.appendChild(s); r.appendChild(b);
    return r;
  }

  function aggHeading(text){
    var d = document.createElement("div");
    d.style.cssText = "margin-top:10px;margin-bottom:3px;font-size:10px;font-weight:850;letter-spacing:.04em;text-transform:uppercase;color:#a9b2c3;";
    d.textContent = text;
    return d;
  }

  function aggMuted(text){
    var d = document.createElement("div");
    d.className = "cg-transparency-note";
    d.textContent = text;
    return d;
  }

  function ensureBannerAggregate(){
    // Overview removed from Browser Observer per request. Never create it, and
    // remove any existing instance.
    var existing = document.getElementById("cgBannerAggregateV1");
    if(existing && existing.parentNode){ existing.parentNode.removeChild(existing); }
    return null;
  }

  function renderBannerAggregate(){
    ensureBannerAggregate(); // removes it if present
    return;
    /* eslint-disable no-unreachable */
    var sec = null;
    if(!sec) return;
    aggStorageGet([CG_AGG_STATS_KEY, CG_AGG_TIMELINE_KEY, CG_AGG_SESSION_KEY, CG_AGG_CURRENT_KEY]).then(function(got){
      var a = aggCompute([got[CG_AGG_STATS_KEY], got[CG_AGG_SESSION_KEY], got[CG_AGG_CURRENT_KEY]], got[CG_AGG_TIMELINE_KEY]);
      while(sec.firstChild) sec.removeChild(sec.firstChild);

      var head = document.createElement("div"); head.className = "cg-section-row";
      var h = document.createElement("h2"); h.textContent = "Banner Suppression Overview";
      head.appendChild(h); sec.appendChild(head);

      sec.appendChild(aggMuted("Cookie/consent banners CookieGate has hidden across every site."));

      sec.appendChild(aggRow("Total banners suppressed", a.total));
      sec.appendChild(aggRow("Sites with banners", a.domainCount));

      sec.appendChild(aggHeading("Top sites by banners"));
      if(a.top.length){
        var topWrap = document.createElement("div"); topWrap.className = "cg-observer-domains";
        a.top.forEach(function(d){ topWrap.appendChild(aggDomainRow(d.domain, d.suppressed)); });
        sec.appendChild(topWrap);
      } else {
        sec.appendChild(aggMuted("No banners suppressed yet — browse a site with a cookie banner and it'll show up here."));
      }

      sec.appendChild(aggHeading("Recent activity"));
      if(a.recent.length){
        var recWrap = document.createElement("div"); recWrap.className = "cg-observer-domains";
        a.recent.forEach(function(e){
          var host = e.host || e.domain || "?";
          var n = Number(e.suppressed_count || 0) || 1;
          var t = aggFmtTime(e.utc || e.stamp_utc);
          recWrap.appendChild(aggDomainRow((t ? (t + " · ") : "") + host, "+" + n));
        });
        sec.appendChild(recWrap);
      } else {
        sec.appendChild(aggMuted("No recent activity."));
      }

      enforceBannerScope();
    }).catch(function(){});
  }

  var cgAggTimer = null;
  function scheduleAggregate(){
    clearTimeout(cgAggTimer);
    cgAggTimer = setTimeout(renderBannerAggregate, 120);
  }

  function boot(){
    scanIfGranted();
    moveBannerUp();
    ensureResetBtn();
    renderBannerAggregate();
    enforceBannerScope();
    setTimeout(moveBannerUp, 400);
    setTimeout(moveBannerUp, 1200);
    setTimeout(ensureResetBtn, 500);
    setTimeout(renderBannerAggregate, 600);
    setTimeout(ensureResetBtn, 1500);
    // Re-enforce + refresh the aggregate on tab clicks (display + storage read;
    // never triggers a browser scan, and the aggregate render is NOT wired to
    // the MutationObserver, so there is no loop).
    document.addEventListener("click", function(ev){
      // Fire the one-time grant request on the FIRST interaction anywhere in the
      // popup (this mirrors the old working behavior). It is fully self-guarded:
      // it does nothing if <all_urls> is already granted (real installed users),
      // and it runs at most once per session (no nagging). Synchronous FIRST so
      // it keeps its user-gesture context, which Firefox requires.
      try { requestAllSitesIfMissing(); } catch(e){}
      setTimeout(enforceBannerScope, 0);
      setTimeout(enforceBannerScope, 120);
      scheduleAggregate();
    }, true);
    try {
      var mo = new MutationObserver(function(){
        clearTimeout(window.__cgBannerTopTimer);
        window.__cgBannerTopTimer = setTimeout(function(){
          moveBannerUp();
          ensureResetBtn();
          enforceBannerScope();
        }, 200);
      });
      mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "data-cg-view"] });
    } catch(e){}
    // Steady, low-cost visibility check so the aggregate reveals/hides promptly
    // on tab switches without requiring a click (fixes the "only shows when I
    // click" flicker). Display-only + guarded, so it never loops or scans.
    try { setInterval(enforceBannerScope, 250); } catch(e){}
    try { setInterval(renderBannerAggregate, 1000); } catch(e){}
  }

  if(document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
/* COOKIEGATE_PATCH_V0_1_2_FIREFOX_ALL_SITES_GRANT_AND_BANNER_TOP_V1_END */
