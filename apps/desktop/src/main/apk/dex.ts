// Small, surgical edits to Dalvik bytecode: blank out calls to methods that
// Lepton's trimmed Android can't serve. Only void methods are touched, so a
// 3-unit invoke becomes three nops and the verifier stays happy.
//
// Format reference: https://source.android.com/docs/core/runtime/dex-format
import { createHash } from "node:crypto";

function adler32(b: Buffer): number {
  let a = 1;
  let s = 0;
  for (let i = 0; i < b.length; i++) {
    a = (a + b[i]!) % 65521;
    s = (s + a) % 65521;
  }
  return ((s << 16) | a) >>> 0;
}

export interface MethodRef {
  /** Type descriptor, e.g. "Landroid/content/ClipboardManager;". */
  class: string;
  name: string;
}

/**
 * Lepton ships no clipboard service, so getSystemService(CLIPBOARD_SERVICE)
 * returns null and any app that registers a clip-changed listener on it
 * crashes (SDL2/SDL3's SDLActivity does so in onCreate). Dropping the calls
 * costs nothing, since there is no clipboard to listen to.
 */
export const LEPTON_CLIPBOARD_CALLS: MethodRef[] = [
  { class: "Landroid/content/ClipboardManager;", name: "addPrimaryClipChangedListener" },
  { class: "Landroid/content/ClipboardManager;", name: "removePrimaryClipChangedListener" },
];

// Instruction widths in 16-bit code units, by opcode (payload pseudo-ops handled separately).
const WIDTH = new Uint8Array(256);
(() => {
  const set = (from: number, to: number, w: number) => {
    for (let o = from; o <= to; o++) WIDTH[o] = w;
  };
  set(0x00, 0xff, 1);
  set(0x02, 0x02, 2); set(0x03, 0x03, 3); set(0x05, 0x05, 2); set(0x06, 0x06, 3); set(0x08, 0x08, 2); set(0x09, 0x09, 3);
  set(0x13, 0x13, 2); set(0x14, 0x14, 3); set(0x15, 0x17, 2); set(0x17, 0x17, 3); set(0x18, 0x18, 5); set(0x19, 0x1a, 2); set(0x1b, 0x1b, 3); set(0x1c, 0x1c, 2);
  set(0x1f, 0x20, 2); set(0x22, 0x23, 2); set(0x24, 0x26, 3); set(0x29, 0x29, 2); set(0x2a, 0x2c, 3);
  set(0x2d, 0x3d, 2); set(0x44, 0x6d, 2); set(0x6e, 0x72, 3); set(0x74, 0x78, 3);
  set(0x90, 0xaf, 2); set(0xd0, 0xe2, 2);
  set(0xfa, 0xfb, 4); set(0xfc, 0xfd, 3); set(0xfe, 0xff, 2);
})();

const INVOKE_VIRTUAL = 0x6e;
const INVOKE_VIRTUAL_RANGE = 0x74;

function uleb128(buf: Buffer, off: number): [number, number] {
  let result = 0;
  let shift = 0;
  for (;;) {
    const b = buf[off++]!;
    result |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return [result >>> 0, off];
    shift += 7;
  }
}

function readString(buf: Buffer, off: number): string {
  // string_data_item: uleb128 utf16 length, then MUTF-8 bytes up to a NUL.
  const [, start] = uleb128(buf, off);
  const end = buf.indexOf(0, start);
  return buf.toString("latin1", start, end); // descriptors and method names are ASCII
}

/** Width of the instruction at `off` (within insns), or of a switch/array payload. */
function insnWidth(buf: Buffer, off: number): number {
  const op = buf[off]!;
  if (op === 0x00) {
    const kind = buf[off + 1]!;
    if (kind === 0x01) return 4 + buf.readUInt16LE(off + 2) * 2; // packed-switch-payload
    if (kind === 0x02) return 2 + buf.readUInt16LE(off + 2) * 4; // sparse-switch-payload
    if (kind === 0x03) return 4 + Math.ceil((buf.readUInt16LE(off + 2) * buf.readUInt32LE(off + 4)) / 2); // fill-array-data-payload
  }
  return WIDTH[op]!;
}

/** Method ids in `dex` that name one of `targets`. */
function methodIndices(dex: Buffer, targets: MethodRef[]): Set<number> {
  if (dex.toString("latin1", 0, 4) !== "dex\n") throw new Error("not a dex file");
  const stringIdsSize = dex.readUInt32LE(0x38);
  const stringIdsOff = dex.readUInt32LE(0x3c);
  const typeIdsSize = dex.readUInt32LE(0x40);
  const typeIdsOff = dex.readUInt32LE(0x44);
  const methodIdsSize = dex.readUInt32LE(0x58);
  const methodIdsOff = dex.readUInt32LE(0x5c);

  const wanted = new Map<string, number>(); // string -> string idx
  const need = new Set<string>(targets.flatMap((t) => [t.class, t.name]));
  for (let i = 0; i < stringIdsSize && wanted.size < need.size; i++) {
    const s = readString(dex, dex.readUInt32LE(stringIdsOff + i * 4));
    if (need.has(s)) wanted.set(s, i);
  }
  const typeIdx = new Map<number, string>(); // type idx -> descriptor
  for (let i = 0; i < typeIdsSize; i++) {
    const d = dex.readUInt32LE(typeIdsOff + i * 4);
    for (const [s, idx] of wanted) if (idx === d && s.startsWith("L")) typeIdx.set(i, s);
  }
  const methods = new Set<number>();
  for (let i = 0; i < methodIdsSize; i++) {
    const p = methodIdsOff + i * 8;
    const cls = typeIdx.get(dex.readUInt16LE(p));
    if (!cls) continue;
    const nameIdx = dex.readUInt32LE(p + 4);
    if (targets.some((t) => t.class === cls && wanted.get(t.name) === nameIdx)) methods.add(i);
  }
  return methods;
}

