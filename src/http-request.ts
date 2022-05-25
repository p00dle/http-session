import type { RequestOptions } from 'node:https';
import type { Readable, Transform } from 'node:stream';
import { CookieJar } from './cookies/jar';
import { URL } from 'node:url';
import { request as nodeHttpsRequest } from 'node:https';
import { request as nodeHttpRequest } from 'node:http';
import { noOpLogger } from './logger';
import { asyncPipeline, collectStreamToBuffer, collectStreamToString, limitString, makeCallbackPromise } from './utils';
import type {
  ErrorWithStack,
  HttpRequestError,
  HttpRequestResponse,
  HttpHeaders,
  HttpRequestDataType,
  HttpMethod,
  HttpRequestOptions,
  HttpRequestParams,
  HttpResponseType,
  ResponseStream,
} from './types/http-request';
import { createGunzip, createBrotliDecompress, createInflate } from 'node:zlib';
/* Resources
https://developer.mozilla.org/en-US/docs/Web/HTTP/Redirections
https://nodejs.org/api/http.html#httprequestoptions-callback
https://nodejs.org/api/http.html#class-httpagent
https://stackoverflow.com/a/64208818
https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Referrer-Policy
*/

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:100.0) Gecko/20100101 Firefox/100.0';

export function isHttpRequestError(err: any): err is HttpRequestError {
  return (
    !!err &&
    typeof err === 'object' &&
    (!err.message || typeof err.message === 'string') &&
    typeof err.stack === 'string' &&
    !!err.request &&
    !!err.response
  );
}

export function makeHttpRequestError(error: Error, responseData: HttpRequestResponse<any>): HttpRequestError {
  const { request, ...response } = responseData;
  return Object.assign({ message: error.message as string, stack: error.stack as string }, { request, response });
}

function isError(err: any): err is ErrorWithStack {
  return (
    !!err &&
    typeof err === 'object' &&
    (!err.message || typeof err.message === 'string') &&
    typeof err.stack === 'string'
  );
}

function isReadableStream(val: any): val is Readable {
  return !!val && typeof val.pipe === 'function';
}

function isBinary(val: any): val is Buffer | Uint8Array {
  return Buffer.isBuffer(val) || val instanceof Uint8Array;
}

function isRecord(val: any): val is Record<string, string | string[]> {
  return typeof val === 'object' && !Array.isArray(val) && Object.keys(val).length >= 0;
}

function formatData<T extends HttpRequestDataType>(
  dataType: T,
  data?: Readable | string | Buffer | Uint8Array | null | Record<string, string[]>
): Readable | string | Buffer | Uint8Array {
  if (dataType === 'stream') {
    if (!isReadableStream(data)) throw new TypeError('Property data is not a ReadableStream when dataType is "stream"');
    return data;
  } else if (dataType === 'binary') {
    if (!isBinary(data)) throw new TypeError('Property data is not a Buffer or Uint8Array when dataType is "binary"');
    return data;
  } else if (dataType === 'raw') {
    return typeof data === 'string' ? data : data ? String(data) : '';
  } else if (dataType === 'form') {
    if (!data) return '';
    if (!isRecord(data)) throw new TypeError('Property data is not an object when dataType is "form"');
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(data)) {
      if (Array.isArray(value)) {
        value.forEach((val) => searchParams.append(key, val));
      } else {
        searchParams.append(key, value);
      }
    }
    return searchParams.toString();
  } else if (dataType === 'json') {
    if (typeof data === 'undefined') return '';
    return JSON.stringify(data);
  }
  throw new TypeError(`Invalid dataType: ${dataType}`);
}

function makeRequestParams<T extends HttpRequestDataType>(
  options: HttpRequestOptions<T, any>,
  url: URL
): HttpRequestParams {
  return {
    dataType: (options.dataType || 'raw') as T,
    responseType: options.responseType || 'string',
    maxRedirects: options.maxRedirects || 5,
    formattedData: formatData(options.dataType || 'raw', options.data),
    logger: noOpLogger,
    makeHttpRequest: options._request || nodeHttpRequest,
    makeHttpsRequest: options._request || nodeHttpsRequest,
    host: options.host || options.previousUrl ? makeURL(options.previousUrl).host : url.host,
    origin: options.previousUrl ? makeURL(options.previousUrl).origin : url.origin,
  };
}

