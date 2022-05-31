import { EventEmitter } from 'node:stream';
import { merge } from './merge';

type Unsubscribe = () => any;
type CancelTimeout = () => any;

export abstract class UtilityClass<S> {
  protected emitter = new EventEmitter();
  protected abstract status: S;
  public onStatus(listener: (status: S) => any): Unsubscribe {
    this.emitter.on('status-change', listener);
    listener(this.status);
    return () => this.emitter.off('status-change', listener);
  }
  protected changeStatus(status: Partial<S>) {
    this.status = merge(this.status, status);
    this.emitter.emit('status-change', this.status);
  }
  private timeouts: { handle: NodeJS.Timeout; cb: () => any; callOnClearAll: boolean }[] = [];
  protected setTimeout(cb: () => any, ms: number, callOnClearAll = true): CancelTimeout {
    const handle = setTimeout(cb, ms);
    const timeoutCallback = { handle, cb, callOnClearAll };
    this.timeouts.push(timeoutCallback);
    return () => {
      const index = this.timeouts.indexOf(timeoutCallback);
      if (index >= 0) this.timeouts.splice(index, 1);
      clearTimeout(handle);
    };
  }
  protected clearAllTimeouts() {
    this.timeouts.forEach(({ handle, cb, callOnClearAll }) => {
      clearTimeout(handle);
      if (callOnClearAll) cb();
    });
  }
}
