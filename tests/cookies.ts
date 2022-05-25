import {
  CookieJar,
  makeCookie,
  getCookieHeaders,
  matchDomain,
  parseCookie,
  selectCookieFactory,
  validateCookie,
} from '../src/cookies';

describe('cookies', () => {
  const exampleUrl = new URL('https:/example.com');
  const httpExampleUrl = new URL('http:/example.com');
  it('makeCookie', () => {
    const cookie = makeCookie({ key: 'key', value: 'value', domain: 'https://example.com' });
    expect(cookie.allowSubDomains).toBe(false);
    expect(cookie.sameSite).toBe('Lax');
  });
  describe('matchDomain', () => {
    it('should match when strings are the same', () => expect(matchDomain('abc', 'abc')).toBeTruthy());
    it('should not match when strings are different', () => expect(matchDomain('abc', 'def')).toBeFalsy());
    it('should match when one is subdomain of the other', () =>
      expect(matchDomain('sub.abc.com', 'abc.com')).toBeTruthy());
    it('should not match the other way round', () => expect(matchDomain('abc.com', 'sub.abc.com')).toBeFalsy());
    it('should not match when top domain is different', () => expect(matchDomain('subabc.com', 'abc.com')).toBeFalsy());
  });

  describe('parseCookie', () => {
    it('parses valid cookies', () => {
      const cookies = [
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
      ].map((str) => parseCookie(exampleUrl, str));
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
    it('Max-Age takes precedence over Expires', () => {
      const cookies = [
        '0=0; Max-Age=50; Expires=Wed, 21 Oct 2015 07:28:00 GMT',
        '1=0; Expires=Wed, 21 Oct 2015 07:28:00 GMT; Max-Age=50',
      ].map((str) => parseCookie(exampleUrl, str));
      expect(cookies[0].expires).toBeGreaterThan(Date.now());
      expect(cookies[1].expires).toBeGreaterThan(Date.now());
    });
    it('Leading dot in domain is discarded', () => {
      const cookie = parseCookie(exampleUrl, '0=0; Domain=.example.com');
      expect(cookie.domain).toBe('example.com');
    });
  });
  describe('validateCookie', () => {
    it('rejects cookies with invalid key, value, or attribute', () => {
      const cookies = [
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
      ].map((str) => parseCookie(exampleUrl, str));
      expect(cookies).toHaveLength(12);
      expect(cookies.filter((cookie) => validateCookie(exampleUrl, cookie))).toHaveLength(0);
    });
    it('rejects cookies from insecure site with secure attribute', () => {
      const cookie = parseCookie(httpExampleUrl, '0=0; Secure');
      expect(cookie).toMatchObject({ key: '0', value: '0' });
      expect(validateCookie(httpExampleUrl, cookie)).toBeFalsy();
    });
    it('allows cookies from insecure localhost with secure attribute', () => {
      const localhostUrl = new URL('http://localhost');
      const cookie = parseCookie(localhostUrl, '0=0; Secure');
      expect(cookie).toMatchObject({ key: '0', value: '0' });
      expect(validateCookie(localhostUrl, cookie)).toBeTruthy();
    });

    it('if cookie key starts with __Secure- allow only https and secure cookies', () => {
      const cookieStrings = ['__Secure-0=0; Secure', '__Secure-1=0'];
      const httpCookies = cookieStrings.map((str) => parseCookie(httpExampleUrl, str));
      const httpsCookies = cookieStrings.map((str) => parseCookie(exampleUrl, str));
      expect(httpCookies).toHaveLength(2);
      expect(httpsCookies).toHaveLength(2);
      expect(httpCookies.filter((cookie) => validateCookie(httpExampleUrl, cookie))).toHaveLength(0);
      expect(httpsCookies.filter((cookie) => validateCookie(httpExampleUrl, cookie))).toHaveLength(0);
    });
    it('if cookie key starts with __Host- allow only https and secure cookies with unspecified domain and path', () => {
      const cookieStrings = [
        '__Host-0=0',
        '__Host-1=0; Secure', // allow only on https
        '__Host-2=0; Secure; Domain=example.com',
        '__Host-3=0; Secure; Path=/foo/bar',
      ];
      const httpCookies = cookieStrings.map((str) => parseCookie(httpExampleUrl, str));
      const httpsCookies = cookieStrings.map((str) => parseCookie(exampleUrl, str));
      expect(httpCookies).toHaveLength(4);
      expect(httpsCookies).toHaveLength(4);
      expect(httpCookies.filter((cookie) => validateCookie(httpExampleUrl, cookie))).toHaveLength(0);
      expect(httpsCookies.filter((cookie) => validateCookie(exampleUrl, cookie))).toHaveLength(1);
    });
    it('rejects insecure cookies with SameSite=None', () => {
      const cookies = [
        '0=0; SameSite=None; Secure', // allow
        '1=0; SameSite=None',
      ].map((str) => parseCookie(exampleUrl, str));
      expect(cookies).toHaveLength(2);
      expect(cookies.filter((cookie) => validateCookie(exampleUrl, cookie))).toHaveLength(1);
    });
    it('rejects cookies with top domain different than host domain', () => {
      const cookies = [
        '0=0; Domain=.example.com', // allow
        '1=0; Domain=example.com; Path=/foo/bar', // allow,
        '2=0; Domain=another.com',
        '3=0; Domain=subdomain.example.com', // allow
      ].map((str) => parseCookie(exampleUrl, str));
      expect(cookies).toHaveLength(4);
      expect(cookies.filter((cookie) => validateCookie(exampleUrl, cookie))).toHaveLength(3);
    });
  });
  it('getCookieHeaders', () => {
    expect(getCookieHeaders(undefined)).toEqual([]);
    expect(getCookieHeaders({})).toEqual([]);
    expect(getCookieHeaders({ 'set-cookie': undefined })).toEqual([]);
    expect(getCookieHeaders({ 'Set-Cookie': undefined })).toEqual([]);
    expect(getCookieHeaders({ 'set-cookie': ['0=0', '1=1'] })).toEqual(['0=0', '1=1']);
    expect(getCookieHeaders({ 'Set-Cookie': ['0=0'] })).toEqual(['0=0']);
  });

  describe('selectCookieFactory', () => {
    const anotherUrl = new URL('https://another.com');
    const httpAnotherUrl = new URL('http://another.com');
    // const exampleUrlWithPath = new URL('https://example.com/foo/bar')
    const cookies = [
      '0=0',
      '1=1; SameSite=None; Secure',
      '2=2; SameSite=Strict',
      '3=3; Domain=example.com',
      '4=4; Domain=example.com; Secure',
      '5=5; Domain=sub.example.com',
      '6=6; Path=/foo/bar',
    ]
      .map((str) => parseCookie(exampleUrl, str))
      .concat(['7=7'].map((str) => parseCookie(httpExampleUrl, str)))
      .concat(['8=8'].map((str) => parseCookie(anotherUrl, str)));

    it('cookies with Secure attribute are not sent when protocol is http', () => {
      const httpCookies = cookies.filter(selectCookieFactory(httpExampleUrl, httpExampleUrl.hostname));
      const httpsCookies = cookies.filter(selectCookieFactory(exampleUrl, exampleUrl.hostname));
      expect(httpCookies.find((c) => c.key === '0')).toBeTruthy(); // sent because Secure is not specified
      expect(httpCookies.find((c) => c.key === '1')).toBeFalsy(); // not sent because Secure is specified
      expect(httpsCookies.find((c) => c.key === '1')).toBeTruthy(); // but sent when protocol is httpsCookies
      expect(httpCookies.find((c) => c.key === '4')).toBeFalsy(); // setting domain doesn't change the outcome
      expect(httpsCookies.find((c) => c.key === '4')).toBeTruthy();
      expect(httpsCookies.find((c) => c.key === '5')).toBeFalsy(); // unless the domain doesn't match
    });
    it('cookies with SameSite=None will be sent to other domains providing they are on https', () => {
      const httpCookies = cookies.filter(selectCookieFactory(httpAnotherUrl, exampleUrl.hostname));
      const httpsCookies = cookies.filter(selectCookieFactory(anotherUrl, exampleUrl.hostname));
      expect(httpCookies).toMatchObject([
        { key: '8', value: '8' }, // sent because Secure is not specified
      ]);
      expect(httpsCookies).toMatchObject([
        { key: '1', value: '1' }, // sent because of SameSite=None
        { key: '8', value: '8' }, // sent because it comes from anotherUrl
      ]);
    });
    it('cookies with SameSite=Lax (default) will be sent when url domain matches when sent from another host', () => {
      const httpsCookies = cookies.filter(selectCookieFactory(exampleUrl, anotherUrl.hostname));
      expect(httpsCookies.find((c) => c.key === '0')).toBeTruthy(); // sent because SameSite=Lax
      expect(httpsCookies.find((c) => c.key === '2')).toBeFalsy(); // not sent because SameSite=Strict
      expect(httpsCookies.find((c) => c.key === '8')).toBeFalsy(); // not sent because SameSite=Lax
    });
  });

  describe('CookieJar', () => {
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
    it('cookies are removed when they are past their expiry time when getRequestCookies is called', () => {
      const jar = new CookieJar();
      jar.addCookie(makeCookie({ key: 'a', value: '', domain: 'example.com', expires: Date.now() + 10_000 }));
      jar.getRequestCookies(exampleUrl, exampleUrl.hostname);
      expect(jar.toJSON()).toHaveLength(1);
      jar.addCookie(makeCookie({ key: 'a', value: '', domain: 'example.com', expires: Date.now() - 10_000 }));
      expect(jar.toJSON()).toHaveLength(1);
      jar.getRequestCookies(exampleUrl, exampleUrl.hostname);
      expect(jar.toJSON()).toHaveLength(0);
    });
  });
});
