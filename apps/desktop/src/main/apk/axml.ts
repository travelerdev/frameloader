// Binary AndroidManifest.xml: read the string pool and resource map, walk the
// elements, and flip the boolean attributes that tell Android the app is only
// complete with its splits installed. Edits are in place, so the file keeps its
// size and every other offset.
const RES_STRING_POOL = 0x0001;
const RES_XML_RESOURCE_MAP = 0x0180;
const RES_XML_START_ELEMENT = 0x0102;

const TYPE_STRING = 0x03;
const TYPE_INT_BOOLEAN = 0x12;

/** android:isSplitRequired */
const ATTR_IS_SPLIT_REQUIRED = 0x01010591;
/** android:requiredSplitTypes (API 31+): "base__abi,base__density" makes newer Androids refuse a lone base. */
const ATTR_REQUIRED_SPLIT_TYPES = 0x0101064e;
/** android:name */
const ATTR_NAME = 0x01010003;
/** android:value */
const ATTR_VALUE = 0x01010024;

interface Attr {
  /** Offset of the 20-byte attribute record. */
  offset: number;
  resId: number | undefined;
  nameIdx: number;
  dataType: number;
  data: number;
}

interface Element {
  name: string;
  attrs: Attr[];
}

export interface AxmlDoc {
  strings: string[];
  resMap: number[];
  elements: Element[];
}

/** Read a string pool chunk starting at `off`. Returns the strings and the chunk size. */
export function readStringPool(buf: Buffer, off: number): { strings: string[]; size: number } {
  const size = buf.readUInt32LE(off + 4);
  const count = buf.readUInt32LE(off + 8);
  const flags = buf.readUInt32LE(off + 16);
  const stringsStart = buf.readUInt32LE(off + 20);
  const utf8 = (flags & 0x100) !== 0;
  const strings: string[] = [];
  for (let i = 0; i < count; i++) {
    const rel = buf.readUInt32LE(off + 28 + i * 4);
    let p = off + stringsStart + rel;
    if (utf8) {
      // two varints: length in UTF-16 units (ignored), then byte length
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
  return { strings, size };
}

export function parseAxml(buf: Buffer): AxmlDoc {
  if (buf.readUInt16LE(0) !== 0x0003) throw new Error("not a binary XML document");
  const total = buf.readUInt32LE(4);
  let strings: string[] = [];
  let resMap: number[] = [];
  const elements: Element[] = [];
  let off = 8;
  while (off + 8 <= total) {
    const type = buf.readUInt16LE(off);
    const headerSize = buf.readUInt16LE(off + 2);
    const size = buf.readUInt32LE(off + 4);
    if (size < 8) throw new Error("corrupt binary XML chunk");
    if (type === RES_STRING_POOL) strings = readStringPool(buf, off).strings;
    else if (type === RES_XML_RESOURCE_MAP) {
      resMap = [];
      for (let p = off + headerSize; p + 4 <= off + size; p += 4) resMap.push(buf.readUInt32LE(p));
    } else if (type === RES_XML_START_ELEMENT) {
      const nameIdx = buf.readUInt32LE(off + 20);
      const attrStart = buf.readUInt16LE(off + 24);
      const attrSize = buf.readUInt16LE(off + 26);
      const attrCount = buf.readUInt16LE(off + 28);
      const attrs: Attr[] = [];
      for (let i = 0; i < attrCount; i++) {
        const a = off + headerSize + attrStart + i * attrSize;
        const ni = buf.readUInt32LE(a + 4);
        attrs.push({ offset: a, resId: resMap[ni], nameIdx: ni, dataType: buf[a + 15]!, data: buf.readUInt32LE(a + 16) });
      }
      elements.push({ name: strings[nameIdx] ?? "", attrs });
    }
    off += size;
  }
  return { strings, resMap, elements };
}

/**
 * Turn off the "needs its splits" markers so a merged APK installs and starts
 * on its own: android:isSplitRequired on <application>, and Play Core's
 * com.android.vending.splits.required <meta-data>. Returns what was changed.
 */
export function unmarkSplitRequired(manifest: Buffer): string[] {
  const doc = parseAxml(manifest);
  const changed: string[] = [];
  const isTrue = (s: string | undefined) => s === "true" || s === "TRUE" || s === "1";
  const setFalse = (a: Attr, what: string) => {
    if (a.dataType === TYPE_INT_BOOLEAN) {
      if (a.data === 0) return;
      manifest.writeUInt32LE(0, a.offset + 16);
    } else if (a.dataType === TYPE_STRING) {
      // bundletool writes isSplitRequired as the string "true". We can't resize
      // the pool, so point the attribute at a string Android won't read as true.
      if (!isTrue(doc.strings[a.data])) return;
      let idx = doc.strings.indexOf("false");
      if (idx < 0) idx = doc.strings.findIndex((s) => !isTrue(s));
      if (idx < 0) return;
      manifest.writeUInt32LE(idx, a.offset + 8); // rawValue
      manifest.writeUInt32LE(idx, a.offset + 16); // typedValue.data
    } else return;
    changed.push(what);
  };
  const setEmpty = (a: Attr, what: string) => {
    if (a.dataType !== TYPE_STRING || doc.strings[a.data] === "") return;
    const idx = doc.strings.indexOf("");
    if (idx < 0) return;
    manifest.writeUInt32LE(idx, a.offset + 8);
    manifest.writeUInt32LE(idx, a.offset + 16);
    changed.push(what);
  };
  for (const el of doc.elements) {
    if (el.name === "manifest" || el.name === "application") {
      for (const a of el.attrs) {
        if (a.resId === ATTR_IS_SPLIT_REQUIRED) setFalse(a, "android:isSplitRequired");
        else if (a.resId === ATTR_REQUIRED_SPLIT_TYPES) setEmpty(a, "android:requiredSplitTypes");
      }
    } else if (el.name === "meta-data") {
      const name = el.attrs.find((a) => a.resId === ATTR_NAME);
      if (!name || doc.strings[name.data] !== "com.android.vending.splits.required") continue;
      for (const a of el.attrs) if (a.resId === ATTR_VALUE) setFalse(a, "com.android.vending.splits.required");
    }
  }
  return changed;
}

/** The manifest's own attributes on the root element: package and split name. */
export function manifestIdentity(manifest: Buffer): { package?: string; split?: string; versionCode?: number } {
  const doc = parseAxml(manifest);
  const root = doc.elements.find((e) => e.name === "manifest");
  const out: { package?: string; split?: string; versionCode?: number } = {};
  if (!root) return out;
  for (const a of root.attrs) {
    const name = doc.strings[a.nameIdx];
    if (a.resId === undefined && name === "package" && a.dataType === 0x03) out.package = doc.strings[a.data];
    else if (a.resId === undefined && name === "split" && a.dataType === 0x03) out.split = doc.strings[a.data];
    else if (a.resId === 0x0101021b) out.versionCode = a.data;
  }
  return out;
}
