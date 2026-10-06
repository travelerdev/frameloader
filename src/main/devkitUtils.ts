// Valve's device-side scripts: keep ~/devkit-utils in sync and drive them.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { app } from "electron";
import { activity } from "./activity";
import { shq, SshSession } from "./ssh";

const REMOTE_DIR = "devkit-utils"; // relative to $HOME
const STAMP = ".frameloader-stamp";
const SCRIPTS = ["steamos-prepare-upload", "steam-client-create-shortcut", "steam-devkit-rpc", "steamos-list-games", "steamos-delete", "steamos-get-status"];

export function vendorDir(): string {
  return app.isPackaged ? join(process.resourcesPath, "devkit-utils") : join(app.getAppPath(), "vendor", "devkit-utils");
}

interface VendorFile {
  rel: string;
  local: string;
  exec: boolean;
}

function listVendor(): VendorFile[] {
  const root = vendorDir();
  const out: VendorFile[] = [];
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === "__pycache__" || e.name === "README.md") continue;
      const full = join(dir, e.name);
      const r = rel ? posix.join(rel, e.name) : e.name;
      if (e.isDirectory()) walk(full, r);
      else if (e.isFile()) out.push({ rel: r, local: full, exec: SCRIPTS.includes(e.name) });
    }
  };
  walk(root, "");
  return out;
}

export function vendorStamp(): string {
  const h = createHash("sha256");
  for (const f of listVendor()) {
    h.update(f.rel + "\0");
    h.update(readFileSync(f.local));
    h.update("\0");
  }
  return h.digest("hex").slice(0, 24);
}

/** Copy the vendored scripts to ~/devkit-utils unless the stamp already matches. Files are merged, never deleted. */
export async function syncDevkitUtils(ssh: SshSession, home: string): Promise<boolean> {
  const stamp = vendorStamp();
  const remote = posix.join(home, REMOTE_DIR);
  const have = await ssh.exec(`cat ${shq(posix.join(remote, STAMP))} 2>/dev/null`, { quiet: true });
  if (have.code === 0 && have.stdout.trim() === stamp) return false;
  activity.info("Copying Valve's devkit helper scripts to the headset (~/devkit-utils)");
  const files = listVendor();
  const dirs = new Set<string>([remote]);
  for (const f of files) dirs.add(posix.join(remote, posix.dirname(f.rel)));
  await ssh.exec("mkdir -p " + [...dirs].map(shq).join(" "), { quiet: true });
  for (const f of files) {
    await ssh.putFile(f.local, posix.join(remote, f.rel), { mode: f.exec ? 0o755 : 0o644 });
  }
  await ssh.writeFile(posix.join(remote, STAMP), stamp + "\n");
  return true;
}

/** The scripts log to stderr and print one JSON document on stdout; take the last JSON-looking line. */
export function lastJson<T>(stdout: string, what: string): T {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (l.startsWith("{") || l.startsWith("[")) {
      try {
        return JSON.parse(l) as T;
      } catch {
        /* keep looking */
      }
    }
  }
  throw new Error(`${what} didn't return JSON (got: ${stdout.trim().slice(-200) || "nothing"})`);
}

function py(home: string, script: string): string {
  return `python3 ${shq(posix.join(home, REMOTE_DIR, script))}`;
}

export async function prepareUpload(ssh: SshSession, home: string, gameId: string): Promise<{ user: string; directory: string }> {
  const r = await ssh.exec(`${py(home, "steamos-prepare-upload")} --gameid ${shq(gameId)}`);
  if (r.code !== 0) throw new Error(`steamos-prepare-upload failed: ${(r.stderr || r.stdout).trim().slice(-300)}`);
  return lastJson(r.stdout, "steamos-prepare-upload");
}

export interface ShortcutParms {
  gameid: string;
  directory: string;
  argv: string[];
  env: Record<string, string>;
  settings: Record<string, string>;
  clear_settings: boolean;
  force_appid: string;
  lepton_args: string;
}

