import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, createVerify, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manifestIdentity, parseAxml, unmarkSplitRequired } from "../src/main/apk/axml";
import { mergeArsc, parseArsc, writeArsc, type ResTable } from "../src/main/apk/arsc";
import { definesMethod, fixChecksums, forceReturnTrue, LEPTON_CLIPBOARD_CALLS, nopVoidCalls, UNITY_OCULUS_CHECK } from "../src/main/apk/dex";
import { allowNonOculusRuntime, applyQuestPatches, classifyOpenXrLoader, detectQuestPatches, findOvrNonOculusFlagTest, OPENXR_LOADER_ENTRY, OVRPLUGIN_ENTRY } from "../src/main/apk/quest";
import { elfNeeded } from "../src/main/apk/elf";
import { mergeSplits } from "../src/main/apk/merge";
import { contentDigest, loadOrCreateSigningKey, selfSignedCert, signApkV2, signApkV2File } from "../src/main/apk/sign";
import { inflateEntry, makeEntry, readRawEntries, ZipWriter } from "../src/main/apk/zip";
import { inspectApk } from "../src/main/payload/apk";
import { mergeBundle } from "../src/main/payload/bundle";

const FIXTURE = join(__dirname, "..", "..", "test", "fixtures", "termux-window.apk");

async function entry(path: string, name: string): Promise<Buffer> {
  const [e] = await readRawEntries(path, (n) => n === name);
  if (!e) throw new Error(`${path} has no ${name}`);
  return inflateEntry(e);
}

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "frameloader-test-"));
  process.on("exit", () => rmSync(d, { recursive: true, force: true }));
  return d;
}

