import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron";
import { join } from "node:path";
import type { AppSettings, InstallRequest, PairRequest, PasswordConnectRequest, PayloadInfo, RuntimeOption, TitleInfo } from "../shared/ipc";
import { activity } from "./activity";
import { config } from "./config";
import { friendlyError } from "./errors";
import { install } from "./installer";
import { logcat } from "./logcat";
import { discardAll, discardPayload, getPayload, inspectPaths } from "./payload";
import { browse } from "./discovery";
import { requestLeptonInstall } from "./preflight";
import { runtimeOptions } from "./runtimes";
import { session } from "./session";
import { getTitles, launchTitle, removeTitle, stopTitle } from "./titles";
import { updates } from "./updates";

let win: BrowserWindow | null = null;
let titlesCache: TitleInfo[] = [];

function send<T>(channel: string, payload: T): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 960,
    height: 700,
    minWidth: 760,
    minHeight: 560,
    title: "Frameloader",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#121417" : "#F5F6F8",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.loadFile(join(__dirname, "index.html"));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  // The window only ever shows our own page. Web links open in the browser;
  // anything else (a stray link, a dropped file the page didn't catch) is ignored.
  win.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    if (/^https?:/.test(url)) void shell.openExternal(url);
  });
  win.on("closed", () => {
    win = null;
  });
  if (process.env.FRAMELOADER_SMOKE) {
    // `FRAMELOADER_SMOKE=1 electron .` prints what the renderer sees, then quits.
    win.webContents.once("did-finish-load", async () => {
      try {
        const r = await win!.webContents.executeJavaScript(
          'new Promise(r => setTimeout(() => r(JSON.stringify({bridge: typeof window.frameloader, heading: document.querySelector("h1,h3")?.textContent ?? null, devices: document.body.innerText.includes("Connect your Frame")})), 500))',
        );
        console.log("SMOKE " + r);
      } catch (e) {
        console.log("SMOKE error " + String(e));
      }
      app.quit();
    });
  }
}

async function refreshTitles(): Promise<TitleInfo[]> {
  try {
    titlesCache = await getTitles(session.require());
  } catch (e) {
    activity.push("err", `Couldn't list titles: ${(e as Error).message}`);
  }
  send("titles", titlesCache);
  return titlesCache;
}

function ok<T>(p: Promise<T>): Promise<{ ok: true } | { ok: false; error: string }> {
  return p.then(
    () => ({ ok: true as const }),
    (e) => ({ ok: false as const, error: friendlyError(e, session.device?.host ?? "the headset") }),
  );
}

function titleOrThrow(gameId: string): TitleInfo {
  const t = titlesCache.find((x) => x.gameId === gameId);
  if (!t) throw new Error(`"${gameId}" isn't in the list anymore. Refresh and try again.`);
  return t;
}

