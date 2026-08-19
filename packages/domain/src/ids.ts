// UUIDv7 helpers (_DECISIONS.md §4: UUIDv7 everywhere; time-ordered).
// Zero dependencies: uses globalThis.crypto (Node 20+/browsers). Time and
// randomness are injectable so tests stay deterministic (32 §12).

export interface Uuidv7Options {
  /** Unix epoch milliseconds; defaults to Date.now(). */
  now?: number;
  /** Fills a byte array with randomness; defaults to crypto.getRandomValues. */
  random?: (byteLength: number) => Uint8Array;
}

const HEX = "0123456789abcdef";

function defaultRandom(byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/** RFC 9562 UUIDv7: 48-bit unix-ms timestamp, version 7, variant 10. */
export function uuidv7(options: Uuidv7Options = {}): string {
  const now = options.now ?? Date.now();
  const random = options.random ?? defaultRandom;
  if (!Number.isInteger(now) || now < 0 || now > 2 ** 48 - 1) {
    throw new RangeError(`uuidv7: timestamp out of range: ${now}`);
  }

  const bytes = new Uint8Array(16);
  // 48-bit big-endian timestamp
  bytes[0] = (now / 2 ** 40) & 0xff;
  bytes[1] = (now / 2 ** 32) & 0xff;
  bytes[2] = (now / 2 ** 24) & 0xff;
  bytes[3] = (now / 2 ** 16) & 0xff;
  bytes[4] = (now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;
  bytes.set(random(10), 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10

  let out = "";
  for (let i = 0; i < 16; i++) {
    if (i === 4 || i === 6 || i === 8 || i === 10) out += "-";
    out += HEX[bytes[i]! >> 4]! + HEX[bytes[i]! & 0x0f]!;
  }
  return out;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function isUuidv7(value: string): boolean {
  return isUuid(value) && value[14] === "7";
}

/** Extracts the unix-ms timestamp embedded in a UUIDv7. */
export function uuidv7Timestamp(id: string): number {
  if (!isUuidv7(id)) throw new RangeError(`not a UUIDv7: ${id}`);
  return Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}

// ---------------------------------------------------------------------------
// UUIDv5 (RFC 9562 name-based, SHA-1) — pure JS, no crypto module, so it is
// safe inside Temporal workflow code (08 §2: stepId = uuidv5(sessionId,
// String(stepNo)) must be computable deterministically in-workflow).

function sha1(bytes: Uint8Array): Uint8Array {
  const ml = bytes.length;
  const withOne = ml + 1;
  const padded = new Uint8Array(Math.ceil((withOne + 8) / 64) * 64);
  padded.set(bytes);
  padded[ml] = 0x80;
  const bitLen = ml * 8;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000), false);
  dv.setUint32(padded.length - 4, bitLen >>> 0, false);

  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  const rotl = (x: number, n: number) => ((x << n) | (x >>> (32 - n))) >>> 0;

  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(block + i * 4, false);
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!, 1);
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number, k: number;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const temp = (rotl(a, 5) + f + e + k + w[i]!) >>> 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = temp;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  const out = new Uint8Array(20);
  const outDv = new DataView(out.buffer);
  outDv.setUint32(0, h0, false); outDv.setUint32(4, h1, false);
  outDv.setUint32(8, h2, false); outDv.setUint32(12, h3, false);
  outDv.setUint32(16, h4, false);
  return out;
}

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** RFC 9562 name-based UUID (version 5). `namespace` must be a UUID. */
export function uuidv5(name: string, namespace: string): string {
  if (!isUuid(namespace)) throw new RangeError(`uuidv5: namespace is not a uuid: ${namespace}`);
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(16 + nameBytes.length);
  input.set(uuidToBytes(namespace));
  input.set(nameBytes, 16);
  const hash = sha1(input).slice(0, 16);
  hash[6] = (hash[6]! & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8]! & 0x3f) | 0x80; // RFC variant
  const hex = [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
