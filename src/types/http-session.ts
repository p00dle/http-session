import type { AgentOptions } from 'node:http';
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

export type LoginMethods<S, E> = {
  getCredentials: () => CredentialsData;
  setState: (state: Partial<S>) => any;
  setDefaultHeaders: (headers: HttpHeaders) => any;
  addCookies: (cookies: Cookie[]) => any;
} & (E extends void ? unknown : E);

export interface HttpSessionParams<S, E> {
  name: string;
  state: S;
  login: ((session: LoginMethods<S, E>, state?: S) => any) | null;
  logout: ((params: S) => any) | null;
  logger: Logger;
  alwaysRenew: boolean;
  lockoutTimeMs: number;
  defaultHeaders: HttpHeaders;
  cookies: Cookie[];
  heartbeatUrl: string | null;
  heartbeatIntervalMs: number;
  allowMultipleRequests: boolean;
  agentOptions: AgentOptions;
  enhanceLoginMethods?: (ref: symbol) => Promise<E>;
  _makeHttpRequest: MakeHttpRequest;
}

export type HttpSessionOptions<S, E> = Partial<HttpSessionParams<S, E>>;

export interface RequestObject<S> {
  resolve: (val: HttpSessionObject<S>) => any;
  reject: (err: unknown) => any;
  ref: symbol;
  onRelease?: (ref: symbol) => any;
}
