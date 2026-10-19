// Split-APK bundles (.apkm from APKMirror, .xapk from APKPure, .apks from
// bundletool, or any zip of base + split_*.apk): pull the APKs out, keep the
// splits the Frame can use, and merge them into one APK, because Lepton only
// ever installs a single file.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { manifestIdentity } from "../apk/axml";
import { mergeSplits } from "../apk/merge";
import { loadOrCreateSigningKey } from "../apk/sign";
import { inflateEntry, readRawEntries } from "../apk/zip";
import { listZipEntries } from "./apk";

export const BUNDLE_EXTS = [".apkm", ".xapk", ".apks"];

const ABIS = new Set(["arm64_v8a", "armeabi_v7a", "armeabi", "x86", "x86_64", "mips", "mips64"]);

export interface BundleResult {
  apkPath: string;
  obbPaths: string[];
  tempDir: string;
  /** Short human-readable notes for the review screen. */
  notes: string[];
  warnings: string[];
}

interface Part {
  file: string;
  name: string;
  split?: string;
  package?: string;
  versionCode?: number;
}

/** True for a zip that looks like a split bundle rather than a game folder. */
export async function zipLooksLikeBundle(path: string): Promise<boolean> {
  if (BUNDLE_EXTS.includes(extname(path).toLowerCase())) return true;
  const names = (await listZipEntries(path)).map((e) => e.name);
  return names.some((n) => /(^|\/)base\.apk$/i.test(n)) && names.some((n) => /(^|\/)split_[^/]+\.apk$/i.test(n));
}

async function identify(file: string, name: string): Promise<Part> {
  const [e] = await readRawEntries(file, (n) => n === "AndroidManifest.xml");
  const id = e ? manifestIdentity(inflateEntry(e)) : {};
  // bundletool and APKMirror name splits split_<name>.apk; fall back to that when the manifest says nothing.
  const fromName = /^split_(.+)\.apk$/i.exec(name)?.[1];
  return { file, name, split: id.split ?? fromName, package: id.package, versionCode: id.versionCode };
}

function describeSplit(split: string): { kind: "abi" | "config" | "feature"; label: string } {
  const m = /^config\.(.+)$/.exec(split);
  if (!m) return { kind: "feature", label: split };
  const q = m[1]!;
  return ABIS.has(q) ? { kind: "abi", label: q } : { kind: "config", label: q };
}

export async function mergeBundle(path: string, signingKeyPath: string): Promise<BundleResult> {
  const temp = mkdtempSync(join(tmpdir(), "frameloader-"));
  try {
    const partsDir = join(temp, "parts");
    mkdirSync(partsDir);
    const entries = await readRawEntries(path, (n) => /\.(apk|obb)$/i.test(n));
    const apks: Part[] = [];
    const obbPaths: string[] = [];
    for (const e of entries) {
      const name = basename(e.name.replace(/\\/g, "/"));
      if (/\.obb$/i.test(name)) {
        const obbDir = join(temp, "obb");
        mkdirSync(obbDir, { recursive: true });
        const out = join(obbDir, name.replace(/[^A-Za-z0-9._-]+/g, "_"));
        writeFileSync(out, inflateEntry(e));
        obbPaths.push(out);
        continue;
      }
      const out = join(partsDir, `${apks.length}-${name.replace(/[^A-Za-z0-9._-]+/g, "_")}`);
      writeFileSync(out, inflateEntry(e));
      apks.push(await identify(out, name));
    }
    if (!apks.length) throw new Error("There's no APK inside that bundle.");

    const bases = apks.filter((p) => !p.split);
    if (bases.length !== 1) throw new Error(bases.length ? "The bundle has more than one base APK." : "The bundle has splits but no base APK.");
    const base = bases[0]!;
    const splits = apks.filter((p) => p.split);
    const foreign = splits.filter((s) => s.package && base.package && s.package !== base.package);
    if (foreign.length) throw new Error(`The bundle mixes apps: ${base.package} and ${foreign[0]!.package}.`);
    const stale = splits.filter((s) => s.versionCode !== undefined && base.versionCode !== undefined && s.versionCode !== base.versionCode);
    if (stale.length) throw new Error(`${stale[0]!.name} is from a different build (version code ${stale[0]!.versionCode}) than the base APK (${base.versionCode}).`);

    const use: Part[] = [];
    const skipped: string[] = [];
    const features: string[] = [];
    const configs: string[] = [];
    let abiSplits = 0;
    for (const s of splits) {
      const d = describeSplit(s.split!);
      if (d.kind === "abi") {
        abiSplits++;
        if (d.label === "arm64_v8a") use.push(s);
        else skipped.push(d.label);
        continue;
      }
      if (d.kind === "feature") features.push(d.label);
      else configs.push(d.label);
      use.push(s);
    }
    if (abiSplits && !use.some((s) => describeSplit(s.split!).kind === "abi")) {
      throw new Error(`This bundle has no arm64 build (${skipped.join(", ")} only). Lepton is 64-bit ARM only.`);
    }

    const stem = basename(path, extname(path)).replace(/[^A-Za-z0-9._-]+/g, "_") || "app";
    const apkPath = join(temp, `${stem}.apk`);
    const key = loadOrCreateSigningKey(signingKeyPath);
    const r = await mergeSplits({ base: base.file, splits: use.map((s) => s.file), out: apkPath, key });
    rmSync(partsDir, { recursive: true, force: true });

    const notes: string[] = [];
    const list = (xs: string[]) => (xs.length > 6 ? `${xs.slice(0, 5).join(", ")} and ${xs.length - 5} more` : xs.join(", "));
    const parts = [use.some((s) => describeSplit(s.split!).kind === "abi") ? "arm64 libraries" : "", configs.length ? `${configs.length} resource split${configs.length === 1 ? "" : "s"} (${list(configs)})` : "", features.length ? `${features.length} feature module${features.length === 1 ? "" : "s"}` : ""].filter(Boolean);
    notes.push(`Merged the bundle into one APK${parts.length ? `: base + ${parts.join(" + ")}` : ""}, then re-signed it with Frameloader's own key.`);
    const warnings: string[] = [];
    if (skipped.length) warnings.push(`Left out the ${skipped.join(", ")} builds; the Frame only runs arm64.`);
    if (features.length) warnings.push(`Feature modules (${features.join(", ")}) were merged as code and resources only; anything their manifests declare isn't registered.`);
    if (r.clashes.length) warnings.push(`${r.clashes.length} file${r.clashes.length === 1 ? "" : "s"} appeared in more than one split with different contents; kept the base's (${r.clashes.slice(0, 3).join(", ")}${r.clashes.length > 3 ? ", …" : ""}).`);
    if (r.resources.conflicts) warnings.push(`${r.resources.conflicts} resource entries differed between splits; kept the first.`);
    return { apkPath, obbPaths, tempDir: temp, notes, warnings };
  } catch (e) {
    rmSync(temp, { recursive: true, force: true });
    throw e;
  }
}
