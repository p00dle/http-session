import type {
  HttpRequestDataType,
  HttpRequestOptions,
  HttpRequestResponse,
  HttpResponseType,
  MakeHttpRequest,
  HttpHeaders,
} from './types/http-request';
import type { Logger } from './types/logger';
import type { Cookie } from './types/cookies';
import { httpRequest } from './http-request';
import { Agent } from 'https';
import { CookieJar } from './cookies/jar';
import { errorToLog, noOpLogger } from './logger';

type CancelTimeout = () => any;

export interface HttpSessionObject<P> {
  getParams: () => P;
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

export interface HttpSessionStatusData {
  status: HttpSession['status'];
  uptimeSince: number | null;
  lastError: number | null;
  error: string | null;
  inQueue: number;
  isInitialised: boolean;
}

export abstract class HttpSession<P = { username: string; password: string }> {
  protected validateParams?(params: P): any;
  protected login?(params: P): Promise<void>;
  protected logout?(params: P): Promise<void>;
  public _makeHttpRequest?: MakeHttpRequest;
  protected alwaysRenew?: boolean;
  protected lockoutTime?: number;
  protected heartbeatURL?: string;
  protected heartbeatInterval?: number;
  protected params: Partial<P> = {};
  protected defaultHeaders: HttpHeaders = {};
  protected httpRequest = httpRequest;
  protected allowMultipleRequests = false;
  protected isInitialised = false;
  protected lastUrl: URL | undefined = undefined;
  private uptimeSince: number | null = null;
  private error: string | null = null;
  private lastError: number | null = null;
  private requestCount = 0;
  private requestQueue: { resolve: (val: HttpSessionObject<P>) => any; reject: (err: unknown) => any }[] = [];
  private loginPromise: Promise<any> | null = null;
  private logoutPromise: Promise<any> | null = null;
  private status:
    | 'Logged Out'
    | 'Logging In'
    | 'Ready'
    | 'In Use'
    | 'Logging Out'
    | 'Error'
    | 'Locked Out'
    | 'Shutdown' = this.login || this.validateParams ? 'Logged Out' : 'Ready';
  private statusChangeListeners: ((data: HttpSessionStatusData) => void)[] = [];
  public onStatusChange(listener: (data: HttpSessionStatusData) => void): () => void {
    this.statusChangeListeners.push(listener);
    listener(this.makeStatus());
    return () => {
      const index = this.statusChangeListeners.indexOf(listener);
      if (index >= 0) {
        this.statusChangeListeners.splice(index, 1);
      }
    };
  }
  private timeouts: { handle: NodeJS.Timeout; cb: () => any; callOnShutdown: boolean }[] = [];
  private setTimeout(cb: () => any, ms: number, callOnShutdown = false): CancelTimeout {
    const handle = setTimeout(cb, ms);
    const timeoutCallback = { handle, cb, callOnShutdown };
    this.timeouts.push(timeoutCallback);
    return (callback?: boolean) => {
      const index = this.timeouts.indexOf(timeoutCallback);
      if (index >= 0) this.timeouts.splice(index, 1);
      clearTimeout(handle);
      if (callback) cb();
    };
  }
  private serialize() {
    return {
      params: this.getParams(),
      defaultHeaders: this.defaultHeaders,
      cookies: this.cookieJar.toJSON(),
    };
  }
  private makeStatus(): HttpSessionStatusData {
    return {
      status: this.status,
      uptimeSince: this.uptimeSince,
      lastError: this.lastError,
      inQueue: this.requestCount,
      error: this.error,
      isInitialised: this.isInitialised,
    };
  }

  private getParams() {
    return this.params as Required<P>;
  }

  private changeStatus(params: {
    status?: HttpSession['status'];
    uptimeSince?: number | null;
    lastError?: number | null;
    error?: string;
  }) {
    if (params.status !== undefined) this.status = params.status;
    if (params.uptimeSince !== undefined) this.uptimeSince = params.uptimeSince;
    if (params.lastError !== undefined) this.lastError = params.lastError;
    if (params.error !== undefined) this.error = params.error;
    const status = this.makeStatus();
    this.statusChangeListeners.forEach((fn) => fn(status));
  }

