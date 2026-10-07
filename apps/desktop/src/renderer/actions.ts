// Everything the views can do, as plain functions over the bridge + store.
import type { InstallProgress, InstallRequest, InstallStep, PayloadInfo, RuntimeId } from "../shared/ipc";
import { toGameId } from "../shared/gameid";
import { api } from "./api";
import { setBusy, store, toast, type ReviewForm } from "./state";
import { requestScrollTop } from "./dom";
import { LivePane } from "./livepane";
import type { AppSettings, LogLine } from "../shared/ipc";

/** Every command sent to the headset (developer tools). Lives outside the store. */
export const activityPane = new LivePane(2000, "activity");
/** The open title's Android log. Recreated per title. */
export let logPane = new LivePane(3000, "logcat");

function fmtLine(l: LogLine): string {
  const t = new Date(l.ts).toLocaleTimeString([], { hour12: false });
  return `${t}  ${l.level === "cmd" ? "$ " : ""}${l.text}`;
}

export async function bootstrap(): Promise<void> {
  const [devices, connection, activity, settings, version, update] = await Promise.all([
    api.devices.list(),
    api.connection.state(),
    api.activity.recent(),
    api.settings.get(),
    api.appVersion(),
    api.updates.status(),
  ]);
  for (const l of activity) activityPane.append(fmtLine(l), l.level);
  store.set({ devices, connection, settings, version, update });
  api.on("connection", (connection) => {
    store.set((s) => ({ connection, titlesLoaded: connection.status === "connected" ? s.titlesLoaded : false }));
    if (connection.status === "connected") void api.devices.list().then((devices) => store.set({ devices }));
  });
  api.on("log", (line) => activityPane.append(fmtLine(line), line.level));
  api.on("update", (update) => store.set({ update }));
  api.on("titles", (titles) => store.set({ titles, titlesLoaded: true }));
  api.on("install:progress", (p) => onInstallProgress(p));
  api.on("logcat", ({ gameId, line }) => {
    if (store.state.panel?.gameId === gameId) logPane.append(line);
  });
  api.on("logcat:ended", ({ gameId, reason }) => {
    if (store.state.panel?.gameId !== gameId) return;
    logPane.append(`— log stream ${reason} —`, "info");
    setPanel({ streaming: false });
  });
  // Auto-connect to the last headset.
  const last = devices.find((d) => d.lastSeen) ? [...devices].sort((a, b) => (b.lastSeen ?? "").localeCompare(a.lastSeen ?? ""))[0] : devices[0];
  if (last && connection.status === "disconnected") {
    store.set((s) => ({ connectForm: { ...s.connectForm, host: last.host, port: String(last.port), user: last.user } }));
    const r = await api.connection.connectSaved(last.id);
    if (!r.ok) store.set((s) => ({ connectForm: { ...s.connectForm, error: r.error, mode: last.auth === "password" ? "password" : s.connectForm.mode } }));
  }
}

export async function pair(): Promise<void> {
  const f = store.state.connectForm;
  const host = f.host.trim();
  if (!host) return store.set({ connectForm: { ...f, error: "Enter the headset's hostname or IP address." } });
  store.set({ connectForm: { ...f, busy: true, error: undefined } });
  const r = await api.connection.pair({ host, port: Number(f.port) || 22 });
  store.set((s) => ({ connectForm: { ...s.connectForm, busy: false, error: r.ok ? undefined : r.error } }));
}

export async function cancelPair(): Promise<void> {
  await api.connection.cancelPair();
  store.set((s) => ({ connectForm: { ...s.connectForm, busy: false } }));
}

export async function connectWithPassword(): Promise<void> {
  const f = store.state.connectForm;
  const host = f.host.trim();
  if (!host) return store.set({ connectForm: { ...f, error: "Enter the headset's hostname or IP address." } });
  if (!f.password) return store.set({ connectForm: { ...f, error: "Enter the Developer Mode password." } });
  store.set({ connectForm: { ...f, busy: true, error: undefined } });
  const r = await api.connection.connectPassword({ host, port: Number(f.port) || 22, user: f.user.trim() || "steamos", password: f.password, remember: f.remember });
  store.set((s) => ({ connectForm: { ...s.connectForm, busy: false, error: r.ok ? undefined : r.error, password: r.ok ? "" : s.connectForm.password } }));
}

export async function connectSaved(deviceId: string): Promise<void> {
  const d = store.state.devices.find((x) => x.id === deviceId);
  store.set((s) => ({ devicesSheet: false, menuOpen: false, connectForm: { ...s.connectForm, host: d?.host ?? s.connectForm.host, port: String(d?.port ?? 22), user: d?.user ?? "steamos", error: undefined } }));
  const r = await api.connection.connectSaved(deviceId);
  if (!r.ok) store.set((s) => ({ connectForm: { ...s.connectForm, error: r.error, mode: d?.auth === "password" ? "password" : s.connectForm.mode } }));
}

