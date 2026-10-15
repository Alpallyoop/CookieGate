// Parity + safety tests for CookieGate engine v0.1.6.
// Extracts the PRE-v0.1.6 classifiers/policy verbatim from the existing code and
// compares them with ui/cg_engine.js. Run: node engine_parity_tests.mjs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const FIX = join(HERE, "fixtures", "legacy_v0.1.5");
const require = createRequire(import.meta.url);
const E = require(join(ROOT, "src", "shared", "ui", "cg_engine.js"));

const OLD_POPUP = readFileSync(join(FIX, "popup_v0.1.5.js"), "utf8");
const OLD_SW = readFileSync(join(FIX, "service_worker_v0.1.2.js"), "utf8");
function extract(code, sig){
  const at = code.indexOf(sig); if(at < 0) throw new Error("not found: " + sig);
  const open = code.indexOf("{", code.indexOf(")", at)); let d = 0, i = open;
  for(; i < code.length; i++){ if(code[i] === "{") d++; else if(code[i] === "}"){ d--; if(d === 0){ i++; break; } } }
  return code.slice(at, i);
}
const safe = (v, f) => (v === undefined || v === null || v === "") ? (f === undefined ? "" : f) : String(v);
const oldActive = new Function("safe", extract(OLD_POPUP, "function classifyCookie(c)") + "; return classifyCookie;")(safe);
const oldV3 = new Function(extract(OLD_POPUP, "function classifyNameV3(") + "; return classifyNameV3;")();
const swSrc = [
  extract(OLD_SW, "function normalizeCookieDomain("),
  extract(OLD_SW, "function classifyCookie(cookie, siteHostname)"),
  extract(OLD_SW, "function determineBasePolicyAction("),
  extract(OLD_SW, "function stableHash(")
].join("\n");
const SW = new Function(swSrc + "; return {classifyCookie, determineBasePolicyAction, stableHash};")();
const oldHash = new Function(extract(OLD_POPUP, "function hashPreviewV3(") + "; return hashPreviewV3;")();

let pass = 0, fail = 0; const fails = [];
const ok = (name, cond) => { if(cond) pass++; else { fail++; fails.push(name); } };

const NAMES = ["_ga","_ga_XJ4T","_gid","_gat","_gat_UA-1","__utma","__utmz","_gcl_au","gclid","IDE","DSID","test_cookie","__gads","__gpi","NID","1P_JAR","SID","HSID","SSID","APISID","SAPISID","__Secure-3PSID","__Host-GAPS","CONSENT","SOCS","AEC","OTZ",
 "_fbp","_fbc","fr","datr","sb","c_user","xs","wd","csrftoken","sessionid","ds_user_id","mid","ig_did","rur","li_at","JSESSIONID","bcookie","lidc","UserMatchHistory","AnalyticsSyncHistory","li_gc",
 "_uetsid","_uetvid","MUID","_clck","_clsk","ANONCHK","_hjSessionUser_123","_hjSession_123","_hjid","OptanonConsent","OptanonAlertBoxClosed","euconsent-v2","usprivacy","CookieConsent","cookieconsent_status",
 "_ttp","tt_webid","_scid","_rdt_uuid","_pin_unauth","__qca","_ym_uid","cf_clearance","__cf_bm","_cfuvid","PHPSESSID","ASP.NET_SessionId","laravel_session","XSRF-TOKEN","remember_web_59ba","wp-settings-1","wordpress_logged_in_ab",
 "lang","locale","theme","timezone","currency","cart","_shopify_y","_shopify_s","_orig_referrer","ajs_anonymous_id","ajs_user_id","mp_1a2b_mixpanel","amplitude_id_x","intercom-id-x","intercom-session-x","__stripe_mid","__stripe_sid","_dd_s",
 "optimizelyEndUserId","optimizelySession","s_ecid","AMCV_7FF8","AMCVS_7FF8","s_cc","s_sq","mbox","demdex","_cb","_cb_svref","_chartbeat2","_v__chartbeat3","_pcid","_pctx","cX_P","cX_G","_sp_id.f5fb","_sp_ses.f5fb","sp",
 "ubid-main","x-main","session-id","session-token","at-main","i18n-prefs","lc-main","skin","csm-hit","sendAuthToken","resolveAuthTimestamp","WMUKID_STABLE","wbdLTP","datid","CDPID","sendWMSegs","FastAB","umto","sato","psmPageLoadId","g_state","SecGpc","__idcontext","countryCode","stateCode","nexus-web-app-id","visitor_id","_uid","ab_bucket","exp_group","tz","ref_src","account_pref","user_token","trackingConsent","login_redirect","sid"];

