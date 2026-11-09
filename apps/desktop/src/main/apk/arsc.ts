// resources.arsc: parse the resource table, merge the tables of config splits
// (density, language, …) into the base's, and write it back out.
//
// A split's table has the same package, type ids and resource ids as the base;
// it only carries entries for its own configurations. Merging means: add the
// split's type chunks (one per configuration) to the base package, pointing
// their key names and string values at the base's string pools.
//
// Format reference: frameworks/base/libs/androidfw/include/androidfw/ResourceTypes.h

const RES_STRING_POOL_TYPE = 0x0001;
const RES_TABLE_TYPE = 0x0002;
const RES_TABLE_PACKAGE_TYPE = 0x0200;
const RES_TABLE_TYPE_TYPE = 0x0201;
const RES_TABLE_TYPE_SPEC_TYPE = 0x0202;

const POOL_SORTED = 1 << 0;
const POOL_UTF8 = 1 << 8;

const TYPE_FLAG_SPARSE = 0x01;
const TYPE_FLAG_OFFSET16 = 0x02;

const ENTRY_FLAG_COMPLEX = 0x0001;
const ENTRY_FLAG_COMPACT = 0x0008;

const NO_ENTRY = 0xffffffff;
const SPAN_END = 0xffffffff;

export const TYPE_STRING = 0x03;

export interface Span {
  name: number;
  firstChar: number;
  lastChar: number;
}

export interface StringPool {
  strings: string[];
  /** Parallel to `strings` for the first styles.length entries; empty array = no spans. */
  styles: Span[][];
  utf8: boolean;
  sorted: boolean;
}

export interface ResValue {
  dataType: number;
  data: number;
}

export interface MapItem {
  name: number;
  value: ResValue;
}

export interface Entry {
  flags: number;
  key: number;
  /** Simple entry value. */
  value?: ResValue;
  /** Complex (bag) entry. */
  parent?: number;
  items?: MapItem[];
}

export interface TypeChunk {
  typeId: number;
  /** Raw ResTable_config bytes, size prefix included. */
  config: Buffer;
  entries: (Entry | null)[];
}

export interface TypeSpec {
  typeId: number;
  flags: number[];
}

export interface Package {
  id: number;
  name: string;
  typeStrings: StringPool;
  keyStrings: StringPool;
  specs: Map<number, TypeSpec>;
  types: TypeChunk[];
  /** Chunks we don't interpret (libraries, overlayables, staged aliases), copied verbatim. */
  extra: Buffer[];
}

export interface ResTable {
  strings: StringPool;
  packages: Package[];
}

// ---- reading ---------------------------------------------------------------

function readPool(buf: Buffer, off: number): StringPool {
  if (buf.readUInt16LE(off) !== RES_STRING_POOL_TYPE) throw new Error("expected a string pool");
  const count = buf.readUInt32LE(off + 8);
  const styleCount = buf.readUInt32LE(off + 12);
  const flags = buf.readUInt32LE(off + 16);
  const stringsStart = off + buf.readUInt32LE(off + 20);
  const stylesStart = off + buf.readUInt32LE(off + 24);
  const utf8 = (flags & POOL_UTF8) !== 0;
  const strings: string[] = [];
  for (let i = 0; i < count; i++) {
    let p = stringsStart + buf.readUInt32LE(off + 28 + i * 4);
    if (utf8) {
      let n = buf[p]!;
      p += n & 0x80 ? 2 : 1;
      n = buf[p]!;
      if (n & 0x80) {
        n = ((n & 0x7f) << 8) | buf[p + 1]!;
        p += 2;
      } else p += 1;
      strings.push(buf.toString("utf8", p, p + n));
    } else {
      let n = buf.readUInt16LE(p);
      p += 2;
      if (n & 0x8000) {
        n = ((n & 0x7fff) << 16) | buf.readUInt16LE(p);
        p += 2;
      }
      strings.push(buf.toString("utf16le", p, p + n * 2));
    }
  }
  const styles: Span[][] = [];
  for (let i = 0; i < styleCount; i++) {
    let p = stylesStart + buf.readUInt32LE(off + 28 + count * 4 + i * 4);
    const spans: Span[] = [];
    while (buf.readUInt32LE(p) !== SPAN_END) {
      spans.push({ name: buf.readUInt32LE(p), firstChar: buf.readUInt32LE(p + 4), lastChar: buf.readUInt32LE(p + 8) });
      p += 12;
    }
    styles.push(spans);
  }
  return { strings, styles, utf8, sorted: (flags & POOL_SORTED) !== 0 };
}

