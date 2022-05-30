export function limitString(str: string | undefined | URL, length = 1000): string {
  if (!str) return '';
  const castedStr = typeof str === 'string' ? str : '' + str;
  if (castedStr.length <= length) return castedStr;
  return castedStr.slice(0, length - 3) + '...';
}
