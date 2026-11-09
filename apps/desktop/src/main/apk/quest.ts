// Quest compatibility patches: small, targeted edits that let apps built for
// Meta Quest start under Lepton on a Steam Frame. Each one is detected while
// inspecting the APK, offered on the review screen, and applied at install
// time by rewriting the APK entry by entry and re-signing it.
import type { QuestPatchId, QuestPatchOffer } from "../../shared/ipc";
import { definesMethod, forceReturnTrue, UNITY_OCULUS_CHECK } from "./dex";
import { elfLoadSegments, elfNeeded } from "./elf";
import { signApkV2File, type SigningKey } from "./sign";
import { forEachRawEntry, inflateEntry, makeEntry, readRawEntries, ZipWriter, type RawEntry } from "./zip";

export const OPENXR_LOADER_ENTRY = "lib/arm64-v8a/libopenxr_loader.so";

export type OpenXrLoaderKind = "meta" | "khronos" | "unknown";

/**
 * Which OpenXR loader an app bundles. Meta's (from the Oculus mobile SDK) only
 * knows how to find Meta's runtime through com.oculus.systemdriver, so it logs
 * "Failed to find default runtime" on the Frame. The Khronos loader also reads
 * /vendor/etc/openxr/1/active_runtime.json, which is how Lepton offers SteamVR.
 */
export function classifyOpenXrLoader(so: Buffer): OpenXrLoaderKind {
  const has = (s: string) => so.includes(Buffer.from(s, "latin1"));
  const khronos = has("org.khronos.openxr.runtime_broker") || has("active_runtime.json");
  if (has("com.oculus.systemdriver") && !khronos) return "meta";
  return khronos ? "khronos" : "unknown";
}

export const OVRPLUGIN_ENTRY = "lib/arm64-v8a/libOVRPlugin.so";

// ---- OVRPlugin: allow non-Meta OpenXR runtimes --------------------------------
//
// Meta's OVRPlugin (the OpenXR build that Unity's Oculus XR plugin and Meta's
// SDKs load) refuses any OpenXR runtime that isn't Meta's ("Non-Oculus OpenXR
// runtime is not supported") unless bit 0x8 of its pre-initialize flags is
// set. Meta added that switch for PC runtimes such as SteamVR, but Unity's
// plugin always passes 0. The flag is tested in one place, right before
// OVRPlugin logs "Support Non-Oculus runtime: %s": `ands wD, wF, #0x8`, whose
// result is stored as the setting. Rewriting that one instruction to
// `orr wD, wzr, #0x8` turns the switch on.

const SUPPORT_NON_OCULUS_LOG = "Support Non-Oculus runtime: %s";
const NON_OCULUS_REJECTED = "Non-Oculus OpenXR runtime is not supported.";

const isBranchOnFlags = (insn: number) => (insn & 0xff000010) >>> 0 === 0x54000000; // b.cond
const isBl = (insn: number) => (insn & 0xfc000000) >>> 0 === 0x94000000;

/**
 * Where OVRPlugin tests its "support non-Oculus runtime" flag, as a file
 * offset into the .so, or undefined when this isn't an OVRPlugin build with
 * that switch (or its code doesn't look the way the patch expects).
 */
export function findOvrNonOculusFlagTest(so: Buffer): number | undefined {
  if (!so.includes(Buffer.from(NON_OCULUS_REJECTED, "latin1"))) return undefined;
  const segs = elfLoadSegments(so);
  const strOff = so.indexOf(Buffer.from(SUPPORT_NON_OCULUS_LOG + "\0", "latin1"));
  if (!segs || strOff < 0) return undefined;
  const strSeg = segs.find((g) => strOff >= g.offset && strOff < g.offset + g.filesz);
  if (!strSeg) return undefined;
  const strAddr = strOff - strSeg.offset + strSeg.vaddr;
  for (const g of segs.filter((x) => x.exec)) {
    const end = Math.min(g.offset + g.filesz, so.length) - 8;
    for (let off = g.offset; off <= end; off += 4) {
      const adrp = so.readUInt32LE(off);
      if ((adrp & 0x9f000000) >>> 0 !== 0x90000000) continue;
      const rd = adrp & 0x1f;
      const imm = ((adrp >>> 29) & 3) | (((adrp >>> 5) & 0x7ffff) << 2);
      const pc = off - g.offset + g.vaddr;
      const page = Math.floor(pc / 4096) * 4096 + ((imm << 11) >> 11) * 4096; // sign-extend 21 bits
      if (page !== Math.floor(strAddr / 4096) * 4096) continue;
      const add = so.readUInt32LE(off + 4);
      if ((add & 0xffc00000) >>> 0 !== 0x91000000 || ((add >>> 10) & 0xfff) !== strAddr % 4096 || (add & 0x1f) !== rd || ((add >>> 5) & 0x1f) !== rd) continue;
      // The flag test sits a few instructions before the string is loaded.
      for (let back = off - 4; back >= Math.max(g.offset, off - 64); back -= 4) {
        const insn = so.readUInt32LE(back);
        if ((insn & 0xfffffc00) >>> 0 !== 0x721d0000) continue; // ands wD, wN, #0x8
        // Nothing between it and the log call may branch on the flags it sets.
        for (let q = back + 4; q < back + 4 + 64 && q <= end; q += 4) {
          const next = so.readUInt32LE(q);
          if (isBranchOnFlags(next)) return undefined;
          if (isBl(next)) return back;
        }
        return undefined;
      }
    }
  }
  return undefined;
}

