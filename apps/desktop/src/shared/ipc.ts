// Typed contract shared by the main process, the preload bridge and the renderer.

export type AuthMethod = "key" | "password";

export interface DeviceProfile {
  id: string;
  nickname: string;
  host: string;
  port: number;
  user: string;
  auth: AuthMethod;
  hasSavedPassword: boolean;
  lastSeen?: string;
  /** IP the host last resolved to; used when the name stops resolving. */
  lastAddress?: string;
  /** Per-device compat tool overrides, e.g. { lepton: "lepton-stable" }. */
  compatToolOverrides?: Record<string, string>;
}

export interface DeviceInfo {
  host: string;
  home: string;
  buildId?: string;
  versionId?: string;
  variantId?: string;
  isFrame: boolean;
  steamRunning: boolean;
  leptonInstalled: boolean;
  protonInstalled: string[];
  commonDirs: string[];
}

export type ConnectionStatus = "disconnected" | "connecting" | "pairing" | "connected" | "offline";

export interface ConnectionState {
  status: ConnectionStatus;
  deviceId?: string;
  host?: string;
  /** The IP address actually in use for this connection. */
  address?: string;
  message?: string;
  info?: DeviceInfo;
}

/** A headset advertising Valve's devkit service on the local network. */
export interface DiscoveredFrame {
  /** Service instance name, usually the hostname. */
  name: string;
  /** mDNS hostname, e.g. "frame.local". */
  host: string;
  /** First IPv4 address, or "" if none was announced. */
  address: string;
  addresses: string[];
  /** Devkit HTTP port (32000). */
  port: number;
  login?: string;
}

export type PayloadKind = "apk" | "windows" | "linux-arm64" | "linux-x64" | "unknown";

export type ExecArch = "x86-64" | "x86" | "arm64" | "arm" | "other";

export interface ExecutableCandidate {
  relPath: string;
  format: "pe" | "elf" | "script";
  arch: ExecArch;
  size: number;
  score: number;
}

export interface ApkFacts {
  package: string;
  label: string;
  versionName: string;
  versionCode: number;
  minSdk?: number;
  targetSdk?: number;
  abis: string[];
  isVr: boolean;
  iconDataUrl?: string;
  obbFiles: string[];
}

export interface PayloadInfo {
  id: string;
  kind: PayloadKind;
  sourcePaths: string[];
  /** Suggested title name. */
  name: string;
  sizeBytes: number;
  apk?: ApkFacts;
  candidates?: ExecutableCandidate[];
  /** Blocking problems; Install is disabled when non-empty. */
  issues: string[];
  warnings: string[];
  /** Existing title with the same package/name, for "update" messaging. */
  updates?: { gameId: string; name: string; fromVersion?: string };
}

export type RuntimeId = "lepton" | "proton-experimental" | "proton-stable" | "slr4-arm64" | "slr4-x64";

export interface RuntimeOption {
  id: RuntimeId;
  label: string;
  compatTool: string;
  note?: string;
  available: boolean;
  unavailableReason?: string;
}

export interface InstallRequest {
  payloadId: string;
  name: string;
  gameId: string;
  runtime: RuntimeId;
  /** Relative path of the executable for archive/folder payloads. */
  startCommand?: string;
  launchArgs: string;
  env: Record<string, string>;
  flatscreen: boolean;
  launchAfter: boolean;
}

export type InstallStep = "prepare" | "upload" | "register" | "launch";
export type StepStatus = "pending" | "active" | "done" | "failed" | "skipped";

export interface InstallProgress {
  step: InstallStep;
  status: StepStatus;
  detail?: string;
  bytes?: number;
  total?: number;
}

export interface InstallResult {
  ok: boolean;
  gameId: string;
  name: string;
  error?: string;
}

export interface TitleInfo {
  gameId: string;
  name: string;
  directory: string;
  kind: PayloadKind;
  runtime?: RuntimeId;
  compatTool?: string;
  argv?: string[];
  installedAt?: string;
  apkPackage?: string;
  versionName?: string;
  isVr?: boolean;
  flatscreen?: boolean;
  sizeBytes?: number;
}

export type LogLevel = "info" | "cmd" | "out" | "err";

export interface LogLine {
  ts: number;
  level: LogLevel;
  text: string;
}

export interface PairRequest {
  host: string;
  port: number;
  nickname?: string;
}

export interface PasswordConnectRequest {
  host: string;
  port: number;
  user: string;
  password: string;
  remember: boolean;
  nickname?: string;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
}

/** Events pushed from main to the renderer. */
export interface EventMap {
  "connection": ConnectionState;
  "install:progress": InstallProgress;
  "log": LogLine;
  "logcat": { gameId: string; line: string };
  "logcat:ended": { gameId: string; reason: string };
  "titles": TitleInfo[];
}

/** The API exposed on window.frameloader by the preload script. */
export interface FrameloaderApi {
  devices: {
    list(): Promise<DeviceProfile[]>;
    remove(id: string): Promise<void>;
    rename(id: string, nickname: string): Promise<void>;
  };
  connection: {
    state(): Promise<ConnectionState>;
    pair(req: PairRequest): Promise<ActionResult>;
    cancelPair(): Promise<void>;
    connectPassword(req: PasswordConnectRequest): Promise<ActionResult>;
    connectSaved(deviceId: string): Promise<ActionResult>;
    disconnect(): Promise<void>;
    installRuntime(which: "lepton"): Promise<ActionResult>;
    /** Browse the LAN for headsets with Developer Mode on. */
    discover(): Promise<DiscoveredFrame[]>;
  };
  payload: {
    inspect(paths: string[]): Promise<PayloadInfo>;
    pick(): Promise<PayloadInfo | null>;
    discard(id: string): Promise<void>;
    runtimes(payloadId: string): Promise<RuntimeOption[]>;
  };
  install: {
    start(req: InstallRequest): Promise<InstallResult>;
  };
  titles: {
    list(): Promise<TitleInfo[]>;
    launch(gameId: string): Promise<ActionResult>;
    stop(gameId: string): Promise<ActionResult>;
    remove(gameId: string): Promise<ActionResult>;
  };
  logcat: {
    start(gameId: string): Promise<ActionResult>;
    stop(): Promise<void>;
  };
  activity: {
    recent(): Promise<LogLine[]>;
  };
  getPathForFile(file: File): string;
  on<K extends keyof EventMap>(event: K, cb: (payload: EventMap[K]) => void): () => void;
}
