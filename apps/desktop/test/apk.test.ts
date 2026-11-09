import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, createVerify, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manifestIdentity, parseAxml, unmarkSplitRequired } from "../src/main/apk/axml";
import { mergeArsc, parseArsc, writeArsc, type ResTable } from "../src/main/apk/arsc";
import { fixChecksums, LEPTON_CLIPBOARD_CALLS, nopVoidCalls } from "../src/main/apk/dex";
import { mergeSplits } from "../src/main/apk/merge";
import { contentDigest, loadOrCreateSigningKey, selfSignedCert, signApkV2 } from "../src/main/apk/sign";
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
