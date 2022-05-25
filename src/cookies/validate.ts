import { Cookie } from '../types/cookies';
import { matchDomain } from './match-domain';

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

export function validateCookie(hostUrl: URL, cookie: Cookie): boolean {
  if (cookie.hasInvalidAttributes) return false;
  if (!['Strict', 'Lax', 'None'].includes(cookie.sameSite)) return false;
  if (cookie.expires !== undefined && isNaN(cookie.expires)) return false;
  if (cookie.key.startsWith('__Secure-')) {
    if (!cookie.isHttps || !cookie.secure) {
      return false;
    }
  }
  if (cookie.key.startsWith('__Host-')) {
    if (!cookie.isHttps || !cookie.secure || cookie.allowSubDomains || cookie.path !== '/') {
      return false;
    }
  }
  if (keyHasInvalidCharacters(cookie.key) || valueHasInvalidCharacters(cookie.value)) {
    return false;
  }
  if (!matchDomain(hostUrl.hostname, cookie.domain) && !matchDomain(cookie.domain, hostUrl.hostname)) {
    return false;
  }
  if (cookie.secure && hostUrl.protocol !== 'https:') {
    if (hostUrl.host !== 'localhost') {
      return false;
    }
  }
  if (cookie.sameSite === 'None' && !cookie.secure) {
    return false;
  }
  return true;
}