function readValue(buf: Buffer, p: number): ResValue {
  return { dataType: buf[p + 3]!, data: buf.readUInt32LE(p + 4) };
}

function readEntry(buf: Buffer, p: number): Entry {
  const flags = buf.readUInt16LE(p + 2);
  if (flags & ENTRY_FLAG_COMPACT) {
    // { u16 key; u16 flags; u32 data } with the data type in the high byte of flags.
    return { flags: flags & ~ENTRY_FLAG_COMPACT & 0xff, key: buf.readUInt16LE(p), value: { dataType: flags >> 8, data: buf.readUInt32LE(p + 4) } };
  }
  const size = buf.readUInt16LE(p);
  const key = buf.readUInt32LE(p + 4);
  if (flags & ENTRY_FLAG_COMPLEX) {
    const parent = buf.readUInt32LE(p + 8);
    const count = buf.readUInt32LE(p + 12);
    const items: MapItem[] = [];
    let q = p + size;
    for (let i = 0; i < count; i++, q += 12) items.push({ name: buf.readUInt32LE(q), value: readValue(buf, q + 4) });
    return { flags, key, parent, items };
  }
  return { flags, key, value: readValue(buf, p + size) };
}

function readPackage(buf: Buffer, off: number): Package {
  const size = buf.readUInt32LE(off + 4);
  const headerSize = buf.readUInt16LE(off + 2);
  const id = buf.readUInt32LE(off + 8);
  const name = buf.toString("utf16le", off + 12, off + 12 + 256).replace(/\0[\s\S]*$/, "");
  const typeStringsOff = buf.readUInt32LE(off + 268);
  const keyStringsOff = buf.readUInt32LE(off + 276);
  const pkg: Package = {
    id,
    name,
    typeStrings: readPool(buf, off + typeStringsOff),
    keyStrings: readPool(buf, off + keyStringsOff),
    specs: new Map(),
    types: [],
    extra: [],
  };
  let p = off + headerSize;
  const end = off + size;
  while (p + 8 <= end) {
    const type = buf.readUInt16LE(p);
    const chunkHeader = buf.readUInt16LE(p + 2);
    const chunkSize = buf.readUInt32LE(p + 4);
    if (chunkSize < 8) throw new Error("corrupt resource table chunk");
    if (type === RES_STRING_POOL_TYPE) {
      /* the type/key pools, already read */
    } else if (type === RES_TABLE_TYPE_SPEC_TYPE) {
      const typeId = buf[p + 8]!;
      const entryCount = buf.readUInt32LE(p + 12);
      const flags: number[] = [];
      for (let i = 0; i < entryCount; i++) flags.push(buf.readUInt32LE(p + chunkHeader + i * 4));
      pkg.specs.set(typeId, { typeId, flags });
    } else if (type === RES_TABLE_TYPE_TYPE) {
      const typeId = buf[p + 8]!;
      const tflags = buf[p + 9]!;
      const entryCount = buf.readUInt32LE(p + 12);
      const entriesStart = p + buf.readUInt32LE(p + 16);
      const configSize = buf.readUInt32LE(p + 20);
      const config = Buffer.from(buf.subarray(p + 20, p + 20 + configSize));
      const specCount = pkg.specs.get(typeId)?.flags.length ?? entryCount;
      const entries: (Entry | null)[] = new Array(Math.max(specCount, entryCount)).fill(null);
      const offsets = p + chunkHeader;
      if (tflags & TYPE_FLAG_SPARSE) {
        for (let i = 0; i < entryCount; i++) {
          const idx = buf.readUInt16LE(offsets + i * 4);
          const rel = buf.readUInt16LE(offsets + i * 4 + 2) * 4;
          entries[idx] = readEntry(buf, entriesStart + rel);
        }
      } else if (tflags & TYPE_FLAG_OFFSET16) {
        for (let i = 0; i < entryCount; i++) {
          const rel = buf.readUInt16LE(offsets + i * 2);
          if (rel !== 0xffff) entries[i] = readEntry(buf, entriesStart + rel * 4);
        }
      } else {
        for (let i = 0; i < entryCount; i++) {
          const rel = buf.readUInt32LE(offsets + i * 4);
          if (rel !== NO_ENTRY) entries[i] = readEntry(buf, entriesStart + rel);
        }
      }
      pkg.types.push({ typeId, config, entries });
    } else {
      pkg.extra.push(Buffer.from(buf.subarray(p, p + chunkSize)));
    }
    p += chunkSize;
  }
  return pkg;
}

