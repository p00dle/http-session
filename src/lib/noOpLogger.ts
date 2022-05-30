function noOp() {
  //
}

export const noOpLogger = {
  debug: noOp,
  info: noOp,
  warn: noOp,
  error: noOp,
  namespace: () => noOpLogger,
};
