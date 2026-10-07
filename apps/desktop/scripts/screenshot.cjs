// Renders the UI against the mock bridge and saves PNGs for the website.
// Usage: pnpm screenshots   (runs `electron scripts/screenshot.cjs` after a build)
const { app, BrowserWindow, nativeTheme } = require("electron");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const OUT = join(__dirname, "..", "..", "web", "public", "screenshots");
const PAGE = join(__dirname, "..", "dist", "index.html");
const W = 960;
const H = 640;

const shots = [
  { name: "home", query: "mock=connected&shot=1", prepare: "" },
  {
    name: "review",
    query: "mock=connected&shot=1",
    prepare: `[...document.querySelectorAll("button")].find(b => b.textContent.includes("Choose file"))?.click();`,
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Each shot opens and closes a window; don't let Electron quit in between.
app.on("window-all-closed", () => undefined);

app.whenReady().then(async () => {
  mkdirSync(OUT, { recursive: true });
  for (const theme of ["light", "dark"]) {
    nativeTheme.themeSource = theme;
    for (const shot of shots) {
      const win = new BrowserWindow({ width: W, height: H, show: false, useContentSize: true, paintWhenInitiallyHidden: true });
      const query = Object.fromEntries(new URLSearchParams(shot.query));
      try {
        await win.loadFile(PAGE, { query });
      } catch (e) {
        console.error("load failed", shot.name, theme, e.message);
        win.destroy();
        continue;
      }
      await sleep(1600);
      if (shot.prepare) {
        await win.webContents.executeJavaScript(shot.prepare);
        await sleep(1200);
      }
      // Hide the scrollbar and the empty macOS titlebar strip for a clean frame.
      await win.webContents.insertCSS("::-webkit-scrollbar{display:none} body{--titlebar:0px !important}");
      await sleep(300);
      const img = await win.webContents.capturePage(undefined, { stayHidden: true });
      const file = join(OUT, `${shot.name}-${theme}.png`);
      writeFileSync(file, img.toPNG());
      console.log("wrote", file, img.getSize());
      win.destroy();
    }
  }
  app.quit();
});
