import { Readable, Writable, pipeline } from 'node:stream';

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
