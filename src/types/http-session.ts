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

export interface HttpSessionObject<P, S> {
  getParams: () => P;
  getState: () => S;
  request: <T extends HttpRequestDataType, R extends HttpResponseType>(
    options: HttpRequestOptions<T, R>
  ) => Promise<HttpRequestResponse<R>>;
  release: () => Promise<void>;
  serialize: () => {
    params: P;
    defaultHeaders: HttpHeaders;
    cookies: Cookie[];
  };
  reportLockout: () => Promise<void>;
  invalidate: (error: string) => Promise<void>;
  wasReleased: boolean;
}

export interface HttpSessionParams<P, S> {
  name: string;
  params: P;
  login: ((params: P & CredentialsData) => any) | null;
  logout: ((params: P, state: S) => any) | null;
  logger: Logger;
  alwaysRenew: boolean;
  lockoutTimeMs: number;
  heartbeatUrl: string | null;
  heartbeatIntervalMs: number;
  allowMultipleRequests: boolean;
  agentOptions: AgentOptions;
  _makeHttpRequest: MakeHttpRequest;
}
