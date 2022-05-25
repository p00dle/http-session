import type { Cookie } from '../types/cookies';
import type { URL } from 'node:url';

function isQuoted(str: string, quote = '"'): boolean {
  return str[0] === quote && str[str.length - 1] === quote;
}

function stripQuotes(str: string): string {
  return str.slice(1, str.length - 1);
}

export function parseCookie(hostUrl: URL, cookieStr: string): Cookie {
  const cookie: Cookie = {
    key: '',
    value: '',
    isHttps: hostUrl.protocol === 'https:',
    domain: hostUrl.hostname,
    path: '/',
    allowSubDomains: false,
    sameSite: 'Lax',
    expires: undefined,
    hasInvalidAttributes: false,
  };
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
        cookie.hasInvalidAttributes = true;
        return;
      }
      const firstEqualSignIndex = str.indexOf('=');
      const attribute = str.slice(0, firstEqualSignIndex);
      const value = str.slice(firstEqualSignIndex + 1);
      switch (attribute.toLowerCase()) {
        case 'expires':
          if (!cookie.expires) cookie.expires = +new Date(value);
          break;
        case 'max-age':
          cookie.expires = Date.now() + parseInt(value) * 1000;
          break;
        case 'domain':
          cookie.allowSubDomains = true;
          cookie.domain = value[0] === '.' ? value.slice(1) : value;
          break;
        case 'path':
          cookie.path = value;
          break;
        case 'samesite':
          cookie.sameSite = value as 'Strict' | 'Lax' | 'None';
          break;
        default:
          cookie.key = isQuoted(attribute) ? stripQuotes(attribute) : attribute;
          cookie.value = isQuoted(value) ? stripQuotes(value) : value;
          break;
      }
    });
  return cookie;
}
