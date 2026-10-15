const fs = require("fs");

const popupPath = process.argv[2];
if (!popupPath) throw new Error("POPUP_PATH_REQUIRED");

let text = fs.readFileSync(popupPath, "utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

function findFunctionRange(src, name) {
  const re = new RegExp("(async\\s+)?function\\s+" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\([^)]*\\)\\s*\\{", "g");
  const m = re.exec(src);
  if (!m) throw new Error("FUNCTION_NOT_FOUND: " + name);

  let open = src.indexOf("{", m.index);
  if (open < 0) throw new Error("OPEN_BRACE_NOT_FOUND: " + name);

  let i = open;
  let depth = 0;
  let inString = false;
  let quote = "";
  let escape = false;
  let inLineComment = false;
  let inBlockComment = false;

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      i++;
      continue;
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === quote) {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 2;
      continue;
    }

    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }

    if (ch === "\"" || ch === "'" || ch === "`") {
      inString = true;
      quote = ch;
      i++;
      continue;
    }

    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        return { start: m.index, end: i + 1, text: src.slice(m.index, i + 1) };
      }
    }

    i++;
  }

  throw new Error("FUNCTION_END_NOT_FOUND: " + name);
}

const beforeRenderMetricsRange = findFunctionRange(text, "renderMetrics");
const beforeRenderMetrics = beforeRenderMetricsRange.text;
const beforeRenderDomainRules = findFunctionRange(text, "renderDomainRules").text;
const beforeSaveInputRule = findFunctionRange(text, "saveInputRule").text;
const beforeRenderHeader = findFunctionRange(text, "renderHeader").text;

if (!/COOKIEGATE_V59_SAVE_RULE_DIRECT_ACTIVE_LOCK_FIXED/.test(text)) {
  throw new Error("SOURCE_IS_NOT_WORKING_V59_FIXED_BUILD");
}

if (!/No banner suppressed on this site right now/.test(beforeRenderMetrics)) {
  throw new Error("RENDER_METRICS_DOES_NOT_OWN_EMPTY_BANNER_MESSAGE");
}

if (!/this site now/.test(beforeRenderMetrics) || !/this session/.test(beforeRenderMetrics) || !/site timeline/.test(beforeRenderMetrics) || !/lifetime blocked/.test(beforeRenderMetrics)) {
  throw new Error("RENDER_METRICS_DOES_NOT_OWN_VISIBLE_BANNER_COUNTER_LABELS");
}

if (/COOKIEGATE_V60_BANNER_METRICS_RECONCILE/.test(text)) {
  throw new Error("V60_ALREADY_PATCHED");
}

const helper = `
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
        var lines = String(document.body.innerText || "").split("\\n");
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

  function cgV60BannerTryParse(value){
    if(typeof value !== "string") return value;
    var s = value.trim();
    if(!s) return value;
    if((s[0] === "{" && s[s.length - 1] === "}") || (s[0] === "[" && s[s.length - 1] === "]")){
      try { return JSON.parse(s); } catch(e){}
    }
    return value;
  }

  function cgV60BannerExtractHost(obj){
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

  function cgV60BannerExtractTime(obj){
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

  function cgV60BannerLooksLikeEvent(obj, keyHint){
    try {
      var blob = (String(keyHint || "") + " " + JSON.stringify(obj || {})).toLowerCase();
      if(blob.indexOf("banner") < 0 && blob.indexOf("suppression") < 0 && blob.indexOf("consent") < 0 && blob.indexOf("cmp") < 0 && blob.indexOf("osano") < 0 && blob.indexOf("onetrust") < 0 && blob.indexOf("privacy") < 0) return false;
      if((blob.indexOf("setting") >= 0 || blob.indexOf("config") >= 0 || blob.indexOf("options") >= 0 || blob.indexOf("preference") >= 0 || blob.indexOf("schema") >= 0 || blob.indexOf("style") >= 0) &&
         blob.indexOf("blocked") < 0 && blob.indexOf("suppressed") < 0 && blob.indexOf("removed") < 0 && blob.indexOf("hidden") < 0 && blob.indexOf("dismissed") < 0 && blob.indexOf("detected") < 0 && blob.indexOf("matched") < 0){
        return false;
      }
      return blob.indexOf("blocked") >= 0 || blob.indexOf("suppressed") >= 0 || blob.indexOf("removed") >= 0 || blob.indexOf("hidden") >= 0 || blob.indexOf("dismissed") >= 0 || blob.indexOf("detected") >= 0 || blob.indexOf("matched") >= 0 || blob.indexOf("banner") >= 0;
    } catch(e){
      return false;
    }
  }

  function cgV60BannerCollect(value, keyHint, out, depth){
    if(depth > 8) return;
    value = cgV60BannerTryParse(value);

    if(Array.isArray(value)){
      value.forEach(function(v){ cgV60BannerCollect(v, keyHint, out, depth + 1); });
      return;
    }

    if(value && typeof value === "object"){
      if(cgV60BannerLooksLikeEvent(value, keyHint)){
        out.push({
          key: String(keyHint || ""),
          host: cgV60BannerExtractHost(value),
          time: cgV60BannerExtractTime(value),
          raw: value
        });
      }

      Object.keys(value).forEach(function(k){
        cgV60BannerCollect(value[k], String(keyHint || "") + "." + k, out, depth + 1);
      });
    }
  }

  function cgV60BannerFindPanel(){
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

  function cgV60BannerSetMetric(panel, label, value, fallbackIndex){
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

  function cgV60BannerSetMessage(panel, counts){
    try {
      var all = Array.from(panel.querySelectorAll("*"));
      var msg = all.find(function(el){
        return String(el.textContent || "").trim() === "No banner suppressed on this site right now.";
      });

      if(!msg){
        msg = all.find(function(el){
          var t = String(el.textContent || "");
          return (t.indexOf("No banner suppressed") >= 0 || t.indexOf("banner suppressed") >= 0 || t.indexOf("Banner suppression") >= 0) && t.length < 180;
        });
      }

      if(!msg) return;

      if(counts.siteNow > 0){
        msg.textContent = "Banner suppression active on this site right now.";
      } else if(counts.siteSession > 0){
        msg.textContent = "Banner suppression activity recorded for this site in this session.";
      } else if(counts.siteTimeline > 0){
        msg.textContent = "Banner suppression history exists for this site.";
      } else if(counts.allSession > 0 || counts.allLifetime > 0){
        msg.textContent = "Banner suppression activity exists in the browser timeline, but not for this site right now.";
      } else {
        msg.textContent = "No banner suppressed on this site right now.";
      }
    } catch(e){}
  }

  function cgV60BannerReconcileMetrics(){
    try {
      var panel = cgV60BannerFindPanel();
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
              cgV60BannerCollect(store[k], k, events, 0);
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

          var counts = {
            siteNow: siteNow,
            siteSession: siteSession,
            siteTimeline: siteTimeline,
            allSession: allSession,
            allLifetime: allLifetime
          };

          cgV60BannerSetMetric(panel, "this site now", counts.siteNow, 0);
          cgV60BannerSetMetric(panel, "this session", counts.siteSession, 1);
          cgV60BannerSetMetric(panel, "site timeline", counts.siteTimeline, 2);
          cgV60BannerSetMetric(panel, "lifetime blocked", counts.allLifetime, 3);
          cgV60BannerSetMessage(panel, counts);

          panel.setAttribute("data-cg-v60-banner-reconciled", "1");
          panel.setAttribute("data-cg-v60-banner-all-session", String(counts.allSession));
          panel.setAttribute("data-cg-v60-banner-all-lifetime", String(counts.allLifetime));
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
`;

