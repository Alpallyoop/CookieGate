const fs = require("fs");

const popupPath = process.argv[2];
if(!popupPath) throw new Error("POPUP_PATH_REQUIRED");

let text = fs.readFileSync(popupPath, "utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

function esc(s){
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findFunctionRange(src, name){
  const re = new RegExp("(async\\s+)?function\\s+" + esc(name) + "\\s*\\([^)]*\\)\\s*\\{", "g");
  const m = re.exec(src);
  if(!m) throw new Error("FUNCTION_NOT_FOUND: " + name);

  const open = src.indexOf("{", m.index);
  if(open < 0) throw new Error("OPEN_BRACE_NOT_FOUND: " + name);

  let depth = 0;
  let inString = false;
  let quote = "";
  let escapeNext = false;
  let inLineComment = false;
  let inBlockComment = false;

  for(let i = open; i < src.length; i++){
    const ch = src[i];
    const next = src[i + 1] || "";

    if(inLineComment){
      if(ch === "\n") inLineComment = false;
      continue;
    }

    if(inBlockComment){
      if(ch === "*" && next === "/"){
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if(inString){
      if(escapeNext){
        escapeNext = false;
      } else if(ch === "\\"){
        escapeNext = true;
      } else if(ch === quote){
        inString = false;
      }
      continue;
    }

    if(ch === "/" && next === "/"){
      inLineComment = true;
      i++;
      continue;
    }

    if(ch === "/" && next === "*"){
      inBlockComment = true;
      i++;
      continue;
    }

    if(ch === "\"" || ch === "'" || ch === "`"){
      inString = true;
      quote = ch;
      continue;
    }

    if(ch === "{") depth++;
    if(ch === "}"){
      depth--;
      if(depth === 0){
        return {
          start: m.index,
          end: i + 1,
          text: src.slice(m.index, i + 1)
        };
      }
    }
  }

  throw new Error("FUNCTION_END_NOT_FOUND: " + name);
}

function replaceFunction(src, name, replacement){
  const r = findFunctionRange(src, name);
  return src.slice(0, r.start) + replacement.trimEnd() + src.slice(r.end);
}

function requireContains(src, needle){
  if(src.indexOf(needle) < 0) throw new Error("REQUIRED_TEXT_MISSING: " + needle);
}

requireContains(text, "function cgV60SetBannerMessage");
requireContains(text, "function cgV60ReconcileBannerMetrics");
requireContains(text, "async function renderMetrics");
requireContains(text, "function cgV61MetricFromText");
requireContains(text, "function cgV61SetMessage");
requireContains(text, "function cgV61Reconcile");

if(/COOKIEGATE_V62_BANNER_SEMANTICS_CANONICAL_OWNER/.test(text)){
  throw new Error("ALREADY_PATCHED_V62");
}

const beforeRenderMetrics = findFunctionRange(text, "renderMetrics").text;
const beforeV60SetMessage = findFunctionRange(text, "cgV60SetBannerMessage").text;
const beforeV60Reconcile = findFunctionRange(text, "cgV60ReconcileBannerMetrics").text;
const beforeV61MetricFromText = findFunctionRange(text, "cgV61MetricFromText").text;
const beforeV61SetMessage = findFunctionRange(text, "cgV61SetMessage").text;
const beforeV61Reconcile = findFunctionRange(text, "cgV61Reconcile").text;

if(!/status\.textContent = siteSuppressed > 0 \? "Suppression active for this site\." : "No banner suppressed on this site right now\.";/.test(beforeRenderMetrics)){
  throw new Error("RENDER_METRICS_STATUS_OWNER_UNEXPECTED");
}

if(!/cgV60SetBannerMetric\(panel, "this session", counts\.siteSession, 1\);/.test(beforeV60Reconcile)){
  throw new Error("V60_RECONCILE_COUNTER_OWNER_UNEXPECTED");
}

if(!/counts\.allSession > 0 \|\| counts\.allLifetime > 0/.test(beforeV60SetMessage)){
  throw new Error("V60_MESSAGE_OWNER_UNEXPECTED");
}

if(!/siteSession: cgV61MetricFromText\(panel, "this session"\)/.test(beforeV61Reconcile)){
  throw new Error("V61_RECONCILE_OWNER_UNEXPECTED");
}

const helper = `
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
    var m = String(value || "").match(/\\d+/);
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
`;

const insertPoint = findFunctionRange(text, "cgV60SetBannerMessage").start;
text = text.slice(0, insertPoint) + helper.trimEnd() + "\n\n" + text.slice(insertPoint);

text = replaceFunction(text, "cgV60SetBannerMessage", `
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
`);

let renderMetrics = findFunctionRange(text, "renderMetrics").text;
renderMetrics = renderMetrics.replace(
  'status.textContent = siteSuppressed > 0 ? "Suppression active for this site." : "No banner suppressed on this site right now.";',

  `status.textContent = cgV62BannerMessageText({
      siteNow: siteSuppressed,
      siteSession: sessionSuppressed,
      siteTimeline: totalEvents,
      lifetimeBlocked: lifetimeSuppressed
    });
    status.setAttribute("data-cg-v62-banner-message", "1");`
);

renderMetrics = renderMetrics.replace(
  `try { cgV60ReconcileBannerMetrics(); } catch(e){}
    setTimeout(function(){ try { cgV60ReconcileBannerMetrics(); } catch(e){} }, 80);
    setTimeout(function(){ try { cgV60ReconcileBannerMetrics(); } catch(e){} }, 300);
    // COOKIEGATE_V60_BANNER_METRICS_RECONCILE_CLEAN_CALL`,

  `try { cgV60ReconcileBannerMetrics(); } catch(e){}
    try { if(typeof cgV61Schedule === "function") cgV61Schedule(); } catch(e){}
    setTimeout(function(){ try { cgV60ReconcileBannerMetrics(); } catch(e){} try { if(typeof cgV61Schedule === "function") cgV61Schedule(); } catch(e){} }, 80);
    setTimeout(function(){ try { cgV60ReconcileBannerMetrics(); } catch(e){} try { if(typeof cgV61Schedule === "function") cgV61Schedule(); } catch(e){} }, 300);
    setTimeout(function(){ try { cgV60ReconcileBannerMetrics(); } catch(e){} try { if(typeof cgV61Schedule === "function") cgV61Schedule(); } catch(e){} }, 900);
    // COOKIEGATE_V62_BANNER_SEMANTICS_RENDER_METRICS_RECONCILE_CALL`
);

if(!/COOKIEGATE_V62_BANNER_SEMANTICS_RENDER_METRICS_RECONCILE_CALL/.test(renderMetrics)){
  throw new Error("RENDER_METRICS_V62_PATCH_FAILED");
}

text = replaceFunction(text, "renderMetrics", renderMetrics);

let v60Reconcile = findFunctionRange(text, "cgV60ReconcileBannerMetrics").text;
v60Reconcile = v60Reconcile.replace(
  `panel.setAttribute("data-cg-v60-banner-reconciled", "1");
          panel.setAttribute("data-cg-v60-banner-all-session", String(counts.allSession));
          panel.setAttribute("data-cg-v60-banner-all-lifetime", String(counts.allLifetime));`,

  `panel.setAttribute("data-cg-v60-banner-reconciled", "1");
          panel.setAttribute("data-cg-v62-site-now", String(counts.siteNow));
          panel.setAttribute("data-cg-v62-site-session", String(counts.siteSession));
          panel.setAttribute("data-cg-v62-site-timeline", String(counts.siteTimeline));
          panel.setAttribute("data-cg-v62-lifetime-blocked", String(counts.allLifetime));
          panel.setAttribute("data-cg-v60-banner-all-session", String(counts.allSession));
          panel.setAttribute("data-cg-v60-banner-all-lifetime", String(counts.allLifetime));
          try { if(typeof cgV61Reconcile === "function") cgV61Reconcile(); } catch(e){}

          // COOKIEGATE_V62_BANNER_SEMANTICS_COUNTER_ATTRS`
);

if(!/COOKIEGATE_V62_BANNER_SEMANTICS_COUNTER_ATTRS/.test(v60Reconcile)){
  throw new Error("V60_RECONCILE_ATTR_PATCH_FAILED");
}

text = replaceFunction(text, "cgV60ReconcileBannerMetrics", v60Reconcile);

text = replaceFunction(text, "cgV61MetricFromText", `
  function cgV61MetricFromText(panel, label){
    try {
      var lines = String(panel.textContent || "")
        .split(/\\n+/)
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
`);

text = replaceFunction(text, "cgV61SetMessage", `
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
`);

text = replaceFunction(text, "cgV61Reconcile", `
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
      panel.setAttribute("data-cg-v61-banner-message-reconciled", "1");
      panel.setAttribute("data-cg-v61-site-now", String(counts.siteNow));
      panel.setAttribute("data-cg-v61-site-session", String(counts.siteSession));
      panel.setAttribute("data-cg-v61-site-timeline", String(counts.siteTimeline));
      panel.setAttribute("data-cg-v61-lifetime", String(counts.lifetime));

      // COOKIEGATE_V62_BANNER_SEMANTICS_V61_RECONCILE_CANONICAL
    } catch(e){}
  }
`);

const finalChecks = [
  "function cgV62BannerMessageText",
  "function cgV62ApplyBannerMessage",
  "COOKIEGATE_V62_BANNER_SEMANTICS_RENDER_METRICS_RECONCILE_CALL",
  "COOKIEGATE_V62_BANNER_SEMANTICS_COUNTER_ATTRS",
  "COOKIEGATE_V62_BANNER_SEMANTICS_V61_RECONCILE_CANONICAL",
  "Banner suppression active on this site right now.",
  "Banner suppression activity recorded for this site in this session.",
  "Banner suppression history exists for this site.",
  "Banner suppression activity exists in the browser timeline, but not for this site right now.",
  "No banner suppressed on this site right now."
];

for(const c of finalChecks){
  if(text.indexOf(c) < 0) throw new Error("FINAL_CHECK_MISSING: " + c);
}

if(/stafunction/.test(text)) throw new Error("STAFUNCTION_CORRUPTION_PRESENT");
if(/async\s+async\s+function/.test(text)) throw new Error("DOUBLE_ASYNC_PRESENT");
if(/COOKIEGATE_V62_BANNER_SEMANTICS_CANONICAL_OWNER/.test(text)) throw new Error("DUPLICATE_V62_MARKER_BEFORE_APPEND");

text = text.trimEnd() + `

// COOKIEGATE_V62_BANNER_SEMANTICS_CANONICAL_OWNER
window.CookieGateV62BannerSemanticsCanonicalOwner = {
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
`;

fs.writeFileSync(popupPath, text.replace(/\r\n/g, "\n").replace(/\r/g, "\n") + "\n", "utf8");
