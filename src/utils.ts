import type { Readable } from 'node:stream';
import type { URL } from 'node:url';

import { pipeline, Writable } from 'node:stream';

export function limitString(str: string | undefined | URL, length = 1000): string {
  if (!str) return '';
  const castedStr = typeof str === 'string' ? str : '' + str;
  if (castedStr.length <= length) return castedStr;
  return castedStr.slice(0, length - 3) + '...';
}

export function makeCallbackPromise<T = void>(): [Promise<T>, (data: T) => void] {
  let onResolve: (data: T) => void;
  const promise = new Promise<T>((resolve) => {
    onResolve = resolve;
  });
  const cb = (data: T) => onResolve(data);
  return [promise, cb];
}

export function asyncPipeline(input: Readable, output: Writable): Promise<void> {
  return new Promise((resolve, reject) => pipeline(input, output, (err) => (err ? reject(err) : resolve())));
}

export function collectStreamToString(stream: Readable): Promise<string> {
  let output = '';
  const collectStream = new Writable({
    write(chunk, _, done) {
      output += chunk;
      done();
    },
  });
  return new Promise((resolve, reject) =>
    pipeline(stream, collectStream, (err) => (err ? reject(err) : resolve(output)))
  );
}

export function collectStreamToBuffer(stream: Readable): Promise<Buffer> {
  const buffers: Buffer[] = [];
  const collectStream = new Writable({
    write(chunk, _, done) {
      buffers.push(chunk);
      done();
    },
  });
  return new Promise((resolve, reject) =>
    pipeline(stream, collectStream, (err) => (err ? reject(err) : resolve(Buffer.concat(buffers))))
  );
}