function copyHeaders(headers: HttpHeaders): HttpHeaders {
  const output: HttpHeaders = {};
  for (const [header, value] of Object.entries(headers)) {
    output[header] = Array.isArray(value) ? value.slice(0) : value;
  }
  return output;
}

function makeHeaders(
  requestParams: HttpRequestParams,
  cookieJar: CookieJar,
  url: URL,
  previousUrl: URL | undefined,
  existingHeaders: HttpHeaders,
  isGetMethod: boolean
) {
  const headers = copyHeaders(existingHeaders);
  if (!isGetMethod && !headers['Content-Type'] && !headers['Content-Length']) {
    if (requestParams.dataType === 'form') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(requestParams.formattedData as string);
    } else if (requestParams.dataType === 'binary') {
      headers['Content-Type'] = 'application/octet-stream';
      headers['Content-Length'] = Buffer.byteLength(requestParams.formattedData as Buffer | Uint8Array);
    } else if (requestParams.dataType === 'json') {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(requestParams.formattedData as string);
    } else if (requestParams.dataType === 'raw') {
      headers['Content-Length'] = Buffer.byteLength(requestParams.formattedData as string);
    }
  }
  if (previousUrl && !headers['Referer']) {
    addRefererToHeaders(url, previousUrl, headers);
  }
  if (!headers['Origin']) {
    headers['Origin'] = requestParams.origin;
  }
  if (!headers['Host']) {
    headers['Host'] = requestParams.host;
  }
  if (!headers['User-Agent']) {
    headers['User-Agent'] = DEFAULT_USER_AGENT;
  }
  if (!headers['Accept']) {
    if (requestParams.responseType === 'json') {
      headers['Accept'] = 'application/json';
    } else {
      headers['Accept'] = 'text/html, application/xhtml+xml, application/xml;q=0.9, */*;q=0.8';
    }
  }
  if (!headers['Accept-Encoding']) {
    headers['Accept-Encoding'] = 'gzip, deflate, br';
  }
  if (!headers['Accept-Language']) {
    headers['Accept-Language'] = 'en-GB,en;q=0.5';
  }
  const cookies = cookieJar.getRequestCookies(url, requestParams.host);
  headers.Cookie = headers.Cookie ? headers.Cookie.concat(cookies) : cookies;
  return headers;
}

function makeOptions<T extends HttpRequestDataType>(
  options: HttpRequestOptions<T, any>
): [HttpRequestParams, CookieJar, URL, { headers: HttpHeaders; method: HttpMethod } & RequestOptions, string] {
  const url = makeURL(options.url);
  const previousUrl = options.previousUrl ? makeURL(options.previousUrl) : undefined;
  const requestParams = makeRequestParams(options, url);
  const cookieJar = options.cookieJar || new CookieJar();
  if (options.cookies) cookieJar.addCookies(options.cookies);
  const headers = makeHeaders(
    requestParams,
    cookieJar,
    url,
    previousUrl,
    options.headers || {},
    !options.method || options.method === 'GET'
  );
  return [
    requestParams,
    cookieJar,
    url,
    {
      method: options.method || 'GET',
      agent: options.agent,
      headers,
      signal: options.abortSignal,
      timeout: options.timeout,
    },
    options.hidePassword || '',
  ];
}

function getContentEncoding(headers: HttpHeaders): null | 'gzip' | 'br' | 'deflate' {
  const acceptedValues = ['gzip', 'br', 'deflate'];
  const headerValue = (headers['Content-Encoding'] || headers['content-encoding'] || null) as string | null;
  if (headerValue === null) return null;
  if (acceptedValues.includes(headerValue)) return headerValue as 'gzip' | 'br' | 'deflate';
  else throw Error('Content-Encoding not recognised: ' + headerValue);
}

function isRedirect(status?: number): boolean {
  return Number(status) >= 300 && Number(status) < 400;
}

function extractCookiesFromHeaders(allHeaders: HttpHeaders, incoming: boolean): [Record<string, string>, HttpHeaders] {
  const { Cookie: requestCookieHeader, 'Set-Cookie': responseCookieHeader, ...headers } = allHeaders;
  const cookies: Record<string, string> = {};
  const cookieArray = incoming
    ? Array.isArray(responseCookieHeader)
      ? responseCookieHeader
      : []
    : (requestCookieHeader as string[]);
  cookieArray.forEach((str) => {
    const [key, value] = str.trim().split('=');
    cookies[key] = value;
  });
  return [cookies, headers];
}

