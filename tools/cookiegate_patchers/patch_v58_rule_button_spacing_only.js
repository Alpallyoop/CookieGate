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

if (!/COOKIEGATE_V57_CLEAN_IMMEDIATE_REPAINT_NOTE_LAYOUT/.test(text)) {
  throw new Error("SOURCE_IS_NOT_V57_CLEAN_BUILD");
}

let renderDomainRules = beforeRules;

if (!/actions\.className = "cg-rule-row-actions";/.test(renderDomainRules)) {
  throw new Error("RULE_ACTIONS_OWNER_NOT_FOUND");
}

renderDomainRules = renderDomainRules.replace(
  'actions.className = "cg-rule-row-actions";',
  `actions.className = "cg-rule-row-actions";
      actions.style.display = "flex";
      actions.style.gap = "14px";
      actions.style.flexWrap = "wrap";
      actions.style.marginTop = "14px";
      actions.style.alignItems = "center";`
);

if (!/btn\.style\.minWidth = "132px";/.test(renderDomainRules)) {
  throw new Error("RULE_BUTTON_MIN_WIDTH_OWNER_NOT_FOUND");
}

renderDomainRules = renderDomainRules.replace(
  'btn.style.minWidth = "132px";\n        btn.style.cursor = "pointer";',
  `btn.style.minWidth = "128px";
        btn.style.margin = "0";
        btn.style.flex = "1 1 128px";
        btn.style.cursor = "pointer";`
);

text = replaceFunction(text, "renderDomainRules", renderDomainRules);

const afterSave = findFunctionRange(text, "saveInputRule").text;
const afterHeader = findFunctionRange(text, "renderHeader").text;
const afterLock = findFunctionRange(text, "applyDomainOpsModeLockOnlyV52").text;
const afterRules = findFunctionRange(text, "renderDomainRules").text;

if (afterSave !== beforeSave) throw new Error("SAVE_INPUT_RULE_CHANGED_UNEXPECTEDLY");
if (afterHeader !== beforeHeader) throw new Error("RENDER_HEADER_CHANGED_UNEXPECTEDLY");
if (afterLock !== beforeLock) throw new Error("LOCK_FUNCTION_CHANGED_UNEXPECTEDLY");
if (!/actions\.style\.gap = "14px"/.test(afterRules)) throw new Error("RULE_BUTTON_GAP_MISSING");
if (!/actions\.style\.flexWrap = "wrap"/.test(afterRules)) throw new Error("RULE_BUTTON_WRAP_MISSING");
if (!/btn\.style\.flex = "1 1 128px"/.test(afterRules)) throw new Error("RULE_BUTTON_FLEX_MISSING");
if (/async\s+async\s+function/.test(text)) throw new Error("DOUBLE_ASYNC_PRESENT");
if (/stafunction/.test(text)) throw new Error("STAFUNCTION_CORRUPTION_PRESENT");

text = text.trimEnd() + `

// COOKIEGATE_V58_RULE_BUTTON_SPACING_ONLY
window.CookieGateV58RuleButtonSpacingOnly = {
  patch: "domain-rule-buttons-have-gap-and-wrap-spacing",
  changed_functions: ["renderDomainRules"],
  source: "v57-clean-immediate-repaint-note-layout"
};
`;

fs.writeFileSync(popupPath, text.replace(/\r\n/g, "\n").replace(/\r/g, "\n") + "\n", "utf8");
