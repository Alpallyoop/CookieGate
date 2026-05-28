console.log("COOKIEGATE_FIREFOX_BACKGROUND_LOADED");

const DEFAULT_GLOBAL_MODE = "strict";
const ALLOWED_MODES = new Set(["strict", "balanced", "trusted"]);
const MAX_EVIDENCE_EVENTS = 200;

const activeSiteTabs = new Map();
const tabSiteIndex = new Map();
const lastCookieStateBySite = new Map();

function buildCookieStateKey(cookies) {
  return cookies
    .map((cookie) => [
      cookie.domain || "",
      cookie.path || "",
      cookie.name || "",
      cookie.classification || "",
      cookie.policyAction || "",
      cookie.keepAlways ? "keep" : "no-keep"
    ].join("|"))
    .sort()
    .join(";");
}

async function appendInspectEvidenceIfChanged(siteHostname, payload) {
  const stateKey = buildCookieStateKey(payload.cookies || []);
  const previousKey = lastCookieStateBySite.get(siteHostname);

  if (stateKey === previousKey) {
    return false;
  }

  lastCookieStateBySite.set(siteHostname, stateKey);
  await appendEvidence("cookiegate.cookie.inspect.v1", payload);
  return true;
}


browser.runtime.onInstalled.addListener(() => {
  console.log("COOKIEGATE_INSTALLED");
});

function nowIso() {
  return new Date().toISOString();
}

function stableHash(input) {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash) + input.charCodeAt(i);
    hash = hash >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function normalizeHostname(hostname) {
  return String(hostname || "").trim().toLowerCase();
}

function normalizeCookieDomain(cookieDomain) {
  return String(cookieDomain || "").replace(/^\./, "").trim().toLowerCase();
}

function cookieRuleKey(cookie) {
  return `${cookie.domain || ""}|${cookie.path || ""}|${cookie.name || ""}`;
}

function classifyCookie(cookie, siteHostname) {
  const name = (cookie.name || "").toLowerCase();
  const domain = (cookie.domain || "").toLowerCase();

  if (
    name.includes("sess") ||
    name === "sid" ||
    name.includes("auth") ||
    name.includes("token") ||
    name.includes("login")
  ) {
    return "auth/session";
  }

  if (
    name.includes("csrf") ||
    name.includes("xsrf") ||
    name.includes("__host-") ||
    name.includes("__secure-")
  ) {
    return "security";
  }

  if (
    name.includes("lang") ||
    name.includes("theme") ||
    name.includes("pref") ||
    name.includes("locale")
  ) {
    return "preferences";
  }

  if (
    name.includes("_ga") ||
    name.includes("_gid") ||
    name.includes("_fbp") ||
    name.includes("analytics") ||
    name.includes("track") ||
    name.includes("utm")
  ) {
    return "analytics/tracking";
  }

  if (domain !== siteHostname && !siteHostname.endsWith(domain.replace(/^\./, ""))) {
    return "third-party/unknown";
  }

  return "unknown";
}

function domainMatchesSite(cookieDomain, siteHostname) {
  if (!cookieDomain || !siteHostname) {
    return false;
  }

  const normalizedCookieDomain = normalizeCookieDomain(cookieDomain);
  const normalizedSite = normalizeHostname(siteHostname);

  return (
    normalizedSite === normalizedCookieDomain ||
    normalizedSite.endsWith("." + normalizedCookieDomain)
  );
}

async function getPolicyState() {
  const result = await browser.storage.local.get([
    "cookiegateGlobalMode",
    "cookiegateSiteModes",
    "cookiegateKeepRules",
    "cookiegateEvidenceLog"
  ]);

  return {
    globalMode: ALLOWED_MODES.has(result.cookiegateGlobalMode) ? result.cookiegateGlobalMode : DEFAULT_GLOBAL_MODE,
    siteModes: result.cookiegateSiteModes && typeof result.cookiegateSiteModes === "object" ? result.cookiegateSiteModes : {},
    keepRules: result.cookiegateKeepRules && typeof result.cookiegateKeepRules === "object" ? result.cookiegateKeepRules : {},
    evidenceLog: Array.isArray(result.cookiegateEvidenceLog) ? result.cookiegateEvidenceLog : []
  };
}

async function appendEvidence(eventType, payload) {
  const state = await getPolicyState();
  const timestamp = nowIso();

  const record = {
    event_type: eventType,
    event_id: stableHash(`${eventType}|${timestamp}|${JSON.stringify(payload)}`),
    timestamp_utc: timestamp,
    payload
  };

  const next = [record, ...state.evidenceLog].slice(0, MAX_EVIDENCE_EVENTS);
  await browser.storage.local.set({ cookiegateEvidenceLog: next });

  // quiet by default: evidence is visible in the popup log, not spammed to console
  return record;
}

