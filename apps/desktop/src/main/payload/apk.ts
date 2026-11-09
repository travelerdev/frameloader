// APK inspection: manifest facts via app-info-parser, ABIs and icon via the zip listing.
import AppInfoParser from "app-info-parser";
import yauzl from "yauzl";
import type { ApkFacts } from "../../shared/ipc";

const VR_CATEGORIES = ["org.khronos.openxr.intent.category.IMMERSIVE_HMD", "com.oculus.intent.category.VR", "com.google.intent.category.CARDBOARD", "com.google.intent.category.DAYDREAM"];
const VR_FEATURES = ["android.hardware.vr.headtracking", "android.software.vr.mode", "oculus.software.handtracking", "com.oculus.feature.PASSTHROUGH"];

interface ZipEntryInfo {
  name: string;
  size: number;
}

export function listZipEntries(path: string): Promise<ZipEntryInfo[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error("not a zip"));
      const out: ZipEntryInfo[] = [];
      zip.on("entry", (e) => {
        out.push({ name: e.fileName, size: e.uncompressedSize });
        zip.readEntry();
      });
      zip.on("end", () => resolve(out));
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}

export function readZipEntry(path: string, name: string, maxBytes = 4 * 1024 * 1024): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error("not a zip"));
      let found = false;
      zip.on("entry", (e) => {
        if (e.fileName !== name || e.uncompressedSize > maxBytes) return zip.readEntry();
        found = true;
        zip.openReadStream(e, (err2, stream) => {
          if (err2 || !stream) return reject(err2 ?? new Error("read failed"));
          const chunks: Buffer[] = [];
          stream.on("data", (c: Buffer) => chunks.push(c));
          stream.on("end", () => {
            zip.close();
            resolve(Buffer.concat(chunks));
          });
          stream.on("error", reject);
        });
      });
      zip.on("end", () => {
        if (!found) resolve(null);
      });
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}

/** ABIs from lib/<abi>/ entries. Empty means "no native code" (fine on any ABI). */
export function abisFromEntries(names: string[]): string[] {
  const abis = new Set<string>();
  for (const n of names) {
    const m = n.match(/^lib\/([^/]+)\/[^/]+\.so$/);
    if (m?.[1]) abis.add(m[1]);
  }
  return [...abis].sort();
}

const MAX_ICON_BYTES = 2 * 1024 * 1024;

/**
 * The best bitmap for the app icon. app-info-parser gives one path per
 * configuration (an array, or a comma-separated string in older versions).
 * Shrunk builds rename resources (res/Ut.png), so density can't be read from
 * the path; the largest bitmap is the highest-density one either way.
 */
export function pickIconEntry(iconField: unknown, entries: ZipEntryInfo[]): string | undefined {
  const declared = (Array.isArray(iconField) ? iconField : typeof iconField === "string" ? iconField.split(",") : []).map((s) => String(s).trim());
  const sizes = new Map(entries.map((e) => [e.name, e.size]));
  const bitmaps = (paths: string[]) => paths.filter((p) => /\.(png|webp)$/i.test(p) && (sizes.get(p) ?? 0) > 8 && (sizes.get(p) ?? 0) <= MAX_ICON_BYTES);
  const largest = (paths: string[]) => paths.sort((a, b) => (sizes.get(b) ?? 0) - (sizes.get(a) ?? 0))[0];
  const own = bitmaps(declared);
  if (own.length) return largest(own);
  // Adaptive/vector icons only: look for a launcher bitmap in res/ by its usual names.
  return largest(bitmaps(entries.map((e) => e.name).filter((n) => /^res\/(mipmap|drawable)[^/]*\/(ic_launcher|app_icon|icon)[^/]*\.(png|webp)$/i.test(n) && !/foreground|background|round|monochrome/i.test(n))));
}

function str(v: unknown): string {
  if (Array.isArray(v)) return str(v[0]);
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return "";
}

// app-info-parser logs "Not sure what to do with typed value…" for float
// attributes. We silence console.log while it runs, one parse at a time, so two
// overlapping parses can never leave console.log swapped out.
let parseQueue: Promise<unknown> = Promise.resolve();

