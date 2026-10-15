/* CookieGate engine v0.1.6 — single source of truth for classification, policy,
 * root-domain handling, removal details, privacy-safe export shapes and evidence
 * records. Pure functions only (no DOM, no browser APIs) so it can be unit-tested.
 *
 * Classification = the UNION of every classifier that existed before v0.1.6
 * (popup Active Site, popup Browser Observer v3, popup router v7, Chrome service
 * worker), evaluated login/security FIRST so it is never less protective than any
 * prior classifier, plus a vendor signature table used for "Source" attribution.
 * Policy = the Chrome service worker's determineBasePolicyAction, verbatim.
 */
(function(root){
  "use strict";

  var MODES = ["strict","balanced","trusted"];

  /* ---------- root domain (eTLD+1 heuristic) ---------- */
  var MULTI = {"co.uk":1,"org.uk":1,"gov.uk":1,"ac.uk":1,"me.uk":1,"ltd.uk":1,"plc.uk":1,"net.uk":1,
    "com.au":1,"net.au":1,"org.au":1,"edu.au":1,"gov.au":1,"co.nz":1,"org.nz":1,"govt.nz":1,"ac.nz":1,
    "co.jp":1,"ne.jp":1,"or.jp":1,"ac.jp":1,"go.jp":1,"co.kr":1,"or.kr":1,"com.br":1,"net.br":1,"org.br":1,"gov.br":1,
    "com.mx":1,"org.mx":1,"com.ar":1,"com.co":1,"com.tr":1,"com.sg":1,"com.hk":1,"com.tw":1,"com.cn":1,"net.cn":1,"org.cn":1,
    "co.in":1,"net.in":1,"org.in":1,"gov.in":1,"ac.in":1,"co.za":1,"org.za":1,"co.il":1,"org.il":1,"ac.il":1,
    "com.pl":1,"com.ua":1,"com.my":1,"com.ph":1,"com.vn":1,"com.pk":1,"com.eg":1,"com.sa":1,"co.id":1,"or.id":1,"co.th":1,"in.th":1};
  function hostOf(input){
    var s = String(input || "").trim().toLowerCase();
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
    s = s.split("/")[0].split("?")[0].split("#")[0];
    s = s.replace(/^[^@]*@/, "").replace(/:\d+$/, "").replace(/^\.+|\.+$/g, "");
    return s;
  }
  function isIp(h){ return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.indexOf(":") >= 0; }
  function rootDomain(input){
    var h = hostOf(input);
    if(!h || isIp(h) || h.indexOf(".") < 0) return h;
    var parts = h.split(".");
    if(parts.length <= 2) return h;
    var last2 = parts.slice(-2).join(".");
    if(MULTI[last2]) return parts.slice(-3).join(".");
    return last2;
  }
  function looksLikeDomain(input){
    var h = hostOf(input);
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h) && /[a-z]/.test(h.split(".").pop());
  }
  function cookieBelongsTo(cookieDomain, siteRoot){
    var d = String(cookieDomain || "").replace(/^\./, "").toLowerCase();
    var r = String(siteRoot || "").toLowerCase();
    return !!r && (d === r || d.slice(-(r.length + 1)) === "." + r);
  }

  /* ---------- vendor signatures (attribution only; never downgrades a login) ---------- */
  var VENDORS = [
    [/^_ga($|_)/, "Google Analytics", "trk"], [/^_gid$/, "Google Analytics", "trk"], [/^_gat($|_)/, "Google Analytics", "trk"],
    [/^__utm[a-z]$/, "Google Analytics (legacy)", "trk"], [/^_gcl_/, "Google Ads", "trk"], [/^gclid$/, "Google Ads", "trk"],
    [/^(ide|dsid|test_cookie)$/, "Google DoubleClick", "trk"], [/^(__gads|__gpi|__eoi)$/, "Google Ad Manager", "trk"],
    [/^_fb[pc]$/, "Meta Pixel", "trk"], [/^fr$/, "Meta Pixel", "trk"],
    [/^amcvs?_/, "Adobe Experience Cloud", "trk"], [/^s_ecid$/, "Adobe Experience Cloud", "trk"],
    [/^s_(cc|sq|vi|fid|nr|ppv|tp)$/, "Adobe Analytics", "trk"], [/^mbox/, "Adobe Target", "trk"], [/demdex/, "Adobe Audience Manager", "trk"],
    [/^_cb($|_)/, "Chartbeat", "trk"], [/chartbeat/, "Chartbeat", "trk"],
    [/^_pc(id|tx)$/, "Piano", "trk"], [/^cx_[pg]$/, "Piano Cxense", "trk"],
    [/^_sp_(id|ses)\./, "Snowplow", "trk"],
    [/^_uet(sid|vid)/, "Microsoft Ads", "trk"], [/^_cl(ck|sk)$/, "Microsoft Clarity", "trk"],
    [/^_hj/, "Hotjar", "trk"], [/^_ttp$|^tt_/, "TikTok Pixel", "trk"], [/^_scid/, "Snap Pixel", "trk"],
    [/^_rdt_/, "Reddit Pixel", "trk"], [/^_pin_/, "Pinterest Tag", "trk"], [/^__qca$/, "Quantcast", "trk"],
    [/^_ym_/, "Yandex Metrica", "trk"], [/^optimizely/, "Optimizely", "trk"], [/^_dd_s$/, "Datadog RUM", "trk"],
    [/^optanon/, "OneTrust consent", "pref"], [/^euconsent/, "IAB TCF consent", "pref"], [/^usprivacy$/, "IAB US privacy (CCPA)", "pref"],
    [/^cookieconsent/, "Cookie consent choice", "pref"]
  ];
  function vendorOf(name){
    var n = String(name || "").toLowerCase();
    for(var i = 0; i < VENDORS.length; i++){ if(VENDORS[i][0].test(n)) return { vendor: VENDORS[i][1], hint: VENDORS[i][2] }; }
    return { vendor: "", hint: "" };
  }

  /* ---------- unified classifier (service-worker vocabulary) ---------- */
  function has(n, list){ for(var i = 0; i < list.length; i++){ if(n.indexOf(list[i]) >= 0) return true; } return false; }
  var AUTH_SUB = ["session","sess","token","auth","login","waf","keycloak","account"];
  var SEC_SUB = ["csrf","xsrf","__host-","__secure-"];
  var PREF_SUB = ["pref","i18n","lc-","consent","lang","theme","locale","optanon","usprivacy"];
  var TRK_SUB = ["amcv","adobe","track","target","ubid","x-main","demdex","_fbp","_gcl","__utm","utm","conversion","uid","uuid","_ga","_gid","_dd","gclid","analytics"];

  function classify(cookie, siteRoot){
    var n = String(cookie && cookie.name || "").toLowerCase();
    var v = vendorOf(n);
    var cls;
    if(n === "sid" || has(n, AUTH_SUB)) cls = "auth/session";
    else if(has(n, SEC_SUB)) cls = "security";
    else if(n === "skin" || has(n, PREF_SUB) || v.hint === "pref") cls = "preferences";
    else if(has(n, TRK_SUB) || v.hint === "trk") cls = "analytics/tracking";
    else if(siteRoot && cookie && cookie.domain && !cookieBelongsTo(cookie.domain, siteRoot)) cls = "third-party/unknown";
    else cls = "unknown";
    return { cls: cls, vendor: v.vendor, group: groupOf(cls) };
  }
  function groupOf(cls){
    if(cls === "auth/session" || cls === "security") return "auth";
    if(cls === "preferences") return "pref";
    if(cls === "analytics/tracking") return "trk";
    return "unk";
  }
  function v3Class(cls){
    var g = groupOf(cls);
    return g === "auth" ? "auth/session" : g === "pref" ? "preferences" : g === "trk" ? "tracking" : "unknown";
  }

  /* ---------- policy: Chrome service worker determineBasePolicyAction, verbatim ---------- */
  function policyFor(cookie, classification, effectiveMode){
    if(effectiveMode === "trusted"){
      return cookie.session ? "allow-session" : "allow-persistent";
    }
    if(effectiveMode === "balanced"){
      if(classification === "analytics/tracking" || classification === "third-party/unknown") return "delete-on-exit";
      if(classification === "auth/session" || classification === "security" || classification === "preferences"){
        return cookie.session ? "allow-session" : "allow-until-exit";
      }
      return cookie.session ? "allow-session" : "review";
    }
    if(classification === "auth/session" || classification === "security"){
      return cookie.session ? "allow-session" : "allow-until-exit";
    }
    if(classification === "preferences") return cookie.session ? "allow-session" : "delete-on-exit";
    if(classification === "analytics/tracking" || classification === "third-party/unknown") return "delete-on-exit";
    return cookie.session ? "allow-session" : "review";
  }
  /* What "Clean" removes: the policy's delete-on-exit set, never keep-always cookies. */
  function cleanRemoves(cookie, classification, mode, keepAlways){
    return !keepAlways && policyFor(cookie, classification, mode) === "delete-on-exit";
  }
  /* What "Wipe" removes: the service worker's manual-wipe set. Logins, security and
   * session-scoped cookies are preserved unless the user explicitly includes logins. */
  function wipeRemoves(cookie, classification, mode, keepAlways, includeLogins){
    if(keepAlways) return false;
    if(includeLogins) return true;
    return !(classification === "auth/session" || classification === "security" || policyFor(cookie, classification, mode) === "allow-session");
  }

  /* ---------- cookie identity, removal, hashing ---------- */
  function cookieKey(c){ return (c.domain || "") + "|" + (c.path || "") + "|" + (c.name || ""); }
  function dedupeKey(c){
    var pk = ""; try { pk = c.partitionKey ? JSON.stringify(c.partitionKey) : ""; } catch(e){}
    return [c.storeId || "", c.firstPartyDomain || "", pk, c.domain || "", c.path || "", c.name || ""].join("|");
  }
  function removalDetails(c){
    var host = String(c.domain || "").replace(/^\./, "");
    var d = { url: (c.secure ? "https://" : "http://") + host + (c.path || "/"), name: c.name };
    if(c.storeId) d.storeId = c.storeId;
    if(c.partitionKey) d.partitionKey = c.partitionKey;
    if(c.firstPartyDomain) d.firstPartyDomain = c.firstPartyDomain;
    return d;
  }
  function hashPreview(value){ /* identical to the v3 popup hashPreviewV3 */
    if(value === null || value === undefined) return "-";
    var s = String(value), h = 0;
    for(var i = 0; i < s.length; i++){ h = ((h << 5) - h) + s.charCodeAt(i); h = h | 0; }
    return ("00000000" + (h >>> 0).toString(16)).slice(-8);
  }
  function stableHash(input){ /* identical to the service worker stableHash */
    var hash = 5381;
    for(var i = 0; i < input.length; i++){ hash = ((hash << 5) + hash) + input.charCodeAt(i); hash = hash >>> 0; }
    return hash.toString(16).padStart(8, "0");
  }

  /* ---------- privacy-safe shapes (raw values never included) ---------- */
  function sanitize(c, siteRoot, mode, keepAlways){
    var k = classify(c, siteRoot);
    return {
      name: String(c.name || ""), domain: String(c.domain || ""), path: String(c.path || "/"),
      session: !!c.session, secure: !!c.secure, httpOnly: !!c.httpOnly,
      sameSite: String(c.sameSite || "unspecified"), hostOnly: !!c.hostOnly,
      storeId: c.storeId === undefined ? null : String(c.storeId),
      expirationDate: c.expirationDate === undefined ? null : c.expirationDate,
      valueHashPreview: hashPreview(c.value),
      classification: v3Class(k.cls),
      classification_detail: k.cls,
      vendor: k.vendor || null,
      policyAction: keepAlways ? "keep-always" : policyFor(c, k.cls, mode)
    };
  }
  function analyze(cookies){ /* same shape as the v3 popup analyzeV3 */
    var byDomain = {}, byClass = { authSession:0, preferences:0, tracking:0, unknown:0 };
    cookies.forEach(function(c){
      var d = String(c.domain || "unknown").replace(/^\./, "");
      var cls = String(c.classification || "unknown").toLowerCase();
      if(!byDomain[d]) byDomain[d] = { domain:d, count:0, authSession:0, preferences:0, tracking:0, unknown:0, important:0 };
      var row = byDomain[d]; row.count++;
      if(cls === "auth/session"){ byClass.authSession++; row.authSession++; }
      else if(cls === "preferences"){ byClass.preferences++; row.preferences++; }
      else if(cls === "tracking"){ byClass.tracking++; row.tracking++; row.important++; }
      else { byClass.unknown++; row.unknown++; row.important++; }
    });
    var domains = Object.keys(byDomain).map(function(k){ return byDomain[k]; }).sort(function(a,b){ return b.count - a.count || a.domain.localeCompare(b.domain); });
    return { totalCookies: cookies.length, totalDomains: domains.length, byClass: byClass, reviewOrTracking: byClass.tracking + byClass.unknown, topDomains: domains.slice(0,10), domains: domains };
  }
  function evidenceRecord(eventType, payload, isoTime){
    var ts = isoTime || new Date().toISOString();
    return { event_type: eventType, event_id: stableHash(eventType + "|" + ts + "|" + JSON.stringify(payload)), timestamp_utc: ts, payload: payload };
  }

  var api = { MODES:MODES, VENDORS:VENDORS, hostOf:hostOf, rootDomain:rootDomain, looksLikeDomain:looksLikeDomain, cookieBelongsTo:cookieBelongsTo,
    vendorOf:vendorOf, classify:classify, groupOf:groupOf, v3Class:v3Class, policyFor:policyFor, cleanRemoves:cleanRemoves, wipeRemoves:wipeRemoves,
    cookieKey:cookieKey, dedupeKey:dedupeKey, removalDetails:removalDetails, hashPreview:hashPreview, stableHash:stableHash,
    sanitize:sanitize, analyze:analyze, evidenceRecord:evidenceRecord, VERSION:"0.1.8" };
  root.CookieGateEngine = api;
  if(typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