async function setGlobalMode(mode) {
  if (!ALLOWED_MODES.has(mode)) {
    throw new Error("INVALID_GLOBAL_MODE");
  }

  await browser.storage.local.set({ cookiegateGlobalMode: mode });
  await appendEvidence("cookiegate.policy.global_mode_set.v1", { mode });
}

async function setSiteMode(siteHostname, mode) {
  if (!ALLOWED_MODES.has(mode)) {
    throw new Error("INVALID_SITE_MODE");
  }

  const normalizedSite = normalizeHostname(siteHostname);
  if (!normalizedSite) {
    throw new Error("INVALID_SITE_HOSTNAME");
  }

  const state = await getPolicyState();
  state.siteModes[normalizedSite] = mode;

  await browser.storage.local.set({ cookiegateSiteModes: state.siteModes });
  await appendEvidence("cookiegate.policy.site_mode_set.v1", { site: normalizedSite, mode });
}

async function clearSiteMode(siteHostname) {
  const normalizedSite = normalizeHostname(siteHostname);
  if (!normalizedSite) {
    throw new Error("INVALID_SITE_HOSTNAME");
  }

  const state = await getPolicyState();
  delete state.siteModes[normalizedSite];

  await browser.storage.local.set({ cookiegateSiteModes: state.siteModes });
  await appendEvidence("cookiegate.policy.site_mode_cleared.v1", { site: normalizedSite });
}

async function setKeepRule(siteHostname, cookieKey, keepAlways) {
  const normalizedSite = normalizeHostname(siteHostname);
  if (!normalizedSite) {
    throw new Error("INVALID_SITE_HOSTNAME");
  }

  if (!cookieKey) {
    throw new Error("INVALID_COOKIE_KEY");
  }

  const state = await getPolicyState();
  if (!state.keepRules[normalizedSite] || typeof state.keepRules[normalizedSite] !== "object") {
    state.keepRules[normalizedSite] = {};
  }

  if (keepAlways) {
    state.keepRules[normalizedSite][cookieKey] = true;
  } else {
    delete state.keepRules[normalizedSite][cookieKey];
  }

  await browser.storage.local.set({ cookiegateKeepRules: state.keepRules });
  await appendEvidence("cookiegate.policy.keep_rule_set.v1", {
    site: normalizedSite,
    cookieKey,
    keepAlways: Boolean(keepAlways)
  });
}

function determineBasePolicyAction(cookie, classification, effectiveMode) {
  if (effectiveMode === "trusted") {
    return cookie.session ? "allow-session" : "allow-persistent";
  }

  if (effectiveMode === "balanced") {
    if (classification === "analytics/tracking" || classification === "third-party/unknown") {
      return "delete-on-exit";
    }

    if (
      classification === "auth/session" ||
      classification === "security" ||
      classification === "preferences"
    ) {
      return cookie.session ? "allow-session" : "allow-until-exit";
    }

    return cookie.session ? "allow-session" : "review";
  }

  if (classification === "auth/session" || classification === "security") {
    return cookie.session ? "allow-session" : "allow-until-exit";
  }

  if (classification === "preferences") {
    return cookie.session ? "allow-session" : "delete-on-exit";
  }

  if (classification === "analytics/tracking" || classification === "third-party/unknown") {
    return "delete-on-exit";
  }

  return cookie.session ? "allow-session" : "review";
}

function normalizeCookie(cookie, siteHostname, effectiveMode, keepAlways) {
  const classification = classifyCookie(cookie, siteHostname);
  let policyAction = determineBasePolicyAction(cookie, classification, effectiveMode);

  if (keepAlways) {
    policyAction = "keep-always";
  }

  return {
    name: cookie.name,
    domain: cookie.domain,
    path: cookie.path,
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    session: Boolean(cookie.session),
    sameSite: cookie.sameSite || "unspecified",
    storeId: cookie.storeId || "",
    expirationDate: cookie.expirationDate || null,
    hostOnly: Boolean(cookie.hostOnly),
    partitionKey: cookie.partitionKey || null,
    valueHashPreview: typeof cookie.value === "string" && cookie.value.length > 0 ? stableHash(cookie.value) : "",
    classification,
    policyAction,
    matchesSite: domainMatchesSite(cookie.domain, siteHostname),
    keepAlways: Boolean(keepAlways),
    cookieKey: cookieRuleKey(cookie)
  };
}

