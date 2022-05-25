import type { HttpHeaders } from '../types/http-request';

export function getCookieHeaders(headers?: HttpHeaders): string[] {
  if (!headers) return [];
  const cookieHeader = headers['Set-Cookie'] || headers['set-cookie'] || null;
  if (!cookieHeader || !Array.isArray(cookieHeader)) return [];
  return cookieHeader;
}
