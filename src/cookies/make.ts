import type { Cookie } from '../types/cookies';

const cookieDefaults: Required<Pick<Cookie, 'allowSubDomains' | 'sameSite' | 'isHttps' | 'path'>> = {
  allowSubDomains: false,
  sameSite: 'Lax',
  isHttps: true,
  path: '/',
};
export function makeCookie(cookieParams: Pick<Cookie, 'key' | 'value' | 'domain'> & Partial<Cookie>): Cookie {
  return Object.assign({}, cookieDefaults, cookieParams);
}
