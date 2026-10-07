// Talks to the Steam client on the headset through its Chrome DevTools port
// (127.0.0.1:8080, page "SharedJSContext"); SteamOS runs Steam with
// -cef-enable-debugging. Used to give devkit titles a proper library name:
// Steam otherwise shows them as "Devkit Game: <id>".
import { activity } from "./activity";
import { lastJson } from "./devkitUtils";
import type { SshSession } from "./ssh";

// Runs on the headset with the system python3, stdlib only. Reads {"js": "..."} on
// stdin, evaluates it in Steam's SharedJSContext and prints {"value": ...} or {"error": ...}.
export const CDP_EVAL = String.raw`
import base64, json, os, socket, struct, sys, urllib.request

def out(obj):
    print(json.dumps(obj))
    sys.exit(0)

req = json.loads(sys.stdin.read())
try:
    targets = json.load(urllib.request.urlopen('http://127.0.0.1:8080/json', timeout=5))
except Exception as e:
    out({'error': 'Steam DevTools port not reachable: %s' % e})
ws_url = next((t.get('webSocketDebuggerUrl') for t in targets if t.get('title') == 'SharedJSContext'), None)
if not ws_url:
    out({'error': 'SharedJSContext not found; is Steam running?'})

hostport, path = ws_url[len('ws://'):].split('/', 1)
host, port = hostport.rsplit(':', 1)
s = socket.create_connection((host, int(port)), timeout=30)
key = base64.b64encode(os.urandom(16)).decode()
s.sendall(('GET /%s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
           'Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n' % (path, hostport, key)).encode())
buf = b''
while b'\r\n\r\n' not in buf:
    chunk = s.recv(4096)
    if not chunk:
        out({'error': 'websocket closed during handshake'})
    buf += chunk
if b' 101 ' not in buf.split(b'\r\n', 1)[0]:
    out({'error': 'websocket handshake refused'})
rest = buf.split(b'\r\n\r\n', 1)[1]

def read(n):
    global rest
    while len(rest) < n:
        chunk = s.recv(65536)
        if not chunk:
            raise EOFError
        rest += chunk
    data, rest = rest[:n], rest[n:]
    return data

def send(text):
    data = text.encode()
    mask = os.urandom(4)
    n = len(data)
    if n < 126:
        head = bytes([0x81, 0x80 | n])
    elif n < 65536:
        head = bytes([0x81, 0x80 | 126]) + struct.pack('>H', n)
    else:
        head = bytes([0x81, 0x80 | 127]) + struct.pack('>Q', n)
    s.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

def recv():
    msg = b''
    while True:
        b0, b1 = read(2)
        n = b1 & 0x7f
        if n == 126:
            n = struct.unpack('>H', read(2))[0]
        elif n == 127:
            n = struct.unpack('>Q', read(8))[0]
        msg += read(n)
        if b0 & 0x80:
            return msg.decode()

send(json.dumps({'id': 1, 'method': 'Runtime.evaluate',
                 'params': {'expression': req['js'], 'awaitPromise': True, 'returnByValue': True}}))
while True:
    r = json.loads(recv())
    if r.get('id') == 1:
        break
res = r.get('result', {})
if 'exceptionDetails' in res:
    out({'error': json.dumps(res['exceptionDetails'])[:400]})
out({'value': res.get('result', {}).get('value')})
`;

export async function steamEval<T>(ssh: SshSession, js: string): Promise<T> {
  const r = await ssh.exec(`python3 -c ${shellQuote(CDP_EVAL)}`, { stdin: JSON.stringify({ js }), quiet: true });
  const reply = lastJson<{ value?: T; error?: string }>(r.stdout, "Steam DevTools helper");
  if (reply.error) throw new Error(reply.error);
  return reply.value as T;
}

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** JS that finds the devkit title's shortcut and renames it. Waits up to ~8 s for Steam to list it. */
export function renameJs(gameId: string, directory: string, name: string): string {
  return `(async () => {
    const gid = ${JSON.stringify(gameId)}, dir = ${JSON.stringify(directory.replace(/\/+$/, ""))}, name = ${JSON.stringify(name)};
    const inside = (p) => { p = String(p || "").trim().replace(/^"|"$/g, ""); return p === dir || p.startsWith(dir + "/"); };
    const details = (appid) => new Promise((ok) => {
      const cached = typeof appDetailsStore !== "undefined" && appDetailsStore.GetAppDetails && appDetailsStore.GetAppDetails(appid);
      if (cached) return ok(cached);
      if (!SteamClient.Apps.RegisterForAppDetails) return ok(null);
      let reg;
      const timer = setTimeout(() => { if (reg) reg.unregister(); ok(null); }, 2500);
      reg = SteamClient.Apps.RegisterForAppDetails(appid, (d) => { clearTimeout(timer); setTimeout(() => reg && reg.unregister()); ok(d); });
    });
    for (let attempt = 0; attempt < 8; attempt++) {
      const shortcuts = appStore.allApps.filter((a) => a.app_type === 1073741824);
      const matches = [];
      for (const a of shortcuts) {
        if (a.devkit_gameid === gid) { matches.push(a); continue; }
        const d = await details(a.appid);
        if (d && (inside(d.strShortcutExe) || inside(d.strShortcutStartDir))) matches.push(a);
      }
      if (matches.length === 1) {
        const a = matches[0];
        const before = a.display_name;
        if (before !== name) SteamClient.Apps.SetShortcutName(a.appid, name);
        if (typeof SteamClient.Apps.SetShortcutSortAs === "function") SteamClient.Apps.SetShortcutSortAs(a.appid, name);
        return { appid: a.appid, before };
      }
      if (matches.length > 1) return { ambiguous: matches.map((m) => m.display_name) };
      await new Promise((r) => setTimeout(r, 1000));
    }
    return { notFound: true };
  })()`;
}

type RenameResult = { appid: number; before: string } | { ambiguous: string[] } | { notFound: true };

/** Best effort: a failure here leaves the title installed under Steam's default name. */
export async function renameDevkitTitle(ssh: SshSession, gameId: string, directory: string, name: string): Promise<boolean> {
  try {
    const r = await steamEval<RenameResult>(ssh, renameJs(gameId, directory, name));
    if (r && "appid" in r) {
      activity.info(`Renamed "${r.before}" to "${name}" in the Steam library`);
      return true;
    }
    if (r && "ambiguous" in r) activity.push("err", `Couldn't rename: several shortcuts point at ${directory} (${r.ambiguous.join(", ")})`);
    else activity.push("err", `Couldn't rename: Steam didn't list a shortcut for ${gameId} yet`);
  } catch (e) {
    activity.push("err", `Couldn't rename the title in Steam: ${(e as Error).message}`);
  }
  return false;
}
