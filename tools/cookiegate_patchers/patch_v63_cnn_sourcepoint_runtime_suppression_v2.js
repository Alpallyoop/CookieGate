const fs = require("fs");

const file = process.argv[2];
if(!file) throw new Error("RUNTIME_PATH_REQUIRED");

let text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

function requireContains(needle){
  if(text.indexOf(needle) < 0){
    throw new Error("REQUIRED_TEXT_MISSING: " + needle);
  }
}

requireContains("COOKIEGATE_BANNER_SUPPRESSION_RUNTIME_V32");
requireContains("function suppressCandidates(candidates)");
requireContains("function modeAllowsSuppression(mode)");
requireContains("async function scanAndSuppress(reason)");
requireContains("var candidates = scanCandidates();");
requireContains("var suppressed = allowSuppression ? suppressCandidates(candidates) : 0;");

if(text.indexOf("COOKIEGATE_V63_CNN_SOURCEPOINT_RUNTIME_SUPPRESSION") >= 0){
  throw new Error("ALREADY_PATCHED_V63");
}

const candidateLineCount = (text.match(/var candidates = scanCandidates\(\);/g) || []).length;
if(candidateLineCount !== 1){
  throw new Error("UNEXPECTED_SCAN_CANDIDATES_OWNER_COUNT_" + candidateLineCount);
}

const helperAnchor = "  async function scanAndSuppress(reason){";
if(text.indexOf(helperAnchor) < 0){
  throw new Error("SCAN_AND_SUPPRESS_ANCHOR_MISSING");
}

