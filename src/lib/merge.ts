import { canBeDestructured } from './canBeDestructured';

export function merge<T>(curr: T, val: Partial<T>): T {
  return canBeDestructured(curr) && canBeDestructured(val) ? { ...curr, ...val } : (val as T);
}
