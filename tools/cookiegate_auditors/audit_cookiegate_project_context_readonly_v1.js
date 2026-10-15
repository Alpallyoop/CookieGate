const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cp = require("child_process");

function exists(p){ return fs.existsSync(p); }
function mkdir(p){ fs.mkdirSync(p, { recursive: true }); }
function read(p){ return fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n"); }
function write(p, s){ mkdir(path.dirname(p)); fs.writeFileSync(p, String(s || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\s*$/, "") + "\n", "utf8"); }
function sha(p){ return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); }
function rel(root, p){ return path.relative(root, p).replace(/\\/g, "/"); }
function walk(dir){
  let out = [];
  if(!exists(dir)) return out;
  for(const ent of fs.readdirSync(dir, { withFileTypes: true })){
    const p = path.join(dir, ent.name);
    if(ent.isDirectory()) out = out.concat(walk(p));
    else if(ent.isFile()) out.push(p);
  }
  return out.sort((a,b) => a.localeCompare(b));
}
function lineNo(text, idx){ return idx <= 0 ? 1 : text.slice(0, idx).split("\n").length; }
function excerpt(lines, start, end){
  const s = Math.max(1, start);
  const e = Math.min(lines.length, end);
  const out = [];
  for(let i=s; i<=e; i++) out.push(String(i).padStart(6, " ") + ": " + (lines[i-1] || ""));
  return out.join("\n");
}
function findBrace(src, open){
  let depth = 0, inStr = false, quote = "", esc = false, line = false, block = false;
  for(let i=open; i<src.length; i++){
    const ch = src[i], nx = src[i+1] || "";
    if(line){ if(ch === "\n") line = false; continue; }
    if(block){ if(ch === "*" && nx === "/"){ block = false; i++; } continue; }
    if(inStr){
      if(esc) esc = false;
      else if(ch === "\\") esc = true;
      else if(ch === quote) inStr = false;
      continue;
    }
    if(ch === "/" && nx === "/"){ line = true; i++; continue; }
    if(ch === "/" && nx === "*"){ block = true; i++; continue; }
    if(ch === "\"" || ch === "'" || ch === "`"){ inStr = true; quote = ch; continue; }
    if(ch === "{") depth++;
    if(ch === "}"){
      depth--;
      if(depth === 0) return i;
    }
  }
  return -1;
}
function findFunction(src, name){
  const safe = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp("(async\\s+)?function\\s+" + safe + "\\s*\\([^)]*\\)\\s*\\{", "g"),
    new RegExp("\\b(?:const|let|var)\\s+" + safe + "\\s*=\\s*(?:async\\s*)?function\\s*\\([^)]*\\)\\s*\\{", "g"),
    new RegExp("\\b(?:const|let|var)\\s+" + safe + "\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>\\s*\\{", "g")
  ];
  for(const re of patterns){
    const m = re.exec(src);
    if(!m) continue;
    const open = src.indexOf("{", m.index);
    const close = findBrace(src, open);
    if(close < 0) return null;
    const text = src.slice(m.index, close + 1);
    return {
      name,
      start_line: lineNo(src, m.index),
      end_line: lineNo(src, close),
      text
    };
  }
  return null;
}
function runNodeCheck(file){
  const r = cp.spawnSync("node", ["--check", file], { encoding: "utf8" });
  return {
    file,
    ok: r.status === 0,
    exitCode: r.status,
    stdout: String(r.stdout || "").trim(),
    stderr: String(r.stderr || "").trim()
  };
}
function fileMap(root){
  const map = {};
  for(const f of walk(root)){
    map[rel(root, f)] = { sha256: sha(f), bytes: fs.statSync(f).size };
  }
  return map;
}
function compareMaps(a, b){
  const keys = Array.from(new Set(Object.keys(a).concat(Object.keys(b)))).sort();
  const changed = [];
  const added = [];
  const removed = [];
  const same = [];
  for(const k of keys){
    if(!a[k]) added.push(k);
    else if(!b[k]) removed.push(k);
    else if(a[k].sha256 !== b[k].sha256 || a[k].bytes !== b[k].bytes) changed.push(k);
    else same.push(k);
  }
  return { changed, added, removed, same_count: same.length };
}
function markerInventory(text){
  const markers = [
    "COOKIEGATE_V57",
    "COOKIEGATE_V58",
    "COOKIEGATE_V59",
    "COOKIEGATE_V60",
    "COOKIEGATE_V61",
    "COOKIEGATE_V62",
    "COOKIEGATE_V61_BANNER_MESSAGE_RECONCILE",
    "COOKIEGATE_V62_BANNER_SEMANTICS_CANONICAL_OWNER",
    "COOKIEGATE_V62_BANNER_SEMANTICS_CANONICAL_OWNER_FIXED",
    "COOKIEGATE_V62_BANNER_SEMANTICS_RENDER_METRICS_RECONCILE_CALL",
    "COOKIEGATE_V62_BANNER_SEMANTICS_COUNTER_ATTRS",
    "COOKIEGATE_V62_BANNER_SEMANTICS_V61_RECONCILE_CANONICAL"
  ];
  const out = {};
  for(const m of markers) out[m] = text.indexOf(m) >= 0;
  return out;
}
function lineHits(text, needles, window){
  const lines = text.split("\n");
  const hits = [];
  for(let i=0; i<lines.length; i++){
    const line = lines[i] || "";
    for(const n of needles){
      if(line.toLowerCase().includes(String(n).toLowerCase())){
        hits.push({
          line: i + 1,
          needle: n,
          text: line.trim(),
          context: excerpt(lines, i + 1 - window, i + 1 + window)
        });
      }
    }
  }
  return hits;
}

