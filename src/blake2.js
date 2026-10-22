// BLAKE2b with a configurable digest length (pure JS, no dependencies).
//
// Why this exists: a Substrate transaction hash is blake2_256 of the encoded
// extrinsic. The zkVerify RPC returns a block's extrinsics as HEX STRINGS
// (not objects with a `hash` field), so to match a task's `proof_tx` against
// what is actually on chain we have to hash each extrinsic ourselves.
//
// Node exposes blake2b512 and blake2s256 but NOT blake2b with a 32-byte
// digest, and Web Crypto has no blake2 at all — so this is implemented here.
//
// Reference: RFC 7693 (BLAKE2) with the blake2b parameter block, and the
// blake2b-256 digest length used by Substrate.

const IV = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];

const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
];

const MASK = 0xffffffffffffffffn;

const rotr = (x, n) => ((x >> BigInt(n)) | (x << BigInt(64 - n))) & MASK;

function compress(h, block, t, last) {
  const v = new Array(16);
  for (let i = 0; i < 8; i++) v[i] = h[i];
  for (let i = 0; i < 8; i++) v[i + 8] = IV[i];
  // The 128-bit counter is low word then high word.
  v[12] ^= t & MASK;
  v[13] ^= (t >> 64n) & MASK;
  if (last) v[14] ^= MASK;

  const m = new Array(16);
  for (let i = 0; i < 16; i++) {
    let lane = 0n;
    for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(block[i * 8 + b]);
    m[i] = lane;
  }

  const G = (a, b, c, d, x, y) => {
    v[a] = (v[a] + v[b] + x) & MASK;
    v[d] = rotr(v[d] ^ v[a], 32);
    v[c] = (v[c] + v[d]) & MASK;
    v[b] = rotr(v[b] ^ v[c], 24);
    v[a] = (v[a] + v[b] + y) & MASK;
    v[d] = rotr(v[d] ^ v[a], 16);
    v[c] = (v[c] + v[d]) & MASK;
    v[b] = rotr(v[b] ^ v[c], 63);
  };

  for (let r = 0; r < 12; r++) {
    const s = SIGMA[r];
    G(0, 4, 8, 12, m[s[0]], m[s[1]]);
    G(1, 5, 9, 13, m[s[2]], m[s[3]]);
    G(2, 6, 10, 14, m[s[4]], m[s[5]]);
    G(3, 7, 11, 15, m[s[6]], m[s[7]]);
    G(0, 5, 10, 15, m[s[8]], m[s[9]]);
    G(1, 6, 11, 12, m[s[10]], m[s[11]]);
    G(2, 7, 8, 13, m[s[12]], m[s[13]]);
    G(3, 4, 9, 14, m[s[14]], m[s[15]]);
  }

  for (let i = 0; i < 8; i++) h[i] = h[i] ^ v[i] ^ v[i + 8];
}

/**
 * BLAKE2b digest of `bytes` with a 32-byte (blake2_256) output.
 * @returns {Uint8Array} 32 bytes
 */
export function blake2b256(bytes) {
  const outLen = 32;
  const h = IV.slice();
  // Parameter block: digest_length | key_length<<8 | fanout<<16 | depth<<24
  h[0] ^= 0x01010000n ^ BigInt(outLen);

  const block = new Uint8Array(128);
  let counter = 0n;
  let offset = 0;

  while (offset < bytes.length) {
    const remaining = bytes.length - offset;
    const take = Math.min(128, remaining);
    block.fill(0);
    block.set(bytes.subarray(offset, offset + take));
    counter += BigInt(take);
    offset += take;
    const isLast = offset >= bytes.length;
    compress(h, block, counter, isLast);
  }

  if (bytes.length === 0) {
    // The empty input still produces one (final, empty) block.
    compress(h, block, 0n, true);
  }

  const out = new Uint8Array(outLen);
  for (let i = 0; i < 4; i++) {
    let lane = h[i];
    for (let b = 0; b < 8; b++) {
      out[i * 8 + b] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
  return out;
}

/** BLAKE2b-256 of a hex string (with or without 0x), as a 0x-prefixed string. */
export function blake2b256Hex(hex) {
  const clean = String(hex ?? "").replace(/^0x/, "");
  const bytes = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  const digest = blake2b256(bytes);
  return "0x" + [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}
