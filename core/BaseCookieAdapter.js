export class BaseCookieAdapter {
  async getCookies(site) {
    throw new Error("NOT_IMPLEMENTED");
  }

  async deleteCookies(site) {
    throw new Error("NOT_IMPLEMENTED");
  }

  getName() {
    return "base";
  }
}
