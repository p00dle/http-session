export function parseError(error: any): [string, string?] {
  if (error && typeof error.message === 'string' && typeof error.stack === 'string')
    return [error.message, error.stack];
  else if (error && typeof error.message === 'string') return [error.message];
  else return [String(error)];
}
