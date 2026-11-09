import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { sniffBinary } from "../src/main/payload/binary";
import { abisFromEntries, apkIssues, inspectApk, pickIconEntry } from "../src/main/payload/apk";
import { inspectPaths, getPayload, discardPayload } from "../src/main/payload/index";
import { TAR_RE, unsafeTarEntry } from "../src/main/payload/tar";
import { execFileSync } from "node:child_process";
import { toGameId, gameIdProblem } from "../src/shared/gameid";
import { splitArgs } from "../src/main/installer";
import { settingsFor, runtimeFromCompatTool } from "../src/main/runtimes";
import { lastJson } from "../src/main/devkitUtils";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const FIXTURES = join(__dirname, "..", "..", "test", "fixtures");

function pe(machine: number, dll = false): Buffer {
  const b = Buffer.alloc(0x100);
  b.write("MZ", 0, "ascii");
  b.writeUInt32LE(0x80, 0x3c);
  b.write("PE\0\0", 0x80, "ascii");
  b.writeUInt16LE(machine, 0x84);
  b.writeUInt16LE(dll ? 0x2000 : 0x0002, 0x80 + 22);
  return b;
}

function elf64(machine: number, type: number, withInterp: boolean): Buffer {
  const b = Buffer.alloc(0x200);
  b.write("\x7fELF", 0, "latin1");
  b[4] = 2; // 64-bit
  b[5] = 1; // little endian
  b.writeUInt16LE(type, 16);
  b.writeUInt16LE(machine, 18);
  b.writeBigUInt64LE(64n, 32); // e_phoff
  b.writeUInt16LE(56, 54); // e_phentsize
  b.writeUInt16LE(2, 56); // e_phnum
  b.writeUInt32LE(1, 64); // PT_LOAD
  b.writeUInt32LE(withInterp ? 3 : 1, 64 + 56); // PT_INTERP or another PT_LOAD
  return b;
}

test("sniffs PE executables and skips DLLs", () => {
  assert.deepEqual(sniffBinary(pe(0x8664)), { format: "pe", arch: "x86-64", executable: true });
  assert.deepEqual(sniffBinary(pe(0x14c)), { format: "pe", arch: "x86", executable: true });
  assert.deepEqual(sniffBinary(pe(0xaa64)), { format: "pe", arch: "arm64", executable: true });
  assert.equal(sniffBinary(pe(0x8664, true))?.executable, false);
});

test("sniffs ELF executables, PIE and shared libraries", () => {
  assert.deepEqual(sniffBinary(elf64(0xb7, 2, false)), { format: "elf", arch: "arm64", executable: true });
  assert.deepEqual(sniffBinary(elf64(0x3e, 3, true)), { format: "elf", arch: "x86-64", executable: true });
  assert.equal(sniffBinary(elf64(0xb7, 3, false))?.executable, false);
  assert.deepEqual(sniffBinary(Buffer.from("#!/bin/sh\necho hi\n")), { format: "script", arch: "other", executable: true });
  assert.equal(sniffBinary(Buffer.from("plain text")), null);
});

test("reads ABIs from lib/ entries", () => {
  assert.deepEqual(abisFromEntries(["lib/arm64-v8a/libfoo.so", "lib/armeabi-v7a/libfoo.so", "assets/x.so", "lib/arm64-v8a/notes.txt"]), ["arm64-v8a", "armeabi-v7a"]);
  assert.deepEqual(abisFromEntries(["classes.dex"]), []);
});

test("flags APKs Lepton can't install", () => {
  const base = { package: "a.b", label: "x", versionName: "1", versionCode: 1, abis: [], isVr: false, obbFiles: [] };
  assert.deepEqual(apkIssues({ ...base, abis: ["armeabi-v7a", "x86"] }).length, 1);
  assert.deepEqual(apkIssues({ ...base, abis: ["arm64-v8a", "armeabi-v7a"] }), []);
  assert.equal(apkIssues({ ...base, minSdk: 33 }).length, 1);
  assert.deepEqual(apkIssues({ ...base, minSdk: 30 }), []);
  assert.match(apkIssues({ ...base, launchable: false })[0]!, /no activity to start/);
  assert.match(apkIssues({ ...base, launchable: false, questEnvironment: true })[0]!, /Quest Home environment/);
  assert.deepEqual(apkIssues({ ...base, launchable: true }), []);
});

