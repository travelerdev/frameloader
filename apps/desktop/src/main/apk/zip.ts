// Just enough zip to rebuild an APK: read entries (raw, still compressed) with
// yauzl and write them back out with the alignment Android wants.
import { closeSync, openSync, writeSync } from "node:fs";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import yauzl from "yauzl";

export interface RawEntry {
  name: string;
  /** 0 = stored, 8 = deflate. */
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  /** The entry's bytes exactly as stored in the zip (compressed when method is 8). */
  raw: Buffer;
}

/** Read every entry of a zip, in order, without inflating. Directory entries are skipped. */
export function readRawEntries(path: string, want?: (name: string) => boolean): Promise<RawEntry[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error("not a zip"));
      const out: RawEntry[] = [];
      zip.on("error", reject);
      zip.on("end", () => resolve(out));
      zip.on("entry", (e) => {
        if (e.fileName.endsWith("/") || (want && !want(e.fileName))) return zip.readEntry();
        if (e.compressionMethod !== 0 && e.compressionMethod !== 8) return reject(new Error(`${e.fileName} uses an unsupported zip compression method (${e.compressionMethod}).`));
        const onStream = (err2: Error | null, stream?: NodeJS.ReadableStream) => {
          if (err2 || !stream) return reject(err2 ?? new Error("zip read failed"));
          const chunks: Buffer[] = [];
          stream.on("data", (c: Buffer) => chunks.push(c));
          stream.on("error", reject);
          stream.on("end", () => {
            out.push({ name: e.fileName, method: e.compressionMethod, crc32: e.crc32, compressedSize: e.compressedSize, uncompressedSize: e.uncompressedSize, raw: Buffer.concat(chunks) });
            zip.readEntry();
          });
        };
        // yauzl only accepts decompress:false for compressed entries.
        if (e.compressionMethod === 8) zip.openReadStream(e, { decrypt: null, decompress: false, start: null, end: null }, onStream);
        else zip.openReadStream(e, onStream);
      });
      zip.readEntry();
    });
  });
}

/** Inflate one raw entry. */
export function inflateEntry(e: RawEntry): Buffer {
  return e.method === 0 ? e.raw : inflateRawSync(e.raw);
}

/** Build a raw entry from plain bytes. */
export function makeEntry(name: string, data: Buffer, method: 0 | 8): RawEntry {
  const raw = method === 8 ? deflateRawSync(data, { level: 6 }) : data;
  return { name, method, crc32: crc32(data), compressedSize: raw.length, uncompressedSize: data.length, raw };
}

// Fixed DOS timestamp (2010-01-01) so output is reproducible; Android doesn't care.
const DOS_TIME = 0;
const DOS_DATE = ((2010 - 1980) << 9) | (1 << 5) | 1;
const ALIGN_EXTRA_ID = 0xd935; // the id zipalign uses

/**
 * Writes entries to a new zip file. Stored entries are aligned (4 bytes, or
 * 4096 for native libraries, as zipalign -p does) by padding the local header's
 * extra field, which is what lets Android mmap them straight out of the APK.
 */
export class ZipWriter {
  private fd: number;
  private offset = 0;
  private central: Buffer[] = [];
  private count = 0;

  constructor(path: string) {
    this.fd = openSync(path, "w");
  }

  add(e: RawEntry): void {
    const nameBuf = Buffer.from(e.name, "utf8");
    let extra = Buffer.alloc(0);
    if (e.method === 0) {
      const align = /\.so$/.test(e.name) ? 4096 : 4;
      const headerEnd = this.offset + 30 + nameBuf.length;
      const pad = (align - ((headerEnd + 6) % align)) % align;
      extra = Buffer.alloc(6 + pad);
      extra.writeUInt16LE(ALIGN_EXTRA_ID, 0);
      extra.writeUInt16LE(2 + pad, 2);
      extra.writeUInt16LE(align, 4);
    }
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x800, 6); // UTF-8 names
    local.writeUInt16LE(e.method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(e.crc32 >>> 0, 14);
    local.writeUInt32LE(e.compressedSize, 18);
    local.writeUInt32LE(e.uncompressedSize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(extra.length, 28);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(0x031e, 4); // made by: unix, 3.0
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x800, 8);
    cd.writeUInt16LE(e.method, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(e.crc32 >>> 0, 16);
    cd.writeUInt32LE(e.compressedSize, 20);
    cd.writeUInt32LE(e.uncompressedSize, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra (central)
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs: -rw-r--r--
    cd.writeUInt32LE(this.offset, 42);
    this.central.push(cd, nameBuf);

    this.write(local);
    this.write(nameBuf);
    if (extra.length) this.write(extra);
    this.write(e.raw);
    this.count++;
  }

  /** Writes the central directory and closes the file. */
  finish(): void {
    const cdOffset = this.offset;
    let cdSize = 0;
    for (const b of this.central) {
      this.write(b);
      cdSize += b.length;
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(this.count, 8);
    eocd.writeUInt16LE(this.count, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    eocd.writeUInt16LE(0, 20);
    this.write(eocd);
    closeSync(this.fd);
  }

  private write(b: Buffer): void {
    let off = 0;
    while (off < b.length) off += writeSync(this.fd, b, off, b.length - off, this.offset + off);
    this.offset += b.length;
  }
}
