import type {
  HttpSessionStatusData,
  HttpSessionObject,
  HttpSessionParams,
  CredentialsData,
  LoginMethods,
  HttpSessionSerializedData,
} from './types/http-session';

import type {
  HttpRequestDataType,
  HttpRequestOptions,
  HttpRequestResponse,
  HttpResponseType,
  MakeHttpRequest,
  HttpHeaders,
} from './types/http-request';
import type { Logger } from './types/logger';
import { request as nodeHttpsRequest } from 'node:https';
import { request as nodeHttpRequest } from 'node:http';
import { httpRequest } from './http-request';
import { Agent } from 'https';
import { CookieJar } from './cookies/jar';
import { parseError } from './lib/parseError';
import { noOpLogger } from './lib/noOpLogger';
import { UtilityClass } from './lib/UtilityClass';
import { merge } from './lib/merge';

const DEFAULT_SESSION_PARAMS: HttpSessionParams<unknown, void> = {
  name: '',
  state: {} as unknown,
  defaultHeaders: {},
  cookies: [],
  login: null,
  logout: null,
  logger: noOpLogger,
  alwaysRenew: false,
  lockoutTimeMs: 86_400_000,
  heartbeatUrl: null,
  heartbeatIntervalMs: 60_000,
  allowMultipleRequests: false,
  agentOptions: {},
  enhanceLoginMethods: undefined,
  _makeHttpRequest: (url, options, cb) =>
    url.protocol === 'https:' ? nodeHttpsRequest(url, options, cb) : nodeHttpRequest(url, options, cb),
};

export class HttpSession<S = unknown, E = void> extends UtilityClass<HttpSessionStatusData> {
  protected login: ((session: LoginMethods<S, E>, state?: S) => Promise<void>) | null;
  protected logout: ((state: S) => Promise<void>) | null;
  protected _makeHttpRequest: MakeHttpRequest;
  protected alwaysRenew: boolean;
  protected lockoutTimeMs: number;
  protected heartbeatUrl: string | null;
  protected heartbeatIntervalMs: number;
  protected logger: Logger;
  protected enhanceLoginMethods?: () => Promise<E>;
  protected credentials: CredentialsData = { username: null, password: null };
  protected state?: S;
  protected defaultHeaders: HttpHeaders = {};

  protected allowMultipleRequests: boolean;
  protected lastUrl: URL | undefined = undefined;
  protected requestQueue: { resolve: (val: HttpSessionObject<S>) => any; reject: (err: unknown) => any }[] = [];
  protected loginPromise: Promise<any> | null = null;
  protected logoutPromise: Promise<any> | null = null;
  protected status: HttpSessionStatusData;
  protected heartbeatTimeout: NodeJS.Timeout | null = null;

  protected cookieJar = new CookieJar();
  protected httpAgent: Agent;

  constructor(params: Partial<HttpSessionParams<S, E>> = {}) {
    super();
    const normalizedParams = { ...DEFAULT_SESSION_PARAMS, ...params } as HttpSessionParams<S>;
    this.login = normalizedParams.login;
    this.logout = normalizedParams.logout;
    this._makeHttpRequest = normalizedParams._makeHttpRequest;
    this.alwaysRenew = normalizedParams.alwaysRenew;
    this.lockoutTimeMs = normalizedParams.lockoutTimeMs;
    this.heartbeatUrl = normalizedParams.heartbeatUrl;
    this.heartbeatIntervalMs = normalizedParams.heartbeatIntervalMs;
    this.allowMultipleRequests = normalizedParams.allowMultipleRequests;
    this.logger = normalizedParams.logger;
    this.httpAgent = new Agent(normalizedParams.agentOptions);
    this.setDefaultHeaders(normalizedParams.defaultHeaders);
    this.cookieJar.addCookies(normalizedParams.cookies);
    this.enhanceLoginMethods = normalizedParams.enhanceLoginMethods as undefined;
    this.status = {
      name: normalizedParams.name,
      status: this.login === null ? 'Ready' : 'Logged Out',
      uptimeSince: null,
      lastError: null,
      error: null,
      inQueue: 0,
      isLoggedIn: false,
    } as const;
  }

  public setState(state: Partial<S>) {
    this.state = merge(this.state, state);
  }
  public setDefaultHeaders(headers: HttpHeaders) {
    this.defaultHeaders = headers;
  }

