// Turn dropped paths into something we can describe and upload.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync, readdirSync, createWriteStream, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, posix, resolve as resolvePath, sep } from "node:path";
import yauzl from "yauzl";
import type { ExecutableCandidate, PayloadInfo, PayloadKind } from "../../shared/ipc";
import { apkIssues, inspectApk } from "./apk";
import { readHead, sniffBinary } from "./binary";

export interface Payload {
  info: PayloadInfo;
  /** For a single-APK payload, the local APK path. */
  apkPath?: string;
  obbPaths: string[];
  /** For archive/folder payloads, the local directory that is uploaded as-is. */
  rootDir?: string;
  /** Temp directory to delete on discard. */
  tempDir?: string;
}

const payloads = new Map<string, Payload>();

export function getPayload(id: string): Payload | undefined {
  return payloads.get(id);
}

export function discardPayload(id: string): void {
  const p = payloads.get(id);
  if (!p) return;
  payloads.delete(id);
  if (p.tempDir) rmSync(p.tempDir, { recursive: true, force: true });
}

export function discardAll(): void {
  for (const id of [...payloads.keys()]) discardPayload(id);
}

const HELPER_RE = /(unitycrashhandler|crashreportclient|crashpad|setup|unins|vc_redist|vcredist|dxsetup|dxwebsetup|prereq|redist|installer|launcher_helper)/i;
const HELPER_DIRS = /(^|\/)(_commonredist|redist|directx|engine|monobleedingedge|_internal|steamworks)(\/|$)/i;

export async function inspectPaths(paths: string[]): Promise<PayloadInfo> {
  if (!paths.length) throw new Error("Nothing was dropped.");
  const apks = paths.filter((p) => extname(p).toLowerCase() === ".apk");
  const obbs = paths.filter((p) => extname(p).toLowerCase() === ".obb");
  const others = paths.filter((p) => !apks.includes(p) && !obbs.includes(p));
  if (apks.length > 1) throw new Error("Drop one APK at a time. Split APKs aren't supported; use a universal APK.");
  if (apks.length === 1 && others.length) throw new Error("Drop an APK on its own (OBB files may come with it).");
  if (apks.length === 1) return inspectApkPayload(apks[0]!, obbs);
  if (obbs.length && !others.length) throw new Error("OBB files need their APK; drop them together.");
  if (others.length !== 1) throw new Error("Drop a single app: an APK, an .exe, a zip, or a folder.");
  const target = others[0]!;
  const st = statSync(target);
  if (st.isDirectory()) return inspectDirPayload(target, undefined);
  const ext = extname(target).toLowerCase();
  if (ext === ".zip") return inspectZipPayload(target);
  if (ext === ".exe" || !ext || ext === ".sh" || ext === ".x86_64" || ext === ".bin" || ext === ".elf") return inspectDirPayload(dirname(target), target);
  throw new Error(`Frameloader doesn't know what to do with a ${ext || "file without an extension"} file. Drop an APK, .exe, zip, or folder.`);
}

async function inspectApkPayload(apkPath: string, obbPaths: string[]): Promise<PayloadInfo> {
  const facts = await inspectApk(apkPath);
  facts.obbFiles = obbPaths.map((p) => basename(p));
  const size = statSync(apkPath).size + obbPaths.reduce((a, p) => a + statSync(p).size, 0);
  const info: PayloadInfo = {
    id: randomUUID(),
    kind: "apk",
    sourcePaths: [apkPath, ...obbPaths],
    name: facts.label,
    sizeBytes: size,
    apk: facts,
    issues: apkIssues(facts),
    warnings: [],
  };
  if (!facts.abis.length) info.warnings.push("No native code; should run on any device.");
  payloads.set(info.id, { info, apkPath, obbPaths });
  return info;
}

