// One headset at a time: pairing, connecting, device info, reconnection state.
import { EventEmitter } from "node:events";
import { readFileSync, existsSync } from "node:fs";
import type { ConnectionState, DeviceInfo, DeviceProfile, PairRequest, PasswordConnectRequest } from "../shared/ipc";
import { activity } from "./activity";
import { config } from "./config";
import { ensureDevkitKey, pair } from "./devkitPair";
import { resolveHost } from "./discovery";
import { friendlyError } from "./errors";
import { preflight } from "./preflight";
import { SshSession } from "./ssh";

export class Session extends EventEmitter {
  ssh?: SshSession;
  device?: DeviceProfile;
  info?: DeviceInfo;
  state: ConnectionState = { status: "disconnected" };
  private pairAbort?: AbortController;

  private setState(next: Partial<ConnectionState>): void {
    this.state = { ...this.state, ...next };
    this.emit("state", this.state);
  }

  private hostVerifier(host: string, port: number): (fp: string) => boolean {
    return (fp) => {
      const known = config.knownHost(host, port);
      if (!known) {
        config.rememberHost(host, port, fp);
        activity.info(`Trusting ${host}'s SSH key on first use (${fp})`);
        return true;
      }
      if (known !== fp) {
        activity.push("err", `Host key for ${host} changed: expected ${known}, got ${fp}`);
        return false;
      }
      return true;
    };
  }

  require(): SshSession {
    if (!this.ssh || this.ssh.isClosed) throw new Error("Not connected to a headset.");
    return this.ssh;
  }

  requireInfo(): DeviceInfo {
    if (!this.info) throw new Error("Not connected to a headset.");
    return this.info;
  }

  async disconnect(): Promise<void> {
    this.pairAbort?.abort();
    this.ssh?.close();
    this.ssh = undefined;
    this.info = undefined;
    this.setState({ status: "disconnected", message: undefined, info: undefined });
  }

  cancelPair(): void {
    this.pairAbort?.abort();
  }

  private async finishConnect(ssh: SshSession, device: DeviceProfile, address: string): Promise<void> {
    this.ssh?.close();
    this.ssh = ssh;
    this.device = device;
    const info = await preflight(ssh);
    this.info = info;
    config.touchDevice(device.id, address);
    if (!info.isFrame) activity.push("err", `${device.host} doesn't look like a Steam Frame (VARIANT_ID=${info.variantId ?? "?"}); continuing anyway.`);
    activity.info(`Connected to ${device.host} (SteamOS ${info.versionId ?? "?"}, build ${info.buildId ?? "?"}); Steam ${info.steamRunning ? "running" : "not running"}; Lepton ${info.leptonInstalled ? "installed" : "missing"}; Proton: ${info.protonInstalled.join(", ") || "none"}`);
    this.setState({ status: "connected", deviceId: device.id, host: device.host, address, message: undefined, info });
    const onClose = () => {
      if (this.ssh === ssh) {
        this.ssh = undefined;
        this.setState({ status: "offline", message: `${device.host} went offline.` });
      }
    };
    // ssh2 emits close on the client; our wrapper tracks it. Poll cheaply.
    const timer = setInterval(() => {
      if (ssh.isClosed) {
        clearInterval(timer);
        onClose();
      }
    }, 2000);
  }

  async refreshInfo(): Promise<DeviceInfo> {
    const info = await preflight(this.require());
    this.info = info;
    this.setState({ info });
    return info;
  }

