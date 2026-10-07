import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { compareVersions } from "../src/shared/version";
import { CDP_EVAL, renameJs } from "../src/main/steamClient";
import { inspectPaths, getPayload, discardPayload } from "../src/main/payload/index";
import { writeJson } from "../src/main/config";

test("compares versions numerically", () => {
  assert.equal(compareVersions("0.10.0", "0.9.3"), 1);
  assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("1.2", "1.2.1"), -1);
  assert.equal(compareVersions("1.0.0-beta.1", "1.0.0"), -1);
  assert.equal(compareVersions("2.0.0", "10.0.0"), -1);
});

test("the Steam DevTools helper is valid Python", () => {
  execFileSync("python3", ["-c", "import ast, sys; ast.parse(sys.stdin.read())"], { input: CDP_EVAL });
});

test("the rename script finds the devkit shortcut by folder and renames it", async () => {
  const calls: unknown[][] = [];
  const shortcuts = [
    { appid: 11, app_type: 1073741824, display_name: "Some other shortcut" },
    { appid: 22, app_type: 1073741824, display_name: "Devkit Game: Termux_Float" },
    { appid: 33, app_type: 1, display_name: "A real Steam game" },
  ];
  const details: Record<number, { strShortcutExe: string; strShortcutStartDir: string }> = {
    11: { strShortcutExe: "/usr/bin/foo", strShortcutStartDir: "/home/steamos" },
    22: { strShortcutExe: '"/home/steamos/devkit-game/Termux_Float/app.apk"', strShortcutStartDir: "/home/steamos/devkit-game/Termux_Float" },
  };
  const ctx = {
    appStore: { allApps: shortcuts },
    appDetailsStore: { GetAppDetails: (id: number) => details[id] },
    SteamClient: { Apps: { SetShortcutName: (...a: unknown[]) => calls.push(["name", ...a]), SetShortcutSortAs: (...a: unknown[]) => calls.push(["sort", ...a]) } },
    setTimeout,
  };
  const result = await runInNewContext(renameJs("Termux_Float", "/home/steamos/devkit-game/Termux_Float/", "Termux:Float"), ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { appid: 22, before: "Devkit Game: Termux_Float" });
  assert.deepEqual(calls, [["name", 22, "Termux:Float"], ["sort", 22, "Termux:Float"]]);
});

test("a lone program is staged by itself, not with its whole folder", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fl-exe-"));
  try {
    const pe = Buffer.alloc(0x100);
    pe.write("MZ", 0, "ascii");
    pe.writeUInt32LE(0x80, 0x3c);
    pe.write("PE\0\0", 0x80, "ascii");
    pe.writeUInt16LE(0x8664, 0x84);
    pe.writeUInt16LE(0x0002, 0x80 + 22);
    writeFileSync(join(dir, "putty.exe"), pe);
    writeFileSync(join(dir, "other.exe"), pe);
    writeFileSync(join(dir, "helper.dll"), "x".repeat(200));
    writeFileSync(join(dir, "tax-return.pdf"), "private");
    mkdirSync(join(dir, "photos"));
    writeFileSync(join(dir, "photos", "a.jpg"), "private");
    const info = await inspectPaths([join(dir, "putty.exe")]);
    const staged = getPayload(info.id)!.rootDir!;
    assert.deepEqual(readdirSync(staged), ["putty.exe"]);
    assert.equal(info.kind, "windows");
    assert.equal(info.name, "putty");
    assert.deepEqual(info.candidates?.map((c) => c.relPath), ["putty.exe"]);
    assert.equal(info.sizeBytes, 0x100);
    assert.match(info.warnings[0] ?? "", /drop its folder/);
    discardPayload(info.id);
    assert.equal(existsSync(staged), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config files are written atomically", () => {
  const dir = mkdtempSync(join(tmpdir(), "fl-cfg-"));
  try {
    const file = join(dir, "config.json");
    writeJson(file, { a: 1 });
    writeJson(file, { a: 2 });
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { a: 2 });
    assert.deepEqual(readdirSync(dir), ["config.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
