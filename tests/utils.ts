import { Readable, Writable } from 'node:stream';
import { asyncPipeline, collectStreamToBuffer, collectStreamToString, limitString } from '../src/utils';

function createReadableStream(str: string | Buffer, chunkSize = 10): Readable {
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

describe('limitString', () => {
  it('should crop the string if length is exceeded', () => {
    expect(limitString('12345678901234', 10)).toBe('1234567...');
  });
  it('should not crop the string if length is not exceeded', () => {
    expect(limitString('12345678901234', 20)).toBe('12345678901234');
  });
  it('should crop to 1000 characters by default', () => {
    const longStr = new Array(2000).fill('0').join('');
    expect(limitString(longStr)).toHaveLength(1000);
  });
});

describe('asyncPipeline', () => {
  it('should reject on error in input stream', async () => {
    const readable = new Readable({
      read() {
        this.emit('error', 'Readable Error');
      },
    });
    const writable = new Writable({
      write(_ch, _enc, cb) {
        cb();
      },
    });
    let errorThrown = false;
    try {
      await asyncPipeline(readable, writable);
    } catch {
      errorThrown = true;
    }
    expect(errorThrown).toBe(true);
  });

  it('should reject on error in output stream', async () => {
    const readable = createReadableStream('abcdfefghijklmnopqrstuvwxyz');
    const writable = new Writable({
      write(_ch, _enc, _cb) {
        this.emit('error', 'Writable Error');
      },
    });
    let errorThrown = false;
    try {
      await asyncPipeline(readable, writable);
    } catch {
      errorThrown = true;
    }
    expect(errorThrown).toBe(true);
  });
});

describe('collectStreamTo___', () => {
  it('collectStreamToString should handle error in input stream', async () => {
    const readable = new Readable({
      read() {
        this.emit('error', 'Readable Error');
      },
    });
    let errorThrown = false;
    try {
      await collectStreamToString(readable);
    } catch {
      errorThrown = true;
    }
    expect(errorThrown).toBe(true);
  });

  it('collectStreamToBuffer should handle error in input stream', async () => {
    const readable = new Readable({
      read() {
        this.emit('error', 'Readable Error');
      },
    });
    let errorThrown = false;
    try {
      await collectStreamToBuffer(readable);
    } catch {
      errorThrown = true;
    }
    expect(errorThrown).toBe(true);
  });
});
