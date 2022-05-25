export interface Cookie {
  key: string;
  value: string;
  domain: string;
  isHttps: boolean;
  allowSubDomains: boolean;
  path: string;
  expires?: number;
  secure?: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
  hasInvalidAttributes?: boolean;
}