function scanExecutables(root: string): ExecutableCandidate[] {
  const out: ExecutableCandidate[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as unknown as ReturnType<typeof readdirSync>;
    } catch {
      return;
    }
    for (const e of entries as unknown as import("node:fs").Dirent[]) {
      const full = join(dir, e.name);
      const r = rel ? posix.join(rel, e.name) : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (depth < 6) walk(full, r, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      let size = 0;
      try {
        size = statSync(full).size;
      } catch {
        continue;
      }
      if (size < 64) continue;
      const ext = extname(e.name).toLowerCase();
      if ([".dll", ".so", ".pdb", ".pak", ".dat", ".txt", ".json", ".png", ".jpg", ".wav", ".ogg", ".mp3", ".bank", ".assets", ".resource", ".ress", ".bin", ".dylib"].includes(ext)) continue;
      let head: Buffer;
      try {
        head = readHead(full);
      } catch {
        continue;
      }
      const b = sniffBinary(head);
      if (!b || !b.executable) continue;
      out.push({ relPath: r, format: b.format, arch: b.arch, size, score: 0 });
    }
  };
  walk(root, "", 0);
  const rootName = basename(root).toLowerCase().replace(/[-_ ]?(linux|windows|win64|win32|arm64|aarch64|x64|x86_64|v?\d+(\.\d+)*)/g, "");
  for (const c of out) {
    let s = 100;
    if (HELPER_RE.test(c.relPath) || HELPER_DIRS.test(c.relPath)) s -= 80;
    if (c.format === "elf" && c.arch === "arm64") s += 30;
    else if (c.format === "pe" && c.arch === "x86-64") s += 25;
    else if (c.format === "elf" && c.arch === "x86-64") s += 10;
    else if (c.format === "pe") s += 15;
    else if (c.format === "script") s += 5;
    const stem = basename(c.relPath, extname(c.relPath)).toLowerCase();
    if (rootName && stem.includes(rootName)) s += 15;
    s -= c.relPath.split("/").length * 3;
    s += Math.min(10, Math.log10(Math.max(1, c.size)));
    c.score = Math.round(s);
  }
  return out.sort((a, b) => b.score - a.score || a.relPath.localeCompare(b.relPath));
}

export function kindForCandidate(c: ExecutableCandidate | undefined, all: ExecutableCandidate[]): PayloadKind {
  if (!c) return "unknown";
  if (c.format === "pe") return "windows";
  if (c.format === "elf") return c.arch === "arm64" ? "linux-arm64" : c.arch === "x86-64" ? "linux-x64" : "unknown";
  // A script: look at the binary beside it.
  const bin = all.find((x) => x.format === "elf");
  if (bin) return bin.arch === "arm64" ? "linux-arm64" : "linux-x64";
  return "linux-arm64";
}

async function inspectDirPayload(root: string, preferred: string | undefined, tempDir?: string, displayName?: string): Promise<PayloadInfo> {
  const candidates = scanExecutables(root);
  if (preferred) {
    const rel = posix.normalize(resolvePath(preferred).slice(resolvePath(root).length + 1).split(sep).join("/"));
    const idx = candidates.findIndex((c) => c.relPath === rel);
    if (idx > 0) {
      const [c] = candidates.splice(idx, 1);
      candidates.unshift(c!);
    } else if (idx === -1) {
      candidates.unshift({ relPath: rel, format: "pe", arch: "other", size: statSync(preferred).size, score: 0 });
    }
  }
  const top = candidates[0];
  const kind = kindForCandidate(top, candidates);
  let size = 0;
  const sum = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) sum(full);
      else if (e.isFile()) size += statSync(full).size;
    }
  };
  sum(root);
  const stem = displayName ?? (preferred ? basename(preferred, extname(preferred)) : basename(root));
  const name = stem.replace(/[-_]?(linux|windows|win64|win32|arm64|aarch64|x64|x86_64)(\b|$)/gi, "").replace(/[-_]+/g, " ").trim() || stem;
  const info: PayloadInfo = {
    id: randomUUID(),
    kind,
    sourcePaths: [preferred ?? root],
    name,
    sizeBytes: size,
    candidates,
    issues: [],
    warnings: [],
  };
  if (!top) info.issues.push("No executable was found in there. Frameloader looks for Windows .exe files and Linux binaries by their headers.");
  else if (kind === "linux-x64") info.issues.push("This is a 64-bit x86 Linux build. The Frame can't run those as sideloaded titles; it needs an ARM64 Linux build or a Windows build.");
  else if (kind === "unknown") info.issues.push(`The executable (${top.relPath}) isn't a build the Frame can run (${top.arch}, ${top.format}).`);
  if (top && candidates.length > 1) info.warnings.push(`Found ${candidates.length} executables; starting with ${top.relPath}.`);
  if (kind === "linux-arm64") info.warnings.push("Linux ARM64 builds start natively, without the Steam Linux Runtime container.");
  payloads.set(info.id, { info, rootDir: root, obbPaths: [], tempDir });
  return info;
}

