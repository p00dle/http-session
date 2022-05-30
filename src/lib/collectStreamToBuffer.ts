import { Readable, Writable, pipeline } from 'node:stream';

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