async function getActiveHttpTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });

  if (!tab || !tab.url) {
    throw new Error("NO_ACTIVE_TAB");
  }

  const url = new URL(tab.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("UNSUPPORTED_PROTOCOL");
  }

  return {
    tab,
    url,
    siteHostname: normalizeHostname(url.hostname)
  };
}

async function inspectActiveTabCookies() {
  const { tab, url, siteHostname } = await getActiveHttpTab();
  const state = await getPolicyState();

  const siteMode = state.siteModes[siteHostname] || null;
  const effectiveMode = siteMode || state.globalMode;
  const keepRulesForSite = state.keepRules[siteHostname] || {};

  const byHref = await browser.cookies.getAll({ url: url.href });
  const byOrigin = await browser.cookies.getAll({ url: url.origin + "/" });
  const byDomain = await browser.cookies.getAll({ domain: siteHostname });

  const dedupedMap = new Map();
  for (const cookie of [...byHref, ...byOrigin, ...byDomain]) {
    const key = `${cookie.storeId || ""}|${cookie.domain || ""}|${cookie.path || ""}|${cookie.name || ""}`;
    if (!dedupedMap.has(key)) {
      dedupedMap.set(key, cookie);
    }
  }

  const rawCookies = Array.from(dedupedMap.values());

  const normalized = rawCookies
    .filter((cookie) => domainMatchesSite(cookie.domain, siteHostname))
    .map((cookie) => {
      const key = cookieRuleKey(cookie);
      const keepAlways = Boolean(keepRulesForSite[key]);
      return normalizeCookie(cookie, siteHostname, effectiveMode, keepAlways);
    })
    .sort((a, b) => `${a.domain}|${a.path}|${a.name}`.localeCompare(`${b.domain}|${b.path}|${b.name}`));

  await appendInspectEvidenceIfChanged(siteHostname, {
    tab_id: tab.id,
    site: siteHostname,
    url: url.href,
    count: normalized.length,
    cookies: normalized.map((cookie) => ({
      name: cookie.name,
      domain: cookie.domain,
      path: cookie.path,
      classification: cookie.classification,
      policy_action: cookie.policyAction,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      session: cookie.session
    }))
  });

  const refreshed = await getPolicyState();

  return {
    ok: true,
    tabId: tab.id,
    site: siteHostname,
    url: url.href,
    count: normalized.length,
    globalMode: state.globalMode,
    siteMode,
    effectiveMode,
    cookies: normalized,
    evidence: refreshed.evidenceLog
  };
}

function buildCookieRemovalUrl(cookie) {
  const protocol = cookie.secure ? "https:" : "http:";
  const host = normalizeCookieDomain(cookie.domain);
  const path = cookie.path || "/";
  return `${protocol}//${host}${path}`;
}

async function wipeCookiesForActiveSite(reason) {
  const inspection = await inspectActiveTabCookies();
    const deletable = inspection.cookies.filter((cookie) => {
    if (cookie.keepAlways) {
      return false;
    }

    if (reason === "manual-wipe") {
      return !(
        cookie.classification === "auth/session" ||
        cookie.classification === "security" ||
        cookie.policyAction === "allow-session"
      );
    }

    return cookie.policyAction === "delete-on-exit";
  });

  const deleted = [];
  const failed = [];

  for (const cookie of deletable) {
    try {
      const removeDetails = {
        url: buildCookieRemovalUrl(cookie),
        name: cookie.name,
        storeId: cookie.storeId
      };

      if (cookie.partitionKey) {
        removeDetails.partitionKey = cookie.partitionKey;
      }

      const result = await browser.cookies.remove(removeDetails);

      if (result) {
        deleted.push({
          name: cookie.name,
          domain: cookie.domain,
          path: cookie.path,
          cookieKey: cookie.cookieKey
        });

        await appendEvidence("cookiegate.cookie.delete.v1", {
          site: inspection.site,
          reason,
          result: "deleted",
          name: cookie.name,
          domain: cookie.domain,
          path: cookie.path
        });
      } else {
        failed.push({
          name: cookie.name,
          domain: cookie.domain,
          path: cookie.path,
          error: "REMOVE_RETURNED_NULL"
        });

        await appendEvidence("cookiegate.cookie.delete.v1", {
          site: inspection.site,
          reason,
          result: "failed",
          error: "REMOVE_RETURNED_NULL",
          name: cookie.name,
          domain: cookie.domain,
          path: cookie.path
        });
      }
    } catch (error) {
      const errorText = String(error && error.message ? error.message : error);

      failed.push({
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path,
        error: errorText
      });

      await appendEvidence("cookiegate.cookie.delete.v1", {
        site: inspection.site,
        reason,
        result: "failed",
        error: errorText,
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path
      });
    }
  }

  await appendEvidence("cookiegate.cookie.wipe.v1", {
    site: inspection.site,
    reason,
    deletedCount: deleted.length,
    failedCount: failed.length,
    deleted,
    failed
  });

  const refreshedInspection = await inspectActiveTabCookies();

  return {
    ok: true,
    site: refreshedInspection.site,
    deletedCount: deleted.length,
    failedCount: failed.length,
    deleted,
    failed,
    inspection: refreshedInspection
  };
}

