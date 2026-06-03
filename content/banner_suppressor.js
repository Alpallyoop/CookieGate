// COOKIEGATE_BANNER_SUPPRESSOR_V011
(function(){
  "use strict";

  const API = typeof browser !== "undefined" ? browser : chrome;
  const SETTING_KEY = "cookiegate.bannerSuppression.enabled";
  const EVENTS_KEY = "cookiegate.bannerSuppression.events.v1";
  const STYLE_ID = "cookiegate-banner-suppressor-style-v011";
  const MARK_ATTR = "data-cookiegate-banner-suppressed";
  const MAX_EVENTS = 50;

  const TEXT_RE = /\b(cookie|cookies|privacy|consent|gdpr|ccpa|personal data|legitimate interest|manage choices|reject all|accept all|necessary only)\b/i;
  const CLASS_RE = /(cookie|cookies|consent|cmp|gdpr|ccpa|privacy|onetrust|ot-sdk|didomi|trustarc|quantcast|qc-cmp|usercentrics|cookiebot|cookie-banner|cookie-notice|cookie-consent|privacy-banner)/i;

  let enabled = true;
  let observer = null;
  let scanTimer = null;
  let lastEventAt = 0;

  function apiStorage(){
    if(!API || !API.storage || !API.storage.local) return null;
    return API.storage.local;
  }

  function storageGet(key){
    const s = apiStorage();

    return new Promise(function(resolve){
      if(!s){ resolve({}); return; }

      try {
        const out = s.get(key);

        if(out && typeof out.then === "function"){
          out.then(function(v){ resolve(v || {}); }).catch(function(){ resolve({}); });
          return;
        }

        s.get(key, function(v){ resolve(v || {}); });
      } catch(e){
        resolve({});
      }
    });
  }

  function storageSet(obj){
    const s = apiStorage();

    return new Promise(function(resolve){
      if(!s){ resolve(); return; }

      try {
        const out = s.set(obj);

        if(out && typeof out.then === "function"){
          out.then(resolve).catch(resolve);
          return;
        }

        s.set(obj, resolve);
      } catch(e){
        resolve();
      }
    });
  }

  function nowIso(){
    return new Date().toISOString();
  }

  function host(){
    try { return String(location.hostname || "").replace(/^www\./, ""); }
    catch(e){ return ""; }
  }

  function textOf(el){
    return String(el && el.textContent ? el.textContent : "").replace(/\s+/g, " ").trim().slice(0, 500);
  }

  function classText(el){
    if(!el) return "";

    return [
      el.id || "",
      el.className || "",
      el.getAttribute && el.getAttribute("aria-label") || "",
      el.getAttribute && el.getAttribute("role") || ""
    ].join(" ");
  }

  function looksLikeBanner(el){
    if(!el || el.nodeType !== 1) return false;
    if(el === document.documentElement || el === document.body) return false;
    if(el.hasAttribute(MARK_ATTR)) return false;

    const tag = String(el.tagName || "").toLowerCase();
    if(["script","style","noscript","svg","path","img","video","canvas"].indexOf(tag) >= 0) return false;

    const ct = classText(el);
    const tx = textOf(el);

    if(!CLASS_RE.test(ct) && !TEXT_RE.test(tx)) return false;

    const rect = safeRect(el);
    if(!rect) return false;

    const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
    const area = Math.max(1, rect.width * rect.height);

    const style = window.getComputedStyle(el);
    const pos = String(style.position || "").toLowerCase();
    const z = parseInt(style.zIndex || "0", 10) || 0;

    const overlayish = pos === "fixed" || pos === "sticky" || z >= 50;
    const sizeable = area >= (viewportArea * 0.03) || rect.height >= 90 || rect.width >= (window.innerWidth * 0.55);

    return overlayish && sizeable;
  }

  function safeRect(el){
    try {
      const r = el.getBoundingClientRect();
      if(!r || r.width <= 0 || r.height <= 0) return null;
      return r;
    } catch(e){
      return null;
    }
  }

  function ensureStyle(){
    if(document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent =
      "[" + MARK_ATTR + "='true']{" +
        "display:none !important;" +
        "visibility:hidden !important;" +
        "opacity:0 !important;" +
        "pointer-events:none !important;" +
      "}" +
      "html.cookiegate-banner-suppression-active body{" +
        "scrollbar-gutter:stable;" +
      "}";

    (document.head || document.documentElement).appendChild(style);
  }

  function removeStyle(){
    const style = document.getElementById(STYLE_ID);
    if(style && style.parentNode) style.parentNode.removeChild(style);
  }

  async function logEvent(type, details){
    const t = Date.now();

    if(t - lastEventAt < 250){
      return;
    }

    lastEventAt = t;

    const event = {
      schema: "cookiegate.banner.event.v1",
      type: type,
      stamp_utc: nowIso(),
      host: host(),
      details: details || {}
    };

    const data = await storageGet(EVENTS_KEY);
    const list = Array.isArray(data[EVENTS_KEY]) ? data[EVENTS_KEY] : [];
    list.unshift(event);

    await storageSet({ [EVENTS_KEY]: list.slice(0, MAX_EVENTS) });
  }

  function suppress(el){
    if(!el || el.hasAttribute(MARK_ATTR)) return false;

    const tx = textOf(el);
    const selector = [
      el.tagName ? el.tagName.toLowerCase() : "element",
      el.id ? "#" + el.id : "",
      el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).slice(0,3).join(".") : ""
    ].join("");

    el.setAttribute(MARK_ATTR, "true");
    el.setAttribute("data-cookiegate-banner-reason", "local_cookie_banner_suppression");

    logEvent("cookiegate.banner.suppressed.v1", {
      selector: selector.slice(0, 180),
      text_preview: tx.slice(0, 120)
    });

    return true;
  }

  function unsuppressAll(){
    const nodes = document.querySelectorAll("[" + MARK_ATTR + "='true']");
    nodes.forEach(function(el){
      el.removeAttribute(MARK_ATTR);
      el.removeAttribute("data-cookiegate-banner-reason");
    });

    document.documentElement.classList.remove("cookiegate-banner-suppression-active");
    removeStyle();
  }

  function scan(){
    if(!enabled){
      unsuppressAll();
      return;
    }

    ensureStyle();
    document.documentElement.classList.add("cookiegate-banner-suppression-active");

    const candidates = Array.from(document.querySelectorAll(
      [
        "[id*='cookie' i]",
        "[class*='cookie' i]",
        "[id*='consent' i]",
        "[class*='consent' i]",
        "[id*='privacy' i]",
        "[class*='privacy' i]",
        "[id*='onetrust' i]",
        "[class*='onetrust' i]",
        "[id*='didomi' i]",
        "[class*='didomi' i]",
        "[id*='trustarc' i]",
        "[class*='trustarc' i]",
        "[id*='usercentrics' i]",
        "[class*='usercentrics' i]",
        "[id*='cookiebot' i]",
        "[class*='cookiebot' i]",
        "[role='dialog']",
        "[aria-modal='true']"
      ].join(",")
    )).slice(0, 250);

    let count = 0;

    candidates.forEach(function(el){
      if(looksLikeBanner(el)){
        if(suppress(el)){
          count++;
        }
      }
    });

    if(count > 0){
      logEvent("cookiegate.banner.detected.v1", { suppressed_count: count });
    }
  }

  function scheduleScan(){
    if(scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 120);
  }

  async function loadSetting(){
    const data = await storageGet(SETTING_KEY);
    enabled = data[SETTING_KEY] !== false;
  }

  function listenSettings(){
    if(!API || !API.storage || !API.storage.onChanged) return;

    try {
      API.storage.onChanged.addListener(function(changes, area){
        if(area !== "local") return;

        if(changes[SETTING_KEY]){
          enabled = changes[SETTING_KEY].newValue !== false;
          scheduleScan();
        }
      });
    } catch(e){}
  }

  async function boot(){
    await loadSetting();
    listenSettings();

    if(enabled){
      scan();
      setTimeout(scan, 700);
      setTimeout(scan, 1800);
    }

    observer = new MutationObserver(scheduleScan);

    try {
      observer.observe(document.documentElement || document.body, {
        childList: true,
        subtree: true
      });
    } catch(e){}
  }

  if(document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }

  window.CookieGateBannerSuppressorV011 = {
    scan: scan,
    unsuppressAll: unsuppressAll,
    settingKey: SETTING_KEY
  };
})();