function auditChrome(root, auditRoot, label){
  const popup = path.join(root, "ui", "popup.js");
  const manifest = path.join(root, "manifest.json");
  const report = [];
  const result = {
    label,
    chrome_root: root,
    exists: exists(root),
    popup_exists: exists(popup),
    manifest_exists: exists(manifest),
    popup_sha256: null,
    manifest_sha256: null,
    popup_bytes: 0,
    parse: [],
    markers: {},
    functions: []
  };

  report.push("COOKIEGATE CHROME ROOT AUDIT");
  report.push("Label: " + label);
  report.push("ChromeRoot: " + root);
  report.push("");

  if(!exists(root)){
    report.push("MISSING_CHROME_ROOT");
    write(path.join(auditRoot, label + "_report.txt"), report.join("\n"));
    return result;
  }

  const jsFiles = walk(root).filter(f => f.toLowerCase().endsWith(".js"));
  for(const js of jsFiles){
    const p = runNodeCheck(js);
    p.file = rel(root, js);
    result.parse.push(p);
  }

  if(exists(popup)){
    const txt = read(popup);
    const lines = txt.split("\n");
    result.popup_sha256 = sha(popup);
    result.popup_bytes = fs.statSync(popup).size;
    result.markers = markerInventory(txt);

    const names = [
      "renderMetrics",
      "renderLifetime",
      "cgV60BannerRootFromPopupState",
      "cgV60LooksLikeBannerEvent",
      "cgV60CollectBannerEvents",
      "cgV60FindBannerPanel",
      "cgV60SetBannerMetric",
      "cgV60SetBannerMessage",
      "cgV60ReconcileBannerMetrics",
      "cgV61Panel",
      "cgV61FindMessageNode",
      "cgV61MetricFromText",
      "cgV61SetMessage",
      "cgV61Reconcile",
      "cgV61Schedule",
      "cgV62BannerMessageText",
      "cgV62ApplyBannerMessage",
      "cgV62FindBannerMessageNode",
      "cgV62PanelAttrCount"
    ];

    const fnRoot = path.join(auditRoot, label + "_functions");
    mkdir(fnRoot);

    for(const name of names){
      const fn = findFunction(txt, name);
      if(fn){
        const out = path.join(fnRoot, String(fn.start_line).padStart(5, "0") + "_" + name + ".txt");
        write(out, excerpt(lines, fn.start_line, fn.end_line));
        result.functions.push({
          name,
          start_line: fn.start_line,
          end_line: fn.end_line,
          file: out,
          contains_no_banner: /No banner suppressed/i.test(fn.text),
          contains_site_now: /this site now|siteNow/i.test(fn.text),
          contains_session: /this session|siteSession|sessionSuppressed/i.test(fn.text),
          contains_timeline: /site timeline|siteTimeline|totalEvents/i.test(fn.text),
          contains_lifetime: /lifetime blocked|lifetimeSuppressed|allLifetime/i.test(fn.text),
          contains_v62: /V62|cgV62|data-cg-v62/i.test(fn.text)
        });
      } else {
        result.functions.push({ name, missing: true });
      }
    }

    const hits = lineHits(txt, [
      "No banner suppressed",
      "Suppression active for this site",
      "Banner suppression active",
      "Banner suppression activity",
      "Banner suppression history",
      "this site now",
      "this session",
      "site timeline",
      "lifetime blocked",
      "data-cg-v60",
      "data-cg-v61",
      "data-cg-v62",
      "COOKIEGATE_V60",
      "COOKIEGATE_V61",
      "COOKIEGATE_V62"
    ], 4);

    write(path.join(auditRoot, label + "_popup_hits.txt"), hits.map(h => "===== line " + h.line + " needle [" + h.needle + "] =====\n" + h.context + "\n").join("\n"));
  }

  if(exists(manifest)){
    result.manifest_sha256 = sha(manifest);
  }

  const badParse = result.parse.filter(x => !x.ok);

  report.push("popup_exists: " + result.popup_exists);
  report.push("popup_sha256: " + result.popup_sha256);
  report.push("popup_bytes: " + result.popup_bytes);
  report.push("manifest_sha256: " + result.manifest_sha256);
  report.push("js_parse_total: " + result.parse.length);
  report.push("js_parse_failures: " + badParse.length);
  report.push("");
  report.push("MARKERS:");
  for(const k of Object.keys(result.markers).sort()) report.push("  " + k + "=" + result.markers[k]);
  report.push("");
  report.push("FUNCTIONS:");
  for(const f of result.functions){
    if(f.missing){
      report.push("  MISSING " + f.name);
    } else {
      report.push("  " + f.name + " lines " + f.start_line + "-" + f.end_line + " noBanner=" + f.contains_no_banner + " siteNow=" + f.contains_site_now + " session=" + f.contains_session + " timeline=" + f.contains_timeline + " lifetime=" + f.contains_lifetime + " v62=" + f.contains_v62);
    }
  }
  report.push("");
  report.push("OUTPUTS:");
  report.push("  function excerpts: " + path.join(auditRoot, label + "_functions"));
  report.push("  popup hits: " + path.join(auditRoot, label + "_popup_hits.txt"));

  write(path.join(auditRoot, label + "_report.txt"), report.join("\n"));
  return result;
}

