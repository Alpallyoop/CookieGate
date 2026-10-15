// COOKIEGATE_OPTIONS_V011
(function(){
  "use strict";

  const API = typeof browser !== "undefined" ? browser : chrome;
  const KEY = "cookiegate.bannerSuppression.enabled";

  function byId(id){
    return document.getElementById(id);
  }

  function setStatus(text, cls){
    const el = byId("status");
    if(!el) return;

    el.className = "cg-status" + (cls ? " " + cls : "");
    el.textContent = text;
  }

  function storageGet(key){
    return new Promise(function(resolve){
      try {
        const out = API.storage.local.get(key);

        if(out && typeof out.then === "function"){
          out.then(function(v){ resolve(v || {}); }).catch(function(){ resolve({}); });
          return;
        }

        API.storage.local.get(key, function(v){ resolve(v || {}); });
      } catch(e){
        resolve({});
      }
    });
  }

  function storageSet(obj){
    return new Promise(function(resolve){
      try {
        const out = API.storage.local.set(obj);

        if(out && typeof out.then === "function"){
          out.then(resolve).catch(resolve);
          return;
        }

        API.storage.local.set(obj, resolve);
      } catch(e){
        resolve();
      }
    });
  }

  async function load(){
    const toggle = byId("bannerSuppressionToggle");
    if(!toggle){
      setStatus("Options UI failed to load.", "warn");
      return;
    }

    const data = await storageGet(KEY);
    const enabled = data[KEY] !== false;

    toggle.checked = enabled;
    setStatus(enabled ? "Banner suppression is enabled." : "Banner suppression is disabled.", enabled ? "good" : "warn");

    toggle.addEventListener("change", async function(){
      await storageSet({ [KEY]: toggle.checked });
      setStatus(toggle.checked ? "Banner suppression enabled. Reload open pages to apply everywhere." : "Banner suppression disabled. Reload open pages to see banners again.", toggle.checked ? "good" : "warn");
    });
  }

  document.addEventListener("DOMContentLoaded", load);
})();
