// PBKDF2-HMAC-SHA256 in plain JavaScript, and a shim that routes workerd's
// refusals through it.
//
// WhatsApp's phone-number pairing derives its key with 131,072 PBKDF2
// iterations (`2 << 16`, baileys/lib/Utils/crypto.js `derivePairingCodeKey`).
// workerd's WebCrypto refuses anything above 100,000:
//
//   Pbkdf2 failed: iteration counts above 100000 are not supported (requested 131072)
//
// The iteration count is part of WhatsApp's protocol, so it cannot be lowered,
// and PBKDF2 cannot be split across two calls — the output is the XOR of every
// intermediate, which the API never exposes. Baileys captures
// `globalThis.crypto.subtle` by destructuring at module load, so the shim
// replaces the method on the object rather than the object itself.
//
// Hand-rolled crypto earns its keep only if it is exactly right: the tests
// check this implementation against Node's own `pbkdf2Sync`, including at the
// 131,072-iteration count WhatsApp actually uses.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INITIAL_STATE = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const w = new Uint32Array(64);

/** One SHA-256 compression, updating `state` in place. */
function compress(state: Uint32Array, block: Uint8Array, offset: number): void {
  for (let i = 0; i < 16; i++) {
    const j = offset + i * 4;
    w[i] = ((block[j]! << 24) | (block[j + 1]! << 16) | (block[j + 2]! << 8) | block[j + 3]!) >>> 0;
  }
  for (let i = 16; i < 64; i++) {
    const x = w[i - 15]!;
    const y = w[i - 2]!;
    const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
    const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
    w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
  }

  let a = state[0]!, b = state[1]!, c = state[2]!, d = state[3]!;
  let e = state[4]!, f = state[5]!, g = state[6]!, h = state[7]!;

  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const ch = (e & f) ^ (~e & g);
    const temp1 = (h + S1 + ch + K[i]! + w[i]!) >>> 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const temp2 = (S0 + maj) >>> 0;
    h = g; g = f; f = e;
    e = (d + temp1) >>> 0;
    d = c; c = b; b = a;
    a = (temp1 + temp2) >>> 0;
  }

  state[0] = (state[0]! + a) >>> 0;
  state[1] = (state[1]! + b) >>> 0;
  state[2] = (state[2]! + c) >>> 0;
  state[3] = (state[3]! + d) >>> 0;
  state[4] = (state[4]! + e) >>> 0;
  state[5] = (state[5]! + f) >>> 0;
  state[6] = (state[6]! + g) >>> 0;
  state[7] = (state[7]! + h) >>> 0;
}

function stateToBytes(state: Uint32Array, out: Uint8Array): void {
  for (let i = 0; i < 8; i++) {
    const value = state[i]!;
    out[i * 4] = (value >>> 24) & 0xff;
    out[i * 4 + 1] = (value >>> 16) & 0xff;
    out[i * 4 + 2] = (value >>> 8) & 0xff;
    out[i * 4 + 3] = value & 0xff;
  }
}

export function sha256(message: Uint8Array): Uint8Array {
  const state = INITIAL_STATE.slice();
  const blocks = Math.floor(message.length / 64);
  for (let i = 0; i < blocks; i++) compress(state, message, i * 64);

  const rest = message.length - blocks * 64;
  const tail = new Uint8Array(rest + 9 > 64 ? 128 : 64);
  tail.set(message.subarray(blocks * 64));
  tail[rest] = 0x80;
  const bits = message.length * 8;
  // Lengths here never approach 2^32 bits, so the high word stays zero.
  const view = new DataView(tail.buffer);
  view.setUint32(tail.length - 4, bits >>> 0);
  view.setUint32(tail.length - 8, Math.floor(bits / 0x100000000));
  for (let i = 0; i < tail.length; i += 64) compress(state, tail, i);

  const digest = new Uint8Array(32);
  stateToBytes(state, digest);
  return digest;
}

/**
 * HMAC-SHA256 with the key's padded blocks pre-compressed. PBKDF2 runs the
 * same key through tens of thousands of HMACs, so hoisting those two
 * compressions out of the loop halves the work.
 */
class HmacSha256 {
  private readonly innerState: Uint32Array;
  private readonly outerState: Uint32Array;
  // 32-byte message padded to one block: the only shape PBKDF2's inner loop
  // needs after the first iteration.
  private readonly messageBlock = new Uint8Array(64);
  private readonly digestBlock = new Uint8Array(64);

  constructor(key: Uint8Array) {
    const normalized = key.length > 64 ? sha256(key) : key;
    const inner = new Uint8Array(64);
    const outer = new Uint8Array(64);
    inner.set(normalized);
    outer.set(normalized);
    for (let i = 0; i < 64; i++) {
      inner[i] = inner[i]! ^ 0x36;
      outer[i] = outer[i]! ^ 0x5c;
    }
    this.innerState = INITIAL_STATE.slice();
    compress(this.innerState, inner, 0);
    this.outerState = INITIAL_STATE.slice();
    compress(this.outerState, outer, 0);

    // Both inner and outer messages are always one block after the key block:
    // 64 + n bytes total, so the length field is fixed per shape.
    this.digestBlock[32] = 0x80;
    new DataView(this.digestBlock.buffer).setUint32(60, (64 + 32) * 8);
  }

