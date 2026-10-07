// Executable sniffing by header, not by file name.
import { openSync, readSync, closeSync, statSync } from "node:fs";
import type { ExecArch } from "../../shared/ipc";

export interface BinaryInfo {
  format: "pe" | "elf" | "script";
  arch: ExecArch;
  /** false for DLLs and shared libraries. */
  executable: boolean;
}

export function readHead(path: string, max = 65536): Buffer {
  const fd = openSync(path, "r");
  try {
    const size = Math.min(max, statSync(path).size);
    const buf = Buffer.alloc(size);
    let off = 0;
    while (off < size) {
      const n = readSync(fd, buf, off, size - off, off);
      if (n <= 0) break;
      off += n;
    }
    return buf.subarray(0, off);
  } finally {
    closeSync(fd);
  }
}

export function sniffBinary(buf: Buffer): BinaryInfo | null {
  if (buf.length >= 2 && buf[0] === 0x23 && buf[1] === 0x21) return { format: "script", arch: "other", executable: true };
  if (buf.length >= 64 && buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) return sniffElf(buf);
  if (buf.length >= 0x40 && buf[0] === 0x4d && buf[1] === 0x5a) return sniffPe(buf);
  return null;
}

function sniffElf(buf: Buffer): BinaryInfo | null {
  const is64 = buf[4] === 2;
  const le = buf[5] === 1;
  const u16 = (o: number) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const u64 = (o: number) => Number(le ? buf.readBigUInt64LE(o) : buf.readBigUInt64BE(o));
  const type = u16(16);
  const machine = u16(18);
  const arch: ExecArch = machine === 0xb7 ? "arm64" : machine === 0x3e ? "x86-64" : machine === 0x28 ? "arm" : machine === 0x03 ? "x86" : "other";
  if (type === 2) return { format: "elf", arch, executable: true };
  if (type !== 3) return { format: "elf", arch, executable: false };
  // ET_DYN: a PIE executable has PT_INTERP, a shared library usually doesn't.
  const phoff = is64 ? u64(32) : u32(28);
  const phentsize = u16(is64 ? 54 : 42);
  const phnum = u16(is64 ? 56 : 44);
  let interp = false;
  for (let i = 0; i < phnum; i++) {
    const o = phoff + i * phentsize;
    if (o + 4 > buf.length) break;
    if (u32(o) === 3) {
      interp = true;
      break;
    }
  }
  return { format: "elf", arch, executable: interp };
}

function sniffPe(buf: Buffer): BinaryInfo | null {
  const lfanew = buf.readUInt32LE(0x3c);
  if (lfanew + 24 > buf.length) return null;
  if (buf.readUInt32LE(lfanew) !== 0x00004550) return null; // "PE\0\0"
  const machine = buf.readUInt16LE(lfanew + 4);
  const characteristics = buf.readUInt16LE(lfanew + 22);
  const arch: ExecArch = machine === 0x8664 ? "x86-64" : machine === 0x14c ? "x86" : machine === 0xaa64 ? "arm64" : "other";
  const isDll = (characteristics & 0x2000) !== 0;
  return { format: "pe", arch, executable: !isDll };
}
