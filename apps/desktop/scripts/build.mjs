// Builds main + preload (Node/CJS) and the renderer (browser) with esbuild.
// `node scripts/build.mjs --watch` rebuilds on change.
import { build, context } from "esbuild";
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const TOKENS = require.resolve("frameloader-tokens/tokens.css");

const watch = process.argv.includes("--watch");
const prod = process.env.NODE_ENV === "production";

const nodeCommon = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: !prod,
  minify: false,
  // Everything except Electron is bundled, so the packaged app needs no node_modules.
  // ssh2's optional native helpers are loaded in try/catch and fall back to pure JS.
  external: ["electron", "cpu-features", "*.node"],
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
  // Shared tokens first, then the app's own styles.
  writeFileSync("dist/styles.css", readFileSync(TOKENS, "utf8") + "\n" + readFileSync("src/renderer/styles.css", "utf8"));
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
  fsWatch(TOKENS, () => copyStatic());
  console.log("watching…");
} else {
  await Promise.all(configs.map((c) => build(c)));
}