/** Local-header data offsets, for alignment checks. */
function dataOffsets(path: string): { name: string; method: number; offset: number }[] {
  const buf = readFileSync(path);
  const eocd = buf.length - 22;
  const cdOff = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  const out: { name: string; method: number; offset: number }[] = [];
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(local + 26);
    const lExtraLen = buf.readUInt16LE(local + 28);
    out.push({ name, method: buf.readUInt16LE(p + 10), offset: local + 30 + lNameLen + lExtraLen });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Independent check of a v2-signed APK: block layout, RSA signature, content digest, certificate. */
function verifyV2(path: string): { sigOk: boolean; digestOk: boolean; cn: string } {
  const zip = readFileSync(path);
  const eocd = zip.length - 22;
  const cdOff = zip.readUInt32LE(eocd + 16);
  assert.equal(zip.toString("latin1", cdOff - 16, cdOff), "APK Sig Block 42");
  const blockSize = Number(zip.readBigUInt64LE(cdOff - 24));
  const blockStart = cdOff - blockSize - 8;
  assert.equal(Number(zip.readBigUInt64LE(blockStart)), blockSize);
  const pairLen = Number(zip.readBigUInt64LE(blockStart + 8));
  assert.equal(zip.readUInt32LE(blockStart + 16), 0x7109871a);
  const value = zip.subarray(blockStart + 20, blockStart + 16 + pairLen);
  const signers = value.subarray(4, 4 + value.readUInt32LE(0));
  const signer = signers.subarray(4, 4 + signers.readUInt32LE(0));
  let q = 0;
  const sdLen = signer.readUInt32LE(q);
  q += 4;
  const signedData = signer.subarray(q, q + sdLen);
  q += sdLen;
  const sigsLen = signer.readUInt32LE(q);
  q += 4;
  const sigs = signer.subarray(q, q + sigsLen);
  q += sigsLen;
  const pk = signer.subarray(q + 4, q + 4 + signer.readUInt32LE(q));
  const sig0 = sigs.subarray(4, 4 + sigs.readUInt32LE(0));
  assert.equal(sig0.readUInt32LE(0), 0x0103);
  const v = createVerify("RSA-SHA256");
  v.update(signedData);
  const sigOk = v.verify(createPublicKey({ key: pk, format: "der", type: "spki" }), sig0.subarray(8, 8 + sig0.readUInt32LE(4)));
  const digests = signedData.subarray(4, 4 + signedData.readUInt32LE(0));
  const d0 = digests.subarray(4, 4 + digests.readUInt32LE(0));
  const certsOff = 4 + digests.length;
  const certs = signedData.subarray(certsOff + 4, certsOff + 4 + signedData.readUInt32LE(certsOff));
  const cert = new X509Certificate(certs.subarray(4, 4 + certs.readUInt32LE(0)));
  const eocdForDigest = Buffer.from(zip.subarray(eocd));
  eocdForDigest.writeUInt32LE(blockStart, 16);
  const expected = contentDigest(zip.subarray(0, blockStart), zip.subarray(cdOff, eocd), eocdForDigest);
  return { sigOk, digestOk: expected.equals(d0.subarray(8, 8 + d0.readUInt32LE(4))), cn: cert.subject };
}

test("zip writer aligns stored entries and yauzl reads the result back", async () => {
  const dir = tempDir();
  const out = join(dir, "t.zip");
  const w = new ZipWriter(out);
  w.add(makeEntry("AndroidManifest.xml", Buffer.from("manifest ".repeat(50)), 8));
  w.add(makeEntry("resources.arsc", Buffer.from("arsc"), 0));
  w.add(makeEntry("lib/arm64-v8a/libx.so", Buffer.alloc(5000, 7), 0));
  w.add(makeEntry("assets/a.txt", Buffer.from("hello"), 0));
  w.finish();
  const back = await readRawEntries(out);
  assert.deepEqual(back.map((e) => [e.name, e.method, e.uncompressedSize]), [["AndroidManifest.xml", 8, 450], ["resources.arsc", 0, 4], ["lib/arm64-v8a/libx.so", 0, 5000], ["assets/a.txt", 0, 5]]);
  assert.equal(inflateEntry(back[0]!).toString(), "manifest ".repeat(50));
  assert.ok(inflateEntry(back[2]!).equals(Buffer.alloc(5000, 7)));
  for (const e of dataOffsets(out)) {
    if (e.method !== 0) continue;
    assert.equal(e.offset % (e.name.endsWith(".so") ? 4096 : 4), 0, `${e.name} is misaligned at ${e.offset}`);
  }
});

test("binary manifest: identity, and split markers are left alone when absent", async () => {
  const m = await entry(FIXTURE, "AndroidManifest.xml");
  assert.deepEqual(manifestIdentity(m), { package: "com.termux.window", versionCode: 14 });
  const doc = parseAxml(m);
  assert.ok(doc.elements.some((e) => e.name === "application"));
  const before = Buffer.from(m);
  assert.deepEqual(unmarkSplitRequired(m), []);
  assert.ok(m.equals(before));
});

test("resource table round-trips and merges a config split", async () => {
  const arsc = await entry(FIXTURE, "resources.arsc");
  const table = parseArsc(arsc);
  const again = parseArsc(writeArsc(table));
  assert.deepEqual(again.strings.strings, table.strings.strings);
  assert.equal(again.packages[0]!.types.length, table.packages[0]!.types.length);

  // Fake a split: same package, one type chunk with a new config and a new string value.
  const pkg = table.packages[0]!;
  const src = pkg.types.find((t) => t.entries.some(Boolean))!;
  const config = Buffer.from(src.config);
  config.writeUInt16LE(480, 10); // density = xxhdpi
  const split: ResTable = {
    strings: { strings: ["from-split"], styles: [], utf8: true, sorted: false },
    packages: [{
      id: pkg.id, name: pkg.name,
      typeStrings: { strings: [...pkg.typeStrings.strings], styles: [], utf8: true, sorted: false },
      keyStrings: { strings: ["brand_new_key"], styles: [], utf8: true, sorted: false },
      specs: new Map([[src.typeId, { typeId: src.typeId, flags: new Array(src.entries.length).fill(0x100) }]]),
      types: [{ typeId: src.typeId, config, entries: src.entries.map((e, i) => (i === 0 ? { flags: 0, key: 0, value: { dataType: 0x03, data: 0 } } : null)) }],
      extra: [],
    }],
  };
  const beforeStrings = table.strings.strings.length;
  const r = mergeArsc(table, split);
  assert.deepEqual(r, { addedConfigs: 1, mergedEntries: 0, conflicts: 0 });
  assert.equal(table.strings.strings[beforeStrings], "from-split");
  assert.ok(pkg.keyStrings.strings.includes("brand_new_key"));
  const merged = parseArsc(writeArsc(table));
  const added = merged.packages[0]!.types.find((t) => t.typeId === src.typeId && t.config.equals(config));
  assert.ok(added, "the split's configuration is in the written table");
  assert.equal(merged.strings.strings[added!.entries[0]!.value!.data], "from-split");
  // Merging the same split again changes nothing.
  assert.deepEqual(mergeArsc(table, split), { addedConfigs: 0, mergedEntries: 0, conflicts: 0 });
});

test("dex: walks real bytecode without touching it, and recomputes header hashes exactly", async () => {
  const dex = await entry(FIXTURE, "classes.dex");
  const original = Buffer.from(dex);
  assert.equal(nopVoidCalls(dex, LEPTON_CLIPBOARD_CALLS), 0);
  assert.ok(dex.equals(original));
  // A no-op edit must reproduce dx/d8's own checksum and signature.
  dex.fill(0, 8, 32);
  fixChecksums(dex);
  assert.ok(dex.equals(original), "checksum/signature round-trip");
  // Blanking a call the fixture does make.
  const n = nopVoidCalls(dex, [{ class: "Landroid/app/Activity;", name: "setContentView" }]);
  assert.ok(n >= 1, "fixture calls setContentView");
  assert.ok(!dex.equals(original));
  assert.notEqual(dex.readUInt32LE(8), original.readUInt32LE(8), "checksum updated");
});

test("signing: self-signed certificate and a v2 block Android's rules accept", () => {
  const dir = tempDir();
  const key = loadOrCreateSigningKey(join(dir, "k.pem"));
  const again = loadOrCreateSigningKey(join(dir, "k.pem"));
  assert.ok(key.cert.equals(again.cert), "the key is persisted");
  const cert = new X509Certificate(selfSignedCert(key.privateKey, "Test"));
  assert.equal(cert.subject, "CN=Test");
  assert.ok(cert.checkIssued(cert));

  const unsigned = join(dir, "u.apk");
  const w = new ZipWriter(unsigned);
  w.add(makeEntry("a.txt", Buffer.alloc(3 * 1024 * 1024 + 123, 1), 8)); // several digest chunks
  w.add(makeEntry("b.bin", Buffer.alloc(10, 2), 0));
  w.finish();
  const signed = join(dir, "s.apk");
  writeFileSync(signed, signApkV2(readFileSync(unsigned), key));
  assert.deepEqual(verifyV2(signed), { sigOk: true, digestOk: true, cn: "CN=Frameloader" });
  // The zip is still readable and the central directory still points at every entry.
  return readRawEntries(signed).then((es) => assert.deepEqual(es.map((e) => e.name), ["a.txt", "b.bin"]));
});

/** A pretend split: a zip with a manifest, native libs for `abi`, and optionally the base's resource table. */
async function fakeSplit(dir: string, name: string, abi: string | null, withArsc: boolean): Promise<string> {
  const out = join(dir, name);
  const w = new ZipWriter(out);
  w.add(makeEntry("AndroidManifest.xml", await entry(FIXTURE, "AndroidManifest.xml"), 8));
  if (abi) w.add(makeEntry(`lib/${abi}/libfake.so`, Buffer.alloc(8192, abi.length), 0));
  if (withArsc) w.add(makeEntry("resources.arsc", await entry(FIXTURE, "resources.arsc"), 0));
  w.add(makeEntry("META-INF/CERT.RSA", Buffer.from("x"), 0));
  w.finish();
  return out;
}

test("merging splits produces one aligned, signed APK the inspector understands", async () => {
  const dir = tempDir();
  const key = loadOrCreateSigningKey(join(dir, "k.pem"));
  const out = join(dir, "merged.apk");
  const r = await mergeSplits({ base: FIXTURE, splits: [await fakeSplit(dir, "s1.apk", "arm64-v8a", true), await fakeSplit(dir, "s2.apk", null, true)], out, key });
  assert.equal(r.added, 1);
  assert.deepEqual(r.clashes, []);
  assert.equal(r.resources.conflicts, 0);
  const names = (await readRawEntries(out)).map((e) => e.name);
  assert.equal(names[0], "AndroidManifest.xml");
  assert.equal(names[1], "resources.arsc");
  assert.ok(names.includes("lib/arm64-v8a/libfake.so"));
  assert.ok(!names.some((n) => /^META-INF\/.*\.(RSA|SF|MF)$/.test(n)), "old signature files are gone");
  for (const e of dataOffsets(out)) if (e.method === 0) assert.equal(e.offset % (e.name.endsWith(".so") ? 4096 : 4), 0, e.name);
  assert.deepEqual(verifyV2(out), { sigOk: true, digestOk: true, cn: "CN=Frameloader" });
  const facts = await inspectApk(out);
  assert.equal(facts.package, "com.termux.window");
  assert.ok(facts.abis.includes("arm64-v8a"));
});

test("a bundle keeps the arm64 split, drops the others, and refuses mixed bundles", async () => {
  const dir = tempDir();
  const bundle = join(dir, "app.apkm");
  const w = new ZipWriter(bundle);
  w.add(makeEntry("info.json", Buffer.from('{"pname":"com.termux.window"}'), 8));
  w.add(makeEntry("base.apk", readFileSync(FIXTURE), 0));
  w.add(makeEntry("split_config.arm64_v8a.apk", readFileSync(await fakeSplit(dir, "a.apk", "arm64-v8a", false)), 0));
  w.add(makeEntry("split_config.x86_64.apk", readFileSync(await fakeSplit(dir, "x.apk", "x86_64", false)), 0));
  w.add(makeEntry("split_config.xxhdpi.apk", readFileSync(await fakeSplit(dir, "d.apk", null, true)), 0));
  w.finish();
  const r = await mergeBundle(bundle, join(dir, "k.pem"));
  try {
    const names = (await readRawEntries(r.apkPath)).map((e) => e.name);
    assert.ok(names.includes("lib/arm64-v8a/libfake.so"));
    assert.ok(!names.includes("lib/x86_64/libfake.so"), "the x86_64 split was left out");
    assert.match(r.notes[0]!, /arm64 libraries/);
    assert.match(r.warnings.join("\n"), /x86_64/);
    assert.deepEqual(r.obbPaths, []);
  } finally {
    rmSync(r.tempDir, { recursive: true, force: true });
  }

  const only32 = join(dir, "arm32.apkm");
  const w2 = new ZipWriter(only32);
  w2.add(makeEntry("base.apk", readFileSync(FIXTURE), 0));
  w2.add(makeEntry("split_config.armeabi_v7a.apk", readFileSync(await fakeSplit(dir, "v7.apk", "armeabi-v7a", false)), 0));
  w2.finish();
  await assert.rejects(mergeBundle(only32, join(dir, "k.pem")), /no arm64 build/);
});

// ---- Quest compatibility patches ---------------------------------------------

function uleb(n: number): Buffer {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return Buffer.from(out);
}

/** The bytecode Unity's OculusUnity.getIsOnOculusHardware compiles to (FNAF SL VR, Commedia). */
const UNITY_CHECK_INSNS = [0x0062, 0x001d, 0x0162, 0x0180, 0x206e, 0x043f, 0x0010, 0x000c, 0x011a, 0x043c, 0x206e, 0x0434, 0x0010, 0x000a, 0x000f];

/**
 * A minimal dex with one class, Lcom/unity/oculus/OculusUnity;, holding a
 * boolean getIsOnOculusHardware() and a void other(). Only the sections the
 * patcher reads are filled in.
 */
function unityDex(): Buffer {
  const strings = ["Lcom/unity/oculus/OculusUnity;", "Z", "getIsOnOculusHardware", "Ljava/lang/Object;", "V", "other"];
  const header = 0x70;
  const stringIds = header;
  const typeIds = stringIds + strings.length * 4;
  const types = [0, 1, 3, 4]; // OculusUnity, Z, Object, V
  const protoIds = typeIds + types.length * 4;
  const protos = [[1, 1], [4, 3]]; // [shorty string, return type]
  const methodIds = protoIds + protos.length * 12;
  const methods = [[0, 0, 2], [0, 1, 5]]; // [class type, proto, name string]
  const classDefs = methodIds + methods.length * 8;
  let p = classDefs + 32;
  const code = (regs: number, insns: number[]) => {
    const b = Buffer.alloc(16 + insns.length * 2);
    b.writeUInt16LE(regs, 0);
    b.writeUInt32LE(insns.length, 12);
    insns.forEach((w, i) => b.writeUInt16LE(w, 16 + i * 2));
    return b;
  };
  const code0Off = p;
  const code0 = code(2, UNITY_CHECK_INSNS);
  p += code0.length;
  p = (p + 3) & ~3;
  const code1Off = p;
  const code1 = code(1, [0x000e]);
  p += code1.length;
  const classData = Buffer.concat([uleb(0), uleb(0), uleb(2), uleb(0), uleb(0), uleb(9), uleb(code0Off), uleb(1), uleb(9), uleb(code1Off)]);
  const classDataOff = p;
  p += classData.length;
  const stringData: Buffer[] = [];
  const stringOffs: number[] = [];
  for (const str of strings) {
    stringOffs.push(p);
    const b = Buffer.concat([uleb(str.length), Buffer.from(str, "latin1"), Buffer.from([0])]);
    stringData.push(b);
    p += b.length;
  }
  const dex = Buffer.alloc(p);
  dex.write("dex\n035\0", 0, "latin1");
  dex.writeUInt32LE(p, 0x20);
  dex.writeUInt32LE(header, 0x24);
  dex.writeUInt32LE(0x12345678, 0x28);
  dex.writeUInt32LE(strings.length, 0x38);
  dex.writeUInt32LE(stringIds, 0x3c);
  dex.writeUInt32LE(types.length, 0x40);
  dex.writeUInt32LE(typeIds, 0x44);
  dex.writeUInt32LE(protos.length, 0x48);
  dex.writeUInt32LE(protoIds, 0x4c);
  dex.writeUInt32LE(methods.length, 0x58);
  dex.writeUInt32LE(methodIds, 0x5c);
  dex.writeUInt32LE(1, 0x60);
  dex.writeUInt32LE(classDefs, 0x64);
  stringOffs.forEach((o, i) => dex.writeUInt32LE(o, stringIds + i * 4));
  types.forEach((t, i) => dex.writeUInt32LE(t, typeIds + i * 4));
  protos.forEach(([shorty, ret], i) => {
    dex.writeUInt32LE(shorty!, protoIds + i * 12);
    dex.writeUInt32LE(ret!, protoIds + i * 12 + 4);
  });
  methods.forEach(([cls, proto, name], i) => {
    dex.writeUInt16LE(cls!, methodIds + i * 8);
    dex.writeUInt16LE(proto!, methodIds + i * 8 + 2);
    dex.writeUInt32LE(name!, methodIds + i * 8 + 4);
  });
  dex.writeUInt32LE(0, classDefs); // class_idx
  dex.writeUInt32LE(1, classDefs + 4); // public
  dex.writeUInt32LE(2, classDefs + 8); // superclass Object
  dex.writeUInt32LE(0xffffffff, classDefs + 16); // no source file
  dex.writeUInt32LE(classDataOff, classDefs + 24);
  code0.copy(dex, code0Off);
  code1.copy(dex, code1Off);
  classData.copy(dex, classDataOff);
  let q = stringOffs[0]!;
  for (const b of stringData) {
    b.copy(dex, q);
    q += b.length;
  }
  fixChecksums(dex);
  return dex;
}

const insnsAt = (dex: Buffer, codeOff: number) => Array.from({ length: dex.readUInt32LE(codeOff + 12) }, (_, i) => dex.readUInt16LE(codeOff + 16 + i * 2));

test("dex: Unity's Oculus check is found and rewritten to return true; nothing else changes", () => {
  const dex = unityDex();
  assert.equal(definesMethod(dex, [UNITY_OCULUS_CHECK]), true);
  assert.equal(definesMethod(dex, [{ class: "Lcom/unity/oculus/OculusUnity;", name: "missing" }]), false);
  const before = Buffer.from(dex);
  const code0 = 0x70 + 6 * 4 + 4 * 4 + 2 * 12 + 2 * 8 + 32;
  assert.deepEqual(insnsAt(dex, code0), UNITY_CHECK_INSNS);
  // A void method isn't touched even when named.
  assert.equal(forceReturnTrue(dex, [{ class: "Lcom/unity/oculus/OculusUnity;", name: "other" }]), 0);
  assert.ok(dex.equals(before));
  assert.equal(forceReturnTrue(dex, [UNITY_OCULUS_CHECK]), 1);
  assert.deepEqual(insnsAt(dex, code0), [0x1012, 0x000f, ...Array(13).fill(0)]);
  // Only the method body and the header hashes differ.
  for (let i = 32; i < dex.length; i++) if (i < code0 + 16 || i >= code0 + 16 + 30) assert.equal(dex[i], before[i], `byte ${i} changed`);
  const check = Buffer.from(dex);
  fixChecksums(check);
  assert.ok(check.equals(dex), "checksum and signature are current");
  // A second pass is a no-op rewrite of the same body.
  forceReturnTrue(dex, [UNITY_OCULUS_CHECK]);
  assert.deepEqual(insnsAt(dex, code0), [0x1012, 0x000f, ...Array(13).fill(0)]);
});

test("OpenXR loaders: Meta's is told apart from Khronos's", () => {
  assert.equal(classifyOpenXrLoader(Buffer.from("...Failed to find default runtime...com.oculus.systemdriver.DriverLoader...")), "meta");
  assert.equal(classifyOpenXrLoader(Buffer.from("org.khronos.openxr.runtime_broker /active_runtime.json")), "khronos");
  // Some Khronos builds mention Oculus too; the broker string wins.
  assert.equal(classifyOpenXrLoader(Buffer.from("com.oculus.systemdriver org.khronos.openxr.runtime_broker")), "khronos");
  assert.equal(classifyOpenXrLoader(Buffer.from("nothing to see")), "unknown");
});

test("in-place file signing gives the same bytes as in-memory signing", () => {
  const dir = tempDir();
  const key = loadOrCreateSigningKey(join(dir, "k.pem"));
  const unsigned = join(dir, "u.apk");
  const w = new ZipWriter(unsigned);
  w.add(makeEntry("a.bin", Buffer.alloc(2 * 1024 * 1024 + 77, 3), 0)); // spans digest chunks
  w.add(makeEntry("b.txt", Buffer.from("b".repeat(5000)), 8));
  w.finish();
  const expected = signApkV2(readFileSync(unsigned), key);
  signApkV2File(unsigned, key);
  assert.ok(readFileSync(unsigned).equals(expected));
  assert.deepEqual(verifyV2(unsigned), { sigOk: true, digestOk: true, cn: "CN=Frameloader" });
});

/** The fixture plus a Meta-style OpenXR loader (stored, as with extractNativeLibs=false) and a Unity Oculus plugin dex. */
async function questLikeApk(dir: string): Promise<string> {
  const out = join(dir, "quest.apk");
  const w = new ZipWriter(out);
  for (const e of await readRawEntries(FIXTURE)) w.add(e);
  w.add(makeEntry(OPENXR_LOADER_ENTRY, Buffer.concat([Buffer.alloc(9000, 1), Buffer.from("com.oculus.systemdriver")]), 0));
  w.add(makeEntry("classes2.dex", unityDex(), 8));
  w.add(makeEntry("META-INF/CERT.RSA", Buffer.from("old signature"), 8));
  w.finish();
  return out;
}

test("Quest patches: detected on a Quest-style APK, not on a plain one", async () => {
  const dir = tempDir();
  const plain = await detectQuestPatches(FIXTURE);
  assert.deepEqual(plain.offers, []);
  assert.equal(plain.openXrLoader, undefined);
  const quest = await detectQuestPatches(await questLikeApk(dir));
  assert.equal(quest.openXrLoader, "meta");
  assert.equal(quest.unityOculusCheck, true);
  assert.deepEqual(quest.offers.map((o) => o.id), ["openxr-loader", "unity-oculus-check"]);
  for (const o of quest.offers) assert.ok(o.title && o.explanation.length > 40);
});

test("Quest patches: the loader is swapped and the check patched in a re-signed, aligned APK", async () => {
  const dir = tempDir();
  const key = loadOrCreateSigningKey(join(dir, "k.pem"));
  const input = await questLikeApk(dir);
  const khronos = Buffer.concat([Buffer.alloc(5000, 2), Buffer.from("org.khronos.openxr.runtime_broker")]);
  const out = join(dir, "patched.apk");
  const r = await applyQuestPatches({ input, out, key, patches: ["openxr-loader", "unity-oculus-check"], openXrLoader: khronos });
  assert.equal(r.notes.length, 2);
  assert.deepEqual(r.unused, []);
  const before = await readRawEntries(input);
  const after = await readRawEntries(out);
  assert.deepEqual(after.map((e) => e.name), before.map((e) => e.name).filter((n) => !n.startsWith("META-INF/")));
  const loader = after.find((e) => e.name === OPENXR_LOADER_ENTRY)!;
  assert.equal(loader.method, 0, "the loader stays stored");
  assert.ok(inflateEntry(loader).equals(khronos));
  assert.equal(forceReturnTrue(inflateEntry(after.find((e) => e.name === "classes2.dex")!), [UNITY_OCULUS_CHECK]), 1, "still a valid dex with the method");
  assert.equal(definesMethod(inflateEntry(after.find((e) => e.name === "classes2.dex")!), [UNITY_OCULUS_CHECK]), true);
  const dex2 = inflateEntry(after.find((e) => e.name === "classes2.dex")!);
  const code0 = 0x70 + 6 * 4 + 4 * 4 + 2 * 12 + 2 * 8 + 32;
  assert.deepEqual(insnsAt(dex2, code0).slice(0, 2), [0x1012, 0x000f]);
  // Everything else is byte-for-byte the same.
  for (const e of after) {
    if (e.name === OPENXR_LOADER_ENTRY || e.name === "classes2.dex") continue;
    const orig = before.find((b) => b.name === e.name)!;
    assert.ok(orig.raw.equals(e.raw) && orig.method === e.method, `${e.name} changed`);
  }
  for (const e of dataOffsets(out)) if (e.method === 0) assert.equal(e.offset % (e.name.endsWith(".so") ? 4096 : 4), 0, e.name);
  assert.deepEqual(verifyV2(out), { sigOk: true, digestOk: true, cn: "CN=Frameloader" });
  assert.equal((await inspectApk(out)).package, "com.termux.window");
  // Already patched: nothing left to change, and that's reported.
  const again = await applyQuestPatches({ input: out, out: join(dir, "again.apk"), key, patches: ["openxr-loader"], openXrLoader: khronos });
  assert.deepEqual(again.unused, ["openxr-loader"]);
  assert.deepEqual((await detectQuestPatches(out)).offers.map((o) => o.id), ["unity-oculus-check"], "the Unity method still exists; only its body changed");
});

/**
 * A tiny AArch64 ELF shaped like Meta's OVRPlugin: DT_NEEDED entries, the two
 * runtime-check strings, and the code that tests the "support non-Oculus
 * runtime" flag right before logging it (copied from OVRPlugin 1.100.1).
 */
function fakeOvrPlugin(needed: string[], opts: { withSwitch?: boolean; branchOnFlags?: boolean } = {}): Buffer {
  const so = Buffer.alloc(0x3000);
  so.writeUInt32BE(0x7f454c46, 0);
  so[4] = 2; // ELF64
  so[5] = 1; // little-endian
  so.writeUInt16LE(3, 16); // ET_DYN
  so.writeUInt16LE(0xb7, 18); // AArch64
  so.writeBigUInt64LE(64n, 32); // e_phoff
  so.writeUInt16LE(56, 54);
  so.writeUInt16LE(2, 56);
  // PT_LOAD r-x over the whole file at vaddr 0
  so.writeUInt32LE(1, 64);
  so.writeUInt32LE(5, 68);
  so.writeBigUInt64LE(BigInt(so.length), 64 + 32);
  // PT_DYNAMIC at 0x200
  so.writeUInt32LE(2, 120);
  so.writeBigUInt64LE(0x200n, 120 + 8);
  so.writeBigUInt64LE(0x200n, 120 + 16);
  so.writeBigUInt64LE(0x100n, 120 + 32);
  // .dynstr at 0x400
  let str = 0x401;
  const dyn: [number, number][] = [];
  for (const n of needed) {
    so.write(n + "\0", str, "latin1");
    dyn.push([1, str - 0x400]);
    str += n.length + 1;
  }
  dyn.push([5, 0x400], [0, 0]);
  dyn.forEach(([tag, val], i) => {
    so.writeBigInt64LE(BigInt(tag), 0x200 + i * 16);
    so.writeBigUInt64LE(BigInt(val), 0x200 + i * 16 + 8);
  });
  so.write("Non-Oculus OpenXR runtime is not supported.\0", 0x1f00, "latin1");
  if (opts.withSwitch !== false) so.write("Support Non-Oculus runtime: %s\0", 0x1604, "latin1");
  // Code at 0x1000: ands w8, w25, #0x8; [b.eq]; adrp x3, 0x1000; add x3, x3, #0x604; mov w0, #1; bl
  const code = [0x721d0328, opts.branchOnFlags ? 0x54000040 : 0xd503201f, 0x90000003, 0x91181063, 0x52800020, 0x94000000];
  code.forEach((w, i) => so.writeUInt32LE(w >>> 0, 0x1000 + i * 4));
  return so;
}

test("ELF: DT_NEEDED is read from the dynamic section", () => {
  assert.deepEqual(elfNeeded(fakeOvrPlugin(["libopenxr_loader.so", "liblog.so"])), ["libopenxr_loader.so", "liblog.so"]);
  assert.deepEqual(elfNeeded(Buffer.from("not an elf at all, just some text padding it out to size".repeat(2))), []);
});

test("OVRPlugin: the non-Oculus runtime switch is found and turned on in place", () => {
  const so = fakeOvrPlugin(["libopenxr_loader.so"]);
  assert.equal(findOvrNonOculusFlagTest(so), 0x1000);
  const before = Buffer.from(so);
  assert.equal(allowNonOculusRuntime(so), true);
  assert.equal(so.readUInt32LE(0x1000), 0x321d03e8, "ands w8, w25, #0x8 became orr w8, wzr, #0x8");
  for (let i = 0; i < so.length; i++) if (i < 0x1000 || i >= 0x1004) assert.equal(so[i], before[i], `byte ${i} changed`);
  // Refuses code that branches on the flags, and builds without the switch.
  assert.equal(findOvrNonOculusFlagTest(fakeOvrPlugin(["libopenxr_loader.so"], { branchOnFlags: true })), undefined);
  assert.equal(findOvrNonOculusFlagTest(fakeOvrPlugin(["libopenxr_loader.so"], { withSwitch: false })), undefined);
  assert.equal(allowNonOculusRuntime(fakeOvrPlugin(["libvrapi.so"], { withSwitch: false })), false);
});

async function apkWith(dir: string, name: string, extra: [string, Buffer][]): Promise<string> {
  const out = join(dir, name);
  const w = new ZipWriter(out);
  for (const e of await readRawEntries(FIXTURE)) w.add(e);
  for (const [n, b] of extra) w.add(makeEntry(n, b, 0));
  w.finish();
  return out;
}

test("Quest patches: an OpenXR OVRPlugin gets the runtime switch; a VrApi one gets a warning instead of the Unity patch", async () => {
  const dir = tempDir();
  const openxr = await apkWith(dir, "openxr.apk", [[OVRPLUGIN_ENTRY, fakeOvrPlugin(["libopenxr_loader.so"])], ["classes2.dex", unityDex()]]);
  const d1 = await detectQuestPatches(openxr);
  assert.equal(d1.ovrPlugin, "openxr");
  assert.deepEqual(d1.offers.map((o) => o.id), ["ovrplugin-runtime", "unity-oculus-check"]);
  assert.deepEqual(d1.warnings, []);
  const vrapi = await apkWith(dir, "vrapi.apk", [[OVRPLUGIN_ENTRY, fakeOvrPlugin(["libvrapi.so"], { withSwitch: false })], ["classes2.dex", unityDex()]]);
  const d2 = await detectQuestPatches(vrapi);
  assert.equal(d2.ovrPlugin, "vrapi");
  assert.equal(d2.unityOculusCheck, true);
  assert.deepEqual(d2.offers, [], "passing Unity's check would only reach VrApi, which aborts");
  assert.match(d2.warnings[0] ?? "", /VrApi/);

  const key = loadOrCreateSigningKey(join(dir, "k.pem"));
  const out = join(dir, "openxr-patched.apk");
  const r = await applyQuestPatches({ input: openxr, out, key, patches: ["ovrplugin-runtime"] });
  assert.deepEqual(r.unused, []);
  const so = inflateEntry((await readRawEntries(out, (n) => n === OVRPLUGIN_ENTRY))[0]!);
  assert.equal(so.readUInt32LE(0x1000), 0x321d03e8);
  assert.deepEqual(verifyV2(out), { sigOk: true, digestOk: true, cn: "CN=Frameloader" });
});
