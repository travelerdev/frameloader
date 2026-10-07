// Valve's SteamOS devkit pairing: HTTP on port 32000.
//   GET  /properties.json  -> {"login": "steamos", ...}
//   POST /register         -> body "ssh-rsa <b64> <comment> <MAGIC_PHRASE>\n"
// The headset answers 403 "...pairing mode..." unless Steam is on
// Settings > Developer > Pair new host, so we keep asking for a while.
import http from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { hostname, userInfo } from "node:os";
import { utils as sshUtils } from "ssh2";
import { activity } from "./activity";

export const DEVKIT_PORT = 32000;
export const MAGIC_PHRASE = "900b919520e4cf601998a71eec318fec";
const PAIRING_MODE_WAIT_MS = 120_000;
const REGISTER_TIMEOUT_MS = 60_000;

export interface DevkitKey {
  privateKey: Buffer;
  publicLine: string; // "ssh-rsa AAAA... comment"
}

function keyComment(): string {
  const user = (() => {
    try {
      return userInfo().username;
    } catch {
      return "user";
    }
  })();
  const node = (hostname() || "computer").split(".")[0] ?? "computer";
  return `frameloader:${user}@${node}`.replace(/[^A-Za-z0-9_.:@-]+/g, "-");
}

export function ensureDevkitKey(privPath: string): Promise<DevkitKey> {
  const pubPath = privPath + ".pub";
  if (existsSync(privPath) && existsSync(pubPath)) {
    return Promise.resolve({ privateKey: readFileSync(privPath), publicLine: readFileSync(pubPath, "utf8").trim() });
  }
  return new Promise((resolve, reject) => {
    sshUtils.generateKeyPair("rsa", { bits: 2048, comment: keyComment() }, (err, keys) => {
      if (err) return reject(err);
      mkdirSync(dirname(privPath), { recursive: true });
      writeFileSync(privPath, keys.private, { mode: 0o600 });
      writeFileSync(pubPath, keys.public.trim() + "\n", { mode: 0o600 });
      try {
        chmodSync(privPath, 0o600);
      } catch {
        /* windows */
      }
      activity.info(`Generated a new pairing key at ${privPath}`);
      resolve({ privateKey: Buffer.from(keys.private), publicLine: keys.public.trim() });
    });
  });
}

function request(host: string, port: number, path: string, opts: { method?: "GET" | "POST"; body?: string; timeoutMs: number; signal?: AbortSignal }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host, port, path, method: opts.method ?? "GET", headers: opts.body ? { "Content-Type": "text/plain", "Content-Length": Buffer.byteLength(opts.body) } : {}, timeout: opts.timeoutMs, agent: false, signal: opts.signal },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

export async function fetchLogin(host: string, port = DEVKIT_PORT, signal?: AbortSignal): Promise<string | undefined> {
  const r = await request(host, port, "/properties.json", { timeoutMs: 5000, signal });
  if (r.status !== 200) throw new Error(`properties.json returned HTTP ${r.status}`);
  const props = JSON.parse(r.body) as { login?: unknown };
  const login = typeof props.login === "string" ? props.login : undefined;
  return login && login !== "root" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(login) ? login : undefined;
}

export function registerBody(publicLine: string): string {
  const parts = publicLine.trim().split(/\s+/);
  if (parts.length < 2 || parts[0] !== "ssh-rsa") throw new Error("the devkit service only takes ssh-rsa keys");
  const comment = parts[2] ?? keyComment();
  return `ssh-rsa ${parts[1]} ${comment} ${MAGIC_PHRASE}\n`;
}

function errorText(status: number, body: string): string {
  try {
    const j = JSON.parse(body) as { error?: unknown };
    if (typeof j.error === "string") return j.error;
  } catch {
    /* plain text */
  }
  return body.trim() || `HTTP ${status}`;
}

export interface PairProgress {
  (phase: "contacting" | "waiting-for-pairing-mode" | "waiting-for-approval" | "approved", detail?: string): void;
}

/**
 * Pair with the headset. Resolves with the login user once the key is accepted.
 * Rejects with a readable message otherwise.
 */
export async function pair(host: string, publicLine: string, opts: { port?: number; signal?: AbortSignal; onProgress?: PairProgress }): Promise<string> {
  const port = opts.port ?? DEVKIT_PORT;
  opts.onProgress?.("contacting");
  let login: string | undefined;
  try {
    login = await fetchLogin(host, port, opts.signal);
  } catch (e) {
    throw new Error(`DEVKIT_UNREACHABLE:${(e as Error).message}`);
  }
  const body = registerBody(publicLine);
  activity.info(`Registering pairing key with ${host}:${port} (approve on the headset)`);
  const deadline = Date.now() + PAIRING_MODE_WAIT_MS;
  let lastMsg = "";
  while (true) {
    if (opts.signal?.aborted) throw new Error("CANCELLED");
    opts.onProgress?.("waiting-for-approval");
    let r: { status: number; body: string };
    try {
      r = await request(host, port, "/register", { method: "POST", body, timeoutMs: REGISTER_TIMEOUT_MS, signal: opts.signal });
    } catch (e) {
      if (opts.signal?.aborted) throw new Error("CANCELLED");
      throw new Error(`DEVKIT_UNREACHABLE:${(e as Error).message}`);
    }
    if (r.status === 200) {
      opts.onProgress?.("approved");
      activity.info(`Headset accepted the key: ${r.body.trim() || "ok"}`);
      return login ?? "steamos";
    }
    lastMsg = errorText(r.status, r.body);
    if (/pairing mode/i.test(lastMsg) && Date.now() < deadline) {
      opts.onProgress?.("waiting-for-pairing-mode", lastMsg);
      await new Promise((res) => setTimeout(res, 3000));
      continue;
    }
    if (/pairing mode/i.test(lastMsg)) throw new Error("PAIRING_MODE_TIMEOUT");
    throw new Error(`PAIRING_REFUSED:${lastMsg}`);
  }
}
