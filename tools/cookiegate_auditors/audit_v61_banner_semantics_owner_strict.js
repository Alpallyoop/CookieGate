const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function die(code, detail){
  const e = new Error(code + (detail ? ": " + detail : ""));
  e.code = code;
  throw e;
}

function readText(file){
  if(!fs.existsSync(file)) die("MISSING_FILE", file);
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function sha256(file){
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function lineNo(text, index){
  if(index <= 0) return 1;
  return text.slice(0, index).split("\n").length;
}

function lineExcerpt(lines, startLine, endLine){
  const start = Math.max(1, startLine);
  const end = Math.min(lines.length, endLine);
  const out = [];
  for(let n = start; n <= end; n++){
    out.push(String(n).padStart(6, " ") + ": " + String(lines[n - 1] || ""));
  }
  return out.join("\n");
}

function findMatchingBrace(src, open){
  let depth = 0;
  let inString = false;
  let quote = "";
  let escape = false;
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
      if(escape){
        escape = false;
      } else if(ch === "\\"){
        escape = true;
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
      if(depth === 0) return i;
    }
  }

  return -1;
}

function findFunctions(src){
  const patterns = [
    /\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^)]*\)\s*\{/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?function\s*\([^)]*\)\s*\{/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?[A-Za-z_$][A-Za-z0-9_$]*\s*=>\s*\{/g,
    /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*function\s*\([^)]*\)\s*\{/g
  ];

  const seen = new Set();
  const spans = [];

  for(const re of patterns){
    let m;
    while((m = re.exec(src))){
      const name = m[1];
      const open = src.indexOf("{", m.index);
      if(open < 0) continue;
      const close = findMatchingBrace(src, open);
      if(close < 0) continue;

      const key = m.index + ":" + close + ":" + name;
      if(seen.has(key)) continue;
      seen.add(key);

      const body = src.slice(m.index, close + 1);
      const startLine = lineNo(src, m.index);
      const endLine = lineNo(src, close);

      spans.push({
        name,
        start_index: m.index,
        start_line: startLine,
        end_line: endLine,
        line_count: endLine - startLine + 1,
        contains_no_banner: /No banner suppressed/i.test(body),
        contains_this_site_now: /this site now/i.test(body),
        contains_this_session: /this session/i.test(body),
        contains_site_timeline: /site timeline/i.test(body),
        contains_lifetime_blocked: /lifetime blocked/i.test(body),
        contains_banner_activity: /Banner suppression activity/i.test(body),
        contains_banner_history: /Banner suppression history/i.test(body),
        contains_v60_attr: /data-cg-v60-banner/i.test(body),
        contains_v61_attr: /data-cg-v61/i.test(body),
        contains_reconcile: /reconcile/i.test(body),
        contains_metric_from_text: /MetricFromText|metricFromText/i.test(body),
        contains_text_node_rewrite: /nodeValue|textContent|innerText/i.test(body),
        text: body
      });
    }
  }

  return spans.sort((a,b) => a.start_index - b.start_index);
}

function hitsFor(lines, needles, window){
  const hits = [];
  for(let i = 0; i < lines.length; i++){
    const line = String(lines[i] || "");
    for(const needle of needles){
      if(line.toLowerCase().includes(String(needle).toLowerCase())){
        hits.push({
          line: i + 1,
          needle,
          text: line.trim(),
          context: lineExcerpt(lines, i + 1 - window, i + 1 + window)
        });
      }
    }
  }
  return hits;
}

function writeText(file, text){
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\s*$/,"") + "\n", "utf8");
}

