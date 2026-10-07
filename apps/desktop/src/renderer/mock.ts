// A fake bridge for previewing the UI in a plain browser (no Electron, no headset).
import type { ConnectionState, DeviceProfile, EventMap, FrameloaderApi, InstallProgress, LogLine, PayloadInfo, TitleInfo, UpdateInfo } from "../shared/ipc";

export function installMock(): void {
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const emit = <K extends keyof EventMap>(ev: K, p: EventMap[K]) => listeners.get(ev)?.forEach((cb) => cb(p));
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const log = (level: LogLine["level"], text: string) => emit("log", { ts: Date.now(), level, text });
  const q = new URLSearchParams(location.search);
  const scenario = q.get("mock") ?? "connected";

  let state: ConnectionState = { status: "disconnected" };
  const devices: DeviceProfile[] = scenario === "fresh" ? [] : [{ id: "d1", nickname: "Living room Frame", host: "frame.local", port: 22, user: "steamos", auth: "key", hasSavedPassword: false, lastSeen: new Date(Date.now() - 3600e3).toISOString() }];
  let titles: TitleInfo[] = scenario === "fresh" || scenario === "empty"
    ? []
    : [
        { gameId: "Playground", name: "Playground", directory: "/home/steamos/devkit-game/Playground", kind: "apk", runtime: "lepton", compatTool: "lepton", installedAt: new Date(Date.now() - 120e3).toISOString(), apkPackage: "com.example.playground", versionName: "1.3", isVr: true, flatscreen: false, sizeBytes: 48e6, argv: ["playground.apk"] },
        { gameId: "PuTTY", name: "PuTTY", directory: "/home/steamos/devkit-game/PuTTY", kind: "windows", runtime: "proton-stable", compatTool: "proton-stable", installedAt: new Date(Date.now() - 86400e3 * 2).toISOString(), sizeBytes: 3.6e6, argv: ["putty.exe"] },
        { gameId: "AntennaPod", name: "AntennaPod", directory: "/home/steamos/devkit-game/AntennaPod", kind: "apk", runtime: "lepton", compatTool: "lepton", installedAt: new Date(Date.now() - 86400e3 * 9).toISOString(), apkPackage: "de.danoeh.antennapod", versionName: "3.5.0", isVr: false, flatscreen: true, sizeBytes: 21e6 },
      ];
  const info = { host: "frame.local", home: "/home/steamos", buildId: "20260925.6191901", versionId: "0.4.1", variantId: "vr", isFrame: true, steamRunning: true, leptonInstalled: scenario !== "nolepton", protonInstalled: ["Proton 11", "Proton - Experimental"], commonDirs: [] };
  const setState = (s: ConnectionState) => {
    state = s;
    emit("connection", s);
  };
  const connect = async (host: string) => {
    setState({ status: "connecting", host, deviceId: "d1", message: "Connecting…" });
    await sleep(700);
    log("info", `${host} → 192.168.1.42 (mDNS)`);
    log("info", `Connected to ${host} (SteamOS 0.4.1)`);
    setState({ status: "connected", host, address: "192.168.1.42", deviceId: "d1", info });
    emit("titles", titles);
  };
  let pairAbort = false;
  // ?dev=1 turns developer tools on; ?update=1 pretends a newer release exists.
  const settings = { developerTools: q.has("dev"), checkForUpdates: true };
  let updateInfo: UpdateInfo = q.has("update")
    ? { current: "0.0.1", latest: "0.0.2", available: true, url: "https://github.com/travelerdev/frameloader/releases/latest", checkedAt: new Date().toISOString() }
    : { current: "0.0.1", available: false };
  const api: FrameloaderApi = {
    devices: { list: async () => devices, remove: async (id) => { const i = devices.findIndex((d) => d.id === id); if (i >= 0) devices.splice(i, 1); }, rename: async (id, n) => { const d = devices.find((x) => x.id === id); if (d) d.nickname = n; } },
    connection: {
      state: async () => state,
      pair: async (req) => {
        pairAbort = false;
        setState({ status: "pairing", host: req.host, message: "Contacting the headset…" });
        await sleep(800);
        if (pairAbort) return { ok: false, error: "Cancelled." };
        setState({ status: "pairing", host: req.host, message: "On the headset, open Settings → Developer → Pair new host." });
        await sleep(1500);
        if (pairAbort) return { ok: false, error: "Cancelled." };
        setState({ status: "pairing", host: req.host, message: "Waiting for you to approve on the headset…" });
        await sleep(1500);
        if (pairAbort) return { ok: false, error: "Cancelled." };
        if (!devices.length) devices.push({ id: "d1", nickname: req.host, host: req.host, port: req.port, user: "steamos", auth: "key", hasSavedPassword: false, lastSeen: new Date().toISOString() });
        await connect(req.host);
        return { ok: true };
      },
      cancelPair: async () => { pairAbort = true; setState({ status: "disconnected", message: "Cancelled." }); },
      connectPassword: async (req) => {
        if (req.password !== "hunter2") {
          setState({ status: "disconnected", host: req.host });
          return { ok: false, error: "The headset rejected the login. The password is the one set under Settings → Developer → Set User Password." };
        }
        await connect(req.host);
        return { ok: true };
      },
      connectSaved: async (id) => {
        if (scenario === "offline") {
          setState({ status: "offline", deviceId: id, host: "frame.local", message: "Couldn't reach frame.local. The Frame leaves the network when it sleeps; wake it and try again." });
          return { ok: false, error: "offline" };
        }
        await connect("frame.local");
        return { ok: true };
      },
      disconnect: async () => setState({ status: "disconnected" }),
      installRuntime: async () => ({ ok: true }),
      discover: async () => {
        await sleep(600);
        // ?nodisc=1 pretends no headset answers.
        return !q.has("nodisc") && (scenario === "fresh" || scenario === "connected")
          ? [{ name: "frame", host: "frame.local", address: "192.168.1.42", addresses: ["192.168.1.42"], port: 32000, login: "steamos" }]
          : [];
      },
    },
    payload: {
      inspect: async (paths) => fakePayload(paths[0] ?? "Playground.apk"),
      pick: async () => fakePayload("Playground.apk"),
      discard: async () => undefined,
      runtimes: async (id) =>
        id.startsWith("win")
          ? [{ id: "proton-experimental", label: "Proton Experimental", compatTool: "proton-experimental", available: true }, { id: "proton-stable", label: "Proton (stable)", compatTool: "proton-stable", available: true }]
          : [{ id: "lepton", label: "Lepton (Android)", compatTool: "lepton", available: info.leptonInstalled, unavailableReason: info.leptonInstalled ? undefined : "Lepton isn't installed on the headset yet." }],
    },
    install: {
      start: async (req) => {
        const step = (p: InstallProgress) => emit("install:progress", p);
        step({ step: "prepare", status: "active", detail: "Preparing a folder on the headset" });
        log("cmd", `python3 ~/devkit-utils/steamos-prepare-upload --gameid ${req.gameId}`);
        await sleep(600);
        step({ step: "prepare", status: "done", detail: `/home/steamos/devkit-game/${req.gameId}` });
        const total = 48e6;
        for (let b = 0; b <= total; b += total / 12) {
          step({ step: "upload", status: "active", bytes: Math.min(b, total), total });
          await sleep(120);
        }
        step({ step: "upload", status: "done", detail: "Uploaded" });
        step({ step: "register", status: "active", detail: "Registering with Steam" });
        log("cmd", "python3 ~/devkit-utils/steam-client-create-shortcut --parms '{…}'");
        await sleep(900);
        if (scenario === "fail") {
          step({ step: "register", status: "failed", detail: "Steam isn't running on the headset. Wake it or put it on, then try again." });
          step({ step: "launch", status: "skipped" });
          return { ok: false, gameId: req.gameId, name: req.name, error: "Steam isn't running" };
        }
        step({ step: "register", status: "done", detail: "In your library under Non-Steam" });
        if (req.launchAfter) {
          step({ step: "launch", status: "active", detail: "Launching on the headset" });
          await sleep(500);
          step({ step: "launch", status: "done", detail: "Launched" });
        } else step({ step: "launch", status: "skipped" });
        titles = [{ gameId: req.gameId, name: req.name, directory: `/home/steamos/devkit-game/${req.gameId}`, kind: req.runtime === "lepton" ? "apk" : "windows", runtime: req.runtime, installedAt: new Date().toISOString(), apkPackage: req.runtime === "lepton" ? "com.example.playground" : undefined, versionName: "1.3", isVr: !req.flatscreen, flatscreen: req.flatscreen, sizeBytes: total }, ...titles.filter((t) => t.gameId !== req.gameId)];
        emit("titles", titles);
        return { ok: true, gameId: req.gameId, name: req.name };
      },
    },
    titles: {
      list: async () => titles,
      launch: async (id) => { log("cmd", `python3 ~/devkit-utils/steam-devkit-rpc run-game gameid=${id}`); return { ok: true }; },
      stop: async () => ({ ok: true }),
      remove: async (id) => { titles = titles.filter((t) => t.gameId !== id); emit("titles", titles); return { ok: true }; },
    },
    logcat: {
      start: async (id) => {
        let n = 0;
        const timer = setInterval(() => {
          n++;
          emit("logcat", { gameId: id, line: `10-06 00:${String(n % 60).padStart(2, "0")}.${String(n * 37 % 1000).padStart(3, "0")} I/Playground(1234): frame ${n} rendered in 11.${n % 10}ms` });
          if (n > 400) clearInterval(timer);
        }, 150);
        (api as unknown as { _t?: ReturnType<typeof setInterval> })._t = timer;
        return { ok: true };
      },
      stop: async () => clearInterval((api as unknown as { _t?: ReturnType<typeof setInterval> })._t),
    },
    activity: { recent: async () => [{ ts: Date.now() - 5000, level: "info", text: "Preview mode: nothing here talks to a real headset." }] },
    settings: {
      get: async () => ({ ...settings }),
      set: async (patch) => Object.assign(settings, patch),
    },
    updates: {
      status: async () => updateInfo,
      check: async () => {
        await sleep(500);
        updateInfo = { ...updateInfo, checkedAt: new Date().toISOString() };
        return updateInfo;
      },
    },
    appVersion: async () => "0.0.1",
    getPathForFile: (f) => f.name,
    on: (ev, cb) => {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev)!.add(cb as (p: unknown) => void);
      return () => listeners.get(ev)!.delete(cb as (p: unknown) => void);
    },
  };

  function fakePayload(path: string): PayloadInfo {
    const lower = path.toLowerCase();
    if (lower.endsWith(".exe") || lower.endsWith(".zip")) {
      return { id: "win1", kind: "windows", sourcePaths: [path], name: path.replace(/\.(exe|zip)$/i, ""), sizeBytes: 3.6e6, candidates: [{ relPath: "putty.exe", format: "pe", arch: "x86-64", size: 3.6e6, score: 120 }, { relPath: "tools/pageant.exe", format: "pe", arch: "x86-64", size: 1.2e6, score: 70 }], issues: [], warnings: ["Found 2 executables; starting with putty.exe."] };
    }
    const bad = lower.includes("x86") || lower.includes("bad");
    return {
      id: "apk1",
      kind: "apk",
      sourcePaths: [path],
      name: "Playground",
      sizeBytes: 48e6,
      apk: { package: "com.example.playground", label: "Playground", versionName: "1.3", versionCode: 13, minSdk: 29, targetSdk: 33, abis: bad ? ["armeabi-v7a"] : ["arm64-v8a"], isVr: !lower.includes("flat"), obbFiles: [] },
      issues: bad ? ["This APK has no arm64 build (armeabi-v7a only). Lepton is 64-bit ARM only."] : [],
      warnings: [],
      updates: titles.find((t) => t.apkPackage === "com.example.playground") ? { gameId: "Playground", name: "Playground", fromVersion: "1.2" } : undefined,
    };
  }

  window.frameloader = api;
  (window as unknown as { __frameloaderMock: boolean }).__frameloaderMock = true;
}
