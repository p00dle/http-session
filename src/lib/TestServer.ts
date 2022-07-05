import * as http from 'node:http';
import * as net from 'node:net';
type HttpMethod = 'GET' | 'POST';
type Unsubscribe = () => any;

export class TestServer {
  private serverInstance: http.Server | null = null;
  private sockets: Set<net.Socket> = new Set<net.Socket>();
  private pathHandlers: Record<HttpMethod, Record<string, http.RequestListener>> = { GET: {}, POST: {} };
  private throwOnUnhandled: boolean;
  private throwOnDuplicateHandler: boolean;
  private port: number;

  constructor({
    throwOnUnhandled = true,
    throwOnDuplicateHandler = true,
    port = 80,
  }: {
    throwOnUnhandled?: boolean;
    throwOnDuplicateHandler?: boolean;
    port?: number;
  }) {
    this.throwOnUnhandled = throwOnUnhandled;
    this.throwOnDuplicateHandler = throwOnDuplicateHandler;
    this.port = port;
  }

  public start() {
    return new Promise<void>((resolve) => {
      if (!this.serverInstance) {
        this.serverInstance = http.createServer(this.requestListener.bind(this));
        this.serverInstance.listen(this.port, resolve);
        this.serverInstance.on('connection', (socket) => {
          this.sockets.add(socket);
        });
      } else {
        resolve();
      }
    });
  }

  public stop() {
    return new Promise<void>((resolve, reject) => {
      for (const socket of this.sockets) {
        socket.destroy();
      }
      if (this.serverInstance) {
        this.serverInstance.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      } else {
        resolve();
      }
    });
  }

  public on(method: HttpMethod, path: string, handler: http.RequestListener): Unsubscribe {
    if (this.throwOnDuplicateHandler && this.pathHandlers[method][path]) {
      throw new Error(`Handler already registered for [${method}] [${path}]`);
    }
    this.pathHandlers[method][path] = handler;
    return () => {
      delete this.pathHandlers[method][path];
    };
  }

  private requestListener: http.RequestListener = async (req, res) => {
    const method: HttpMethod = (req.method as HttpMethod) || 'GET';
    const path = req.url || '/';
    if (this.pathHandlers[method][path]) {
      this.pathHandlers[method][path](req, res);
    } else {
      res.statusCode = 404;
      res.end('Not found');
      if (this.throwOnUnhandled) {
        await this.stop();
        throw new Error(`Unhandled: [${method}] [${path}]`);
      }
    }
  };
}
