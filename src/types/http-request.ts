import type { Readable, Writable } from 'node:stream';
import type { Agent, RequestOptions } from 'node:https';
import type { CookieJar } from '../cookies/jar';
import type { Logger } from './logger';
import type { Cookie } from './cookies';

interface UsedHeaders {
  location?: string;
  Referer?: string;
  Cookie?: string[];
  'Set-Cookie'?: string[];
}

export type HttpHeaders = UsedHeaders & Record<string, string | string[] | number | undefined>;

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
  hideSecrets?: string[];
  timeout?: number;
  dataType?: T;
  data?: HttpRequestData<T>;
  cookies?: Cookie[];
  cookieJar?: CookieJar;
  maxRedirects?: number;
  logger?: Logger;
  host?: string;
  _request?: MakeHttpRequest;
}

export type ResponseStream = Readable & {
  headers: HttpHeaders;
  statusCode?: number;
  statusMessage?: string;
};

export type MakeHttpRequest = (url: URL, options: RequestOptions, callback: (data: ResponseStream) => any) => Writable;

export interface HttpRequestParams {
  dataType: HttpRequestDataType;
  responseType: HttpResponseType;
  formattedData: Readable | string | Buffer | Uint8Array;
  maxRedirects: number;
  logger: Logger;
  host: string;
  origin: string;
  makeRequest: MakeHttpRequest;
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

export type ErrorWithStack = {
  message?: string;
  stack: string;
} & Record<string, unknown>;

export interface HttpRequestError {
  message: string;
  stack: string;
  request: HttpRequestResponse<any>['request'];
  response: Omit<HttpRequestResponse<any>, 'request'>;
}
