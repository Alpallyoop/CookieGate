const fs = require("fs");

const popupPath = process.argv[2];
const cssPath = process.argv[3];

if(!popupPath) throw new Error("POPUP_PATH_REQUIRED");
if(!cssPath) throw new Error("CSS_PATH_REQUIRED");

let popup = fs.readFileSync(popupPath, "utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
let css = fs.readFileSync(cssPath, "utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

function req(s){
  if(popup.indexOf(s) < 0) throw new Error("POPUP_REQUIRED_TEXT_MISSING: " + s);
}

req("COOKIEGATE_V65_HORIZONTAL_METRICS_SITE_NOW_CURRENT");
req("function cgV60ReconcileBannerMetrics");
req("function cgV61Reconcile");
req("function cgV62BannerMessageText");
req("cgV32BannerMetrics");
req("this site now");
req("this session");
req("site timeline");
req("lifetime blocked");

if(popup.indexOf("COOKIEGATE_V66_BANNER_TAB_SCOPE_SITE_NOW_OWNER") >= 0){
  throw new Error("POPUP_ALREADY_V66");
}

if(css.indexOf("COOKIEGATE_V66_BANNER_TAB_SCOPE_SITE_NOW_OWNER_CSS") >= 0){
  throw new Error("CSS_ALREADY_V66");
}

const helper = `

(function(){
  "use strict";

  function cgV66Panel(){
    try {
      var direct = document.getElementById("cgV32BannerMetrics");
      if(direct) return direct;

      var nodes = Array.prototype.slice.call(document.querySelectorAll("section, article, aside, div"));
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

  function cgV66Number(value){
    var m = String(value || "").match(/\\d+/);
    if(!m) return 0;
    var n = Number(m[0]);
    return isFinite(n) && !isNaN(n) && n > 0 ? n : 0;
  }

  function cgV66AttrNumber(panel, names){
    try {
      for(var i = 0; i < names.length; i++){
        var raw = panel.getAttribute(names[i]);
        if(raw !== null && raw !== undefined && String(raw).trim() !== ""){
          return cgV66Number(raw);
        }
      }
    } catch(e){}
    return null;
  }

  function cgV66TextMetric(panel, label){
    try {
      var wanted = String(label || "").toLowerCase();
      var lines = String(panel.textContent || "")
        .split(/\\n+/)
        .map(function(x){ return String(x || "").replace(/\\s+/g, " ").trim(); })
        .filter(Boolean);

      for(var i = 0; i < lines.length; i++){
        var current = String(lines[i] || "");
        var lower = current.toLowerCase();

        if(lower === wanted || lower === wanted + ":"){
          var prev = i > 0 ? cgV66Number(lines[i - 1]) : 0;
          var next = i + 1 < lines.length ? cgV66Number(lines[i + 1]) : 0;
          if(prev > 0) return prev;
          if(next > 0) return next;
          return 0;
        }

        if(lower.indexOf(wanted + ":") >= 0 || lower.indexOf(wanted) >= 0){
          return cgV66Number(current);
        }
      }
    } catch(e){}
    return 0;
  }

  function cgV66Counts(panel){
    var siteNow = cgV66AttrNumber(panel, ["data-cg-v66-site-now", "data-cg-v62-site-now", "data-cg-v61-site-now"]);
    var siteSession = cgV66AttrNumber(panel, ["data-cg-v66-site-session", "data-cg-v62-site-session", "data-cg-v61-site-session"]);
    var siteTimeline = cgV66AttrNumber(panel, ["data-cg-v66-site-timeline", "data-cg-v62-site-timeline", "data-cg-v61-site-timeline"]);
    var lifetime = cgV66AttrNumber(panel, ["data-cg-v66-lifetime-blocked", "data-cg-v62-lifetime-blocked", "data-cg-v61-lifetime", "data-cg-v60-banner-all-lifetime"]);

    if(siteNow === null) siteNow = cgV66TextMetric(panel, "this site now");
    if(siteSession === null) siteSession = cgV66TextMetric(panel, "this session");
    if(siteTimeline === null) siteTimeline = cgV66TextMetric(panel, "site timeline");
    if(lifetime === null) lifetime = cgV66TextMetric(panel, "lifetime blocked");

    siteNow = cgV66Number(siteNow);
    siteSession = cgV66Number(siteSession);
    siteTimeline = cgV66Number(siteTimeline);
    lifetime = cgV66Number(lifetime);

    if(siteSession > 0 && siteNow < 1){
      siteNow = 1;
    }

    return {
      siteNow: siteNow,
      siteSession: siteSession,
      siteTimeline: siteTimeline,
      lifetimeBlocked: lifetime
    };
  }

  function cgV66Message(counts){
    counts = counts || {};
    if(Number(counts.siteNow || 0) > 0) return "Banner suppression active on this site right now.";
    if(Number(counts.siteSession || 0) > 0) return "Banner suppression activity recorded for this site in this session.";
    if(Number(counts.siteTimeline || 0) > 0) return "Banner suppression history exists for this site.";
    if(Number(counts.lifetimeBlocked || 0) > 0) return "Banner suppression activity exists in the browser timeline, but not for this site right now.";
    return "No banner suppressed on this site right now.";
  }

  function cgV66EnsureCss(){
    try {
      ["cgV64MetricRowClarityStyle", "cgV65HorizontalMetricStyle"].forEach(function(id){
        var old = document.getElementById(id);
        if(old && old.parentNode) old.parentNode.removeChild(old);
      });

      if(document.getElementById("cgV66BannerTabScopeSiteNowStyle")) return;

      var style = document.createElement("style");
      style.id = "cgV66BannerTabScopeSiteNowStyle";
      style.textContent = [
        "body[data-cg-v66-active-popup-tab='browser-observer'] #cgV32BannerMetrics{display:none!important;}",
        "#cgV32BannerMetrics .cg-grid{display:grid!important;grid-template-columns:repeat(4,minmax(0,1fr))!important;gap:8px!important;}",
        "#cgV32BannerMetrics [data-cg-v66-metric-card='1']{display:flex!important;flex-direction:column!important;align-items:center!important;justify-content:center!important;gap:4px!important;min-height:52px!important;padding:8px 6px!important;text-align:center!important;white-space:normal!important;}",
        "#cgV32BannerMetrics .cg-v66-metric-value{display:block!important;font-size:18px!important;font-weight:900!important;line-height:1!important;font-variant-numeric:tabular-nums!important;}",
        "#cgV32BannerMetrics .cg-v66-metric-label{display:block!important;font-size:10px!important;font-weight:750!important;line-height:1.12!important;opacity:.9!important;text-transform:none!important;}"
      ].join("\\n");

      document.documentElement.appendChild(style);
    } catch(e){}
  }

  function cgV66MetricCard(label, value){
    var card = document.createElement("div");
    card.setAttribute("data-cg-v66-metric-card", "1");
    card.setAttribute("data-cg-v66-metric-label", label);
    card.setAttribute("data-cg-v66-metric-value", String(value));
    card.setAttribute("aria-label", label + ": " + value);

    var v = document.createElement("span");
    v.className = "cg-v66-metric-value";
    v.textContent = String(value);

    var l = document.createElement("span");
    l.className = "cg-v66-metric-label";
    l.textContent = label;

    card.appendChild(v);
    card.appendChild(l);
    return card;
  }

  function cgV66RenderMetrics(panel, counts){
    try {
      var grid = panel.querySelector(".cg-grid");
      if(!grid){
        grid = document.createElement("div");
        grid.className = "cg-grid";
        var status = panel.querySelector(".cg-status, [data-cg-v62-banner-message]");
        if(status && status.parentNode === panel){
          panel.insertBefore(grid, status);
        } else {
          panel.appendChild(grid);
        }
      }

      while(grid.firstChild) grid.removeChild(grid.firstChild);

      grid.appendChild(cgV66MetricCard("this site now", counts.siteNow));
      grid.appendChild(cgV66MetricCard("this session", counts.siteSession));
      grid.appendChild(cgV66MetricCard("site timeline", counts.siteTimeline));
      grid.appendChild(cgV66MetricCard("lifetime blocked", counts.lifetimeBlocked));
    } catch(e){}
  }

  function cgV66RenderMessage(panel, counts){
    try {
      var text = cgV66Message(counts);
      var status = panel.querySelector("[data-cg-v62-banner-message], .cg-status");

      if(!status){
        status = document.createElement("div");
        status.className = "cg-status";
        panel.appendChild(status);
      }

      status.textContent = text;
      status.setAttribute("data-cg-v62-banner-message", "1");
      status.setAttribute("data-cg-v66-message-owner", "1");

      panel.setAttribute("data-cg-v62-banner-message-text", text);
      panel.setAttribute("data-cg-v66-banner-message-text", text);
    } catch(e){}
  }

  function cgV66ActivePopupTab(){
    try {
      var nodes = Array.prototype.slice.call(document.querySelectorAll(".cg-tab.active, .cg-tab[aria-selected='true'], [role='tab'][aria-selected='true'], button.active"));
      for(var i = 0; i < nodes.length; i++){
        var t = String(nodes[i].textContent || "").replace(/\\s+/g, " ").trim().toLowerCase();
        if(t) return t;
      }
    } catch(e){}
    return "";
  }

  function cgV66ApplyScope(panel){
    try {
      var active = cgV66ActivePopupTab();
      var isBrowserObserver = active.indexOf("browser observer") >= 0 || (active.indexOf("observer") >= 0 && active.indexOf("domain") < 0);
      var name = isBrowserObserver ? "browser-observer" : "allowed";
      document.body.setAttribute("data-cg-v66-active-popup-tab", name);
      panel.setAttribute("data-cg-v66-active-popup-tab", name);

      if(isBrowserObserver){
        panel.setAttribute("data-cg-v66-hidden-by-tab-scope", "1");
        panel.style.display = "none";
      } else {
        panel.removeAttribute("data-cg-v66-hidden-by-tab-scope");
        panel.style.removeProperty("display");
      }
    } catch(e){}
  }

  function cgV66Reconcile(){
    try {
      cgV66EnsureCss();

      var panel = cgV66Panel();
      if(!panel) return false;

      var counts = cgV66Counts(panel);

      panel.setAttribute("data-cg-v66-site-now", String(counts.siteNow));
      panel.setAttribute("data-cg-v66-site-session", String(counts.siteSession));
      panel.setAttribute("data-cg-v66-site-timeline", String(counts.siteTimeline));
      panel.setAttribute("data-cg-v66-lifetime-blocked", String(counts.lifetimeBlocked));

      panel.setAttribute("data-cg-v62-site-now", String(counts.siteNow));
      panel.setAttribute("data-cg-v62-site-session", String(counts.siteSession));
      panel.setAttribute("data-cg-v62-site-timeline", String(counts.siteTimeline));
      panel.setAttribute("data-cg-v62-lifetime-blocked", String(counts.lifetimeBlocked));

      panel.setAttribute("data-cg-v61-site-now", String(counts.siteNow));
      panel.setAttribute("data-cg-v61-site-session", String(counts.siteSession));
      panel.setAttribute("data-cg-v61-site-timeline", String(counts.siteTimeline));
      panel.setAttribute("data-cg-v61-lifetime", String(counts.lifetimeBlocked));

      cgV66RenderMetrics(panel, counts);
      cgV66RenderMessage(panel, counts);
      cgV66ApplyScope(panel);

      panel.setAttribute("data-cg-v66-banner-tab-scope-site-now-owner", "1");
      return true;
    } catch(e){
      return false;
    }
  }

  function cgV66Schedule(){
    try { cgV66Reconcile(); } catch(e){}
    setTimeout(cgV66Reconcile, 0);
    setTimeout(cgV66Reconcile, 80);
    setTimeout(cgV66Reconcile, 220);
    setTimeout(cgV66Reconcile, 600);
    setTimeout(cgV66Reconcile, 1200);
    setTimeout(cgV66Reconcile, 2400);
  }

  document.addEventListener("DOMContentLoaded", cgV66Schedule);
  window.addEventListener("load", cgV66Schedule);
  document.addEventListener("click", function(){
    setTimeout(cgV66Reconcile, 0);
    setTimeout(cgV66Reconcile, 80);
    setTimeout(cgV66Reconcile, 250);
    setTimeout(cgV66Reconcile, 700);
  }, true);

  try {
    var obs = new MutationObserver(function(){
      setTimeout(cgV66Reconcile, 50);
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(function(){ try { obs.disconnect(); } catch(e){} }, 8000);
  } catch(e){}

  cgV66Schedule();

  window.CookieGateV66BannerTabScopeSiteNowOwner = {
    ok: true,
    marker: "COOKIEGATE_V66_BANNER_TAB_SCOPE_SITE_NOW_OWNER",
    owner: "ui/popup.js",
    behavior: "hide banner panel on Browser Observer; show on Active Site/Domain Ops; force current-site now when current-site session activity exists"
  };
})();

// COOKIEGATE_V66_BANNER_TAB_SCOPE_SITE_NOW_OWNER
`;

popup = popup.trimEnd() + helper + "\n";

const cssPatch = `

/* COOKIEGATE_V66_BANNER_TAB_SCOPE_SITE_NOW_OWNER_CSS */
body[data-cg-v66-active-popup-tab="browser-observer"] #cgV32BannerMetrics {
  display: none !important;
}

#cgV32BannerMetrics .cg-grid {
  display: grid !important;
  grid-template-columns: repeat(4, minmax(0, 1fr)) !important;
  gap: 8px !important;
}

#cgV32BannerMetrics [data-cg-v66-metric-card="1"] {
  display: flex !important;
  flex-direction: column !important;
  align-items: center !important;
  justify-content: center !important;
  gap: 4px !important;
  min-height: 52px !important;
  padding: 8px 6px !important;
  text-align: center !important;
  white-space: normal !important;
}

#cgV32BannerMetrics .cg-v66-metric-value {
  display: block !important;
  font-size: 18px !important;
  font-weight: 900 !important;
  line-height: 1 !important;
  font-variant-numeric: tabular-nums !important;
}

#cgV32BannerMetrics .cg-v66-metric-label {
  display: block !important;
  font-size: 10px !important;
  font-weight: 750 !important;
  line-height: 1.12 !important;
  opacity: .9 !important;
  text-transform: none !important;
}
`;

css = css.trimEnd() + cssPatch + "\n";

[
  "COOKIEGATE_V66_BANNER_TAB_SCOPE_SITE_NOW_OWNER",
  "function cgV66Reconcile",
  "function cgV66ApplyScope",
  "function cgV66RenderMetrics",
  "function cgV66Counts",
  "if(siteSession > 0 && siteNow < 1)",
  "body.setAttribute(\"data-cg-v66-active-popup-tab\"",
  "browser-observer"
].forEach(function(needle){
  if(popup.indexOf(needle) < 0){
    throw new Error("FINAL_POPUP_TEXT_MISSING: " + needle);
  }
});

[
  "COOKIEGATE_V66_BANNER_TAB_SCOPE_SITE_NOW_OWNER_CSS",
  "grid-template-columns: repeat(4, minmax(0, 1fr))",
  "body[data-cg-v66-active-popup-tab=\"browser-observer\"] #cgV32BannerMetrics"
].forEach(function(needle){
  if(css.indexOf(needle) < 0){
    throw new Error("FINAL_CSS_TEXT_MISSING: " + needle);
  }
});

fs.writeFileSync(popupPath, popup.replace(/\r\n/g, "\n").replace(/\r/g, "\n"), "utf8");
fs.writeFileSync(cssPath, css.replace(/\r\n/g, "\n").replace(/\r/g, "\n"), "utf8");

console.log("PATCH_V66_BANNER_TAB_SCOPE_SITE_NOW_OWNER_OK");
