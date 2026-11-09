// A folder (or unpacked archive) that holds an Android app rather than a PC
// build: Unreal's Android_ASTC/ packaging output, or an APK zipped up with its
// OBB expansion files. Pick the app's APK and its OBBs, and leave the rest
// (install .bat files, debug symbols, Unreal's Windows file tool) behind.
import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { manifestIdentity } from "../apk/axml";
import { inflateEntry, readRawEntries } from "../apk/zip";

export interface ApkSet {
  apk: string;
  obbs: string[];
  notes: string[];
}

/** Unreal's Android File Server helper, installed next to every Unreal app for its file tool; not the game. */
const HELPER_APK = /^AFS_/i;
const OBB_NAME = /^(main|patch)\.(\d+)\.(.+)\.obb$/i;

function walk(root: string, maxDepth: number): string[] {
  const out: string[] = [];
  const go = (dir: string, depth: number) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (depth < maxDepth && !e.name.startsWith("__MACOSX")) go(full, depth + 1);
      } else if (e.isFile()) out.push(full);
    }
  };
  go(root, 0);
  return out;
}

async function packageOf(apk: string): Promise<string | undefined> {
  try {
    const [m] = await readRawEntries(apk, (n) => n === "AndroidManifest.xml");
    return m ? manifestIdentity(inflateEntry(m)).package : undefined;
  } catch {
    return undefined;
  }
}

/** The app APK and OBBs in `root`, or undefined when there's no APK there. */
export async function findApkSet(root: string): Promise<ApkSet | undefined> {
  const files = walk(root, 2);
  const apks = files.filter((f) => /\.apk$/i.test(f));
  if (!apks.length) return undefined;
  const obbs = files.filter((f) => /\.obb$/i.test(f));
  const helpers = apks.filter((f) => HELPER_APK.test(basename(f)));
  let candidates = apks.filter((f) => !helpers.includes(f));
  if (!candidates.length) throw new Error("The only APK in there is Unreal's file-transfer helper (AFS_…apk), not the app itself.");
  if (candidates.every((f) => /^(base|split_.+)\.apk$/i.test(basename(f))) && candidates.length > 1) {
    throw new Error("Those look like the pieces of a split APK. Drop the bundle they came in (.apkm, .xapk or .apks) instead.");
  }
  // With several APKs, the one the OBBs belong to is the app; otherwise the largest.
  if (candidates.length > 1) {
    const obbPackages = new Set(obbs.map((o) => OBB_NAME.exec(basename(o))?.[3]).filter(Boolean));
    const owned: string[] = [];
    for (const c of candidates) if (obbPackages.has((await packageOf(c)) ?? "")) owned.push(c);
    if (owned.length) candidates = owned;
  }
  const apk = candidates.sort((a, b) => statSync(b).size - statSync(a).size)[0]!;
  const left = apks.length - 1;
  const notes = [`Installing ${basename(apk)}${obbs.length ? ` with ${obbs.map((o) => basename(o)).join(", ")}` : ""}.${left ? ` Left out ${left === helpers.length ? "Unreal's file-transfer helper APK" : `${left} other APK${left === 1 ? "" : "s"}`} and the files that aren't part of the app.` : ""}`];
  return { apk, obbs, notes };
}

/** Warnings for OBBs Android won't hand to `pkg`: it looks for main/patch.<version>.<package>.obb. */
export function obbWarnings(obbNames: string[], pkg: string): string[] {
  const out: string[] = [];
  for (const name of obbNames) {
    const m = OBB_NAME.exec(name);
    if (!m) out.push(`${name} isn't named like an expansion file (main.<version>.<package>.obb), so the app may not find it.`);
    else if (m[3] !== pkg) out.push(`${name} is for ${m[3]}, not ${pkg}, so the app won't see it.`);
  }
  return out;
}