/** Turn on OVRPlugin's non-Oculus-runtime switch in place. Returns false when the code isn't found. */
export function allowNonOculusRuntime(so: Buffer): boolean {
  const at = findOvrNonOculusFlagTest(so);
  if (at === undefined) return false;
  const rd = so.readUInt32LE(at) & 0x1f;
  so.writeUInt32LE((0x321d03e0 | rd) >>> 0, at); // orr wD, wzr, #0x8
  return true;
}

const OFFERS: Record<QuestPatchId, Omit<QuestPatchOffer, "id">> = {
  "openxr-loader": {
    title: "Use the standard OpenXR loader",
    explanation:
      "This app ships Meta's OpenXR loader, which only looks for the Quest's own VR system and gives up on the Frame. Frameloader swaps in the open-source Khronos loader, which finds the Frame's SteamVR runtime.",
  },
  "ovrplugin-runtime": {
    title: "Let Meta's OVRPlugin use SteamVR",
    explanation:
      "Meta's OVRPlugin refuses to run on any VR system but Meta's own, though it has a built-in switch for others. This turns that switch on, so the app can render to the Frame's SteamVR runtime.",
  },
  "unity-oculus-check": {
    title: "Skip Unity's Quest-only check",
    explanation:
      "Unity's Oculus plugin quits the app when the headset's maker isn't Oculus. This makes that check pass, so the app can start and use OpenXR instead.",
  },
};

export interface QuestDetection {
  openXrLoader?: OpenXrLoaderKind;
  unityOculusCheck: boolean;
  /** "openxr": OVRPlugin's OpenXR build; "vrapi": the older build on Meta's VrApi, which the Frame doesn't have. */
  ovrPlugin?: "openxr" | "vrapi";
  /** The OpenXR OVRPlugin has the non-Oculus-runtime switch the patch can turn on. */
  ovrPluginSwitch: boolean;
  offers: QuestPatchOffer[];
  /** Problems no patch fixes, for the review screen. */
  warnings: string[];
}

const isDex = (n: string) => /^classes\d*\.dex$/.test(n);

/** Look for the patterns the patches fix. Reads the loader and the dex files, nothing else. */
export async function detectQuestPatches(apkPath: string): Promise<QuestDetection> {
  const entries = await readRawEntries(apkPath, (n) => n === OPENXR_LOADER_ENTRY || n === OVRPLUGIN_ENTRY || isDex(n));
  const loader = entries.find((e) => e.name === OPENXR_LOADER_ENTRY);
  const openXrLoader = loader ? classifyOpenXrLoader(inflateEntry(loader)) : undefined;
  const ovr = entries.find((e) => e.name === OVRPLUGIN_ENTRY);
  let ovrPlugin: QuestDetection["ovrPlugin"];
  let ovrPluginSwitch = false;
  if (ovr) {
    const so = inflateEntry(ovr);
    const needed = elfNeeded(so);
    ovrPlugin = needed.includes("libopenxr_loader.so") ? "openxr" : needed.includes("libvrapi.so") ? "vrapi" : undefined;
    ovrPluginSwitch = ovrPlugin === "openxr" && findOvrNonOculusFlagTest(so) !== undefined;
  }
  let unityOculusCheck = false;
  for (const e of entries) {
    if (!isDex(e.name)) continue;
    try {
      if (definesMethod(inflateEntry(e), [UNITY_OCULUS_CHECK])) {
        unityOculusCheck = true;
        break;
      }
    } catch {
      /* not a dex we can read; leave it alone */
    }
  }
  const offers: QuestPatchOffer[] = [];
  const warnings: string[] = [];
  if (openXrLoader === "meta") offers.push({ id: "openxr-loader", ...OFFERS["openxr-loader"] });
  if (ovrPluginSwitch) offers.push({ id: "ovrplugin-runtime", ...OFFERS["ovrplugin-runtime"] });
  if (ovrPlugin === "vrapi") {
    // Getting past Unity's check would only reach VrApi, which aborts the app without Meta's system software.
    warnings.push("This app draws its VR view through Meta's VrApi, which only exists on Quest headsets. Frameloader can't patch that, so it will likely quit at start on the Frame.");
  } else if (unityOculusCheck) {
    offers.push({ id: "unity-oculus-check", ...OFFERS["unity-oculus-check"] });
  }
  return { openXrLoader, unityOculusCheck, ovrPlugin, ovrPluginSwitch, offers, warnings };
}