test("picks the largest declared icon bitmap, including shrunk resource names", () => {
  const e = (name: string, size: number) => ({ name, size });
  // app-info-parser returns one path per configuration, as an array.
  assert.equal(pickIconEntry(["res/Ut.png", "res/W5.png", "res/YA.png", "res/Qu.xml"], [e("res/Ut.png", 900), e("res/W5.png", 4000), e("res/YA.png", 2500), e("res/Qu.xml", 300)]), "res/W5.png");
  assert.equal(pickIconEntry("res/mipmap-mdpi/a.png,res/mipmap-xxhdpi/a.png", [e("res/mipmap-mdpi/a.png", 100), e("res/mipmap-xxhdpi/a.png", 900)]), "res/mipmap-xxhdpi/a.png");
  // Only an adaptive icon declared: fall back to Unity's app_icon.png, skipping layers.
  assert.equal(
    pickIconEntry(["res/mipmap-anydpi-v26/app_icon.xml"], [e("res/mipmap-anydpi-v26/app_icon.xml", 300), e("res/mipmap-hdpi-v4/app_icon.png", 2000), e("res/mipmap-xxxhdpi-v4/app_icon.png", 9000), e("res/mipmap-xxxhdpi-v4/ic_launcher_foreground.png", 20000)]),
    "res/mipmap-xxxhdpi-v4/app_icon.png",
  );
  assert.equal(pickIconEntry(undefined, [e("classes.dex", 10)]), undefined);
});

test("inspects a real APK fixture", async () => {
  const facts = await inspectApk(join(FIXTURES, "termux-window.apk"));
  assert.equal(facts.package, "com.termux.window");
  assert.equal(facts.label, "Termux:Float");
  assert.equal(facts.versionName, "0.14");
  assert.equal(facts.minSdk, 24);
  assert.ok(facts.abis.includes("arm64-v8a"));
  assert.equal(facts.isVr, false);
  assert.deepEqual(apkIssues(facts), []);
  const info = await inspectPaths([join(FIXTURES, "termux-window.apk")]);
  assert.equal(info.kind, "apk");
  assert.equal(info.name, "Termux:Float");
  assert.ok(getPayload(info.id));
  discardPayload(info.id);
});

