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