export interface QuestPatchInput {
  input: string;
  out: string;
  key: SigningKey;
  patches: QuestPatchId[];
  /** The replacement libopenxr_loader.so, for "openxr-loader". */
  openXrLoader?: Buffer;
}

export interface QuestPatchResult {
  /** Plain-language notes on what changed, for the activity log. */
  notes: string[];
  /** Patches that were asked for but found nothing to change. */
  unused: QuestPatchId[];
}

// Old signatures don't survive a rewrite; the APK gets a fresh v2 signature.
const SIGNATURE_FILE = /^(META-INF\/[^/]+\.(SF|RSA|DSA|EC)$|META-INF\/MANIFEST\.MF$|stamp-cert-sha256$)/i;

/**
 * Write a patched, re-signed copy of `input` to `out`. Entries are copied one
 * at a time (still compressed when untouched), so large APKs aren't loaded
 * into memory whole.
 */
export async function applyQuestPatches(p: QuestPatchInput): Promise<QuestPatchResult> {
  const want = new Set(p.patches);
  if (want.has("openxr-loader") && !p.openXrLoader) throw new Error("The replacement OpenXR loader is missing.");
  let loaderSwapped = false;
  let checksPatched = 0;
  let ovrSwitched = false;
  const writer = new ZipWriter(p.out);
  try {
    await forEachRawEntry(p.input, (e) => {
      if (SIGNATURE_FILE.test(e.name)) return;
      let out: RawEntry = e;
      if (want.has("openxr-loader") && e.name === OPENXR_LOADER_ENTRY && classifyOpenXrLoader(inflateEntry(e)) === "meta") {
        // Keep the entry's storage: an app with extractNativeLibs=false needs its libraries stored and page-aligned.
        out = makeEntry(e.name, p.openXrLoader!, e.method === 0 ? 0 : 8);
        loaderSwapped = true;
      } else if (want.has("ovrplugin-runtime") && e.name === OVRPLUGIN_ENTRY) {
        const so = Buffer.from(inflateEntry(e));
        if (allowNonOculusRuntime(so)) {
          out = makeEntry(e.name, so, e.method === 0 ? 0 : 8);
          ovrSwitched = true;
        }
      } else if (want.has("unity-oculus-check") && isDex(e.name)) {
        const dex = inflateEntry(e);
        const n = forceReturnTrue(dex, [UNITY_OCULUS_CHECK]);
        if (n) {
          checksPatched += n;
          out = makeEntry(e.name, dex, 8);
        }
      }
      writer.add(out);
    });
  } finally {
    writer.finish();
  }
  signApkV2File(p.out, p.key);

  const notes: string[] = [];
  const unused: QuestPatchId[] = [];
  if (want.has("openxr-loader")) {
    if (loaderSwapped) notes.push("Replaced Meta's OpenXR loader with the Khronos loader.");
    else unused.push("openxr-loader");
  }
  if (want.has("ovrplugin-runtime")) {
    if (ovrSwitched) notes.push("Turned on OVRPlugin's support for non-Meta OpenXR runtimes.");
    else unused.push("ovrplugin-runtime");
  }
  if (want.has("unity-oculus-check")) {
    if (checksPatched) notes.push("Made Unity's Oculus plugin accept the Frame as a supported headset.");
    else unused.push("unity-oculus-check");
  }
  return { notes, unused };
}