function main(){
  const repo = path.resolve(__dirname, "..", "..");
  const dist = path.join(repo, "dist");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const auditRoot = path.join(repo, "proofs", "audits", "cookiegate_project_context_readonly_" + stamp);
  mkdir(auditRoot);

  const v61 = path.join(dist, "v012_chrome_only_v61_banner_message_reconcile_20260614_110754", "chrome");

  const badRoots = [
    path.join(dist, "v012_chrome_only_v57_mode_lock_immediate_repaint_note_layout_20260613_000451", "chrome"),
    path.join(dist, "v012_chrome_only_v58_banner_message_rule_button_spacing_20260613_012538", "chrome"),
    path.join(dist, "v012_chrome_only_v60_banner_metrics_reconcile_20260613_180429", "chrome")
  ];

  const distDirs = exists(dist) ? fs.readdirSync(dist, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(dist, d.name)) : [];
  const v62Dirs = distDirs
    .filter(d => /v012_chrome_only_v62_banner_semantics_canonical_owner/i.test(path.basename(d)))
    .map(d => path.join(d, "chrome"))
    .filter(d => exists(d))
    .sort((a,b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

  const audits = [];
  audits.push(auditChrome(v61, auditRoot, "trusted_v61"));

  let candidateLabel = null;
  if(v62Dirs.length > 0){
    candidateLabel = "latest_v62_candidate";
    audits.push(auditChrome(v62Dirs[0], auditRoot, candidateLabel));
  }

  const v61Map = exists(v61) ? fileMap(v61) : {};
  let comparison = null;
  if(v62Dirs.length > 0){
    const candidateMap = fileMap(v62Dirs[0]);
    comparison = compareMaps(v61Map, candidateMap);
    write(path.join(auditRoot, "v61_vs_latest_v62_candidate_changed_files.txt"), [
      "CHANGED:",
      ...comparison.changed,
      "",
      "ADDED:",
      ...comparison.added,
      "",
      "REMOVED:",
      ...comparison.removed,
      "",
      "SAME_COUNT=" + comparison.same_count
    ].join("\n"));
  }

  const latest = {
    schema: "cookiegate.project_context_readonly_audit.v1",
    utc: new Date().toISOString(),
    repo_root: repo,
    audit_root: auditRoot,
    trusted_v61_chrome: v61,
    refused_bad_roots: badRoots,
    v62_candidate_chrome_roots: v62Dirs,
    audits,
    v61_vs_latest_v62_candidate: comparison,
    patched: false,
    zipped: false,
    certified: false
  };

  write(path.join(auditRoot, "audit.json"), JSON.stringify(latest, null, 2));

  const summary = [];
  summary.push("COOKIEGATE PROJECT CONTEXT READONLY AUDIT");
  summary.push("AuditRoot: " + auditRoot);
  summary.push("TrustedV61: " + v61);
  summary.push("V62CandidateCount: " + v62Dirs.length);
  if(v62Dirs.length > 0) summary.push("LatestV62Candidate: " + v62Dirs[0]);
  summary.push("");
  for(const a of audits){
    const bad = a.parse.filter(x => !x.ok);
    summary.push("[" + a.label + "]");
    summary.push("  chrome_root: " + a.chrome_root);
    summary.push("  popup_sha256: " + a.popup_sha256);
    summary.push("  popup_bytes: " + a.popup_bytes);
    summary.push("  js_parse_total: " + a.parse.length);
    summary.push("  js_parse_failures: " + bad.length);
    summary.push("  report: " + path.join(auditRoot, a.label + "_report.txt"));
    summary.push("  functions: " + path.join(auditRoot, a.label + "_functions"));
    summary.push("  hits: " + path.join(auditRoot, a.label + "_popup_hits.txt"));
    summary.push("");
  }
  if(comparison){
    summary.push("[v61_vs_latest_v62_candidate]");
    summary.push("  changed_count: " + comparison.changed.length);
    summary.push("  added_count: " + comparison.added.length);
    summary.push("  removed_count: " + comparison.removed.length);
    summary.push("  comparison_file: " + path.join(auditRoot, "v61_vs_latest_v62_candidate_changed_files.txt"));
  }
  summary.push("");
  summary.push("NO_PATCH_NO_ZIP_NO_CERTIFICATION");

  write(path.join(auditRoot, "summary.txt"), summary.join("\n"));

  console.log("COOKIEGATE_PROJECT_CONTEXT_READONLY_AUDIT_COMPLETE");
  console.log("AUDIT_ROOT=" + auditRoot);
  console.log("SUMMARY=" + path.join(auditRoot, "summary.txt"));
  console.log("AUDIT_JSON=" + path.join(auditRoot, "audit.json"));
}

main();
