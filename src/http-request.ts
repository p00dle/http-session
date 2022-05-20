import type { Agent, RequestOptions } from 'node:https';
import type { Readable, Writable } from 'node:stream';
import type { Cookie } from './cookie';
import type { HttpHeaders } from './types';
import type { Logger } from './logger';

import { CookieJar } from './cookie';
import { URL } from 'node:url';
import { request as nodeHttpsRequest } from 'node:https';
import { request as nodeHttpRequest } from 'node:http';
import { noOpLogger } from './logger';
import { asyncPipeline, collectStreamToBuffer, collectStreamToString, limitString, makeCallbackPromise } from './utils';

/* Resources
https://developer.mozilla.org/en-US/docs/Web/HTTP/Redirections
https://nodejs.org/api/http.html#httprequestoptions-callback
https://nodejs.org/api/http.html#class-httpagent
https://stackoverflow.com/a/64208818
*/

export type HttpResponseType = 'string' | 'binary' | 'json' | 'stream';
export type HttpRequestDataType = 'json' | 'stream' | 'form' | 'binary' | 'raw';

export type HttpRequestData<T extends HttpRequestDataType | undefined> = T extends undefined
  ? any
  : T extends 'raw'
  ? any
  : T extends 'json'
  ? any
  : T extends 'stream'
  ? Readable
  : T extends 'form'
  ? Record<string, string | string[]>
  : T extends 'binary'
  ? Buffer | Uint8Array
  : never;

export interface HttpRequestOptions<T extends HttpRequestDataType, R extends HttpResponseType> {
  url: URL | string;
  previousUrl?: URL | string;
  method?: HttpMethod;
  responseType?: R;
  agent?: Agent | false;
  headers?: HttpHeaders;
  abortSignal?: AbortSignal;
  hidePassword?: string;
  timeout?: number;
  dataType?: T;
  data?: HttpRequestData<T>;
  cookies?: Cookie[];
  cookieJar?: CookieJar;
  maxRedirects?: number;
  logger?: Logger;
  _request?: MakeHttpRequest;
}

type ResponseStream = Readable & {
  headers: HttpHeaders;
  statusCode?: number;
  statusMessage?: string;
};

export type MakeHttpRequest = (url: URL, options: RequestOptions, callback: (data: ResponseStream) => any) => Writable;

interface HttpRequestParams {
  dataType: HttpRequestDataType;
  responseType: HttpResponseType;
  formattedData: Readable | string | Buffer | Uint8Array;
  maxRedirects: number;
  logger: Logger;
  makeHttpRequest: MakeHttpRequest;
  makeHttpsRequest: MakeHttpRequest;
}

export type HttpResponseDataType<T extends HttpResponseType> =
  | (T extends 'json'
      ? unknown
      : T extends 'binary'
      ? Buffer
      : T extends 'stream'
      ? Readable
      : T extends 'string'
      ? string
      : never)
  | null;

export interface HttpRequestResponse<T extends HttpResponseType> {
  status: number;
  statusMessage: string;
  url: URL;
  redirectUrls: string[];
  redirectCount: 0;
  headers: HttpHeaders;
  cookies: Record<string, string>;
  data: HttpResponseDataType<T>;
  request: {
    method: string;
    url: URL;
    timeout: number | '[NO TIMEOUT]';
    dataType: HttpRequestDataType;
    data: any;
    formattedData: Readable | string | Buffer | Uint8Array;
    headers: HttpHeaders;
    cookies: Record<string, string>;
  };
}
export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

type ErrorWithStack = {
  message?: string;
  stack: string;
} & Record<string, unknown>;

interface HttpRequestError {
  message: string;
  stack: string;
  request: HttpRequestResponse<any>['request'];
  response: Omit<HttpRequestResponse<any>, 'request'>;
}

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

function makeRequestParams<T extends HttpRequestDataType>(options: HttpRequestOptions<T, any>): HttpRequestParams {
  return {
    dataType: (options.dataType || 'raw') as T,
    responseType: options.responseType || 'string',
    maxRedirects: options.maxRedirects || 5,
    formattedData: formatData(options.dataType || 'raw', options.data),
    logger: noOpLogger,
    makeHttpRequest: options._request || nodeHttpRequest,
    makeHttpsRequest: options._request || nodeHttpsRequest,
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
  if (!isGetMethod) {
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
  cookieJar.addCookiesToHeaders(url, headers, previousUrl);
  return headers;
}

function makeOptions<T extends HttpRequestDataType>(
  options: HttpRequestOptions<T, any>
): [HttpRequestParams, CookieJar, URL, { headers: HttpHeaders; method: HttpMethod } & RequestOptions, string] {
  const url = makeURL(options.url);
  const previousUrl = options.previousUrl ? makeURL(options.previousUrl) : undefined;
  const requestParams = makeRequestParams(options);
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

function addRefererToHeaders(url: URL, headers: HttpHeaders) {
  const output = headers;
  output.Referer = url.origin + url.pathname + (url.search.length > 0 ? '?' + url.search : '');
  return output;
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
      nodeRequestParams.headers = addRefererToHeaders(redirectUrl, nodeRequestParams.headers);
      const originalUrl = redirectUrl;
      redirectUrl = makeRedirectUrl(originalUrl, response.headers.location);
      if (redirectUrl === invalidUrl) {
        throw makeHttpRequestError(new Error('Redirected to invalid URL'), responseData);
      }
      responseData.redirectUrls.push(redirectUrl.toString());
      nodeRequestParams.headers = cookieJar.addCookiesToHeaders(redirectUrl, nodeRequestParams.headers, originalUrl);
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
    let data =
      responseType === 'stream'
        ? response
        : responseType === 'binary'
        ? await collectStreamToBuffer(response)
        : await collectStreamToString(response);
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

// TODO: might need to use http.request for http requests and _httpRequest for both
// TODO: maybe make a copy of nodeRequestParams so it doesn't change
// TODO: what if there is an error on stream?
