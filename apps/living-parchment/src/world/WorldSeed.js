// Worlds as a replayable stroke log, packed into a short URL-safe "seed".
//
// Every committed stroke is stored as {kind, biome, seed, points}. Points are quantized to a
// 4096 grid and simplified *before* the stroke is applied, and every random choice the stroke
// makes is drawn from its own seeded generator, so replaying the log rebuilds the same page.
//
// Wire format (then optionally deflated, then base32 so it fits in a plain #hash):
//   u8 'L' | u8 version | u8 current biome | u16 entry count
//   per entry: u8 kind | u8 biome | u32 seed | u16 n | n * (u16 x, u16 y)

export const KINDS = ['loop', 'ruin', 'river', 'tap', 'flick'];
export const SEED_VERSION = 1;
const Q = 4095;
const HASH_PREFIX = 'w1';

export function quantize(v) {
  return Math.round(Math.min(1, Math.max(0, v)) * Q);
}
export function dequantize(q) {
  return q / Q;
}

function perpDist(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Ramer-Douglas-Peucker polyline simplification (iterative). */
export function simplify(pts, eps = 0.0012) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let best = -1;
    let bestD = eps;
    for (let i = a + 1; i < b; i++) {
      const d = perpDist(pts[i], pts[a], pts[b]);
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Canonical points for a stroke: simplified, then snapped to the quantization grid. */
export function canonicalPoints(pts, kind) {
  const s = kind === 'ruin' || kind === 'tap' ? pts : simplify(pts);
  return s.slice(0, 4000).map((p) => ({ x: dequantize(quantize(p.x)), y: dequantize(quantize(p.y)) }));
}

export function encodeBytes(entries, biome = 0) {
  let size = 5;
  for (const e of entries) size += 8 + e.points.length * 4;
  const buf = new ArrayBuffer(size);
  const v = new DataView(buf);
  let o = 0;
  v.setUint8(o++, 76); // 'L'
  v.setUint8(o++, SEED_VERSION);
  v.setUint8(o++, biome);
  v.setUint16(o, entries.length);
  o += 2;
  for (const e of entries) {
    v.setUint8(o++, KINDS.indexOf(e.kind));
    v.setUint8(o++, e.biome);
    v.setUint32(o, e.seed >>> 0);
    o += 4;
    v.setUint16(o, e.points.length);
    o += 2;
    for (const p of e.points) {
      v.setUint16(o, quantize(p.x));
      v.setUint16(o + 2, quantize(p.y));
      o += 4;
    }
  }
  return new Uint8Array(buf);
}

export function decodeBytes(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  if (v.getUint8(o++) !== 76) throw new Error('Not a Living Parchment world');
  const ver = v.getUint8(o++);
  if (ver !== SEED_VERSION) throw new Error(`Unsupported world version ${ver}`);
  const biome = v.getUint8(o++);
  const count = v.getUint16(o);
  o += 2;
  const entries = [];
  for (let i = 0; i < count; i++) {
    const kind = KINDS[v.getUint8(o++)];
    if (!kind) throw new Error('Corrupt world: unknown stroke');
    const b = v.getUint8(o++);
    const seed = v.getUint32(o);
    o += 4;
    const n = v.getUint16(o);
    o += 2;
    const points = [];
    for (let k = 0; k < n; k++) {
      points.push({ x: dequantize(v.getUint16(o)), y: dequantize(v.getUint16(o + 2)) });
      o += 4;
    }
    entries.push({ kind, biome: b, seed, points });
  }
  return { biome, entries };
}

// RFC 4648 base32, lowercase, unpadded: letters and digits only, so it is a valid plain #hash.
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
export function toBase32(bytes) {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function fromBase32(str) {
  const out = [];
  let bits = 0;
  let value = 0;
  for (const ch of str) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('Corrupt world code');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  return new Uint8Array(out);
}

async function pipe(bytes, stream) {
  const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}

/** World -> hash string ("w1" + flag + base32). Deflates when the browser can. */
export async function encodeWorld(entries, biome) {
  const raw = encodeBytes(entries, biome);
  if (typeof CompressionStream !== 'undefined') {
    try {
      const z = await pipe(raw, new CompressionStream('deflate-raw'));
      if (z.length < raw.length) return `${HASH_PREFIX}z${toBase32(z)}`;
    } catch {
      /* fall through to raw */
    }
  }
  return `${HASH_PREFIX}r${toBase32(raw)}`;
}

export function isWorldHash(hash) {
  const h = hash.replace(/^#/, '');
  return h.startsWith(HASH_PREFIX) && h.length > 3;
}

export async function decodeWorld(hash) {
  const h = hash.replace(/^#/, '');
  if (!isWorldHash(h)) throw new Error('Not a world link');
  const flag = h[2];
  let bytes = fromBase32(h.slice(3));
  if (flag === 'z') {
    if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot open compressed worlds');
    bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
  } else if (flag !== 'r') throw new Error('Corrupt world link');
  return decodeBytes(bytes);
}
