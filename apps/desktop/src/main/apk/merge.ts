// Merge a base APK and its config splits into one APK Lepton can install with a
// plain `adb install`: union of the zip entries, merged resource table, the
// "needs splits" flags turned off in the manifest, and a fresh v2 signature.
import { readFileSync, writeFileSync } from "node:fs";
import { unmarkSplitRequired } from "./axml";
import { mergeArsc, parseArsc, writeArsc, type MergeReport } from "./arsc";
import { nopVoidCalls, type MethodRef } from "./dex";
import { signApkV2, type SigningKey } from "./sign";
import { inflateEntry, makeEntry, readRawEntries, ZipWriter, type RawEntry } from "./zip";

export interface MergeInput {
  base: string;
  splits: string[];
  out: string;
  key: SigningKey;
  /** Void method calls to blank out of the bytecode (see dex.ts). */
  nopCalls?: MethodRef[];
}

export interface MergeResult {
  /** Entries taken from splits. */
  added: number;
  /** Entries present in both base and a split with different content; the base's was kept. */
  clashes: string[];
  /** Dex files renamed to make room (feature splits ship their own classes.dex). */
  renamedDex: string[];
  manifestChanges: string[];
  resources: MergeReport;
  /** Calls removed by `nopCalls`. */
  patchedCalls: number;
}

// Signature files and per-APK metadata that must not survive the merge.
const DROP = /^(META-INF\/[^/]+\.(SF|RSA|DSA|EC|MF)$|META-INF\/MANIFEST\.MF$|stamp-cert-sha256$)/i;

export async function mergeSplits(input: MergeInput): Promise<MergeResult> {
  const baseEntries = await readRawEntries(input.base);
  const byName = new Map<string, RawEntry>();
  for (const e of baseEntries) if (!DROP.test(e.name)) byName.set(e.name, e);

  const manifestEntry = byName.get("AndroidManifest.xml");
  const arscEntry = byName.get("resources.arsc");
  if (!manifestEntry) throw new Error("The base APK has no AndroidManifest.xml.");
  const manifest = inflateEntry(manifestEntry);
  const table = arscEntry ? parseArsc(inflateEntry(arscEntry)) : undefined;

  const result: MergeResult = { added: 0, clashes: [], renamedDex: [], manifestChanges: [], resources: { addedConfigs: 0, mergedEntries: 0, conflicts: 0 }, patchedCalls: 0 };
  let nextDex = 2;
  while (byName.has(`classes${nextDex}.dex`)) nextDex++;

  for (const split of input.splits) {
    const entries = await readRawEntries(split);
    const splitArsc = entries.find((e) => e.name === "resources.arsc");
    if (splitArsc && table) {
      const r = mergeArsc(table, parseArsc(inflateEntry(splitArsc)));
      result.resources.addedConfigs += r.addedConfigs;
      result.resources.mergedEntries += r.mergedEntries;
      result.resources.conflicts += r.conflicts;
    }
    for (const e of entries) {
      if (e.name === "AndroidManifest.xml" || e.name === "resources.arsc" || DROP.test(e.name) || e.name.startsWith("META-INF/")) continue;
      let name = e.name;
      const have = byName.get(name);
      if (have) {
        if (have.crc32 === e.crc32 && have.uncompressedSize === e.uncompressedSize) continue;
        if (/^classes\d*\.dex$/.test(name)) {
          name = `classes${nextDex++}.dex`;
          result.renamedDex.push(`${e.name} → ${name}`);
        } else {
          result.clashes.push(name);
          continue;
        }
      }
      byName.set(name, name === e.name ? e : { ...e, name });
      result.added++;
    }
  }

  result.manifestChanges = unmarkSplitRequired(manifest);

  if (input.nopCalls?.length) {
    for (const [name, e] of byName) {
      if (!/^classes\d*\.dex$/.test(name)) continue;
      const dex = inflateEntry(e);
      const n = nopVoidCalls(dex, input.nopCalls);
      if (!n) continue;
      result.patchedCalls += n;
      byName.set(name, makeEntry(name, dex, 8));
    }
  }

  const writer = new ZipWriter(input.out);
  // Manifest first, then the resource table (stored and 4-byte aligned, as
  // Android 11+ requires for targetSdk 30+), then everything else in base order.
  writer.add(makeEntry("AndroidManifest.xml", manifest, 8));
  if (table) writer.add(makeEntry("resources.arsc", writeArsc(table), 0));
  for (const e of byName.values()) {
    if (e.name === "AndroidManifest.xml" || e.name === "resources.arsc") continue;
    writer.add(e);
  }
  writer.finish();

  writeFileSync(input.out, signApkV2(readFileSync(input.out), input.key));
  return result;
}
