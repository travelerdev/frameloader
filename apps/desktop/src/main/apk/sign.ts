// APK Signature Scheme v2 with a self-signed RSA key that Frameloader keeps in
// its user-data folder. Lepton is Android 11, which accepts v2 on its own for
// any minSdk, so there's no JAR (v1) signature here.
//
// Reference: https://source.android.com/docs/security/features/apksigning/v2
import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject, createPrivateKey, createPublicKey } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface SigningKey {
  privateKey: KeyObject;
  /** X.509 certificate, DER. */
  cert: Buffer;
}

// ---- minimal DER ------------------------------------------------------------

function derLen(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLen(body.length), body]);
}

const seq = (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]) => tlv(0x31, Buffer.concat(parts));
const derNull = () => Buffer.from([0x05, 0x00]);
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, "utf8"));
const bitString = (b: Buffer) => tlv(0x03, Buffer.concat([Buffer.from([0]), b]));
const explicit = (n: number, body: Buffer) => tlv(0xa0 | n, body);

function derInt(b: Buffer): Buffer {
  // Positive integer: strip leading zeros, add one back if the high bit is set.
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  let body = b.subarray(i);
  if (body[0]! & 0x80) body = Buffer.concat([Buffer.from([0]), body]);
  return tlv(0x02, body);
}

function oid(s: string): Buffer {
  const parts = s.split(".").map(Number);
  const out: number[] = [parts[0]! * 40 + parts[1]!];
  for (const p of parts.slice(2)) {
    const enc: number[] = [p & 0x7f];
    for (let v = p >> 7; v > 0; v >>= 7) enc.unshift(0x80 | (v & 0x7f));
    out.push(...enc);
  }
  return tlv(0x06, Buffer.from(out));
}

function time(d: Date): Buffer {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const y = d.getUTCFullYear();
  const rest = `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  // UTCTime before 2050, GeneralizedTime after, as X.509 requires.
  return y < 2050 ? tlv(0x17, Buffer.from(`${p(y % 100)}${rest}`)) : tlv(0x18, Buffer.from(`${y}${rest}`));
}

const SHA256_WITH_RSA = seq(oid("1.2.840.113549.1.1.11"), derNull());
const COMMON_NAME = "2.5.4.3";

/** A self-signed certificate for `privateKey`, valid for 30 years. */
export function selfSignedCert(privateKey: KeyObject, cn: string): Buffer {
  const spki = createPublicKey(privateKey).export({ type: "spki", format: "der" }) as Buffer;
  const name = seq(set(seq(oid(COMMON_NAME), utf8(cn))));
  const now = new Date();
  const notBefore = new Date(now.getTime() - 86400e3);
  const notAfter = new Date(now.getTime() + 30 * 365.25 * 86400e3);
  const tbs = seq(
    explicit(0, derInt(Buffer.from([2]))), // v3
    derInt(randomBytes(16)),
    SHA256_WITH_RSA,
    name,
    seq(time(notBefore), time(notAfter)),
    name,
    spki,
  );
  const signer = createSign("RSA-SHA256");
  signer.update(tbs);
  const sig = signer.sign(privateKey);
  return seq(tbs, SHA256_WITH_RSA, bitString(sig));
}

/** Load the signing key from `pemPath` (+ `.cert.der` beside it), generating it on first use. */
export function loadOrCreateSigningKey(pemPath: string): SigningKey {
  const certPath = pemPath.replace(/\.pem$/, "") + ".cert.der";
  if (existsSync(pemPath) && existsSync(certPath)) {
    return { privateKey: createPrivateKey(readFileSync(pemPath)), cert: readFileSync(certPath) };
  }
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const cert = selfSignedCert(privateKey, "Frameloader");
  mkdirSync(dirname(pemPath), { recursive: true });
  writeFileSync(pemPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  writeFileSync(certPath, cert);
  return { privateKey, cert };
}

// ---- v2 signing block ---------------------------------------------------------

const SIG_RSA_PKCS1_SHA256 = 0x0103;
const V2_BLOCK_ID = 0x7109871a;
const CHUNK = 1024 * 1024;

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}

function u64(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n), 0);
  return b;
}

const prefixed = (b: Buffer) => Buffer.concat([u32(b.length), b]);

function findEocd(zip: Buffer): number {
  // No comment is written by ZipWriter, but tolerate one.
  for (let p = zip.length - 22; p >= Math.max(0, zip.length - 22 - 0xffff); p--) {
    if (zip.readUInt32LE(p) === 0x06054b50 && p + 22 + zip.readUInt16LE(p + 20) === zip.length) return p;
  }
  throw new Error("zip has no end-of-central-directory record");
}

/** SHA-256 of the three zip sections, chunked the way the signing scheme defines. */
export function contentDigest(entries: Buffer, centralDir: Buffer, eocd: Buffer): Buffer {
  const chunkDigests: Buffer[] = [];
  for (const section of [entries, centralDir, eocd]) {
    for (let off = 0; off < section.length; off += CHUNK) {
      const part = section.subarray(off, Math.min(off + CHUNK, section.length));
      chunkDigests.push(createHash("sha256").update(Buffer.from([0xa5])).update(u32(part.length)).update(part).digest());
    }
  }
  return createHash("sha256").update(Buffer.from([0x5a])).update(u32(chunkDigests.length)).update(Buffer.concat(chunkDigests)).digest();
}

/** Returns the zip with an APK Signing Block (v2) inserted before the central directory. */
export function signApkV2(zip: Buffer, key: SigningKey): Buffer {
  const eocdOff = findEocd(zip);
  const cdOff = zip.readUInt32LE(eocdOff + 16);
  const cdSize = zip.readUInt32LE(eocdOff + 12);
  if (cdOff + cdSize !== eocdOff) throw new Error("zip already has data between the central directory and its end record");
  const entries = zip.subarray(0, cdOff);
  const centralDir = zip.subarray(cdOff, eocdOff);

  const build = (digest: Buffer): Buffer => {
    const digests = prefixed(prefixed(Buffer.concat([u32(SIG_RSA_PKCS1_SHA256), prefixed(digest)])));
    const certs = prefixed(prefixed(key.cert));
    const attrs = prefixed(Buffer.alloc(0));
    const signedData = Buffer.concat([digests, certs, attrs]);
    const signer = createSign("RSA-SHA256");
    signer.update(signedData);
    const sig = signer.sign(key.privateKey);
    const signatures = prefixed(prefixed(Buffer.concat([u32(SIG_RSA_PKCS1_SHA256), prefixed(sig)])));
    const pub = prefixed(createPublicKey(key.privateKey).export({ type: "spki", format: "der" }) as Buffer);
    const signer1 = prefixed(Buffer.concat([prefixed(signedData), signatures, pub]));
    const value = prefixed(signer1);
    const pair = Buffer.concat([u64(4 + value.length), u32(V2_BLOCK_ID), value]);
    const blockSize = pair.length + 8 + 16;
    return Buffer.concat([u64(blockSize), pair, u64(blockSize), Buffer.from("APK Sig Block 42", "latin1")]);
  };
  // The digest covers the EOCD with its central-directory offset pointing at
  // the signing block, i.e. the unsigned file's EOCD as it is; the written
  // EOCD then points past the block.
  const block = build(contentDigest(entries, centralDir, zip.subarray(eocdOff)));
  const eocd = Buffer.from(zip.subarray(eocdOff));
  eocd.writeUInt32LE(cdOff + block.length, 16);
  return Buffer.concat([entries, block, centralDir, eocd]);
}
