import { URL } from 'node:url';
import { HttpHeaders } from './types';

/*
Resources:
 https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Set-Cookie
 https://en.wikipedia.org/wiki/HTTP_cookie#Cookie_attributes
*/

export interface Cookie {
  key: string;
  value: string;
  domain: string;
  isHttps: boolean;
  allowSubDomains: boolean;
  path: string;
  expires?: number;
  secure?: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}

const cookieDefaults: Required<Pick<Cookie, 'allowSubDomains' | 'sameSite' | 'isHttps' | 'path'>> = {
  allowSubDomains: false,
  sameSite: 'Lax',
  isHttps: true,
  path: '/',
};
export function makeCookie(cookieParams: Pick<Cookie, 'key' | 'value' | 'domain'> & Partial<Cookie>): Cookie {
  return Object.assign({}, cookieDefaults, cookieParams);
}

function getCookieHeaders(headers?: HttpHeaders): string[] {
  if (!headers) return [];
  const cookieHeader = headers['Set-Cookie'] || headers['set-cookie'] || null;
  if (!cookieHeader || !Array.isArray(cookieHeader)) return [];
  return cookieHeader;
}

/*
cookie path = /foo/bar
url path = /foo
DONT MATCH

cookie path = /foo
url path = /foo/bar
MATCH
*/

function cookieFilterFactory(url: URL, previousUrl: URL | undefined): (cookie: Cookie) => boolean {
  const isSecure = url.protocol === 'https:';
  const domain = url.hostname;
  const path = url.pathname;

  return function (cookie: Cookie): boolean {
    return cookie.sameSite === 'None'
      ? isSecure
      : cookie.isHttps === isSecure &&
          (cookie.secure ? isSecure : true) &&
          (cookie.allowSubDomains ? domain.endsWith(cookie.domain) : cookie.domain === domain) &&
          path.startsWith(cookie.path) &&
          (cookie.sameSite === 'Strict' && previousUrl ? previousUrl.hostname.endsWith(cookie.domain) : true);
  };
}

function isQuoted(str: string, quote = '"'): boolean {
  return str[0] === quote && str[str.length - 1] === quote;
}

function stripQuotes(str: string): string {
  return str.slice(1, str.length - 1);
}

function stringHasControlOrNonAsciiCharacter(str: string): boolean {
  // https://en.wikipedia.org/wiki/Control_character
  // http://www.columbia.edu/kermit/ascii.html
  for (let i = 0; i < str.length; i++) {
    const charCode = str.charCodeAt(i);
    if (charCode < 33 || charCode > 126) return true;
  }
  return false;
}

function keyHasInvalidCharacters(str: string): boolean {
  return /[ \t\(\)\<\>\@\,\;\:\\\"\/\[\]\?\=\{\}]/.test(str) || stringHasControlOrNonAsciiCharacter(str);
}

function valueHasInvalidCharacters(str: string): boolean {
  return /[\s\"\,\;\\]/.test(str) || stringHasControlOrNonAsciiCharacter(str);
}

function parseCookie(hostUrl: URL, cookieStr: string): Cookie | null {
  const cookie: Cookie = {
    key: '',
    value: '',
    isHttps: hostUrl.protocol === 'https:',
    domain: hostUrl.hostname,
    path: '/',
    allowSubDomains: false,
    sameSite: 'Lax',
    expires: undefined,
  };
  let rejectCookie = false;
  cookieStr
    .split('; ')
    .filter((str) => str.length > 0)
    .forEach((str) => {
      if (/^secure$/i.test(str)) {
        cookie.secure = true;
        return;
      } else if (/^httponly$/i.test(str)) {
        return;
      } else if (!/=/.test(str)) {
        rejectCookie = true;
        return;
      }
      const firstEqualSignIndex = str.indexOf('=');
      const attribute = str.slice(0, firstEqualSignIndex);
      const value = str.slice(firstEqualSignIndex + 1);
      switch (attribute.toLowerCase()) {
        case 'expires':
          if (!cookie.expires) {
            const date = +new Date(value);
            if (!isNaN(date)) {
              cookie.expires = date;
            } else {
              rejectCookie = true;
            }
          }
          break;
        case 'max-age':
          const seconds = parseInt(value);
          if (!isNaN(seconds)) {
            cookie.expires = Date.now() + seconds * 1000;
          } else {
            rejectCookie = true;
          }
          break;
        case 'domain':
          cookie.allowSubDomains = true;
          cookie.domain = value[0] === '.' ? value.slice(1) : value;
          break;
        case 'path':
          cookie.path = value;
          break;
        case 'samesite':
          if (value !== 'Lax' && value !== 'Strict' && value !== 'None') {
            rejectCookie = true;
          } else {
            cookie.sameSite = value;
          }
          break;
        default:
          cookie.key = isQuoted(attribute) ? stripQuotes(attribute) : attribute;
          cookie.value = isQuoted(value) ? stripQuotes(value) : value;
          break;
      }
    });
  if (rejectCookie) {
    return null;
  }
  if (cookie.key.startsWith('__Secure-')) {
    if (!cookie.isHttps || !cookie.secure) {
      return null;
    }
  }
  if (cookie.key.startsWith('__Host-')) {
    if (!cookie.isHttps || !cookie.secure || cookie.allowSubDomains || cookie.path !== '/') {
      return null;
    }
  }
  if (keyHasInvalidCharacters(cookie.key) || valueHasInvalidCharacters(cookie.value)) {
    return null;
  }
  if (hostUrl.hostname !== cookie.domain) {
    return null;
  }
  if (cookie.secure && hostUrl.protocol !== 'https:') {
    if (hostUrl.host !== 'localhost') {
      return null;
    }
  }
  if (cookie.sameSite === 'None' && !cookie.secure) {
    return null;
  }
  return cookie;
}

function stringifyCookie(cookie: Cookie): string {
  return cookie.key + '=' + (cookie.value ? cookie.value : '');
}

export class CookieJar {
  private cookies: Cookie[] = [];
  constructor(cookies?: Cookie[]) {
    if (Array.isArray(cookies)) this.cookies = cookies;
  }
  public collectCookiesFromResponse(url: URL, responseHeaders?: HttpHeaders) {
    getCookieHeaders(responseHeaders)
      .map((cookieStr) => parseCookie(url, cookieStr))
      .forEach((cookie) => {
        if (cookie) {
          this.addCookie(cookie);
        }
      });
  }

  private expireCookies() {
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
  public addCookiesToHeaders(url: URL, headers: HttpHeaders | undefined, previousUrl: URL | undefined): HttpHeaders {
    this.expireCookies();
    const outputHeaders = headers || {};
    const cookies = this.cookies.filter(cookieFilterFactory(url, previousUrl));
    const headerName = outputHeaders.cookie ? 'cookie' : 'Cookie';
    const cookieHeader = outputHeaders[headerName];
    if (Array.isArray(cookieHeader)) {
      outputHeaders[headerName] = cookieHeader.concat(cookies.map(stringifyCookie));
    } else {
      outputHeaders[headerName] = cookies.map(stringifyCookie);
    }
    return outputHeaders;
  }
}