function makeRequestData(
  requestParams: HttpRequestParams,
  url: URL,
  nodeRequestParams: { headers: HttpHeaders; method: HttpMethod } & RequestOptions,
  data: any
): HttpRequestResponse<any>['request'] {
  const [cookies, headers] = extractCookiesFromHeaders(nodeRequestParams.headers, false);
  return {
    method: nodeRequestParams.method,
    url,
    timeout: typeof nodeRequestParams.timeout === 'number' ? nodeRequestParams.timeout : '[NO TIMEOUT]',
    dataType: requestParams.dataType,
    data,
    formattedData: requestParams.formattedData,
    headers,
    cookies,
  };
}
const invalidUrl = new URL('http://invalid.url');
export function isInvalidUrl(url: URL): boolean {
  return url === invalidUrl;
}
function makeURL(url?: string | URL): URL {
  if (url instanceof URL) return url;
  if (typeof url !== 'string') return invalidUrl;
  try {
    return new URL(url);
  } catch {
    return invalidUrl;
  }
}

function makeResponseData<T extends HttpRequestDataType, R extends HttpResponseType>(
  options: HttpRequestOptions<T, R>
): HttpRequestResponse<R> {
  return {
    status: 0,
    statusMessage: '',
    url: invalidUrl,
    redirectCount: 0,
    redirectUrls: [],
    cookies: {},
    headers: {},
    data: null,
    request: {
      method: 'UNKNOWN',
      timeout: '[NO TIMEOUT]',
      url: makeURL(options.url),
      dataType: 'raw',
      data: '',
      formattedData: '',
      headers: {},
      cookies: {},
    },
  };
}
/*
strict-origin-when-cross-origin
Send the origin, path, and querystring when performing a same-origin request. 
For cross-origin requests send the origin (only) when the protocol security level stays same (HTTPS→HTTPS). 
Don't send the Referer header to less secure destinations (HTTPS→HTTP).
*/
function addRefererToHeaders(url: URL, previousUrl: URL, headers: HttpHeaders) {
  const sameOrigin = url.origin === previousUrl.origin;
  const securityDowngrade = previousUrl.protocol === 'https:' && url.protocol === 'http:';
  if (securityDowngrade) {
    delete headers.Referer;
  } else if (sameOrigin) {
    headers.Referer = previousUrl.origin + previousUrl.pathname + previousUrl.search;
  } else {
    headers.Referer = previousUrl.origin;
  }
}

function isPathAbsolute(str: string): boolean {
  return /^https*:\/\//.test(str);
}

function makeRedirectUrl(previous: URL, current?: string): URL {
  if (typeof current !== 'string') return invalidUrl;
  try {
    return isPathAbsolute(current) ? new URL(current) : new URL(current, previous.origin);
  } catch {
    return invalidUrl;
  }
}

function formatResponse(response: Omit<HttpRequestResponse<any>, 'request'>) {
  const responseData = {
    status: response.status,
    statusMessage: response.statusMessage,
    url: isInvalidUrl(response.url) ? '[INVALID URL]' : response.url.toString(),
    redirectUrls: response.redirectUrls.map((url) => limitString(url, 2000)),
    redirectCount: response.redirectCount,
    headers: response.headers,
    cookies: response.cookies,
    data: isReadableStream(response.data)
      ? '[STREAM]'
      : isBinary(response.data)
      ? '[BINARY]'
      : typeof response.data === 'string'
      ? limitString('' + response.data, 2000)
      : response.data,
  };
  return JSON.stringify(responseData, null, 2);
}

function formatRequest(request: HttpRequestResponse<any>['request'], hidePassword: string) {
  const requestData = {
    method: request.method,
    url: request.url.toString(),
    timeout: request.timeout,
    dataType: request.dataType,
    data: isReadableStream(request.data)
      ? '[STREAM]'
      : isBinary(request.data)
      ? '[BINARY]'
      : limitString('' + request.data, 2000).replace(hidePassword, '[PASSWORD]'),
    formattedData: isReadableStream(request.data)
      ? '[STREAM]'
      : isBinary(request.data)
      ? '[BINARY]'
      : '' + limitString('' + request.data, 2000),
    headers: request.headers,
    cookies: request.cookies,
  };
  return JSON.stringify(requestData, null, 2);
}

