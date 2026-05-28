import { BaseCookieAdapter } from "./BaseCookieAdapter.js";

export class ChromiumCookieAdapter extends BaseCookieAdapter {
  async getCookies(site) {
    return await chrome.cookies.getAll({ domain: site });
  }

  async deleteCookies(site) {
    const cookies = await this.getCookies(site);

    let deleted = 0;

    for (const c of cookies) {
      const url = `https://${c.domain.replace(/^\./, "")}${c.path}`;

      try {
        await chrome.cookies.remove({
          url,
          name: c.name
        });
        deleted++;
      } catch (e) {}
    }

    return {
      deleted,
      failed: cookies.length - deleted
    };
  }

  getName() {
    return "chromium";
  }
}
