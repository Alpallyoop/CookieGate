import { BaseCookieAdapter } from "./BaseCookieAdapter.js";

export class FirefoxCookieAdapter extends BaseCookieAdapter {
  async getCookies(site) {
    return await browser.cookies.getAll({ domain: site });
  }

  async deleteCookies(site) {
    const cookies = await this.getCookies(site);

    let deleted = 0;

    for (const c of cookies) {
      const url = `https://${c.domain.replace(/^\./, "")}${c.path}`;

      try {
        await browser.cookies.remove({
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
    return "firefox";
  }
}