function wireIpc(): void {
  ipcMain.handle("devices:list", () => config.devices());
  ipcMain.handle("devices:remove", (_e, id: string) => {
    const d = config.device(id);
    if (d) config.forgetHost(d.host, d.port);
    config.removeDevice(id);
    if (session.device?.id === id) void session.disconnect();
  });
  ipcMain.handle("devices:rename", (_e, id: string, nickname: string) => config.renameDevice(id, nickname));

  ipcMain.handle("connection:state", () => session.state);
  ipcMain.handle("connection:pair", (_e, req: PairRequest) => ok(session.pair(req).then(() => refreshTitles())));
  ipcMain.handle("connection:cancelPair", () => session.cancelPair());
  ipcMain.handle("connection:password", (_e, req: PasswordConnectRequest) => ok(session.connectPassword(req).then(() => refreshTitles())));
  ipcMain.handle("connection:saved", (_e, id: string) => ok(session.connectSaved(id).then(() => refreshTitles())));
  ipcMain.handle("connection:disconnect", () => {
    logcat.stop();
    return session.disconnect();
  });
  ipcMain.handle("connection:installRuntime", (_e, which: string) =>
    ok(
      (async () => {
        if (which !== "lepton") throw new Error("Unknown runtime.");
        await requestLeptonInstall(session.require());
        activity.info("Asked Steam to install Lepton (app 3056000). Confirm the install on the headset, then reconnect.");
      })(),
    ),
  );

  ipcMain.handle("connection:discover", () => browse(2500));

  ipcMain.handle("payload:inspect", async (_e, paths: string[]): Promise<PayloadInfo> => {
    discardAll();
    const info = await inspectPaths(paths);
    const pkg = info.apk?.package;
    const existing = titlesCache.find((t) => (pkg && t.apkPackage === pkg) || t.name.toLowerCase() === info.name.toLowerCase());
    if (existing) info.updates = { gameId: existing.gameId, name: existing.name, fromVersion: existing.versionName };
    activity.info(`Inspected ${info.sourcePaths[0]}: ${info.kind}${info.apk ? ` ${info.apk.package} ${info.apk.versionName}` : ""}`);
    return info;
  });
  ipcMain.handle("payload:pick", async (): Promise<PayloadInfo | null> => {
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, {
      title: "Choose an app to install",
      properties: ["openFile", "openDirectory", "multiSelections"],
      filters: [
        { name: "Apps", extensions: ["apk", "exe", "zip", "obb"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (r.canceled || !r.filePaths.length) return null;
    discardAll();
    const info = await inspectPaths(r.filePaths);
    const pkg = info.apk?.package;
    const existing = titlesCache.find((t) => (pkg && t.apkPackage === pkg) || t.name.toLowerCase() === info.name.toLowerCase());
    if (existing) info.updates = { gameId: existing.gameId, name: existing.name, fromVersion: existing.versionName };
    return info;
  });
  ipcMain.handle("payload:discard", (_e, id: string) => discardPayload(id));
  ipcMain.handle("payload:runtimes", (_e, id: string): RuntimeOption[] => {
    const p = getPayload(id);
    if (!p) return [];
    return runtimeOptions(p.info, session.info, { ...config.compatToolOverrides(), ...(session.device?.compatToolOverrides ?? {}) });
  });

  ipcMain.handle("install:start", async (_e, req: InstallRequest) => {
    const result = await install(req, (p) => send("install:progress", p));
    if (result.ok) {
      discardPayload(req.payloadId);
      await refreshTitles();
    }
    return result;
  });

  ipcMain.handle("titles:list", () => refreshTitles());
  ipcMain.handle("titles:launch", (_e, id: string) => ok(launchTitle(session.require(), session.requireInfo().home, id)));
  ipcMain.handle("titles:stop", (_e, id: string) => ok(stopTitle(session.require(), titleOrThrow(id))));
  ipcMain.handle("titles:remove", (_e, id: string) =>
    ok(
      (async () => {
        if (titlesCache.find((t) => t.gameId === id)) logcat.stop();
        await removeTitle(session.require(), session.requireInfo().home, titleOrThrow(id));
        await refreshTitles();
      })(),
    ),
  );

  ipcMain.handle("logcat:start", (_e, id: string) =>
    ok(
      (async () => {
        if (!config.settings().developerTools) throw new Error("Turn on developer tools in Settings to see logs.");
        await logcat.start(session.require(), titleOrThrow(id));
      })(),
    ),
  );
  ipcMain.handle("logcat:stop", () => logcat.stop());
  ipcMain.handle("activity:recent", () => activity.recent());

  ipcMain.handle("settings:get", () => config.settings());
  ipcMain.handle("settings:set", (_e, patch: Partial<AppSettings>) => {
    const clean: Partial<AppSettings> = {};
    if (typeof patch.developerTools === "boolean") clean.developerTools = patch.developerTools;
    if (typeof patch.checkForUpdates === "boolean") clean.checkForUpdates = patch.checkForUpdates;
    const next = config.updateSettings(clean);
    if (!next.developerTools) logcat.stop();
    if ("checkForUpdates" in clean) {
      if (next.checkForUpdates) updates.start();
      else updates.stop();
    }
    return next;
  });
  ipcMain.handle("updates:status", () => updates.status);
  ipcMain.handle("updates:check", () => updates.check());
  ipcMain.handle("app:version", () => app.getVersion());
}

function wireEvents(): void {
  activity.on("line", (line) => send("log", line));
  session.on("state", (state) => send("connection", state));
  logcat.on("line", (l) => send("logcat", l));
  logcat.on("ended", (l) => send("logcat:ended", l));
  updates.on("status", (s) => send("update", s));
}

app.setName("Frameloader");
app.whenReady().then(() => {
  wireIpc();
  wireEvents();
  createWindow();
  updates.start();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  logcat.stop();
  discardAll();
  void session.disconnect();
});