let patchedRenderMetrics = beforeRenderMetrics;
const insertAt = patchedRenderMetrics.lastIndexOf("}");
if(insertAt < 0) throw new Error("RENDER_METRICS_FINAL_BRACE_NOT_FOUND");

patchedRenderMetrics =
  patchedRenderMetrics.slice(0, insertAt) +
  `
    try { cgV60BannerReconcileMetrics(); } catch(e){}
    setTimeout(function(){ try { cgV60BannerReconcileMetrics(); } catch(e){} }, 80);
    setTimeout(function(){ try { cgV60BannerReconcileMetrics(); } catch(e){} }, 300);
    // COOKIEGATE_V60_BANNER_METRICS_RECONCILE_CALL
` +
  patchedRenderMetrics.slice(insertAt);

text =
  text.slice(0, beforeRenderMetricsRange.start) +
  helper.trimEnd() + "\n\n" +
  patchedRenderMetrics.trimEnd() +
  text.slice(beforeRenderMetricsRange.end);

const afterRenderMetrics = findFunctionRange(text, "renderMetrics").text;
const afterRenderDomainRules = findFunctionRange(text, "renderDomainRules").text;
const afterSaveInputRule = findFunctionRange(text, "saveInputRule").text;
const afterRenderHeader = findFunctionRange(text, "renderHeader").text;

if(afterRenderDomainRules !== beforeRenderDomainRules) throw new Error("RENDER_DOMAIN_RULES_CHANGED_UNEXPECTEDLY");
if(afterSaveInputRule !== beforeSaveInputRule) throw new Error("SAVE_INPUT_RULE_CHANGED_UNEXPECTEDLY");
if(afterRenderHeader !== beforeRenderHeader) throw new Error("RENDER_HEADER_CHANGED_UNEXPECTEDLY");
if(!/COOKIEGATE_V60_BANNER_METRICS_RECONCILE_CALL/.test(afterRenderMetrics)) throw new Error("RENDER_METRICS_CALL_MARKER_MISSING");
if(!/cgV60BannerReconcileMetrics/.test(text)) throw new Error("V60_RECONCILE_HELPER_MISSING");
if(!/this site now/.test(text) || !/this session/.test(text) || !/site timeline/.test(text) || !/lifetime blocked/.test(text)) throw new Error("VISIBLE_COUNTER_LABELS_MISSING");
if(/async\s+async\s+function/.test(text)) throw new Error("DOUBLE_ASYNC_PRESENT");
if(/stafunction/.test(text)) throw new Error("STAFUNCTION_CORRUPTION_PRESENT");
if(/\\\/\\\//.test(text)) throw new Error("OVER_ESCAPED_REGEX_SLASH_PRESENT");

text = text.trimEnd() + `

// COOKIEGATE_V60_BANNER_METRICS_RECONCILE_FIXED
window.CookieGateV60BannerMetricsReconcileFixed = {
  patch: "align-banner-site-now-session-timeline-and-all-lifetime-counters",
  changed_functions: ["renderMetrics"],
  source: "v59-save-rule-direct-active-lock-fixed"
};
`;

fs.writeFileSync(popupPath, text.replace(/\r\n/g, "\n").replace(/\r/g, "\n") + "\n", "utf8");
