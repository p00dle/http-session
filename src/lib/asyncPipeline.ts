import type { Readable, Writable } from 'stream';

import { pipeline } from 'node:stream';

export function asyncPipeline(input: Readable, output: Writable): Promise<void> {
  return new Promise((resolve, reject) => pipeline(input, output, (err) => (err ? reject(err) : resolve())));
}
