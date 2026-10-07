import type { AppSettings, ConnectionState, DeviceProfile, DiscoveredFrame, InstallProgress, InstallResult, InstallStep, PayloadInfo, RuntimeId, RuntimeOption, TitleInfo, UpdateInfo } from "../shared/ipc";

export interface ConnectForm {
  host: string;
  port: string;
  mode: "pair" | "password";
  user: string;
  password: string;
  remember: boolean;
  error?: string;
  busy: boolean;
}

export interface ReviewForm {
  name: string;
  gameId: string;
  gameIdTouched: boolean;
  runtime?: RuntimeId;
  startCommand?: string;
  launchArgs: string;
  env: { k: string; v: string }[];
  flatscreen: boolean;
  launchAfter: boolean;
  advancedOpen: boolean;
}

export interface InstallState {
  steps: Record<InstallStep, InstallProgress>;
  result?: InstallResult;
  running: boolean;
}

export interface PanelState {
  gameId: string;
  tab: "details" | "logs";
  streaming: boolean;
  confirmRemove: boolean;
  error?: string;
  paused: boolean;
  filter: string;
}

export interface State {
  connection: ConnectionState;
  devices: DeviceProfile[];
  titles: TitleInfo[];
  titlesLoaded: boolean;
  payload?: PayloadInfo;
  runtimes: RuntimeOption[];
  review?: ReviewForm;
  install?: InstallState;
  panel?: PanelState;
  devicesSheet: boolean;
  activityOpen: boolean;
  settings: AppSettings;
  settingsOpen: boolean;
  update?: UpdateInfo;
  updateDismissed?: string;
  checkingUpdate: boolean;
  version: string;
  menuOpen: boolean;
  rowMenu?: string;
  dragOver: boolean;
  busy: Set<string>;
  toast?: { text: string; kind: "ok" | "bad" | "info" };
  connectForm: ConnectForm;
  inspecting: boolean;
  inspectError?: string;
  discovered: DiscoveredFrame[];
  discovering: boolean;
}

export const initialState: State = {
  connection: { status: "disconnected" },
  devices: [],
  titles: [],
  titlesLoaded: false,
  runtimes: [],
  devicesSheet: false,
  activityOpen: false,
  settings: { developerTools: false, checkForUpdates: true },
  settingsOpen: false,
  checkingUpdate: false,
  version: "",
  menuOpen: false,
  dragOver: false,
  busy: new Set(),
  connectForm: { host: "frame.local", port: "22", mode: "pair", user: "steamos", password: "", remember: true, busy: false },
  inspecting: false,
  discovered: [],
  discovering: false,
};

type Listener = (s: State) => void;

class Store {
  state: State = initialState;
  private listeners = new Set<Listener>();
  private scheduled = false;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  set(patch: Partial<State> | ((s: State) => Partial<State>)): void {
    const p = typeof patch === "function" ? patch(this.state) : patch;
    let changed = false;
    for (const k of Object.keys(p) as (keyof State)[]) {
      if (p[k] !== this.state[k]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.state = { ...this.state, ...p };
    this.schedule();
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => {
      this.scheduled = false;
      for (const l of this.listeners) l(this.state);
    });
  }
}

export const store = new Store();

export function setBusy(key: string, on: boolean): void {
  store.set((s) => {
    const busy = new Set(s.busy);
    if (on) busy.add(key);
    else busy.delete(key);
    return { busy };
  });
}

let toastTimer: number | undefined;
export function toast(text: string, kind: "ok" | "bad" | "info" = "info"): void {
  store.set({ toast: { text, kind } });
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => store.set({ toast: undefined }), kind === "bad" ? 8000 : 4000);
}
