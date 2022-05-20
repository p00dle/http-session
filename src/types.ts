interface UsedHeaders {
  location?: string;
  Referer?: string;
  Cookie?: string[];
  'Set-Cookie'?: string[];
}

export type HttpHeaders = UsedHeaders & Record<string, string | string[] | number | undefined>;