function main(){
  const chromeRoot = process.argv[2];
  const auditRoot = process.argv[3];
  if(!chromeRoot) die("CHROME_ROOT_REQUIRED");
  if(!auditRoot) die("AUDIT_ROOT_REQUIRED");

  const popupPath = path.join(chromeRoot, "ui", "popup.js");
  const manifestPath = path.join(chromeRoot, "manifest.json");
  const runtimePath = path.join(chromeRoot, "banner_suppression_runtime_v32.js");
  const ledgerPath = path.join(chromeRoot, "banner_ledger_producer_v29.js");

  const popup = readText(popupPath);
  const manifest = readText(manifestPath);

  if(popup.length < 1000) die("POPUP_JS_TOO_SMALL_OR_EMPTY", popupPath + " bytes=" + popup.length);
  if(!/renderMetrics/i.test(popup)) die("POPUP_RENDER_METRICS_NOT_FOUND", popupPath);
  if(!/No banner suppressed/i.test(popup)) die("POPUP_NO_BANNER_STRING_NOT_FOUND", popupPath);

  const popupLines = popup.split("\n");
  const manifestLines = manifest.split("\n");

  const needles = [
    "No banner suppressed",
    "this site now",
    "this session",
    "site timeline",
    "lifetime blocked",
    "Banner suppression activity",
    "Banner suppression history",
    "data-cg-v60-banner",
    "data-cg-v61",
    "renderMetrics",
    "renderLifetime",
    "cgV61",
    "CookieGateV61BannerMessageReconcile",
    "reconcile"
  ];

  const counterNeedles = [
    "siteNow",
    "site now",
    "siteSession",
    "session",
    "siteTimeline",
    "timeline",
    "lifetime",
    "blocked",
    "suppressed",
    "banner"
  ];

  const popupHits = hitsFor(popupLines, needles, 6);
  const counterHits = hitsFor(popupLines, counterNeedles, 3);
  const manifestHits = hitsFor(manifestLines, ["popup.js","banner_suppression_runtime_v32.js","banner_ledger_producer_v29.js","background","content_scripts"], 4);

  const spans = findFunctions(popup);
  const ownerSpans = spans.filter(s =>
    s.contains_no_banner ||
    s.contains_this_site_now ||
    s.contains_this_session ||
    s.contains_site_timeline ||
    s.contains_lifetime_blocked ||
    s.contains_banner_activity ||
    s.contains_banner_history ||
    s.contains_v60_attr ||
    s.contains_v61_attr ||
    s.contains_reconcile ||
    /^renderMetrics$/.test(s.name) ||
    /^renderLifetime$/.test(s.name) ||
    /banner/i.test(s.name)
  );

  const renderMetrics = spans.find(s => s.name === "renderMetrics") || null;
  const renderLifetime = spans.find(s => s.name === "renderLifetime") || null;
  const v61Spans = ownerSpans.filter(s => /cgV61|CookieGateV61|reconcile/i.test(s.name) || s.contains_v61_attr || s.contains_reconcile);

  let ownerConclusion = "UNKNOWN";
  if(renderMetrics && (renderMetrics.contains_no_banner || renderMetrics.contains_this_site_now || renderMetrics.contains_this_session || renderMetrics.contains_site_timeline || renderMetrics.contains_lifetime_blocked)){
    ownerConclusion = "renderMetrics_owns_visible_banner_message_and_counter_labels";
  } else if(renderLifetime && (renderLifetime.contains_no_banner || renderLifetime.contains_this_site_now || renderLifetime.contains_this_session || renderLifetime.contains_site_timeline || renderLifetime.contains_lifetime_blocked)){
    ownerConclusion = "renderLifetime_owns_visible_banner_message_and_counter_labels";
  } else if(ownerSpans.length > 0){
    ownerConclusion = "popup_other_span_owns_visible_banner_logic";
  }

  const excerptIndex = [];
  for(const s of ownerSpans){
    const safe = String(s.name || "anonymous").replace(/[^A-Za-z0-9_.-]/g, "_");
    const file = path.join(auditRoot, `popup_span_${String(s.start_line).padStart(5,"0")}_${String(s.end_line).padStart(5,"0")}_${safe}.txt`);
    writeText(file, lineExcerpt(popupLines, s.start_line, s.end_line));
    excerptIndex.push({
      name: s.name,
      start_line: s.start_line,
      end_line: s.end_line,
      line_count: s.line_count,
      excerpt_path: file,
      contains_no_banner: s.contains_no_banner,
      contains_this_site_now: s.contains_this_site_now,
      contains_this_session: s.contains_this_session,
      contains_site_timeline: s.contains_site_timeline,
      contains_lifetime_blocked: s.contains_lifetime_blocked,
      contains_banner_activity: s.contains_banner_activity,
      contains_banner_history: s.contains_banner_history,
      contains_v60_attr: s.contains_v60_attr,
      contains_v61_attr: s.contains_v61_attr,
      contains_reconcile: s.contains_reconcile,
      contains_metric_from_text: s.contains_metric_from_text,
      contains_text_node_rewrite: s.contains_text_node_rewrite
    });
  }

  const hotText = popupHits.map(h => `===== ui/popup.js line ${h.line} needle [${h.needle}] =====\n${h.context}\n`).join("\n");
  const counterText = counterHits.map(h => `===== ui/popup.js line ${h.line} needle [${h.needle}] =====\n${h.context}\n`).join("\n");
  const manifestText = manifestHits.map(h => `===== manifest.json line ${h.line} needle [${h.needle}] =====\n${h.context}\n`).join("\n");

  writeText(path.join(auditRoot, "popup_hot_string_hits.txt"), hotText);
  writeText(path.join(auditRoot, "popup_counter_candidate_hits.txt"), counterText);
  writeText(path.join(auditRoot, "manifest_relevant_hits.txt"), manifestText);

  const contentInventory = [];
  for(const p of [runtimePath, ledgerPath]){
    const rel = path.relative(chromeRoot, p);
    if(fs.existsSync(p)){
      const t = readText(p);
      const lines = t.split("\n");
      const hits = hitsFor(lines, ["banner","suppression","ledger","session","timeline","lifetime","blocked","runtime"], 2);
      const out = path.join(auditRoot, "content_inventory_" + rel.replace(/[^A-Za-z0-9_.-]/g, "_") + ".txt");
      writeText(out, hits.map(h => `===== ${rel} line ${h.line} needle [${h.needle}] =====\n${h.context}\n`).join("\n"));
      contentInventory.push({
        relative_path: rel,
        exists: true,
        sha256: sha256(p),
        bytes: fs.statSync(p).size,
        hit_count: hits.length,
        inventory_path: out
      });
    } else {
      contentInventory.push({
        relative_path: rel,
        exists: false,
        sha256: null,
        bytes: 0,
        hit_count: 0,
        inventory_path: null
      });
    }
  }

  const audit = {
    schema: "cookiegate.v61.banner_semantics_owner_audit.strict.v1",
    generated_utc: new Date().toISOString(),
    chrome_root: chromeRoot,
    popup_path: popupPath,
    manifest_path: manifestPath,
    popup_sha256: sha256(popupPath),
    manifest_sha256: sha256(manifestPath),
    popup_bytes: fs.statSync(popupPath).size,
    manifest_bytes: fs.statSync(manifestPath).size,
    owner_conclusion: ownerConclusion,
    renderMetrics: renderMetrics ? {
      name: renderMetrics.name,
      start_line: renderMetrics.start_line,
      end_line: renderMetrics.end_line,
      contains_no_banner: renderMetrics.contains_no_banner,
      contains_this_site_now: renderMetrics.contains_this_site_now,
      contains_this_session: renderMetrics.contains_this_session,
      contains_site_timeline: renderMetrics.contains_site_timeline,
      contains_lifetime_blocked: renderMetrics.contains_lifetime_blocked
    } : null,
    renderLifetime: renderLifetime ? {
      name: renderLifetime.name,
      start_line: renderLifetime.start_line,
      end_line: renderLifetime.end_line,
      contains_no_banner: renderLifetime.contains_no_banner,
      contains_this_site_now: renderLifetime.contains_this_site_now,
      contains_this_session: renderLifetime.contains_this_session,
      contains_site_timeline: renderLifetime.contains_site_timeline,
      contains_lifetime_blocked: renderLifetime.contains_lifetime_blocked
    } : null,
    v61_reconcile_spans: v61Spans.map(s => ({
      name: s.name,
      start_line: s.start_line,
      end_line: s.end_line,
      contains_v61_attr: s.contains_v61_attr,
      contains_reconcile: s.contains_reconcile,
      contains_metric_from_text: s.contains_metric_from_text,
      contains_text_node_rewrite: s.contains_text_node_rewrite
    })),
    popup_hot_hit_count: popupHits.length,
    popup_counter_candidate_hit_count: counterHits.length,
    manifest_relevant_hit_count: manifestHits.length,
    banner_owner_spans: excerptIndex,
    content_inventory: contentInventory,
    patched: false,
    zipped: false
  };

  const auditJsonPath = path.join(auditRoot, "audit.json");
  writeText(auditJsonPath, JSON.stringify(audit, null, 2));

  const summary = [];
  summary.push("COOKIEGATE V61 BANNER SEMANTICS OWNER AUDIT STRICT");
  summary.push("Generated UTC: " + audit.generated_utc);
  summary.push("Chrome root: " + chromeRoot);
  summary.push("popup.js bytes: " + audit.popup_bytes);
  summary.push("popup.js SHA256: " + audit.popup_sha256);
  summary.push("manifest.json SHA256: " + audit.manifest_sha256);
  summary.push("Owner conclusion: " + ownerConclusion);
  summary.push("");
  summary.push("renderMetrics:");
  summary.push(renderMetrics ? `  lines ${renderMetrics.start_line}-${renderMetrics.end_line} noBanner=${renderMetrics.contains_no_banner} siteNow=${renderMetrics.contains_this_site_now} session=${renderMetrics.contains_this_session} timeline=${renderMetrics.contains_site_timeline} lifetime=${renderMetrics.contains_lifetime_blocked}` : "  NOT FOUND");
  summary.push("");
  summary.push("renderLifetime:");
  summary.push(renderLifetime ? `  lines ${renderLifetime.start_line}-${renderLifetime.end_line} noBanner=${renderLifetime.contains_no_banner} siteNow=${renderLifetime.contains_this_site_now} session=${renderLifetime.contains_this_session} timeline=${renderLifetime.contains_site_timeline} lifetime=${renderLifetime.contains_lifetime_blocked}` : "  NOT FOUND");
  summary.push("");
  summary.push("V61 reconcile spans:");
  for(const s of v61Spans){
    summary.push(`  - ${s.name} lines ${s.start_line}-${s.end_line} v61Attr=${s.contains_v61_attr} reconcile=${s.contains_reconcile} metricFromText=${s.contains_metric_from_text} textRewrite=${s.contains_text_node_rewrite}`);
  }
  summary.push("");
  summary.push("Banner owner spans:");
  for(const s of excerptIndex){
    summary.push(`  - ${s.name} lines ${s.start_line}-${s.end_line} noBanner=${s.contains_no_banner} siteNow=${s.contains_this_site_now} session=${s.contains_this_session} timeline=${s.contains_site_timeline} lifetime=${s.contains_lifetime_blocked} v60Attr=${s.contains_v60_attr} v61Attr=${s.contains_v61_attr} reconcile=${s.contains_reconcile}`);
  }
  summary.push("");
  summary.push("Hit counts:");
  summary.push("  popup_hot_string_hits: " + popupHits.length);
  summary.push("  popup_counter_candidate_hits: " + counterHits.length);
  summary.push("  manifest_relevant_hits: " + manifestHits.length);
  summary.push("");
  summary.push("Output files:");
  summary.push("  audit.json: " + auditJsonPath);
  summary.push("  popup_hot_string_hits.txt: " + path.join(auditRoot, "popup_hot_string_hits.txt"));
  summary.push("  popup_counter_candidate_hits.txt: " + path.join(auditRoot, "popup_counter_candidate_hits.txt"));
  summary.push("  manifest_relevant_hits.txt: " + path.join(auditRoot, "manifest_relevant_hits.txt"));
  summary.push("  span excerpts: " + auditRoot);

  const summaryPath = path.join(auditRoot, "audit_summary.txt");
  writeText(summaryPath, summary.join("\n"));

  console.log("COOKIEGATE_V61_BANNER_SEMANTICS_OWNER_AUDIT_STRICT_OK");
  console.log("AUDIT_JSON=" + auditJsonPath);
  console.log("AUDIT_SUMMARY=" + summaryPath);
}

main();
