// A minimal streaming tar writer (POSIX ustar, with PAX headers for long or
// non-ASCII names and files of 8 GiB or more). It lets a directory go to the
// headset as one stream piped into `tar -x` over SSH instead of one SFTP
// round-trip per file. Only regular files and directories are written; links
// and special files are skipped, matching what the SFTP path uploads.
import { createReadStream, readdirSync, statSync } from "node:fs";
import { join, posix } from "node:path";

const BLOCK = 512;
/** Largest size that fits in ustar's 11-digit octal size field. */
const USTAR_MAX_SIZE = 0o77777777777;

export interface TarEntry {
  /** Path inside the archive, '/'-separated and relative. */
  rel: string;
  type: "file" | "dir";
  /** Absolute local path (files only). */
  local?: string;
  size: number;
  mtimeMs: number;
}

/** Walk a directory into tar entries: directories before their contents, links skipped. */
export function collectTarEntries(root: string): TarEntry[] {
  const out: TarEntry[] = [];
  const walk = (dir: string, rel: string) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const full = join(dir, e.name);
      const r = rel ? posix.join(rel, e.name) : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        out.push({ rel: r, type: "dir", size: 0, mtimeMs: statSync(full).mtimeMs });
        walk(full, r);
      } else if (e.isFile()) {
        const st = statSync(full);
        out.push({ rel: r, type: "file", local: full, size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  };
  walk(root, "");
  return out;
}

function octal(n: number, width: number): string {
  // width includes the trailing NUL.
  return n.toString(8).padStart(width - 1, "0") + "\0";
}

function header(name: string, type: "0" | "5" | "x", size: number, mode: number, mtime: number): Buffer {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, "utf8");
  h.write(octal(mode, 8), 100, "ascii");
  h.write(octal(0, 8), 108, "ascii"); // uid
  h.write(octal(0, 8), 116, "ascii"); // gid
  h.write(octal(size, 12), 124, "ascii");
  h.write(octal(mtime, 12), 136, "ascii");
  h.write("        ", 148, "ascii"); // checksum placeholder
  h.write(type, 156, "ascii");
  h.write("ustar\0", 257, "ascii");
  h.write("00", 263, "ascii");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return h;
}

/** One PAX record: "<len> <key>=<value>\n", where len counts the whole record. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  const bodyLen = Buffer.byteLength(body);
  let len = bodyLen + 1;
  while (String(len).length + bodyLen !== len) len = String(len).length + bodyLen;
  return `${len}${body}`;
}

function padding(size: number): Buffer {
  const rem = size % BLOCK;
  return rem ? Buffer.alloc(BLOCK - rem) : Buffer.alloc(0);
}

/** Printable-ASCII stand-in for a name, for the ustar field a PAX header overrides. */
function asciiName(name: string): string {
  return name.replace(/[^\x20-\x7e]/g, "_").slice(0, 100);
}

/** Headers for one entry, with a PAX extended header first when ustar can't hold it. */
function entryHeaders(e: TarEntry, mode: number): Buffer {
  const name = e.type === "dir" ? e.rel + "/" : e.rel;
  const mtime = Math.max(0, Math.floor(e.mtimeMs / 1000));
  const bigFile = e.size > USTAR_MAX_SIZE;
  const records: string[] = [];
  if (asciiName(name) !== name) records.push(paxRecord("path", name));
  if (bigFile) records.push(paxRecord("size", String(e.size)));
  const main = header(asciiName(name), e.type === "dir" ? "5" : "0", bigFile ? 0 : e.size, mode, mtime);
  if (!records.length) return main;
  const pax = Buffer.from(records.join(""), "utf8");
  return Buffer.concat([header(asciiName("PaxHeaders/" + e.rel), "x", pax.length, 0o644, mtime), pax, padding(pax.length), main]);
}

/**
 * Yield the archive for `entries` chunk by chunk. Files are read lazily, so
 * memory stays flat and a slow consumer applies backpressure. `onFileBytes`
 * reports file content bytes as they're handed off.
 */
export async function* tarChunks(entries: TarEntry[], opts: { fileMode?: number; dirMode?: number; onFileBytes?: (n: number) => void } = {}): AsyncGenerator<Buffer> {
  const fileMode = opts.fileMode ?? 0o644;
  const dirMode = opts.dirMode ?? 0o755;
  // Small files are coalesced so each SSH write carries more than a header.
  let pending: Buffer[] = [];
  let pendingLen = 0;
  const FLUSH = 256 * 1024;
  const push = (b: Buffer) => {
    if (!b.length) return;
    pending.push(b);
    pendingLen += b.length;
  };
  const take = () => {
    const out = Buffer.concat(pending, pendingLen);
    pending = [];
    pendingLen = 0;
    return out;
  };

  for (const e of entries) {
    if (e.type === "dir") {
      push(entryHeaders(e, dirMode));
    } else {
      push(entryHeaders(e, fileMode));
      if (e.size > 0) {
        let read = 0;
        const rs = createReadStream(e.local!, { start: 0, end: e.size - 1, highWaterMark: FLUSH });
        for await (const chunk of rs as AsyncIterable<Buffer>) {
          read += chunk.length;
          push(chunk);
          opts.onFileBytes?.(chunk.length);
          if (pendingLen >= FLUSH) yield take();
        }
        if (read !== e.size) throw new Error(`${e.rel} changed size while uploading.`);
        push(padding(e.size));
      }
    }
    if (pendingLen >= FLUSH) yield take();
  }
  push(Buffer.alloc(BLOCK * 2));
  yield take();
}