export function parseArsc(buf: Buffer): ResTable {
  if (buf.readUInt16LE(0) !== RES_TABLE_TYPE) throw new Error("not a resource table");
  const headerSize = buf.readUInt16LE(2);
  const total = buf.readUInt32LE(4);
  let strings: StringPool | undefined;
  const packages: Package[] = [];
  let p = headerSize;
  while (p + 8 <= total) {
    const type = buf.readUInt16LE(p);
    const size = buf.readUInt32LE(p + 4);
    if (size < 8) throw new Error("corrupt resource table chunk");
    if (type === RES_STRING_POOL_TYPE) strings = readPool(buf, p);
    else if (type === RES_TABLE_PACKAGE_TYPE) packages.push(readPackage(buf, p));
    p += size;
  }
  if (!strings) throw new Error("resource table has no string pool");
  return { strings, packages };
}

// ---- writing ---------------------------------------------------------------

function chunkHeader(type: number, headerSize: number, size: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeUInt16LE(type, 0);
  b.writeUInt16LE(headerSize, 2);
  b.writeUInt32LE(size, 4);
  return b;
}

function pad4(b: Buffer): Buffer {
  const rem = b.length % 4;
  return rem ? Buffer.concat([b, Buffer.alloc(4 - rem)]) : b;
}

function encodeString(s: string, utf8: boolean): Buffer {
  if (utf8) {
    const bytes = Buffer.from(s, "utf8");
    const units = Buffer.from(s, "utf16le").length / 2;
    const len = (n: number) => (n > 0x7f ? Buffer.from([0x80 | (n >> 8), n & 0xff]) : Buffer.from([n]));
    return Buffer.concat([len(units), len(bytes.length), bytes, Buffer.from([0])]);
  }
  const bytes = Buffer.from(s, "utf16le");
  const units = bytes.length / 2;
  const len = Buffer.alloc(units > 0x7fff ? 4 : 2);
  if (units > 0x7fff) {
    len.writeUInt16LE(0x8000 | (units >> 16), 0);
    len.writeUInt16LE(units & 0xffff, 2);
  } else len.writeUInt16LE(units, 0);
  return Buffer.concat([len, bytes, Buffer.alloc(2)]);
}

