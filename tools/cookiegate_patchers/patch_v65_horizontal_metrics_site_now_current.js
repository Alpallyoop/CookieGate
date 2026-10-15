const fs = require("fs");

const file = process.argv[2];
if(!file) throw new Error("POPUP_PATH_REQUIRED");

let text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

function req(s){
  if(text.indexOf(s) < 0) throw new Error("REQUIRED_TEXT_MISSING: " + s);
}

req("COOKIEGATE_V64_METRIC_ROW_CLARITY");
req("function cgV64NormalizeBannerMetricRows");
req("function cgV60ReconcileBannerMetrics");
req("var siteNow = siteEvents.filter(function(ev){");
req("return ev.time && (now - ev.time) <= 30000;");
req("function cgV60SetBannerMessage(panel, counts){");

if(text.indexOf("COOKIEGATE_V65_HORIZONTAL_METRICS_SITE_NOW_CURRENT") >= 0){
  throw new Error("ALREADY_PATCHED_V65");
}

const helperAnchor = "  function cgV60SetBannerMessage(panel, counts){";
const helper = `
  function cgV65MetricNumber(value){
    var m = String(value || "").match(/\\d+/);
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
          var raw = String(row.textContent || "").replace(/\\s+/g, " ").trim();
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
      ].join("\\n");

      document.documentElement.appendChild(style);
    } catch(e){}
  }

  // COOKIEGATE_V65_HORIZONTAL_METRICS_SITE_NOW_CURRENT_HELPERS
`;

text = text.replace(helperAnchor, helper.trimEnd() + "\n\n" + helperAnchor);

const siteNowNeedle = `          var siteNow = siteEvents.filter(function(ev){
            return ev.time && (now - ev.time) <= 30000;
          }).length;`;

const siteNowPatch = `          var siteNow = siteEvents.filter(function(ev){
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
          } catch(e){}`;

if(text.indexOf(siteNowNeedle) < 0){
  throw new Error("SITE_NOW_OWNER_BLOCK_MISSING");
}

text = text.replace(siteNowNeedle, siteNowPatch);

text = text.replaceAll(
  "cgV64NormalizeBannerMetricRows(panel);",
  "cgV64NormalizeBannerMetricRows(panel); try { cgV65NormalizeBannerMetricRows(panel); } catch(e){}"
);

const marker = `

try {
  window.CookieGateV65HorizontalMetricsSiteNowCurrent = {
    ok: true,
    marker: "COOKIEGATE_V65_HORIZONTAL_METRICS_SITE_NOW_CURRENT",
    owner: "ui/popup.js",
    note: "Restores compact horizontal Banner Suppression metrics and makes this-site-now reflect current-site session suppression."
  };
} catch(e){}

// COOKIEGATE_V65_HORIZONTAL_METRICS_SITE_NOW_CURRENT
`;

text = text.trimEnd() + marker + "\n";

[
  "COOKIEGATE_V65_HORIZONTAL_METRICS_SITE_NOW_CURRENT",
  "COOKIEGATE_V65_HORIZONTAL_METRICS_SITE_NOW_CURRENT_HELPERS",
  "function cgV65NormalizeBannerMetricRows",
  "function cgV65EnsureMetricCss",
  "if(siteSession > 0 && siteNow < 1) siteNow = 1;",
  "grid-template-columns:repeat(2,minmax(0,1fr))"
].forEach(function(needle){
  if(text.indexOf(needle) < 0){
    throw new Error("FINAL_TEXT_MISSING: " + needle);
  }
});

fs.writeFileSync(file, text, "utf8");
console.log("PATCH_V65_HORIZONTAL_METRICS_SITE_NOW_CURRENT_OK");
