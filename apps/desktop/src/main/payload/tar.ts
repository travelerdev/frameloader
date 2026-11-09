// Tar archives (.tar, .tar.gz/.tgz, .tar.xz/.txz, .tar.bz2, .tar.zst), as many
// Linux builds ship. Node can't read xz, so this uses the system's tar (bsdtar
// on macOS and Windows 10+, GNU tar on Linux), which detects the compression
// itself. Entries are checked before anything is written, and links are
// removed afterwards, matching what the zip path keeps.
import { execFile } from "node:child_process";
import { lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export const TAR_RE = /\.(tar|tgz|tbz2?|txz|tzst|tar\.(gz|bz2|xz|zst|zstd))$/i;

function run(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("tar", args, { maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const why = (err as NodeJS.ErrnoException).code === "ENOENT" ? "tar isn't installed" : (String(stderr).trim() || err.message).split("\n").slice(-2).join(" ");
        return reject(new Error(`Couldn't unpack that archive (${why}).`));
      }
      resolve(stdout);
    });
  });
}

/** Problems with an entry name that would write outside the destination, or undefined if it's fine. */
export function unsafeTarEntry(name: string): string | undefined {
  const n = name.replace(/\\/g, "/");
  if (/^([A-Za-z]:|\/)/.test(n)) return "an absolute path";
  if (n.split("/").includes("..")) return "a path with ..";
  return undefined;
}

export interface TarLimits {
  maxEntries: number;
  maxBytes: number;
}

export async function extractTar(archive: string, dest: string, limits: TarLimits): Promise<void> {
  const names = (await run(["-t", "-f", archive], 60_000)).split(/\r?\n/).filter(Boolean);
  if (!names.length) throw new Error("That archive is empty.");
  if (names.length > limits.maxEntries) throw new Error("That archive is too large to unpack.");
  for (const n of names) {
    const why = unsafeTarEntry(n);
    if (why) throw new Error(`Refusing an archive entry with ${why}: ${n}`);
  }
  await run(["-x", "-f", archive, "-C", dest], 30 * 60_000);
  // Drop links (the zip path never creates them) and enforce the size cap.
  let bytes = 0;
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isSymbolicLink()) rmSync(full, { force: true });
      else if (e.isDirectory()) walk(full);
      else if (e.isFile()) bytes += lstatSync(full).size;
    }
  };
  walk(dest);
  if (bytes > limits.maxBytes) throw new Error("That archive is too large to unpack.");
}
