import { Readable } from 'node:stream';

export function createReadableStream(str: string | Buffer | Uint8Array | Readable, chunkSize = 10): Readable {
  if (str instanceof Readable) {
    return str;
  }
  let start = 0;
  return new Readable({
    read() {
      if (start >= str.length) {
        this.push(null);
      } else {
        this.push(str.slice(start, start + chunkSize));
        start += chunkSize;
      }
    },
  });
}
