import { HttpSession, HttpSessionOptions } from '../src';
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

const testHttpSessionFactory = (): [{ login: any; logout: any; creds: any }, HttpSessionOptions<any, any, any>] => {
  const calls = {
    login: null,
    logout: null,
    creds: null,
  };
  const session: HttpSessionOptions<any, any, any> = {
    async login(session, state) {
      await waitFor(30);
      calls.creds = session.getCredentials();
      calls.login = state;
    },
    async logout(_, params) {
      await waitFor(30);
      calls.logout = params;
    },
    allowMultipleRequests: true,
    lockoutTimeMs: 100,
    _makeHttpRequest: mockHttpRequest,
    _makeHttpsRequest: mockHttpRequest,
  };
  return [calls, session];
};

const [, testSessionOptions] = testHttpSessionFactory();

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

describe('HttpSession', () => {
  it('logs in and out', async () => {
    const suppliedParams = { str: 'abc', num: 123 };
    const suppliedCreds = { username: 'user1', password: 'hunter2' };
    const [calls, sessionOptions] = testHttpSessionFactory();
    const testSession = new HttpSession(sessionOptions);
    const statuses: string[] = [];
    testSession.setState(suppliedParams);
    testSession.setCredentials(suppliedCreds);
    testSession.onStatus((data) => {
      if (statuses[statuses.length - 1] !== data.status) statuses.push(data.status);
    });
    const session = await testSession.requestSession();
    await session.request({ url: 'https://example.com' });
    const sessionData = session.serialize();
    const sessionParams = session.getState();
    await session.release();
    expect(sessionData).toEqual({ state: { str: 'abc', num: 123 }, defaultHeaders: {}, cookies: [] });
    expect(sessionParams).toEqual({ str: 'abc', num: 123 });
    expect(statuses).toEqual(['Logged Out', 'Logging In', 'Ready', 'In Use', 'Ready']);
    expect(calls.login).toEqual(suppliedParams);
    expect(calls.creds).toEqual(suppliedCreds);
    await testSession.shutdown();
    expect(calls.logout).toEqual(suppliedParams);
    expect(statuses).toEqual(['Logged Out', 'Logging In', 'Ready', 'In Use', 'Ready', 'Logging Out', 'Logged Out']);
  });
  it('allow multiple requests when specified', async () => {
    const testSession = new HttpSession(testSessionOptions);
    let mostRecentCount = 0;
    testSession.onStatus((data) => (mostRecentCount = data.inQueue));
    expect(mostRecentCount).toBe(0);
    const session = await testSession.requestSession();
    expect(mostRecentCount).toBe(1);
    const session2 = await testSession.requestSession();
    expect(mostRecentCount).toBe(2);
    session.release();
    expect(mostRecentCount).toBe(1);
    session2.release();
    expect(mostRecentCount).toBe(0);
  });
  it('merges default and request headers', async () => {
    const testSession = new HttpSession(testSessionOptions);
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
    expect(response.headers).toMatchObject({ ...defaultHeaders, ...requestHeaders });
  });
  it('throw when calling request or serialize after release but when calling getParams', async () => {
    const testSession = new HttpSession(testSessionOptions);
    const session = await testSession.requestSession();
    await session.release();
    let errorRequest: any = null;
    let errorSerialize: any = null;
    let errorGetParams: any = null;
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
    try {
      session.getState();
    } catch (err) {
      errorGetParams = err;
    }
    expect(errorGetParams).not.toBeNull();
    expect(errorRequest).not.toBeNull();
    expect(errorSerialize).not.toBeNull();
  });
  it('calls the heartbeat url when specified', async () => {
    const urls: string[] = [];
    const heartbeatSession = new HttpSession({
      heartbeatUrl: 'https://heartbeat.url',
      heartbeatIntervalMs: 20,
      _makeHttpsRequest: urlHttpRequestFactory(urls),
    });
    expect(urls).toHaveLength(0);
    const session = await heartbeatSession.requestSession();
    await session.request({ url: 'https://example.com' });
    expect(urls).toHaveLength(1);
    await session.release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    let urlsLength = urls.length;
    expect(urlsLength).toBeGreaterThan(1);
    await heartbeatSession.shutdown();
    urlsLength = urls.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(urls).toHaveLength(urlsLength);
  });
  it('logs out after release every time when specified', async () => {
    const testSession = new HttpSession({
      async login(): Promise<void> {
        await waitFor(30);
      },
      async logout(): Promise<void> {
        await waitFor(30);
      },
      alwaysRenew: true,
    });
    const statuses: string[] = [];
    testSession.onStatus((data) => {
      if (data.status !== statuses[statuses.length - 1]) {
        statuses.push(data.status);
      }
    });
    const session = await testSession.requestSession();
    const session2Promise = testSession.requestSession();
    await session.release();
    const session2 = await session2Promise;
    await session2.release();
    await testSession.shutdown();
    expect(statuses).toEqual([
      'Logged Out',
      'Logging In',
      'Ready',
      'In Use',
      'Logging Out',
      'Logged Out',
      'Logging In',
      'Ready',
      'In Use',
      'Logging Out',
      'Logged Out',
    ]);
  });
  it('handles login error gracefully', async () => {
    let alreadyThrown = false;

    const testSession = new HttpSession({
      async login(): Promise<void> {
        if (alreadyThrown) {
          throw 'login_error';
        } else {
          alreadyThrown = true;
          throw Error('login_error');
        }
      },
    });
    const listenerErrors: (string | null)[] = [];
    const inQueueCount: number[] = [];
    testSession.onStatus(({ status, error, inQueue }) => {
      if (status === 'Error') listenerErrors.push(error);
      if (inQueue !== inQueueCount[inQueueCount.length - 1]) inQueueCount.push(inQueue);
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
    await testSession.shutdown();
    expect(inQueueCount).toEqual([0, 1, 0, 1, 0]);
    expect(listenerErrors[0]).toMatch('login_error');
    expect(listenerErrors[1]).toMatch('login_error');
    expect(loginError).not.toBeNull();
  });
  it('login error rejects all requests in queue; consecutive requests will attempt to login again', async () => {
    let alreadyThrown = false;
    const testSession = new HttpSession({
      async login(): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, 30));
        if (!alreadyThrown) {
          alreadyThrown = true;
          throw 'login_error';
        }
      },
    });
    const inQueueCount: number[] = [];
    testSession.onStatus(({ inQueue }) => {
      if (inQueue !== inQueueCount[inQueueCount.length - 1]) inQueueCount.push(inQueue);
    });
    let loginError: any = null;
    try {
      await Promise.all([testSession.requestSession(), testSession.requestSession()]);
    } catch (err) {
      loginError = err;
    }
    expect(loginError).not.toBeNull();
    const session = await testSession.requestSession();
    expect(session.wasReleased).toBe(false);
    await session.release();
    expect(session.wasReleased).toBe(true);
    await testSession.shutdown();
    expect(inQueueCount).toEqual([0, 1, 2, 1, 0, 1, 0]);
  });
  it('handles login error when in queue and session has no logout specified', async () => {
    let loggedInOnce = false;
    const testSession = new HttpSession({
      async login() {
        await waitFor(30);
        if (loggedInOnce) {
          throw new Error('login_error');
        }
        loggedInOnce = true;
      },
      alwaysRenew: true,
    });
    let listenerError: any;
    testSession.onStatus((data) => {
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
    try {
      await session2Promise;
    } catch {}
    await testSession.shutdown();
    expect(listenerError).toMatch('login_error');
    expect(loginError).not.toBeNull();
  });
  it('handles logout error gracefully', async () => {
    let alreadyThrown = false;
    const testSession = new HttpSession({
      async login() {
        await waitFor(30);
      },
      async logout() {
        await waitFor(30);
        if (alreadyThrown) {
          throw 'logout_error';
        } else {
          alreadyThrown = true;
          throw Error('logout_error');
        }
      },
      alwaysRenew: true,
    });
    const listenerErrors: (string | null)[] = [];
    testSession.onStatus(({ status, error }) => {
      if (status === 'Error') listenerErrors.push(error);
    });
    const inQueueCount: number[] = [];
    testSession.onStatus(({ inQueue }) => {
      if (inQueue !== inQueueCount[inQueueCount.length - 1]) inQueueCount.push(inQueue);
    });
    const session = await testSession.requestSession();
    await session.release();
    const session2 = await testSession.requestSession();
    await session2.release();
    await testSession.shutdown();
    expect(listenerErrors[0]).toMatch('logout_error');
    expect(listenerErrors[1]).toMatch('logout_error');
    expect(inQueueCount).toEqual([0, 1, 0, 1, 0]);
  });
  it('queues up session requests', async () => {
    const testSession = new HttpSession();
    const session1 = await testSession.requestSession();
    const session2Promise = testSession.requestSession();
    await session1.release();
    const session2 = await session2Promise;
    expect(session2.wasReleased).toBe(false);
    await session2.release();
    expect(session2.wasReleased).toBe(true);
    await testSession.shutdown();
  });
  it('waiting session requests will reject when session is forced to stop and current one will reject on request and serialize', async () => {
    const testSession = new HttpSession();
    const session = await testSession.requestSession();
    const waitRejectionError = await new Promise(async (resolve) => {
      testSession.requestSession().then(() => undefined, resolve);
      await testSession.shutdown();
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
    const testSession = new HttpSession();
    await testSession.requestSession();
    const waitRejectionError = await new Promise(async (resolve) => {
      testSession.requestSession({ timeout: 20 }).then(() => undefined, resolve);
    });
    expect(waitRejectionError).not.toBeNull();
  });
  it('invalidate session will force the next request to login again', async () => {
    const [calls, testSessionOptions] = testHttpSessionFactory();
    const testSession = new HttpSession(testSessionOptions);
    testSession.setState({ str: 'abc' });
    const session = await testSession.requestSession();
    expect(calls.login).toMatchObject({ str: 'abc' });
    testSession.setState({ str: 'def' });
    await session.invalidate();
    await testSession.requestSession();
    expect(calls.login).toMatchObject({ str: 'def' });
    await testSession.shutdown();
  });
  it('reportLockout will force the next request to wait until lockout runs out', async () => {
    const [calls, testSessionOptions] = testHttpSessionFactory();
    const testSession = new HttpSession(testSessionOptions);
    testSession.setState({ str: 'abc' });
    const session = await testSession.requestSession();
    expect(calls.login).toMatchObject({ str: 'abc' });
    testSession.setState({ str: 'def' });
    const startTime = Date.now();
    await session.reportLockout();
    await testSession.requestSession();
    expect(Date.now() - startTime).toBeGreaterThanOrEqual(100);
    await testSession.shutdown();
  });
  it('correctly increments and decrements inQueue property when allowMultipleRequests is false', async () => {
    const testSession = new HttpSession({ ...testSessionOptions, allowMultipleRequests: false });
    const inQueueArr: number[] = [];
    testSession.onStatus((status) => {
      if (status.inQueue !== inQueueArr[inQueueArr.length - 1]) inQueueArr.push(status.inQueue);
    });
    expect(inQueueArr).toEqual([0]);
    const session1 = await testSession.requestSession();
    expect(inQueueArr).toEqual([0, 1]);
    const session2Promise = testSession.requestSession();
    expect(inQueueArr).toEqual([0, 1, 2]);
    await session1.release();
    expect(inQueueArr).toEqual([0, 1, 2, 1]);
    const session2 = await session2Promise;
    await session2.release();
    expect(inQueueArr).toEqual([0, 1, 2, 1, 0]);
    await testSession.shutdown();
  });
  it('correctly increments and decrements inQueue property when allowMultipleRequests is true', async () => {
    const testSession = new HttpSession({ ...testSessionOptions, allowMultipleRequests: true });
    const inQueueArr: number[] = [];
    testSession.onStatus((status) => {
      if (status.inQueue !== inQueueArr[inQueueArr.length - 1]) inQueueArr.push(status.inQueue);
    });
    expect(inQueueArr).toEqual([0]);
    const session1 = await testSession.requestSession();
    expect(inQueueArr).toEqual([0, 1]);
    const session2Promise = testSession.requestSession();
    expect(inQueueArr).toEqual([0, 1, 2]);
    await session1.release();
    expect(inQueueArr).toEqual([0, 1, 2, 1]);
    const session2 = await session2Promise;
    await session2.release();
    expect(inQueueArr).toEqual([0, 1, 2, 1, 0]);
    await testSession.shutdown();
  });
  it('uses enhanceLoginMethods to add additional props to LoginMethods', async () => {
    let resultOfEnhancedMethod: any = null;
    const testSession = new HttpSession({
      enhanceLoginMethods: async () => ({ getAdditionalNumber: () => 123 }),
      async login(methods) {
        resultOfEnhancedMethod = methods.getAdditionalNumber();
      },
    });
    const session = await testSession.requestSession();
    await session.release();
    await testSession.shutdown();
    expect(resultOfEnhancedMethod).toBe(123);
  });
  it('uses the same ref symbol for beforeRequest, onRelease, and enhanceLoginMethods', async () => {
    const originalRef = Symbol('original-ref');
    const orderOfCalls: string[] = [];
    let beforeRequestRef: any;
    let enhanceRef: any;
    let onReleaseRef: any;
    const testSession = new HttpSession({
      allowMultipleRequests: true,
      enhanceLoginMethods: async (ref) => {
        enhanceRef = ref;
        orderOfCalls.push('enhance');
        return {};
      },
      async login() {
        //
      },
    });
    const session = await testSession.requestSession({
      ref: originalRef,
      beforeRequest: (ref) => {
        beforeRequestRef = ref;
        orderOfCalls.push('before-request');
      },
      onRelease: (ref) => {
        onReleaseRef = ref;
        orderOfCalls.push('release');
      },
    });
    await session.release();
    await testSession.shutdown();
    expect(enhanceRef).toBe(originalRef);
    expect(beforeRequestRef).toBe(originalRef);
    expect(onReleaseRef).toBe(originalRef);
    expect(orderOfCalls).toEqual(['before-request', 'enhance', 'release']);
  });
  it('handles errors in request', async () => {
    const testSession = new HttpSession();
    const session = await testSession.requestSession();
    try {
      await session.request({ url: 'https://example.thisisnotavalidtopdomain' });
    } catch {}
    try {
      await session.request({ url: 'http://example.thisisnotavalidtopdomain' });
    } catch {}
    expect(true).toBe(true);
  });
  it('shutting down will reject all requests currently in queue', async () => {
    const testSession = new HttpSession({
      async login() {
        await new Promise((resolve) => setTimeout(resolve, 100));
      },
    });
    const promise1 = testSession.requestSession();
    const promise2 = testSession.requestSession();
    await testSession.shutdown();
    try {
      await Promise.all([promise1, promise2]);
    } catch (err) {
      expect(err).toMatch(/Timed out waiting for session/);
    }
  });
  it('invalidating session will make current request fail and force next one to login again', async () => {
    let loginCount = 0;
    const testSession = new HttpSession({
      async login() {
        await new Promise((resolve) => setTimeout(resolve, 100));
        loginCount++;
      },
    });
    const session = await testSession.requestSession();
    const promise1 = testSession.requestSession();
    await testSession.invalidateSession();
    try {
      session.request({ url: new URL('https://example.com') });
    } catch (err) {
      expect(err).toBeTruthy();
    }
    await promise1;
    await testSession.shutdown();
    expect(loginCount).toBe(2);
  });
});

/*
TODO: 
 - beforeRequest
 - setHeartbeatUrl
 - addCookies
 - removeCookies
 - call logoutWrapper when isLoggedIn is false
 - enhanceLogoutMethods
 - call next() when queue is empty
 - onRelase
 - setState
 - waitForLockout - finished waiting
 - shutdown while waiting for lockout
 
*/