// 1) SAFETY: anything any old classifier treated as login/security must stay login/security.
let safetyChecked = 0;
for(const n of NAMES){
  const c = { name:n, domain:".example.com" };
  const olds = [oldActive(c), oldV3(n), SW.classifyCookie(c, "example.com")];
  const newCls = E.classify(c, "example.com").cls;
  if(olds.some(o => o === "auth/session" || o === "security")){
    safetyChecked++;
    ok("safety:" + n + " old=" + olds.join("/") + " new=" + newCls, newCls === "auth/session" || newCls === "security");
  }
}
// 2) POLICY: engine policy must equal the service worker's for every class/mode/session combo.
const CLASSES = ["auth/session","security","preferences","analytics/tracking","third-party/unknown","unknown"];
for(const cls of CLASSES) for(const mode of ["strict","balanced","trusted"]) for(const session of [true,false]){
  ok(`policy:${cls}/${mode}/${session}`, E.policyFor({session}, cls, mode) === SW.determineBasePolicyAction({session}, cls, mode));
}
// 3) HASHES identical to prior implementations.
for(const v of ["", "abc", "a".repeat(500), "ünïcødé", "1234567890"]) {
  ok("hashPreview:" + v.slice(0,8), E.hashPreview(v) === oldHash(v));
  ok("stableHash:" + v.slice(0,8), E.stableHash(v) === SW.stableHash(v));
}
// 4) ROOT DOMAIN normalization (handoff Rule 3).
const RD = [["bbc.com","bbc.com"],["www.bbc.com","bbc.com"],["https://www.bbc.com/news","bbc.com"],["bbc.com/sjfsdklds/cfdja/fdmkaf","bbc.com"],["edition.cnn.com","cnn.com"],["news.bbc.co.uk","bbc.co.uk"],["http://localhost:8080/x","localhost"],["192.168.1.10","192.168.1.10"],["shop.example.com.au","example.com.au"]];
for(const [i,o] of RD) ok("root:" + i, E.rootDomain(i) === o);
ok("belongs:.cnn.com", E.cookieBelongsTo(".cnn.com","cnn.com")); ok("belongs:collector.cdp.cnn.com", E.cookieBelongsTo("collector.cdp.cnn.com","cnn.com")); ok("notbelongs:evilcnn.com", !E.cookieBelongsTo("evilcnn.com","cnn.com"));
// 5) CLEAN never removes logins/security in any mode; WIPE preserves them unless explicitly included.
for(const cls of ["auth/session","security"]) for(const mode of ["strict","balanced","trusted"]) for(const session of [true,false]){
  ok(`clean-keeps-${cls}/${mode}/${session}`, !E.cleanRemoves({session}, cls, mode, false));
  ok(`wipe-keeps-${cls}/${mode}/${session}`, !E.wipeRemoves({session}, cls, mode, false, false));
  ok(`wipe-explicit-${cls}/${mode}/${session}`, E.wipeRemoves({session}, cls, mode, false, true));
}
ok("keep-always-never-cleaned", !E.cleanRemoves({session:false}, "analytics/tracking", "strict", true));
ok("keep-always-never-wiped", !E.wipeRemoves({session:false}, "analytics/tracking", "strict", true, true));
ok("trusted-cleans-nothing", CLASSES.every(c => !E.cleanRemoves({session:false}, c, "trusted", false)));
// 6) PRIVACY: sanitized output never contains the raw value.
const raw = "SECRET-RAW-VALUE-123";
const s = E.sanitize({ name:"_ga", domain:".cnn.com", value:raw }, "cnn.com", "strict", false);
ok("sanitize-no-raw", !JSON.stringify(s).includes(raw) && s.valueHashPreview === E.hashPreview(raw));
// 7) Evidence record shape matches the service worker's appendEvidence record.
const rec = E.evidenceRecord("cookiegate.cookie.delete.v1", {site:"cnn.com"}, "2026-01-01T00:00:00.000Z");
ok("evidence-shape", ["event_type","event_id","timestamp_utc","payload"].every(k => k in rec) && rec.event_id.length === 8);

// REPORT: category shifts vs the old Active Site classifier and the service worker.
const shifts = [];
for(const n of NAMES){
  const c = { name:n, domain:".example.com" };
  const a = oldActive(c), w = SW.classifyCookie(c, "example.com"), e = E.classify(c, "example.com");
  const norm = x => x === "analytics/tracking" ? "tracking" : (x === "third-party/unknown" ? "unknown" : x);
  if(norm(w) !== norm(e.cls) || a !== E.v3Class(e.cls)) shifts.push([n, a, w, e.cls, e.vendor]);
}
console.log(`\nSafety cases checked: ${safetyChecked} (names any old classifier called login/security)`);
console.log(`Category shifts vs old (name | old Active Site | old service worker | NEW | vendor): ${shifts.length} of ${NAMES.length}`);
shifts.forEach(r => console.log("  " + r.map(x => String(x || "-")).join(" | ")));
console.log(`\n${pass}/${pass + fail} checks passed`);
if(fail){ console.log("FAILURES:"); fails.forEach(f => console.log("  " + f)); process.exit(1); }
