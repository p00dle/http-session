import type {
  HttpSessionStatusData,
  HttpSessionObject,
  HttpSessionParams,
  CredentialsData,
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

const DEFAULT_SESSION_PARAMS: HttpSessionParams<never, never> = {
  name: '',
  params: null as unknown as never,
  login: null,
  logout: null,
  logger: noOpLogger,
  alwaysRenew: false,
  lockoutTimeMs: 86_400_000,
  heartbeatUrl: null,
  heartbeatIntervalMs: 60_000,
  allowMultipleRequests: false,
  agentOptions: {},
  _makeHttpRequest: (url, options, cb) =>
    url.protocol === 'https:' ? nodeHttpsRequest(url, options, cb) : nodeHttpRequest(url, options, cb),
};

export class HttpSession<
  P extends Record<string, any> = never,
  S extends Record<string, any> = never
> extends UtilityClass<HttpSessionStatusData> {
  protected login: ((params: P & CredentialsData) => Promise<void>) | null;
  protected logout: ((params: P, state: S) => Promise<void>) | null;
  protected _makeHttpRequest: MakeHttpRequest;
  protected alwaysRenew: boolean;
  protected lockoutTimeMs: number;
  protected heartbeatUrl: string | null;
  protected heartbeatIntervalMs: number;
  protected logger: Logger;

  protected credentials: CredentialsData = { username: null, password: null };
  protected params?: P;
  protected state?: S;
  protected defaultHeaders: HttpHeaders = {};

  protected allowMultipleRequests: boolean;
  protected lastUrl: URL | undefined = undefined;
  protected requestQueue: { resolve: (val: HttpSessionObject<P, S>) => any; reject: (err: unknown) => any }[] = [];
  protected loginPromise: Promise<any> | null = null;
  protected logoutPromise: Promise<any> | null = null;
  protected status: HttpSessionStatusData;
  protected heartbeatTimeout: NodeJS.Timeout | null = null;

  protected cookieJar = new CookieJar();
  protected httpAgent: Agent;

  constructor(params: Partial<HttpSessionParams<P, S>>) {
    super();
    const normalizedParams = { ...DEFAULT_SESSION_PARAMS, params } as HttpSessionParams<P, S>;
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
    this.status = {
      name: normalizedParams.name,
      status: this.login === null ? 'Ready' : 'Logged Out',
      uptimeSince: null,
      lastError: null,
      error: null,
      inQueue: 0,
      isLoggedIn: false,
    } as const;
    this;
  }

  public setParams(params: Partial<P>) {
    this.params = merge(this.params, params);
  }
  public setDefaultHeaders(headers: HttpHeaders) {
    this.defaultHeaders = headers;
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

  protected serialize() {
    return {
      params: this.params as P,
      defaultHeaders: this.defaultHeaders,
      cookies: this.cookieJar.toJSON(),
    };
  }

  protected getSessionObject(): HttpSessionObject<P, S> {
    const wrap = <A extends any[], R>(
      fnName: string,
      fn: (...args: A) => R,
      releaseAfter?: boolean
    ): ((...args: A) => R) => {
      return (...args) => {
        if (sessionObject.wasReleased) {
          throw new Error(`calling ${fnName} failed because session has already been released`);
        } else if (this.status.status !== 'In Use') {
          throw new Error(`calling ${fnName} failed because session is in status ${this.status}`);
        }
        if (releaseAfter) sessionObject.wasReleased = true;
        return fn(...args);
      };
    };
    const sessionObject = {
      getParams: wrap('getParams', () => this.params as P),
      getState: wrap('getState', () => this.state as S),
      request: wrap('request', (options) => this.request(options)),
      release: wrap('release', () => this.releaseSession(), true),
      serialize: wrap('serialize', () => this.serialize()),
      invalidate: wrap('invalidate', (err) => this.invalidateSession(err), true),
      reportLockout: wrap('reportLockout', () => this.reportLockout(), true),
      wasReleased: false,
    };
    return sessionObject;
  }

  private async waitForLockout() {
    if (this.status.status !== 'Locked Out' || this.status.lastError === null) return;
    const waitFor = this.status.lastError + this.lockoutTimeMs - Date.now();
    if (waitFor <= 0) return;
    await new Promise<void>((resolve) => this.setTimeout(resolve, waitFor, true));
    if ((this.status.status as 'Locked Out' | 'Shutdown') === 'Shutdown') throw 'Session has shutdown';
  }

  private loginWrapper(): Promise<void> {
    if (!this.loginPromise) {
      this.loginPromise = new Promise<void>(async (resolve, reject) => {
        if (this.status.isLoggedIn) return resolve();
        try {
          await this.waitForLockout();
          if (this.login) {
            this.changeStatus({ status: 'Logging In' });
            await this.login({ ...this.params, ...this.credentials } as P & CredentialsData);
          }
          this.changeStatus({ isLoggedIn: true, error: null, lastError: null });
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

  private logoutWrapper(): Promise<void> {
    if (!this.logoutPromise) {
      this.logoutPromise = new Promise<void>(async (resolve) => {
        this.stopHeartbeat();
        if (!this.logout) {
          this.changeStatus({ status: 'Logged Out', uptimeSince: null, isLoggedIn: false });
          return resolve();
        }
        try {
          this.changeStatus({ status: 'Logging Out' });
          await this.logout(this.params as P, this.state as S);
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

  private stopHeartbeat() {
    if (this.heartbeatTimeout) clearTimeout(this.heartbeatTimeout);
  }

  private heartbeat() {
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

  public async requestSession(timeout = 30000): Promise<HttpSessionObject<P, S>> {
    const inQueue = this.status.inQueue + 1;
    this.changeStatus({ inQueue });
    if (this.allowMultipleRequests) {
      await this.loginWrapper();
      this.loginPromise = null;
      this.changeStatus({ status: 'In Use' });
      return this.getSessionObject();
    }
    return new Promise<HttpSessionObject<P, S>>(async (resolve, reject) => {
      let settled = false;
      const cancelTimeout = this.setTimeout(
        () => onSettle(`Timed out waiting for session after ${timeout}ms`),
        timeout
      );
      function onSettle(err: unknown, val?: HttpSessionObject<P, S>) {
        if (settled) return;
        settled = true;
        cancelTimeout();
        if (err) reject(err);
        else resolve(val as HttpSessionObject<P, S>);
      }
      this.requestQueue.push({
        resolve: (val) => onSettle(null, val),
        reject: onSettle,
      });
      this.next();
    });
  }

  protected async next() {
    if (this.status.status === 'In Use') return;

    // if (this.allowMultipleRequests) {
    //   if (this.status.status !== 'Locked Out') {
    // if (!this.status.isLoggedIn) {
    // }
    // await this.loginWrapper();
    // this.loginPromise = null;
    // const nextRequest = this.requestQueue.shift();
  }

  protected async releaseSession() {
    this.lastUrl = undefined;
    const inQueue = this.status.inQueue - 1;
    if (this.allowMultipleRequests) {
      if (this.status.status !== 'Locked Out') {
        this.changeStatus({ status: inQueue === 0 ? 'Ready' : 'In Use', inQueue });
      }
      return;
    }
    if (this.alwaysRenew && this.status.status !== 'Locked Out' && this.status.status !== 'Error') {
      this.loginPromise = null;
      await this.logoutWrapper();
      this.logoutPromise = null;
    }
    this.requestQueue.shift();
    const nextRequest = this.requestQueue.shift();
    if (nextRequest) {
      if (this.alwaysRenew) {
        this.loginWrapper().then(
          () => {
            this.loginPromise = null;
            nextRequest.resolve(this.getSessionObject());
          },
          (err) => {
            this.loginPromise = null;
            nextRequest.reject(err);
          }
        );
      } else {
        nextRequest.resolve(this.getSessionObject());
      }
    } else if (!this.alwaysRenew && this.status.status !== 'Locked Out' && this.status.status !== 'Error') {
      this.changeStatus({ status: 'Ready' });
    }
  }

  protected async reportLockout() {
    this.changeStatus({ status: 'Locked Out', lastError: Date.now(), isLoggedIn: false });
  }
}
