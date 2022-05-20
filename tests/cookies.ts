import type { Cookie } from '../src/cookie';

import { CookieJar } from '../src';
import { makeCookie } from '../src/cookie';
import { HttpHeaders } from '../src/types';

describe('cookies', () => {
  function collectCookies(url: URL, cookieStrings: string[]): Cookie[] {
    const responseHeaders: HttpHeaders = { 'Set-Cookie': [] };
    for (const cookieStr of cookieStrings) {
      responseHeaders['Set-Cookie'].push(cookieStr);
    }
    const jar = new CookieJar();
    jar.collectCookiesFromResponse(url, responseHeaders);
    return jar.toJSON();
  }
  it('makeCookie', () => {
    const cookie = makeCookie({ key: 'key', value: 'value', domain: 'https://example.com' });
    expect(cookie.allowSubDomains).toBe(false);
    expect(cookie.sameSite).toBe('Lax');
  });
  it('parseCookie', () => {
    const cookies = collectCookies(new URL('https://example.com'), [
      '0=0',
      '1=a; Expires=Wed, 21 Oct 2015 07:28:00 GMT ',
      '2=b; Max-Age=200',
      '3=c; Domain=.example.com',
      '4=d; Path=/foo/bar',
      '5=e; Secure',
      '6=f; HttpOnly',
      '7=a; SameSite=None; Secure',
      '8=b; SameSite=Lax',
      '9=c; SameSite=Strict',
      '10=d',
      '"11"="e"',
    ]);
    expect(cookies[0]).toMatchObject({ key: '0', value: '0' });
    expect(cookies[1].expires).toBe(Date.UTC(2015, 9, 21, 7, 28));
    expect(cookies[2].expires).toBeGreaterThan(Date.now() + 199_000);
    expect(cookies[3].allowSubDomains).toBe(true);
    expect(cookies[4].path).toBe('/foo/bar');
    expect(cookies[5].secure).toBe(true);
    expect(cookies[6]).toMatchObject({ key: '6', value: 'f' });
    expect(cookies[7].sameSite).toBe('None');
    expect(cookies[8].sameSite).toBe('Lax');
    expect(cookies[9].sameSite).toBe('Strict');
    expect(cookies[10].sameSite).toBe('Lax');
    expect(cookies[11]).toMatchObject({ key: '11', value: 'e' });
  });
  it('rejects cookies with invalid key, value, or attribute', () => {
    const cookies = collectCookies(new URL('https://example.com'), [
      '0"=0',
      '1= 1',
      '(1=a)',
      '@2=b',
      '3=c,; Domain=example.com',
      '4=\\d; Path=/foo/bar',
      '\u00105=e; Secure',
      '6=f\u0100; HttpOnly',
      '7=g; InvalidAttribute',
      '8=h; SameSite=Duh',
      '9=i; Max-Age=abc',
      '10=k; Expires=INVALID DATE',
    ]);
    expect(cookies).toHaveLength(0);
  });
  it('Max-Age takes precedence over Expires', () => {
    const cookies = collectCookies(new URL('https://example.com'), [
      '0=0; Max-Age=50; Expires=Wed, 21 Oct 2015 07:28:00 GMT',
      '1=0; Expires=Wed, 21 Oct 2015 07:28:00 GMT; Max-Age=50',
    ]);
    expect(cookies[0].expires).toBeGreaterThan(Date.now());
    expect(cookies[1].expires).toBeGreaterThan(Date.now());
  });
  it('Leading dot in domain is discarded', () => {
    const cookies = collectCookies(new URL('https://example.com'), [
      '0=0; Domain=.example.com',
      '1=0; Expires=Wed, 21 Oct 2015 07:28:00 GMT; Max-Age=50',
    ]);
    expect(cookies[0].domain).toBe('example.com');
  });
  it('rejects cookies from insecure site with secure attribute', () => {
    const cookies = collectCookies(new URL('http://example.com'), ['0=0; Secure', '1=0']);
    expect(cookies[0]).toMatchObject({ key: '1', value: '0' });
  });
  it('allows cookies from insecure localhost with secure attribute', () => {
    const cookies = collectCookies(new URL('http://localhost'), ['0=0; Secure', '1=0']);
    expect(cookies).toHaveLength(2);
  });
  it('works with empty headers and lowercase set-cookie', () => {
    const url = new URL('https://example.com');
    const jar = new CookieJar([]);
    jar.collectCookiesFromResponse(url, undefined);
    jar.collectCookiesFromResponse(url, {});
    expect(jar.toJSON()).toHaveLength(0);
    jar.collectCookiesFromResponse(url, { 'set-cookie': ['0=0', '1=1'] });
    expect(jar.toJSON()).toHaveLength(2);
  });
  it('if cookie key starts with __Secure- allow only https and secure cookies', () => {
    const cookieStrings = ['__Secure-0=0; Secure', '__Secure-1=0'];
    const httpCookies = collectCookies(new URL('http://example.com'), cookieStrings);
    expect(httpCookies).toHaveLength(0);
    const httpsCookies = collectCookies(new URL('https://example.com'), cookieStrings);
    expect(httpsCookies).toHaveLength(1);
  });
  it('if cookie key starts with __Host- allow only https and secure cookies with unspecified domain and path', () => {
    const cookieStrings = [
      '__Host-0=0',
      '__Host-1=0; Secure', // allow only on https
      '__Host-2=0; Secure; Domain=example.com',
      '__Host-3=0; Secure; Path=/foo/bar',
    ];
    const httpCookies = collectCookies(new URL('http://example.com'), cookieStrings);
    expect(httpCookies).toHaveLength(0);
    const httpsCookies = collectCookies(new URL('https://example.com'), cookieStrings);
    expect(httpsCookies).toHaveLength(1);
  });
  it('rejects cookies with domain different than host domain', () => {
    const cookies = collectCookies(new URL('https://example.com'), [
      '0=0; Domain=.example.com', // allow
      '1=0; Domain=example.com; Path=/foo/bar', // allow,
      '2=0; Domain=another.com',
      '3=0; Domain=subdomain.example.com',
    ]);
    expect(cookies).toHaveLength(2);
  });
  it('rejects insecure cookies with SameSite=None', () => {
    const cookies = collectCookies(new URL('https://example.com'), [
      '0=0; SameSite=None; Secure', // allow
      '1=0; SameSite=None',
    ]);
    expect(cookies).toHaveLength(1);
  });
  it('addCookie overwrites with same key, domain, and path else adds', () => {
    const jar = new CookieJar();
    jar.addCookie(makeCookie({ key: 'a', value: 'b', domain: 'abc.com' }));
    expect(jar.toJSON()).toHaveLength(1);
    jar.addCookie(makeCookie({ key: 'a', value: 'c', domain: 'abc.com' }));
    expect(jar.toJSON()[0].value).toBe('c');
    jar.addCookie(makeCookie({ key: 'a', value: 'e', domain: 'abc.com', path: '/foo' }));
    expect(jar.toJSON()).toHaveLength(2);
    jar.addCookie(makeCookie({ key: 'a', value: 'g', domain: 'abc.com', path: '/foo' }));
    expect(jar.toJSON()).toHaveLength(2);
    jar.addCookie(makeCookie({ key: 'a', value: 'g', domain: 'bob.com', path: '/foo' }));
    expect(jar.toJSON()).toHaveLength(3);
    jar.addCookie(makeCookie({ key: 'a', value: 'g', domain: 'bob.com' }));
    expect(jar.toJSON()).toHaveLength(4);
  });
  it('removeCookie removes cookie that matches key, domain or path', () => {
    const jar = new CookieJar();
    jar.addCookie(makeCookie({ key: 'a', value: 'b', domain: 'abc.com' }));
    jar.addCookie(makeCookie({ key: 'a', value: 'e', domain: 'abc.com', path: '/foo' }));
    jar.addCookie(makeCookie({ key: 'a', value: 'g', domain: 'bob.com', path: '/foo' }));
    jar.addCookie(makeCookie({ key: 'a', value: 'h', domain: 'bob.com' }));
    jar.removeCookies({ path: '/foo' });
    expect(jar.toJSON()).toHaveLength(2);
    jar.removeCookies({ domain: 'bob.com' });
    expect(jar.toJSON()).toHaveLength(1);
    jar.removeCookies({ key: 'a' });
    expect(jar.toJSON()).toHaveLength(0);
  });
  it('getCookie gets the first cookie that matches key, or optionally domain and path', () => {
    const jar = new CookieJar();
    jar.addCookie(makeCookie({ key: 'a', value: 'b', domain: 'abc.com' }));
    jar.addCookie(makeCookie({ key: 'a', value: 'e', domain: 'abc.com', path: '/foo' }));
    jar.addCookie(makeCookie({ key: 'a', value: 'g', domain: 'bob.com', path: '/foo' }));
    jar.addCookie(makeCookie({ key: 'a', value: 'h', domain: 'bob.com' }));

    expect(jar.getCookie('a').value).toBe('b');
    expect(jar.getCookie('a', undefined, '/foo').value).toBe('e');
    expect(jar.getCookie('a', 'bob.com', '/foo').value).toBe('g');
    expect(jar.getCookie('b')).toBe(null);
  });
  it('addCookiesToHeaders works with undefined headers and previousUrl', () => {
    const jar = new CookieJar();
    const headers = jar.addCookiesToHeaders(new URL('https://example.com'), undefined, undefined);
    expect(headers).toEqual({ Cookie: [] });
  });
  it('addCookiesToHeaders works with lowercase cookie header', () => {
    const jar = new CookieJar();
    jar.addCookie(makeCookie({ key: 'a', value: 'b', domain: 'example.com' }));
    const headers = jar.addCookiesToHeaders(new URL('https://example.com'), { cookie: [] }, undefined);
    expect(headers).toEqual({ cookie: ['a=b'] });
  });
  it('addCookiesToHeaders works with predefined cookies in header', () => {
    const jar = new CookieJar();
    jar.addCookie(makeCookie({ key: 'c', value: 'd', domain: 'example.com' }));
    jar.addCookie(makeCookie({ key: 'e', value: '', domain: 'example.com' }));
    const headers = jar.addCookiesToHeaders(new URL('https://example.com'), { Cookie: ['a=b'] }, undefined);
    expect(headers).toEqual({ Cookie: ['a=b', 'c=d', 'e='] });
  });
  it('cookies are removed when they are past their expiry time when addCookiesToHeaders is called', () => {
    const jar = new CookieJar();
    jar.addCookie(makeCookie({ key: 'a', value: 'b', domain: 'example.com', expires: Date.now() + 10_000 }));
    jar.addCookiesToHeaders(new URL('https://example.com'), undefined, undefined);
    expect(jar.toJSON()).toHaveLength(1);
    jar.addCookie(makeCookie({ key: 'a', value: 'b', domain: 'example.com', expires: Date.now() - 10_000 }));
    expect(jar.toJSON()).toHaveLength(1);
    jar.addCookiesToHeaders(new URL('https://example.com'), undefined, undefined);
    expect(jar.toJSON()).toHaveLength(0);
  });
  it('cookies with different protocol are not added to headers', () => {
    const jar = new CookieJar();
    jar.collectCookiesFromResponse(new URL('http://example.com'), { 'Set-Cookie': ['a=b'] });
    jar.collectCookiesFromResponse(new URL('https://example.com'), { 'Set-Cookie': ['a=c'] });
    expect(jar.toJSON()).toHaveLength(2);
    const httpHeaders = jar.addCookiesToHeaders(new URL('http://example.com'), undefined, undefined);
    expect(httpHeaders).toEqual({ Cookie: ['a=b'] });
    const httpsHeaders = jar.addCookiesToHeaders(new URL('https://example.com'), undefined, undefined);
    expect(httpsHeaders).toEqual({ Cookie: ['a=c'] });
  });
  it('secure cookies are not added to headers if protocol is not secure', () => {
    const jar = new CookieJar();
    jar.addCookie(makeCookie({ key: 'a', value: 'b', domain: 'example.com', secure: true, isHttps: false }));
    const headers = jar.addCookiesToHeaders(new URL('http://example.com'), undefined, undefined);
    expect(headers).toEqual({ Cookie: [] });
  });
  it('cookies with specified domain are only added when request domain is subdomain of cookie domain', () => {
    const jar = new CookieJar();
    jar.collectCookiesFromResponse(new URL('https://example.com'), {
      'Set-Cookie': ['a=b; Domain=example.com', 'c=d'],
    });
    const headers = jar.addCookiesToHeaders(new URL('https://sub.example.com'), undefined, undefined);
    expect(headers).toEqual({ Cookie: ['a=b'] });
  });
  it('cookies with SameSite=none are always added when protocol is https', () => {
    const jar = new CookieJar();
    jar.addCookie(makeCookie({ key: 'a', value: 'b', sameSite: 'None', secure: true, domain: 'third-party.com' }));
    const httpHeaders = jar.addCookiesToHeaders(new URL('http://sub.example.com'), undefined, undefined);
    expect(httpHeaders).toEqual({ Cookie: [] });
    const httpsHeaders = jar.addCookiesToHeaders(new URL('https://sub.example.com'), undefined, undefined);
    expect(httpsHeaders).toEqual({ Cookie: ['a=b'] });
  });
  it('cookies with specified path are only added when request path starts with cookie path', () => {
    const jar = new CookieJar();
    jar.addCookie(makeCookie({ key: 'a', value: 'b', domain: 'example.com', path: '/foo/bar' }));
    expect(jar.addCookiesToHeaders(new URL('https://example.com'), undefined, undefined)).toEqual({ Cookie: [] });
    expect(jar.addCookiesToHeaders(new URL('https://example.com/foo'), undefined, undefined)).toEqual({ Cookie: [] });
    expect(jar.addCookiesToHeaders(new URL('https://example.com/foo/ba'), undefined, undefined)).toEqual({
      Cookie: [],
    });
    expect(jar.addCookiesToHeaders(new URL('https://example.com/foo/bar'), undefined, undefined)).toEqual({
      Cookie: ['a=b'],
    });
    expect(jar.addCookiesToHeaders(new URL('https://example.com/foo/bar/'), undefined, undefined)).toEqual({
      Cookie: ['a=b'],
    });
    expect(jar.addCookiesToHeaders(new URL('https://example.com/foo/bar/baz'), undefined, undefined)).toEqual({
      Cookie: ['a=b'],
    });
  });
  it('cookies with SameSite=strict are only added when previousUrl ends with cookie domain', () => {
    const jar = new CookieJar();
    jar.addCookie(makeCookie({ key: 'a', value: 'b', sameSite: 'Strict', domain: 'example.com' }));
    expect(jar.addCookiesToHeaders(new URL('https://example.com'), undefined, undefined)).toEqual({ Cookie: ['a=b'] });
    expect(jar.addCookiesToHeaders(new URL('https://example.com'), undefined, new URL('https://example.com'))).toEqual({
      Cookie: ['a=b'],
    });
    expect(
      jar.addCookiesToHeaders(new URL('https://example.com'), undefined, new URL('https://sub.example.com'))
    ).toEqual({ Cookie: ['a=b'] });
    expect(jar.addCookiesToHeaders(new URL('https://example.com'), undefined, new URL('https://another.com'))).toEqual({
      Cookie: [],
    });
  });
});
