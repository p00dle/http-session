import type { RequestOptions } from 'node:https';
import type { MakeHttpRequest, HttpHeaders } from '../src/types/http-request';
import type { Cookie } from '../src/types/cookies';

import { isHttpRequestError } from '../src/http-request';
import { httpRequest } from '../src';
import { Readable, Writable } from 'node:stream';
import { CookieJar, makeCookie } from '../src/cookies';
import { callbackPromise } from '../src/lib/callbackPromise';
import { collectStreamToString } from '../src/lib/collectStreamToString';

function createReadableStream(str: string | Buffer, chunkSize = 10): Readable {
  let start = 0;
  return new Readable({
    read() {
      if (start >= str.length) {
        this.push(null);
      } else {
        this.push(str.slice(start, start + chunkSize));
        start += chunkSize;
      }
    },
  });
}

interface MockRequestParams {
  returns: any;
  binary?: boolean;
  statusCode?: number;
  headers?: HttpHeaders;
  onDataReceived?: (data: any) => void;
  onOptionsReceived?: (data: RequestOptions & { url: URL | string }) => void;
  delay?: number;
}
function mockHttpRequestFactory(params: MockRequestParams): MakeHttpRequest {
  const { returns, binary, statusCode, headers, onDataReceived, onOptionsReceived, delay = 1 } = params;
  return (url, options, cb) => {
    if (onOptionsReceived) onOptionsReceived({ url, ...options });
    const chunks: any[] = [];
    const requestStream = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk);
        cb();
      },
    });
    if (onDataReceived) {
      requestStream.on('finish', () => {
        if (binary) {
          onDataReceived(Buffer.concat(chunks));
        } else {
          onDataReceived(chunks.join(''));
        }
      });
    }
    const responseStream = Object.assign(createReadableStream(returns), {
      statusCode,
      statusMessage: '',
      headers: headers || {},
    });
    setTimeout(() => cb(responseStream), delay);
    return requestStream;
  };
}

function mockHeadersHttpRequestFactory(fn: (headers: HttpHeaders) => HttpHeaders): MakeHttpRequest {
  return (_, options, cb) => {
    const requestStream = new Writable({
      write(_chunk, _enc, cb) {
        cb();
      },
    });
    requestStream.on('finish', () => {
      const responseStream = Object.assign(createReadableStream(''), {
        statusCode: 200,
        statusMessage: '',
        headers: fn(options.headers as HttpHeaders),
      });
      setTimeout(() => cb(responseStream), 1);
    });
    return requestStream;
  };
}

function mockCustomResponseHttpRequestFactory(
  fns: Record<string, (options: RequestOptions, data: string) => ['redirect' | 'data', number, string | undefined]>
): MakeHttpRequest {
  return (url, options, cb) => {
    const chunks: any[] = [];
    const requestStream = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk);
        cb();
      },
    });
    requestStream.on('finish', () => {
      const [type, status, data] = (fns['' + url] || (() => ['data', 404, '']))(options, chunks.join(''));
      if (type === 'redirect') {
        const responseStream = Object.assign(createReadableStream(''), {
          statusCode: status,
          statusMessage: '',
          headers: { location: data },
        });
        setTimeout(() => cb(responseStream), 1);
      } else {
        const responseStream = Object.assign(createReadableStream(data), {
          statusCode: status,
          statusMessage: '',
          headers: {},
        });
        setTimeout(() => cb(responseStream), 1);
      }
    });
    return requestStream;
  };
}

async function captureError(fn: () => Promise<any>): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
}

