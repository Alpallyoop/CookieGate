export class CookieGateUI {
  constructor(engine) {
    this.engine = engine;
  }

  async inspect(site) {
    const result = await this.engine.inspect(site);

    return this._renderState(result);
  }

  async wipe(site) {
    const result = await this.engine.wipe(site);

    return this._renderState(result);
  }

  setGlobalMode(mode) {
    this.engine.setGlobalMode(mode);
  }

  setSiteMode(site, mode) {
    this.engine.setSiteMode(site, mode);
  }

  getEvidence() {
    return this.engine.getEvidence();
  }

  _renderState(result) {
    return {
      site: result.site,
      count: result.count,
      cookies: result.cookies,
      mode: result.mode
    };
  }
}
