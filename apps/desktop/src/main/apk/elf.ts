// Just enough ELF (64-bit little-endian AArch64, as in an APK's lib/arm64-v8a)
// to map addresses to file offsets and list a library's dependencies.

export interface Segment {
  offset: number;
  vaddr: number;
  filesz: number;
  exec: boolean;
}

/** PT_LOAD segments of an AArch64 ELF64 file, or undefined for anything else. */
export function elfLoadSegments(so: Buffer): Segment[] | undefined {
  if (so.length < 64 || so.readUInt32BE(0) !== 0x7f454c46 || so[4] !== 2 || so[5] !== 1 || so.readUInt16LE(18) !== 0xb7) return undefined;
  const phoff = Number(so.readBigUInt64LE(32));
  const phentsize = so.readUInt16LE(54);
  const phnum = so.readUInt16LE(56);
  const out: Segment[] = [];
  for (let i = 0; i < phnum; i++) {
    const p = phoff + i * phentsize;
    if (p + 56 > so.length || so.readUInt32LE(p) !== 1) continue; // PT_LOAD
    out.push({ offset: Number(so.readBigUInt64LE(p + 8)), vaddr: Number(so.readBigUInt64LE(p + 16)), filesz: Number(so.readBigUInt64LE(p + 32)), exec: (so.readUInt32LE(p + 4) & 1) !== 0 });
  }
  return out;
}

export function vaddrToOffset(segs: Segment[], vaddr: number): number | undefined {
  const g = segs.find((s) => vaddr >= s.vaddr && vaddr < s.vaddr + s.filesz);
  return g ? vaddr - g.vaddr + g.offset : undefined;
}

/** DT_NEEDED entries: the libraries this one links against. Empty when it can't be read. */
export function elfNeeded(so: Buffer): string[] {
  const segs = elfLoadSegments(so);
  if (!segs) return [];
  const phoff = Number(so.readBigUInt64LE(32));
  const phentsize = so.readUInt16LE(54);
  const phnum = so.readUInt16LE(56);
  for (let i = 0; i < phnum; i++) {
    const p = phoff + i * phentsize;
    if (p + 56 > so.length || so.readUInt32LE(p) !== 2) continue; // PT_DYNAMIC
    const off = Number(so.readBigUInt64LE(p + 8));
    const size = Number(so.readBigUInt64LE(p + 32));
    const needed: number[] = [];
    let strtab: number | undefined;
    for (let q = off; q + 16 <= Math.min(off + size, so.length); q += 16) {
      const tag = Number(so.readBigInt64LE(q));
      const val = Number(so.readBigUInt64LE(q + 8));
      if (tag === 0) break;
      if (tag === 1) needed.push(val);
      else if (tag === 5) strtab = val;
    }
    const base = strtab === undefined ? undefined : vaddrToOffset(segs, strtab);
    if (base === undefined) return [];
    return needed.map((n) => so.toString("latin1", base + n, so.indexOf(0, base + n)));
  }
  return [];
}