function removeTabTracking(tabId) {
  const existingSite = tabSiteIndex.get(tabId);
  if (!existingSite) {
    return null;
  }

  tabSiteIndex.delete(tabId);

  const siteTabs = activeSiteTabs.get(existingSite);
  if (siteTabs) {
    siteTabs.delete(tabId);
    if (siteTabs.size === 0) {
      activeSiteTabs.delete(existingSite);
    }
  }

  return existingSite;
}

function recordTabSite(tabId, siteHostname) {
  const normalizedSite = normalizeHostname(siteHostname);
  if (!normalizedSite) {
    return;
  }

  const previousSite = tabSiteIndex.get(tabId);
  if (previousSite === normalizedSite) {
    return;
  }

  if (previousSite) {
    removeTabTracking(tabId);
  }

  tabSiteIndex.set(tabId, normalizedSite);

  if (!activeSiteTabs.has(normalizedSite)) {
    activeSiteTabs.set(normalizedSite, new Set());
  }

  activeSiteTabs.get(normalizedSite).add(tabId);
}

function getTrackedTabCount(siteHostname) {
  const siteTabs = activeSiteTabs.get(normalizeHostname(siteHostname));
  return siteTabs ? siteTabs.size : 0;
}

function parseTrackableSiteFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return normalizeHostname(url.hostname);
  } catch {
    return null;
  }
}

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const siteHostname = parseTrackableSiteFromUrl(tab && tab.url ? tab.url : changeInfo.url);

  if (siteHostname) {
    recordTabSite(tabId, siteHostname);
    return;
  }

  if (changeInfo.url) {
    removeTabTracking(tabId);
  }
});

browser.tabs.onRemoved.addListener((tabId) => {
  removeTabTracking(tabId);
});

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (!message || !message.type) {
        sendResponse({ ok: false, error: "INVALID_MESSAGE" });
        return;
      }

      if (message.type === "COOKIEGATE_INSPECT_ACTIVE_TAB") {
        const result = await inspectActiveTabCookies();
        sendResponse({
          ...result,
          trackedTabs: getTrackedTabCount(result.site)
        });
        return;
      }

      if (message.type === "COOKIEGATE_GET_EVIDENCE") {
        const state = await getPolicyState();
        sendResponse({ ok: true, evidence: state.evidenceLog });
        return;
      }

      if (message.type === "COOKIEGATE_SET_GLOBAL_MODE") {
        await setGlobalMode(message.mode);
        const result = await inspectActiveTabCookies();
        sendResponse({
          ...result,
          trackedTabs: getTrackedTabCount(result.site)
        });
        return;
      }

      if (message.type === "COOKIEGATE_SET_SITE_MODE") {
        const { siteHostname } = await getActiveHttpTab();
        await setSiteMode(siteHostname, message.mode);
        const result = await inspectActiveTabCookies();
        sendResponse({
          ...result,
          trackedTabs: getTrackedTabCount(result.site)
        });
        return;
      }

      if (message.type === "COOKIEGATE_CLEAR_SITE_MODE") {
        const { siteHostname } = await getActiveHttpTab();
        await clearSiteMode(siteHostname);
        const result = await inspectActiveTabCookies();
        sendResponse({
          ...result,
          trackedTabs: getTrackedTabCount(result.site)
        });
        return;
      }

      if (message.type === "COOKIEGATE_SET_KEEP_ALWAYS") {
        const { siteHostname } = await getActiveHttpTab();
        await setKeepRule(siteHostname, message.cookieKey, Boolean(message.keepAlways));
        const result = await inspectActiveTabCookies();
        sendResponse({
          ...result,
          trackedTabs: getTrackedTabCount(result.site)
        });
        return;
      }

      if (message.type === "COOKIEGATE_WIPE_ACTIVE_SITE") {
        const result = await wipeCookiesForActiveSite("manual-wipe");
        sendResponse(result);
        return;
      }

      sendResponse({ ok: false, error: "UNKNOWN_MESSAGE_TYPE" });
    } catch (error) {
      sendResponse({
        ok: false,
        error: String(error && error.message ? error.message : error)
      });
    }
  })();

  return true;
});
