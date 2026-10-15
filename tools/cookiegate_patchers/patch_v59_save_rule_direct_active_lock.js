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

function replaceFunction(src, name, replacement) {
  const r = findFunctionRange(src, name);
  return src.slice(0, r.start) + replacement.trimEnd() + src.slice(r.end);
}

const beforeSave = findFunctionRange(text, "saveInputRule").text;
const beforeRenderRules = findFunctionRange(text, "renderDomainRules").text;
const beforeHeader = findFunctionRange(text, "renderHeader").text;

if (!/COOKIEGATE_V58_CSS_ONLY_RULE_BUTTON_SPACING/.test(text)) {
  throw new Error("SOURCE_IS_NOT_V58_CSS_ONLY_BUILD");
}

if (!/Saved rule for/.test(beforeSave)) {
  throw new Error("SAVE_INPUT_RULE_OWNER_UNEXPECTED");
}

const directLockHelper = `
  function cgV59DirectLockVisibleActiveSiteFromSavedRule(domain, mode){
    try {
      var normalizedMode = String(mode || "strict").toLowerCase();
      var label = normalizedMode.charAt(0).toUpperCase() + normalizedMode.slice(1);

      if(typeof state === "object" && state){
        state.siteMode = normalizedMode;
        state.effectiveMode = normalizedMode;
      }

      localStorage.setItem("cookiegate.siteMode:" + domain, normalizedMode);
      localStorage.setItem("cookiegate.siteMode:www." + domain, normalizedMode);

      var currentSite = "";
      try {
        currentSite = String((state && state.site) || "").toLowerCase();
      } catch(e){}

      if(currentSite){
        localStorage.setItem("cookiegate.siteMode:" + currentSite, normalizedMode);
      }

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
`;

let save = beforeSave;

if (/COOKIEGATE_V59_DIRECT_ACTIVE_SITE_LOCK_AFTER_SAVE/.test(save)) {
  throw new Error("SAVE_INPUT_RULE_ALREADY_PATCHED_V59");
}

save = save.replace(
  /setStatus\("Saved rule for " \+ n\.domain \+ "\. Status: active"\);\s*renderDomainRules\(\);/,
  `setStatus("Saved rule for " + n.domain + ". Status: active");
    renderDomainRules();

    cgV59DirectLockVisibleActiveSiteFromSavedRule(n.domain, next.mode);
    setTimeout(function(){ cgV59DirectLockVisibleActiveSiteFromSavedRule(n.domain, next.mode); }, 0);
    setTimeout(function(){ cgV59DirectLockVisibleActiveSiteFromSavedRule(n.domain, next.mode); }, 100);
    setTimeout(function(){ cgV59DirectLockVisibleActiveSiteFromSavedRule(n.domain, next.mode); }, 300);

    // COOKIEGATE_V59_DIRECT_ACTIVE_SITE_LOCK_AFTER_SAVE`
);

if (!/COOKIEGATE_V59_DIRECT_ACTIVE_SITE_LOCK_AFTER_SAVE/.test(save)) {
  throw new Error("SAVE_PATCH_INSERTION_FAILED");
}

text = text.slice(0, findFunctionRange(text, "saveInputRule").start) +
  directLockHelper.trimEnd() + "\n\n" +
  save.trimEnd() +
  text.slice(findFunctionRange(text, "saveInputRule").end);

const afterSave = findFunctionRange(text, "saveInputRule").text;
const afterRenderRules = findFunctionRange(text, "renderDomainRules").text;
const afterHeader = findFunctionRange(text, "renderHeader").text;

if (afterRenderRules !== beforeRenderRules) throw new Error("RENDER_DOMAIN_RULES_CHANGED_UNEXPECTEDLY");
if (afterHeader !== beforeHeader) throw new Error("RENDER_HEADER_CHANGED_UNEXPECTEDLY");
if (!/cgV59DirectLockVisibleActiveSiteFromSavedRule/.test(text)) throw new Error("DIRECT_LOCK_HELPER_MISSING");
if (!/COOKIEGATE_V59_DIRECT_ACTIVE_SITE_LOCK_AFTER_SAVE/.test(afterSave)) throw new Error("SAVE_LOCK_MARKER_MISSING");
if (!/siteModeSelect\.disabled = true/.test(text)) throw new Error("DIRECT_LOCK_SELECT_DISABLE_MISSING");
if (!/effectiveStat/.test(text)) throw new Error("DIRECT_LOCK_EFFECTIVE_STAT_MISSING");
if (/async\s+async\s+function/.test(text)) throw new Error("DOUBLE_ASYNC_PRESENT");
if (/stafunction/.test(text)) throw new Error("STAFUNCTION_CORRUPTION_PRESENT");

text = text.trimEnd() + `

// COOKIEGATE_V59_SAVE_RULE_DIRECT_ACTIVE_LOCK
window.CookieGateV59SaveRuleDirectActiveLock = {
  patch: "save-rule-directly-locks-visible-active-site-controls",
  changed_functions: ["saveInputRule"],
  source: "v58-css-only-rule-button-spacing"
};
`;

fs.writeFileSync(popupPath, text.replace(/\r\n/g, "\n").replace(/\r/g, "\n") + "\n", "utf8");