  public setCredentials(creds: CredentialsData) {
    this.credentials = creds;
  }

  public async shutdown() {
    this.clearAllTimeouts();
    this.stopHeartbeat();
    this.requestQueue.forEach(({ reject }) => reject('Session forced to stop'));
    if (this.status.isLoggedIn) await this.logoutWrapper();
  }

  public async invalidateSession(error = 'Session invalidated') {
    if (this.status.isLoggedIn) await this.logoutWrapper();
    this.changeStatus({ status: 'Logged Out', error, lastError: Date.now() });
  }

  public async requestSession(timeout = 30000, onRelease?: () => any): Promise<HttpSessionObject<S>> {
    const inQueue = this.status.inQueue + 1;
    this.changeStatus({ inQueue });
    if (this.allowMultipleRequests) {
      await this.loginWrapper();
      this.loginPromise = null;
      this.changeStatus({ status: 'In Use' });
      return this.getSessionObject(onRelease);
    }
    return new Promise<HttpSessionObject<S>>(async (resolve, reject) => {
      let settled = false;
      const timeoutMsg = `Timed out waiting for session after ${timeout}ms`;
      const cancelTimeout = this.setTimeout(() => onSettle(timeoutMsg), timeout);
      function onSettle(err: unknown, val?: HttpSessionObject<S>) {
        if (settled) return;
        settled = true;
        cancelTimeout();
        if (err) reject(err);
        else resolve(val as HttpSessionObject<S>);
      }
      this.requestQueue.push({
        resolve: (val) => onSettle(null, val),
        reject: onSettle,
      });
      this.next();
    });
  }

  protected loginMethods: LoginMethods<S> = {
    getCredentials: () => this.credentials,
    setState: this.setState.bind(this),
    setDefaultHeaders: this.setDefaultHeaders.bind(this),
    addCookies: (cookies) => this.cookieJar.addCookies(cookies),
  };

  protected loginWrapper(): Promise<void> {
    if (this.status.isLoggedIn) return Promise.resolve();
    if (!this.loginPromise) {
      this.loginPromise = new Promise<void>(async (resolve, reject) => {
        try {
          await this.waitForLockout();
          if (this.login) {
            this.changeStatus({ status: 'Logging In' });
            if (this.enhanceLoginMethods) {
              const enhancedMethods = await this.enhanceLoginMethods();
              // eslint-disable-next-line @typescript-eslint/ban-ts-comment
              // @ts-ignore don't have time to figure out why this is failing
              await this.login({ ...this.loginMethods, ...enhancedMethods }, this.state);
            } else {
              // eslint-disable-next-line @typescript-eslint/ban-ts-comment
              // @ts-ignore ditto
              await this.login(this.loginMethods, this.state);
            }
          }
          this.changeStatus({ status: 'Ready', isLoggedIn: true, error: null, lastError: null });
          this.heartbeat();
          this.loginPromise = null;
          resolve();
        } catch (err) {
          const [errorMessage] = parseError(err);
          this.changeStatus({ status: 'Error', error: errorMessage, lastError: Date.now() });
          this.stopHeartbeat();
          this.loginPromise = null;
          reject(err);
        }
      });
    }
    return this.loginPromise;
  }

  protected logoutWrapper(): Promise<void> {
    if (!this.status.isLoggedIn) return Promise.resolve();
    if (!this.logoutPromise) {
      this.logoutPromise = new Promise<void>(async (resolve) => {
        this.stopHeartbeat();
        if (!this.logout) {
          this.changeStatus({ status: 'Logged Out', uptimeSince: null, isLoggedIn: false });
          return resolve();
        }
        try {
          this.changeStatus({ status: 'Logging Out' });
          await this.logout(this.state as S);
          this.stopHeartbeat();
          this.changeStatus({ status: 'Logged Out', uptimeSince: null, isLoggedIn: false });
        } catch (err) {
          const [errorMessage] = parseError(err);
          this.changeStatus({ status: 'Error', error: errorMessage, lastError: Date.now(), isLoggedIn: false });
        }
        resolve();
      });
    }
    return this.logoutPromise;
  }

  protected stopHeartbeat() {
    if (this.heartbeatTimeout) clearTimeout(this.heartbeatTimeout);
  }

