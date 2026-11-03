/**
 * Which network addresses a server-side fetch of a user-supplied URL may
 * reach. Pure (no Node imports) so client-shared modules such as
 * lib/validate.ts can use the same rules as lib/net/safeFetch.ts.
 *
 * Blocked: loopback, private (RFC 1918), CGNAT, link-local (incl. the
 * 169.254.169.254 cloud metadata address), unspecified, multicast/reserved,
 * benchmarking, IPv6 ULA/link-local, and IPv4 addresses embedded in IPv6
 * (v4-mapped, NAT64) when the embedded address is blocked.
 */

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function parseIpv4(ip: string): number[] | null {
  const m = IPV4_RE.exec(ip);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  return octets.every((o) => o <= 255) ? octets : null;
}

function isBlockedIpv4(octets: number[]): boolean {
  const [a, b, c] = octets;
  return (
    a === 0 || // "this network"
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local + cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast, reserved, broadcast
  );
}

/** Expand an IPv6 literal (no brackets, no zone) to 8 hextets, or null. */
function expandIpv6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  // Trailing dotted IPv4 (::ffff:1.2.3.4) → two hextets.
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIpv4(tail);
    if (!v4) return null;
    s =
      s.slice(0, lastColon + 1) +
      ((v4[0] << 8) | v4[1]).toString(16) +
      ":" +
      ((v4[2] << 8) | v4[3]).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const parts = [
    ...head,
    ...Array(halves.length === 2 ? missing : 0).fill("0"),
    ...rest,
  ];
  const out: number[] = [];
  for (const p of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(p)) return null;
    out.push(parseInt(p, 16));
  }
  return out.length === 8 ? out : null;
}

function isBlockedIpv6(h: number[]): boolean {
  if (h.every((x) => x === 0)) return true; // ::
  if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return true; // ::1
  if ((h[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((h[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((h[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((h[0] & 0xff00) === 0xff00) return true; // multicast
  const embedded = (hi: number, lo: number) => [
    hi >> 8,
    hi & 0xff,
    lo >> 8,
    lo & 0xff,
  ];
  // ::ffff:a.b.c.d (v4-mapped) and ::a.b.c.d (v4-compatible)
  if (h.slice(0, 5).every((x) => x === 0) && (h[5] === 0xffff || h[5] === 0)) {
    return isBlockedIpv4(embedded(h[6], h[7]));
  }
  // 64:ff9b::/96 NAT64
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) {
    return isBlockedIpv4(embedded(h[6], h[7]));
  }
  // 2002::/16 6to4 carries an IPv4 address in hextets 1-2
  if (h[0] === 0x2002) return isBlockedIpv4(embedded(h[1], h[2]));
  return false;
}

/** True for an IP address (v4 or v6, brackets allowed) a fetch must not reach. */
export function isBlockedAddress(ip: string): boolean {
  const s = ip.trim().replace(/^\[|\]$/g, "");
  const v4 = parseIpv4(s);
  if (v4) return isBlockedIpv4(v4);
  if (s.includes(":")) {
    const v6 = expandIpv6(s);
    return v6 ? isBlockedIpv6(v6) : true; // unparseable literal → refuse
  }
  return false;
}

/** True when the hostname is an IP literal (v4 dotted or bracketed/bare v6). */
export function isIpLiteral(hostname: string): boolean {
  const s = hostname.replace(/^\[|\]$/g, "");
  return !!parseIpv4(s) || (s.includes(":") && !!expandIpv6(s));
}

/**
 * Hostname-only check (no DNS): blocked IP literals plus names that only
 * ever mean "this machine / this network". A public-looking name can still
 * resolve to a private address (nip.io, rebinding) — safeFetch re-checks
 * every resolved address at connect time.
 */
export function isBlockedHostname(hostname: string): boolean {
  const h = hostname
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    h.endsWith(".home.arpa")
  ) {
    return true;
  }
  if (isIpLiteral(h)) return isBlockedAddress(h);
  return false;
}