export async function disconnect(): Promise<void> {
  store.set({ menuOpen: false, panel: undefined, payload: undefined, review: undefined, install: undefined });
  await api.connection.disconnect();
}

export async function retryConnection(): Promise<void> {
  const id = store.state.connection.deviceId;
  if (id) await connectSaved(id);
}

export async function removeDevice(id: string): Promise<void> {
  await api.devices.remove(id);
  store.set({ devices: await api.devices.list() });
}

export async function renameDevice(id: string, nickname: string): Promise<void> {
  await api.devices.rename(id, nickname);
  store.set({ devices: await api.devices.list() });
}

export async function installLepton(): Promise<void> {
  setBusy("lepton", true);
  const r = await api.connection.installRuntime("lepton");
  setBusy("lepton", false);
  store.set({ menuOpen: false });
  toast(r.ok ? "Asked Steam to install Lepton. Confirm it on the headset, then reconnect." : r.error ?? "Couldn't ask for Lepton.", r.ok ? "info" : "bad");
}

function reviewFor(p: PayloadInfo, runtimes: { id: RuntimeId; available: boolean }[]): ReviewForm {
  const firstAvailable = runtimes.find((r) => r.available)?.id ?? runtimes[0]?.id;
  return {
    name: p.updates?.name ?? p.name,
    gameId: p.updates?.gameId ?? toGameId(p.name),
    gameIdTouched: !!p.updates,
    runtime: firstAvailable,
    startCommand: p.candidates?.[0]?.relPath,
    launchArgs: "",
    env: [],
    flatscreen: p.apk ? !p.apk.isVr : false,
    launchAfter: true,
    advancedOpen: false,
  };
}

export async function inspectPaths(paths: string[]): Promise<void> {
  if (!paths.length) return;
  store.set({ inspecting: true, inspectError: undefined, install: undefined });
  try {
    const payload = await api.payload.inspect(paths);
    const runtimes = await api.payload.runtimes(payload.id);
    requestScrollTop();
    store.set({ payload, runtimes, review: reviewFor(payload, runtimes), inspecting: false });
  } catch (e) {
    store.set({ inspecting: false, inspectError: cleanError(e) });
  }
}

export async function pickFiles(): Promise<void> {
  store.set({ inspecting: true, inspectError: undefined, install: undefined });
  try {
    const payload = await api.payload.pick();
    if (!payload) return store.set({ inspecting: false });
    const runtimes = await api.payload.runtimes(payload.id);
    store.set({ payload, runtimes, review: reviewFor(payload, runtimes), inspecting: false });
  } catch (e) {
    store.set({ inspecting: false, inspectError: cleanError(e) });
  }
}

export function cancelReview(): void {
  const id = store.state.payload?.id;
  store.set({ payload: undefined, review: undefined, runtimes: [], install: undefined });
  if (id) void api.payload.discard(id);
}

export function updateReview(patch: Partial<ReviewForm>): void {
  store.set((s) => (s.review ? { review: { ...s.review, ...patch } } : {}));
}

export function setReviewName(name: string): void {
  store.set((s) => {
    if (!s.review) return {};
    const review = { ...s.review, name };
    if (!review.gameIdTouched) review.gameId = toGameId(name);
    return { review };
  });
}

const STEPS: InstallStep[] = ["prepare", "upload", "register", "launch"];

function onInstallProgress(p: InstallProgress): void {
  store.set((s) => (s.install ? { install: { ...s.install, steps: { ...s.install.steps, [p.step]: p } } } : {}));
}

export async function startInstall(): Promise<void> {
  const { payload, review } = store.state;
  if (!payload || !review || !review.runtime) return;
  const req: InstallRequest = {
    payloadId: payload.id,
    name: review.name.trim() || payload.name,
    gameId: review.gameId.trim(),
    runtime: review.runtime,
    startCommand: review.startCommand,
    launchArgs: review.launchArgs,
    env: Object.fromEntries(review.env.filter((e) => e.k.trim()).map((e) => [e.k.trim(), e.v])),
    flatscreen: review.flatscreen,
    launchAfter: review.launchAfter,
  };
  const steps = Object.fromEntries(STEPS.map((s) => [s, { step: s, status: "pending" } as InstallProgress])) as Record<InstallStep, InstallProgress>;
  requestScrollTop();
  store.set({ install: { steps, running: true } });
  const result = await api.install.start(req);
  store.set((s) => ({ install: s.install ? { ...s.install, running: false, result } : undefined }));
  if (result.ok) {
    store.set({ payload: undefined, review: undefined });
  }
}

