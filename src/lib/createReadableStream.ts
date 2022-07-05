import { Readable } from 'node:stream';

export function createReadableStream(str: string | Buffer, chunkSize = 10): Readable {
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
