import { HttpSession } from '../src';
import { Readable, Writable } from 'node:stream';

const mockHttpRequest = function (_url, options, callback) {
  const requestStream = new Writable({
    write(_ch, _enc, cb) {
      cb();
    },
  });
  const responseStream = Object.assign(
    new Readable({
      read() {
        this.push(null);
      },
    }),
    { statusCode: 200, statusMessage: '', headers: options.headers }
  );
  setTimeout(() => callback(responseStream), 1);
  return requestStream;
};

function waitFor(n: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, n));
}

class TestHttpSession extends HttpSession<{ str: string; num: number }> {
  public loginCalledWithParams: any;
  public logoutCalledWithParams: any;
  public validateCalledWithParams: any;
  protected async login(params: Required<{ str: string; num: number }>): Promise<void> {
    await waitFor(30);
    this.loginCalledWithParams = params;
  }
  protected async logout(params: Required<{ str: string; num: number }>): Promise<void> {
    await waitFor(30);
    this.logoutCalledWithParams = params;
  }
  protected validateParams(params: { str: string; num: number }) {
    this.validateCalledWithParams = params;
  }
  protected allowMultipleRequests = true;
  protected _makeHttpRequest? = mockHttpRequest;
}

const urlHttpRequestFactory = (urls: string[]) => {
  function httpRequest(url, _options, callback) {
    const requestStream = new Writable({
      write(_ch, _enc, cb) {
        cb();
      },
    });
    const responseStream = Object.assign(
      new Readable({
        read() {
          this.push(null);
        },
      }),
      { statusCode: 200, statusMessage: '', headers: {} }
    );
    urls.push('' + url);
    setTimeout(() => callback(responseStream), 10);
    return requestStream;
  }
  return httpRequest;
};

class EmptySession extends HttpSession {}

