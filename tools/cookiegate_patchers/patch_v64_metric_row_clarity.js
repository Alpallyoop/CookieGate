const fs = require("fs");

const file = process.argv[2];
if(!file) throw new Error("POPUP_PATH_REQUIRED");

let text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

function req(s){
  if(text.indexOf(s) < 0) throw new Error("REQUIRED_TEXT_MISSING: " + s);
}

req("COOKIEGATE_V62_BANNER_SEMANTICS_CANONICAL_OWNER");
req("function cgV62ApplyBannerMessage");
req("function cgV60ReconcileBannerMetrics");
req("grid.appendChild(metric(\"this site now\"");
req("grid.appendChild(metric(\"this session\"");
req("grid.appendChild(metric(\"site timeline\"");
req("grid.appendChild(metric(\"lifetime blocked\"");

if(text.indexOf("COOKIEGATE_V64_METRIC_ROW_CLARITY") >= 0){
  throw new Error("ALREADY_PATCHED_V64");
}

const anchor = "  function cgV60SetBannerMessage(panel, counts){";
if(text.indexOf(anchor) < 0) throw new Error("V64_INSERT_ANCHOR_MISSING");

const helper = `
  function cgV64MetricNumber(text){
    var m = String(text || "").match(/\\d+/);
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
          var raw = String(row.textContent || "").replace(/\\s+/g, " ").trim();
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
      ].join("\\n");

      document.documentElement.appendChild(style);
    } catch(e){}
  }

  // COOKIEGATE_V64_METRIC_ROW_CLARITY_HELPERS
`;

text = text.replace(anchor, helper.trimEnd() + "\n\n" + anchor);

text = text.replace(
  "panel.appendChild(grid);\n\n    var status = document.createElement(\"div\");",
  "panel.appendChild(grid);\n    try { cgV64NormalizeBannerMetricRows(panel); } catch(e){}\n\n    var status = document.createElement(\"div\");"
);

text = text.replace(
  "cgV60SetBannerMessage(panel, counts);\n\n          panel.setAttribute(\"data-cg-v60-banner-reconciled\", \"1\");",
  "cgV60SetBannerMessage(panel, counts);\n          try { cgV64NormalizeBannerMetricRows(panel); } catch(e){}\n\n          panel.setAttribute(\"data-cg-v60-banner-reconciled\", \"1\");"
);

text = text.replace(
  "cgV61SetMessage(panel, counts);\n      panel.setAttribute(\"data-cg-v61-banner-message-reconciled\", \"1\");",
  "cgV61SetMessage(panel, counts);\n      try { cgV64NormalizeBannerMetricRows(panel); } catch(e){}\n      panel.setAttribute(\"data-cg-v61-banner-message-reconciled\", \"1\");"
);

const marker = `

try {
  window.CookieGateV64MetricRowClarity = {
    ok: true,
    marker: "COOKIEGATE_V64_METRIC_ROW_CLARITY",
    owner: "ui/popup.js",
    note: "Renders Banner Suppression metrics as label-colon-value rows to remove value/label ambiguity."
  };
} catch(e){}

// COOKIEGATE_V64_METRIC_ROW_CLARITY
`;

text = text.trimEnd() + marker + "\n";

[
  "COOKIEGATE_V64_METRIC_ROW_CLARITY",
  "COOKIEGATE_V64_METRIC_ROW_CLARITY_HELPERS",
  "function cgV64NormalizeBannerMetricRows",
  "function cgV64EnsureMetricRowCss",
  "data-cg-v64-metric-row",
  "cgV64NormalizeBannerMetricRows(panel)"
].forEach(function(needle){
  if(text.indexOf(needle) < 0){
    throw new Error("FINAL_TEXT_MISSING: " + needle);
  }
});

fs.writeFileSync(file, text, "utf8");
console.log("PATCH_V64_METRIC_ROW_CLARITY_OK");