export function writePool(pool: StringPool): Buffer {
  // UTF-8 pools can't hold strings over 32767 bytes; aapt2 switches such pools to UTF-16, and so do we.
  const utf8 = pool.utf8 && pool.strings.every((s) => s.length <= 0x7fff && Buffer.byteLength(s, "utf8") <= 0x7fff);
  const strOffsets: number[] = [];
  const strParts: Buffer[] = [];
  let pos = 0;
  for (const s of pool.strings) {
    const e = encodeString(s, utf8);
    strOffsets.push(pos);
    strParts.push(e);
    pos += e.length;
  }
  const stringsData = pad4(Buffer.concat(strParts));
  const styleOffsets: number[] = [];
  const styleParts: Buffer[] = [];
  pos = 0;
  for (const spans of pool.styles) {
    styleOffsets.push(pos);
    const b = Buffer.alloc(spans.length * 12 + 4);
    spans.forEach((sp, i) => {
      b.writeUInt32LE(sp.name, i * 12);
      b.writeUInt32LE(sp.firstChar, i * 12 + 4);
      b.writeUInt32LE(sp.lastChar, i * 12 + 8);
    });
    b.writeUInt32LE(SPAN_END, spans.length * 12);
    styleParts.push(b);
    pos += b.length;
  }
  if (pool.styles.length) {
    // aapt terminates the style block with two more END markers.
    const tail = Buffer.alloc(8, 0xff);
    styleParts.push(tail);
    pos += 8;
  }
  const stylesData = Buffer.concat(styleParts);
  const headerSize = 28;
  const offsetsSize = (strOffsets.length + styleOffsets.length) * 4;
  const stringsStart = headerSize + offsetsSize;
  const stylesStart = pool.styles.length ? stringsStart + stringsData.length : 0;
  const size = stringsStart + stringsData.length + stylesData.length;
  const head = Buffer.alloc(headerSize);
  head.writeUInt16LE(RES_STRING_POOL_TYPE, 0);
  head.writeUInt16LE(headerSize, 2);
  head.writeUInt32LE(size, 4);
  head.writeUInt32LE(pool.strings.length, 8);
  head.writeUInt32LE(pool.styles.length, 12);
  head.writeUInt32LE((utf8 ? POOL_UTF8 : 0) | (pool.sorted ? POOL_SORTED : 0), 16);
  head.writeUInt32LE(stringsStart, 20);
  head.writeUInt32LE(stylesStart, 24);
  const offs = Buffer.alloc(offsetsSize);
  strOffsets.forEach((o, i) => offs.writeUInt32LE(o, i * 4));
  styleOffsets.forEach((o, i) => offs.writeUInt32LE(o, strOffsets.length * 4 + i * 4));
  return Buffer.concat([head, offs, stringsData, stylesData]);
}

function writeValue(v: ResValue): Buffer {
  const b = Buffer.alloc(8);
  b.writeUInt16LE(8, 0);
  b[3] = v.dataType;
  b.writeUInt32LE(v.data >>> 0, 4);
  return b;
}

function writeEntry(e: Entry): Buffer {
  if (e.items) {
    const head = Buffer.alloc(16);
    head.writeUInt16LE(16, 0);
    head.writeUInt16LE(e.flags | ENTRY_FLAG_COMPLEX, 2);
    head.writeUInt32LE(e.key, 4);
    head.writeUInt32LE((e.parent ?? 0) >>> 0, 8);
    head.writeUInt32LE(e.items.length, 12);
    const items = e.items.map((it) => {
      const b = Buffer.alloc(12);
      b.writeUInt32LE(it.name >>> 0, 0);
      writeValue(it.value).copy(b, 4);
      return b;
    });
    return Buffer.concat([head, ...items]);
  }
  const head = Buffer.alloc(8);
  head.writeUInt16LE(8, 0);
  head.writeUInt16LE(e.flags & ~ENTRY_FLAG_COMPLEX, 2);
  head.writeUInt32LE(e.key, 4);
  return Buffer.concat([head, writeValue(e.value ?? { dataType: 0, data: 0 })]);
}

function writeTypeChunk(t: TypeChunk, entryCount: number): Buffer {
  const offsets = Buffer.alloc(entryCount * 4, 0xff);
  const parts: Buffer[] = [];
  let pos = 0;
  for (let i = 0; i < entryCount; i++) {
    const e = t.entries[i];
    if (!e) continue;
    const b = writeEntry(e);
    offsets.writeUInt32LE(pos, i * 4);
    parts.push(b);
    pos += b.length;
  }
  const data = Buffer.concat(parts);
  const headerSize = 20 + t.config.length;
  const head = Buffer.alloc(headerSize);
  head.writeUInt16LE(RES_TABLE_TYPE_TYPE, 0);
  head.writeUInt16LE(headerSize, 2);
  head.writeUInt32LE(headerSize + offsets.length + data.length, 4);
  head[8] = t.typeId;
  head[9] = 0;
  head.writeUInt16LE(0, 10);
  head.writeUInt32LE(entryCount, 12);
  head.writeUInt32LE(headerSize + offsets.length, 16);
  t.config.copy(head, 20);
  return Buffer.concat([head, offsets, data]);
}

