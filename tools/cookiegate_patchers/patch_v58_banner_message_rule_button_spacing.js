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
const beforeHeader = findFunctionRange(text, "renderHeader").text;
const beforeLock = findFunctionRange(text, "applyDomainOpsModeLockOnlyV52").text;
const beforeRules = findFunctionRange(text, "renderDomainRules").text;
const beforeLifetime = findFunctionRange(text, "renderLifetime").text;

if (!/COOKIEGATE_V57_CLEAN_IMMEDIATE_REPAINT_NOTE_LAYOUT/.test(text)) {
  throw new Error("SOURCE_IS_NOT_V57_CLEAN_BUILD");
}

let renderDomainRules = beforeRules;

renderDomainRules = renderDomainRules.replace(
  'actions.className = "cg-rule-row-actions";',
  `actions.className = "cg-rule-row-actions";
      actions.style.display = "flex";
      actions.style.gap = "12px";
      actions.style.flexWrap = "wrap";
      actions.style.marginTop = "14px";
      actions.style.alignItems = "center";`
);

renderDomainRules = renderDomainRules.replace(
  'btn.style.minWidth = "132px";\n        btn.style.cursor = "pointer";',
  `btn.style.minWidth = "120px";
        btn.style.margin = "0";
        btn.style.flex = "1 1 120px";
        btn.style.cursor = "pointer";`
);

if (!/actions\.style\.gap = "12px"/.test(renderDomainRules)) throw new Error("RULE_BUTTON_GAP_PATCH_FAILED");
if (!/btn\.style\.flex = "1 1 120px"/.test(renderDomainRules)) throw new Error("RULE_BUTTON_FLEX_PATCH_FAILED");

let renderLifetime = beforeLifetime;

if (!/No banner suppressed on this site right now/.test(renderLifetime)) {
  throw new Error("BANNER_EMPTY_MESSAGE_OWNER_NOT_IN_RENDER_LIFETIME");
}

renderLifetime = renderLifetime.replace(
  /No banner suppressed on this site right now\./g,
  `No banner suppressed on this site right now.`
);

const bannerMessagePatch = `
    try {
      var panelText = panel ? String(panel.innerText || "") : "";
      var metricNums = Array.from(panel ? panel.querySelectorAll(".cg-metric b") : []).map(function(el){
        var n = parseInt(String(el.textContent || "0").replace(/[^0-9]/g, ""), 10);
        return isNaN(n) ? 0 : n;
      });
      var nowCount = metricNums[0] || 0;
      var sessionCount = metricNums[1] || 0;
      var timelineCount = metricNums[2] || 0;
      var lifetimeCount = metricNums[3] || 0;
      var msg = panel ? panel.querySelector(".cg-banner-now, .cg-banner-status, .cg-status-pill, .cg-banner-empty, .cg-empty") : null;

      if(msg && (nowCount > 0 || sessionCount > 0 || timelineCount > 0 || lifetimeCount > 0)){
        if(nowCount > 0){
          msg.textContent = "Banner suppression active on this site right now.";
        } else if(sessionCount > 0 || timelineCount > 0){
          msg.textContent = "Banner suppression activity recorded for this site.";
        } else {
          msg.textContent = "Banner suppression history exists for this site.";
        }
      }
    } catch(e){}
    // COOKIEGATE_V58_BANNER_MESSAGE_ALIGNS_WITH_COUNTERS
`;

const lastBrace = renderLifetime.lastIndexOf("}");
if (lastBrace < 0) throw new Error("RENDER_LIFETIME_FINAL_BRACE_NOT_FOUND");
renderLifetime = renderLifetime.slice(0, lastBrace) + "\n" + bannerMessagePatch + "\n" + renderLifetime.slice(lastBrace);

text = replaceFunction(text, "renderDomainRules", renderDomainRules);
text = replaceFunction(text, "renderLifetime", renderLifetime);

const afterSave = findFunctionRange(text, "saveInputRule").text;
const afterHeader = findFunctionRange(text, "renderHeader").text;
const afterLock = findFunctionRange(text, "applyDomainOpsModeLockOnlyV52").text;
const afterRules = findFunctionRange(text, "renderDomainRules").text;
const afterLifetime = findFunctionRange(text, "renderLifetime").text;

if (afterSave !== beforeSave) throw new Error("SAVE_INPUT_RULE_CHANGED_UNEXPECTEDLY");
if (afterHeader !== beforeHeader) throw new Error("RENDER_HEADER_CHANGED_UNEXPECTEDLY");
if (afterLock !== beforeLock) throw new Error("LOCK_FUNCTION_CHANGED_UNEXPECTEDLY");
if (!/actions\.style\.gap = "12px"/.test(afterRules)) throw new Error("RULE_BUTTON_GAP_MISSING");
if (!/flexWrap/.test(afterRules)) throw new Error("RULE_BUTTON_WRAP_MISSING");
if (!/COOKIEGATE_V58_BANNER_MESSAGE_ALIGNS_WITH_COUNTERS/.test(afterLifetime)) throw new Error("BANNER_MESSAGE_PATCH_MARKER_MISSING");
if (/async\s+async\s+function/.test(text)) throw new Error("DOUBLE_ASYNC_PRESENT");
if (/stafunction/.test(text)) throw new Error("STAFUNCTION_CORRUPTION_PRESENT");

text = text.trimEnd() + `

// COOKIEGATE_V58_BANNER_MESSAGE_RULE_BUTTON_SPACING
window.CookieGateV58BannerMessageRuleButtonSpacing = {
  patch: "banner-message-aligns-with-counters-and-rule-buttons-have-spacing",
  changed_functions: ["renderDomainRules","renderLifetime"],
  source: "v57-clean-immediate-repaint-note-layout"
};
`;

fs.writeFileSync(popupPath, text.replace(/\r\n/g, "\n").replace(/\r/g, "\n") + "\n", "utf8");
