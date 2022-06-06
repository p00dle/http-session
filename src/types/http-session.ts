import type { AgentOptions as HttpAgentOptions } from 'node:http';
import type { AgentOptions as HttpsAgentOptions } from 'node:https';
import type { Cookie } from './cookies';
import type {
  HttpRequestDataType,
  HttpResponseType,
  HttpRequestOptions,
  HttpRequestResponse,
  HttpHeaders,
  MakeHttpRequest,
} from './http-request';
import type { Logger } from './logger';

export type HttpSessionStatus =
  | 'Logged Out'
  | 'Logging In'
  | 'Ready'
  | 'In Use'
  | 'Logging Out'
  | 'Error'
  | 'Locked Out'
  | 'Shutdown';

export interface HttpSessionStatusData {
  name: string;
  status: HttpSessionStatus;
  uptimeSince: number | null;
  lastError: number | null;
  error: string | null;
  inQueue: number;
  isLoggedIn: boolean;
}

export interface CredentialsData {
  username: string | null;
  password: string | null;
}

export interface HttpSessionSerializedData<S> {
  state: S;
  defaultHeaders: HttpHeaders;
  cookies: Cookie[];
}
export interface HttpSessionObject<S> {
  getState: () => S;
  setState: (state: Partial<S>) => any;
  request: <T extends HttpRequestDataType, R extends HttpResponseType>(
    options: HttpRequestOptions<T, R>
  ) => Promise<HttpRequestResponse<R>>;
  release: () => Promise<void>;
  serialize: () => HttpSessionSerializedData<S>;
  reportLockout: () => Promise<void>;
  invalidate: (error?: string) => Promise<void>;
  wasReleased: boolean;
}

export type HttpSessionRequest = <T extends HttpRequestDataType, R extends HttpResponseType>(
  options: HttpRequestOptions<T, R>
) => Promise<HttpRequestResponse<R>>;

export type LoginMethods<S, E> = {
  request: HttpSessionRequest;
  getCredentials: () => CredentialsData;
  setState: (state: Partial<S>) => any;
  setHeartbeatUrl: (url: string | null) => any;
  setDefaultHeaders: (headers: HttpHeaders) => any;
  addCookies: (cookies: Cookie[]) => any;
  removeCookies: (cookies: { key?: string; domain?: string; path?: string }[]) => any;
} & (E extends void ? unknown : E);

export interface HttpSessionParams<S, E, E2> {
  name: string;
  state: S;
  login: ((session: LoginMethods<S, E>, state?: S) => any) | null;
  logout: ((session: LoginMethods<S, E2>, state: S) => any) | null;
  logger: Logger;
  alwaysRenew: boolean;
  lockoutTimeMs: number;
  defaultHeaders: HttpHeaders;
  cookies: Cookie[];
  heartbeatUrl: string | null;
  heartbeatIntervalMs: number;
  allowMultipleRequests: boolean;
  agentOptions: HttpAgentOptions & HttpsAgentOptions;
  enhanceLoginMethods?: (ref: symbol) => Promise<E>;
  enhanceLogoutMethods?: () => Promise<E2>;
  _makeHttpRequest: MakeHttpRequest;
  _makeHttpsRequest: MakeHttpRequest;
}

export type HttpSessionOptions<S, E, E2> = Partial<HttpSessionParams<S, E, E2>>;

export interface RequestObject<S> {
  resolve: (val: HttpSessionObject<S>) => any;
  reject: (err: unknown) => any;
  ref: symbol;
  beforeRequest?: (ref: symbol) => any;
  onRelease?: (ref: symbol) => any;
}

export interface RequestSesssionOptions {
  timeout?: number;
  ref?: symbol;
  beforeRequest?: (ref: symbol) => any;
  onRelease?: (ref: symbol) => any;
}