export function installAnother(): void {
  store.set({ install: undefined, payload: undefined, review: undefined, inspectError: undefined });
}

export async function refreshTitles(): Promise<void> {
  setBusy("titles", true);
  try {
    store.set({ titles: await api.titles.list(), titlesLoaded: true });
  } finally {
    setBusy("titles", false);
  }
}

export async function launchTitle(gameId: string): Promise<void> {
  setBusy(`launch:${gameId}`, true);
  const r = await api.titles.launch(gameId);
  setBusy(`launch:${gameId}`, false);
  store.set({ rowMenu: undefined });
  if (r.ok) toast("Launching on the headset.", "ok");
  else toast(r.error ?? "Couldn't launch.", "bad");
}

export async function stopTitle(gameId: string): Promise<void> {
  setBusy(`stop:${gameId}`, true);
  const r = await api.titles.stop(gameId);
  setBusy(`stop:${gameId}`, false);
  if (!r.ok) toast(r.error ?? "Couldn't stop it.", "bad");
}

export async function removeTitle(gameId: string): Promise<void> {
  setBusy(`remove:${gameId}`, true);
  const r = await api.titles.remove(gameId);
  setBusy(`remove:${gameId}`, false);
  store.set((s) => ({ rowMenu: undefined, panel: s.panel?.gameId === gameId ? undefined : s.panel }));
  if (r.ok) toast("Removed from the headset.", "ok");
  else toast(r.error ?? "Couldn't remove it.", "bad");
}

export function openPanel(gameId: string, tab: "details" | "logs" = "details"): void {
  if (tab === "logs" && !store.state.settings.developerTools) tab = "details";
  logPane = new LivePane(3000, "logcat");
  store.set({ panel: { gameId, tab, streaming: false, confirmRemove: false, paused: false, filter: "" }, rowMenu: undefined });
  if (tab === "logs") void startLogs();
}

export function closePanel(): void {
  if (store.state.panel?.streaming) void api.logcat.stop();
  store.set({ panel: undefined });
}

export function setPanel(patch: Partial<NonNullable<import("./state").State["panel"]>>): void {
  store.set((s) => (s.panel ? { panel: { ...s.panel, ...patch } } : {}));
}

export async function startLogs(): Promise<void> {
  const p = store.state.panel;
  if (!p) return;
  logPane.clear();
  logPane.setPaused(false);
  setPanel({ tab: "logs", error: undefined, streaming: true, paused: false });
  const r = await api.logcat.start(p.gameId);
  if (!r.ok) setPanel({ streaming: false, error: r.error });
}

export async function stopLogs(): Promise<void> {
  await api.logcat.stop();
  setPanel({ streaming: false });
}

export function cleanError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

let discoveryTimer: number | undefined;
let discoveryBusy = false;

async function discoverOnce(): Promise<void> {
  if (discoveryBusy) return;
  discoveryBusy = true;
  store.set({ discovering: true });
  try {
    const discovered = await api.connection.discover();
    store.set({ discovered, discovering: false });
  } catch {
    store.set({ discovering: false });
  } finally {
    discoveryBusy = false;
  }
}

/** Keep browsing for headsets while the connect screen is up. */
export function startDiscovery(): void {
  if (discoveryTimer !== undefined) return;
  void discoverOnce();
  discoveryTimer = window.setInterval(() => void discoverOnce(), 5000);
}

export function stopDiscovery(): void {
  if (discoveryTimer === undefined) return;
  clearInterval(discoveryTimer);
  discoveryTimer = undefined;
}

export function useDiscovered(host: string): void {
  store.set((s) => ({ connectForm: { ...s.connectForm, host, error: undefined } }));
}

export function openSettings(): void {
  store.set({ settingsOpen: true, menuOpen: false, rowMenu: undefined });
}

export function closeSettings(): void {
  store.set({ settingsOpen: false });
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<void> {
  const settings = await api.settings.set(patch);
  store.set((s) => ({
    settings,
    activityOpen: settings.developerTools ? s.activityOpen : false,
    panel: s.panel && !settings.developerTools && s.panel.tab === "logs" ? { ...s.panel, tab: "details", streaming: false } : s.panel,
  }));
}

export async function checkForUpdates(): Promise<void> {
  store.set({ checkingUpdate: true });
  try {
    const update = await api.updates.check();
    store.set({ update, checkingUpdate: false });
    if (update.error) toast(`Couldn't check for updates: ${update.error}`, "bad");
    else if (!update.available) toast(`You're on the latest version (${update.current}).`, "ok");
  } catch (e) {
    store.set({ checkingUpdate: false });
    toast(cleanError(e), "bad");
  }
}

export function dismissUpdate(): void {
  store.set((s) => ({ updateDismissed: s.update?.latest }));
}
