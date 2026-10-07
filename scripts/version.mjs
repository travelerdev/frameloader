#!/usr/bin/env node
// The app's version lives in apps/desktop/package.json.
//   node scripts/version.mjs get            -> prints the current version
//   node scripts/version.mjs set 1.2.3      -> sets it
//   node scripts/version.mjs next 1.2.3     -> prints 1.2.4 (the version after a release)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "desktop", "package.json");
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

const [cmd, arg] = process.argv.slice(2);
const pkg = JSON.parse(readFileSync(PKG, "utf8"));

function check(v) {
  if (!SEMVER.test(v ?? "")) {
    console.error(`"${v}" isn't a plain MAJOR.MINOR.PATCH version`);
    process.exit(1);
  }
  return v;
}

if (cmd === "get") {
  console.log(pkg.version);
} else if (cmd === "set") {
  pkg.version = check(arg);
  writeFileSync(PKG, JSON.stringify(pkg, null, 2) + "\n");
  console.log(pkg.version);
} else if (cmd === "next") {
  const [, a, b, c] = check(arg ?? pkg.version).match(SEMVER);
  console.log(`${a}.${b}.${Number(c) + 1}`);
} else {
  console.error("usage: version.mjs get | set X.Y.Z | next [X.Y.Z]");
  process.exit(1);
}
