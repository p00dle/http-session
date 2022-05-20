import type {
  HttpRequestDataType,
  HttpRequestOptions,
  HttpRequestResponse,
  HttpResponseType,
  MakeHttpRequest,
} from './http-request';

import { httpRequest } from './http-request';
import { Agent } from 'https';
import { CookieJar } from './cookie';
import { errorToLog, Logger, noOpLogger } from './logger';
import { HttpHeaders } from './types';

interface HttpSessionObject<P extends Record<string, unknown> = { username: string; password: string }> {
  getParams: HttpSession<P>['getParams'];
  request: HttpSession<P>['request'];
  release: HttpSession<P>['releaseSession'];
  serialize: HttpSession<P>['serialize'];
}

interface HttpSessionStatusData {
  status: HttpSession['status'];
  uptimeSince: number | null;
  lastError: number | null;
  error: string | null;
  inQueue: number;
  isInitialised: boolean;
}

export abstract class HttpSession<P extends Record<string, unknown> = { username: string; password: string }> {
  protected validateParams?(params: P): any;
  protected login?(params: P): Promise<void>;
  protected logout?(params: P): Promise<void>;
  protected _makeHttpRequest?: MakeHttpRequest;
  protected alwaysRenew?: boolean;
  protected waitAfterError?: number;
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
  private status: 'Logged Out' | 'Logging In' | 'Ready' | 'In Use' | 'Logging Out' | 'Error' =
    this.login || this.validateParams ? 'Logged Out' : 'Ready';
  private statusChangeListeners: ((data: HttpSessionStatusData) => void)[] = [];
  public onStatusChange(listener: (data: HttpSessionStatusData) => void): () => void {
    this.statusChangeListeners.push(listener);
    return () => {
      const index = this.statusChangeListeners.indexOf(listener);
      if (index >= 0) {
        this.statusChangeListeners.splice(index, 1);
      }
    };
  }
  private serialize() {
    return {
      params: this.getParams(),
      defaultHeaders: this.defaultHeaders,
      cookies: this.cookieJar.toJSON(),
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
    this.statusChangeListeners.forEach((listener) => {
      listener({
        status: this.status,
        uptimeSince: this.uptimeSince,
        lastError: this.lastError,
        inQueue: this.requestCount,
        error: this.error,
        isInitialised: this.isInitialised,
      });
    });
  }
  public async forceStop() {
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
    this.changeStatus({ status: 'Logged Out', error: undefined, uptimeSince: null, lastError: null });
  }
  public setParams(params: Partial<P>) {
    this.params = { ...this.params, ...params };
  }
  public setDefaultHeaders(headers: HttpHeaders) {
    this.defaultHeaders = headers;
  }
  private getSessionObject(): HttpSessionObject<P> {
    let sessionReleased = false;
    return {
      getParams: () => this.getParams(),
      request: async <T extends HttpRequestDataType, R extends HttpResponseType>(
        options: HttpRequestOptions<T, R>
      ): Promise<HttpRequestResponse<R>> => {
        if (sessionReleased) {
          throw new Error('Request after session was released is not allowed');
        } else if (this.status === 'Logged Out') {
          throw new Error('Session forced to stop');
        } else {
          return this.request(options);
        }
      },
      release: (errorMessage?: string) => {
        sessionReleased = true;
        return this.releaseSession(errorMessage);
      },
      serialize: () => {
        if (sessionReleased) {
          throw new Error('Serialize after session was released is not allowed');
        } else if (this.status === 'Logged Out') {
          throw new Error('Session forced to stop');
        } else {
          return this.serialize();
        }
      },
    };
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
              if (this.waitAfterError) {
                const waitFor = this.lastError ? this.lastError + this.waitAfterError - Date.now() : 0;
                if (waitFor > 0) {
                  await new Promise((resolve) => setTimeout(resolve, waitFor));
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
  private async request<T extends HttpRequestDataType, R extends HttpResponseType>(
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
      const timeoutHandle = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(`Timed out waiting for session after ${timeout}ms`);
        }
      }, timeout);
      this.requestQueue.push({
        resolve: (val) => {
          if (!settled) {
            this.changeStatus({ status: 'In Use' });
            settled = true;
            clearTimeout(timeoutHandle);
            resolve(val);
          }
        },
        reject: (err) => {
          if (!settled) {
            settled = true;
            clearTimeout(timeoutHandle);
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
          clearTimeout(timeoutHandle);
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
  private async releaseSession(errorMessage?: string) {
    this.lastUrl = undefined;
    this.requestCount--;
    if (errorMessage) {
      this.lastError = Date.now();
      this.requestQueue.forEach(({ reject }) => reject(`Error in session`));
      this.requestQueue = [];
      this.changeStatus({ status: 'Error', error: errorMessage, lastError: Date.now() });
      this.isInitialised = false;
    } else if (this.allowMultipleRequests) {
      this.changeStatus({ status: this.requestCount === 0 ? 'Ready' : 'In Use' });
    } else if (!this.allowMultipleRequests) {
      if (this.alwaysRenew) {
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
      } else if (!this.alwaysRenew) {
        this.changeStatus({ status: 'Ready' });
      }
    }
  }
  protected logger: Logger = noOpLogger;
  protected cookieJar = new CookieJar();
  protected httpAgent = new Agent();
}