  async pair(req: PairRequest): Promise<void> {
    const host = req.host.trim();
    const port = req.port || 22;
    this.pairAbort?.abort();
    const abort = new AbortController();
    this.pairAbort = abort;
    this.setState({ status: "pairing", host, message: "Looking for the headset…" });
    try {
      const { address } = await resolveHost(host, config.findDeviceByHost(host, port)?.lastAddress);
      this.setState({ address, message: "Contacting the headset…" });
      const key = await ensureDevkitKey(config.keyPath());
      const login = await pair(address, key.publicLine, {
        signal: abort.signal,
        onProgress: (phase) => {
          const message =
            phase === "waiting-for-pairing-mode"
              ? "On the headset, open Settings → Developer → Pair new host."
              : phase === "waiting-for-approval"
                ? "Waiting for you to approve on the headset…"
                : phase === "approved"
                  ? "Approved. Connecting…"
                  : "Contacting the headset…";
          this.setState({ message });
        },
      });
      // sshd may take a moment to pick up the key.
      let ssh: SshSession | undefined;
      let lastErr: unknown;
      for (let i = 0; i < 8 && !ssh; i++) {
        try {
          ssh = await SshSession.connect({ host: address, port, username: login, privateKey: key.privateKey, verifyHost: this.hostVerifier(host, port) });
        } catch (e) {
          lastErr = e;
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
      if (!ssh) throw lastErr ?? new Error("NEEDS_PASSWORD");
      const device = config.upsertDevice({ nickname: req.nickname ?? host, host, port, user: login, auth: "key", lastAddress: address });
      await this.finishConnect(ssh, device, address);
    } catch (e) {
      const message = friendlyError(e, host);
      this.setState({ status: "disconnected", message });
      throw new Error(message);
    } finally {
      if (this.pairAbort === abort) this.pairAbort = undefined;
    }
  }

  async connectPassword(req: PasswordConnectRequest): Promise<void> {
    const host = req.host.trim();
    const port = req.port || 22;
    const user = req.user.trim() || "steamos";
    this.setState({ status: "connecting", host, message: "Looking for the headset…" });
    try {
      const { address } = await resolveHost(host, config.findDeviceByHost(host, port)?.lastAddress);
      this.setState({ address, message: "Connecting…" });
      const ssh = await SshSession.connect({ host: address, port, username: user, password: req.password, verifyHost: this.hostVerifier(host, port) });
      const device = config.upsertDevice({ nickname: req.nickname ?? host, host, port, user, auth: "password", lastAddress: address });
      if (req.remember) {
        if (!config.savePassword(device.id, req.password)) activity.push("err", "Couldn't store the password securely on this computer; it won't be remembered.");
      } else {
        config.forgetPassword(device.id);
      }
      await this.finishConnect(ssh, device, address);
    } catch (e) {
      const message = friendlyError(e, host);
      this.setState({ status: "disconnected", message });
      throw new Error(message);
    }
  }

  /** Reconnect to a saved device with whatever credentials we have. Throws NEEDS_PASSWORD when none work. */
  async connectSaved(deviceId: string): Promise<void> {
    const device = config.device(deviceId);
    if (!device) throw new Error("That headset isn't saved anymore.");
    this.setState({ status: "connecting", deviceId, host: device.host, message: "Looking for the headset…" });
    let address: string;
    try {
      address = (await resolveHost(device.host, device.lastAddress)).address;
    } catch (e) {
      const message = friendlyError(e, device.host);
      this.setState({ status: "offline", deviceId, message });
      throw new Error(message);
    }
    this.setState({ address, message: "Connecting…" });
    const verify = this.hostVerifier(device.host, device.port);
    const attempts: (() => Promise<SshSession>)[] = [];
    const keyPath = config.keyPath();
    if (existsSync(keyPath)) {
      attempts.push(() => SshSession.connect({ host: address, port: device.port, username: device.user, privateKey: readFileSync(keyPath), verifyHost: verify }));
    }
    const pw = config.password(deviceId);
    if (pw !== undefined) {
      attempts.push(() => SshSession.connect({ host: address, port: device.port, username: device.user, password: pw, verifyHost: verify }));
    }
    let lastErr: unknown = new Error("NEEDS_PASSWORD");
    for (const attempt of attempts) {
      try {
        const ssh = await attempt();
        await this.finishConnect(ssh, device, address);
        return;
      } catch (e) {
        lastErr = e;
        const m = e instanceof Error ? e.message : "";
        if (m !== "AUTH_FAILED") break; // network problems: don't try other credentials
      }
    }
    const m = lastErr instanceof Error ? lastErr.message : "";
    const message = friendlyError(m === "AUTH_FAILED" ? new Error("NEEDS_PASSWORD") : lastErr, device.host);
    this.setState({ status: m === "AUTH_FAILED" || !attempts.length ? "disconnected" : "offline", deviceId, message });
    throw new Error(message);
  }
}

export const session = new Session();
