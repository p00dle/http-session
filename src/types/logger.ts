export type LoggerFunction = (message: string, details?: string) => any;

export interface Logger {
  debug: LoggerFunction;
  info: LoggerFunction;
  warn: LoggerFunction;
  error: LoggerFunction;
}
