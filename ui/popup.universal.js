import { CookieGateEngine } from "../core/engine/CookieGateEngine.js";
import { ChromiumCookieAdapter } from "../core/ChromiumCookieAdapter.js";
import { FirefoxCookieAdapter } from "../core/FirefoxCookieAdapter.js";
import { CookieGateUI } from "../ui-core/CookieGateUI.js";

function detectAdapter() {
  if (typeof chrome !== "undefined" && chrome.cookies) {
    return new ChromiumCookieAdapter();
  }
  if (typeof browser !== "undefined") {
    return new FirefoxCookieAdapter();
  }
  throw new Error("NO_ADAPTER_AVAILABLE");
}

const adapter = detectAdapter();
const engine = new CookieGateEngine(adapter);
const ui = new CookieGateUI(engine);

// EXPOSE FOR POPUP BUTTONS

window.CookieGate = {
  inspect: async (site) => ui.inspect(site),
  wipe: async (site) => ui.wipe(site),
  setGlobalMode: (m) => ui.setGlobalMode(m),
  setSiteMode: (s,m) => ui.setSiteMode(s,m),
  getEvidence: () => ui.getEvidence()
};