test("finds and ranks executables in a folder", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fl-test-"));
  try {
    mkdirSync(join(dir, "Game-Win64", "Engine", "Binaries"), { recursive: true });
    writeFileSync(join(dir, "Game-Win64", "Game.exe"), pe(0x8664));
    writeFileSync(join(dir, "Game-Win64", "UnityCrashHandler64.exe"), pe(0x8664));
    writeFileSync(join(dir, "Game-Win64", "Engine", "Binaries", "helper.exe"), pe(0x8664));
    writeFileSync(join(dir, "Game-Win64", "lib.dll"), pe(0x8664, true));
    writeFileSync(join(dir, "Game-Win64", "readme.txt"), "hi");
    const info = await inspectPaths([join(dir, "Game-Win64")]);
    assert.equal(info.kind, "windows");
    assert.equal(info.candidates?.[0]?.relPath, "Game.exe");
    assert.equal(info.candidates?.length, 3);
    assert.deepEqual(info.issues, []);
    assert.equal(info.name, "Game");
    discardPayload(info.id);

    mkdirSync(join(dir, "linux"));
    writeFileSync(join(dir, "linux", "game.x86_64"), elf64(0x3e, 2, false));
    const lin = await inspectPaths([join(dir, "linux")]);
    assert.equal(lin.kind, "linux-x64");
    assert.equal(lin.issues.length, 1);
    discardPayload(lin.id);

    mkdirSync(join(dir, "arm"));
    writeFileSync(join(dir, "arm", "game"), elf64(0xb7, 3, true));
    const arm = await inspectPaths([join(dir, "arm")]);
    assert.equal(arm.kind, "linux-arm64");
    assert.deepEqual(arm.issues, []);
    discardPayload(arm.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const script = (interp: string) => `#!${interp}\n# ${"padding ".repeat(12)}\necho hi\n`;

test("an ARM64 build starts through its own launcher script, not install helpers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fl-test-"));
  try {
    // MatineeVR's layout: the binary, launch.sh, and Python install helpers.
    const mv = join(dir, "matineevr-steam-frame-linux-arm64-0-1-1");
    mkdirSync(join(mv, "ffmpeg"), { recursive: true });
    writeFileSync(join(mv, "matineevr"), elf64(0xb7, 3, true));
    writeFileSync(join(mv, "launch.sh"), script("/bin/sh"));
    writeFileSync(join(mv, "install.py"), script("/usr/bin/env python3"));
    const info = await inspectPaths([mv]);
    assert.equal(info.kind, "linux-arm64");
    assert.equal(info.candidates?.[0]?.relPath, "launch.sh");
    assert.equal(info.candidates?.at(-1)?.relPath, "install.py");
    assert.ok(info.warnings.some((w) => /launch\.sh looks like the build's own launcher/.test(w)));
    discardPayload(info.id);

    // A lone shell script named after the binary counts too.
    const g = join(dir, "game");
    mkdirSync(g);
    writeFileSync(join(g, "mygame"), elf64(0xb7, 3, true));
    writeFileSync(join(g, "mygame.sh"), script("/bin/bash"));
    const gi = await inspectPaths([g]);
    assert.equal(gi.candidates?.[0]?.relPath, "mygame.sh");
    discardPayload(gi.id);

    // A Ren'Py-style Windows build keeps its .exe: its .sh is for x86-64 Linux.
    const rp = join(dir, "TDITD-1.0-pc");
    mkdirSync(join(rp, "lib", "py3-linux-x86_64"), { recursive: true });
    writeFileSync(join(rp, "TDITD.exe"), pe(0x8664));
    writeFileSync(join(rp, "TDITD.sh"), script("/bin/sh"));
    writeFileSync(join(rp, "TDITD.py"), script("/usr/bin/env python3"));
    writeFileSync(join(rp, "lib", "py3-linux-x86_64", "TDITD"), elf64(0x3e, 3, true));
    const ri = await inspectPaths([rp]);
    assert.equal(ri.kind, "windows");
    assert.equal(ri.candidates?.[0]?.relPath, "TDITD.exe");
    discardPayload(ri.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tar archives unpack like zips, and unsafe entries are refused", async () => {
  assert.equal(unsafeTarEntry("game/bin/x"), undefined);
  assert.equal(unsafeTarEntry("/etc/passwd"), "an absolute path");
  assert.equal(unsafeTarEntry("a/../../x"), "a path with ..");
  assert.ok(TAR_RE.test("devilutionx-linux-aarch64.tar.xz") && TAR_RE.test("g.tgz") && TAR_RE.test("g.tar") && !TAR_RE.test("g.xz"));
  const dir = mkdtempSync(join(tmpdir(), "fl-test-"));
  try {
    const src = join(dir, "src");
    mkdirSync(src);
    writeFileSync(join(src, "devilutionx"), elf64(0xb7, 3, true));
    writeFileSync(join(src, "README.txt"), "data");
    for (const [name, flag] of [["devilutionx-linux-aarch64.tar.xz", "-J"], ["game.tar.gz", "-z"], ["game.tar", ""]] as const) {
      const out = join(dir, name);
      execFileSync("tar", ["-c", ...(flag ? [flag] : []), "-f", out, "-C", src, "devilutionx", "README.txt"]);
      const info = await inspectPaths([out]);
      assert.equal(info.kind, "linux-arm64", name);
      assert.equal(info.candidates?.[0]?.relPath, "devilutionx", name);
      assert.ok(!/tar|xz|gz/.test(info.name), `name "${info.name}" keeps the archive extension`);
      discardPayload(info.id);
    }
    writeFileSync(join(dir, "broken.tar.xz"), "not an archive");
    await assert.rejects(inspectPaths([join(dir, "broken.tar.xz")]), /Couldn't unpack that archive/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("derives safe library IDs", () => {
  assert.equal(toGameId("Playground"), "Playground");
  assert.equal(toGameId("Termux:Float"), "Termux_Float");
  assert.equal(toGameId("2048 Game"), "_2048_Game");
  assert.equal(toGameId("steam"), "steam_game");
  assert.equal(toGameId("Café ☕"), "Cafe");
  assert.equal(toGameId("!!!"), "Title");
  assert.equal(gameIdProblem("fc-smoke-exe"), "Use 2 to 64 letters, digits or underscores, not starting with a digit.");
  assert.equal(gameIdProblem("Playground"), null);
  assert.ok(gameIdProblem("steamvr"));
});

test("splits launch arguments loosely like a shell", () => {
  assert.deepEqual(splitArgs(`-windowed "two words" 'three more' plain`), ["-windowed", "two words", "three more", "plain"]);
  assert.deepEqual(splitArgs(""), []);
});

test("builds the settings Valve's client sends", () => {
  assert.deepEqual(settingsFor("lepton"), { steam_play: "0", compat_tool: "lepton" });
  assert.deepEqual(settingsFor("lepton", { lepton: "lepton-stable" }), { steam_play: "0", compat_tool: "lepton-stable" });
  assert.deepEqual(settingsFor("proton-experimental"), { steam_play: "1", steam_play_debug: "0", steam_play_debug_version: "2019", compat_tool: "proton-experimental" });
  assert.equal(runtimeFromCompatTool("fauxdroid"), "lepton");
  assert.equal(runtimeFromCompatTool("SteamLinuxRuntime_4-arm64"), "slr4-arm64");
});

test("takes the last JSON line from a chatty script", () => {
  assert.deepEqual(lastJson('Updating command line\nRegistering Devkit Game x\n{"success": ""}\n', "x"), { success: "" });
  assert.throws(() => lastJson("nothing here", "x"));
});
