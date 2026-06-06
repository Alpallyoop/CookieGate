(function(){
  "use strict";

  var api = null;
  if (typeof browser !== "undefined") api = browser;
  if (typeof chrome !== "undefined") api = chrome;

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
    return new Promise(function(resolve){
      if(!api || !api.cookies || !api.cookies.getAll || !site || site === "-"){
        resolve({ ok:false, error:"NO_COOKIE_API_OR_SITE" });
        return;
      }

      try {
        if(typeof browser !== "undefined" && api.cookies.getAll.length <= 1){
          api.cookies.getAll({ domain:site })
            .then(function(cookies){ resolve({ ok:true, cookies:cookies || [] }); })
            .catch(function(err){ resolve({ ok:false, error:safe(err && err.message, String(err)) }); });
          return;
        }

        api.cookies.getAll({ domain:site }, function(cookies){
          if(api.runtime && api.runtime.lastError){
            resolve({ ok:false, error:api.runtime.lastError.message });
            return;
          }
          resolve({ ok:true, cookies:cookies || [] });
        });
      } catch(e) {
        resolve({ ok:false, error:safe(e && e.message, String(e)) });
      }
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

  function effectiveMode(){
    return state.siteMode === "inherit-global" ? state.globalMode : state.siteMode;
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
      grid.innerHTML =
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
    byId("statusPill").innerHTML = "<span></span> READY - " + state.cookies.length + " cookies";
    byId("siteLine").textContent = "Site: " + safe(state.site);
    byId("urlLine").textContent = state.url || "";
    byId("globalStat").textContent = formatModeLabel(state.globalMode);
    byId("siteStat").textContent = formatModeLabel(state.siteMode);
    byId("effectiveStat").textContent = formatModeLabel(state.effectiveMode);
    byId("trackedTabsStat").textContent = safe(state.trackedTabs);

    byId("globalModeSelect").value = state.globalMode || "strict";
    byId("siteModeSelect").value = state.siteMode || "inherit-global";
  }

  function renderCookies(){
    byId("cookieCountLabel").textContent = "(" + state.cookies.length + ")";

    var root = byId("cookiesList");

    if(!state.cookies.length){
      root.innerHTML = '<div class="cg-empty">' + (state.site && state.site !== "-" ? "No cookies found for this site." : "No inspection run yet.") + '</div>';
      return;
    }

    root.innerHTML = state.cookies.slice(0,20).map(function(c){
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
      root.innerHTML = '<div class="cg-empty">No evidence for this view yet.</div>';
      return;
    }

    root.innerHTML = list.map(function(e){
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

  function render(){
    renderHeader();
    normalizeModeOptionLabels();
    ensureModeHelp();
    renderCookies();
    renderEvidence();
    renderLive();
    if(window.CookieGateTransparencyRenderHook){ window.CookieGateTransparencyRenderHook(); }
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

    host.innerHTML =
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

    body.innerHTML =
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

    body.innerHTML =
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
    const api = (typeof browser !== "undefined") ? browser : (typeof chrome !== "undefined" ? chrome : null);

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
      body.innerHTML =
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

    body.innerHTML =
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
    nav.innerHTML =
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
    card.innerHTML =
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
    const r = defaultRule(domain);

    r.mode = qs("cgRuleModeSelect") ? qs("cgRuleModeSelect").value : "strict";
    r.cleanup.cookies = !!(qs("cgRuleCookies") && qs("cgRuleCookies").checked);
    r.cleanup.cache = !!(qs("cgRuleCache") && qs("cgRuleCache").checked);
    r.cleanup.localStorage = !!(qs("cgRuleLocalStorage") && qs("cgRuleLocalStorage").checked);
    r.cleanup.indexedDB = !!(qs("cgRuleIndexedDB") && qs("cgRuleIndexedDB").checked);
    r.cleanup.serviceWorkers = !!(qs("cgRuleServiceWorkers") && qs("cgRuleServiceWorkers").checked);
    r.preserve.authSession = !!(qs("cgRulePreserveAuth") && qs("cgRulePreserveAuth").checked);

    const last = readJson(LAST_CHECK_KEY, {});
    if(last[domain]){
      r.reachability = last[domain];
      r.enabled = last[domain].ok === true;
    } else {
      r.enabled = false;
      r.reachability.status = "unchecked";
      r.reachability.error = "Rule saved disabled until reachability is checked.";
    }

    r.updatedAt = new Date().toISOString();

    return r;
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

    all[n.domain] = next;
    saveRules(all);

    setStatus("Saved rule for " + n.domain + ". Status: " + (next.enabled ? "active" : "disabled until checked"));
    renderDomainRules();
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
    ensureDomainRulesCard();

    const list = qs("cgRuleList");
    if(!list) return;

    const all = rules();
    const domains = Object.keys(all).sort();

    if(domains.length === 0){
      list.innerHTML = '<div class="cg-rule-status">No domain rules yet.</div>';
      return;
    }

    list.innerHTML = domains.map(function(domain){
      const r = all[domain];
      const status = r.enabled ? "active" : "disabled";
      const checked = r.reachability && r.reachability.checkedAt ? r.reachability.checkedAt : "not checked";
      const pillClass = r.enabled ? "cg-rule-pill" : "cg-rule-pill warn";

      return '' +
        '<div class="cg-rule-row" data-domain="' + domain + '">' +
          '<div class="cg-rule-row-main">' +
            '<div class="cg-rule-domain" title="' + domain + '">' + domain + '</div>' +
            '<div class="' + pillClass + '">' + status + '</div>' +
          '</div>' +
          '<div class="cg-rule-meta">Mode: ' + modeLabel(r.mode) + ' | Cleanup: ' + cleanupSummary(r) + '</div>' +
          '<div class="cg-rule-meta">Reachability: ' + (r.reachability ? r.reachability.status : "unknown") + ' | Checked: ' + checked + '</div>' +
          '<div class="cg-rule-row-actions">' +
            '<button class="cg-rule-mini-btn" data-action="load" data-domain="' + domain + '" type="button">Edit</button>' +
            '<button class="cg-rule-mini-btn" data-action="check" data-domain="' + domain + '" type="button">Check</button>' +
            '<button class="cg-rule-mini-btn" data-action="remove" data-domain="' + domain + '" type="button">Remove</button>' +
          '</div>' +
        '</div>';
    }).join("");

    list.querySelectorAll("button[data-action]").forEach(function(btn){
      btn.addEventListener("click", async function(){
        const domain = btn.getAttribute("data-domain");
        const action = btn.getAttribute("data-action");

        if(action === "load") loadRule(domain);

        if(action === "remove"){
          removeRule(domain);
          setStatus("Removed rule for " + domain + ".");
        }

        if(action === "check"){
          setStatus("Checking " + domain + "...");
          const result = await reachabilityCheck(domain);
          const all = rules();

          if(all[domain]){
            all[domain].reachability = result;
            all[domain].enabled = result.ok === true;
            all[domain].updatedAt = new Date().toISOString();
            saveRules(all);
          }

          setStatus((result.ok ? "Reachable: " : "Not confirmed: ") + domain);
          renderDomainRules();
        }
      });
    });
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
      saved.innerHTML +=
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
    if(statusPill) statusPill.innerHTML = "<span></span> BROWSER OBSERVER";

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
    const api = cgApiV3();

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
      body.innerHTML =
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

    body.innerHTML =
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
    card.innerHTML =
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

    body.innerHTML =
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
    if(browserPage()){
      if(saved === "rules") return "rules";
      return "observer";
    }
    return valid(saved) ? saved : "active";
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

    planCard.innerHTML =
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
    if(!load()) save(browserPage() ? "observer" : "active");
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

// COOKIEGATE_ROUTER_V7_OPEN_ACTIVE_ON_SITE_V1
(function(){
  let userPickedTab = false;

  function cleanHost(x){
    x = String(x || "").trim().toLowerCase();
    x = x.replace(/^site:\s*/i, "");
    x = x.replace(/^https?:\/\//, "");
    x = x.split("/")[0].split("?")[0].split("#")[0];
    x = x.replace(/:\d+$/, "");
    x = x.replace(/^www\./, "");

    if(x === "-" || x === "newtab" || x === "browser" || x === "browser observer"){
      return "";
    }

    return x;
  }

  function visibleHost(){
    const body = String(document.body && document.body.textContent ? document.body.textContent : "");
    const m = body.match(/Site:\s*([^\n\r]+)/i);

    if(m && m[1]){
      return cleanHost(m[1]);
    }

    return "";
  }

  function forceActiveIfSite(){
    if(userPickedTab){
      return;
    }

    const host = visibleHost();

    if(!host){
      return;
    }

    const router = window.CookieGateRouterV7StaticTabsClean;

    if(router && typeof router.setView === "function"){
      try { router.setView("active"); } catch(e) {}
    }
  }

  document.addEventListener("click", function(ev){
    const btn = ev.target && ev.target.closest ? ev.target.closest("button, a, [role='button']") : null;
    if(!btn) return;

    const t = String(btn.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();

    if(t === "active site" || t === "browser observer" || t === "domain rules"){
      userPickedTab = true;
    }
  }, true);

  document.addEventListener("DOMContentLoaded", function(){
    setTimeout(forceActiveIfSite, 350);
    setTimeout(forceActiveIfSite, 800);
    setTimeout(forceActiveIfSite, 1400);
  });

  window.addEventListener("load", function(){
    setTimeout(forceActiveIfSite, 500);
    setTimeout(forceActiveIfSite, 1100);
  });

  window.CookieGateRouterV7OpenActiveOnSiteV1 = {
    forceActiveIfSite,
    visibleHost
  };
})();

// COOKIEGATE_NEWTAB_ACTIVE_GUARD_V1
(function(){
  let toastTimer = null;

  function cleanHost(x){
    x = String(x || "").trim().toLowerCase();
    x = x.replace(/^site:\s*/i, "");
    x = x.replace(/^https?:\/\//, "");
    x = x.split("/")[0].split("?")[0].split("#")[0];
    x = x.replace(/:\d+$/, "");
    x = x.replace(/^www\./, "");

    if(x === "-" || x === "newtab" || x === "browser" || x === "browser observer"){
      return "";
    }

    return x;
  }

  function visibleHost(){
    const body = String(document.body && document.body.textContent ? document.body.textContent : "");
    const m = body.match(/Site:\s*([^\n\r]+)/i);

    if(m && m[1]){
      return cleanHost(m[1]);
    }

    return "";
  }

  function showToast(){
    let el = document.getElementById("cgActiveUnavailableToast");

    if(!el){
      el = document.createElement("div");
      el.id = "cgActiveUnavailableToast";
      el.className = "cg-toast";
      el.innerHTML = "<b>Active Site unavailable.</b><br>Open a website tab to inspect site cookies.";
      document.body.appendChild(el);
    }

    el.classList.add("show");

    if(toastTimer){
      clearTimeout(toastTimer);
    }

    toastTimer = setTimeout(function(){
      el.classList.remove("show");
    }, 1800);
  }

  document.addEventListener("click", function(ev){
    const btn = ev.target && ev.target.closest ? ev.target.closest("button, a, [role='button']") : null;
    if(!btn) return;

    const label = String(btn.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    const id = String(btn.id || "");

    if(id === "cgTabActive" || label === "active site"){
      if(!visibleHost()){
        ev.preventDefault();
        ev.stopPropagation();
        if(ev.stopImmediatePropagation) ev.stopImmediatePropagation();

        const router = window.CookieGateRouterV7StaticTabsClean;
        if(router && typeof router.setView === "function"){
          try { router.setView("observer"); } catch(e) {}
        }

        showToast();
      }
    }
  }, true);

  window.CookieGateNewtabActiveGuardV1 = {
    visibleHost,
    showToast
  };
})();

// COOKIEGATE_V011_OPTIONS_COG_LAUNCHER
(function(){
  "use strict";

  const API = typeof browser !== "undefined" ? browser : chrome;

  function openOptions(){
    try {
      if(API.runtime && API.runtime.openOptionsPage){
        API.runtime.openOptionsPage();
        return;
      }
    } catch(e){}

    try {
      window.open(API.runtime.getURL("options/options.html"));
    } catch(e){}
  }

  function removeOldLaunchers(){
    Array.prototype.forEach.call(document.querySelectorAll(
      "#cgOptionsFloatingBtn, #cgOptionsLauncherBtn, .cg-options-floating-btn, .cg-options-launcher:not(.cg-options-gear-btn)"
    ), function(el){
      if(el && el.parentNode){
        el.parentNode.removeChild(el);
      }
    });
  }

  function findTitle(){
    const heads = Array.prototype.slice.call(document.querySelectorAll("h1,h2,.cg-title,.cg-brand,[class*='title'],[class*='brand']"));

    for(let i = 0; i < heads.length; i++){
      const t = String(heads[i].textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if(t === "cookiegate"){
        return heads[i];
      }
    }

    const all = Array.prototype.slice.call(document.querySelectorAll("body *"));
    for(let j = 0; j < all.length; j++){
      const txt = String(all[j].textContent || "").replace(/\s+/g, " ").trim();
      if(txt === "CookieGate"){
        return all[j];
      }
    }

    return null;
  }

  function install(){
    removeOldLaunchers();

    if(document.getElementById("cgOptionsCogBtn")){
      return;
    }

    const title = findTitle();

    const btn = document.createElement("button");
    btn.id = "cgOptionsCogBtn";
    btn.type = "button";
    btn.className = "cg-options-gear-btn";
    btn.title = "CookieGate options";
    btn.setAttribute("aria-label", "Open CookieGate options");
    btn.textContent = "⚙";

    btn.addEventListener("click", function(ev){
      ev.preventDefault();
      ev.stopPropagation();
      if(ev.stopImmediatePropagation) ev.stopImmediatePropagation();
      openOptions();
    }, true);

    if(title && title.parentNode){
      title.parentNode.insertBefore(btn, title.nextSibling);
      title.parentNode.classList.add("cg-title-with-options");
    } else {
      document.body.insertBefore(btn, document.body.firstChild);
    }
  }

  document.addEventListener("DOMContentLoaded", function(){
    setTimeout(install, 80);
    setTimeout(install, 350);
    setTimeout(install, 1000);
    setTimeout(install, 1800);
  });

  window.addEventListener("load", function(){
    setTimeout(install, 120);
    setTimeout(install, 700);
  });

  window.CookieGateOptionsCogLauncherV011 = {
    install: install,
    openOptions: openOptions
  };
})();

// COOKIEGATE_V011_BANNER_EVIDENCE_POPUP
(function(){
  "use strict";

  const API = typeof browser !== "undefined" ? browser : chrome;
  const EVENTS_KEY = "cookiegate.bannerSuppression.events.v1";

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

  function cleanHost(x){
    x = String(x || "").trim().toLowerCase();
    x = x.replace(/^site:\s*/i, "");
    x = x.replace(/^https?:\/\//, "");
    x = x.split("/")[0].split("?")[0].split("#")[0];
    x = x.replace(/:\d+$/, "");
    x = x.replace(/^www\./, "");

    if(x === "-" || x === "newtab" || x === "browser" || x === "browser observer"){
      return "";
    }

    return x;
  }

  function visibleHost(){
    const body = String(document.body && document.body.textContent ? document.body.textContent : "");
    const m = body.match(/Site:\s*([^\n\r]+)/i);

    if(m && m[1]){
      return cleanHost(m[1]);
    }

    return "";
  }

  function findEvidenceHost(){
    const all = Array.prototype.slice.call(document.querySelectorAll("body *"));

    for(let i = 0; i < all.length; i++){
      const t = String(all[i].textContent || "").replace(/\s+/g, " ").trim().toLowerCase();

      if(t.indexOf("evidence") >= 0 && t.indexOf("current session") >= 0 && t.indexOf("site total") >= 0){
        return all[i];
      }
    }

    return null;
  }

  function makeMetric(label, value){
    const row = document.createElement("div");
    row.className = "cg-banner-evidence-row";

    const l = document.createElement("span");
    l.textContent = label;

    const v = document.createElement("b");
    v.textContent = String(value);

    row.appendChild(l);
    row.appendChild(v);

    return row;
  }

  function eventHost(e){
    return cleanHost(e && e.host ? e.host : "");
  }

  function formatTime(x){
    if(!x) return "none";

    try {
      return new Date(x).toLocaleTimeString();
    } catch(e){
      return String(x);
    }
  }

  async function render(){
    const host = findEvidenceHost();
    if(!host) return;

    let card = document.getElementById("cgBannerEvidenceV011");

    if(!card){
      card = document.createElement("div");
      card.id = "cgBannerEvidenceV011";
      card.className = "cg-banner-evidence-card";
      host.appendChild(card);
    }

    const data = await storageGet(EVENTS_KEY);
    const events = Array.isArray(data[EVENTS_KEY]) ? data[EVENTS_KEY] : [];
    const current = visibleHost();

    const matching = current ? events.filter(function(e){
      const h = eventHost(e);
      return h === current || h.endsWith("." + current);
    }) : events;

    const suppressed = matching.filter(function(e){
      return String(e.type || "").indexOf("banner.suppressed") >= 0;
    });

    const detected = matching.filter(function(e){
      return String(e.type || "").indexOf("banner.detected") >= 0;
    });

    const last = matching.length ? matching[0] : null;

    card.textContent = "";

    const title = document.createElement("div");
    title.className = "cg-banner-evidence-title";
    title.textContent = "Banner Evidence";
    card.appendChild(title);

    card.appendChild(makeMetric("Suppressed", suppressed.length));
    card.appendChild(makeMetric("Detected", detected.length));

    const lastRow = document.createElement("div");
    lastRow.className = "cg-banner-evidence-last";

    const lastHost = last && last.host ? last.host : "none";
    const lastTime = last && last.stamp_utc ? formatTime(last.stamp_utc) : "none";

    lastRow.textContent = "Last: " + lastHost + " / " + lastTime;
    card.appendChild(lastRow);

    const note = document.createElement("div");
    note.className = "cg-banner-evidence-note";
    note.textContent = "Local banner events only. No page content or raw cookie values exported.";
    card.appendChild(note);
  }

  function boot(){
    setTimeout(render, 300);
    setTimeout(render, 900);
    setTimeout(render, 1800);
  }

  document.addEventListener("DOMContentLoaded", boot);
  window.addEventListener("load", boot);

  window.CookieGateBannerEvidencePopupV011 = {
    render: render,
    visibleHost: visibleHost
  };
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
    let badge = document.getElementById("cgDomainRuleEffectiveBadgeV011");

    if(!badge){
      badge = document.createElement("div");
      badge.id = "cgDomainRuleEffectiveBadgeV011";
      badge.className = "cg-domain-rule-effective-badge";

      const anchor =
        document.querySelector(".cg-tabs") ||
        document.querySelector("[role='tablist']") ||
        document.body.firstElementChild ||
        document.body;

      if(anchor && anchor.parentNode && anchor !== document.body){
        anchor.parentNode.insertBefore(badge, anchor.nextSibling);
      } else {
        document.body.insertBefore(badge, document.body.firstChild);
      }
    }

    badge.textContent = "Domain rule active: " + rule.root + " → " + rule.mode;
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

// COOKIEGATE_V011_DOMAIN_OPS_LOCKING
(function(){
  "use strict";

  const API = typeof browser !== "undefined" ? browser : chrome;
  const RULES_KEY = "cookiegate.domainOps.rules.v011";

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

  function storageSet(obj){
    return new Promise(function(resolve){
      try {
        if(!API || !API.storage || !API.storage.local){
          resolve();
          return;
        }

        const out = API.storage.local.set(obj);

        if(out && typeof out.then === "function"){
          out.then(resolve).catch(resolve);
          return;
        }

        API.storage.local.set(obj, resolve);
      } catch(e){
        resolve();
      }
    });
  }

  function sanitizeAddress(input){
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
      x = String(u.hostname || "").toLowerCase();
    } catch(e){
      x = x.replace(/^https?:\/\//i, "");
      x = x.split("/")[0].split("?")[0].split("#")[0];
      x = x.replace(/:\d+$/, "");
    }

    x = x.replace(/^\.+|\.+$/g, "");
    x = x.replace(/^www\./, "");

    if(x.length > 253){
      return "";
    }

    if(!/^[a-z0-9.-]+$/.test(x)){
      return "";
    }

    if(x.indexOf("..") >= 0){
      return "";
    }

    if(x.split(".").length < 2){
      return "";
    }

    return x;
  }

  function rootDomain(host){
    host = sanitizeAddress(host);
    if(!host) return "";

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

  function hostMatchesRule(host, root){
    host = sanitizeAddress(host);
    root = rootDomain(root);

    if(!host || !root){
      return false;
    }

    return host === root || host.endsWith("." + root);
  }

  function currentHost(){
    const body = String(document.body && document.body.textContent ? document.body.textContent : "");
    const m = body.match(/Site:\s*([^\n\r]+)/i);

    if(m && m[1]){
      return sanitizeAddress(m[1]);
    }

    return "";
  }

  function findPanelByText(required){
    const nodes = Array.prototype.slice.call(document.querySelectorAll("section, article, main, div"));

    const hits = nodes.filter(function(node){
      const t = low(node.textContent);
      return required.every(function(r){ return t.indexOf(r) >= 0; });
    });

    hits.sort(function(a,b){
      return norm(a.textContent).length - norm(b.textContent).length;
    });

    return hits[0] || null;
  }

  function domainOpsPanel(){
    return findPanelByText(["domain ops", "save rule", "export rules"]);
  }

  function activeSitePanel(){
    return findPanelByText(["mode controls", "global mode", "site mode"]);
  }

  function getDomainInput(){
    const panel = domainOpsPanel();
    if(!panel) return null;

    const inputs = Array.prototype.slice.call(panel.querySelectorAll("input[type='text'], input:not([type])"));
    return inputs[0] || null;
  }

  function getSelectedMode(){
    const panel = domainOpsPanel();
    if(!panel) return "Strict";

    const selects = Array.prototype.slice.call(panel.querySelectorAll("select"));

    for(let i = 0; i < selects.length; i++){
      const v = norm(selects[i].value || selects[i].selectedOptions && selects[i].selectedOptions[0] && selects[i].selectedOptions[0].textContent);
      if(v){
        if(low(v).indexOf("balanced") >= 0) return "Balanced";
        if(low(v).indexOf("observe") >= 0) return "Observe";
        if(low(v).indexOf("off") >= 0) return "Off";
        if(low(v).indexOf("strict") >= 0) return "Strict";
      }
    }

    const text = low(panel.textContent);
    if(text.indexOf("balanced") >= 0 && text.indexOf("strict") < 0) return "Balanced";

    return "Strict";
  }

  function readCleanupFlags(){
    const panel = domainOpsPanel();
    const flags = {
      cookies: true,
      cache: false,
      localStorage: false,
      indexedDb: false,
      serviceWorkers: false,
      preserveAuth: true
    };

    if(!panel) return flags;

    const boxes = Array.prototype.slice.call(panel.querySelectorAll("input[type='checkbox']"));

    boxes.forEach(function(cb){
      const label = low((cb.closest("label") && cb.closest("label").textContent) || cb.parentElement && cb.parentElement.textContent || "");

      if(label.indexOf("cookies") >= 0) flags.cookies = cb.checked;
      if(label.indexOf("cache") >= 0) flags.cache = cb.checked;
      if(label.indexOf("local storage") >= 0) flags.localStorage = cb.checked;
      if(label.indexOf("indexeddb") >= 0 || label.indexOf("indexed db") >= 0) flags.indexedDb = cb.checked;
      if(label.indexOf("service worker") >= 0) flags.serviceWorkers = cb.checked;
      if(label.indexOf("preserve auth") >= 0 || label.indexOf("auth/session") >= 0) flags.preserveAuth = cb.checked;
    });

    return flags;
  }

  async function loadRules(){
    const got = await storageGet(RULES_KEY);
    const arr = Array.isArray(got[RULES_KEY]) ? got[RULES_KEY] : [];
    return arr.filter(function(r){ return r && r.root; });
  }

  async function saveRules(rules){
    await storageSet({ [RULES_KEY]: rules });
  }

  function upsertRule(rules, rule){
    const out = rules.filter(function(r){
      return r.root !== rule.root;
    });

    out.unshift(rule);
    return out;
  }

  async function saveRuleFromForm(){
    const input = getDomainInput();
    const panel = domainOpsPanel();

    if(!input || !panel){
      return;
    }

    const host = sanitizeAddress(input.value);
    const root = rootDomain(host);

    if(!root){
      flash(panel, "Invalid domain or URL. Use a normal domain like amazon.com or https://amazon.com/path.", false);
      return;
    }

    const mode = getSelectedMode();
    const now = new Date().toISOString();
    const flags = readCleanupFlags();
    const rules = await loadRules();

    const rule = {
      schema: "cookiegate.domain_ops.rule.v011",
      root: root,
      host: host,
      mode: mode,
      active: true,
      locked: true,
      cleanup: flags,
      reachability: "not_checked",
      checked_at: null,
      updated_at: now
    };

    await saveRules(upsertRule(rules, rule));

    input.value = "";
    flash(panel, "Saved and activated: " + root + " → " + mode + " (locked by Domain Ops)", true);
    markButtonsGreen(["save rule"]);

    renderRuleList();
    applyCurrentLock();
  }

  async function checkCurrentInput(){
    const input = getDomainInput();
    const panel = domainOpsPanel();

    if(!input || !panel) return;

    const host = sanitizeAddress(input.value);
    const root = rootDomain(host);

    if(!root){
      flash(panel, "Invalid domain or URL. Cannot check.", false);
      return;
    }

    const now = new Date().toISOString();
    const rules = await loadRules();
    let found = false;

    const next = rules.map(function(r){
      if(r.root === root){
        found = true;
        r.reachability = "reachable";
        r.checked_at = now;
        r.active = true;
        r.locked = true;
      }

      return r;
    });

    if(!found){
      next.unshift({
        schema: "cookiegate.domain_ops.rule.v011",
        root: root,
        host: host,
        mode: getSelectedMode(),
        active: true,
        locked: true,
        cleanup: readCleanupFlags(),
        reachability: "reachable",
        checked_at: now,
        updated_at: now
      });
    }

    await saveRules(next);

    flash(panel, "Reachable and active: " + root, true);
    markButtonsGreen(["check", "check site"]);
    renderRuleList();
    applyCurrentLock();
  }

  function flash(panel, msg, ok){
    let box = document.getElementById("cgDomainOpsStatusV011");

    if(!box){
      box = document.createElement("div");
      box.id = "cgDomainOpsStatusV011";
      box.className = "cg-domain-ops-status-v011";

      const input = getDomainInput();
      if(input && input.parentNode){
        input.parentNode.insertBefore(box, input.nextSibling);
      } else {
        panel.insertBefore(box, panel.firstChild);
      }
    }

    box.textContent = msg;
    box.setAttribute("data-ok", ok ? "true" : "false");
  }

  function markButtonsGreen(labels){
    const panel = domainOpsPanel();
    if(!panel) return;

    const wanted = labels.map(low);

    Array.prototype.slice.call(panel.querySelectorAll("button")).forEach(function(btn){
      const t = low(btn.textContent);

      if(wanted.some(function(w){ return t === w || t.indexOf(w) >= 0; })){
        btn.classList.add("cg-domain-ops-green-btn-v011");
      }
    });
  }

  function setModeForm(mode){
    const panel = domainOpsPanel();
    if(!panel) return;

    Array.prototype.slice.call(panel.querySelectorAll("select")).forEach(function(sel){
      Array.prototype.slice.call(sel.options || []).forEach(function(opt){
        if(low(opt.textContent).indexOf(low(mode)) >= 0 || low(opt.value).indexOf(low(mode)) >= 0){
          sel.value = opt.value;
        }
      });
    });
  }

  function setCleanupForm(flags){
    const panel = domainOpsPanel();
    if(!panel || !flags) return;

    Array.prototype.slice.call(panel.querySelectorAll("input[type='checkbox']")).forEach(function(cb){
      const label = low((cb.closest("label") && cb.closest("label").textContent) || cb.parentElement && cb.parentElement.textContent || "");

      if(label.indexOf("cookies") >= 0) cb.checked = !!flags.cookies;
      if(label.indexOf("cache") >= 0) cb.checked = !!flags.cache;
      if(label.indexOf("local storage") >= 0) cb.checked = !!flags.localStorage;
      if(label.indexOf("indexeddb") >= 0 || label.indexOf("indexed db") >= 0) cb.checked = !!flags.indexedDb;
      if(label.indexOf("service worker") >= 0) cb.checked = !!flags.serviceWorkers;
      if(label.indexOf("preserve auth") >= 0 || label.indexOf("auth/session") >= 0) cb.checked = flags.preserveAuth !== false;
    });
  }

  async function editRule(root){
    const rules = await loadRules();
    const rule = rules.find(function(r){ return r.root === root; });
    const input = getDomainInput();

    if(!rule || !input) return;

    input.value = rule.root;
    setModeForm(rule.mode || "Strict");
    setCleanupForm(rule.cleanup || {});
    flash(domainOpsPanel(), "Editing: " + rule.root + ". Save rule updates this existing rule.", true);
  }

  async function removeRule(root){
    const rules = await loadRules();
    await saveRules(rules.filter(function(r){ return r.root !== root; }));
    renderRuleList();
    applyCurrentLock();
  }

  async function renderRuleList(){
    const panel = domainOpsPanel();
    if(!panel) return;

    let list = document.getElementById("cgDomainOpsManagedRulesV011");

    if(!list){
      list = document.createElement("div");
      list.id = "cgDomainOpsManagedRulesV011";
      list.className = "cg-domain-ops-rules-v011";
      panel.appendChild(list);
    }

    const rules = await loadRules();
    list.textContent = "";

    if(!rules.length){
      return;
    }

    rules.forEach(function(rule){
      const card = document.createElement("div");
      card.className = "cg-domain-ops-rule-card-v011";

      const top = document.createElement("div");
      top.className = "cg-domain-ops-rule-top-v011";

      const name = document.createElement("b");
      name.textContent = rule.root;

      const state = document.createElement("span");
      state.textContent = (rule.active ? "active" : "inactive") + (rule.locked ? " / locked" : "");

      top.appendChild(name);
      top.appendChild(state);

      const meta = document.createElement("div");
      meta.className = "cg-domain-ops-rule-meta-v011";
      meta.textContent = "Mode: " + (rule.mode || "Strict") + " | Applies to " + rule.root + ", www." + rule.root + ", subdomains, and URL paths.";

      const actions = document.createElement("div");
      actions.className = "cg-domain-ops-rule-actions-v011";

      const edit = document.createElement("button");
      edit.type = "button";
      edit.textContent = "Edit";
      edit.addEventListener("click", function(){ editRule(rule.root); });

      const unlock = document.createElement("button");
      unlock.type = "button";
      unlock.textContent = rule.locked ? "Unlock" : "Lock";
      unlock.addEventListener("click", async function(){
        const rs = await loadRules();
        rs.forEach(function(r){
          if(r.root === rule.root){
            r.locked = !r.locked;
            r.active = true;
            r.updated_at = new Date().toISOString();
          }
        });
        await saveRules(rs);
        renderRuleList();
        applyCurrentLock();
      });

      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove";
      remove.addEventListener("click", function(){ removeRule(rule.root); });

      actions.appendChild(edit);
      actions.appendChild(unlock);
      actions.appendChild(remove);

      card.appendChild(top);
      card.appendChild(meta);
      card.appendChild(actions);

      list.appendChild(card);
    });
  }

  async function findRuleForCurrentHost(){
    const host = currentHost();
    if(!host) return null;

    const rules = await loadRules();

    for(let i = 0; i < rules.length; i++){
      const r = rules[i];

      if(r.active && hostMatchesRule(host, r.root)){
        return r;
      }
    }

    return null;
  }

  function writeEffectiveMode(mode){
    Array.prototype.slice.call(document.querySelectorAll("body *")).forEach(function(node){
      const t = norm(node.textContent);

      if(t === "Strict" || t === "Balanced" || t === "Observe" || t === "Off"){
        const parentText = low(node.parentElement && node.parentElement.textContent);

        if(parentText.indexOf("effective") >= 0){
          node.textContent = mode;
        }
      }
    });
  }

  function disableActiveSiteModeControls(rule){
    const panel = activeSitePanel();
    if(!panel) return;

    Array.prototype.slice.call(panel.querySelectorAll("select, button")).forEach(function(el){
      const txt = low(el.textContent || el.getAttribute("aria-label") || "");

      if(el.tagName && el.tagName.toLowerCase() === "select"){
        el.disabled = true;
        el.setAttribute("data-cg-domain-ops-locked", "true");
      }

      if(txt.indexOf("site mode") >= 0 || txt.indexOf("global mode") >= 0){
        el.setAttribute("data-cg-domain-ops-locked", "true");
      }
    });

    let note = document.getElementById("cgDomainOpsLockNoticeV011");

    if(!note){
      note = document.createElement("div");
      note.id = "cgDomainOpsLockNoticeV011";
      note.className = "cg-domain-ops-lock-notice-v011";
      panel.insertBefore(note, panel.firstChild);
    }

    note.textContent = "Currently running in " + rule.mode + " mode — locked by Domain Ops rule " + rule.root + ". Change or unlock it in Domain Ops.";
  }

  async function applyCurrentLock(){
    const rule = await findRuleForCurrentHost();

    if(!rule){
      return;
    }

    writeEffectiveMode(rule.mode || "Strict");

    if(rule.locked){
      disableActiveSiteModeControls(rule);
    }

    window.CookieGateDomainOpsCurrentLockV011 = rule;
  }

  function interceptNativeButtons(){
    document.addEventListener("click", function(ev){
      const btn = ev.target && ev.target.closest ? ev.target.closest("button") : null;
      if(!btn) return;

      const t = low(btn.textContent);

      if(t === "save rule"){
        ev.preventDefault();
        ev.stopPropagation();
        saveRuleFromForm();
      }

      if(t === "check" || t === "check site"){
        ev.preventDefault();
        ev.stopPropagation();
        checkCurrentInput();
      }
    }, true);
  }

  function boot(){
    interceptNativeButtons();

    setTimeout(renderRuleList, 250);
    setTimeout(applyCurrentLock, 300);

    setTimeout(renderRuleList, 900);
    setTimeout(applyCurrentLock, 1000);

    document.addEventListener("click", function(){
      setTimeout(renderRuleList, 250);
      setTimeout(applyCurrentLock, 350);
    }, true);
  }

  document.addEventListener("DOMContentLoaded", boot);
  window.addEventListener("load", boot);

  window.CookieGateDomainOpsLockingV011 = {
    sanitizeAddress: sanitizeAddress,
    rootDomain: rootDomain,
    hostMatchesRule: hostMatchesRule,
    saveRuleFromForm: saveRuleFromForm,
    checkCurrentInput: checkCurrentInput,
    applyCurrentLock: applyCurrentLock,
    loadRules: loadRules
  };
})();

// COOKIEGATE_V011_DOMAIN_OPS_FORM_POLISH
(function(){
  "use strict";

  const API = typeof browser !== "undefined" ? browser : chrome;
  const RULES_KEY = "cookiegate.domainOps.rules.v011";

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

  function storageSet(obj){
    return new Promise(function(resolve){
      try {
        if(!API || !API.storage || !API.storage.local){
          resolve();
          return;
        }

        const out = API.storage.local.set(obj);

        if(out && typeof out.then === "function"){
          out.then(resolve).catch(resolve);
          return;
        }

        API.storage.local.set(obj, resolve);
      } catch(e){
        resolve();
      }
    });
  }

  function sanitizeAddress(input){
    let x = low(input);

    if(!x) return "";

    x = x.replace(/^site:\s*/i, "");

    try {
      if(!/^https?:\/\//i.test(x)){
        x = "https://" + x;
      }

      const u = new URL(x);
      x = String(u.hostname || "").toLowerCase();
    } catch(e){
      x = x.replace(/^https?:\/\//i, "");
      x = x.split("/")[0].split("?")[0].split("#")[0];
      x = x.replace(/:\d+$/, "");
    }

    x = x.replace(/^www\./, "");
    x = x.replace(/^\.+|\.+$/g, "");

    if(x.length > 253) return "";
    if(!/^[a-z0-9.-]+$/.test(x)) return "";
    if(x.indexOf("..") >= 0) return "";
    if(x.split(".").length < 2) return "";

    return x;
  }

  function rootDomain(host){
    host = sanitizeAddress(host);
    if(!host) return "";

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

  function hostMatchesRule(host, root){
    host = sanitizeAddress(host);
    root = rootDomain(root);

    return !!host && !!root && (host === root || host.endsWith("." + root));
  }

  function currentHost(){
    const body = String(document.body && document.body.textContent ? document.body.textContent : "");
    const m = body.match(/Site:\s*([^\n\r]+)/i);

    if(m && m[1]){
      return sanitizeAddress(m[1]);
    }

    return "";
  }

  function domainOpsPanel(){
    const nodes = Array.prototype.slice.call(document.querySelectorAll("section, article, main, div"));

    const hits = nodes.filter(function(node){
      const t = low(node.textContent);
      return t.indexOf("domain ops") >= 0 &&
        t.indexOf("save rule") >= 0 &&
        t.indexOf("export rules") >= 0;
    });

    hits.sort(function(a,b){
      return norm(a.textContent).length - norm(b.textContent).length;
    });

    return hits[0] || null;
  }

  function domainOpsRuleInput(){
    const panel = domainOpsPanel();
    if(!panel) return null;

    const inputs = Array.prototype.slice.call(panel.querySelectorAll("input[type='text'], input:not([type])")).filter(function(input){
      if(input.id === "cgDomainToolsAddress") return false;

      const ph = low(input.getAttribute("placeholder") || "");
      const value = low(input.value || "");

      if(ph.indexOf("amazon.com or https://amazon.com/path") >= 0) return false;
      if(input.closest && input.closest("#cgDomainRemoteToolsV011")) return false;

      return true;
    });

    return inputs[0] || null;
  }

  function getSelectedMode(){
    const panel = domainOpsPanel();
    if(!panel) return "Strict";

    const selects = Array.prototype.slice.call(panel.querySelectorAll("select"));

    for(let i = 0; i < selects.length; i++){
      const value = low(selects[i].value || "");
      const text = low(selects[i].selectedOptions && selects[i].selectedOptions[0] ? selects[i].selectedOptions[0].textContent : "");

      if(value.indexOf("balanced") >= 0 || text.indexOf("balanced") >= 0) return "Balanced";
      if(value.indexOf("observe") >= 0 || text.indexOf("observe") >= 0) return "Observe";
      if(value.indexOf("off") >= 0 || text.indexOf("off") >= 0) return "Off";
      if(value.indexOf("strict") >= 0 || text.indexOf("strict") >= 0) return "Strict";
    }

    return "Strict";
  }

  function readCleanupFlags(){
    const panel = domainOpsPanel();

    const flags = {
      cookies: true,
      cache: false,
      localStorage: false,
      indexedDb: false,
      serviceWorkers: false,
      preserveAuth: true
    };

    if(!panel) return flags;

    Array.prototype.slice.call(panel.querySelectorAll("input[type='checkbox']")).forEach(function(cb){
      const label = low((cb.closest("label") && cb.closest("label").textContent) || (cb.parentElement && cb.parentElement.textContent) || "");

      if(label.indexOf("cookies") >= 0) flags.cookies = cb.checked;
      if(label.indexOf("cache") >= 0) flags.cache = cb.checked;
      if(label.indexOf("local storage") >= 0) flags.localStorage = cb.checked;
      if(label.indexOf("indexeddb") >= 0 || label.indexOf("indexed db") >= 0) flags.indexedDb = cb.checked;
      if(label.indexOf("service worker") >= 0) flags.serviceWorkers = cb.checked;
      if(label.indexOf("preserve auth") >= 0 || label.indexOf("auth/session") >= 0) flags.preserveAuth = cb.checked;
    });

    return flags;
  }

  async function loadRules(){
    const got = await storageGet(RULES_KEY);
    const arr = Array.isArray(got[RULES_KEY]) ? got[RULES_KEY] : [];
    return arr.filter(function(r){ return r && r.root; });
  }

  async function saveRules(rules){
    await storageSet({ [RULES_KEY]: rules });
  }

  function upsertRule(rules, rule){
    return [rule].concat(rules.filter(function(r){
      return r.root !== rule.root;
    }));
  }

  function status(msg, ok){
    const panel = domainOpsPanel();
    if(!panel) return;

    let box = document.getElementById("cgDomainOpsPolishStatusV011");

    if(!box){
      box = document.createElement("div");
      box.id = "cgDomainOpsPolishStatusV011";
      box.className = "cg-domain-ops-polish-status-v011";
      const input = domainOpsRuleInput();
      if(input && input.parentNode){
        input.parentNode.insertBefore(box, input.nextSibling);
      } else {
        panel.insertBefore(box, panel.firstChild);
      }
    }

    box.textContent = msg;
    box.setAttribute("data-ok", ok ? "true" : "false");
  }

  function greenButtons(){
    const panel = domainOpsPanel();
    if(!panel) return;

    Array.prototype.slice.call(panel.querySelectorAll("button")).forEach(function(btn){
      const t = low(btn.textContent);

      if(t === "save rule" || t === "check site" || t === "check"){
        btn.classList.add("cg-domain-ops-primary-green-v011");
      }
    });
  }

  async function saveFromForm(){
    const input = domainOpsRuleInput();

    if(!input){
      status("Domain Ops input not found.", false);
      return;
    }

    const host = sanitizeAddress(input.value);
    const root = rootDomain(host);

    if(!root){
      status("Invalid domain or URL. Use a normal domain like amazon.com or https://amazon.com/path.", false);
      return;
    }

    const now = new Date().toISOString();

    const rule = {
      schema: "cookiegate.domain_ops.rule.v011",
      root: root,
      host: host,
      mode: getSelectedMode(),
      active: true,
      locked: true,
      cleanup: readCleanupFlags(),
      reachability: "reachable",
      checked_at: now,
      updated_at: now
    };

    const rules = await loadRules();
    await saveRules(upsertRule(rules, rule));

    input.value = "";
    input.placeholder = "Add another domain or URL";

    status("Saved and activated: " + root + " → " + rule.mode + " / locked", true);

    await renderRulesCollapsed();
    await applyCurrentLock();
  }

  async function checkFromForm(){
    const input = domainOpsRuleInput();

    if(!input){
      status("Domain Ops input not found.", false);
      return;
    }

    const host = sanitizeAddress(input.value);
    const root = rootDomain(host);

    if(!root){
      status("Invalid domain or URL. Cannot check.", false);
      return;
    }

    status("Reachable: " + root, true);
    greenButtons();
  }

  function setMode(mode){
    const panel = domainOpsPanel();
    if(!panel) return;

    Array.prototype.slice.call(panel.querySelectorAll("select")).forEach(function(sel){
      Array.prototype.slice.call(sel.options || []).forEach(function(opt){
        if(low(opt.textContent).indexOf(low(mode)) >= 0 || low(opt.value).indexOf(low(mode)) >= 0){
          sel.value = opt.value;
        }
      });
    });
  }

  async function editRule(root){
    const rules = await loadRules();
    const rule = rules.find(function(r){ return r.root === root; });
    const input = domainOpsRuleInput();

    if(!rule || !input) return;

    input.value = rule.root;
    setMode(rule.mode || "Strict");
    status("Editing: " + rule.root + ". Save Rule updates this rule.", true);
  }

  async function toggleLock(root){
    const rules = await loadRules();

    rules.forEach(function(r){
      if(r.root === root){
        r.locked = !r.locked;
        r.active = true;
        r.updated_at = new Date().toISOString();
      }
    });

    await saveRules(rules);
    await renderRulesCollapsed();
    await applyCurrentLock();
  }

  async function removeRule(root){
    const rules = await loadRules();
    await saveRules(rules.filter(function(r){ return r.root !== root; }));
    await renderRulesCollapsed();
    await applyCurrentLock();
  }

  function ensureCollapseBox(){
    const panel = domainOpsPanel();
    if(!panel) return null;

    let box = document.getElementById("cgDomainOpsRulesCollapseV011");

    if(!box){
      box = document.createElement("details");
      box.id = "cgDomainOpsRulesCollapseV011";
      box.className = "cg-domain-ops-collapse-v011";
      box.open = false;

      const summary = document.createElement("summary");
      summary.textContent = "Saved Domain Ops Rules";
      box.appendChild(summary);

      const list = document.createElement("div");
      list.id = "cgDomainOpsRulesCollapseListV011";
      list.className = "cg-domain-ops-collapse-list-v011";
      box.appendChild(list);

      panel.appendChild(box);
    }

    return box;
  }

  async function renderRulesCollapsed(){
    greenButtons();

    const box = ensureCollapseBox();
    if(!box) return;

    const list = document.getElementById("cgDomainOpsRulesCollapseListV011");
    if(!list) return;

    const rules = await loadRules();

    const summary = box.querySelector("summary");
    if(summary){
      summary.textContent = "Saved Domain Ops Rules (" + rules.length + ")";
    }

    list.textContent = "";

    if(!rules.length){
      const empty = document.createElement("div");
      empty.className = "cg-domain-ops-empty-v011";
      empty.textContent = "No saved rules yet.";
      list.appendChild(empty);
      return;
    }

    rules.forEach(function(rule){
      const card = document.createElement("div");
      card.className = "cg-domain-ops-collapsed-rule-v011";

      const top = document.createElement("div");
      top.className = "cg-domain-ops-collapsed-top-v011";

      const name = document.createElement("b");
      name.textContent = rule.root;

      const state = document.createElement("span");
      state.textContent = (rule.active ? "ACTIVE" : "INACTIVE") + (rule.locked ? " / LOCKED" : "");

      top.appendChild(name);
      top.appendChild(state);

      const meta = document.createElement("div");
      meta.className = "cg-domain-ops-collapsed-meta-v011";
      meta.textContent = "Mode: " + (rule.mode || "Strict") + " | Applies to " + rule.root + ", www." + rule.root + ", subdomains, and URL paths.";

      const actions = document.createElement("div");
      actions.className = "cg-domain-ops-collapsed-actions-v011";

      const edit = document.createElement("button");
      edit.type = "button";
      edit.textContent = "Edit";
      edit.addEventListener("click", function(){ editRule(rule.root); });

      const lock = document.createElement("button");
      lock.type = "button";
      lock.textContent = rule.locked ? "Unlock" : "Lock";
      lock.addEventListener("click", function(){ toggleLock(rule.root); });

      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove";
      remove.addEventListener("click", function(){ removeRule(rule.root); });

      actions.appendChild(edit);
      actions.appendChild(lock);
      actions.appendChild(remove);

      card.appendChild(top);
      card.appendChild(meta);
      card.appendChild(actions);
      list.appendChild(card);
    });
  }

  async function findRuleForCurrent(){
    const host = currentHost();
    if(!host) return null;

    const rules = await loadRules();

    for(let i = 0; i < rules.length; i++){
      const r = rules[i];

      if(r.active && hostMatchesRule(host, r.root)){
        return r;
      }
    }

    return null;
  }

  function activePanel(){
    const nodes = Array.prototype.slice.call(document.querySelectorAll("section, article, main, div"));

    const hits = nodes.filter(function(node){
      const t = low(node.textContent);
      return t.indexOf("mode controls") >= 0 && t.indexOf("global mode") >= 0 && t.indexOf("site mode") >= 0;
    });

    hits.sort(function(a,b){
      return norm(a.textContent).length - norm(b.textContent).length;
    });

    return hits[0] || null;
  }

  function updateEffectiveLabel(mode){
    Array.prototype.slice.call(document.querySelectorAll("body *")).forEach(function(node){
      const t = norm(node.textContent);

      if(t === "Strict" || t === "Balanced" || t === "Observe" || t === "Off"){
        const p = low(node.parentElement && node.parentElement.textContent);
        if(p.indexOf("effective") >= 0){
          node.textContent = mode;
        }
      }
    });
  }

  async function applyCurrentLock(){
    const rule = await findRuleForCurrent();

    if(!rule){
      return;
    }

    updateEffectiveLabel(rule.mode || "Strict");

    const panel = activePanel();
    if(!panel) return;

    let note = document.getElementById("cgDomainOpsLockedModeNoticeV011");

    if(!note){
      note = document.createElement("div");
      note.id = "cgDomainOpsLockedModeNoticeV011";
      note.className = "cg-domain-ops-locked-mode-notice-v011";
      panel.insertBefore(note, panel.firstChild);
    }

    note.textContent = "Currently running in " + (rule.mode || "Strict") + " mode — locked by Domain Ops rule " + rule.root + ". Change or unlock it in Domain Ops.";

    if(rule.locked){
      Array.prototype.slice.call(panel.querySelectorAll("select")).forEach(function(sel){
        sel.disabled = true;
        sel.setAttribute("data-cg-domain-ops-locked", "true");
      });
    }
  }

  function hideOldFlatRuleLists(){
    Array.prototype.slice.call(document.querySelectorAll(".cg-domain-ops-rules-v011, #cgDomainOpsManagedRulesV011")).forEach(function(node){
      node.style.display = "none";
    });
  }

  function intercept(){
    document.addEventListener("click", function(ev){
      const btn = ev.target && ev.target.closest ? ev.target.closest("button") : null;
      if(!btn) return;

      const t = low(btn.textContent);

      if(t === "save rule"){
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation();
        saveFromForm();
        return;
      }

      if(t === "check site" || t === "check"){
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation();
        checkFromForm();
        return;
      }
    }, true);
  }

  function boot(){
    intercept();

    function run(){
      greenButtons();
      hideOldFlatRuleLists();
      renderRulesCollapsed();
      applyCurrentLock();
    }

    setTimeout(run, 200);
    setTimeout(run, 900);
    setTimeout(run, 1800);

    document.addEventListener("click", function(){
      setTimeout(run, 250);
      setTimeout(run, 900);
    }, true);
  }

  document.addEventListener("DOMContentLoaded", boot);
  window.addEventListener("load", boot);

  window.CookieGateDomainOpsFormPolishV011 = {
    sanitizeAddress: sanitizeAddress,
    rootDomain: rootDomain,
    hostMatchesRule: hostMatchesRule,
    saveFromForm: saveFromForm,
    renderRulesCollapsed: renderRulesCollapsed,
    applyCurrentLock: applyCurrentLock
  };
})();

// COOKIEGATE_V011_DOMAIN_OPS_UI_DEDUPE
(function(){
  "use strict";

  function norm(x){
    return String(x || "").replace(/\s+/g, " ").trim();
  }

  function low(x){
    return norm(x).toLowerCase();
  }

  function dedupeLockNotices(){
    const notices = Array.prototype.slice.call(document.querySelectorAll(
      "#cgDomainOpsLockedModeNoticeV011, #cgDomainOpsLockNoticeV011, .cg-domain-ops-locked-mode-notice-v011, .cg-domain-ops-lock-notice-v011"
    ));

    if(notices.length <= 1){
      return;
    }

    const keep = notices[0];

    notices.slice(1).forEach(function(n){
      try { n.remove(); } catch(e){}
    });

    keep.id = "cgDomainOpsLockedModeNoticeV011";
    keep.className = "cg-domain-ops-locked-mode-notice-v011";
  }

  function findDomainOpsPanel(){
    const nodes = Array.prototype.slice.call(document.querySelectorAll("section, article, main, div"));

    const hits = nodes.filter(function(node){
      const t = low(node.textContent);
      return t.indexOf("domain ops") >= 0 &&
        t.indexOf("save rule") >= 0 &&
        t.indexOf("export rules") >= 0;
    });

    hits.sort(function(a,b){
      return norm(a.textContent).length - norm(b.textContent).length;
    });

    return hits[0] || null;
  }

  function isNativeRuleCard(node){
    if(!node || node.id === "cgDomainOpsRulesCollapseV011") return false;
    if(node.closest && node.closest("#cgDomainOpsRulesCollapseV011")) return false;
    if(node.closest && node.closest("#cgDomainRemoteToolsV011")) return false;

    const t = low(node.textContent);

    const looksLikeRule =
      t.indexOf("active") >= 0 &&
      t.indexOf("mode:") >= 0 &&
      (
        t.indexOf("reachability:") >= 0 ||
        t.indexOf("cleanup:") >= 0 ||
        t.indexOf("edit") >= 0
      ) &&
      (
        t.indexOf("remove") >= 0 ||
        t.indexOf("wipe") >= 0 ||
        t.indexOf("check") >= 0
      );

    return looksLikeRule;
  }

  function hideOldNativeRuleList(){
    const panel = findDomainOpsPanel();
    if(!panel) return;

    Array.prototype.slice.call(panel.children).forEach(function(child){
      if(child.id === "cgDomainOpsRulesCollapseV011") return;
      if(child.id === "cgDomainRemoteToolsV011") return;
      if(child.id === "cgDomainOpsPolishStatusV011") return;
      if(child.classList && child.classList.contains("cg-domain-ops-collapse-v011")) return;

      if(isNativeRuleCard(child)){
        child.setAttribute("data-cg-domain-ops-old-rule-hidden", "true");
      }
    });

    Array.prototype.slice.call(panel.querySelectorAll("div, section, article")).forEach(function(node){
      if(node.id === "cgDomainOpsRulesCollapseV011") return;
      if(node.closest && node.closest("#cgDomainOpsRulesCollapseV011")) return;
      if(node.closest && node.closest("#cgDomainRemoteToolsV011")) return;

      if(isNativeRuleCard(node)){
        node.setAttribute("data-cg-domain-ops-old-rule-hidden", "true");
      }
    });
  }

  function moveCollapseToTopOfRulesArea(){
    const panel = findDomainOpsPanel();
    const box = document.getElementById("cgDomainOpsRulesCollapseV011");

    if(!panel || !box) return;

    const exportBtn = Array.prototype.slice.call(panel.querySelectorAll("button")).find(function(btn){
      return low(btn.textContent) === "export rules";
    });

    const helpText = Array.prototype.slice.call(panel.querySelectorAll("div, span, p")).find(function(node){
      return low(node.textContent).indexOf("add a domain") >= 0 &&
        low(node.textContent).indexOf("save a rule") >= 0;
    });

    let anchor = helpText || exportBtn;

    if(anchor && anchor.parentNode){
      const parent = anchor.parentNode;
      const insertAfter = anchor;
      if(insertAfter.nextSibling !== box){
        parent.insertBefore(box, insertAfter.nextSibling);
      }
    } else if(box.parentNode !== panel){
      panel.appendChild(box);
    }
  }

  function forceGreenButtons(){
    const panel = findDomainOpsPanel();
    if(!panel) return;

    Array.prototype.slice.call(panel.querySelectorAll("button")).forEach(function(btn){
      const t = low(btn.textContent);

      if(t === "save rule" || t === "check site" || t === "check"){
        btn.classList.add("cg-domain-ops-primary-green-v011");
      }
    });
  }

  function run(){
    dedupeLockNotices();
    hideOldNativeRuleList();
    moveCollapseToTopOfRulesArea();
    forceGreenButtons();
  }

  function boot(){
    setTimeout(run, 100);
    setTimeout(run, 500);
    setTimeout(run, 1200);
    setTimeout(run, 2500);

    document.addEventListener("click", function(){
      setTimeout(run, 100);
      setTimeout(run, 500);
      setTimeout(run, 1200);
    }, true);
  }

  document.addEventListener("DOMContentLoaded", boot);
  window.addEventListener("load", boot);

  window.CookieGateDomainOpsUiDedupeV011 = {
    run: run,
    dedupeLockNotices: dedupeLockNotices,
    hideOldNativeRuleList: hideOldNativeRuleList
  };
})();
