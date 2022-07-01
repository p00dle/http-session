import type {
  HttpSessionStatusData,
  HttpSessionObject,
  HttpSessionParams,
  CredentialsData,
  LoginMethods,
  HttpSessionSerializedData,
  RequestObject,
  RequestSesssionOptions,
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
import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';
import { CookieJar } from './cookies/jar';
import { parseError } from './lib/parseError';
import { noOpLogger } from './lib/noOpLogger';
import { UtilityClass } from './lib/UtilityClass';
import { merge } from './lib/merge';
import { Cookie } from './types/cookies';

const DEFAULT_SESSION_PARAMS: HttpSessionParams<unknown, void, void> = {
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
  enhanceLogoutMethods: undefined,
  _makeHttpRequest: nodeHttpRequest,
  _makeHttpsRequest: nodeHttpsRequest,
};

export class HttpSession<S, E, E2> extends UtilityClass<HttpSessionStatusData> {
  protected login: ((session: LoginMethods<S, E>, state?: S) => Promise<void>) | null;
  protected logout: ((session: LoginMethods<S, E2>, state: S) => Promise<void>) | null;
  protected _makeHttpRequest: MakeHttpRequest;
  protected _makeHttpsRequest: MakeHttpRequest;
  protected alwaysRenew: boolean;
  protected lockoutTimeMs: number;
  protected heartbeatUrl: string | null;
  protected heartbeatIntervalMs: number;
  protected logger: Logger;
  protected enhanceLoginMethods?: (ref: symbol) => Promise<E>;
  protected enhanceLogoutMethods?: () => Promise<E2>;
  protected credentials: CredentialsData = { username: null, password: null };
  protected state: S;
  protected defaultHeaders: HttpHeaders = {};

  protected allowMultipleRequests: boolean;
  protected lastUrl: URL | undefined = undefined;
  protected requestQueue: RequestObject<S>[] = [];
  protected loginPromise: Promise<any> | null = null;
  protected logoutPromise: Promise<any> | null = null;
  protected status: HttpSessionStatusData;
  protected heartbeatTimeout: NodeJS.Timeout | null = null;

  protected cookieJar: CookieJar;
  protected httpAgent: HttpAgent;
  protected httpsAgent: HttpsAgent;

  constructor(params: Partial<HttpSessionParams<S, E, E2>> = {}) {
    super();
    const normalizedParams = { ...DEFAULT_SESSION_PARAMS, ...params } as HttpSessionParams<S, E, E2>;
    this.login = normalizedParams.login;
    this.logout = normalizedParams.logout;
    this._makeHttpRequest = normalizedParams._makeHttpRequest;
    this._makeHttpsRequest = normalizedParams._makeHttpsRequest;
    this.alwaysRenew = normalizedParams.alwaysRenew;
    this.lockoutTimeMs = normalizedParams.lockoutTimeMs;
    this.heartbeatUrl = normalizedParams.heartbeatUrl;
    this.heartbeatIntervalMs = normalizedParams.heartbeatIntervalMs;
    this.allowMultipleRequests = normalizedParams.allowMultipleRequests;
    this.logger = normalizedParams.logger;
    this.httpAgent = new HttpAgent(normalizedParams.agentOptions);
    this.httpsAgent = new HttpsAgent(normalizedParams.agentOptions);
    this.setDefaultHeaders(normalizedParams.defaultHeaders);
    this.cookieJar = new CookieJar();
    this.cookieJar.addCookies(normalizedParams.cookies);
    this.enhanceLoginMethods = normalizedParams.enhanceLoginMethods;
    this.enhanceLogoutMethods = normalizedParams.enhanceLogoutMethods;
    this.state = normalizedParams.state;
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
    if (this.status.isLoggedIn) await this.logoutWrapper();
  }

  public async invalidateSession(error = 'Session invalidated') {
    if (this.status.isLoggedIn) await this.logoutWrapper();
    this.changeStatus({ status: 'Logged Out', error, lastError: Date.now(), inQueue: 0 });
    this.next();
  }

  public async requestSession(
    { timeout = 30000, onRelease, beforeRequest, ref = Symbol('request-session') }: RequestSesssionOptions = {
      timeout: 30000,
      ref: Symbol('request-session'),
    }
  ): Promise<HttpSessionObject<S>> {
    const inQueue = this.status.inQueue + 1;
    this.changeStatus({ inQueue });
    if (this.allowMultipleRequests) {
      if (beforeRequest) await beforeRequest(ref);
      await this.loginWrapper(ref);
      this.loginPromise = null;
      this.changeStatus({ status: 'In Use' });
      return this.getSessionObject(ref, onRelease);
    }
    return new Promise<HttpSessionObject<S>>(async (resolve, reject) => {
      let settled = false;
      const timeoutMsg = `Timed out waiting for session after ${timeout}ms`;
      const cancelTimeout = this.setTimeout(() => onSettle(timeoutMsg), timeout);
      const requestQueue = this.requestQueue;
      const decrementQueue = () => {
        this.changeStatus({ inQueue: this.status.inQueue - 1 });
      };
      const next = this.next.bind(this);
      function onSettle(err: unknown, val?: HttpSessionObject<S>) {
        if (settled) return;
        settled = true;
        cancelTimeout();
        if (err) {
          decrementQueue();
          const index = requestQueue.indexOf(requestObject);
          if (index >= 0) requestQueue.splice(index, 1);
          reject(err);
          next();
        } else resolve(val as HttpSessionObject<S>);
      }
      const requestObject: RequestObject<S> = {
        resolve: (val) => onSettle(null, val),
        reject: onSettle,
        ref,
        onRelease,
        beforeRequest,
      };
      this.requestQueue.push(requestObject);
      this.next();
    });
  }

  protected loginMethods: LoginMethods<S, any> = {
    getCredentials: () => this.credentials,
    setState: this.setState.bind(this),
    setHeartbeatUrl: (url: string | null) => {
      this.heartbeatUrl = url;
    },
    request: this.request.bind(this),
    setDefaultHeaders: this.setDefaultHeaders.bind(this),
    addCookies: (cookies: Cookie[]) => this.cookieJar.addCookies(cookies),
    removeCookies: (cookies: { key?: string; domain?: string; path?: string }[]) =>
      cookies.forEach((cookie) => this.cookieJar.removeCookies(cookie)),
  };

  protected loginWrapper(ref: symbol): Promise<void> {
    if (this.status.isLoggedIn) return Promise.resolve();
    if (!this.loginPromise) {
      this.loginPromise = new Promise<void>(async (resolve, reject) => {
        try {
          await this.waitForLockout();
          if (this.login) {
            this.changeStatus({ status: 'Logging In' });
            if (this.enhanceLoginMethods) {
              const enhancedMethods = await this.enhanceLoginMethods(ref);
              await this.login({ ...this.loginMethods, ...enhancedMethods }, this.state);
            } else {
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
          if (this.enhanceLogoutMethods) {
            const enhancedMethods = await this.enhanceLogoutMethods();
            await this.logout({ ...this.loginMethods, ...enhancedMethods }, this.state as S);
          } else {
            await this.logout(this.loginMethods, this.state as S);
          }
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
    const { agent, cookieJar, headers, logger, previousUrl, url: originalUrl, ...otherOptions } = options;
    const url = typeof originalUrl === 'string' ? new URL(originalUrl) : originalUrl;
    const isHttps = url.protocol === 'https:';
    this.stopHeartbeat();
    const response = await httpRequest({
      url,
      agent: agent || (isHttps ? this.httpsAgent : (this.httpAgent as HttpsAgent)),
      cookieJar: cookieJar || this.cookieJar,
      headers: headers ? { ...this.defaultHeaders, ...headers } : this.defaultHeaders,
      logger: logger || this.logger,
      previousUrl: previousUrl || this.lastUrl,
      _request: isHttps ? this._makeHttpsRequest : this._makeHttpRequest,
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
      if (request.beforeRequest) await request.beforeRequest(request.ref);
      await this.loginWrapper(request.ref);
      this.loginPromise = null;
      this.changeStatus({ status: 'In Use' });
      request.resolve(this.getSessionObject(request.ref, request.onRelease));
    } catch (err) {
      request.reject(err);
    }
  }

  protected getSessionObject(ref: symbol, onRelease?: (ref: symbol) => any): HttpSessionObject<S> {
    const wrap = <A extends any[], R>(
      fnName: string,
      fn: (...args: A) => R,
      releaseAfter?: boolean
    ): ((...args: A) => R) => {
      return (...args) => {
        if (sessionObject.wasReleased) {
          throw new Error(`calling ${fnName} failed because session has already been released`);
        } else if (this.status.status !== 'In Use') {
          if (onRelease) onRelease(ref);
          throw new Error(`calling ${fnName} failed because session is in status ${this.status.status}`);
        }
        if (releaseAfter) {
          sessionObject.wasReleased = true;
          if (onRelease) onRelease(ref);
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
