// Thin wrapper over ssh2: one connection, exec with captured output, SFTP and tar-stream uploads.
import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper } from "ssh2";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { activity } from "./activity";
import { collectTarEntries, tarChunks, type TarEntry } from "./tarStream";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SshConnectOptions {
  host: string;
  port: number;
  username: string;
  privateKey?: Buffer | string;
  password?: string;
  /** Called with the sha256 fingerprint; return true to accept. */
  verifyHost: (fingerprint: string) => boolean;
  readyTimeoutMs?: number;
}

export class SshError extends Error {}

/** Quote a string for a POSIX shell. */
export function shq(s: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export function fingerprint(key: Buffer): string {
  return "SHA256:" + createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
}

export class SshSession {
  private sftpCache?: SFTPWrapper;
  private closed = false;

  private constructor(private readonly client: Client, readonly host: string, readonly username: string) {
    client.on("close", () => {
      this.closed = true;
      this.sftpCache = undefined;
    });
    client.on("error", () => {
      this.closed = true;
    });
  }

  static connect(opts: SshConnectOptions): Promise<SshSession> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      const cfg: ConnectConfig = {
        host: opts.host,
        port: opts.port,
        username: opts.username,
        readyTimeout: opts.readyTimeoutMs ?? 15000,
        keepaliveInterval: 10000,
        keepaliveCountMax: 3,
        hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => verify(opts.verifyHost(fingerprint(key))),
      };
      if (opts.privateKey) cfg.privateKey = opts.privateKey;
      if (opts.password !== undefined) cfg.password = opts.password;
      client
        .once("ready", () => resolve(new SshSession(client, opts.host, opts.username)))
        .once("error", (err: Error) => reject(new SshError(describeSshError(err))))
        .connect(cfg);
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    this.closed = true;
    this.client.end();
  }

  exec(cmd: string, opts: { stdin?: string; quiet?: boolean; onLine?: (line: string, stream: "out" | "err") => void } = {}): Promise<ExecResult> {
    if (!opts.quiet) activity.push("cmd", cmd.length > 400 ? cmd.slice(0, 400) + " …" : cmd);
    return new Promise((resolve, reject) => {
      this.client.exec(cmd, (err, stream) => {
        if (err) return reject(new SshError(err.message));
        let stdout = "";
        let stderr = "";
        let outBuf = "";
        let errBuf = "";
        const feed = (chunk: Buffer, which: "out" | "err") => {
          const text = chunk.toString("utf8");
          if (which === "out") stdout += text;
          else stderr += text;
          if (!opts.onLine) return;
          let buf = (which === "out" ? outBuf : errBuf) + text;
          const parts = buf.split(/\r?\n/);
          buf = parts.pop() ?? "";
          for (const p of parts) opts.onLine(p, which);
          if (which === "out") outBuf = buf;
          else errBuf = buf;
        };
        stream.on("data", (c: Buffer) => feed(c, "out"));
        stream.stderr.on("data", (c: Buffer) => feed(c, "err"));
        stream.on("close", (code: number | null) => {
          if (opts.onLine) {
            if (outBuf) opts.onLine(outBuf, "out");
            if (errBuf) opts.onLine(errBuf, "err");
          }
          if (!opts.quiet) {
            const tail = (stdout + (stderr ? "\n" + stderr : "")).trim();
            if (tail) activity.push(code === 0 ? "out" : "err", tail.length > 2000 ? tail.slice(-2000) : tail);
            if (code !== 0) activity.push("err", `exit ${code}`);
          }
          resolve({ code: code ?? -1, stdout, stderr });
        });
        if (opts.stdin !== undefined) stream.end(opts.stdin);
        else stream.stdin.end();
      });
    });
  }

  /** Exec and return a handle for a long-running stream (e.g. logcat). */
  stream(cmd: string, onLine: (line: string, which: "out" | "err") => void): Promise<{ stop: () => void; done: Promise<number> }> {
    activity.push("cmd", cmd);
    return new Promise((resolve, reject) => {
      this.client.exec(cmd, { pty: false }, (err, stream) => {
        if (err) return reject(new SshError(err.message));
        let outBuf = "";
        let errBuf = "";
        const feed = (chunk: Buffer, which: "out" | "err") => {
          let buf = (which === "out" ? outBuf : errBuf) + chunk.toString("utf8");
          const parts = buf.split(/\r?\n/);
          buf = parts.pop() ?? "";
          for (const p of parts) onLine(p, which);
          if (which === "out") outBuf = buf;
          else errBuf = buf;
        };
        stream.on("data", (c: Buffer) => feed(c, "out"));
        stream.stderr.on("data", (c: Buffer) => feed(c, "err"));
        const done = new Promise<number>((res) => stream.on("close", (code: number | null) => res(code ?? -1)));
        resolve({
          stop: () => {
            try {
              stream.signal("INT");
            } catch {
              /* ignore */
            }
            stream.close();
          },
          done,
        });
      });
    });
  }

  private sftp(): Promise<SFTPWrapper> {
    if (this.sftpCache) return Promise.resolve(this.sftpCache);
    return new Promise((resolve, reject) => {
      this.client.sftp((err, sftp) => {
        if (err) return reject(new SshError(err.message));
        this.sftpCache = sftp;
        sftp.on("close", () => {
          this.sftpCache = undefined;
        });
        resolve(sftp);
      });
    });
  }

  async putFile(local: string, remote: string, opts: { mode?: number; onProgress?: (sent: number, total: number) => void } = {}): Promise<void> {
    const sftp = await this.sftp();
    await new Promise<void>((resolve, reject) => {
      sftp.fastPut(
        local,
        remote,
        {
          mode: opts.mode ?? 0o644,
          step: (transferred: number, _chunk: number, total: number) => opts.onProgress?.(transferred, total),
        },
        (err) => (err ? reject(new SshError(`upload failed: ${err.message}`)) : resolve()),
      );
    });
  }

  async writeFile(remote: string, content: string | Buffer, mode = 0o644): Promise<void> {
    const sftp = await this.sftp();
    await new Promise<void>((resolve, reject) => {
      sftp.writeFile(remote, content, { mode }, (err) => (err ? reject(new SshError(err.message)) : resolve()));
    });
  }

  /**
   * Upload a directory tree. When the headset has tar, the tree goes as one
   * tar stream into `tar -x` over this (already encrypted, host-verified) SSH
   * connection, so thousands of small files cost one round-trip instead of one
   * each. Without tar it falls back to per-file SFTP.
   */
  async putDir(localDir: string, remoteDir: string, opts: { onProgress?: (sent: number, total: number) => void } = {}): Promise<void> {
    const entries = collectTarEntries(localDir);
    const total = entries.reduce((a, e) => a + e.size, 0);
    if (await this.hasRemoteTar()) await this.putDirTar(entries, remoteDir, total, opts.onProgress);
    else await this.putDirSftp(entries, remoteDir, total, opts.onProgress);
  }

  private remoteTar?: boolean;

  private async hasRemoteTar(): Promise<boolean> {
    if (this.remoteTar === undefined) this.remoteTar = (await this.exec("command -v tar >/dev/null 2>&1", { quiet: true })).code === 0;
    return this.remoteTar;
  }

  private async putDirTar(entries: TarEntry[], remoteDir: string, total: number, onProgress?: (sent: number, total: number) => void): Promise<void> {
    // Every file gets 0755, as the SFTP path does: builds unpacked from zips
    // often lose their exec bits. --no-same-owner keeps files owned by the user.
    const cmd = `mkdir -p ${shq(remoteDir)} && exec tar --no-same-owner -x -f - -C ${shq(remoteDir)}`;
    activity.push("cmd", `${cmd}  (${entries.length} entries streamed)`);
    const ch = await new Promise<ClientChannel>((resolve, reject) => this.client.exec(cmd, (err, c) => (err ? reject(new SshError(err.message)) : resolve(c))));

    let stderr = "";
    let closed = false;
    ch.on("data", () => {}); // tar prints nothing on success; keep stdout flowing regardless
    ch.on("error", () => {}); // writes after the far side exits; the exit code reports that
    ch.stderr.on("data", (c: Buffer) => {
      stderr = (stderr + c.toString("utf8")).slice(-4000);
    });
    const exit = new Promise<number | null>((resolve) =>
      ch.once("close", (code: number | null) => {
        closed = true;
        resolve(code);
      }),
    );
    const drainedOrClosed = () =>
      new Promise<void>((resolve) => {
        const done = () => {
          ch.off("drain", done).off("close", done);
          resolve();
        };
        ch.on("drain", done).on("close", done);
      });

    let sent = 0;
    let complete = false;
    try {
      for await (const chunk of tarChunks(entries, { fileMode: 0o755, dirMode: 0o755, onFileBytes: (n) => onProgress?.((sent += n), total) })) {
        if (closed) break;
        if (!ch.write(chunk)) await drainedOrClosed();
      }
      complete = !closed;
      ch.end();
    } catch (e) {
      ch.close();
      throw new SshError(`upload failed: ${(e as Error).message}`);
    }

    const code = await exit;
    if (code !== 0 || !complete) {
      const why = stderr.trim().split("\n").slice(-3).join(" ") || `tar exited ${code ?? "on a signal"}`;
      activity.push("err", why);
      throw new SshError(`upload failed: ${why}`);
    }
    onProgress?.(total, total);
  }

  private async putDirSftp(entries: TarEntry[], remoteDir: string, total: number, onProgress?: (sent: number, total: number) => void): Promise<void> {
    const dirs = [remoteDir, ...entries.filter((e) => e.type === "dir").map((e) => posix.join(remoteDir, e.rel))];
    await this.exec("mkdir -p " + dirs.map(shq).join(" "), { quiet: true });
    let doneBytes = 0;
    for (const f of entries) {
      if (f.type !== "file") continue;
      let last = 0;
      await this.putFile(f.local!, posix.join(remoteDir, f.rel), {
        mode: 0o755,
        onProgress: (sent) => {
          doneBytes += sent - last;
          last = sent;
          onProgress?.(doneBytes, total);
        },
      });
      doneBytes += f.size - last;
      onProgress?.(doneBytes, total);
    }
  }
}

function describeSshError(err: Error & { level?: string }): string {
  const m = err.message || String(err);
  if (/All configured authentication methods failed/i.test(m)) return "AUTH_FAILED";
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m)) return "HOST_NOT_FOUND";
  if (/ECONNREFUSED/i.test(m)) return "CONNECTION_REFUSED";
  if (/EHOSTUNREACH|EHOSTDOWN|ETIMEDOUT|Timed out/i.test(m)) return "HOST_UNREACHABLE";
  if (/Host key/i.test(m) || /hostVerifier/i.test(m) || /handshake/i.test(m)) return "HOST_KEY_REJECTED";
  return m;
}
