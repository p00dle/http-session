export function callbackPromise<T = void>(): [Promise<T>, (data: T) => void] {
  let onResolve: (data: T) => void;
  const promise = new Promise<T>((resolve) => {
    onResolve = resolve;
  });
  const cb = (data: T) => onResolve(data);
  return [promise, cb];
}