const helper = `
  function cgV63String(value){
    return String(value || "");
  }

  function cgV63Lower(value){
    return cgV63String(value).toLowerCase();
  }

  function cgV63Attr(el, name){
    try { return el && el.getAttribute ? cgV63String(el.getAttribute(name)) : ""; } catch(e){ return ""; }
  }

  function cgV63NodeHay(el){
    try {
      var parts = [
        el && el.id,
        el && el.className,
        cgV63Attr(el, "role"),
        cgV63Attr(el, "aria-label"),
        cgV63Attr(el, "title"),
        cgV63Attr(el, "data-testid"),
        cgV63Attr(el, "data-cy"),
        cgV63Attr(el, "data-test"),
        cgV63Attr(el, "src"),
        el && el.textContent
      ];
      return cgV63Lower(parts.join(" ").slice(0, 12000));
    } catch(e){
      return "";
    }
  }

  function cgV63Visible(el){
    try {
      if(!el || el === document.documentElement || el === document.body) return false;
      if(!document.documentElement.contains(el)) return false;
      var cs = getComputedStyle(el);
      if(!cs) return false;
      if(cs.display === "none") return false;
      if(cs.visibility === "hidden") return false;
      if(Number(cs.opacity || "1") < 0.03) return false;
      var r = el.getBoundingClientRect();
      if(!r) return false;
      if(r.width < 40 || r.height < 20) return false;
      return true;
    } catch(e){
      return false;
    }
  }

  function cgV63StrongKnownVendor(hay){
    return /sourcepoint|sp_message|sp-ccpa|sp-gdpr|sp_choice|onetrust|didomi|osano|quantcast|qc-cmp|trustarc|truste|cookiebot|privacy-manager|privacy_manager|consent-manager|consent_manager/.test(hay);
  }

  function cgV63HasConsentLanguage(hay){
    if(!hay) return false;

    if(cgV63StrongKnownVendor(hay)) return true;

    var primary =
      /\\bcookie\\b|\\bcookies\\b|\\bconsent\\b|\\bprivacy\\b|\\bgdpr\\b|\\bccpa\\b|do not sell|privacy choices|privacy preferences|manage choices|manage preferences|legitimate interest|your choices|ad choices|privacy manager/.test(hay);

    if(!primary) return false;

    var action =
      /\\baccept\\b|\\bagree\\b|\\bcontinue\\b|\\bdecline\\b|\\breject\\b|\\bmanage\\b|\\bpreferences\\b|\\bchoices\\b|\\bsettings\\b|\\bclose\\b|\\bsave\\b|\\bconfirm\\b|\\ballow\\b|\\bdisagree\\b/.test(hay);

    var container =
      /banner|modal|dialog|notice|overlay|popup|pop-up|message|container|cmp|consent|privacy|cookie/.test(hay);

    return action || container;
  }

  function cgV63LooksOverlayLike(el, hay){
    try {
      if(cgV63StrongKnownVendor(hay)) return true;

      var cs = getComputedStyle(el);
      var pos = cgV63Lower(cs && cs.position);
      var z = parseInt((cs && cs.zIndex) || "0", 10);
      var r = el.getBoundingClientRect();
      var vw = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
      var vh = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);

      if(pos === "fixed" || pos === "sticky"){
        if(isNaN(z) || z >= 1) return true;
      }

      if(r && vw && vh){
        var area = (r.width * r.height) / Math.max(1, vw * vh);
        if(area >= 0.12 && (!isNaN(z) && z >= 10)) return true;
        if(area >= 0.22 && cgV63HasConsentLanguage(hay)) return true;
      }

      var role = cgV63Lower(cgV63Attr(el, "role"));
      if(role === "dialog" || role === "alertdialog") return true;

      return /banner|modal|dialog|notice|overlay|popup|pop-up|message|container|cmp|consent|privacy|cookie/.test(hay);
    } catch(e){
      return false;
    }
  }

  function cgV63CandidateElement(el){
    try {
      if(!el || el === document.documentElement || el === document.body) return null;

      var cur = el;
      var best = el;
      var steps = 0;

      while(cur && cur.parentElement && cur.parentElement !== document.body && steps < 6){
        var h = cgV63NodeHay(cur);
        if(cgV63StrongKnownVendor(h) || cgV63LooksOverlayLike(cur, h)){
          best = cur;
        }
        cur = cur.parentElement;
        steps++;
      }

      if(best === document.documentElement || best === document.body) return el;
      return best;
    } catch(e){
      return el;
    }
  }

  function cgV63PushCandidate(out, seen, el, hint, score){
    try {
      var target = cgV63CandidateElement(el);
      if(!target || target === document.documentElement || target === document.body) return;
      if(seen.has(target)) return;

      var hay = cgV63NodeHay(target) + " " + cgV63NodeHay(el);
      var strong = cgV63StrongKnownVendor(hay);

      if(!strong && !cgV63HasConsentLanguage(hay)) return;
      if(!cgV63Visible(target) && !strong) return;

      seen.add(target);
      out.push({
        el: target,
        score: score || (strong ? 120 : 95),
        selector_hint: "v63:" + hint
      });
    } catch(e){}
  }

  function cgV63ExtraCandidates(){
    var out = [];
    var seen = new Set();

    var selectors = [
      "[id*='sp_message' i]",
      "[class*='sp_message' i]",
      "[id*='sourcepoint' i]",
      "[class*='sourcepoint' i]",
      "[id*='sp-ccpa' i]",
      "[class*='sp-ccpa' i]",
      "[id*='sp-gdpr' i]",
      "[class*='sp-gdpr' i]",
      "[class*='sp_choice' i]",
      "[id*='qc-cmp' i]",
      "[class*='qc-cmp' i]",
      "[id*='quantcast' i]",
      "[class*='quantcast' i]",
      "[id*='truste' i]",
      "[class*='truste' i]",
      "[id*='trustarc' i]",
      "[class*='trustarc' i]",
      "[id*='privacy-manager' i]",
      "[class*='privacy-manager' i]",
      "[id*='privacy_manager' i]",
      "[class*='privacy_manager' i]",
      "[id*='consent-manager' i]",
      "[class*='consent-manager' i]",
      "[id*='consent_manager' i]",
      "[class*='consent_manager' i]",
      "[id*='cookie-consent' i]",
      "[class*='cookie-consent' i]",
      "[data-testid*='cookie' i]",
      "[data-testid*='consent' i]",
      "[data-testid*='privacy' i]",
      "[data-cy*='cookie' i]",
      "[data-cy*='consent' i]",
      "iframe[src*='consent' i]",
      "iframe[src*='privacy' i]",
      "iframe[src*='sourcepoint' i]",
      "iframe[src*='onetrust' i]",
      "iframe[src*='quantcast' i]",
      "dialog",
      "[role='dialog']",
      "[role='alertdialog']"
    ];

    selectors.forEach(function(sel){
      try {
        Array.prototype.slice.call(document.querySelectorAll(sel)).forEach(function(el){
          cgV63PushCandidate(out, seen, el, sel, 130);
        });
      } catch(e){}
    });

    try {
      Array.prototype.slice.call(document.querySelectorAll("div, aside, section, article, form")).forEach(function(el){
        var hay = cgV63NodeHay(el);
        if(!cgV63HasConsentLanguage(hay)) return;
        if(!cgV63LooksOverlayLike(el, hay)) return;
        cgV63PushCandidate(out, seen, el, "broad-consent-overlay", 100);
      });
    } catch(e){}

    return out;
  }

  function cgV63MergeCandidates(base){
    var merged = [];
    var seen = new Set();

    try {
      (Array.isArray(base) ? base : []).forEach(function(item){
        if(!item || !item.el) return;
        if(seen.has(item.el)) return;
        seen.add(item.el);
        merged.push(item);
      });
    } catch(e){}

    try {
      cgV63ExtraCandidates().forEach(function(item){
        if(!item || !item.el) return;
        if(seen.has(item.el)) return;
        seen.add(item.el);
        merged.push(item);
      });
    } catch(e){}

    return merged;
  }

  function cgV63ReleasePageLocks(){
    try {
      [document.documentElement, document.body].forEach(function(el){
        if(!el || !el.style) return;
        var cs = getComputedStyle(el);
        if(cs && (cs.overflow === "hidden" || cs.overflowY === "hidden")){
          el.style.setProperty("overflow", "auto", "important");
          el.style.setProperty("overflow-y", "auto", "important");
        }
      });
    } catch(e){}
  }

  // COOKIEGATE_V63_CNN_SOURCEPOINT_RUNTIME_SUPPRESSION_HELPERS
`;

