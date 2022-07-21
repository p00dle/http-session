import { TestServer } from '../src/lib/TestServer';
import { HttpSession } from '../src/http-session';
import { createGzip, createBrotliCompress, createDeflate } from 'node:zlib';
import * as net from 'node:net';
import { createReadableStream } from '../src/lib/createReadableStream';
import { makeCookie } from '../src/cookies/make';

describe('End to end', () => {
  const server = new TestServer({ port: 3000 });

  beforeAll(() => {
    return server.start();
  });

  test('Cookies are extracted from headers and sent on subsequent requests', async () => {
    const session = new HttpSession({
      async login(session) {
        session.addCookies([makeCookie({ key: 'a', value: 'b', domain: 'localhost' })]);
      },
    });
    const { request } = await session.requestSession();
    let cookieHeader = '';
    const unsubscribes = [
      server.on('GET', '/set-cookie', (_req, res) => {
        res.setHeader('set-cookie', ['foo=bar', 'boo=baz']);
        res.end('OK');
      }),
      server.on('GET', '/get-cookie', (req, res) => {
        cookieHeader = req.headers.cookie || '';
        res.end('OK');
      }),
    ];
    await request({ url: 'http://localhost:3000/set-cookie' });
    await request({ url: 'http://localhost:3000/get-cookie' });
    for (const unsubscribe of unsubscribes) unsubscribe();
    await session.shutdown();
    expect(cookieHeader).toBe('a=b; foo=bar; boo=baz');
  });

  test('Connection keep-alive header should be set when keepConnectionAlive is true', async () => {
    const session = new HttpSession();
    const { request } = await session.requestSession();
    let connectionHeader: string | undefined = '';
    const unsubscribe = server.on('GET', '/keep-alive-header', (req, res) => {
      connectionHeader = req.headers.connection;
      res.end('OK');
    });
    await request({ method: 'GET', url: 'http://localhost:3000/keep-alive-header' });
    unsubscribe();
    await session.shutdown();
    expect(connectionHeader).toBe('keep-alive');
  });

  test('sockets are re-used by default', async () => {
    const session = new HttpSession();
    const { request } = await session.requestSession();
    const serverSockets = new Set<net.Socket>();
    const unsubscribe = server.on('GET', '/reused-sockets', (req, res) => {
      serverSockets.add(req.socket);
      res.end('OK');
    });
    await request({ method: 'GET', url: 'http://localhost:3000/reused-sockets' });
    await request({ method: 'GET', url: 'http://localhost:3000/reused-sockets' });
    await request({ method: 'GET', url: 'http://localhost:3000/reused-sockets' });
    await request({ method: 'GET', url: 'http://localhost:3000/reused-sockets' });
    unsubscribe();
    await session.shutdown();
    expect(serverSockets.size).toBe(1);
  });

  test('sockets should not be re-used when keepConnectionAlive is false', async () => {
    const session = new HttpSession({
      keepConnectionAlive: false,
    });
    const { request } = await session.requestSession();
    const serverSockets = new Set<net.Socket>();
    const unsubscribe = server.on('GET', '/sockets-not-reused', (req, res) => {
      serverSockets.add(req.socket);
      res.end('OK');
    });
    await request({ method: 'GET', url: 'http://localhost:3000/sockets-not-reused' });
    await request({ method: 'GET', url: 'http://localhost:3000/sockets-not-reused' });
    await request({ method: 'GET', url: 'http://localhost:3000/sockets-not-reused' });
    await request({ method: 'GET', url: 'http://localhost:3000/sockets-not-reused' });
    unsubscribe();
    await session.shutdown();
    expect(serverSockets.size).toBe(4);
  });

  test('Brotli compression is handled', async () => {
    const session = new HttpSession();
    const testString = 'abc123456';
    const unsubscribe = server.on('GET', '/brotli', (_, res) => {
      const inputStream = createReadableStream(testString);
      const compress = createBrotliCompress();
      res.setHeader('content-encoding', 'br');
      inputStream.pipe(compress).pipe(res);
    });
    const { request } = await session.requestSession();
    const response = await request({ url: 'http://localhost:3000/brotli' });
    unsubscribe();
    await session.shutdown();
    expect(response.data).toBe(testString);
  });

  test('Deflate compression is handled', async () => {
    const session = new HttpSession();
    const testString = 'abc123456';
    const unsubscribe = server.on('GET', '/deflate', (_, res) => {
      const inputStream = createReadableStream(testString);
      const compress = createDeflate();
      res.setHeader('content-encoding', 'deflate');
      inputStream.pipe(compress).pipe(res);
    });
    const { request } = await session.requestSession();
    const response = await request({ url: 'http://localhost:3000/deflate' });
    unsubscribe();
    await session.shutdown();
    expect(response.data).toBe(testString);
  });

  test('Gzip compression is handled', async () => {
    const session = new HttpSession();
    const testString = 'abc123456';
    const unsubscribe = server.on('GET', '/gzip', (_, res) => {
      const inputStream = createReadableStream(testString);
      const compress = createGzip();
      res.setHeader('content-encoding', 'gzip');
      inputStream.pipe(compress).pipe(res);
    });
    const { request } = await session.requestSession();
    const response = await request({ url: 'http://localhost:3000/gzip' });
    unsubscribe();
    await session.shutdown();
    expect(response.data).toBe(testString);
  });

  test('Throws on unhandled content encoding', async () => {
    let err: any = null;
    const session = new HttpSession();
    const unsubscribe = server.on('GET', '/unhandled-encoding', (_, res) => {
      res.setHeader('content-encoding', 'invalid-content-type');
      res.end('OK');
    });
    const { request } = await session.requestSession();
    try {
      await request({ url: 'http://localhost:3000/unhandled-encoding' });
    } catch (error) {
      err = error;
    }
    unsubscribe();
    await session.shutdown();
    expect(err).not.toBe(null);
  });

  test('Throws on invalid JSON response', async () => {
    let err: any = null;
    const session = new HttpSession();
    const unsubscribe = server.on('GET', '/invalid-json', (_, res) => {
      res.setHeader('content-type', 'application/json');
      res.end('This is not JSON');
    });
    const { request } = await session.requestSession();
    try {
      await request({ url: 'http://localhost:3000/invalid-json', responseType: 'json' });
    } catch (error) {
      err = error;
    }
    unsubscribe();
    await session.shutdown();
    expect(err).not.toBe(null);
  });

  afterAll(() => {
    return server.stop();
  });
});
