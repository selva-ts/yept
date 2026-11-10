// MD4 (RFC 1320), needed only for the NTLM password hash. Node's OpenSSL 3 build no longer offers md4, so it's here.
// Never use it for anything else: MD4 is broken as a general hash.

const rotl = (v: number, s: number): number => (v << s) | (v >>> (32 - s));
const F = (x: number, y: number, z: number): number => (x & y) | (~x & z);
const G = (x: number, y: number, z: number): number => (x & y) | (x & z) | (y & z);
const H = (x: number, y: number, z: number): number => x ^ y ^ z;

export function md4(input: Buffer): Buffer {
  const len = input.length;
  // Message, 0x80, zeros up to 56 mod 64, then the bit length as a 64-bit little-endian number.
  const total = Math.floor((len + 8) / 64) * 64 + 64;
  const buf = Buffer.alloc(total);
  input.copy(buf);
  buf[len] = 0x80;
  buf.writeUInt32LE((len * 8) >>> 0, total - 8);
  buf.writeUInt32LE(Math.floor(len / 0x20000000), total - 4);

  let a = 0x67452301;
  let b = 0xefcdab89 | 0;
  let c = 0x98badcfe | 0;
  let d = 0x10325476;
  const x = new Array<number>(16);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) x[i] = buf.readInt32LE(off + i * 4);
    const [aa, bb, cc, dd] = [a, b, c, d];
    for (const i of [0, 4, 8, 12]) {
      a = rotl((a + F(b, c, d) + x[i]) | 0, 3);
      d = rotl((d + F(a, b, c) + x[i + 1]) | 0, 7);
      c = rotl((c + F(d, a, b) + x[i + 2]) | 0, 11);
      b = rotl((b + F(c, d, a) + x[i + 3]) | 0, 19);
    }
    for (const i of [0, 1, 2, 3]) {
      a = rotl((a + G(b, c, d) + x[i] + 0x5a827999) | 0, 3);
      d = rotl((d + G(a, b, c) + x[i + 4] + 0x5a827999) | 0, 5);
      c = rotl((c + G(d, a, b) + x[i + 8] + 0x5a827999) | 0, 9);
      b = rotl((b + G(c, d, a) + x[i + 12] + 0x5a827999) | 0, 13);
    }
    for (const i of [0, 2, 1, 3]) {
      a = rotl((a + H(b, c, d) + x[i] + 0x6ed9eba1) | 0, 3);
      d = rotl((d + H(a, b, c) + x[i + 8] + 0x6ed9eba1) | 0, 9);
      c = rotl((c + H(d, a, b) + x[i + 4] + 0x6ed9eba1) | 0, 11);
      b = rotl((b + H(c, d, a) + x[i + 12] + 0x6ed9eba1) | 0, 15);
    }
    a = (a + aa) | 0;
    b = (b + bb) | 0;
    c = (c + cc) | 0;
    d = (d + dd) | 0;
  }
  const out = Buffer.alloc(16);
  [a, b, c, d].forEach((v, i) => out.writeInt32LE(v, i * 4));
  return out;
}