function writeSpec(spec: TypeSpec, typeCount: number): Buffer {
  const b = Buffer.alloc(16 + spec.flags.length * 4);
  b.writeUInt16LE(RES_TABLE_TYPE_SPEC_TYPE, 0);
  b.writeUInt16LE(16, 2);
  b.writeUInt32LE(b.length, 4);
  b[8] = spec.typeId;
  b[9] = 0;
  b.writeUInt16LE(typeCount, 10);
  b.writeUInt32LE(spec.flags.length, 12);
  spec.flags.forEach((f, i) => b.writeUInt32LE(f >>> 0, 16 + i * 4));
  return b;
}

function writePackage(pkg: Package): Buffer {
  const typePool = writePool(pkg.typeStrings);
  const keyPool = writePool(pkg.keyStrings);
  const body: Buffer[] = [];
  const typeIds = [...new Set([...pkg.specs.keys(), ...pkg.types.map((t) => t.typeId)])].sort((a, b) => a - b);
  for (const id of typeIds) {
    const chunks = pkg.types.filter((t) => t.typeId === id);
    const spec = pkg.specs.get(id) ?? { typeId: id, flags: new Array(Math.max(0, ...chunks.map((c) => c.entries.length))).fill(0) };
    const entryCount = Math.max(spec.flags.length, ...chunks.map((c) => c.entries.length));
    while (spec.flags.length < entryCount) spec.flags.push(0);
    body.push(writeSpec(spec, chunks.length));
    for (const c of chunks) body.push(writeTypeChunk(c, entryCount));
  }
  body.push(...pkg.extra);
  const headerSize = 288;
  const head = Buffer.alloc(headerSize);
  const bodyBuf = Buffer.concat(body);
  head.writeUInt16LE(RES_TABLE_PACKAGE_TYPE, 0);
  head.writeUInt16LE(headerSize, 2);
  head.writeUInt32LE(headerSize + typePool.length + keyPool.length + bodyBuf.length, 4);
  head.writeUInt32LE(pkg.id, 8);
  Buffer.from(pkg.name.slice(0, 127), "utf16le").copy(head, 12);
  head.writeUInt32LE(headerSize, 268);
  head.writeUInt32LE(pkg.typeStrings.strings.length, 272);
  head.writeUInt32LE(headerSize + typePool.length, 276);
  head.writeUInt32LE(pkg.keyStrings.strings.length, 280);
  head.writeUInt32LE(0, 284);
  return Buffer.concat([head, typePool, keyPool, bodyBuf]);
}

export function writeArsc(table: ResTable): Buffer {
  const pool = writePool(table.strings);
  const pkgs = table.packages.map(writePackage);
  const head = Buffer.alloc(12);
  const size = 12 + pool.length + pkgs.reduce((a, b) => a + b.length, 0);
  head.writeUInt16LE(RES_TABLE_TYPE, 0);
  head.writeUInt16LE(12, 2);
  head.writeUInt32LE(size, 4);
  head.writeUInt32LE(table.packages.length, 8);
  return Buffer.concat([head, pool, ...pkgs]);
}

// ---- merging ---------------------------------------------------------------

/** Index-of helper that appends missing strings; appending breaks any sorted guarantee. */
class PoolIndex {
  private byValue = new Map<string, number>();
  constructor(private pool: StringPool) {
    pool.strings.forEach((s, i) => {
      if (!pool.styles[i]?.length && !this.byValue.has(s)) this.byValue.set(s, i);
    });
  }
  /** Index of `s` with the given spans (spans already remapped), appending when needed. */
  intern(s: string, spans: Span[] | undefined): number {
    if (!spans?.length) {
      const have = this.byValue.get(s);
      if (have !== undefined) return have;
    }
    const idx = this.pool.strings.length;
    this.pool.strings.push(s);
    if (spans?.length) {
      while (this.pool.styles.length < idx) this.pool.styles.push([]);
      this.pool.styles.push(spans);
    }
    if (!spans?.length) this.byValue.set(s, idx);
    this.pool.sorted = false;
    return idx;
  }
}

