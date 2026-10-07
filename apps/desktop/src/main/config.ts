// Persistent app config in userData: devices, known host keys, overrides.
// Passwords are stored separately, encrypted with Electron's safeStorage.
import { app, safeStorage } from "electron";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AppSettings, DeviceProfile } from "../shared/ipc";

export const DEFAULT_SETTINGS: AppSettings = { developerTools: false, checkForUpdates: true };

interface ConfigFile {
  devices: DeviceProfile[];
  activeDeviceId?: string;
  /** host:port -> sha256 fingerprint of the host key. */
  knownHosts: Record<string, string>;
  /** Global compat tool overrides, e.g. { lepton: "lepton-stable" }. */
  compatToolOverrides: Record<string, string>;
  settings?: Partial<AppSettings>;
}

interface SecretsFile {
  /** deviceId -> base64 of safeStorage-encrypted password. */
  passwords: Record<string, string>;
}

function dir(): string {
  const d = app.getPath("userData");
  mkdirSync(d, { recursive: true });
  return d;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return { ...fallback, ...(JSON.parse(readFileSync(file, "utf8")) as T) };
  } catch {
    return fallback;
  }
}

/** Write via a temp file and rename, so a crash mid-write never leaves a half-written file. */
export function writeJson(file: string, value: unknown, mode = 0o600): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2), { mode });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

class Config {
  private get file(): string {
    return join(dir(), "config.json");
  }
  private get secretsFile(): string {
    return join(dir(), "secrets.json");
  }

  load(): ConfigFile {
    return readJson<ConfigFile>(this.file, { devices: [], knownHosts: {}, compatToolOverrides: {} });
  }

  save(c: ConfigFile): void {
    writeJson(this.file, c);
  }

  devices(): DeviceProfile[] {
    return this.load().devices;
  }

  device(id: string): DeviceProfile | undefined {
    return this.devices().find((d) => d.id === id);
  }

  findDeviceByHost(host: string, port: number): DeviceProfile | undefined {
    const h = host.trim().toLowerCase();
    return this.devices().find((d) => d.host.toLowerCase() === h && d.port === port);
  }

  upsertDevice(partial: Omit<DeviceProfile, "id" | "hasSavedPassword"> & { id?: string }): DeviceProfile {
    const c = this.load();
    const existing = partial.id
      ? c.devices.find((d) => d.id === partial.id)
      : c.devices.find((d) => d.host.toLowerCase() === partial.host.toLowerCase() && d.port === partial.port);
    const device: DeviceProfile = {
      id: existing?.id ?? randomUUID(),
      nickname: partial.nickname || existing?.nickname || partial.host,
      host: partial.host,
      port: partial.port,
      user: partial.user,
      auth: partial.auth,
      hasSavedPassword: existing?.hasSavedPassword ?? false,
      lastSeen: partial.lastSeen ?? existing?.lastSeen,
      lastAddress: partial.lastAddress ?? existing?.lastAddress,
      compatToolOverrides: partial.compatToolOverrides ?? existing?.compatToolOverrides,
    };
    c.devices = [...c.devices.filter((d) => d.id !== device.id), device];
    c.activeDeviceId = device.id;
    this.save(c);
    return device;
  }

  touchDevice(id: string, address?: string): void {
    const c = this.load();
    const d = c.devices.find((x) => x.id === id);
    if (d) {
      d.lastSeen = new Date().toISOString();
      if (address) d.lastAddress = address;
      c.activeDeviceId = id;
      this.save(c);
    }
  }

  renameDevice(id: string, nickname: string): void {
    const c = this.load();
    const d = c.devices.find((x) => x.id === id);
    if (d) {
      d.nickname = nickname.trim() || d.host;
      this.save(c);
    }
  }

  removeDevice(id: string): void {
    const c = this.load();
    c.devices = c.devices.filter((d) => d.id !== id);
    if (c.activeDeviceId === id) c.activeDeviceId = c.devices[0]?.id;
    this.save(c);
    this.forgetPassword(id);
  }

  activeDeviceId(): string | undefined {
    return this.load().activeDeviceId;
  }

  knownHost(host: string, port: number): string | undefined {
    return this.load().knownHosts[`${host.toLowerCase()}:${port}`];
  }

  rememberHost(host: string, port: number, fingerprint: string): void {
    const c = this.load();
    c.knownHosts[`${host.toLowerCase()}:${port}`] = fingerprint;
    this.save(c);
  }

  forgetHost(host: string, port: number): void {
    const c = this.load();
    delete c.knownHosts[`${host.toLowerCase()}:${port}`];
    this.save(c);
  }

  compatToolOverrides(): Record<string, string> {
    return this.load().compatToolOverrides ?? {};
  }

  // ---- secrets ----

  savePassword(deviceId: string, password: string): boolean {
    if (!safeStorage.isEncryptionAvailable()) return false;
    const s = readJson<SecretsFile>(this.secretsFile, { passwords: {} });
    s.passwords[deviceId] = safeStorage.encryptString(password).toString("base64");
    writeJson(this.secretsFile, s);
    const c = this.load();
    const d = c.devices.find((x) => x.id === deviceId);
    if (d) {
      d.hasSavedPassword = true;
      this.save(c);
    }
    return true;
  }

  password(deviceId: string): string | undefined {
    const s = readJson<SecretsFile>(this.secretsFile, { passwords: {} });
    const enc = s.passwords[deviceId];
    if (!enc || !safeStorage.isEncryptionAvailable()) return undefined;
    try {
      return safeStorage.decryptString(Buffer.from(enc, "base64"));
    } catch {
      return undefined;
    }
  }

  forgetPassword(deviceId: string): void {
    if (!existsSync(this.secretsFile)) return;
    const s = readJson<SecretsFile>(this.secretsFile, { passwords: {} });
    delete s.passwords[deviceId];
    writeJson(this.secretsFile, s);
    const c = this.load();
    const d = c.devices.find((x) => x.id === deviceId);
    if (d) {
      d.hasSavedPassword = false;
      this.save(c);
    }
  }

  settings(): AppSettings {
    return { ...DEFAULT_SETTINGS, ...(this.load().settings ?? {}) };
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    const c = this.load();
    c.settings = { ...this.settings(), ...patch };
    this.save(c);
    return this.settings();
  }

  keyPath(): string {
    return join(dir(), "devkit_rsa");
  }
}

export const config = new Config();