/** Call `visit` for every method that has code, with its method id and code_item offset. */
function forEachCode(dex: Buffer, visit: (methodIdx: number, codeOff: number) => void): void {
  const classDefsSize = dex.readUInt32LE(0x60);
  const classDefsOff = dex.readUInt32LE(0x64);
  for (let c = 0; c < classDefsSize; c++) {
    const dataOff = dex.readUInt32LE(classDefsOff + c * 32 + 24);
    if (!dataOff) continue;
    let p = dataOff;
    let staticFields: number, instanceFields: number, direct: number, virtual: number;
    [staticFields, p] = uleb128(dex, p);
    [instanceFields, p] = uleb128(dex, p);
    [direct, p] = uleb128(dex, p);
    [virtual, p] = uleb128(dex, p);
    for (let i = 0; i < staticFields + instanceFields; i++) {
      [, p] = uleb128(dex, p);
      [, p] = uleb128(dex, p);
    }
    let idx = 0;
    for (let i = 0; i < direct + virtual; i++) {
      if (i === direct) idx = 0; // method_idx_diff restarts for the virtual list
      let diff: number, codeOff: number;
      [diff, p] = uleb128(dex, p);
      [, p] = uleb128(dex, p);
      [codeOff, p] = uleb128(dex, p);
      idx += diff;
      if (codeOff) visit(idx, codeOff);
    }
  }
}

/** Replace invoke-virtual calls to `targets` with nops, in place. Returns how many calls were blanked. */
export function nopVoidCalls(dex: Buffer, targets: MethodRef[]): number {
  const methods = methodIndices(dex, targets);
  if (!methods.size) return 0;
  let patched = 0;
  forEachCode(dex, (_, codeOff) => {
    const insnsSize = dex.readUInt32LE(codeOff + 12);
    const start = codeOff + 16;
    const end = start + insnsSize * 2;
    for (let p = start; p < end; ) {
      const w = insnWidth(dex, p);
      const op = dex[p]!;
      if ((op === INVOKE_VIRTUAL || op === INVOKE_VIRTUAL_RANGE) && methods.has(dex.readUInt16LE(p + 2))) {
        dex.fill(0, p, p + 6);
        patched++;
      }
      p += w * 2;
    }
  });
  if (patched) fixChecksums(dex);
  return patched;
}

/** True when `dex` defines (has code for) any of `targets`. */
export function definesMethod(dex: Buffer, targets: MethodRef[]): boolean {
  const methods = methodIndices(dex, targets);
  if (!methods.size) return false;
  let found = false;
  forEachCode(dex, (idx) => {
    if (methods.has(idx)) found = true;
  });
  return found;
}

/**
 * Unity's Oculus XR Plugin decides whether it's on a Quest with
 * `Build.MANUFACTURER.toLowerCase().contains("oculus")`, and when it isn't,
 * quits the app ("attempting to run on a non-Oculus device"). Lepton reports
 * Valve as the manufacturer and overrides any injected ro.product.manufacturer.
 */
export const UNITY_OCULUS_CHECK: MethodRef = { class: "Lcom/unity/oculus/OculusUnity;", name: "getIsOnOculusHardware" };

/**
 * Rewrite the bodies of boolean methods in `targets` to `return true`, in
 * place (const/4 v0, #1; return v0; the rest nops). Skips methods that
 * don't return boolean, have try blocks, or are too short. Returns how many
 * were rewritten.
 */
export function forceReturnTrue(dex: Buffer, targets: MethodRef[]): number {
  const methods = methodIndices(dex, targets);
  if (!methods.size) return 0;
  const methodIdsOff = dex.readUInt32LE(0x5c);
  const protoIdsOff = dex.readUInt32LE(0x4c);
  const stringIdsOff = dex.readUInt32LE(0x3c);
  let patched = 0;
  forEachCode(dex, (idx, codeOff) => {
    if (!methods.has(idx)) return;
    const proto = dex.readUInt16LE(methodIdsOff + idx * 8 + 2);
    const shorty = readString(dex, dex.readUInt32LE(stringIdsOff + dex.readUInt32LE(protoIdsOff + proto * 12) * 4));
    const registers = dex.readUInt16LE(codeOff);
    const tries = dex.readUInt16LE(codeOff + 6);
    const insns = dex.readUInt32LE(codeOff + 12);
    if (shorty[0] !== "Z" || registers < 1 || tries !== 0 || insns < 2) return;
    const start = codeOff + 16;
    dex.fill(0, start, start + insns * 2);
    dex.writeUInt16LE(0x1012, start); // const/4 v0, #1
    dex.writeUInt16LE(0x000f, start + 2); // return v0
    patched++;
  });
  if (patched) fixChecksums(dex);
  return patched;
}

/** Recompute the header's SHA-1 signature and Adler-32 checksum after editing. */
export function fixChecksums(dex: Buffer): void {
  createHash("sha1").update(dex.subarray(32)).digest().copy(dex, 12);
  dex.writeUInt32LE(adler32(dex.subarray(12)) >>> 0, 8);
}
