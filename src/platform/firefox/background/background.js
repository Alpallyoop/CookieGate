// v0.1.8: previously this overwrote "cookiegate.bannerSuppression.enabled" with true
// on EVERY install/update (re-enabling suppression for users who turned it off) and
// recorded a stale "0.1.2" version. Defaults are now only set when absent.
chrome.runtime.onInstalled.addListener(function(){
  var version = "";
  try { version = String(chrome.runtime.getManifest().version || ""); } catch(e){}
  chrome.storage.local.get(["cookiegate.bannerSuppression.enabled"], function(cur){
    var patch = {
      "cookiegate.version": version,
      "cookiegate.safeRecovery": true,
      "cookiegate.canonicalSafeRecovery": "v19.2-firefox"
    };
    if(!cur || typeof cur["cookiegate.bannerSuppression.enabled"] !== "boolean"){
      patch["cookiegate.bannerSuppression.enabled"] = true;
    }
    chrome.storage.local.set(patch);
  });
});

/* COOKIEGATE_PATCH_V0_1_2_BROWSER_OBSERVER_BACKGROUND_COOKIE_READER_V1_START */
(function(){
  "use strict";

  var COOKIEGATE_PATCH_V0_1_2_BROWSER_OBSERVER_BACKGROUND_COOKIE_READER_V1 = true;

  if(globalThis.__COOKIEGATE_PATCH_V0_1_2_BROWSER_OBSERVER_BACKGROUND_COOKIE_READER_V1__) return;
  globalThis.__COOKIEGATE_PATCH_V0_1_2_BROWSER_OBSERVER_BACKGROUND_COOKIE_READER_V1__ = true;

  function apiRef(){
    if(typeof browser !== "undefined") return browser;
    if(typeof chrome !== "undefined") return chrome;
    return null;
  }

  function text(v){
    if(v === undefined || v === null) return "";
    return String(v);
  }

  function keyForCookie(c){
    var pk = "";
    try { pk = c && c.partitionKey ? JSON.stringify(c.partitionKey) : ""; } catch(e){}
    return [
      c && c.storeId ? c.storeId : "",
      c && c.firstPartyDomain ? c.firstPartyDomain : "",
      pk,
      c && c.domain ? c.domain : "",
      c && c.path ? c.path : "",
      c && c.name ? c.name : ""
    ].join("|");
  }

  function addCookies(target, seen, cookies){
    (cookies || []).forEach(function(c){
      var k = keyForCookie(c);
      if(!seen[k]){
        seen[k] = true;
        target.push(c);
      }
    });
  }

  function readStores(api){
    return new Promise(function(resolve){
      if(!api || !api.cookies || !api.cookies.getAllCookieStores){
        resolve({ ok:false, stores:[], error:"NO_COOKIE_STORES_API" });
        return;
      }

      try {
        if(typeof browser !== "undefined"){
          api.cookies.getAllCookieStores()
            .then(function(stores){ resolve({ ok:true, stores:stores || [] }); })
            .catch(function(err){ resolve({ ok:false, stores:[], error:text(err && err.message ? err.message : err) }); });
          return;
        }

        api.cookies.getAllCookieStores(function(stores){
          if(api.runtime && api.runtime.lastError){
            resolve({ ok:false, stores:[], error:api.runtime.lastError.message });
            return;
          }

          resolve({ ok:true, stores:stores || [] });
        });
      } catch(e) {
        resolve({ ok:false, stores:[], error:text(e && e.message ? e.message : e) });
      }
    });
  }

  function readCookies(api, query){
    return new Promise(function(resolve){
      if(!api || !api.cookies || !api.cookies.getAll){
        resolve({ ok:false, cookies:[], error:"NO_COOKIES_API", query:query || {} });
        return;
      }

      try {
        if(typeof browser !== "undefined"){
          api.cookies.getAll(query || {})
            .then(function(cookies){ resolve({ ok:true, cookies:cookies || [], query:query || {} }); })
            .catch(function(err){ resolve({ ok:false, cookies:[], error:text(err && err.message ? err.message : err), query:query || {} }); });
          return;
        }

        api.cookies.getAll(query || {}, function(cookies){
          if(api.runtime && api.runtime.lastError){
            resolve({ ok:false, cookies:[], error:api.runtime.lastError.message, query:query || {} });
            return;
          }

          resolve({ ok:true, cookies:cookies || [], query:query || {} });
        });
      } catch(e) {
        resolve({ ok:false, cookies:[], error:text(e && e.message ? e.message : e), query:query || {} });
      }
    });
  }

  // With first-party isolation enabled, getAll() rejects unless firstPartyDomain is
  // given; null means "any first-party domain".
  async function readCookiesAnyIsolation(api, query){
    var res = await readCookies(api, query);
    if(res.ok) return res;
    var retry = await readCookies(api, Object.assign({}, query, { firstPartyDomain:null }));
    return retry.ok ? retry : res;
  }

  async function readBrowserWide(){
    var api = apiRef();
    var all = [];
    var seen = {};
    var errors = [];
    var stores = [null];
    var storesResult;
    var i;
    var query;
    var res;

    if(!api || !api.cookies || !api.cookies.getAll){
      return { ok:false, cookies:[], error:"NO_COOKIES_API", source:"browser_observer_background_cookie_reader_v1" };
    }

    storesResult = await readStores(api);

    if(storesResult.ok && storesResult.stores && storesResult.stores.length){
      stores = storesResult.stores.map(function(s){ return s && s.id ? s.id : null; }).filter(function(x){ return !!x; });
      if(!stores.length) stores = [null];
    } else if(storesResult && storesResult.error) {
      errors.push("stores:" + storesResult.error);
    }

    for(i = 0; i < stores.length; i++){
      query = {};
      if(stores[i]) query.storeId = stores[i];

      res = await readCookiesAnyIsolation(api, query);

      if(res.ok){
        addCookies(all, seen, res.cookies || []);
      } else {
        errors.push(String(stores[i] || "default") + ":" + String(res.error || "COOKIE_READ_ERROR"));
      }

      // v0.1.8: without partitionKey only unpartitioned cookies are returned, so
      // every third-party cookie kept by Total Cookie Protection was invisible.
      // partitionKey:{} (no topLevelSite) returns partitioned + unpartitioned.
      res = await readCookiesAnyIsolation(api, Object.assign({}, query, { partitionKey:{} }));
      if(res.ok) addCookies(all, seen, res.cookies || []);
    }

    return {
      ok:true,
      cookies:all,
      source:"browser_observer_background_cookie_reader_v1",
      store_count:stores.length,
      errors:errors
    };
  }

  var api = apiRef();

  if(api && api.runtime && api.runtime.onMessage){
    api.runtime.onMessage.addListener(function(message, sender, sendResponse){
      if(!message || message.type !== "COOKIEGATE_BROWSER_OBSERVER_READ_ALL_COOKIES_V1"){
        return false;
      }

      readBrowserWide()
        .then(function(result){ sendResponse(result); })
        .catch(function(err){
          sendResponse({
            ok:false,
            cookies:[],
            error:text(err && err.message ? err.message : err),
            source:"browser_observer_background_cookie_reader_v1"
          });
        });

      return true;
    });
  }
})();
/* COOKIEGATE_PATCH_V0_1_2_BROWSER_OBSERVER_BACKGROUND_COOKIE_READER_V1_END */