async function inspectZipPayload(zipPath: string): Promise<PayloadInfo> {
  const temp = mkdtempSync(join(tmpdir(), "frameloader-"));
  try {
    await extractZip(zipPath, temp);
  } catch (e) {
    rmSync(temp, { recursive: true, force: true });
    throw e;
  }
  // A zip with a single top-level folder is that folder.
  let root = temp;
  const top = readdirSync(temp, { withFileTypes: true }).filter((e) => !e.name.startsWith("__MACOSX") && e.name !== ".DS_Store");
  if (top.length === 1 && top[0]!.isDirectory()) root = join(temp, top[0]!.name);
  return inspectDirPayload(root, undefined, temp, basename(zipPath, ".zip"));
}

const MAX_ENTRIES = 200_000;
const MAX_UNPACKED = 64 * 1024 ** 3;

function extractZip(zipPath: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(new Error("That zip can't be opened."));
      let count = 0;
      let bytes = 0;
      const destAbs = resolvePath(dest);
      zip.on("error", reject);
      zip.on("end", () => resolve());
      zip.on("entry", (entry) => {
        count++;
        bytes += entry.uncompressedSize;
        if (count > MAX_ENTRIES || bytes > MAX_UNPACKED) return reject(new Error("That zip is too large to unpack."));
        const name = entry.fileName.replace(/\\/g, "/");
        if (name.startsWith("__MACOSX/") || /(^|\/)\.DS_Store$/.test(name)) return zip.readEntry();
        if (/^([A-Za-z]:|\/)/.test(name) || name.split("/").includes("..")) return reject(new Error(`Refusing a zip entry with an unsafe path: ${name}`));
        const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
        const isSymlink = (mode & 0xf000) === 0xa000;
        if (isSymlink) return zip.readEntry();
        const out = resolvePath(dest, name);
        if (!out.startsWith(destAbs + sep) && out !== destAbs) return reject(new Error(`Refusing a zip entry outside the archive: ${name}`));
        if (name.endsWith("/")) {
          mkdirSync(out, { recursive: true });
          return zip.readEntry();
        }
        mkdirSync(dirname(out), { recursive: true });
        zip.openReadStream(entry, (err2, stream) => {
          if (err2 || !stream) return reject(err2 ?? new Error("zip read failed"));
          const exec = (mode & 0o111) !== 0;
          const ws = createWriteStream(out, { mode: exec ? 0o755 : 0o644 });
          stream.pipe(ws);
          ws.on("finish", () => zip.readEntry());
          ws.on("error", reject);
          stream.on("error", reject);
        });
      });
      zip.readEntry();
    });
  });
}

export function payloadExists(id: string): boolean {
  const p = payloads.get(id);
  if (!p) return false;
  const path = p.apkPath ?? p.rootDir;
  return !!path && existsSync(path);
}
