import type { Cookie } from '../types/cookies';
import type { HttpHeaders } from '../types/http-request';
import type { URL } from 'node:url';
import { getCookieHeaders } from './get-cookie-headers';
import { parseCookie } from './parse';
import { validateCookie } from './validate';
import { selectCookieFactory } from './select';

function stringifyCookie(cookie: Cookie): string {
  return cookie.key + '=' + (cookie.value ? cookie.value : '');
}

export class CookieJar {
  protected cookies: Cookie[];
  constructor(cookies?: Cookie[]) {
    this.cookies = Array.isArray(cookies) ? cookies : [];
  }

  public collectCookiesFromResponse(url: URL, responseHeaders?: HttpHeaders) {
    const cookies = getCookieHeaders(responseHeaders)
      .map((cookieStr) => parseCookie(url, cookieStr))
      .filter((cookie) => validateCookie(url, cookie));
    this.addCookies(cookies);
  }

  protected expireCookies() {
    let i = this.cookies.length;
    const now = Date.now();
    while (i--) {
      const cookie = this.cookies[i];
      if (cookie.expires !== undefined && cookie.expires < now) this.cookies.splice(i, 1);
    }
  }

  public toJSON() {
    return this.cookies;
  }

  public addCookie(cookie: Cookie) {
    const existingCookieIndex = this.cookies.findIndex(
      (c) =>
        c.key === cookie.key && c.domain === cookie.domain && c.path === cookie.path && c.isHttps === cookie.isHttps
    );
    if (existingCookieIndex >= 0) {
      this.cookies[existingCookieIndex] = cookie;
    } else {
      this.cookies.push(cookie);
    }
  }

  public addCookies(cookies: Cookie[]) {
    cookies.forEach((cookie) => this.addCookie(cookie));
  }

  public removeCookies({ key, domain, path }: { key?: string; domain?: string; path?: string }) {
    this.cookies = this.cookies.filter(
      (cookie) =>
        !(
          (key ? cookie.key === key : true) &&
          (domain ? cookie.domain === domain : true) &&
          (path ? cookie.path === path : true)
        )
    );
  }

  public getCookie(key: string, domain?: string, path?: string): Cookie | null {
    const cookie = this.cookies.find(
      (cookie) =>
        cookie.key === key && (domain ? cookie.domain === domain : true) && (path ? cookie.path === path : true)
    );
    return cookie ? cookie : null;
  }
  public getRequestCookies(url: URL, host: string): string[] {
    this.expireCookies();
    const cookies = this.cookies.filter(selectCookieFactory(url, host));
    return cookies.map(stringifyCookie);
  }
}
