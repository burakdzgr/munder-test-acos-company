// Auth crypto primitives (18 §2, ADR-013): Argon2id, opaque tokens, RFC 6238
// TOTP, and sealed-box encryption of TOTP secrets under MASTER_KEY.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";
import sodium from "libsodium-wrappers";

/** OWASP-aligned baseline (18 §2): m=64MiB, t=3, p=4 — stored per-hash. */
const ARGON2_OPTIONS = { memoryCost: 65536, timeCost: 3, parallelism: 4 };

export function hashPassword(password: string): Promise<string> {
  return argon2Hash(password, ARGON2_OPTIONS);
}

export function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2Verify(hash, password).catch(() => false);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Opaque 256-bit random id, base64url. */
export function opaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

// ---------- sealed boxes (MASTER_KEY envelope, 18 §7) ----------

let keypair: { publicKey: Uint8Array; privateKey: Uint8Array } | null = null;

async function sealKeypair(masterKeyBase64: string) {
  await sodium.ready;
  if (!keypair) {
    const seed = Buffer.from(masterKeyBase64, "base64");
    keypair = sodium.crypto_box_seed_keypair(seed);
  }
  return keypair;
}

export async function sealSecret(masterKeyBase64: string, plaintext: string): Promise<Buffer> {
  const kp = await sealKeypair(masterKeyBase64);
  return Buffer.from(sodium.crypto_box_seal(Buffer.from(plaintext), kp.publicKey));
}

export async function unsealSecret(masterKeyBase64: string, ciphertext: Buffer): Promise<string> {
  const kp = await sealKeypair(masterKeyBase64);
  return Buffer.from(
    sodium.crypto_box_seal_open(ciphertext, kp.publicKey, kp.privateKey),
  ).toString();
}

// ---------- TOTP (RFC 6238, 30s step, ±1 window — 18 §2) ----------

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(encoded: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of encoded.replace(/=+$/, "").toUpperCase()) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error("invalid base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpCode(secretBase32: string, timestampMs: number, stepOffset = 0): string {
  const counter = Math.floor(timestampMs / 30_000) + stepOffset;
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32Decode(secretBase32)).update(counterBuf).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, "0");
}

/** ±1 window (18 §2). */
export function verifyTotp(secretBase32: string, code: string, timestampMs = Date.now()): boolean {
  return [-1, 0, 1].some((offset) =>
    constantTimeEqual(totpCode(secretBase32, timestampMs, offset), code),
  );
}

export function otpauthUrl(email: string, secretBase32: string): string {
  return `otpauth://totp/ACOS:${encodeURIComponent(email)}?secret=${secretBase32}&issuer=ACOS&period=30&digits=6`;
}