export async function httpRequest<T extends HttpRequestDataType, R extends HttpResponseType>(
  options: HttpRequestOptions<T, R>
): Promise<HttpRequestResponse<R>> {
  if (typeof options !== 'object') throw new TypeError('options must be an object with at least url property defined');
  const [requestParams, cookieJar, url, nodeRequestParams, hidePassword] = makeOptions(options);
  const { dataType, formattedData, maxRedirects, responseType, logger, makeHttpRequest, makeHttpsRequest } =
    requestParams;
  const responseData = makeResponseData(options);
  responseData.request = makeRequestData(requestParams, url, nodeRequestParams, options.data);
  if (url === invalidUrl) {
    throw makeHttpRequestError(new Error('Invalid Url'), responseData);
  }
  const makeRequest = url.protocol === 'https:' ? makeHttpsRequest : makeHttpRequest;
  try {
    let redirectUrl = url;
    let response: ResponseStream;
    let keepMethodAndData = nodeRequestParams.method !== 'GET';
    do {
      if (!keepMethodAndData) {
        nodeRequestParams.method = 'GET';
        nodeRequestParams.headers['Content-Length'] = 0;
        delete nodeRequestParams.headers['Content-Type'];
      }
      const [responsePromise, responseCallback] = makeCallbackPromise<ResponseStream>();
      if (responseData.redirectCount === 0) {
        logger.debug({
          message: `${nodeRequestParams.method} ${limitString(url, 200)}`,
          details: formatRequest(responseData.request, hidePassword),
        });
      }
      const request = makeRequest(redirectUrl, nodeRequestParams, responseCallback);
      if (keepMethodAndData) {
        if (dataType === 'stream') {
          await asyncPipeline(formattedData as Readable, request);
        } else {
          request.end(formattedData);
        }
      } else {
        request.end();
      }
      response = await responsePromise;
      cookieJar.collectCookiesFromResponse(redirectUrl, response.headers);
      if (!isRedirect(response.statusCode)) break;
      const originalUrl = redirectUrl;
      redirectUrl = makeRedirectUrl(originalUrl, response.headers.location);
      addRefererToHeaders(redirectUrl, originalUrl, nodeRequestParams.headers);
      if (redirectUrl === invalidUrl) {
        throw makeHttpRequestError(new Error('Redirected to invalid URL'), responseData);
      }
      nodeRequestParams.headers.Host = redirectUrl.hostname;
      nodeRequestParams.headers.Origin = redirectUrl.origin;
      responseData.redirectUrls.push(redirectUrl.toString());
      nodeRequestParams.headers.Cookie = cookieJar.getRequestCookies(redirectUrl, originalUrl.host);
      logger.debug({
        message: `REDIRECT (${response.statusCode}) TO ${limitString(redirectUrl, 200)}`,
        details: `FROM: ${limitString(originalUrl, 1000)}\nTO: ${limitString(redirectUrl, 1000)}`,
      });
      keepMethodAndData = response.statusCode === 307 || response.statusCode === 308;
    } while (responseData.redirectCount++ < maxRedirects);
    if (responseData.redirectCount >= maxRedirects) {
      throw makeHttpRequestError(new Error('Max redirect count exceeded'), responseData);
    }
    const [cookies, headers] = extractCookiesFromHeaders(response.headers, true);
    let dataStream: Readable | Transform = response;
    const contentEncoding = getContentEncoding(response.headers);
    if (contentEncoding === 'br') {
      const decompress = createBrotliDecompress();
      response.pipe(decompress);
      dataStream = decompress;
    } else if (contentEncoding === 'deflate') {
      const decompress = createInflate();
      response.pipe(decompress);
      dataStream = decompress;
    } else if (contentEncoding === 'gzip') {
      const decompress = createGunzip();
      response.pipe(decompress);
      dataStream = decompress;
    }

    let data =
      responseType === 'stream'
        ? dataStream
        : responseType === 'binary'
        ? await collectStreamToBuffer(dataStream)
        : await collectStreamToString(dataStream);
    if (responseType === 'json') data = JSON.parse(data as string);
    responseData.status = response.statusCode as number;
    responseData.statusMessage = response.statusMessage || '';
    responseData.url = redirectUrl;
    responseData.cookies = cookies;
    responseData.headers = headers;
    responseData.data = data as any;
    logger.debug({
      message: `RESPONSE ${limitString(redirectUrl, 200)} (${responseData.status})`,
      details: formatResponse(responseData),
    });
    return responseData;
  } catch (err) {
    if (isError(err)) {
      const { request, ...response } = responseData;
      err.request = formatRequest(request, hidePassword);
      err.response = formatResponse(response);
    }
    throw err;
  }
}
