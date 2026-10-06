// Builds main + preload (Node/CJS) and the renderer (browser) with esbuild.
// `node scripts/build.mjs --watch` rebuilds on change.
import { build, context } from "esbuild";
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const watch = process.argv.includes("--watch");
const prod = process.env.NODE_ENV === "production";

const nodeCommon = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: !prod,
  minify: false,
  external: ["electron", "ssh2", "cpu-features", "app-info-parser", "yauzl"],
  logLevel: "info",
};

const testEntries = (() => {
  try {
    return readdirSync("test").filter((f) => f.endsWith(".test.ts")).map((f) => join("test", f));
  } catch {
    return [];
  }
})();

const configs = [
  { ...nodeCommon, entryPoints: ["src/main/index.ts"], outfile: "dist/main.cjs" },
  { ...nodeCommon, entryPoints: ["src/preload/index.ts"], outfile: "dist/preload.cjs" },
  {
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "chrome130",
    sourcemap: !prod,
    entryPoints: ["src/renderer/index.ts"],
    outfile: "dist/renderer.js",
    logLevel: "info",
  },
  ...(testEntries.length
    ? [{ ...nodeCommon, entryPoints: testEntries, outdir: "dist/test", outExtension: { ".js": ".cjs" } }]
    : []),
];

function copyStatic() {
  mkdirSync("dist", { recursive: true });
  cpSync("src/renderer/index.html", "dist/index.html");
  cpSync("src/renderer/styles.css", "dist/styles.css");
}

copyStatic();
if (watch) {
  const ctxs = await Promise.all(configs.map((c) => context(c)));
  await Promise.all(ctxs.map((c) => c.watch()));
  // Keep static files fresh too.
  const { watch: fsWatch } = await import("node:fs");
  fsWatch("src/renderer", { recursive: true }, (_e, f) => {
    if (f && (f.endsWith(".html") || f.endsWith(".css"))) copyStatic();
  });
  console.log("watching…");
} else {
  await Promise.all(configs.map((c) => build(c)));
}