  /** HMAC of a message of at most 55 bytes (one padded block). */
  digest(message: Uint8Array): Uint8Array {
    // Past 55 bytes the padding needs a second block, and writing the length
    // into this one would silently produce a wrong digest.
    if (message.length > 55) {
      throw new Error(`this HMAC only handles messages up to 55 bytes, got ${message.length}`);
    }
    const state = this.innerState.slice();
    this.messageBlock.fill(0);
    this.messageBlock.set(message);
    this.messageBlock[message.length] = 0x80;
    new DataView(this.messageBlock.buffer).setUint32(60, (64 + message.length) * 8);
    compress(state, this.messageBlock, 0);

    const innerDigest = new Uint8Array(32);
    stateToBytes(state, innerDigest);

    const outer = this.outerState.slice();
    this.digestBlock.set(innerDigest);
    compress(outer, this.digestBlock, 0);
    const result = new Uint8Array(32);
    stateToBytes(outer, result);
    return result;
  }
}

export function pbkdf2Sha256(
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  keyLength: number,
): Uint8Array {
  const hmac = new HmacSha256(password);
  const output = new Uint8Array(keyLength);
  const blocks = Math.ceil(keyLength / 32);
  const seed = new Uint8Array(salt.length + 4);
  seed.set(salt);
  for (let block = 1; block <= blocks; block++) {
    new DataView(seed.buffer).setUint32(salt.length, block);
    let u = hmac.digest(seed);
    const accumulator = u.slice();
    for (let i = 1; i < iterations; i++) {
      u = hmac.digest(u);
      for (let j = 0; j < 32; j++) accumulator[j] = accumulator[j]! ^ u[j]!;
    }
    output.set(accumulator.subarray(0, Math.min(32, keyLength - (block - 1) * 32)), (block - 1) * 32);
  }
  return output;
}

/** workerd's ceiling; above it WebCrypto throws rather than computing. */
export const WORKERD_PBKDF2_LIMIT = 100_000;

const HIGH_ITERATION_KEYS = new WeakMap<CryptoKey, Uint8Array>();

/**
 * Make `crypto.subtle` answer high-iteration PBKDF2 instead of throwing.
 * Everything else — every other algorithm, and PBKDF2 under the limit — goes
 * to the platform untouched. Call once, at module scope, before any code that
 * might destructure `crypto.subtle`.
 */
export function installHighIterationPbkdf2(subtle: SubtleCrypto = crypto.subtle): boolean {
  const originalImportKey = subtle.importKey.bind(subtle);
  const originalDeriveBits = subtle.deriveBits.bind(subtle);

  const importKey = async (
    format: string,
    keyData: BufferSource | JsonWebKey,
    algorithm: unknown,
    extractable: boolean,
    usages: string[],
  ) => {
    const key = await (originalImportKey as (...args: unknown[]) => Promise<CryptoKey>)(
      format,
      keyData,
      algorithm,
      extractable,
      usages,
    );
    // PBKDF2 key material is not extractable, so remember the bytes here or
    // the fallback would have nothing to hash.
    const name = typeof algorithm === "string" ? algorithm : (algorithm as { name?: string })?.name;
    if (name === "PBKDF2" && format === "raw" && ArrayBuffer.isView(keyData)) {
      HIGH_ITERATION_KEYS.set(key, new Uint8Array(keyData.buffer.slice(0) as ArrayBuffer, keyData.byteOffset, keyData.byteLength));
    } else if (name === "PBKDF2" && format === "raw" && keyData instanceof ArrayBuffer) {
      HIGH_ITERATION_KEYS.set(key, new Uint8Array(keyData.slice(0)));
    }
    return key;
  };

  const deriveBits = async (algorithm: unknown, key: CryptoKey, length: number) => {
    const params = algorithm as { name?: string; iterations?: number; salt?: BufferSource; hash?: unknown };
    const hash = typeof params?.hash === "string" ? params.hash : (params?.hash as { name?: string })?.name;
    if (
      params?.name === "PBKDF2" &&
      typeof params.iterations === "number" &&
      params.iterations > WORKERD_PBKDF2_LIMIT &&
      hash === "SHA-256"
    ) {
      const password = HIGH_ITERATION_KEYS.get(key);
      if (!password) {
        throw new Error("high-iteration PBKDF2 needs key material imported through the patched importKey");
      }
      const salt = ArrayBuffer.isView(params.salt!)
        ? new Uint8Array(params.salt.buffer, params.salt.byteOffset, params.salt.byteLength)
        : new Uint8Array(params.salt as ArrayBuffer);
      const derived = pbkdf2Sha256(password, salt, params.iterations, length / 8);
      return derived.buffer.slice(derived.byteOffset, derived.byteOffset + derived.byteLength) as ArrayBuffer;
    }
    return (originalDeriveBits as (...args: unknown[]) => Promise<ArrayBuffer>)(algorithm, key, length);
  };

  try {
    Object.defineProperty(subtle, "importKey", { value: importKey, configurable: true, writable: true });
    Object.defineProperty(subtle, "deriveBits", { value: deriveBits, configurable: true, writable: true });
    return true;
  } catch {
    return false;
  }
}
