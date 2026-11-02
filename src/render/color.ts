// Colour helpers.

const cache = new Map<string, string>();

function parse(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Lighten (amt > 0) or darken (amt < 0) a hex colour. */
export function shade(hex: string, amt: number): string {
  const k = hex + amt;
  const c = cache.get(k);
  if (c) return c;
  const [r, g, b] = parse(hex);
  const f = (v: number) => Math.round(amt >= 0 ? v + (255 - v) * amt : v * (1 + amt));
  const out = `rgb(${f(r)},${f(g)},${f(b)})`;
  cache.set(k, out);
  return out;
}

export function rgba(hex: string, a: number): string {
  const k = hex + '|' + a;
  const c = cache.get(k);
  if (c) return c;
  const [r, g, b] = parse(hex);
  const out = `rgba(${r},${g},${b},${a})`;
  cache.set(k, out);
  return out;
}

export function mix(a: string, b: string, t: number): string {
  const k = a + b + t;
  const c = cache.get(k);
  if (c) return c;
  const [r1, g1, b1] = parse(a);
  const [r2, g2, b2] = parse(b);
  const out = `rgb(${Math.round(r1 + (r2 - r1) * t)},${Math.round(g1 + (g2 - g1) * t)},${Math.round(b1 + (b2 - b1) * t)})`;
  cache.set(k, out);
  return out;
}

export function rgbOf(hex: string): [number, number, number] {
  return parse(hex);
}
