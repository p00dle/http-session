import { TestServer } from '../src/lib/TestServer';
import { HttpSession } from '../src/http-session';
import { createGzip, createBrotliCompress, createDeflate } from 'node:zlib';
import * as net from 'node:net';
import { createReadableStream } from '../src/lib/createReadableStream';
import { makeCookie } from '../src/cookies/make'

describe('End to end', () => {
  const server = new TestServer({ port: 3000 });

  beforeAll(() => {
    return server.start();
  });


  test('Cookies are extracted from headers and sent on subsequent requests', async () => {
    const session = new HttpSession({
      async login(session) {
        session.addCookies([makeCookie({key: 'a', value: 'b', domain: 'localhost'})])
      },
    });
    const { request } = await session.requestSession();
    let cookieHeader = '';
    const unsubscribes = [
      server.on('GET', '/', (_req, res) => {
        res.setHeader('set-cookie', ['foo=bar', 'boo=baz'])
        res.end('OK');
      }),
      server.on('GET', '/a', (req, res) => {
        cookieHeader = req.headers.cookie || '';
        res.end('OK');
      })
    ];
    await request({url: 'http://localhost:3000'});
    await request({url: 'http://localhost:3000/a'});
    for (const unsubscribe of unsubscribes) unsubscribe();
    await session.shutdown();
    expect(cookieHeader).toBe('a=b; foo=bar; boo=baz');
  });


  test('Connection keep-alive header should be set when keepConnectionAlive is true', async () => {
    const session = new HttpSession();
    const { request } = await session.requestSession();
    let connectionHeader: string | undefined = ''; 
    const unsubscribe = server.on('GET', '/', (req, res) => {
      connectionHeader = req.headers.connection;
      res.end('OK');
    });
    await request({ method: 'GET', url: 'http://localhost:3000' });
    unsubscribe();
    await session.shutdown();
    expect(connectionHeader).toBe('keep-alive');
  });

  test('sockets are re-used by default', async () => {
    const session = new HttpSession();
    const { request } = await session.requestSession();
    const serverSockets = new Set<net.Socket>();
    const unsubscribe = server.on('GET', '/', (req, res) => {
      serverSockets.add(req.socket);
      res.end('OK');
    });
    await request({ method: 'GET', url: 'http://localhost:3000' });
    await request({ method: 'GET', url: 'http://localhost:3000' });
    await request({ method: 'GET', url: 'http://localhost:3000' });
    await request({ method: 'GET', url: 'http://localhost:3000' });
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
    const unsubscribe = server.on('GET', '/', (req, res) => {
      serverSockets.add(req.socket);
      res.end('OK');
    });
    await request({ method: 'GET', url: 'http://localhost:3000' });
    await request({ method: 'GET', url: 'http://localhost:3000' });
    await request({ method: 'GET', url: 'http://localhost:3000' });
    await request({ method: 'GET', url: 'http://localhost:3000' });
    unsubscribe();
    await session.shutdown();
    expect(serverSockets.size).toBe(4);
  });

  test('Brotli compression is handled', async () => {
    const session = new HttpSession();
    const testString = 'abc123456';
    const unsubscribe = server.on('GET', '/', (_, res) => {
      const inputStream = createReadableStream(testString);
      const compress = createBrotliCompress();
      res.setHeader('content-encoding', 'br');
      inputStream.pipe(compress).pipe(res);
    });
    const { request } = await session.requestSession();
    const response = await request({ url: 'http://localhost:3000' });
    unsubscribe();
    await session.shutdown();
    expect(response.data).toBe(testString);
  });

  test('Deflate compression is handled', async () => {
    const session = new HttpSession();
    const testString = 'abc123456';
    const unsubscribe = server.on('GET', '/', (_, res) => {
      const inputStream = createReadableStream(testString);
      const compress = createDeflate();
      res.setHeader('content-encoding', 'deflate');
      inputStream.pipe(compress).pipe(res);
    });
    const { request } = await session.requestSession();
    const response = await request({ url: 'http://localhost:3000' });
    unsubscribe();
    await session.shutdown();
    expect(response.data).toBe(testString);
  });

  test('Gzip compression is handled', async () => {
    const session = new HttpSession();
    const testString = 'abc123456';
    const unsubscribe = server.on('GET', '/', (_, res) => {
      const inputStream = createReadableStream(testString);
      const compress = createGzip();
      res.setHeader('content-encoding', 'gzip');
      inputStream.pipe(compress).pipe(res);
    });
    const { request } = await session.requestSession();
    const response = await request({ url: 'http://localhost:3000' });
    unsubscribe();
    await session.shutdown();
    expect(response.data).toBe(testString);
  });

  test('Throws on unhandled content encoding', async () => {
    let err: any = null;
    const session = new HttpSession();
    const unsubscribe = server.on('GET', '/', (_, res) => {
      res.setHeader('content-encoding', 'invalid-content-type');
      res.end('OK');
    });
    const { request } = await session.requestSession();
    try {
      await request({ url: 'http://localhost:3000' });
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
    const unsubscribe = server.on('GET', '/', (_, res) => {
      res.setHeader('content-type', 'application/json');
      res.end('This is not JSON');
    });
    const { request } = await session.requestSession();
    try {
      await request({ url: 'http://localhost:3000', responseType: 'json' });
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
