export function matchDomain(hostName: string, cookieDomain: string): boolean {
  if (hostName === cookieDomain) return true;
  if (hostName.endsWith(cookieDomain)) {
    return hostName[hostName.length - 1 - cookieDomain.length] === '.';
  } else {
    return false;
  }
}
