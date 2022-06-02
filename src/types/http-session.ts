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

export interface HttpSessionSerializedData<S = any> {
  state: S;
  defaultHeaders: HttpHeaders;
  cookies: Cookie[];
}
export interface HttpSessionObject<S = any> {
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

export interface LoginMethods<S = any> {
  setState: (state: Partial<S>) => any;
  setDefaultHeaders: (headers: HttpHeaders) => any;
  addCookies: (cookies: Cookie[]) => any;
}

export interface HttpSessionParams<S = any> {
  name: string;
  state: S;
  login: ((params: S & CredentialsData, methods: LoginMethods<S>) => any) | null;
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
  _makeHttpRequest: MakeHttpRequest;
}

export type HttpSessionOptions<S = unknown> = Partial<HttpSessionParams<S>>;
