// Stream `lepton logcat <instance>` for an Android title.
import { EventEmitter } from "node:events";
import { LEPTON_PATH } from "./preflight";
import { shq, type SshSession } from "./ssh";
import { leptonInstanceFor } from "./titles";
import type { TitleInfo } from "../shared/ipc";

export class Logcat extends EventEmitter {
  private current?: { gameId: string; stop: () => void };

  async start(ssh: SshSession, title: TitleInfo): Promise<void> {
    this.stop();
    const instance = await leptonInstanceFor(ssh, title.apkPackage, title.directory);
    if (!instance) throw new Error(`${title.name} isn't running right now. Launch it, then open the logs.`);
    const handle = await ssh.stream(`TERM=dumb "${LEPTON_PATH}" logcat ${shq(instance)} --full 2>&1`, (line) => this.emit("line", { gameId: title.gameId, line }));
    this.current = { gameId: title.gameId, stop: handle.stop };
    handle.done.then((code) => {
      if (this.current?.gameId === title.gameId) {
        this.current = undefined;
        this.emit("ended", { gameId: title.gameId, reason: code === 0 ? "ended" : `exited (${code})` });
      }
    });
  }

  stop(): void {
    const c = this.current;
    this.current = undefined;
    if (c) {
      c.stop();
      this.emit("ended", { gameId: c.gameId, reason: "stopped" });
    }
  }
}

export const logcat = new Logcat();
