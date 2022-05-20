import { httpRequest, HttpSession, CookieJar } from '../src';
import { noOpLogger, errorToLog } from '../src/logger';

describe('exports', () => {
  it('exports httpRequest', () => expect(httpRequest).toBeTruthy());
  it('exports HttpSession', () => expect(HttpSession).toBeTruthy());
  it('exports CookieJar', () => expect(CookieJar).toBeTruthy());
});

describe('logger', () => {
  it('noOpLogger works but does nothing', () => {
    expect(() => {
      noOpLogger.debug();
      noOpLogger.info();
      noOpLogger.warn();
      noOpLogger.error();
    }).not.toThrow();
  });
  it('errorToLog converts error to log', () => {
    const errorLog = errorToLog(new Error('error message'));
    expect(errorLog.message).toBe('error message');
    expect(errorLog.details.length > 100).toBe(true);
  });
  it('errorToLog converts a non-error to log', () => {
    const errorLog = errorToLog('error message');
    expect(errorLog).toEqual({ message: 'Unknown error', details: '"error message"' });
  });
});
