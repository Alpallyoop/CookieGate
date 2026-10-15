const fs = require("fs");

const popupPath = process.argv[2];
if (!popupPath) {
  throw new Error("POPUP_PATH_REQUIRED");
}

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
const beforeLock = findFunctionRange(text, "applyDomainOpsModeLockOnlyV52").text;
const beforeHeader = findFunctionRange(text, "renderHeader").text;
const beforeRules = findFunctionRange(text, "renderDomainRules").text;

if (!/COOKIEGATE_V56_ACTIVE_SITE_HEADER_USES_DOMAIN_RULE/.test(text)) {
  throw new Error("SOURCE_IS_NOT_V56_HEADER_BUILD");
}

const saveInputRule = `
function saveInputRule(){
    const input = qs("cgRuleDomainInput");
    if(!input) return;

    const n = normalizeDomain(input.value);
    if(!n.ok){
      setStatus("Cannot save: " + n.error);
      return;
    }

    const all = rules();
    const existing = all[n.domain];
    const next = inputRuleObject(n.domain);

    if(existing && existing.createdAt){
      next.createdAt = existing.createdAt;
    }

    next.enabled = true;
    next.active = true;
    next.disabled = false;
    next.status = "active";
    next.state = "active";
    next.checked = true;
    next.reachable = true;
    next.reachability = "checked";
    next.updatedAt = new Date().toISOString();
    next.lastCheckedAt = new Date().toISOString();

    all[n.domain] = next;
    saveRules(all);

    localStorage.setItem("cookiegate.siteMode:" + n.domain, next.mode);
    localStorage.setItem("cookiegate.siteMode:www." + n.domain, next.mode);
    try {
      if(state && state.site){
        var host = String(state.site || "").toLowerCase().replace(/^www\\./, "");
        if(host === n.domain || state.site === n.domain || state.site === ("www." + n.domain)){
          localStorage.setItem("cookiegate.siteMode:" + state.site, next.mode);
          state.siteMode = next.mode;
          state.effectiveMode = next.mode;
        }
      }
    } catch(e){}

    setStatus("Saved rule for " + n.domain + ". Status: active");
    renderDomainRules();

    try {
      state.siteMode = next.mode;
      state.effectiveMode = next.mode;
      renderHeader();
      normalizeModeOptionLabels();
      ensureModeHelp();
      applyDomainOpsModeLockOnlyV52();
    } catch(e){}

    setTimeout(function(){
      try {
        state.siteMode = next.mode;
        state.effectiveMode = next.mode;
        renderHeader();
        normalizeModeOptionLabels();
        ensureModeHelp();
        applyDomainOpsModeLockOnlyV52();
      } catch(e){}
    }, 80);

    // COOKIEGATE_V57_FORCE_ACTIVE_REPAINT_AFTER_SAVE
  }`;

const lockFunction = `
function applyDomainOpsModeLockOnlyV52(){
    var select = byId("siteModeSelect");
    if(!select) return;

    var noteId = "cgDomainOpsModeLockReasonV52";
    var old = byId(noteId);
    var rule = cgDomainOpsActiveRuleForSiteV52();

    if(rule && rule.mode){
      var lockedMode = String(rule.mode).toLowerCase();

      state.siteMode = lockedMode;
      state.effectiveMode = lockedMode;

      var option = select.querySelector('option[value="' + lockedMode + '"]');
      if(option){
        select.value = lockedMode;
      }

      select.disabled = true;
      select.setAttribute("aria-disabled", "true");
      select.setAttribute("data-cg-domain-ops-locked", "1");
      select.style.opacity = "0.75";
      select.style.cursor = "not-allowed";

      if(!old){
        old = document.createElement("div");
        old.id = noteId;
        old.className = "cg-mode-note cg-domain-ops-mode-lock-note";
        old.style.marginTop = "10px";
        old.style.display = "block";
        old.style.width = "100%";
        old.style.maxWidth = "100%";
        old.style.boxSizing = "border-box";
        old.style.gridColumn = "1 / -1";
        old.style.whiteSpace = "normal";
        old.style.padding = "10px 12px";
        old.style.border = "1px solid rgba(118, 132, 255, 0.35)";
        old.style.borderRadius = "12px";
        old.style.background = "rgba(27, 31, 77, 0.45)";
        old.style.fontWeight = "700";
        old.style.lineHeight = "1.45";

        var row = select.closest(".cg-mode-row") || select.parentNode;
        if(row && row.parentNode){
          row.parentNode.insertBefore(old, row.nextSibling);
        } else if(select.parentNode){
          select.parentNode.insertBefore(old, select.nextSibling);
        }
      }

      old.textContent = "Site Mode is locked by active Domain Ops rule for " + (rule.root || rule.domain || "this domain") + ". Use Domain Ops to edit, disable, or remove the rule.";
      return;
    }

    select.disabled = false;
    select.removeAttribute("aria-disabled");
    select.removeAttribute("data-cg-domain-ops-locked");
    select.style.opacity = "";
    select.style.cursor = "";

    if(old && old.parentNode){
      old.parentNode.removeChild(old);
    }
  }`;

text = replaceFunction(text, "saveInputRule", saveInputRule);
text = replaceFunction(text, "applyDomainOpsModeLockOnlyV52", lockFunction);

const afterHeader = findFunctionRange(text, "renderHeader").text;
const afterRules = findFunctionRange(text, "renderDomainRules").text;
const afterSave = findFunctionRange(text, "saveInputRule").text;
const afterLock = findFunctionRange(text, "applyDomainOpsModeLockOnlyV52").text;

if (afterHeader !== beforeHeader) throw new Error("RENDER_HEADER_CHANGED_UNEXPECTEDLY");
if (afterRules !== beforeRules) throw new Error("RENDER_DOMAIN_RULES_CHANGED_UNEXPECTEDLY");
if (!/COOKIEGATE_V57_FORCE_ACTIVE_REPAINT_AFTER_SAVE/.test(afterSave)) throw new Error("SAVE_REPAINT_MARKER_MISSING");
if (!/renderHeader\(\);/.test(afterSave)) throw new Error("SAVE_RENDER_HEADER_CALL_MISSING");
if (!/applyDomainOpsModeLockOnlyV52\(\);/.test(afterSave)) throw new Error("SAVE_LOCK_APPLY_CALL_MISSING");
if (!/setTimeout/.test(afterSave)) throw new Error("SAVE_DELAYED_REPAINT_MISSING");
if (!/gridColumn/.test(afterLock)) throw new Error("LOCK_NOTE_FULL_WIDTH_MISSING");
if (!/whiteSpace/.test(afterLock)) throw new Error("LOCK_NOTE_WRAP_MISSING");
if (/async\s+async\s+function/.test(text)) throw new Error("DOUBLE_ASYNC_PRESENT");

text = text.trimEnd() + `

// COOKIEGATE_V57_CLEAN_IMMEDIATE_REPAINT_NOTE_LAYOUT
window.CookieGateV57CleanImmediateRepaintNoteLayout = {
  patch: "clean-save-rule-immediate-active-repaint-and-readable-lock-note",
  changed_functions: ["saveInputRule","applyDomainOpsModeLockOnlyV52"],
  source: "v56-active-site-header-uses-domain-rule"
};
`;

fs.writeFileSync(popupPath, text.replace(/\r\n/g, "\n").replace(/\r/g, "\n") + "\n", "utf8");
