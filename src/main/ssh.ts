// Thin wrapper over ssh2: one connection, exec with captured output, SFTP uploads.
import { Client, type ConnectConfig, type SFTPWrapper } from "ssh2";
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { activity } from "./activity";

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

  /** Upload a directory tree. Remote directories are created with one mkdir -p. */
  async putDir(localDir: string, remoteDir: string, opts: { onProgress?: (sent: number, total: number) => void } = {}): Promise<void> {
    const files: { local: string; rel: string; size: number; exec: boolean }[] = [];
    const dirs = new Set<string>([remoteDir]);
    const walk = (dir: string, rel: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        const r = rel ? posix.join(rel, entry.name) : entry.name;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          dirs.add(posix.join(remoteDir, r));
          walk(full, r);
        } else if (entry.isFile()) {
          const st = statSync(full);
          files.push({ local: full, rel: r, size: st.size, exec: (st.mode & 0o111) !== 0 });
        }
      }
    };
    walk(localDir, "");
    await this.exec("mkdir -p " + [...dirs].map(shq).join(" "), { quiet: true });
    const total = files.reduce((a, f) => a + f.size, 0);
    let doneBytes = 0;
    for (const f of files) {
      let last = 0;
      await this.putFile(f.local, posix.join(remoteDir, f.rel), {
        mode: 0o755,
        onProgress: (sent) => {
          doneBytes += sent - last;
          last = sent;
          opts.onProgress?.(doneBytes, total);
        },
      });
      doneBytes += f.size - last;
      opts.onProgress?.(doneBytes, total);
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