function parseManifest(path: string): Promise<Record<string, unknown>> {
  const run = async () => {
    const origLog = console.log;
    console.log = () => undefined;
    try {
      return await new AppInfoParser(path).parse();
    } finally {
      console.log = origLog;
    }
  };
  const next = parseQueue.then(run, run);
  parseQueue = next.catch(() => undefined);
  return next;
}

export async function inspectApk(path: string): Promise<ApkFacts> {
  let manifest: Record<string, unknown>;
  try {
    manifest = await parseManifest(path);
  } catch (e) {
    throw new Error(`Couldn't read the APK's manifest (${(e as Error).message || "unknown error"}).`);
  }
  const entries = await listZipEntries(path);
  const names = entries.map((e) => e.name);
  const application = (manifest.application ?? {}) as Record<string, unknown>;
  const usesSdk = (manifest.usesSdk ?? {}) as Record<string, unknown>;
  const pkg = str(manifest.package);
  if (!pkg) throw new Error("The APK has no package name; it may be a split or malformed.");
  let label = str(application.label).trim();
  if (!label || /^\d+$/.test(label) || label.startsWith("@")) {
    const tail = pkg.split(".").pop() ?? pkg;
    label = tail.charAt(0).toUpperCase() + tail.slice(1);
  }
  const activities = [...((application.activities ?? []) as Record<string, unknown>[]), ...((application.activityAliases ?? []) as Record<string, unknown>[])];
  const categories = new Set<string>();
  let launchable = false;
  for (const a of activities) {
    for (const f of (a.intentFilters ?? []) as Record<string, unknown>[]) {
      for (const c of (f.categories ?? []) as Record<string, unknown>[]) categories.add(str(c.name));
      if (((f.actions ?? []) as Record<string, unknown>[]).some((x) => str(x.name) === "android.intent.action.MAIN")) launchable = true;
    }
  }
  const metaNames = ((application.metaData ?? []) as Record<string, unknown>[]).map((m) => str(m.name));
  const questEnvironment = metaNames.includes("com.oculus.environmentVersion");
  const features = new Set(((manifest.usesFeatures ?? []) as Record<string, unknown>[]).map((f) => str(f.name)));
  const hasOpenXr = names.some((n) => /^lib\/[^/]+\/libopenxr_loader\.so$/.test(n));
  const isVr = hasOpenXr || VR_CATEGORIES.some((c) => categories.has(c)) || VR_FEATURES.some((f) => features.has(f));
  let iconDataUrl: string | undefined;
  const iconEntry = pickIconEntry(application.icon, entries);
  if (iconEntry) {
    try {
      const data = await readZipEntry(path, iconEntry, MAX_ICON_BYTES);
      if (data && data.length > 8) {
        const mime = /\.webp$/i.test(iconEntry) ? "image/webp" : "image/png";
        iconDataUrl = `data:${mime};base64,${data.toString("base64")}`;
      }
    } catch {
      /* no icon */
    }
  }
  const minSdk = Number(usesSdk.minSdkVersion);
  const targetSdk = Number(usesSdk.targetSdkVersion);
  return {
    package: pkg,
    label,
    versionName: str(manifest.versionName),
    versionCode: Number(manifest.versionCode) || 0,
    minSdk: Number.isFinite(minSdk) ? minSdk : undefined,
    targetSdk: Number.isFinite(targetSdk) ? targetSdk : undefined,
    abis: abisFromEntries(names),
    isVr,
    iconDataUrl,
    obbFiles: [],
    launchable,
    questEnvironment,
  };
}

/** Lepton is Android 11 (API 30), arm64-v8a only, and starts an app through its MAIN activity. */
export function apkIssues(f: ApkFacts): string[] {
  const issues: string[] = [];
  if (f.questEnvironment && !f.launchable) {
    issues.push("This is a Quest Home environment (scenery for the Quest's home space), not an app. There's nothing in it to start on the Frame.");
  } else if (f.launchable === false) {
    issues.push("This APK has no activity to start, so Lepton can't launch it. It may be a plugin, a theme, or part of another app.");
  }
  if (f.abis.length && !f.abis.includes("arm64-v8a")) {
    issues.push(`This APK has no arm64 build (${f.abis.join(", ")} only). Lepton is 64-bit ARM only.`);
  }
  if (f.minSdk !== undefined && f.minSdk > 30) {
    issues.push(`This app needs Android API ${f.minSdk}. Lepton is Android 11 (API 30).`);
  }
  return issues;
}