describe('HttpSession', () => {
  it('validates, logs in and out', async () => {
    const suppliedParams = { str: 'abc', num: 123 };
    const testSession = new TestHttpSession();
    const statuses: string[] = [];
    testSession.setParams(suppliedParams);
    const removeStatusChangeListener = testSession.onStatusChange((data) => statuses.push(data.status));
    const session = await testSession.requestSession();
    await session.request({ url: 'https://example.com' });
    const sessionData = session.serialize();
    await session.release();
    removeStatusChangeListener();
    expect(sessionData).toEqual({ params: { str: 'abc', num: 123 }, defaultHeaders: {}, cookies: [] });
    expect(statuses).toEqual(['Logging In', 'In Use', 'Ready']);
    expect(testSession.validateCalledWithParams).toEqual(suppliedParams);
    expect(testSession.loginCalledWithParams).toEqual(suppliedParams);
    await testSession.forceStop();
    expect(testSession.logoutCalledWithParams).toEqual(suppliedParams);
  });
  it('allow multiple requests when specified', async () => {
    const testSession = new TestHttpSession();
    let mostRecentCount = 0;
    const removeStatusChangeListener = testSession.onStatusChange((data) => (mostRecentCount = data.inQueue));
    expect(mostRecentCount).toBe(0);
    const session = await testSession.requestSession();
    expect(mostRecentCount).toBe(1);
    const session2 = await testSession.requestSession();
    expect(mostRecentCount).toBe(2);
    session.release();
    expect(mostRecentCount).toBe(1);
    session2.release();
    expect(mostRecentCount).toBe(0);
    removeStatusChangeListener();
  });
  it('merges default and request headers', async () => {
    const testSession = new TestHttpSession();
    const defaultHeaders = {
      auth: 'bob:123',
      csrf: 'zzz',
    };
    const requestHeaders = {
      a: 'b',
      c: 'd',
    };
    testSession.setDefaultHeaders(defaultHeaders);

    const session = await testSession.requestSession();
    const response = await session.request({ url: 'https://example.com', headers: requestHeaders });
    expect(response.headers).toEqual({ ...defaultHeaders, ...requestHeaders });
  });
  it('throw when calling request or serialize after release but when calling getParams', async () => {
    const testSession = new TestHttpSession();
    const session = await testSession.requestSession();
    await session.release();
    let errorRequest: any = null;
    let errorSerialize: any = null;
    try {
      await session.request({ url: 'https://example.com' });
    } catch (err) {
      errorRequest = err;
    }
    try {
      session.serialize();
    } catch (err) {
      errorSerialize = err;
    }
    expect(session.getParams()).toEqual({});
    expect(errorRequest).not.toBeNull();
    expect(errorSerialize).not.toBeNull();
  });
  it('calls the heartbeat url when specified', async () => {
    class HeartbeatSession extends HttpSession {
      public urls: string[] = [];
      protected heartbeatInterval = 20;
      protected heartbeatURL = 'https://heartbeat.url';
      protected _makeHttpRequest? = urlHttpRequestFactory(this.urls);
    }
    const heartbeatSession = new HeartbeatSession();
    expect(heartbeatSession.urls).toHaveLength(0);
    const session = await heartbeatSession.requestSession();
    await session.request({ url: 'https://example.com' });
    expect(heartbeatSession.urls).toHaveLength(1);
    await session.release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    let urlsLength = heartbeatSession.urls.length;
    expect(urlsLength).toBeGreaterThan(1);
    await heartbeatSession.forceStop();
    urlsLength = heartbeatSession.urls.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(heartbeatSession.urls).toHaveLength(urlsLength);
  });
  it('logs out after release every time when specified', async () => {
    class AlwaysRenewSession extends HttpSession {
      protected async login(): Promise<void> {
        await waitFor(30);
      }
      protected async logout(): Promise<void> {
        await waitFor(30);
      }
      protected alwaysRenew = true;
    }
    const statuses: string[] = [];
    const testSession = new AlwaysRenewSession();
    const removeStatusChangeListener = testSession.onStatusChange((data) => {
      if (data.status !== statuses[statuses.length - 1]) {
        statuses.push(data.status);
      }
    });
    const session = await testSession.requestSession();
    const session2Promise = testSession.requestSession();
    await session.release();
    const session2 = await session2Promise;
    await session2.release();
    removeStatusChangeListener();
    await testSession.forceStop();
    expect(statuses).toEqual([
      'Logging In',
      'In Use',
      'Logging Out',
      'Logged Out',
      'Logging In',
      'In Use',
      'Logging Out',
      'Logged Out',
    ]);
  });
  it('handles login error gracefully', async () => {
    class LoginErrorSession extends HttpSession {
      private alreadyThrown = false;
      protected async login(): Promise<void> {
        if (this.alreadyThrown) {
          throw 'login_error';
        } else {
          this.alreadyThrown = true;
          throw Error('login_error');
        }
      }
    }
    const testSession = new LoginErrorSession();
    const listenerErrors: string[] = [];
    const removeStatusChangeListener = testSession.onStatusChange(({ status, error }) => {
      if (status === 'Error') listenerErrors.push(error);
    });
    let loginError: any = null;
    try {
      const session = await testSession.requestSession();
      await session.release();
    } catch (err) {
      loginError = err;
    }
    expect(loginError).not.toBeNull();
    loginError = null;
    try {
      const session = await testSession.requestSession();
      await session.release();
    } catch (err) {
      loginError = err;
    }
    await testSession.forceStop();
    removeStatusChangeListener();
    expect(listenerErrors[0]).toMatch('login_error');
    expect(listenerErrors[1]).toMatch('Unknown');
    expect(loginError).not.toBeNull();
  });
  it('handles login error when in queue and session has no logout specified', async () => {
    class LoginErrorSession extends HttpSession {
      private loggedInOnce = false;
      protected async login(): Promise<void> {
        await waitFor(30);
        if (this.loggedInOnce) {
          throw new Error('login_error');
        }
        this.loggedInOnce = true;
      }
      protected alwaysRenew = true;
    }
    const testSession = new LoginErrorSession();
    let listenerError: any;
    const removeStatusChangeListener = testSession.onStatusChange((data) => {
      if (data.status === 'Error') listenerError = data.error;
    });
    let loginError: any = null;
    const session1 = await testSession.requestSession();
    const session2Promise = testSession.requestSession().then(
      () => undefined,
      (err) => {
        loginError = err;
      }
    );
    await session1.release();
    await testSession.forceStop();
    try {
      await session2Promise;
    } catch {}
    removeStatusChangeListener();
    expect(listenerError).toMatch('login_error');
    expect(loginError).not.toBeNull();
  });
  it('handles logout error gracefully', async () => {
    class LogoutErrorSession extends HttpSession {
      private alreadyThrown = false;
      protected async login(): Promise<void> {
        await waitFor(30);
      }
      protected async logout(): Promise<void> {
        await waitFor(30);
        if (this.alreadyThrown) {
          throw 'logout_error';
        } else {
          this.alreadyThrown = true;
          throw Error('logout_error');
        }
      }
      protected alwaysRenew = true;
    }
    const testSession = new LogoutErrorSession();
    const listenerErrors: string[] = [];
    const removeStatusChangeListener = testSession.onStatusChange(({ status, error }) => {
      if (status === 'Error') listenerErrors.push(error);
    });
    const session = await testSession.requestSession();
    await session.release();
    const session2 = await testSession.requestSession();
    await session2.release();
    await testSession.forceStop();
    removeStatusChangeListener();
    expect(listenerErrors[0]).toMatch('logout_error');
    expect(listenerErrors[1]).toMatch('Unknown');
  });
  it('queues up session requests', async () => {
    const testSession = new EmptySession();
    const session1 = await testSession.requestSession();
    const session2Promise = testSession.requestSession();
    await session1.release();
    await testSession.forceStop();
    const session2 = await session2Promise;
    expect(typeof session2.release).toBe('function');
  });
  it('waiting session requests will reject if there is an error in the current one', async () => {
    const testSession = new EmptySession();
    const rejectionError = await new Promise(async (resolve) => {
      const session = await testSession.requestSession();
      testSession.requestSession().then(() => undefined, resolve);
      await session.release('error');
    });
    expect(rejectionError).not.toBeNull();
  });
  it('waiting session requests will reject when session is forced to stop and current one will reject on request and serialize', async () => {
    const testSession = new EmptySession();
    const session = await testSession.requestSession();
    const waitRejectionError = await new Promise(async (resolve) => {
      testSession.requestSession().then(() => undefined, resolve);
      await testSession.forceStop();
    });
    expect(waitRejectionError).not.toBeNull();
    let requestError: any = null;
    let serializeError: any = null;
    try {
      await session.request({ url: 'https://example.com' });
    } catch (err) {
      requestError = err;
    }
    try {
      session.serialize();
    } catch (err) {
      serializeError = err;
    }
    expect(requestError).not.toBeNull();
    expect(serializeError).not.toBeNull();
  });
  it('waiting session request will reject when timeout is exceeded', async () => {
    const testSession = new EmptySession();
    await testSession.requestSession();
    const waitRejectionError = await new Promise(async (resolve) => {
      testSession.requestSession(20).then(() => undefined, resolve);
    });
    expect(waitRejectionError).not.toBeNull();
  });
  it('if waitAfterError is specified session will wait before logging in again after an error', async () => {
    class WaitAfterErrorSession extends HttpSession {
      protected async login(): Promise<void> {
        await waitFor(30);
      }
      protected async logout(): Promise<void> {
        await waitFor(30);
      }
      protected waitAfterError = 100;
    }
    const testSession = new WaitAfterErrorSession();
    let session = await testSession.requestSession();
    await session.release('error');
    const start = Date.now();
    session = await testSession.requestSession();
    expect(Date.now() - start).toBeGreaterThanOrEqual(100);
    await session.release();
    testSession.forceStop();
  });
});

/*
- setDefaultHeaders
- request after release
*** serialize; add a method for importing serialized data ***
- error on initialise
- heartbeat
- headers with default headers
- cookies without cookiejar
- allowmultiplerequests
- requestsession timeout
- releasesession with an error
- multiple requestsession
- alwaysrenew

*/
