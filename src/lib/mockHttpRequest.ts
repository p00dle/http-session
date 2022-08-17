import { RequestOptions } from 'http';
import { Readable, Writable } from 'stream';
import { createReadableStream } from './createReadableStream';

type HttpHeaders = Record<string, string | string[] | number | undefined>;

type ResponseStream = Readable & {
  headers: HttpHeaders;
  statusCode?: number;
  statusMessage?: string;
};
type MakeHttpRequest = (url: URL, options: RequestOptions, callback: (data: ResponseStream) => any) => Writable;

interface MockRequestParams {
  returns: any;
  binary?: boolean;
  statusCode?: number;
  headers?: HttpHeaders;
  onDataReceived?: (data: any) => void;
  onOptionsReceived?: (data: RequestOptions & { url: URL | string }) => void;
  delay?: number;
}
export function mockHttpRequestFactory(params: MockRequestParams): MakeHttpRequest {
  const { returns, binary, statusCode, headers, onDataReceived, onOptionsReceived, delay = 1 } = params;
  return (url, options, cb) => {
    if (onOptionsReceived) onOptionsReceived({ url, ...options });
    const chunks: any[] = [];
    const requestStream = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk);
        cb();
      },
    });
    if (onDataReceived) {
      requestStream.on('finish', () => {
        if (binary) {
          onDataReceived(Buffer.concat(chunks));
        } else {
          onDataReceived(chunks.join(''));
        }
        requestStream.emit('response');
      });
    }
    const responseStream = Object.assign(createReadableStream(returns), {
      statusCode,
      statusMessage: '',
      headers: headers || {},
    });
    setTimeout(() => cb(responseStream), delay);
    return requestStream;
  };
}
