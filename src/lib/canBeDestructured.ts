export function canBeDestructured(val: any): val is Record<string, unknown> {
  return val && typeof val === 'object';
}