export async function createShortcut(ssh: SshSession, home: string, parms: ShortcutParms): Promise<string> {
  const r = await ssh.exec(`${py(home, "steam-client-create-shortcut")} --parms ${shq(JSON.stringify(parms))}`);
  if (r.code !== 0) throw new Error(`steam-client-create-shortcut failed: ${(r.stderr || r.stdout).trim().slice(-300)}`);
  const reply = lastJson<{ success?: unknown; error?: unknown }>(r.stdout, "steam-client-create-shortcut");
  if (typeof reply.error === "string" && reply.error) throw new Error(reply.error);
  if (!("success" in reply)) throw new Error("Steam didn't confirm the registration.");
  return typeof reply.success === "string" ? reply.success : "";
}

export async function runGame(ssh: SshSession, home: string, gameId: string): Promise<void> {
  const r = await ssh.exec(`${py(home, "steam-devkit-rpc")} run-game gameid=${shq(gameId)}`);
  if (r.code !== 0) throw new Error(`Steam didn't launch ${gameId}: ${(r.stderr || r.stdout).trim().slice(-300)}`);
}

export async function deleteTitle(ssh: SshSession, home: string, gameId: string): Promise<void> {
  const r = await ssh.exec(`${py(home, "steamos-delete")} --delete-title ${shq(gameId)}`);
  if (r.code !== 0) throw new Error(`steamos-delete failed: ${(r.stderr || r.stdout).trim().slice(-300)}`);
  // Valve's script leaves the json sidecars behind; tidy them so the title doesn't come back.
  const base = posix.join(home, "devkit-game", gameId);
  await ssh.exec(`rm -f ${shq(base + "-argv.json")} ${shq(base + "-env.json")} ${shq(base + "-settings.json")}`, { quiet: true });
}

/** Frameloader's own sidecar inside each title folder. */
export interface TitleMeta {
  name: string;
  kind: string;
  installedAt: string;
  apkPackage?: string;
  versionName?: string;
  isVr?: boolean;
  flatscreen?: boolean;
  sizeBytes?: number;
  startCommand?: string;
}

export interface RawTitle {
  gameId: string;
  directory: string;
  settings: Record<string, string> | null;
  argv: string[] | null;
  meta: Partial<TitleMeta>;
  apks: string[];
  flatscreen: boolean;
  sizeBytes: number;
}

const LIST_SCRIPT = `
import os, json, glob
root = os.path.expanduser('~/devkit-game')
out = []
def rj(f):
    try:
        with open(f) as fh:
            return json.load(fh)
    except Exception:
        return None
if os.path.isdir(root):
    for d in sorted(os.listdir(root)):
        p = os.path.join(root, d)
        if not os.path.isdir(p):
            continue
        size = 0
        for dp, dn, fn in os.walk(p):
            for f in fn:
                try:
                    size += os.path.getsize(os.path.join(dp, f))
                except OSError:
                    pass
        out.append({
            'gameId': d, 'directory': p,
            'settings': rj(os.path.join(root, d + '-settings.json')),
            'argv': rj(os.path.join(root, d + '-argv.json')),
            'meta': rj(os.path.join(p, '.frameloader.json')) or {},
            'apks': [os.path.basename(x) for x in glob.glob(os.path.join(p, '*.apk'))],
            'flatscreen': os.path.exists(os.path.join(p, 'lepton-show-flatscreen')),
            'sizeBytes': size,
        })
print(json.dumps(out))
`;

export async function listTitles(ssh: SshSession): Promise<RawTitle[]> {
  const r = await ssh.exec("python3 -", { stdin: LIST_SCRIPT, quiet: true });
  if (r.code !== 0) throw new Error(`listing titles failed: ${(r.stderr || r.stdout).trim().slice(-300)}`);
  return lastJson<RawTitle[]>(r.stdout, "title listing");
}
