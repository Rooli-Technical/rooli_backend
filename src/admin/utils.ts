export function isIPInRange(ip: string, range: string): boolean {
  try {
    // Single IP, no CIDR
    if (!range.includes('/')) {
      return ip === range;
    }

    const [rangeIp, prefixLength] = range.split('/');
    const prefix = parseInt(prefixLength, 10);

    // Handle IPv4
    if (isIPv4(ip) && isIPv4(rangeIp)) {
      return ipv4InRange(ip, rangeIp, prefix);
    }

    // Handle IPv6
    if (isIPv6(ip) && isIPv6(rangeIp)) {
      return ipv6InRange(ip, rangeIp, prefix);
    }

    return false;
  } catch {
    return false;
  }
}

function isIPv4(ip: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip);
}

function isIPv6(ip: string): boolean {
  return ip.includes(':');
}

function ipv4ToInt(ip: string): number {
  return (
    ip
      .split('.')
      .reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0
  );
}

function ipv4InRange(ip: string, rangeIp: string, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(rangeIp) & mask);
}

function ipv6Expand(ip: string): string {
  // Expand :: shorthand
  if (ip.includes('::')) {
    const [left, right] = ip.split('::');
    const leftParts = left ? left.split(':') : [];
    const rightParts = right ? right.split(':') : [];
    const missing = 8 - leftParts.length - rightParts.length;
    const middle = Array(missing).fill('0000');
    return [...leftParts, ...middle, ...rightParts]
      .map((p) => p.padStart(4, '0'))
      .join(':');
  }
  return ip
    .split(':')
    .map((p) => p.padStart(4, '0'))
    .join(':');
}

function ipv6ToBigInt(ip: string): bigint {
  return BigInt('0x' + ipv6Expand(ip).replace(/:/g, ''));
}

function ipv6InRange(ip: string, rangeIp: string, prefix: number): boolean {
  const mask = prefix === 0 ? 0n : ~0n << BigInt(128 - prefix);
  return (ipv6ToBigInt(ip) & mask) === (ipv6ToBigInt(rangeIp) & mask);
}

export function normalizeIp(ip: string): string {
  if (ip === '::1') return '127.0.0.1';
  // Handle IPv4-mapped IPv6 addresses e.g. ::ffff:192.168.1.1
  if (ip.startsWith('::ffff:')) return ip.replace('::ffff:', '');
  return ip;
}