text = text.replace(helperAnchor, helper.trimEnd() + "\n\n" + helperAnchor);
text = text.replace("var candidates = scanCandidates();", "var candidates = cgV63MergeCandidates(scanCandidates());");
text = text.replace(
  "var suppressed = allowSuppression ? suppressCandidates(candidates) : 0;",
  "var suppressed = allowSuppression ? suppressCandidates(candidates) : 0;\n    try { if(allowSuppression && suppressed > 0) cgV63ReleasePageLocks(); } catch(e){}"
);

const finalMarker = `

try {
  window.CookieGateV63CnnSourcepointRuntimeSuppression = {
    ok: true,
    marker: "COOKIEGATE_V63_CNN_SOURCEPOINT_RUNTIME_SUPPRESSION",
    owner: "banner_suppression_runtime_v32.js",
    note: "Augments active suppression candidates for Sourcepoint/CNN/common CMP overlays without touching popup semantics."
  };
} catch(e){}

// COOKIEGATE_V63_CNN_SOURCEPOINT_RUNTIME_SUPPRESSION
`;

text = text.trimEnd() + finalMarker + "\n";

[
  "COOKIEGATE_V63_CNN_SOURCEPOINT_RUNTIME_SUPPRESSION",
  "COOKIEGATE_V63_CNN_SOURCEPOINT_RUNTIME_SUPPRESSION_HELPERS",
  "function cgV63MergeCandidates",
  "function cgV63ExtraCandidates",
  "function cgV63ReleasePageLocks",
  "var candidates = cgV63MergeCandidates(scanCandidates());"
].forEach(function(needle){
  if(text.indexOf(needle) < 0){
    throw new Error("FINAL_TEXT_MISSING: " + needle);
  }
});

fs.writeFileSync(file, text.replace(/\r\n/g, "\n").replace(/\r/g, "\n"), "utf8");
console.log("PATCH_V63_CNN_SOURCEPOINT_RUNTIME_SUPPRESSION_V2_OK");
