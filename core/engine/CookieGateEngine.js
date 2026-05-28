export class CookieGateEngine {
  constructor(adapter) {
    this.adapter = adapter;

    this.globalMode = "strict";
    this.siteModes = new Map();
    this.keepRules = new Map();
    this.evidence = [];
  }

  async inspect(site) {
    const cookies = await this.adapter.getCookies(site);

    const normalized = cookies.map(c => ({
      name: c.name,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      session: c.session
    }));

    this._addEvidence("inspect", site, normalized.length);

    return {
      site,
      count: normalized.length,
      cookies: normalized,
      mode: this._resolveMode(site)
    };
  }

  async wipe(site) {
    const result = await this.adapter.deleteCookies(site);

    this._addEvidence("wipe", site, result.deleted);

    return result;
  }

  setGlobalMode(mode) {
    this.globalMode = mode;
    this._addEvidence("global_mode", "global", mode);
  }

  setSiteMode(site, mode) {
    this.siteModes.set(site, mode);
    this._addEvidence("site_mode", site, mode);
  }

  _resolveMode(site) {
    return this.siteModes.get(site) || this.globalMode;
  }

  _addEvidence(type, site, data) {
    this.evidence.push({
      type,
      site,
      data,
      ts: Date.now()
    });
  }

  getEvidence() {
    return this.evidence;
  }
}