export interface MergeReport {
  /** Type chunks (configurations) added from splits. */
  addedConfigs: number;
  /** Entries filled into configurations the base already had. */
  mergedEntries: number;
  /** Entries already present with a different value; the existing one was kept. */
  conflicts: number;
}

function sameEntry(a: Entry, b: Entry): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Merge `split`'s tables into `base`, in place. */
export function mergeArsc(base: ResTable, split: ResTable): MergeReport {
  const report: MergeReport = { addedConfigs: 0, mergedEntries: 0, conflicts: 0 };
  const globalIdx = new PoolIndex(base.strings);
  const remapString = (i: number): number => {
    const s = split.strings.strings[i];
    if (s === undefined) throw new Error(`split resource table references string #${i}, which it doesn't have`);
    const spans = split.strings.styles[i]?.map((sp) => ({ ...sp, name: remapString(sp.name) }));
    return globalIdx.intern(s, spans);
  };
  const remapValue = (v: ResValue): ResValue => (v.dataType === TYPE_STRING ? { dataType: v.dataType, data: remapString(v.data) } : v);

  for (const spkg of split.packages) {
    const bpkg = base.packages.find((p) => p.id === spkg.id);
    if (!bpkg) throw new Error(`split carries package 0x${spkg.id.toString(16)} (${spkg.name}), which the base APK doesn't have`);
    // Type ids are positional and identical across base and splits (resource
    // ids must match); bundletool fills unused slots with "?N" placeholders.
    const bt = bpkg.typeStrings.strings;
    spkg.typeStrings.strings.forEach((name, i) => {
      if (i >= bt.length) bt.push(name);
      else if (bt[i]!.startsWith("?") && !name.startsWith("?")) bt[i] = name;
    });
    const keyIdx = new PoolIndex(bpkg.keyStrings);
    const remapKey = (k: number): number => {
      const name = spkg.keyStrings.strings[k];
      if (name === undefined) throw new Error(`split resource table references key #${k}, which it doesn't have`);
      return keyIdx.intern(name, undefined);
    };
    const remapEntry = (e: Entry): Entry => ({
      flags: e.flags,
      key: remapKey(e.key),
      value: e.value ? remapValue(e.value) : undefined,
      parent: e.parent,
      items: e.items?.map((it) => ({ name: it.name, value: remapValue(it.value) })),
    });

    for (const [id, sspec] of spkg.specs) {
      const bspec = bpkg.specs.get(id);
      if (!bspec) bpkg.specs.set(id, { typeId: id, flags: [...sspec.flags] });
      else {
        while (bspec.flags.length < sspec.flags.length) bspec.flags.push(0);
        sspec.flags.forEach((f, i) => (bspec.flags[i] = (bspec.flags[i]! | f) >>> 0));
      }
    }

    for (const st of spkg.types) {
      const existing = bpkg.types.find((t) => t.typeId === st.typeId && t.config.equals(st.config));
      if (!existing) {
        bpkg.types.push({ typeId: st.typeId, config: st.config, entries: st.entries.map((e) => (e ? remapEntry(e) : null)) });
        report.addedConfigs++;
        continue;
      }
      while (existing.entries.length < st.entries.length) existing.entries.push(null);
      // Density splits each carry the nearest alternative of resources that lack
      // their own density, so the same entry shows up in several splits.
      st.entries.forEach((e, i) => {
        if (!e) return;
        const have = existing.entries[i];
        const mine = remapEntry(e);
        if (!have) {
          existing.entries[i] = mine;
          report.mergedEntries++;
        } else if (!sameEntry(have, mine)) report.conflicts++;
      });
    }
  }
  return report;
}