  protected heartbeat() {
    if (!this.heartbeatUrl) return;
    if (this.heartbeatTimeout) clearTimeout(this.heartbeatTimeout);

    this.heartbeatTimeout = setTimeout(async () => {
      if (this.status.status === 'In Use' || this.status.status === 'Ready') {
        await this.request({ url: this.heartbeatUrl as string });
      }
      this.heartbeat();
    }, this.heartbeatIntervalMs);
  }

  protected async request<T extends HttpRequestDataType, R extends HttpResponseType>(
    options: HttpRequestOptions<T, R>
  ): Promise<HttpRequestResponse<R>> {
    const { agent, cookieJar, headers, logger, previousUrl, ...otherOptions } = options;
    this.stopHeartbeat();
    const response = await httpRequest({
      agent: agent || this.httpAgent,
      cookieJar: cookieJar || this.cookieJar,
      headers: headers ? { ...this.defaultHeaders, ...headers } : this.defaultHeaders,
      logger: logger || this.logger,
      previousUrl: previousUrl || this.lastUrl,
      _request: this._makeHttpRequest,
      ...otherOptions,
    });
    this.heartbeat();
    this.lastUrl = response.url;
    return response;
  }

  protected async releaseSession() {
    this.lastUrl = undefined;
    const inQueue = this.status.inQueue - 1;
    this.changeStatus({ inQueue });
    if (this.allowMultipleRequests) {
      if (this.status.status !== 'Locked Out') {
        this.changeStatus({ status: inQueue === 0 ? 'Ready' : 'In Use' });
      }
      return;
    }
    if (this.alwaysRenew && this.status.status !== 'Locked Out' && this.status.status !== 'Error') {
      await this.logoutWrapper();
      this.logoutPromise = null;
    } else {
      this.changeStatus({ status: 'Ready' });
    }
    this.next();
  }

  protected async next() {
    if (this.requestQueue.length === 0) {
      if (this.status.isLoggedIn) this.changeStatus({ status: 'Ready' });
      return;
    }
    if (this.status.status === 'In Use') return;
    const request = this.requestQueue.shift();
    if (!request) return;
    try {
      await this.loginWrapper();
      this.loginPromise = null;
      this.changeStatus({ status: 'In Use' });
      request.resolve(this.getSessionObject());
    } catch (err) {
      request.reject(err);
    }
  }

  protected getSessionObject(onRelease?: () => any): HttpSessionObject<S> {
    const wrap = <A extends any[], R>(
      fnName: string,
      fn: (...args: A) => R,
      releaseAfter?: boolean
    ): ((...args: A) => R) => {
      return (...args) => {
        if (sessionObject.wasReleased) {
          throw new Error(`calling ${fnName} failed because session has already been released`);
        } else if (this.status.status !== 'In Use') {
          if (onRelease) onRelease();
          throw new Error(`calling ${fnName} failed because session is in status ${this.status}`);
        }
        if (releaseAfter) {
          sessionObject.wasReleased = true;
          if (onRelease) onRelease();
        }
        return fn(...args);
      };
    };
    const sessionObject = {
      getState: wrap('getState', () => this.state as S),
      request: wrap('request', (options) => this.request(options)),
      release: wrap('release', () => this.releaseSession(), true),
      serialize: wrap('serialize', () => this.serialize()),
      invalidate: wrap('invalidate', (err) => this.invalidateSession(err), true),
      reportLockout: wrap('reportLockout', () => this.reportLockout(), true),
      setState: wrap('setState', (state) => this.setState(state)),
      wasReleased: false,
    };
    return sessionObject;
  }

  protected async waitForLockout() {
    if (this.status.status !== 'Locked Out' || this.status.lastError === null) return;
    const waitFor = this.status.lastError + this.lockoutTimeMs - Date.now();
    if (waitFor <= 0) return;
    await new Promise<void>((resolve) => this.setTimeout(resolve, waitFor, true));
    if ((this.status.status as 'Locked Out' | 'Shutdown') === 'Shutdown') throw 'Session has shutdown';
  }

  protected serialize(): HttpSessionSerializedData<S> {
    return {
      state: this.state as S,
      defaultHeaders: this.defaultHeaders,
      cookies: this.cookieJar.toJSON(),
    };
  }

  protected async reportLockout() {
    this.changeStatus({ status: 'Locked Out', lastError: Date.now(), isLoggedIn: false });
  }
}
