import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { sniffBinary } from "../src/main/payload/binary";
import { abisFromEntries, apkIssues, inspectApk } from "../src/main/payload/apk";
import { inspectPaths, getPayload, discardPayload } from "../src/main/payload/index";
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
