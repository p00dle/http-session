export interface LogPayload {
  message: string;
  details: string;
}

export type LoggerFunction = (payload: LogPayload) => any;

export interface Logger {
  debug: LoggerFunction;
  info: LoggerFunction;
  warn: LoggerFunction;
  error: LoggerFunction;
}