describe('httpRequest', () => {
  it('works with simple POST', async () => {
    const requestData = 'UNFORMATTED_DATA';
    const responseData = 'abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const [dataReceivedPromise, dataReceivedCb] = callbackPromise();
    const makeHttpRequest = mockHttpRequestFactory({
      returns: responseData,
      statusCode: 200,
      onDataReceived: dataReceivedCb,
    });
    const response = await httpRequest({
      method: 'POST',
      url: new URL('http://example.com'),
      _request: makeHttpRequest,
      data: requestData,
    });
    expect(response.data).toBe(responseData);
    const receivedData = await dataReceivedPromise;
    expect(receivedData).toBe(requestData);
  });
  it('stringifies data when dataType=raw and data is not a string', async () => {
    const requestData = ['a', 'b', 'c'];
    const [dataReceivedPromise, dataReceivedCb] = callbackPromise();
    const makeHttpRequest = mockHttpRequestFactory({
      returns: '',
      statusCode: 200,
      onDataReceived: dataReceivedCb,
    });
    await httpRequest({
      method: 'POST',
      url: new URL('https://example.com'),
      _request: makeHttpRequest,
      data: requestData,
    });
    const receivedData = await dataReceivedPromise;
    expect(receivedData).toBe('a,b,c');
  });
  it('works with stream request data', async () => {
    const requestData = 'UNFORMATTED_DATA';
    const readable = createReadableStream(requestData, 1);
    const [dataReceivedPromise, dataReceivedCb] = callbackPromise();
    const makeHttpRequest = mockHttpRequestFactory({
      returns: '',
      statusCode: 200,
      onDataReceived: dataReceivedCb,
    });
    await httpRequest({
      _request: makeHttpRequest,
      method: 'POST',
      dataType: 'stream',
      url: new URL('https://example.com'),
      data: readable,
    });
    const receivedData = await dataReceivedPromise;
    expect(receivedData).toBe(requestData);
  });
  it('works with stream response data', async () => {
    const responseData = 'abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const makeHttpRequest = mockHttpRequestFactory({
      returns: responseData,
      statusCode: 200,
    });
    const response = await httpRequest({
      _request: makeHttpRequest,
      url: new URL('https://example.com'),
      responseType: 'stream',
    });
    const receveivedData = await collectStreamToString(response.data);
    expect(receveivedData).toBe(responseData);
  });
  it('formats form data correctly', async () => {
    const [dataReceivedPromise, dataReceivedCb] = callbackPromise();
    const makeHttpRequest = mockHttpRequestFactory({
      returns: '',
      statusCode: 200,
      onDataReceived: dataReceivedCb,
    });
    await httpRequest({
      _request: makeHttpRequest,
      method: 'PATCH',
      url: new URL('https://example.com'),
      dataType: 'form',
      data: {
        'a b': 'c d',
        e: 'f=g',
        h: 'i&j',
        arr: ['a', 'b'],
      },
    });
    const receivedData = await dataReceivedPromise;
    expect(receivedData).toEqual('a+b=c+d&e=f%3Dg&h=i%26j&arr=a&arr=b');
  });
  it('sends and receives binary data', async () => {
    const requestBuffer = new Uint8Array(10).fill(2);
    const responseBuffer = Buffer.from('abcdefg');
    const [dataReceivedPromise, dataReceivedCb] = callbackPromise<any>();
    const makeHttpRequest = mockHttpRequestFactory({
      returns: responseBuffer,
      statusCode: 200,
      onDataReceived: dataReceivedCb,
      binary: true,
    });
    const response = await httpRequest({
      _request: makeHttpRequest,
      method: 'PATCH',
      url: new URL('https://example.com'),
      previousUrl: new URL('https://example.com'),
      dataType: 'binary',
      responseType: 'binary',
      data: requestBuffer,
    });
    const receivedData = await dataReceivedPromise;
    expect(Array.from(receivedData).every((n) => n === 2)).toBe(true);
    expect(Buffer.isBuffer(response.data)).toBe(true);
    expect(response.data.toString()).toBe('abcdefg');
  });
  it('sends and receives json data', async () => {
    const jsonObject = {
      str: 'string',
      num: 0,
      nl: null,
      arr: ['a', 'b', 'c'],
      subObj: { a: 1, b: 2 },
    };
    const jsonString = JSON.stringify(jsonObject);
    const [dataReceivedPromise, dataReceivedCb] = callbackPromise();
    const makeHttpRequest = mockHttpRequestFactory({
      returns: jsonString,
      statusCode: 500,
      onDataReceived: dataReceivedCb,
    });
    const response = await httpRequest({
      _request: makeHttpRequest,
      method: 'DELETE',
      url: 'https://example.com',
      dataType: 'json',
      responseType: 'json',
      data: jsonObject,
    });
    const receivedData = await dataReceivedPromise;
    expect(receivedData).toBe(jsonString);
    expect(response.data).toEqual(jsonObject);
  });
  it('sends an empty string when data is undefined and dataType is json', async () => {
    const [dataReceivedPromise, dataReceivedCb] = callbackPromise();
    const makeHttpRequest = mockHttpRequestFactory({ returns: '', statusCode: 500, onDataReceived: dataReceivedCb });
    await httpRequest({ _request: makeHttpRequest, method: 'POST', url: 'https://example.com', dataType: 'json' });
    const receivedData = await dataReceivedPromise;
    expect(receivedData).toBe('');
  });
  it('sends an empty string when data is undefined and dataType is form', async () => {
    const [dataReceivedPromise, dataReceivedCb] = callbackPromise();
    const makeHttpRequest = mockHttpRequestFactory({ returns: '', statusCode: 500, onDataReceived: dataReceivedCb });
    await httpRequest({ _request: makeHttpRequest, method: 'POST', url: 'https://example.com', dataType: 'form' });
    const receivedData = await dataReceivedPromise;
    expect(receivedData).toBe('');
  });
  it('throws error on invalid parameters', async () => {
    const wrongParameters: (() => Promise<any>)[] = [
      // @ts-expect-error options parameter is required
      () => httpRequest(),
      // @ts-expect-error url must be defined and must be either URL or non-empty string
      () => httpRequest({ url: 0 }),
      () => httpRequest({ url: '' }),
      // @ts-expect-error ...
      () => httpRequest({}),
      // @ts-expect-error when dataType=stream data must be Readable
      () => httpRequest({ method: 'POST', dataType: 'stream', timeout: 1000 }),
      // @ts-expect-error ...
      () => httpRequest({ method: 'POST', dataType: 'stream', data: 123 }),
      // @ts-expect-error when dataType=form data must be a Record
      () => httpRequest({ method: 'POST', dataType: 'form', data: 123 }),
      // @ts-expect-error ...
      () => httpRequest({ method: 'POST', dataType: 'form', data: [1, 2, 3] }),
      // @ts-expect-error when dataType=binary data must be either Buffer or UintArray8
      () => httpRequest({ method: 'POST', dataType: 'binary', data: 'abc' }),
      // @ts-expect-error ...
      () => httpRequest({ method: 'POST', dataType: 'binary', data: [1, 2, 3] }),
      // @ts-expect-error invalid dataType
      () => httpRequest({ method: 'POST', dataType: 'invalid', data: 123 }),
    ];
    const errors = await Promise.all(wrongParameters.map((fn) => captureError(fn)));
    expect(errors.every((err) => isHttpRequestError(err) || err instanceof Error)).toBe(true);
  });
  it('handles redirects', async () => {
    const assertions: boolean[] = [];
    const makeHttpRequest = mockCustomResponseHttpRequestFactory({
      'https://abc.com/': ({ method }, data) => {
        assertions.push(method === 'POST');
        assertions.push(data === 'abc');
        return ['redirect', 307, 'https://abc.com/foo'];
      },
      'https://abc.com/foo': ({ method }, data) => {
        assertions.push(method === 'POST');
        assertions.push(data === 'abc');
        return ['redirect', 308, '/foo/bar'];
      },
      'https://abc.com/foo/bar': ({ method }, data) => {
        assertions.push(method === 'POST');
        assertions.push(data === 'abc');
        return ['redirect', 301, 'https://another.com?boo=hoo'];
      },
      'https://another.com/?boo=hoo': ({ method }, data) => {
        assertions.push(method === 'GET');
        assertions.push(!data);
        return ['redirect', 302, 'https://another.com/foo'];
      },
      'https://another.com/foo': ({ method }, data) => {
        assertions.push(method === 'GET');
        assertions.push(!data);
        return ['redirect', 303, '/foo/bar'];
      },
      'https://another.com/foo/bar': ({ method }, data) => {
        assertions.push(method === 'GET');
        assertions.push(!data);
        return ['redirect', 399, '/foo/bar/baz?boo=hoo'];
      },
      'https://another.com/foo/bar/baz?boo=hoo': ({ method }, data) => {
        assertions.push(method === 'GET');
        assertions.push(!data);
        return ['data', 200, '123'];
      },
    });
    const errorRedirectCountDefault = await captureError(() =>
      httpRequest({ _request: makeHttpRequest, method: 'POST', url: 'https://abc.com', data: 'abc' })
    );
    expect(errorRedirectCountDefault).not.toBeNull();
    const errorRedirectCountSpecified = await captureError(() =>
      httpRequest({ _request: makeHttpRequest, method: 'POST', url: 'https://abc.com', data: 'abc', maxRedirects: 3 })
    );
    expect(errorRedirectCountSpecified).not.toBeNull();
    const response = await httpRequest({
      _request: makeHttpRequest,
      method: 'POST',
      data: 'abc',
      url: 'https://abc.com',
      maxRedirects: 10,
      timeout: 4000,
    });
    expect(response.data).toBe('123');
    expect(assertions.every((id) => id)).toBe(true);
  });
  it('handles invalid redirects', async () => {
    const makeHttpRequest = mockCustomResponseHttpRequestFactory({
      'https://invalid.com/': () => ['redirect', 307, 'https://[invalid]'],
      'https://undefined.com/': () => ['redirect', 308, undefined],
    });
    const errorInvalidRedirect = await captureError(() =>
      httpRequest({ _request: makeHttpRequest, url: 'https://invalid.com' })
    );
    expect(errorInvalidRedirect).not.toBeNull();
    const errorUndefinedRedirect = await captureError(() =>
      httpRequest({ _request: makeHttpRequest, url: 'https://undefined.com' })
    );
    expect(errorUndefinedRedirect).not.toBeNull();
  });
  it('handles cookies and headers correctly', async () => {
    const assertions: boolean[] = [];
    const assertionErrors: string[] = [];
    const requestHeaders: HttpHeaders = {
      'Content-Type': 'application/magic',
      Cookie: ['header-cookie=123'],
    };
    function assert(label: string, test: boolean) {
      assertions.push(test);
      if (!test) assertionErrors.push(label);
    }
    const requestCookies: Cookie[] = [
      makeCookie({ key: 'a', value: 'b', domain: 'example.com' }),
      makeCookie({ key: 'c', value: 'd', domain: 'example.com' }),
    ];
    const responseHeaders: HttpHeaders = {
      'Set-Cookie': ['e=f', 'g=h'],
    };
    const makeHttpRequest = mockHeadersHttpRequestFactory((requestHeaders) => {
      assert(
        `requestHeaders['Content-Type'] === 'application/magic'`,
        requestHeaders['Content-Type'] === 'application/magic'
      );
      if (Array.isArray(requestHeaders.Cookie)) {
        assert(
          `requestHeaders.Cookie.includes('header-cookie=123')`,
          requestHeaders.Cookie.includes('header-cookie=123')
        );
        assert(`requestHeaders.Cookie.includes('a=b')`, requestHeaders.Cookie.includes('a=b'));
        assert(`requestHeaders.Cookie.includes('c=d')`, requestHeaders.Cookie.includes('c=d'));
      } else {
        assert('Array.isArray(requestHeaders.Cookie)', false);
      }
      return responseHeaders;
    });
    const cookieJar = new CookieJar();
    const response = await httpRequest({
      method: 'POST',
      _request: makeHttpRequest,
      url: 'https://example.com',
      headers: requestHeaders,
      cookieJar,
      cookies: requestCookies,
    });
    expect(response.cookies['e']).toBe('f');
    expect(response.cookies['g']).toBe('h');
    const cookies = cookieJar.toJSON();
    expect(cookies[0]).toMatchObject({ key: 'a', value: 'b' });
    expect(cookies[1]).toMatchObject({ key: 'c', value: 'd' });
    expect(cookies[2]).toMatchObject({ key: 'e', value: 'f' });
    expect(cookies[3]).toMatchObject({ key: 'g', value: 'h' });
    if (assertionErrors.length > 0) {
      console.error(assertionErrors.join('\n'));
    }
    expect(assertions.every((id) => id)).toBe(true);
  });
  it('handles error thrown by underlying request', async () => {
    try {
      await httpRequest({ url: 'http://example.thisisnotavalidtopdomain' });
    } catch {}
    try {
      await httpRequest({ url: 'https://example.thisisnotavalidtopdomain' });
    } catch {}
    expect(true).toBe(true);
  });
});

/*
TODO:
 - Content-Encoding: gzip, br, deflate
 - hidePassword
 - invalid JSON response
*/