  public async shutdown() {
    this.stopHeartbeat();
    this.lastUrl = undefined;
    if (this.status !== 'Error') {
      this.requestQueue.forEach(({ reject }) => reject('Session forced to stop'));
      this.requestQueue = [];
      if (this.status !== 'Logged Out') {
        await this.logoutWrapper();
        this.logoutPromise = null;
      }
    }
    this.isInitialised = false;
    this.changeStatus({ status: 'Shutdown', error: undefined, uptimeSince: null, lastError: null });
    this.timeouts.forEach(({ handle, cb, callOnShutdown }) => {
      clearTimeout(handle);
      if (callOnShutdown) cb();
    });
  }
  public setParams(params: Partial<P>) {
    this.params = { ...this.params, ...params };
  }
  public setDefaultHeaders(headers: HttpHeaders) {
    this.defaultHeaders = headers;
  }
  private getSessionObject(): HttpSessionObject<P> {
    const wrap = <A extends any[], R>(
      fnName: string,
      fn: (...args: A) => R,
      releaseAfter?: boolean
    ): ((...args: A) => R) => {
      return (...args) => {
        if (sessionObject.wasReleased) {
          throw new Error(`calling ${fnName} failed because session has already been released`);
        } else if (this.status !== 'In Use') {
          throw new Error(`calling ${fnName} failed because session is in status ${this.status}`);
        }
        if (releaseAfter) sessionObject.wasReleased = true;
        return fn(...args);
      };
    };
    const sessionObject = {
      getParams: wrap('getParams', () => this.getParams()),
      request: wrap('request', (options) => this.request(options)),
      release: wrap('release', () => this.releaseSession(), true),
      serialize: wrap('serialize', () => this.serialize()),
      invalidate: wrap('invalidate', (err) => this.invalidateSession(err), true),
      reportLockout: wrap('reportLockout', () => this.reportLockout(), true),
      wasReleased: false,
    };
    return sessionObject;
  }
  private logoutWrapper(): Promise<void> {
    if (!this.logoutPromise) {
      this.logoutPromise = new Promise<void>(async (resolve) => {
        this.stopHeartbeat();
        if (this.logout) {
          try {
            // if (this.loginPromise) {
            //   await this.loginPromise;
            // }
            this.changeStatus({ status: 'Logging Out' });
            await this.logout(this.params as P);
            this.stopHeartbeat();
            this.changeStatus({ status: 'Logged Out', uptimeSince: null, lastError: null, error: undefined });
            this.isInitialised = false;
            resolve();
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : 'Unknown';
            this.changeStatus({
              status: 'Error',
              error: `Error logging out: ${errorMessage}`,
              lastError: Date.now(),
            });
            this.isInitialised = false;
            resolve();
          }
        } else {
          this.changeStatus({ status: 'Logged Out', uptimeSince: null, lastError: null, error: undefined });
          this.isInitialised = false;
          resolve();
        }
      });
    }
    return this.logoutPromise;
  }
  private loginWrapper(): Promise<void> {
    if (!this.loginPromise) {
      this.loginPromise = this.isInitialised
        ? Promise.resolve()
        : new Promise<void>(async (resolve, reject) => {
            try {
              if (this.status === 'Locked Out' && this.lockoutTime && this.lastError) {
                const waitFor = this.lastError + this.lockoutTime - Date.now();
                if (waitFor > 0) {
                  await new Promise<void>((resolve) => this.setTimeout(resolve, waitFor, true));
                  if ((this.status as 'Locked Out' | 'Shutdown') === 'Shutdown') reject('Session has shutdown');
                }
              }
              // if (this.logoutPromise) {
              //   await this.logoutPromise;
              //   this.logoutPromise = null;
              // }

              if (this.validateParams) this.validateParams(this.params as P);
              if (this.login) {
                this.changeStatus({ status: 'Logging In' });
                await this.login(this.params as P);
              }
              this.isInitialised = true;
              this.heartbeat();
              this.loginPromise = null;
              resolve();
            } catch (err) {
              this.isInitialised = false;
              const errorMessage = err instanceof Error ? err.message : 'Unknown';
              this.changeStatus({
                status: 'Error',
                error: `Error logging in: ${errorMessage}`,
                lastError: Date.now(),
              });
              this.stopHeartbeat();
              this.loginPromise = null;
              reject(err);
            }
          });
    }
    return this.loginPromise;
  }
  private heartbeatTimeout: NodeJS.Timeout | null = null;
  private stopHeartbeat() {
    if (this.heartbeatTimeout) clearTimeout(this.heartbeatTimeout);
  }
  private heartbeat() {
    if (this.heartbeatURL && this.heartbeatInterval) {
      if (this.heartbeatTimeout) clearTimeout(this.heartbeatTimeout);
      if (this.status === 'In Use' || this.status === 'Ready') {
        this.heartbeatTimeout = setTimeout(async () => {
          await this.request({ url: this.heartbeatURL as string });
          if (this.status === 'In Use' || this.status === 'Ready') {
            this.heartbeat();
          }
        }, this.heartbeatInterval);
      }
    }
  }
  protected async request<T extends HttpRequestDataType, R extends HttpResponseType>(
    options: HttpRequestOptions<T, R>
  ): Promise<HttpRequestResponse<R>> {
    const { agent, cookieJar, headers, logger, previousUrl, ...otherOptions } = options;
    this.stopHeartbeat();
    const response = await this.httpRequest({
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
  public async requestSession(timeout = 30000): Promise<HttpSessionObject<P>> {
    this.requestCount++;
    if (this.allowMultipleRequests) {
      await this.loginWrapper();
      this.loginPromise = null;
      this.changeStatus({ status: 'In Use' });
      return this.getSessionObject();
    }
    return new Promise<HttpSessionObject<P>>(async (resolve, reject) => {
      let settled = false;
      const cancelTimeout = this.setTimeout(
        () => {
          if (!settled) {
            settled = true;
            reject(`Timed out waiting for session after ${timeout}ms`);
          }
        },
        timeout,
        true
      );
      this.requestQueue.push({
        resolve: (val) => {
          if (!settled) {
            this.changeStatus({ status: 'In Use' });
            settled = true;
            cancelTimeout();
            resolve(val);
          }
        },
        reject: (err) => {
          if (!settled) {
            settled = true;
            cancelTimeout();
            reject(err);
          }
        },
      });
      try {
        await this.loginWrapper();
        this.loginPromise = null;
      } catch (err) {
        if (!settled) {
          settled = true;
          cancelTimeout();
          this.logger.error(errorToLog(err));
          reject(`Error initialising session; see logs for details`);
        }
      }
      if (this.requestQueue.length === 1) {
        this.requestQueue[0].resolve(this.getSessionObject());
      } else {
        this.changeStatus({});
      }
    });
  }
  public async invalidateSession(errorMessage: string) {
    this.changeStatus({ status: 'Error', error: errorMessage, lastError: Date.now() });
    this.isInitialised = false;
  }
  private async reportLockout() {
    this.changeStatus({ status: 'Locked Out', lastError: Date.now() });
    this.isInitialised = false;
  }
  private async releaseSession() {
    this.lastUrl = undefined;
    this.requestCount--;
    if (this.allowMultipleRequests) {
      if (this.status !== 'Locked Out') {
        this.changeStatus({ status: this.requestCount === 0 ? 'Ready' : 'In Use' });
      }
    } else {
      if (this.alwaysRenew && this.status !== 'Locked Out' && this.status !== 'Error') {
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
      } else if (!this.alwaysRenew && this.status !== 'Locked Out' && this.status !== 'Error') {
        this.changeStatus({ status: 'Ready' });
      }
    }
  }
  public logger: Logger = noOpLogger;
  protected cookieJar = new CookieJar();
  protected httpAgent = new Agent();
}
