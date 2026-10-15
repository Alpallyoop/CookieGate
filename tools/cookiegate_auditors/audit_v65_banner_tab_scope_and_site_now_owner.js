const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cp = require("child_process");

const chromeRoot = path.resolve(__dirname, "..", "..") + "\\dist\\v012_v65_horizontal_metrics_site_now_current_firefox_candidate_20260615_214736\\chrome";
const auditRoot = process.argv[2];

function die(s){ throw new Error(s); }
function read(p){ return fs.existsSync(p) ? fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n") : ""; }
function write(p, s){ fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, String(s || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\s*$/, "") + "\n", "utf8"); }
function sha(p){ return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); }
function rel(p){ return path.relative(chromeRoot, p).replace(/\\/g, "/"); }
function escRx(s){ return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

if(!auditRoot) die("AUDIT_ROOT_ARG_REQUIRED");

const files = {
  manifest: path.join(chromeRoot, "manifest.json"),
  popupJs: path.join(chromeRoot, "ui", "popup.js"),
  popupHtml: path.join(chromeRoot, "ui", "popup.html"),
  popupCss: path.join(chromeRoot, "ui", "popup.css"),
  backgroundJs: path.join(chromeRoot, "background", "background.js"),
  runtimeJs: path.join(chromeRoot, "banner_suppression_runtime_v32.js")
};

for(const [k,p] of Object.entries(files)){
  if(!fs.existsSync(p)) die("REQUIRED_FILE_MISSING " + k + " " + p);
}

function walk(dir){
  let out = [];
  for(const ent of fs.readdirSync(dir, { withFileTypes: true })){
    const p = path.join(dir, ent.name);
    if(ent.isDirectory()) out = out.concat(walk(p));
    if(ent.isFile()) out.push(p);
  }
  return out.sort((a,b) => a.localeCompare(b));
}

function lineNo(src, idx){
  return idx <= 0 ? 1 : src.slice(0, idx).split("\n").length;
}

function numberedSlice(src, startLine, endLine){
  const lines = src.split("\n");
  const out = [];
  const s = Math.max(1, startLine);
  const e = Math.min(lines.length, endLine);
  for(let i = s; i <= e; i++){
    out.push(String(i).padStart(6, " ") + ": " + (lines[i - 1] || ""));
  }
  return out.join("\n");
}

function findHits(src, needles, win){
  const lines = src.split("\n");
  const out = [];
  for(let i = 0; i < lines.length; i++){
    const lower = String(lines[i] || "").toLowerCase();
    for(const needle of needles){
      if(lower.includes(String(needle).toLowerCase())){
        out.push("===== line " + (i + 1) + " needle [" + needle + "] =====");
        out.push(numberedSlice(src, i + 1 - win, i + 1 + win));
        out.push("");
      }
    }
  }
  return out.join("\n") || "NO_HITS\n";
}

function braceMatch(src, open){
  let depth = 0, str = false, quote = "", esc = false, line = false, block = false;
  for(let i = open; i < src.length; i++){
    const ch = src[i], nx = src[i + 1] || "";
    if(line){ if(ch === "\n") line = false; continue; }
    if(block){ if(ch === "*" && nx === "/"){ block = false; i++; } continue; }
    if(str){
      if(esc) esc = false;
      else if(ch === "\\") esc = true;
      else if(ch === quote) str = false;
      continue;
    }
    if(ch === "/" && nx === "/"){ line = true; i++; continue; }
    if(ch === "/" && nx === "*"){ block = true; i++; continue; }
    if(ch === "\"" || ch === "'" || ch === "`"){ str = true; quote = ch; continue; }
    if(ch === "{") depth++;
    if(ch === "}"){
      depth--;
      if(depth === 0) return i;
    }
  }
  return -1;
}

function extractFunction(src, name){
  const e = escRx(name);
  const patterns = [
    new RegExp("(async\\s+)?function\\s+" + e + "\\s*\\([^)]*\\)\\s*\\{", "g"),
    new RegExp("\\b(?:const|let|var)\\s+" + e + "\\s*=\\s*(?:async\\s*)?function\\s*\\([^)]*\\)\\s*\\{", "g"),
    new RegExp("\\b(?:const|let|var)\\s+" + e + "\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>\\s*\\{", "g")
  ];

  for(const re of patterns){
    const m = re.exec(src);
    if(!m) continue;
    const open = src.indexOf("{", m.index);
    const close = braceMatch(src, open);
    if(close < 0) return null;
    return {
      name,
      startLine: lineNo(src, m.index),
      endLine: lineNo(src, close),
      text: src.slice(m.index, close + 1)
    };
  }

  return null;
}

function writeFunction(src, name, outDir){
  const fn = extractFunction(src, name);
  if(!fn) return null;
  write(path.join(outDir, String(fn.startLine).padStart(6, "0") + "_" + name + ".txt"), numberedSlice(src, fn.startLine, fn.endLine));
  return fn;
}

function allOccurrences(src, needle){
  const out = [];
  let idx = 0;
  while(true){
    const n = src.indexOf(needle, idx);
    if(n < 0) break;
    out.push(lineNo(src, n));
    idx = n + needle.length;
  }
  return out;
}

function nodeCheck(file){
  const r = cp.spawnSync("node", ["--check", file], { encoding: "utf8" });
  return { file: rel(file), ok: r.status === 0, stderr: String(r.stderr || "").trim() };
}

const popup = read(files.popupJs);
const html = read(files.popupHtml);
const css = read(files.popupCss);
const runtime = read(files.runtimeJs);
const background = read(files.backgroundJs);
const manifest = JSON.parse(read(files.manifest));

const allJs = walk(chromeRoot).filter(p => p.toLowerCase().endsWith(".js"));
const parseRows = allJs.map(nodeCheck);
const parseFail = parseRows.filter(x => !x.ok);
write(path.join(auditRoot, "js_parse.json"), JSON.stringify(parseRows, null, 2));
if(parseFail.length) die("JS_PARSE_FAILURES " + parseFail.map(x => x.file).join(", "));

const popupNeedles = [
  "Banner Suppression",
  "cgV32BannerMetrics",
  "renderMetrics",
  "function metric",
  "grid.appendChild(metric",
  "appendChild(panel)",
  "document.body.appendChild",
  "querySelector",
  "Active Site",
  "Browser Observer",
  "Domain Ops",
  "data-tab",
  "tab",
  "hidden",
  "display",
  "CURRENT_KEY",
  "SESSION_KEY",
  "TIMELINE_KEY",
  "STATS_KEY",
  "siteNow",
  "siteSession",
  "siteTimeline",
  "cgV60ReconcileBannerMetrics",
  "cgV64NormalizeBannerMetricRows",
  "cgV65NormalizeBannerMetricRows",
  "COOKIEGATE_V65_HORIZONTAL_METRICS_SITE_NOW_CURRENT"
];

const htmlNeedles = [
  "Active Site",
  "Browser Observer",
  "Domain Ops",
  "Banner Suppression",
  "tab",
  "panel",
  "data-tab",
  "hidden",
  "cgV32BannerMetrics"
];

const cssNeedles = [
  "cgV32BannerMetrics",
  "cg-grid",
  "display",
  "grid",
  "flex",
  "hidden",
  "tab",
  "panel",
  "active"
];

write(path.join(auditRoot, "popup_hits.txt"), findHits(popup, popupNeedles, 7));
write(path.join(auditRoot, "popup_html_hits.txt"), findHits(html, htmlNeedles, 7));
write(path.join(auditRoot, "popup_css_hits.txt"), findHits(css, cssNeedles, 7));
write(path.join(auditRoot, "runtime_site_now_storage_hits.txt"), findHits(runtime, [
  "CURRENT_KEY",
  "SESSION_KEY",
  "TIMELINE_KEY",
  "STATS_KEY",
  "suppressed_count",
  "active",
  "expires",
  "Date.now",
  "chrome.storage.local",
  "scanAndSuppress",
  "suppressCandidates",
  "record",
  "session"
], 7));

write(path.join(auditRoot, "background_hits.txt"), findHits(background, [
  "tabs",
  "active",
  "onMessage",
  "sendMessage",
  "storage",
  "popup",
  "banner"
], 7));

const fnDir = path.join(auditRoot, "function_excerpts");
fs.mkdirSync(fnDir, { recursive: true });

const functionNames = [
  "metric",
  "renderMetrics",
  "renderLifetime",
  "cgV60FindBannerPanel",
  "cgV60SetBannerMetric",
  "cgV60BannerRootFromPopupState",
  "cgV60CollectBannerEvents",
  "cgV60ReconcileBannerMetrics",
  "cgV60SetBannerMessage",
  "cgV62BannerMessageText",
  "cgV62ApplyBannerMessage",
  "cgV64NormalizeBannerMetricRows",
  "cgV64EnsureMetricRowCss",
  "cgV65NormalizeBannerMetricRows",
  "cgV65EnsureMetricCss",
  "showTab",
  "setTab",
  "switchTab",
  "activateTab",
  "renderActiveSite",
  "renderBrowserObserver",
  "renderDomainOps"
];

const foundFns = [];
for(const name of functionNames){
  const fn = writeFunction(popup, name, fnDir);
  if(fn) foundFns.push({ name, startLine: fn.startLine, endLine: fn.endLine });
}

const panelOccurrences = {
  bannerSuppressionText: allOccurrences(popup, "Banner Suppression"),
  cgV32BannerMetrics: allOccurrences(popup, "cgV32BannerMetrics"),
  appendChildPanel: allOccurrences(popup, "appendChild(panel)"),
  bodyAppendPanel: allOccurrences(popup, "document.body.appendChild(panel)"),
  gridAppendMetric: allOccurrences(popup, "grid.appendChild(metric"),
  v65NormalizeCalls: allOccurrences(popup, "cgV65NormalizeBannerMetricRows(panel)"),
  v64NormalizeCalls: allOccurrences(popup, "cgV64NormalizeBannerMetricRows(panel)")
};

write(path.join(auditRoot, "owner_counts.json"), JSON.stringify(panelOccurrences, null, 2));

const contentScripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
const manifestAudit = [];
manifestAudit.push("MANIFEST SUMMARY");
manifestAudit.push("manifest_version=" + manifest.manifest_version);
manifestAudit.push("name=" + manifest.name);
manifestAudit.push("version=" + manifest.version);
manifestAudit.push("permissions=" + (Array.isArray(manifest.permissions) ? manifest.permissions.join(", ") : ""));
manifestAudit.push("host_permissions=" + (Array.isArray(manifest.host_permissions) ? manifest.host_permissions.join(", ") : ""));
manifestAudit.push("");
contentScripts.forEach((cs, i) => {
  manifestAudit.push("CONTENT_SCRIPT[" + i + "]");
  manifestAudit.push("  matches=" + (Array.isArray(cs.matches) ? cs.matches.join(", ") : ""));
  manifestAudit.push("  js=" + (Array.isArray(cs.js) ? cs.js.join(", ") : ""));
  manifestAudit.push("  run_at=" + (cs.run_at || "<missing>"));
  manifestAudit.push("");
});
write(path.join(auditRoot, "manifest_audit.txt"), manifestAudit.join("\n"));

const sourceDir = path.join(auditRoot, "source_copies");
fs.mkdirSync(sourceDir, { recursive: true });
for(const p of Object.values(files)){
  fs.copyFileSync(p, path.join(sourceDir, rel(p).replace(/[\\/:*?"<>| ]/g, "_")));
}

const summary = [];
summary.push("COOKIEGATE V65 BANNER TAB SCOPE + SITE NOW OWNER AUDIT");
summary.push("ChromeRoot: " + chromeRoot);
summary.push("AuditRoot: " + auditRoot);
summary.push("");
summary.push("Core hashes:");
for(const [k,p] of Object.entries(files)){
  summary.push("  " + k + ": " + sha(p) + " " + rel(p));
}
summary.push("");
summary.push("JS parse checked:");
parseRows.forEach(x => summary.push("  " + x.file));
summary.push("");
summary.push("Function excerpts found:");
foundFns.forEach(x => summary.push("  " + x.name + " lines " + x.startLine + "-" + x.endLine));
summary.push("");
summary.push("Owner counts:");
summary.push("  Banner Suppression text lines: " + panelOccurrences.bannerSuppressionText.join(", "));
summary.push("  cgV32BannerMetrics lines: " + panelOccurrences.cgV32BannerMetrics.join(", "));
summary.push("  appendChild(panel) lines: " + panelOccurrences.appendChildPanel.join(", "));
summary.push("  document.body.appendChild(panel) lines: " + panelOccurrences.bodyAppendPanel.join(", "));
summary.push("  grid.appendChild(metric) lines: " + panelOccurrences.gridAppendMetric.join(", "));
summary.push("  v64 normalize calls: " + panelOccurrences.v64NormalizeCalls.join(", "));
summary.push("  v65 normalize calls: " + panelOccurrences.v65NormalizeCalls.join(", "));
summary.push("");
summary.push("Read these next:");
summary.push("  popup_hits.txt");
summary.push("  popup_html_hits.txt");
summary.push("  popup_css_hits.txt");
summary.push("  runtime_site_now_storage_hits.txt");
summary.push("  owner_counts.json");
summary.push("  function_excerpts/");
summary.push("");
summary.push("NO_PATCH_NO_ZIP_NO_CERTIFICATION");

write(path.join(auditRoot, "summary.txt"), summary.join("\n"));

console.log("COOKIEGATE_V65_BANNER_TAB_SCOPE_AND_SITE_NOW_OWNER_AUDIT_OK");
console.log("Audit root: " + auditRoot);
console.log("");
for(const name of [
  "summary.txt",
  "owner_counts.json",
  "manifest_audit.txt",
  "popup_hits.txt",
  "popup_html_hits.txt",
  "popup_css_hits.txt",
  "runtime_site_now_storage_hits.txt",
  "background_hits.txt"
]){
  const p = path.join(auditRoot, name);
  console.log("");
  console.log("===== " + p + " =====");
  console.log(read(p));
}
