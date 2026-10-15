const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cp = require("child_process");

const repoRoot = path.resolve(__dirname, "..", "..");
const chromeRoot = path.resolve(__dirname, "..", "..") + "\\dist\\v012_chrome_only_v62_banner_semantics_canonical_owner_certified_20260614_134805\\chrome";

function die(msg){ throw new Error(msg); }
function exists(p){ return fs.existsSync(p); }
function mkdir(p){ fs.mkdirSync(p, { recursive: true }); }
function read(p){ return fs.existsSync(p) ? fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n") : ""; }
function write(p, s){ mkdir(path.dirname(p)); fs.writeFileSync(p, String(s || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\s*$/, "") + "\n", "utf8"); }
function sha(p){ return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); }
function rel(root, p){ return path.relative(root, p).replace(/\\/g, "/"); }
function safeName(s){ return String(s).replace(/[\\/:*?"<>| ]/g, "_"); }

function walk(dir){
  let out = [];
  if(!exists(dir)) return out;
  for(const ent of fs.readdirSync(dir, { withFileTypes: true })){
    const p = path.join(dir, ent.name);
    if(ent.isDirectory()) out = out.concat(walk(p));
    if(ent.isFile()) out.push(p);
  }
  return out.sort((a,b) => a.localeCompare(b));
}

function nodeCheck(file){
  const r = cp.spawnSync("node", ["--check", file], { encoding: "utf8" });
  return {
    file,
    ok: r.status === 0,
    exitCode: r.status,
    stdout: String(r.stdout || "").trim(),
    stderr: String(r.stderr || "").trim()
  };
}

function lineHits(text, needles, win){
  const lines = String(text || "").split("\n");
  const hits = [];
  for(let i = 0; i < lines.length; i++){
    const line = String(lines[i] || "");
    const lower = line.toLowerCase();
    for(const needle of needles){
      const n = String(needle || "");
      if(lower.includes(n.toLowerCase())){
        const start = Math.max(0, i - win);
        const end = Math.min(lines.length - 1, i + win);
        const ctx = [];
        for(let j = start; j <= end; j++){
          ctx.push(String(j + 1).padStart(6, " ") + ": " + String(lines[j] || ""));
        }
        hits.push({
          line: i + 1,
          needle: n,
          text: line.trim(),
          context: ctx.join("\n")
        });
      }
    }
  }
  return hits;
}

function formatHits(fileLabel, hits){
  if(!hits.length) return "NO_HITS\n";
  return hits.map(h => "===== " + fileLabel + " line " + h.line + " needle [" + h.needle + "] =====\n" + h.context + "\n").join("\n");
}

function copyFileToSourceCopies(auditRoot, root, file){
  const outDir = path.join(auditRoot, "source_copies");
  mkdir(outDir);
  const r = rel(root, file);
  fs.copyFileSync(file, path.join(outDir, safeName(r)));
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

function lineNo(src, idx){
  return idx <= 0 ? 1 : src.slice(0, idx).split("\n").length;
}

function extractNamedFunction(src, name){
  const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp("(async\\s+)?function\\s+" + esc + "\\s*\\([^)]*\\)\\s*\\{", "g"),
    new RegExp("\\b(?:const|let|var)\\s+" + esc + "\\s*=\\s*(?:async\\s*)?function\\s*\\([^)]*\\)\\s*\\{", "g"),
    new RegExp("\\b(?:const|let|var)\\s+" + esc + "\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>\\s*\\{", "g")
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

function writeFunctionExcerpt(auditRoot, root, file, name){
  const src = read(file);
  const fn = extractNamedFunction(src, name);
  if(!fn) return null;
  const lines = src.split("\n");
  const out = [];
  for(let i = fn.startLine; i <= fn.endLine; i++){
    out.push(String(i).padStart(6, " ") + ": " + String(lines[i - 1] || ""));
  }
  const outPath = path.join(auditRoot, "function_excerpts", safeName(rel(root, file)) + "__" + String(fn.startLine).padStart(5, "0") + "_" + name + ".txt");
  write(outPath, out.join("\n"));
  return outPath;
}

if(!exists(chromeRoot)) die("CERTIFIED_CHROME_ROOT_MISSING " + chromeRoot);

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const auditRoot = path.join(repoRoot, "proofs", "audits", "cookiegate_v62_banner_runtime_blocking_owner_audit_v4_" + stamp);
mkdir(auditRoot);

const manifestPath = path.join(chromeRoot, "manifest.json");
const popupPath = path.join(chromeRoot, "ui", "popup.js");
const backgroundPath = path.join(chromeRoot, "background", "background.js");

for(const p of [manifestPath, popupPath, backgroundPath]){
  if(!exists(p)) die("REQUIRED_FILE_MISSING " + p);
}

const allJs = walk(chromeRoot).filter(p => p.toLowerCase().endsWith(".js"));
const parseRows = allJs.map(nodeCheck);
const parseFailures = parseRows.filter(x => !x.ok);
write(path.join(auditRoot, "js_parse.json"), JSON.stringify(parseRows.map(x => ({
  file: rel(chromeRoot, x.file),
  ok: x.ok,
  exitCode: x.exitCode,
  stderr: x.stderr
})), null, 2));
if(parseFailures.length) die("JS_PARSE_FAILURES " + parseFailures.map(x => rel(chromeRoot, x.file)).join(", "));

const manifest = JSON.parse(read(manifestPath));
const manifestLines = [];
manifestLines.push("COOKIEGATE MANIFEST CONTENT SCRIPT AUDIT V4");
manifestLines.push("Manifest: " + manifestPath);
manifestLines.push("Manifest SHA256: " + sha(manifestPath));
manifestLines.push("");

const contentScripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
if(contentScripts.length){
  contentScripts.forEach((cs, i) => {
    manifestLines.push("CONTENT_SCRIPT[" + i + "]");
    manifestLines.push("  matches: " + (Array.isArray(cs.matches) ? cs.matches.join(", ") : ""));
    manifestLines.push("  js: " + (Array.isArray(cs.js) ? cs.js.join(", ") : ""));
    manifestLines.push("  run_at: " + (cs.run_at || "<missing>"));
    manifestLines.push("  all_frames: " + (Object.prototype.hasOwnProperty.call(cs, "all_frames") ? String(cs.all_frames) : "<missing>"));
    manifestLines.push("  match_about_blank: " + (Object.prototype.hasOwnProperty.call(cs, "match_about_blank") ? String(cs.match_about_blank) : "<missing>"));
    manifestLines.push("");
  });
} else {
  manifestLines.push("NO_CONTENT_SCRIPTS_FOUND");
}
manifestLines.push("HOST PERMISSIONS:");
manifestLines.push("  " + (Array.isArray(manifest.host_permissions) ? manifest.host_permissions.join(", ") : ""));
manifestLines.push("");
manifestLines.push("PERMISSIONS:");
manifestLines.push("  " + (Array.isArray(manifest.permissions) ? manifest.permissions.join(", ") : ""));
write(path.join(auditRoot, "manifest_content_script_audit.txt"), manifestLines.join("\n"));

const manifestJs = [];
for(const cs of contentScripts){
  if(Array.isArray(cs.js)){
    for(const j of cs.js){
      const p = path.join(chromeRoot, j);
      if(exists(p)) manifestJs.push(p);
    }
  }
}

const expectedRel = [
  "banner_suppression_runtime_v32.js",
  "content/banner_suppression_runtime_v32.js",
  "content\\banner_suppression_runtime_v32.js",
  "banner_ledger_producer_v29.js",
  "content/banner_ledger_producer_v29.js",
  "content\\banner_ledger_producer_v29.js",
  "content/content.js",
  "content\\content.js",
  "content/banner_runtime.js",
  "content\\banner_runtime.js"
];

const expectedFiles = expectedRel.map(r => path.join(chromeRoot, r)).filter(exists);

const nameCandidateFiles = allJs.filter(p => {
  const r = rel(chromeRoot, p).toLowerCase();
  return r.includes("banner") || r.includes("ledger") || r.includes("runtime") || r.includes("content") || r.includes("background");
});

const candidateSet = new Map();
for(const p of expectedFiles.concat(manifestJs).concat(nameCandidateFiles).concat([popupPath, backgroundPath])){
  if(exists(p)) candidateSet.set(path.resolve(p), p);
}
const candidateFiles = Array.from(candidateSet.values()).sort((a,b) => a.localeCompare(b));

const candidateLines = [];
candidateLines.push("BANNER RUNTIME / LEDGER / INJECTION CANDIDATE FILES");
candidateLines.push("");
candidateFiles.forEach(p => {
  candidateLines.push(rel(chromeRoot, p) + " sha256=" + sha(p) + " bytes=" + fs.statSync(p).size);
});
write(path.join(auditRoot, "banner_runtime_candidate_files.txt"), candidateLines.join("\n"));

const runtimeNeedles = [
  "MutationObserver","querySelector","querySelectorAll","closest",
  "remove()",".remove(","removeChild","style.display","style.visibility","hidden","aria-hidden","display: none",
  "cookie banner","consent","cmp","OneTrust","onetrust","osano","didomi","quantcast","privacy","gdpr","ccpa",
  "accept","reject","decline","suppress","suppressed","blocked","banner","ledger",
  "chrome.storage.local","localStorage","sendMessage","onMessage","runtime","document_start","document_idle"
];

const popupNeedles = [
  "CURRENT_KEY","SESSION_KEY","TIMELINE_KEY","STATS_KEY",
  "Banner Suppression","cgV60CollectBannerEvents","cgV60ReconcileBannerMetrics","cgV62BannerMessageText",
  "chrome.storage.local","banner","suppression","ledger","timeline","lifetime",
  "site timeline","this session","this site now","lifetime blocked"
];

const backgroundNeedles = [
  "chrome.runtime.onMessage","chrome.tabs.sendMessage","chrome.storage.local",
  "banner","suppression","ledger","content","inject","scripting","tabs"
];

let candidateHitText = "";
for(const p of candidateFiles){
  const hits = lineHits(read(p), runtimeNeedles, 5);
  candidateHitText += formatHits(rel(chromeRoot, p), hits) + "\n";
}
write(path.join(auditRoot, "banner_runtime_hits.txt"), candidateHitText);

let allJsHitText = "";
for(const p of allJs){
  const hits = lineHits(read(p), runtimeNeedles, 3);
  if(hits.length) allJsHitText += formatHits(rel(chromeRoot, p), hits) + "\n";
}
write(path.join(auditRoot, "all_js_banner_runtime_hits.txt"), allJsHitText || "NO_ALL_JS_RUNTIME_HITS\n");

write(path.join(auditRoot, "popup_banner_storage_hits.txt"), formatHits(rel(chromeRoot, popupPath), lineHits(read(popupPath), popupNeedles, 5)));
write(path.join(auditRoot, "background_runtime_hits.txt"), formatHits(rel(chromeRoot, backgroundPath), lineHits(read(backgroundPath), backgroundNeedles, 5)));

for(const p of candidateFiles){
  copyFileToSourceCopies(auditRoot, chromeRoot, p);
}

const functionNames = [
  "renderMetrics",
  "cgV60CollectBannerEvents",
  "cgV60ReconcileBannerMetrics",
  "cgV62BannerMessageText",
  "cgV62ApplyBannerMessage",
  "cgV61Reconcile",
  "scan",
  "scanNow",
  "observe",
  "suppress",
  "hide",
  "record",
  "ledger",
  "emit",
  "send"
];

const fnOutputs = [];
for(const p of candidateFiles){
  for(const n of functionNames){
    const out = writeFunctionExcerpt(auditRoot, chromeRoot, p, n);
    if(out) fnOutputs.push(out);
  }
}

const summary = [];
summary.push("COOKIEGATE V62 BANNER RUNTIME BLOCKING OWNER AUDIT V4");
summary.push("ChromeRoot: " + chromeRoot);
summary.push("AuditRoot: " + auditRoot);
summary.push("");
summary.push("JS parse checked:");
parseRows.forEach(r => summary.push("  " + rel(chromeRoot, r.file)));
summary.push("");
summary.push("Manifest content scripts: " + contentScripts.length);
summary.push("Manifest JS files:");
manifestJs.forEach(p => summary.push("  " + rel(chromeRoot, p)));
summary.push("");
summary.push("Candidate files:");
candidateFiles.forEach(p => summary.push("  " + rel(chromeRoot, p)));
summary.push("");
summary.push("Function excerpts:");
fnOutputs.forEach(p => summary.push("  " + p));
summary.push("");
summary.push("Output files:");
summary.push("  manifest_content_script_audit.txt");
summary.push("  banner_runtime_candidate_files.txt");
summary.push("  banner_runtime_hits.txt");
summary.push("  popup_banner_storage_hits.txt");
summary.push("  background_runtime_hits.txt");
summary.push("  all_js_banner_runtime_hits.txt");
summary.push("  js_parse.json");
summary.push("  source_copies/");
summary.push("");
summary.push("NO_PATCH_NO_ZIP_NO_CERTIFICATION");
write(path.join(auditRoot, "summary.txt"), summary.join("\n"));

console.log("COOKIEGATE_V62_BANNER_RUNTIME_BLOCKING_OWNER_AUDIT_V4_OK");
console.log("AUDIT_ROOT=" + auditRoot);
console.log("");

for(const name of [
  "summary.txt",
  "manifest_content_script_audit.txt",
  "banner_runtime_candidate_files.txt",
  "banner_runtime_hits.txt",
  "popup_banner_storage_hits.txt",
  "background_runtime_hits.txt",
  "all_js_banner_runtime_hits.txt"
]){
  const p = path.join(auditRoot, name);
  console.log("");
  console.log("===== " + p + " =====");
  console.log(read(p));
}