// COOKIEGATE_V011_BANNER_LIFETIME_LEDGER
(function(){
  "use strict";

  const API = typeof browser !== "undefined" ? browser : chrome;
  const ENABLED_KEY = "cookiegate.bannerSuppression.enabled";
  const EVENTS_KEY = "cookiegate.bannerSuppression.events.v1";
  const STATS_KEY = "cookiegate.bannerSuppression.stats.v1";
  const SEEN_ATTR = "data-cookiegate-banner-ledger-v011";

  function host(){
    try {
      return String(location.hostname || "").toLowerCase().replace(/^www\./, "");
    } catch(e){
      return "";
    }
  }

  function storageGet(keys){
    return new Promise(function(resolve){
      try {
        if(!API || !API.storage || !API.storage.local){
          resolve({});
          return;
        }

        const out = API.storage.local.get(keys);

        if(out && typeof out.then === "function"){
          out.then(function(v){ resolve(v || {}); }).catch(function(){ resolve({}); });
          return;
        }

        API.storage.local.get(keys, function(v){ resolve(v || {}); });
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

  function textOf(el){
    try {
      return String((el.innerText || el.textContent || "")).replace(/\s+/g, " ").trim().toLowerCase();
    } catch(e){
      return "";
    }
  }

  function looksLikeBanner(el){
    if(!el || el.nodeType !== 1) return false;
    if(el.hasAttribute(SEEN_ATTR)) return false;

    const id = String(el.id || "").toLowerCase();
    const cls = String(el.className || "").toLowerCase();
    const role = String(el.getAttribute("role") || "").toLowerCase();
    const label = String(el.getAttribute("aria-label") || "").toLowerCase();
    const txt = textOf(el);

    const hay = id + " " + cls + " " + role + " " + label + " " + txt;

    const keyword =
      hay.indexOf("cookie") >= 0 ||
      hay.indexOf("cookies") >= 0 ||
      hay.indexOf("consent") >= 0 ||
      hay.indexOf("privacy") >= 0 ||
      hay.indexOf("gdpr") >= 0 ||
      hay.indexOf("ccpa") >= 0 ||
      hay.indexOf("onetrust") >= 0 ||
      hay.indexOf("didomi") >= 0 ||
      hay.indexOf("quantcast") >= 0 ||
      hay.indexOf("usercentrics") >= 0 ||
      hay.indexOf("trustarc") >= 0 ||
      hay.indexOf("cmp") >= 0;

    if(!keyword) return false;

    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    if(!rect) return false;

    const visibleSize = rect.width >= 120 && rect.height >= 35;
    const fixedish = (getComputedStyle(el).position || "").match(/fixed|sticky|absolute/i);

    return visibleSize && (fixedish || rect.top < 220 || rect.bottom > (window.innerHeight - 220));
  }

  function candidateNodes(){
    const selector = [
      "[id*='cookie' i]",
      "[class*='cookie' i]",
      "[id*='consent' i]",
      "[class*='consent' i]",
      "[id*='privacy' i]",
      "[class*='privacy' i]",
      "[id*='gdpr' i]",
      "[class*='gdpr' i]",
      "[id*='onetrust' i]",
      "[class*='onetrust' i]",
      "[id*='didomi' i]",
      "[class*='didomi' i]",
      "[id*='usercentrics' i]",
      "[class*='usercentrics' i]",
      "[id*='cmp' i]",
      "[class*='cmp' i]",
      "[role='dialog']",
      "[aria-label*='cookie' i]",
      "[aria-label*='privacy' i]"
    ].join(",");

    try {
      return Array.prototype.slice.call(document.querySelectorAll(selector));
    } catch(e){
      return [];
    }
  }

  async function enabled(){
    const got = await storageGet(ENABLED_KEY);
    if(Object.prototype.hasOwnProperty.call(got, ENABLED_KEY)){
      return got[ENABLED_KEY] !== false;
    }
    return true;
  }

  async function record(kind, count){
    if(!count || count <= 0) return;

    const now = new Date().toISOString();
    const h = host();
    const got = await storageGet([EVENTS_KEY, STATS_KEY]);

    const events = Array.isArray(got[EVENTS_KEY]) ? got[EVENTS_KEY] : [];
    const stats = got[STATS_KEY] && typeof got[STATS_KEY] === "object" ? got[STATS_KEY] : {};

    if(!stats.byHost || typeof stats.byHost !== "object"){
      stats.byHost = {};
    }

    if(!stats.byHost[h]){
      stats.byHost[h] = {
        detected: 0,
        suppressed: 0,
        last_stamp_utc: null
      };
    }

    if(kind === "detected"){
      stats.detected = Number(stats.detected || 0) + count;
      stats.byHost[h].detected = Number(stats.byHost[h].detected || 0) + count;
    }

    if(kind === "suppressed"){
      stats.suppressed = Number(stats.suppressed || 0) + count;
      stats.byHost[h].suppressed = Number(stats.byHost[h].suppressed || 0) + count;
    }

    stats.last_host = h;
    stats.last_kind = kind;
    stats.last_stamp_utc = now;
    stats.byHost[h].last_stamp_utc = now;

    events.unshift({
      schema: "cookiegate.banner_suppression.event.v1",
      type: "cookiegate.banner." + kind + ".v1",
      host: h,
      count: count,
      stamp_utc: now
    });

    await storageSet({
      [EVENTS_KEY]: events.slice(0, 100),
      [STATS_KEY]: stats
    });
  }

  async function scan(){
    if(!(await enabled())) return;

    const nodes = candidateNodes().filter(looksLikeBanner);

    if(!nodes.length) return;

    await record("detected", nodes.length);

    let suppressed = 0;

    nodes.forEach(function(el){
      try {
        el.setAttribute(SEEN_ATTR, "1");
        el.style.setProperty("display", "none", "important");
        el.style.setProperty("visibility", "hidden", "important");
        el.style.setProperty("pointer-events", "none", "important");
        suppressed++;
      } catch(e){}
    });

    if(suppressed > 0){
      await record("suppressed", suppressed);
    }
  }

  function boot(){
    setTimeout(scan, 300);
    setTimeout(scan, 900);
    setTimeout(scan, 1800);
    setTimeout(scan, 3500);

    try {
      const mo = new MutationObserver(function(){
        clearTimeout(window.__cookieGateBannerLedgerTimerV011);
        window.__cookieGateBannerLedgerTimerV011 = setTimeout(scan, 250);
      });

      mo.observe(document.documentElement || document.body, {
        childList: true,
        subtree: true
      });
    } catch(e){}
  }

  if(document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  window.CookieGateBannerLifetimeLedgerV011 = {
    scan: scan
  };
})();
