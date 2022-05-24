import { LogPayload } from './types/logger';

const noOp = function () {
  //
};

export const noOpLogger = {
  debug: noOp,
  info: noOp,
  warn: noOp,
  error: noOp,
};

export function errorToLog(err: unknown): LogPayload {
  if (err instanceof Error) {
    return { message: err.message, details: String(err.stack) };
  } else {
    return { message: 'Unknown error', details: JSON.stringify(err, null, 2) };
  }
}
